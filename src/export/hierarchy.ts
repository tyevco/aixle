/**
 * From a scene's objects to a node tree with a mesh per node, the shape the
 * GLB and OBJ writers consume.
 *
 * An object is a node with its own geometry: the object's shape extracted
 * with every joint inside it hidden. Each top-level joint becomes a child
 * node at its pivot, with the joint's child shape extracted (its own
 * nested joints hidden) and its vertices made relative to the pivot, and
 * so on down. A placed shape is a node with no mesh and a child per
 * placement, all referring to one base mesh. Every mesh is extracted at
 * the same cell size, so parts match, and all of them share one texture
 * atlas: they are merged for baking and split again with their UVs.
 */
import type { Vec3 } from "../core/vec.js";
import { allJoints, findJoints, move as moveShape } from "../sdf/ops.js";
import { boundsSize, isEmpty, type Material, type Shape3 } from "../sdf/types.js";
import { surfaceNets } from "../mesh/surfaceNets.js";
import { decimate } from "../mesh/decimate.js";
import { triangleCount, type Mesh } from "../mesh/mesh.js";
import { bakeAtlas, type AtlasResult } from "./atlas.js";

export interface SceneNode {
  name: string;
  /** Index into `meshes`, or -1. */
  mesh: number;
  /** Position relative to the parent node's origin. */
  translation: Vec3;
  /** Yaw about y in degrees and a uniform scale (instances only). */
  yaw: number;
  scale: number;
  /** For a joint node: its name, so animations can find it. */
  joint?: string;
  children: SceneNode[];
  /** World position of this node's origin (for flattening). */
  origin: Vec3;
}

export interface SceneHierarchy {
  roots: SceneNode[];
  meshes: Mesh[];
  /** Per mesh, its UVs into the shared atlas; present when an atlas was baked. */
  uvs?: Float32Array[];
  atlas?: AtlasResult["image"];
  atlasCharts?: number;
  triangles: number;
  /** Things the export could not carry, for the report: a rotation or a scale above a joint. */
  notes: string[];
}

export interface HierarchyOptions {
  cellSize: number;
  /** Step names by shape, so a placed set's node carries the name the program gave it. */
  names?: Map<Shape3, string>;
  sharp?: boolean;
  /** Crease angle for vertex splitting, or undefined for the mesher's default. */
  crease?: number;
  /** Atlas size in pixels; 0 for none. */
  texture: number;
  maxResolution?: number;
  /** Decimate the meshes to at most this many triangles in all (a Roblox budget), each taking its share, before the atlas is baked. */
  maxTriangles?: number;
}

function extract(shape: Shape3, opts: HierarchyOptions): Mesh {
  const s = boundsSize(shape.bounds);
  const longest = Math.max(s[0], s[1], s[2]);
  if (!(longest > 0) || isEmpty(shape.bounds)) return surfaceNets(shape, { resolution: 8 }).mesh;
  const resolution = Math.max(8, Math.min(opts.maxResolution ?? 512, Math.ceil(longest / opts.cellSize)));
  return surfaceNets(shape, { resolution, sharp: opts.sharp, crease: opts.crease }).mesh;
}

function shifted(mesh: Mesh, origin: Vec3): Mesh {
  if (origin[0] === 0 && origin[1] === 0 && origin[2] === 0) return mesh;
  const p = new Float32Array(mesh.positions);
  for (let i = 0; i < p.length; i += 3) { p[i] -= origin[0]; p[i + 1] -= origin[1]; p[i + 2] -= origin[2]; }
  return { ...mesh, positions: p };
}

export function buildHierarchy(objects: { name: string; shape: Shape3 }[], opts: HierarchyOptions): SceneHierarchy {
  const meshes: Mesh[] = [];
  const addMesh = (m: Mesh): number => { meshes.push(m); return meshes.length - 1; };
  const roots: SceneNode[] = [];
  const notes: string[] = [];
  const names = opts.names ?? new Map<Shape3, string>();

  // A joint is declared at a world pivot, but a move above it (`(boat + cradle) | ground()`) carries the joint's
  // part elsewhere while the pivot stays in the program's numbers: the node and its mesh follow the move (measured:
  // a grounded boat's rudder and boom nodes sat a unit below its hull in the GLB). Only translations are carried;
  // a rotation or a scale above a joint would also turn its axis, which the node cannot express, so it is reported.
  // The placed sets under a shape, not descending into joints (a joint's part has its own): each keeps its per-copy
  // nodes wherever it sits in the tree, so a `place()` joined to a board with `+` is still one mesh and thirty-two
  // nodes (measured: joined by `+`, an army became one 16 MB mesh).
  const placedIn = (s: Shape3): Shape3[] => {
    const out: Shape3[] = [];
    const seen = new Set<Shape3>();
    const walk = (n: Shape3) => {
      if (seen.has(n) || n.joint) return;
      seen.add(n);
      if (n.instanced) { out.push(n); return; }
      for (const k of n.parts ?? n.inner ?? []) walk(k);
    };
    walk(s);
    return out;
  };
  const placedNodes = (set: Shape3, name: string, parentOrigin: Vec3, offset: Vec3): SceneNode => {
    const { base, placements } = set.instanced!;
    const baseJoints = allJoints(base);
    for (const n of baseJoints) n.joint!.hidden = true;
    const m = extract(base, opts);
    for (const n of baseJoints) n.joint!.hidden = false;
    const mi = triangleCount(m) ? addMesh(m) : -1;
    return {
      name,
      mesh: -1,
      translation: [offset[0] - parentOrigin[0], offset[1] - parentOrigin[1], offset[2] - parentOrigin[2]],
      yaw: 0,
      scale: 1,
      origin: offset,
      children: placements.map((p, i) => ({
        name: `${name}_${i + 1}`,
        mesh: mi,
        translation: [p.x, p.y, p.z],
        yaw: p.yaw,
        scale: p.scale,
        children: [],
        origin: [p.x + offset[0], p.y + offset[1], p.z + offset[2]],
      })),
    };
  };
  /** The step name a placed set was given, for its node, or a numbered fallback. */
  const setName = (set: Shape3, fallback: string): string => names.get(set) ?? fallback;

  const jointNode = (j: Shape3, parentOrigin: Vec3, offset: Vec3): SceneNode => {
    const st = j.joint!;
    const nested = findJoints(st.child);
    const sets = placedIn(st.child);
    for (const n of nested) n.joint!.hidden = true;
    for (const s of sets) s.instanced!.hidden = true;
    const child = offset[0] === 0 && offset[1] === 0 && offset[2] === 0 ? st.child : moveShape(st.child, offset[0], offset[1], offset[2]);
    const own = extract(child, opts);
    for (const n of nested) n.joint!.hidden = false;
    for (const s of sets) s.instanced!.hidden = false;
    const pivot: Vec3 = [st.pivot[0] + offset[0], st.pivot[1] + offset[1], st.pivot[2] + offset[2]];
    const node: SceneNode = {
      name: st.name,
      mesh: triangleCount(own) ? addMesh(shifted(own, pivot)) : -1,
      translation: [pivot[0] - parentOrigin[0], pivot[1] - parentOrigin[1], pivot[2] - parentOrigin[2]],
      yaw: 0,
      scale: 1,
      joint: st.name,
      children: [...sets.map((s, i) => placedNodes(s, setName(s, `${st.name}_set${i + 1}`), pivot, [offset[0], offset[1], offset[2]])), ...nested.map((n) => jointNode(n, pivot, offset))],
      origin: pivot,
    };
    return node;
  };
  /** The translation the transforms between a root and a joint add up to, and whether any of them is not a plain move. */
  const offsetTo = (root: Shape3, j: Shape3): { offset: Vec3; rigid: boolean } => {
    const chain: Shape3[] = [];
    const seen = new Set<Shape3>();
    const find = (n: Shape3): boolean => {
      if (n === j) return true;
      if (seen.has(n) || n.joint) return false;
      seen.add(n);
      chain.push(n);
      for (const k of n.parts ?? n.inner ?? []) if (find(k)) return true;
      chain.pop();
      return false;
    };
    if (!find(root)) return { offset: [0, 0, 0], rigid: true };
    let rigid = true;
    let p: Vec3 = [0, 0, 0], q: Vec3 = [1, 2, 3];
    for (let k = chain.length - 1; k >= 0; k--) {
      const w = chain[k].warp;
      if (!w) continue;
      p = w(p[0], p[1], p[2]); q = w(q[0], q[1], q[2]);
    }
    if (Math.abs(q[0] - p[0] - 1) > 1e-6 || Math.abs(q[1] - p[1] - 2) > 1e-6 || Math.abs(q[2] - p[2] - 3) > 1e-6) rigid = false;
    return { offset: p, rigid };
  };

  for (const obj of objects) {
    if (obj.shape.instanced) {
      const { base, placements } = obj.shape.instanced;
      const baseJoints = allJoints(base);
      for (const n of baseJoints) n.joint!.hidden = true;
      const m = extract(base, opts);
      for (const n of baseJoints) n.joint!.hidden = false;
      const mi = triangleCount(m) ? addMesh(m) : -1;
      roots.push({
        name: obj.name,
        mesh: -1,
        translation: [0, 0, 0],
        yaw: 0,
        scale: 1,
        origin: [0, 0, 0],
        children: placements.map((p, i) => ({
          name: `${obj.name}_${i + 1}`,
          mesh: mi,
          translation: [p.x, p.y, p.z],
          yaw: p.yaw,
          scale: p.scale,
          children: [],
          origin: [p.x, p.y, p.z],
        })),
      });
      continue;
    }
    const joints = allJoints(obj.shape);
    const sets = placedIn(obj.shape);
    for (const n of joints) n.joint!.hidden = true;
    for (const s of sets) s.instanced!.hidden = true;
    const own = extract(obj.shape, opts);
    for (const n of joints) n.joint!.hidden = false;
    for (const s of sets) s.instanced!.hidden = false;
    roots.push({
      name: obj.name,
      mesh: triangleCount(own) ? addMesh(own) : -1,
      translation: [0, 0, 0],
      yaw: 0,
      scale: 1,
      origin: [0, 0, 0],
      children: [
        ...sets.map((s, i) => {
          const { offset, rigid } = offsetTo(obj.shape, s);
          if (!rigid) notes.push(`the placed set "${setName(s, `${obj.name}_set${i + 1}`)}" sits under a rotation or a scale, which its copies' nodes cannot carry: the GLB places it as if that transform were a move.`);
          return placedNodes(s, setName(s, `${obj.name}_set${i + 1}`), [0, 0, 0], offset);
        }),
        ...findJoints(obj.shape).map((j) => {
          const { offset, rigid } = offsetTo(obj.shape, j);
          if (!rigid) notes.push(`joint "${j.joint!.name}" sits under a rotation or a scale, which the export's joint node cannot carry: the GLB places it as if that transform were a move. Rotate or scale the part before the joint, not after.`);
          return jointNode(j, [0, 0, 0], offset);
        }),
      ],
    });
  }

  let triangles = 0;
  for (const m of meshes) triangles += triangleCount(m);
  // A budget is for the whole export: each mesh gives up the same share, so a jointed pet's ten bones together
  // come in under an accessory's four thousand rather than each taking four thousand of its own.
  if (opts.maxTriangles && triangles > opts.maxTriangles) {
    const share = opts.maxTriangles / triangles;
    for (let i = 0; i < meshes.length; i++) meshes[i] = decimate(meshes[i], Math.max(4, Math.floor(triangleCount(meshes[i]) * share)), opts.crease ?? 35);
    triangles = 0;
    for (const m of meshes) triangles += triangleCount(m);
  }
  const out: SceneHierarchy = { roots, meshes, triangles, notes };
  if (opts.texture > 0 && meshes.length > 0) {
    const { merged, ranges, materials } = mergeMeshes(meshes);
    const baked = bakeAtlas(merged, { size: opts.texture });
    const parts = splitBaked(baked.mesh, baked.uv, ranges, materials);
    out.meshes = parts.map((p) => p.mesh);
    out.uvs = parts.map((p) => p.uv);
    out.atlas = baked.image;
    out.atlasCharts = baked.charts;
  }
  return out;
}

/** Concatenate meshes into one, remembering each one's triangle range. */
export function mergeMeshes(meshes: Mesh[]): { merged: Mesh; ranges: [number, number][]; materials: Material[] } {
  const materials: Material[] = [];
  const matIndex = new Map<Material, number>();
  let nv = 0, ni = 0;
  for (const m of meshes) { nv += m.positions.length / 3; ni += m.indices.length; }
  const positions = new Float32Array(nv * 3), normals = new Float32Array(nv * 3), local = new Float32Array(nv * 3);
  const materialIndex = new Uint16Array(nv);
  const indices = new Uint32Array(ni);
  const ranges: [number, number][] = [];
  let vo = 0, io = 0;
  for (const m of meshes) {
    const n = m.positions.length / 3;
    positions.set(m.positions, vo * 3);
    normals.set(m.normals, vo * 3);
    local.set(m.local, vo * 3);
    for (let v = 0; v < n; v++) {
      const mat = m.materials[m.materialIndex[v]];
      let id = matIndex.get(mat);
      if (id === undefined) { id = materials.length; materials.push(mat); matIndex.set(mat, id); }
      materialIndex[vo + v] = id;
    }
    for (let i = 0; i < m.indices.length; i++) indices[io + i] = m.indices[i] + vo;
    ranges.push([io / 3, (io + m.indices.length) / 3]);
    vo += n;
    io += m.indices.length;
  }
  return { merged: { positions, normals, local, materialIndex, materials, indices }, ranges, materials };
}

/** Cut a baked mesh back into parts by triangle range, compacting each part's vertices. */
export function splitBaked(mesh: Mesh, uv: Float32Array, ranges: [number, number][], materials: Material[]): { mesh: Mesh; uv: Float32Array }[] {
  return ranges.map(([t0, t1]) => {
    const map = new Map<number, number>();
    const idx = new Uint32Array((t1 - t0) * 3);
    const pos: number[] = [], nrm: number[] = [], loc: number[] = [], mat: number[] = [], uvs: number[] = [];
    for (let t = t0; t < t1; t++)
      for (let k = 0; k < 3; k++) {
        const v = mesh.indices[t * 3 + k];
        let nv = map.get(v);
        if (nv === undefined) {
          nv = pos.length / 3;
          map.set(v, nv);
          pos.push(mesh.positions[v * 3], mesh.positions[v * 3 + 1], mesh.positions[v * 3 + 2]);
          nrm.push(mesh.normals[v * 3], mesh.normals[v * 3 + 1], mesh.normals[v * 3 + 2]);
          loc.push(mesh.local[v * 3], mesh.local[v * 3 + 1], mesh.local[v * 3 + 2]);
          mat.push(mesh.materialIndex[v]);
          uvs.push(uv[v * 2], uv[v * 2 + 1]);
        }
        idx[(t - t0) * 3 + k] = nv;
      }
    return {
      mesh: { positions: new Float32Array(pos), normals: new Float32Array(nrm), local: new Float32Array(loc), materialIndex: new Uint16Array(mat), materials, indices: idx },
      uv: new Float32Array(uvs),
    };
  });
}

/** Every node with its world transform, depth first, for writers with no hierarchy. */
export function flatten(h: SceneHierarchy): { node: SceneNode; world: Vec3 }[] {
  const out: { node: SceneNode; world: Vec3 }[] = [];
  const walk = (n: SceneNode) => {
    out.push({ node: n, world: n.origin });
    for (const c of n.children) walk(c);
  };
  for (const r of h.roots) walk(r);
  return out;
}
