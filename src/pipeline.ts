/**
 * From a source file to a folder of things to look at. `run()` is the whole
 * pipeline: parse, evaluate, extract the surface, render the sheets, write
 * the exports and the report. The CLI is a thin wrapper over it, and so is
 * the examples generator.
 */
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseObj } from "./import/obj.js";
import { parseGlb } from "./import/glb.js";
import { meshField } from "./mesh/meshSdf.js";
import { box, primitive } from "./sdf/primitives.js";
import { axisAngleToQuat, eulerToQuat, toGlbScene, type GlbAnimation } from "./export/glb.js";
import { toObjScene } from "./export/obj.js";
import { toStl } from "./export/stl.js";
import { toBedrock, toBedrockAnimations, type BedrockClip } from "./export/bedrock.js";
import { ACCESSORY_TRIANGLES, MESHPART_TRIANGLES, toRoblox } from "./export/roblox.js";
import { buildHierarchy, flatten } from "./export/hierarchy.js";
import type { Vec3 } from "./core/vec.js";
import { anchorsOf, allJoints, intersect, jointTreeLines, move, placedBounds, placedShape, rotate as rotateShape, scale as scaleShape, surfaceExtent, surfacePoint } from "./sdf/ops.js";
import { INK, interpolatePose, renderAnimation, renderPoses, type PoseCache, type PoseView, type ShapeAt } from "./render/views.js";
import { Canvas } from "./render/canvas.js";
import { drawText } from "./render/font.js";
import { viewerHtml } from "./export/viewer.js";
import { ENVIRONMENTS, renderBeauty, type BeautyLight, type Environment } from "./render/beauty.js";
import { renderCallouts } from "./render/callouts.js";
import { decodePng, type DecodedPng } from "./render/png.js";
import { assertLine, type AssertResult, evaluate, type Evaluation, type StepRole } from "./lang/interpreter.js";
import { parse } from "./lang/parser.js";
import { isShape3 } from "./lang/values.js";
import { meshBounds, meshVolume, triangleCount, vertexCount, watertightReport, type Mesh } from "./mesh/mesh.js";
import { analyse, isSpeck, type Physics, type Piece } from "./mesh/physics.js";
import { surfaceNets } from "./mesh/surfaceNets.js";
import { meshSteps, renderSheet, renderSlices, renderSteps, renderTurntable, renderView, dimsLabel, type StepView, type ViewName } from "./render/views.js";
import { boundsCenter, boundsSize, isEmpty, type Bounds, type JointPose, type Shape3 } from "./sdf/types.js";

/** The inner-loop preset: a small grid, the sheet only, no exports. A render in a second or two. */
export const QUICK: RunOptions = { quick: true, grid: 64, size: 320, views: [], steps: false, slices: false, turntable: false, obj: false, glb: false, viewer: false, beauty: false };

export interface RunOptions {
  /** A quick pass: the grid is coarse for speed, so thin-part warnings are judged at the grid a full render would use. */
  quick?: boolean;
  /** Write poses.png and the animation strips (default true when the model has joints). */
  poses?: boolean;
  /** false skips the animation strips (the pose sheet stays); a list draws only those animations. */
  animations?: boolean | string[];
  /** false skips the program's asserts. */
  asserts?: boolean;
  /** Cells along the longest side of the model; overrides a `set grid` in the file. Default 128. */
  grid?: number;
  /** Used only when neither `grid` nor the file's `set grid` is given. */
  defaultGrid?: number;
  /** Pixels per view. Default 512. */
  size?: number;
  views?: ViewName[];
  steps?: boolean;
  /** false skips callouts.png, the perspective view with its visible steps named. */
  callouts?: boolean;
  /** A sky for the beauty render, over the program's `set environment`. */
  environment?: string;
  /** Render this declared camera only (beauty.png and the sheet take its view), over the program's `set camera`. */
  camera?: string;
  slices?: boolean;
  turntable?: boolean;
  obj?: boolean;
  glb?: boolean;
  /** Write viewer.html with the GLB embedded. Default true when the GLB is written. */
  viewer?: boolean;
  /** Bake the materials into a texture atlas of this many pixels square for the exports; 0 disables. Default 1024. */
  texture?: number;
  /** Ray-march the field for beauty.png. Default false: it costs seconds. */
  beauty?: boolean;
  /** Pixels for the beauty render; default `size`. */
  beautySize?: number;
  /** Vertex placement: sharp (dual contouring, default) or the rounded surface-nets mean. */
  sharp?: boolean;
  /** Split vertices where faces meet at more than this many degrees, so edges shade and export as edges (or `set crease`); 0 for one smooth normal per vertex. Default 35. */
  crease?: number;
  /** Also write model.roblox.glb: the GLB turned to face -Z with a Handle node and `_Att` attachment nodes from the anchors, sized against Roblox's accessory limits (or `set roblox 1`). */
  roblox?: boolean;
  /** Also write Minecraft Bedrock geometry (model.geo.json and its texture) at this many pixels per unit, a unit being a block; 16 is the game's own (or `set minecraft 16`). */
  minecraft?: number;
  /** The Bedrock geometry is an entity's, which faces north: turn the model half a turn about y (or `set minecraft_entity 1`). */
  minecraftEntity?: boolean;
  /** Perspective camera direction in degrees; defaults 35 and 25, or `set azimuth` / `set elevation`. */
  azimuth?: number;
  elevation?: number;
  /** Called with progress lines. */
  log?: (line: string) => void;
  /** Density in mass units per cubic unit for the report's mass line; default 1 (or `set density`). */
  density?: number;
  /** Show this pose on the sheet, views, slices and beauty render instead of `set pose` (rest by default). */
  pose?: string;
  /** Beauty camera zoom, 1 fits the bounding sphere (or `set zoom`). */
  zoom?: number;
  /** Frame every view on this named step or object instead of the whole model (or `set focus name`). */
  focus?: string;
}

export interface RunResult {
  name: string;
  outDir: string;
  evaluation: Evaluation;
  mesh?: Mesh;
  bounds?: Bounds;
  files: string[];
  warnings: string[];
  report: string;
  timings: Record<string, number>;
  /** Mass properties, pieces and overhangs of the mesh, when there is one. */
  physics?: Physics;
}

// Three decimals, or three significant figures below 0.1, so a 0.4-unit drone's 0.006 lens is not "0.01" (round 7).
const fmt = (v: number): string => {
  const s = Number.isInteger(v) ? String(v) : Math.abs(v) < 0.1 && Math.abs(v) >= 0.0005 ? String(Number(v.toPrecision(3))) : v.toFixed(3).replace(/0+$/, "").replace(/\.$/, "");
  return s === "-0" ? "0" : s;
};

/** The folder the shipped libraries live in: `std/` beside `src/` (and beside `dist/` once built). */
export const STD_DIR = resolve(dirname(fileURLToPath(import.meta.url)), "..", "std");

/**
 * `use "path"` resolves relative to the program that uses it (or, for a
 * library's own uses, relative to that library), except `std/<name>`,
 * which is the library shipped with the tool; `.aix` may be left off.
 * Each file is read once per run.
 */
/** Load a PNG beside the program for material(image=) and decal(image=), once per file. */
export function imageResolver(sourceName: string) {
  const cache = new Map<string, DecodedPng>();
  return (path: string): DecodedPng => {
    const file = resolve(dirname(resolve(sourceName)), path);
    const hit = cache.get(file);
    if (hit) return hit;
    let data: Buffer;
    try {
      data = readFileSync(file);
    } catch {
      throw new Error(`cannot read ${file}`);
    }
    if (!/\.png$/i.test(file)) throw new Error(`${path} is not a PNG; pictures are PNG files`);
    const png = decodePng(data);
    cache.set(file, png);
    return png;
  };
}

export function moduleResolver(sourceName: string) {
  const cache = new Map<string, { source: string; file: string }>();
  return (path: string, from?: string): { source: string; file: string } => {
    const withExt = path.endsWith(".aix") ? path : `${path}.aix`;
    const file = /^std\//.test(withExt) ? resolve(STD_DIR, withExt.slice(4)) : resolve(dirname(resolve(from ?? sourceName)), withExt);
    const hit = cache.get(file);
    if (hit) return hit;
    let source: string;
    try {
      source = readFileSync(file, "utf8");
    } catch {
      const std = existsSync(STD_DIR) ? readdirSync(STD_DIR).filter((f) => f.endsWith(".aix")).map((f) => `std/${f.replace(/\.aix$/, "")}`) : [];
      throw new Error(`cannot read ${file}${std.length ? `; the shipped libraries are ${std.join(", ")}` : ""}`);
    }
    const out = { source, file };
    cache.set(file, out);
    return out;
  };
}

/** Imports resolve relative to the source file's folder: OBJ or GLB, sampled into a field. */
export function importResolver(sourceName: string, log: (line: string) => void = () => {}) {
  const cache = new Map<string, Shape3>();
  return (path: string, opts: { resolution: number }): Shape3 => {
    const file = resolve(dirname(resolve(sourceName)), path);
    const key = `${file}@${opts.resolution}`;
    const hit = cache.get(key);
    if (hit) return hit;
    let data: Buffer;
    try {
      data = readFileSync(file);
    } catch {
      throw new Error(`cannot read ${file}`);
    }
    const lower = file.toLowerCase();
    const mesh = lower.endsWith(".glb") ? parseGlb(data) : lower.endsWith(".obj") ? parseObj(data.toString("utf8")) : undefined;
    if (!mesh) throw new Error(`only .obj and .glb files can be imported`);
    const t0 = performance.now();
    log(`import ${path}: sampling ${mesh.indices.length / 3} triangles at resolution ${opts.resolution}...`);
    const field = meshField(mesh, opts.resolution);
    log(`import ${path}: ${field.triangles} triangles sampled at cell ${fmt(field.cell)} in ${Math.round(performance.now() - t0)} ms${field.openness > 0.01 ? ` (mesh is not closed: ${(field.openness * 100).toFixed(0)}% of rays end inside)` : ""}`);
    const shape = primitive(field.dist, field.bounds, 8);
    shape.sampledAt = field.cell;
    cache.set(key, shape);
    return shape;
  };
}

/**
 * A part thinner than about a cell on any axis can drop out of the mesh
 * entirely (measured: rails at 0.9 of a cell vanished, a plate at 1.3
 * survived); say so from its bounds alone, so `check` can say it too.
 */
export function thinWarnings(evaluation: Evaluation, cellSize: number, grid: number, thin = 1.2): string[] {
  const out: string[] = [];
  const gridFor = (t: number) => Math.min(512, Math.ceil((grid * 2.5 * cellSize) / t));
  const reportedFeatures = new Set<number>();
  const notedShapes = new Set<Shape3>();
  const geometry = geometrySteps(evaluation);
  for (const st of evaluation.steps) {
    if (!isShape3(st.value) || !geometry.has(st.name) || isEmpty(st.value.bounds)) continue;
    const ss = boundsSize(st.value.bounds);
    const t = Math.min(ss[0], ss[1], ss[2]);
    if (t > 0 && t < cellSize * thin) {
      out.push(`'${st.name}' (line ${st.line}) is only ${fmt(t)} units thin, ${fmt(t / cellSize)} of the ${fmt(cellSize)} cell: it may be missing or broken in the mesh. Thicken it to ${fmt(cellSize * 2)} (two cells) or raise the grid (set grid ${gridFor(t)}).`);
      // Its own feature size is settled too, or the union above it would repeat the warning under its own name
      // (measured: 'house', forty parts, listed as thin for its mullion).
      if (st.value.feature !== undefined) reportedFeatures.add(Math.round(st.value.feature * 1e6));
      continue;
    }
    // An import is one step: nothing in its mesh thinner than its sampling cell survived, whatever the render grid.
    if (st.value.sampledAt !== undefined && st.value.sampledAt > cellSize * 1.05) {
      out.push(`'${st.name}' (line ${st.line}) is an import sampled at cell ${fmt(st.value.sampledAt)}, coarser than this render's ${fmt(cellSize)}: anything in its mesh thinner than about ${fmt(st.value.sampledAt * 1.2)} (rails, hooks, rungs) is gone or broken, whatever the grid. Give import() resolution=${Math.ceil(Math.max(...boundsSize(st.value.bounds)) / cellSize)} to match.`);
      continue;
    }
    // A gap (a letter's counters, a slot) narrower than a cell closes up; reported once per size like features.
    // Half a cell: dual contouring resolves a counter at most of a cell (measured: rim lettering at 0.8 of a cell read
    // fine), while one that is closed or nearly so becomes blobs.
    // Between half a cell and a cell it survives but the mesh around it may not be watertight (measured: a nameplate's
    // counters at 0.7 of a cell left open edges in the GLB), so that band warns more softly.
    const g = st.value.gap;
    if (g !== undefined && g >= 0 && g < cellSize) {
      const gkey = Math.round(g * 1e6) + 0.5;
      if (!reportedFeatures.has(gkey)) {
        reportedFeatures.add(gkey);
        const what = st.value.gapWhat ?? "a gap (a letter's counters, the space between letters, a slot)";
        const between = /space between/.test(what);
        const fix = between ? "more spacing= or a lighter weight" : "a larger size or a lighter weight (under a quarter of the size for lowercase), or capitals";
        out.push(
          g <= 0
            ? `'${st.name}' (line ${st.line}): ${what} closes up at this weight. Use ${fix}.`
            : g < cellSize * 0.5
              ? `'${st.name}' (line ${st.line}): ${what} is only ${fmt(g)} wide, ${fmt(g / cellSize)} of the ${fmt(cellSize)} cell, and closes up in the mesh. Use ${fix}, or raise the grid (set grid ${gridFor(g)}).`
              : `'${st.name}' (line ${st.line}): ${what} is ${fmt(g)} wide, ${(g / cellSize).toFixed(2)} of the ${fmt(cellSize)} cell, so the mesh there may not be watertight. For a print or a clean GLB use ${fix}, or raise the grid (set grid ${gridFor(g)}).`,
        );
      }
    }
    // What the constructor itself noticed, once, at the step that made it (a curve bent tighter than its tube).
    if (st.value.notes && !notedShapes.has(st.value)) {
      notedShapes.add(st.value);
      for (const note of st.value.notes) out.push(`'${st.name}' (line ${st.line}): ${note}`);
    }
    // A wall, tube or stroke inside a thick step: bounds cannot see it, so the shape carries the size itself.
    // Reported once per size, at the step that introduced it, not again at every step built on top.
    const f = st.value.feature;
    if (f === undefined || !(f > 0) || f >= cellSize * thin) continue;
    const key = Math.round(f * 1e6);
    if (reportedFeatures.has(key)) continue;
    reportedFeatures.add(key);
    out.push(`'${st.name}' (line ${st.line}) has a part (a wall, slat, rod, tube at its thin end, or stroke) only ${fmt(f)} thick, ${fmt(f / cellSize)} of the ${fmt(cellSize)} cell: it may be missing or broken in the mesh. Thicken it to ${fmt(cellSize * 2)} (two cells) or raise the grid (set grid ${gridFor(f)}).`);
  }
  return out;
}

/**
 * The steps whose shape is part of the output's geometry: reachable from the
 * output through the shape tree. A step used only as a decal's region, or
 * only to measure something, is "used" but adds no surface, so it gets no
 * thin-part warning and is never named as holding a loose piece.
 */
export function geometrySteps(evaluation: Evaluation): Set<string> {
  const out = new Set<string>();
  const roots = evaluation.objects.length ? evaluation.objects.map((o) => o.shape) : evaluation.output ? [evaluation.output] : [];
  const reachable = new Set<Shape3>();
  const walk = (n: Shape3) => {
    if (reachable.has(n)) return;
    reachable.add(n);
    for (const c of n.inner ?? []) walk(c);
    for (const c of n.parts ?? []) walk(c);
    if (n.joint) walk(n.joint.child);
    if (n.instanced) walk(n.instanced.base);
  };
  for (const r of roots) walk(r);
  for (const st of evaluation.steps) if (isShape3(st.value) && reachable.has(st.value)) out.add(st.name);
  return out;
}

/**
 * The steps to name for a point: the innermost named shapes whose surface
 * passes within `tol` of it, found by walking the tree from the output
 * and pulling the point back through each transform's inverse on the way
 * down. A step built at the origin and moved into place is tested where
 * it ends up, in its own frame, so a loose lug is blamed on the lug and
 * not on the arm it was welded to (measured: round 3 named the outermost
 * placed union, round 2 named a part by its box). The tolerance follows
 * the point through scales and warps by measuring how the inverse
 * stretches a step of `tol`. Smallest box first, so the most specific
 * name comes first.
 */
function stepsNearDetailed(evaluation: Evaluation, c: [number, number, number], tol: number): { name: string; leaf: boolean; d: number; parents: string[] }[] {
  const names = new Map<Shape3, string>();
  for (const st of evaluation.steps) if (isShape3(st.value) && !names.has(st.value)) names.set(st.value, st.name);
  const roots = evaluation.objects.length ? evaluation.objects.map((o) => o.shape) : evaluation.output ? [evaluation.output] : [];
  // Every named shape within reach, with how close its surface passes, its depth in the tree and whether it is
  // innermost: the closest first (by the cell, so a hand's tip a fifth of a cell from a recess wall names both, not
  // a dial a whole cell away: measured on a clock), then innermost, then the nearest ancestors.
  const found = new Map<string, { d: number; depth: number; leaf: boolean; parents: Set<string>; exposed: boolean }>();
  // The whole model's field, for telling an exposed surface from a buried one.
  const modelDist = roots.length ? (x: number, y: number, z: number) => Math.min(...roots.map((r) => r.dist(x, y, z))) : undefined;
  // The forward maps of the nodes walked through so far, to carry a point in a child's frame back to the world.
  const warps: ((x: number, y: number, z: number) => Vec3)[] = [];
  const toWorld = (p: Vec3): Vec3 => { let q = p; for (let i = warps.length - 1; i >= 0; i--) q = warps[i](q[0], q[1], q[2]); return q; };
  let budget = 20000;
  // Returns whether a named step at or below `n` was within reach of the point.
  const walk = (n: Shape3, x: number, y: number, z: number, t: number, depth: number, parent: string): boolean => {
    if (--budget < 0 || isEmpty(n.bounds)) return false;
    const b = n.bounds;
    if (x < b.min[0] - t || x > b.max[0] + t || y < b.min[1] - t || y > b.max[1] + t || z < b.min[2] - t || z > b.max[2] + t) return false;
    const dn = Math.abs(n.dist(x, y, z));
    if (dn > t) return false;
    let cx = x, cy = y, cz = z, ct = t;
    const pushed = !!(n.unwarp && n.warp);
    if (pushed) warps.push(n.warp!);
    if (n.unwarp) {
      const q = n.unwarp(x, y, z);
      let stretch = 0;
      for (const [ex, ey, ez] of [[t, 0, 0], [0, t, 0], [0, 0, t]]) {
        const r = n.unwarp(x + ex, y + ey, z + ez);
        stretch = Math.max(stretch, Math.hypot(r[0] - q[0], r[1] - q[1], r[2] - q[2]));
      }
      cx = q[0]; cy = q[1]; cz = q[2]; ct = stretch > 0 && Number.isFinite(stretch) ? stretch : t;
    }
    let below = false;
    const name = names.get(n);
    const here = name ?? parent;
    for (const k of n.parts ?? n.inner ?? []) if (walk(k, cx, cy, cz, ct, depth + 1, here)) below = true;
    if (n.instanced && !n.parts) below = walk(n.instanced.base, cx, cy, cz, ct, depth + 1, here) || below;
    if (pushed) warps.pop();
    if (name === undefined) return below;
    const prev = found.get(name);
    const parents = prev?.parents ?? new Set<string>();
    if (parent) parents.add(parent);
    // Exposed or buried: the step's nearest surface point, read back in the model, sits on the outside (the part
    // the edge is on) or inside another part (a cap ending inside a housing, which is not the part to name).
    let exposed = prev?.exposed ?? false;
    if (!exposed && modelDist) {
      const q = surfacePoint(n, x, y, z);
      // Back to the world through the transforms above (the walk pulled the point into this node's frame).
      const w = toWorld(q);
      exposed = modelDist(w[0], w[1], w[2]) > -tol * 0.5;
    }
    found.set(name, { d: Math.min(dn / t, prev?.d ?? Infinity), depth: Math.max(depth, prev?.depth ?? 0), leaf: !below || (prev?.leaf ?? false), parents, exposed });
    return true;
  };
  for (const r of roots) walk(r, c[0], c[1], c[2], tol, 0, "");
  const bucket = (v: number) => Math.round(v * 3);
  return [...found.entries()]
    .sort((a, b) => Number(b[1].exposed) - Number(a[1].exposed) || bucket(a[1].d) - bucket(b[1].d) || Number(b[1].leaf) - Number(a[1].leaf) || b[1].depth - a[1].depth)
    .map(([name, f]) => ({ name, leaf: f.leaf, d: f.d, parents: [...f.parents] }));
}

/** The names near a point, quoted, at most `limit`: what the warnings print. */
export function stepsNear(evaluation: Evaluation, c: [number, number, number], tol: number, limit = 2): string[] {
  return stepsNearDetailed(evaluation, c, tol).slice(0, limit).map((n) => `'${n.name}'`);
}

/**
 * Whether a shape is painted all over, not at all, or only in parts, read
 * from the tree: paint() marks its result, a wrapper takes its child's
 * state, a union combines its parts. Used to catch `a + b | paint(m)`,
 * which paints only b because `|` binds tighter (measured: a beige lid).
 */
export type PaintState = "all" | "none" | "mixed";
export function paintState(s: Shape3, memo = new Map<Shape3, PaintState>()): PaintState {
  const known = memo.get(s);
  if (known) return known;
  let state: PaintState;
  if (s.painted) state = "all";
  else {
    // A cutter's paint never shows, so a difference or intersection takes only its first shape's state.
    const kids = s.cut && s.inner ? [s.inner[0]] : [...(s.parts ?? s.inner ?? []), ...(s.joint ? [s.joint.child] : []), ...(s.instanced ? [s.instanced.base] : [])];
    if (kids.length === 0) state = "none";
    else {
      const states = new Set(kids.map((k) => paintState(k, memo)));
      state = states.size === 1 ? [...states][0] : "mixed";
    }
  }
  memo.set(s, state);
  return state;
}

/**
 * A cut that removes almost nothing: `a - b` where b's box overlaps a's
 * but the material both cover is under a few cells, or none (measured: a
 * bishop's slot cut 0.014 thick, tangent to the mitre, left no mark and
 * no message). The overlap of the two boxes is sampled on a fixed
 * lattice, so the estimate is the same every run.
 */
export function cutWarnings(evaluation: Evaluation, cellSize: number): string[] {
  const out: string[] = [];
  if (!(cellSize > 0)) return out;
  const geometry = geometrySteps(evaluation);
  for (const st of evaluation.steps) {
    const v = st.value;
    if (!isShape3(v) || !v.cut || !v.inner || v.inner.length < 2 || !geometry.has(st.name)) continue;
    const a = v.inner[0], b = v.inner[1];
    if (isEmpty(a.bounds) || isEmpty(b.bounds)) continue;
    // An intersection keeps what both cover; a difference removes it. Either way the shared material is the measure.
    const lo = [0, 1, 2].map((k) => Math.max(a.bounds.min[k], b.bounds.min[k]));
    const hi = [0, 1, 2].map((k) => Math.min(a.bounds.max[k], b.bounds.max[k]));
    if (lo.some((v0, k) => v0 >= hi[k])) {
      if (!intersectionLike(v)) out.push(`'${st.name}' (line ${st.line}): the cut removes nothing; the cutter's box (${dimsLabel(b.bounds)} at ${b.bounds.min.map(fmt).join(", ")}) does not reach the shape's (${dimsLabel(a.bounds)} at ${a.bounds.min.map(fmt).join(", ")}).`);
      continue;
    }
    const n = 14;
    let inside = 0, cutter = 0;
    for (let i = 0; i < n; i++)
      for (let j = 0; j < n; j++)
        for (let k = 0; k < n; k++) {
          const x = lo[0] + ((i + 0.5) / n) * (hi[0] - lo[0]);
          const y = lo[1] + ((j + 0.5) / n) * (hi[1] - lo[1]);
          const z = lo[2] + ((k + 0.5) / n) * (hi[2] - lo[2]);
          if (b.dist(x, y, z) >= 0) continue;
          cutter++;
          if (a.dist(x, y, z) < 0) inside++;
        }
    if (intersectionLike(v) || cutter === 0) continue;
    const boxVol = (hi[0] - lo[0]) * (hi[1] - lo[1]) * (hi[2] - lo[2]);
    const removed = (inside / (n * n * n)) * boxVol;
    // Two readings of "almost nothing": the shared material is under a few cells, whatever the cutter; or a cutter
    // that sits mostly inside the shape's box (a slot, a hole, not a trim under the floor) barely touches the shape.
    const bs = boundsSize(b.bounds);
    const slotLike = boxVol > bs[0] * bs[1] * bs[2] * 0.5;
    if (removed < cellSize ** 3 * 8 || (slotLike && inside < cutter * 0.04))
      out.push(`'${st.name}' (line ${st.line}): the cut removes ${inside === 0 ? "nothing the samples could find" : `only about ${fmt(removed)} cubic units, ${((inside / cutter) * 100).toFixed(0)}% of the cutter where the boxes overlap`}: the cutter barely reaches into the shape. Push it in further or make it thicker, or it leaves no mark.`);
  }
  return out;
}

/** Whether a cut node is an intersection (keeps the overlap) rather than a difference; both carry `cut`, only a difference keeps a's box. */
function intersectionLike(v: Shape3): boolean {
  const a = v.inner![0];
  return [0, 1, 2].some((k) => v.bounds.min[k] > a.bounds.min[k] + 1e-9 || v.bounds.max[k] < a.bounds.max[k] - 1e-9);
}

/** Warnings for steps that join painted and unpainted parts, once, at the smallest such step. */
/**
 * Glass on a field that is a bound rather than a distance: a loft, a smooth boolean, a warp or a non-uniform scale.
 * The beauty render marches through glass, and a bound makes it stop short in bands (round 9: a liquid seen through a
 * lofted flacon drew contour lines; the same bottle as a rounded box rendered clean).
 */
export function glassWarnings(evaluation: Evaluation): string[] {
  const geometry = geometrySteps(evaluation);
  const out: string[] = [];
  const names = new Map<Shape3, string>();
  for (const st of evaluation.steps) if (isShape3(st.value) && !names.has(st.value)) names.set(st.value, st.name);
  for (const st of evaluation.steps) {
    const v = st.value;
    if (!isShape3(v) || !v.painted || !geometry.has(st.name) || isEmpty(v.bounds)) continue;
    const c = boundsCenter(v.bounds);
    if (!(v.hit(c[0], c[1], c[2]).mat.transmit > 0)) continue;
    // The first bound field under the paint, by name when it has one.
    let found: Shape3 | undefined;
    const seen = new Set<Shape3>();
    const walk = (n: Shape3) => {
      if (found || seen.has(n)) return;
      seen.add(n);
      if (n.bound) { found = n; return; }
      for (const k of n.parts ?? n.inner ?? []) walk(k);
    };
    walk(v);
    if (!found) continue;
    const what = names.get(found);
    out.push(`'${st.name}' (line ${st.line}) is glass on a field that is a bound, not a distance${what ? ` ('${what}': a loft, a smooth union, a warp or a non-uniform scale)` : " (a loft, a smooth union, a warp or a non-uniform scale)"}: the beauty render bands behind it. Build glass from exact shapes (a rounded box, a cylinder, a revolve) or drop transmit.`);
  }
  return out;
}

export function paintWarnings(evaluation: Evaluation): string[] {
  const memo = new Map<Shape3, PaintState>();
  const geometry = geometrySteps(evaluation);
  const out: string[] = [];
  // paint() over a union whose named parts already had materials of their own repaints them all; when that is
  // what happened, say which parts lost their material (round 4: a bucket's chrome pins went yellow with the arm).
  const names = new Map<Shape3, { name: string; line: number }>();
  for (const st of evaluation.steps) if (isShape3(st.value) && !names.has(st.value)) names.set(st.value, { name: st.name, line: st.line });
  for (const st of evaluation.steps) {
    const v = st.value;
    if (!isShape3(v) || !v.painted || !geometry.has(st.name) || !v.inner?.length) continue;
    const lost: string[] = [];
    const seen = new Set<Shape3>();
    const walk = (n: Shape3) => {
      if (seen.has(n)) return;
      seen.add(n);
      const named = names.get(n);
      if (n.painted && named && n !== v) { lost.push(`'${named.name}'`); return; }
      for (const k of n.parts ?? n.inner ?? []) walk(k);
      if (n.joint) walk(n.joint.child);
    };
    walk(v.inner[0]);
    if (lost.length) out.push(`'${st.name}' (line ${st.line}) paints over parts that already had a material: ${lost.slice(0, 4).join(", ")}${lost.length > 4 ? ", ..." : ""} now show this one. Paint the bare parts before the union, or leave the union unpainted.`);
  }
  const mixed = evaluation.steps.filter((st) => isShape3(st.value) && geometry.has(st.name) && paintState(st.value, memo) === "mixed");
  if (!mixed.length) return out;
  // The smallest mixed step whose children are not themselves mixed is where the mix was made.
  const leafMixed = mixed.filter((st) => {
    const v = st.value as Shape3;
    const kids = v.parts ?? v.inner ?? [];
    return !kids.some((k) => paintState(k, memo) === "mixed");
  });
  const first = (leafMixed.length ? leafMixed : mixed)[0];
  const v = first.value as Shape3;
  const kids = v.parts ?? v.inner ?? [];
  const bare = kids.filter((k) => paintState(k, memo) === "none");
  const named = bare.map((k) => evaluation.steps.find((st) => st.value === k)?.name).filter((n): n is string => !!n);
  const what = named.length ? named.map((n) => `'${n}'`).join(", ") : bare.length ? `${bare.length} part${bare.length === 1 ? "" : "s"} (${bare.map((k) => dimsLabel(k.bounds)).slice(0, 3).join(", ")})` : "a part";
  out.push(`'${first.name}' (line ${first.line}) joins painted and unpainted parts: ${what} ${bare.length > 1 ? "have" : "has"} no material and will render as clay. '|' binds tighter than '+', so \`a + b | paint(m)\` paints only b: wrap the union in parentheses.`);
  return out;
}

/** A speck: tiny in volume and in extent, a sliver left by a cut or a blend neck (round 5: counted as a piece and as a cavity). */

/** The asserts row: how many passed, and each failure as check prints it. */
export function assertsRow(asserts: AssertResult[]): string {
  const failed = asserts.filter((a) => !a.passed);
  const passed = asserts.length - failed.length;
  if (!failed.length) return `${passed} pass`;
  return `${passed} pass, ${failed.length} fail: ${failed.map((a) => assertLine(a).replace(/^assert /, "")).join("; ")}`;
}

/** The pieces row: the count without cavities, and for every piece but the largest its volume, centre and step. */
function piecesRow(physics: Physics, evaluation: Evaluation, cellSize: number): string {
  const solid = physics.pieces.filter((pc) => !pc.cavity && !isSpeck(pc, physics, cellSize));
  if (solid.length <= 1) return `${solid.length}`;
  const rest = solid.slice(1, 5).map((pc) => {
    const at = stepsNear(evaluation, pc.centre, Math.max(pc.size * 0.5, Math.cbrt(Math.abs(pc.volume))) + cellSize * 2);
    return `${fmt(Math.abs(pc.volume))} at (${pc.centre.map(fmt).join(", ")})${at.length ? ` in ${at.join(", ")}` : ""}`;
  });
  return `${solid.length} (the largest ${fmt(Math.abs(solid[0].volume))}; then ${rest.join("; ")}${solid.length > 5 ? "; ..." : ""})`;
}

/**
 * Steps whose feature is between 1.2 and 2 cells: they mesh (the thin warning's threshold is 1.2) but a tube or a
 * wall that thin often meshes with open edges, so when the mesh is not watertight they are the first suspects
 * (measured: a bicycle's spokes and stays at 1.3 to 1.8 cells carried the edges; at 2 cells they were clean).
 */
export function nearlyThin(evaluation: Evaluation, cellSize: number): string {
  const geometry = geometrySteps(evaluation);
  const seen = new Set<number>();
  const names: string[] = [];
  for (const st of evaluation.steps) {
    if (!isShape3(st.value) || !geometry.has(st.name)) continue;
    const f = st.value.feature;
    if (f === undefined || !(f >= cellSize * 1.2) || f >= cellSize * 2) continue;
    const key = Math.round(f * 1e6);
    if (seen.has(key)) continue;
    seen.add(key);
    names.push(`'${st.name}' (${(f / cellSize).toFixed(1)} cells)`);
  }
  if (!names.length) return "";
  return ` Parts between 1.2 and 2 cells thick mesh but often not watertight: ${names.slice(0, 6).join(", ")}${names.length > 6 ? ", ..." : ""}; thicken them to two cells or raise the grid.`;
}

/** The cavities row: enclosed voids, without the sub-cell ones a grazing contact leaves (those are the watertight row's). */
function cavitiesRow(physics: Physics, cellSize: number): string {
  const cavities = physics.pieces.filter((pc) => pc.cavity && !isSpeck(pc, physics, cellSize));
  if (!cavities.length) return "none";
  return cavities.slice(0, 4).map((pc) => `volume ${fmt(Math.abs(pc.volume))} at (${pc.centre.map(fmt).join(", ")})`).join("; ") + " (enclosed voids, not loose parts)";
}

/**
 * The watertight line, with where the bad edges are and which steps hold
 * them, so it can be acted on. Each cluster names the steps whose surface
 * passes there; when only one step does, two of its own surfaces cross
 * (a tube's segments at a join, a fold in a displaced skin), and it says
 * so rather than naming the step's parent as if it were the other party
 * (round 5: "'swing_branch', 'wood'" read as a branch meeting the tree).
 * A tally per step follows, so one construct carrying every edge shows
 * in one read.
 */
export function watertightNote(w: ReturnType<typeof watertightReport>, evaluation: Evaluation, cellSize: number, edgeList: { at: Vec3; count: number; steps: string[] }[] = [], posed = false): string {
  if (w.ok || !w.where || isEmpty(w.where)) return w.note;
  const tally = new Map<string, number>();
  let planar = 0;
  const all = w.clusters ?? [];
  const spots = all.map((cl, index) => {
    // Named at an edge that is on the model, not at the cluster's mean, which for a ring of edges is inside the part.
    const near = stepsNearDetailed(evaluation, cl.at, cellSize * 2);
    const leaves = near.filter((n) => n.leaf).slice(0, 2);
    const names = leaves.length ? leaves : near.slice(0, 1);
    for (const n of names) tally.set(n.name, (tally.get(n.name) ?? 0) + cl.count);
    // One step reached through two named parents is two placements of the same part crossing (two boards of one
    // panel), which is worth more than "with itself".
    const twice = names.length === 1 && names[0].parents.length >= 2 ? names[0].parents.slice(0, 2) : undefined;
    // One name alone: the step's own surface folds or creases there, or a sample-plane coincidence; a straight
    // tube has no second surface to cross, so it is not called "with itself" (round 6: that read as nonsense).
    const label = names.length === 0 ? "" : names.length === 1 ? (twice ? ` in '${names[0].name}' twice, as '${twice[0]}' and '${twice[1]}'` : ` in '${names[0].name}' alone (no other part within a cell: two copies of the same step touching, a crease of its own surface, or the mesher's noise at a few edges)`) : ` in ${names.map((n) => `'${n.name}'`).join(", ")}`;
    edgeList.push({ at: cl.at, count: cl.count, steps: names.map((n) => n.name) });
    if (index >= 3) return "";
    // Edges that all share one coordinate lie on a plane: a flat face or a widest line sitting exactly on a sample
    // plane, which the extractor cannot resolve (measured: a down tube's side and a tyre's equator on grid planes).
    const flat = cl.count >= 3 ? [0, 1, 2].find((k) => cl.box.max[k] - cl.box.min[k] < cellSize * 0.05) : undefined;
    if (flat !== undefined) planar++;
    const plane = flat !== undefined ? `, all on the plane ${"xyz"[flat]} = ${fmt(cl.at[flat])}` : "";
    return `${cl.count} at (${cl.at.map(fmt).join(", ")})${label}${plane}`;
  });
  const byStep = [...tally.entries()].sort((a, b) => b[1] - a[1]).slice(0, 6).map(([n, c]) => `'${n}' ${c}`).join(", ");
  // In a pose the sample planes fall where the pose puts the part, so a nudge that clears them at rest need not hold
  // and one that clears them here need not hold at rest (round 8: a lug blamed on a plane in two poses).
  const planeNote = planar ? (posed ? " Edges all on one plane are a surface lying exactly on a sample plane in this pose, not a thin part; the planes move with the pose, so judge watertightness at rest and leave these." : " Edges all on one plane are a surface lying exactly on a sample plane, not a thin part: move the part or the grid by a fraction of a cell, or change the radius a little.") : "";
  const more = all.length > 3 ? ` and ${all.length - 3} more places (every one is in report.json under watertight)` : "";
  return `${w.note} The edges are mostly ${spots.filter(Boolean).join("; ")}${more}.${byStep ? ` By step, over all of them: ${byStep}.` : ""}${planeNote}`;
}

/**
 * Many thin-part warnings at once (a scene's chalk lines, teeth, rails) are
 * one problem with one answer, so past three they fold into a line that
 * names the steps and the single grid that covers them all.
 */
export function foldThinWarnings(list: string[]): string[] {
  if (list.length <= 3) return list;
  const names = list.map((w) => w.match(/^'([^']+)'/)?.[1] ?? "?");
  const grids = list.map((w) => Number(w.match(/set grid (\d+)/)?.[1] ?? 0));
  const thinnest = list.map((w) => Number(w.match(/only ([\d.]+)/)?.[1] ?? Infinity));
  const worst = thinnest.indexOf(Math.min(...thinnest));
  return [
    `${list.length} steps are thinner than a grid cell (${names.slice(0, 10).join(", ")}${names.length > 10 ? ", ..." : ""}), the thinnest '${names[worst]}' at ${fmt(thinnest[worst])}: they may be missing or broken in the mesh. Thicken them, or set grid ${Math.max(...grids)} covers them all.`,
  ];
}

/**
 * The surface's extent from a coarse extraction, grown by two coarse cells,
 * within the bounds; the bounds themselves when they are already tight (so a
 * well-bounded model extracts exactly as before) or when nothing was found.
 */
export function tightBounds(shape: Shape3, rays = 48): Bounds {
  const b = shape.bounds;
  if (isEmpty(b)) return b;
  // Rays from each face of the box find the surface's extent; grown by two ray spacings so a part between rays is kept.
  const e = surfaceExtent(shape, rays);
  const bs = boundsSize(b);
  const t: Bounds = {
    min: [0, 1, 2].map((k) => Math.max(b.min[k], e.min[k] - (2 * bs[(k + 1) % 3]) / rays - (2 * bs[(k + 2) % 3]) / rays)) as [number, number, number],
    max: [0, 1, 2].map((k) => Math.min(b.max[k], e.max[k] + (2 * bs[(k + 1) % 3]) / rays + (2 * bs[(k + 2) % 3]) / rays)) as [number, number, number],
  };
  const ts = boundsSize(t);
  const loose = [0, 1, 2].some((k) => ts[k] < bs[k] * 0.94);
  return loose ? t : b;
}

/** The grid and cell size a render of this evaluation would use, from its settings and bounds. */
export function cellFor(evaluation: Evaluation, gridOverride?: number): { grid: number; cellSize: number } {
  const grid = Math.max(8, Math.round(gridOverride ?? (evaluation.settings.grid as number | undefined) ?? 128));
  const b = evaluation.output?.bounds;
  if (!b || isEmpty(b)) return { grid, cellSize: 0 };
  const s = boundsSize(b);
  return { grid, cellSize: Math.max(s[0], s[1], s[2]) / grid };
}

/** The thin-part warnings a Bedrock export at `px` pixels per block gets: a part under a voxel is lost in the geometry. */
export function minecraftThinWarnings(ev: Evaluation, px: number, grid: number): string[] {
  const voxel = 1 / px;
  return foldThinWarnings(thinWarnings(ev, voxel, grid, 1)).map((w) => `minecraft: ${w.replace(/ or raise the grid \(set grid \d+\)/, "").replace(/, or set grid \d+ covers them all/, "").replace(/in the mesh/g, "in the geometry")} (a voxel is ${fmt(voxel)} at ${px} pixels per block; set minecraft ${px * 2} halves it)`);
}

/** The mesh's vertices inside a box, for a camera that fits one part; undefined when too few to fit (the box's corners then do). */
function pointsWithin(mesh: Mesh, b: Bounds): Float32Array | undefined {
  const pos = mesh.positions;
  const out: number[] = [];
  for (let i = 0; i < pos.length; i += 3) {
    const x = pos[i], y = pos[i + 1], z = pos[i + 2];
    if (x >= b.min[0] && x <= b.max[0] && y >= b.min[1] && y <= b.max[1] && z >= b.min[2] && z <= b.max[2]) out.push(x, y, z);
  }
  return out.length >= 24 ? new Float32Array(out) : undefined;
}

/** A ghost is meshed at this many times the close-up's cell. */
const GHOST_CELL = 2;

/** The shape clipped to a box: the cut faces keep the shape's own material (measured: a marble base read as clay). */
function clipTo(shape: Shape3, frame: Bounds): Shape3 {
  const fc = boundsCenter(frame), fsz = boundsSize(frame);
  const clipBox = move(box(fsz[0], fsz[1], fsz[2]), fc[0], fc[1], fc[2]);
  return {
    kind: "shape3",
    dist: (x, y, z) => Math.max(shape.dist(x, y, z), clipBox.dist(x, y, z)),
    hit: (x, y, z) => { const q = shape.hit(x, y, z); return { ...q, d: Math.max(q.d, clipBox.dist(x, y, z)) }; },
    bounds: frame,
    cost: shape.cost + 1,
  };
}

/**
 * A focus close-up in two: the focused part (already placed where the output puts it) clipped to the frame, and the
 * ghost, everything else the frame holds with the part carved out of it, grown by `margin` so the two surfaces never
 * coincide and the ghost reads as the neighbour it is.
 */
function focusSplit(output: Shape3, part: Shape3, frame: Bounds, margin: number): { focus: Shape3; ghost: Shape3 } {
  const focus = clipTo(part, frame);
  const rest = clipTo(output, frame);
  const ghost: Shape3 = {
    kind: "shape3",
    dist: (x, y, z) => Math.max(rest.dist(x, y, z), margin - part.dist(x, y, z)),
    hit: (x, y, z) => { const q = rest.hit(x, y, z); return { ...q, d: Math.max(q.d, margin - part.dist(x, y, z)) }; },
    bounds: frame,
    cost: rest.cost + part.cost,
  };
  return { focus, ghost };
}

/** Parse and evaluate only: what `aixle check` does. `sourceName` lets imports resolve. */
export function check(source: string, sourceName = "model.aix", log?: (line: string) => void, jointPoses?: Record<string, JointPose>, poseName?: string, skipAsserts = false): Evaluation {
  return evaluate(parse(source), { resolveImport: importResolver(sourceName, log), resolveModule: moduleResolver(sourceName), resolveImage: imageResolver(sourceName), moduleFrom: sourceName, jointPoses, poseName, skipAsserts });
}

/**
 * Every assert with its verdict: the rest evaluation's own, and for each pose an assert names (`pose=name`) the
 * verdict from the program evaluated in that pose, which `evalIn` supplies (undefined for a pose that does not
 * exist; the rest evaluation already warned about it).
 */
export function collectAsserts(rest: Evaluation, evalIn: (poseName: string) => Evaluation | undefined): AssertResult[] {
  const out: AssertResult[] = rest.asserts.filter((a) => !a.pose || a.pose === "rest");
  const poseNames = [...new Set(rest.asserts.filter((a) => a.pose && a.pose !== "rest").map((a) => a.pose!))];
  for (const pn of poseNames) {
    const ev = evalIn(pn);
    if (!ev) continue;
    out.push(...ev.asserts.filter((a) => a.pose === pn && !a.pending));
  }
  return out.sort((a, b) => a.line - b.line);
}

export function run(source: string, sourceName: string, outDir: string, opts: RunOptions = {}): RunResult {
  const log = opts.log ?? (() => {});
  const timings: Record<string, number> = {};
  const time = <T>(key: string, f: () => T): T => {
    const t0 = performance.now();
    const r = f();
    timings[key] = Math.round(performance.now() - t0);
    return r;
  };
  const name = basename(sourceName).replace(/\.[^.]+$/, "") || "model";
  const files: string[] = [];
  const write = (file: string, data: Buffer | string) => {
    writeFileSync(join(outDir, file), data);
    files.push(file);
  };
  mkdirSync(outDir, { recursive: true });

  // Evaluate once at rest to learn the poses, then again with the pose to show (if any); imports are cached across both.
  const resolver = importResolver(sourceName, log);
  const resolveImage = imageResolver(sourceName);
  const program = parse(source);
  const modules = moduleResolver(sourceName);
  const skipAsserts = opts.asserts === false;
  const rest = time("evaluate", () => evaluate(program, { resolveImport: resolver, resolveModule: modules, resolveImage, moduleFrom: sourceName, skipAsserts }));
  const shownPose = opts.pose ?? (typeof rest.settings.pose === "string" ? rest.settings.pose : undefined);
  const shownJoints = shownPose ? rest.poses.find((p) => p.name === shownPose)?.joints : undefined;
  const evaluation = shownJoints ? evaluate(program, { resolveImport: resolver, resolveModule: modules, resolveImage, moduleFrom: sourceName, jointPoses: shownJoints, poseName: shownPose, skipAsserts }) : rest;
  // The program evaluated in a pose, once per distinct pose: the pose sheet, the strips, a focused frame and the
  // asserts for a pose share it.
  const evalCache = new Map<string, Evaluation>();
  const evalAt = (joints: Record<string, JointPose>, poseName?: string): Evaluation => {
    const key = JSON.stringify(Object.entries(joints).sort(([a], [b]) => (a < b ? -1 : 1)));
    let ev = evalCache.get(key);
    if (!ev) { ev = evaluate(program, { resolveImport: resolver, resolveModule: modules, resolveImage, moduleFrom: sourceName, jointPoses: joints, poseName: poseName ?? rest.poses.find((p) => p.joints === joints)?.name, skipAsserts }); evalCache.set(key, ev); }
    return ev;
  };
  // Asserts are the program's promises about the model as built, so they are judged at rest (round 7: a "2.5 tall"
  // on a rig failed in its jump pose) unless one names its pose, which is tested in that pose's evaluation.
  const asserts = collectAsserts(rest, (pn) => { const p = rest.poses.find((x) => x.name === pn); return p ? evalAt(p.joints, pn) : undefined; });
  const warnings = [...evaluation.warnings, ...asserts.filter((a) => !a.passed).map(assertLine)];
  // Set by a quick pass that dropped thin steps: the pieces count is then not worth a warning.
  let quickDropped = 0;
  // Set when the shown pose has lifted the whole model off the floor: standing is then not judged.
  let offFloor = false;
  // A focused render's close-up mesh judged on its own (round 4: a focus sheet could not say whether the lug was sound).
  let closeUpNote: string | undefined;
  // The focused step's name when the sheet drew the rest of the model as a ghost, for the report's file notes.
  let ghosted: string | undefined;
  // Which steps callouts.png labelled, for the report.
  let calloutNote: string | undefined;
  let calloutData: { labelled: { name: string; cut?: boolean; visible: number }[]; unlabelled: string[] } | undefined;
  // Every cluster of open edges, for report.json: where, how many, which steps (round 6: most edges were unattributed).
  const edgeList: { at: Vec3; count: number; steps: string[] }[] = [];
  if (shownPose && !shownJoints && shownPose !== "rest") warnings.push(`pose ${shownPose}: no such pose (poses: ${rest.poses.map((p) => p.name).join(", ") || "none"}); showing rest`);
  const shapeAt: ShapeAt = (joints) => evalAt(joints).output;
  let grid = Math.max(8, Math.round(opts.grid ?? (evaluation.settings.grid as number | undefined) ?? opts.defaultGrid ?? 128));
  const size = Math.max(64, Math.round(opts.size ?? (evaluation.settings.size as number | undefined) ?? 512));
  const output = evaluation.output;
  // A quick pass on a model made of thin parts (a clock with a pane, hands, a rod and mouldings) drops half its
  // steps at the quick grid and shows nothing worth judging (measured: 20 of 41 steps). It steps the grid up, to
  // 128 at most, until fewer than a quarter of the geometry steps are thinner than the cell; still a few seconds.
  if (opts.quick && output && !isEmpty(output.bounds)) {
    const geometry = geometrySteps(evaluation).size || 1;
    const longest = Math.max(...boundsSize(output.bounds));
    for (const g of [grid, 96, 128]) {
      if (g < grid) continue;
      grid = g;
      if (thinWarnings(evaluation, longest / g, g).length <= geometry / 4) break;
    }
  }
  // Joints and poses: the sheet shows `set pose` (rest by default); exports are always at rest.
  const joints = output ? allJoints(output) : [];
  const jointNames = joints.map((j) => j.joint!.name);
  const poseViews: PoseView[] = evaluation.poses.map((p) => ({ name: p.name, joints: p.joints }));
  // Every animation sampled once, for the GLB and the Bedrock file alike: glTF samplers and Bedrock keyframes are
  // both linear, so an eased animation is sampled a few times per segment and a linear one at its keys.
  const clips: BedrockClip[] = evaluation.animations
    .filter((a) => a.poses.every((pn) => pn === "rest" || poseViews.some((v) => v.name === pn)))
    .map((a) => {
      const keys = a.poses.map((pn) => poseViews.find((v) => v.name === pn) ?? { name: "rest", joints: {} });
      const timing = { times: a.times, ease: a.ease, easeEnds: a.easeEnds };
      const keyTimes = a.times ?? keys.map((_, i) => (keys.length === 1 ? 0 : (i / (keys.length - 1)) * a.seconds));
      const times: number[] = [];
      for (let i = 0; i < keyTimes.length - 1; i++) {
        // A segment eased at either key is sampled eight times; a linear one keeps its two keys.
        const eased = (i === 0 ? a.easeEnds : a.ease) > 0 || (i === keyTimes.length - 2 ? a.easeEnds : a.ease) > 0;
        const sub = eased ? 8 : 1;
        for (let k = 0; k < sub; k++) times.push(keyTimes[i] + ((keyTimes[i + 1] - keyTimes[i]) * k) / sub);
      }
      times.push(keyTimes[keyTimes.length - 1]);
      const samples = times.map((t) => interpolatePose(keys, jointNames, a.seconds > 0 ? t / a.seconds : 0, timing));
      const axes: Record<string, Vec3 | undefined> = {};
      for (const j of joints) axes[j.joint!.name] = j.joint!.axis;
      return { name: a.name, seconds: a.seconds, loop: a.loop, times, samples, axes };
    });
  // `set camera hero` makes a declared shot the sheet's and the beauty render's view; the CLI still overrides.
  const shotName = opts.camera ?? (typeof evaluation.settings.camera === "string" ? evaluation.settings.camera : undefined);
  const shot = shotName ? evaluation.cameras.find((c) => c.name === shotName) : undefined;
  if (opts.camera && !shot) warnings.push(`--camera ${opts.camera}: no such camera${evaluation.cameras.length ? `; cameras: ${evaluation.cameras.map((c) => c.name).join(", ")}` : " (declare one with camera(name, ...))"}; every shot is rendered`);
  const azimuth = opts.azimuth ?? shot?.azimuth ?? (evaluation.settings.azimuth as number | undefined) ?? 35;
  const elevation = opts.elevation ?? shot?.elevation ?? (evaluation.settings.elevation as number | undefined) ?? 25;
  const environmentName = opts.environment ?? evaluation.settings.environment;
  const environment: Environment | undefined = ENVIRONMENTS.includes(environmentName as Environment) ? (environmentName as Environment) : undefined;
  if (opts.environment && !environment) warnings.push(`--environment ${opts.environment}: no such environment; the skies are ${ENVIRONMENTS.join(", ")}`);

  const crease = opts.crease ?? (typeof evaluation.settings.crease === "number" ? evaluation.settings.crease : undefined);
  let minecraftNote: string | undefined;
  const minecraftEntity = opts.minecraftEntity ?? evaluation.settings.minecraft_entity === 1;
  let robloxNote: string | undefined;
  // A Roblox accessory hangs on an attachment and never stands, so its balance is not worth a warning.
  const robloxAccessory = (opts.roblox ?? evaluation.settings.roblox === 1) && !!rest.output && Object.keys(anchorsOf(rest.output)).some((n) => /Attachment$/.test(n));
  let mesh: Mesh | undefined;
  let bounds: Bounds | undefined;
  let trueBounds: Bounds | undefined;
  let cellSize = 0;
  const lines: string[] = [`# ${name}`, "", `Source: \`${sourceName}\`  Output: \`${evaluation.outputName}\``, ""];

  if (!output) {
    warnings.push("The program made no 3D shape. Assign a shape to a name, or `show` one.");
  } else if (isEmpty(output.bounds)) {
    warnings.push(`'${evaluation.outputName}' is empty: nothing to render. A difference may have removed everything, or an intersection may not overlap.`);
  } else {
    bounds = output.bounds;
    // The box sets the cell size, and a rotated joint or a blend leaves it loose (measured: a posed excavator's box
    // was twice its surface, costing a third of the resolution), so find the surface's extent coarsely first.
    const extractBox = time("extent", () => tightBounds(output));
    let nets = time("mesh", () => surfaceNets(output, { resolution: grid, sharp: opts.sharp ?? evaluation.settings.sharp !== 0, crease, bounds: extractBox }));
    // The safety net: if the mesh reaches a face of a tightened box, something was cut off there (a part thinner than
    // the rays' spacing), so extract again over the whole bounds rather than ship a clipped model.
    if (extractBox !== output.bounds && triangleCount(nets.mesh) > 0) {
      const mb = meshBounds(nets.mesh);
      const near = nets.cellSize * 1.5;
      const clipped = [0, 1, 2].some((k) => (extractBox.min[k] > output.bounds.min[k] + near && mb.min[k] < extractBox.min[k] + near) || (extractBox.max[k] < output.bounds.max[k] - near && mb.max[k] > extractBox.max[k] - near));
      if (clipped) {
        log(`extent: the surface reaches the tightened box, so extracting over the full bounds instead`);
        nets = time("mesh", () => surfaceNets(output, { resolution: grid, sharp: opts.sharp ?? evaluation.settings.sharp !== 0, crease }));
      }
    }
    mesh = nets.mesh;
    cellSize = nets.cellSize;
    log(`mesh: ${triangleCount(mesh)} triangles, cell ${fmt(cellSize)} (${nets.dims.join("×")} cells, ${nets.samples} samples) in ${timings.mesh} ms`);
    if (nets.nanSamples > 0)
      warnings.push(`The distance field is NaN at ${nets.nanSamples} of ${nets.samples} samples, so parts of the model are missing: look for a scale of 0, a zero-size primitive, or a blend radius that is not a number.`);
    if (triangleCount(mesh) === 0)
      warnings.push(`'${evaluation.outputName}' has bounds ${dimsLabel(output.bounds)} but no surface was found inside them at grid ${grid}: it may be thinner than a cell (${fmt(cellSize)}), or empty.`);
    const s = boundsSize(bounds);
    const thin = Math.min(s[0], s[1], s[2]);
    // A quick pass judges thinness at the grid the full render will use, or every quick sheet would cry wolf.
    const fullGrid = opts.quick ? Math.max(8, Math.round((evaluation.settings.grid as number | undefined) ?? opts.defaultGrid ?? 128)) : grid;
    const fullCell = opts.quick ? (cellSize * grid) / fullGrid : cellSize;
    if (thin > 0 && thin < fullCell * 3)
      warnings.push(`The model is only ${fmt(thin)} units thin on one axis, about ${fmt(thin / fullCell)} cells; raise the grid (set grid 256) if it looks broken.`);
    warnings.push(...foldThinWarnings(thinWarnings(evaluation, fullCell, fullGrid)));
    warnings.push(...paintWarnings(evaluation));
    warnings.push(...cutWarnings(evaluation, fullCell));
    warnings.push(...glassWarnings(evaluation));
    if (opts.quick) {
      // The quick cell drops what the full grid keeps; say so on the sheet rather than let a missing plank look like a bug.
      const dropped = [...new Set(thinWarnings(evaluation, cellSize, grid).map((w) => w.match(/^'([^']+)'/)?.[1] ?? "?"))];
      // An import sampled finer than this pass's cell loses its thin parts here too (round 6: a quick sheet called an
      // imported playground twenty pieces).
      for (const st of evaluation.steps) if (isShape3(st.value) && st.value.sampledAt !== undefined && st.value.sampledAt < cellSize && !dropped.includes(st.name)) dropped.push(st.name);
      if (dropped.length) {
        quickDropped = dropped.length;
        warnings.push(`quick pass: ${dropped.length} step${dropped.length === 1 ? " is" : "s are"} thinner than this pass's ${fmt(cellSize)} cell and may be missing or broken on this sheet (${dropped.slice(0, 6).join(", ")}${dropped.length > 6 ? ", ..." : ""}), so the pieces count and the footprint are not judged here; the full render at grid ${fullGrid} has cell ${fmt(fullCell)}.`);
      }
    }
    // The true extent comes from the mesh: bounds are boxes, and a difference keeps the left side's box
    // however much was cut away, so a note based on bounds once told a scene on the floor to ground() itself.
    const extent = triangleCount(mesh) > 0 ? meshBounds(mesh) : bounds;
    if (extent.min[1] < -cellSize)
      lines.push(`Note: the lowest point of the surface is at y = ${fmt(extent.min[1])}; pipe the model through ground() to rest it on y = 0.`, "");
    else if (extent.min[1] > cellSize * 2)
      lines.push(`Note: the surface floats: its lowest point is at y = ${fmt(extent.min[1])}. ground() rests it on y = 0 (by bounds, which may be looser than the surface).`, "");
    trueBounds = extent;
  }

  if (mesh && bounds && output) {
    const views = opts.views ?? ["persp", "front", "right", "top"];
    // Views frame the surface's true extent, or the focused step's bounds.
    const focusName = opts.focus ?? (typeof evaluation.settings.focus === "string" ? evaluation.settings.focus : undefined);
    let focusStep = false;
    let frame = trueBounds ?? bounds;
    // The sheet's title names the pose it shows (round 8: two focus renders of a wheel read alike).
    let shownName = shownJoints ? `${evaluation.outputName} in pose ${shownPose}` : evaluation.outputName;
    // The focused step as it sits in the output (through the joints and moves above it), for the close-up's split
    // into the part itself and the ghost of everything else the frame holds.
    let focusShape: Shape3 | undefined;
    // A step or object to frame, as `--focus` and a camera's focus= do: its surface where the output puts it, grown
    // a little; `name_3` is one copy of a placed set, rebuilt from its base and placement (round 6: focusing on a
    // placed group framed the whole span between its copies).
    const resolveFocus = (name: string): { frame: Bounds; shape: Shape3 } | undefined => {
      let st = evaluation.steps.find((x) => x.name === name && isShape3(x.value));
      let obj = evaluation.objects.find((o) => o.name === name);
      let fs = st ? (st.value as Shape3) : obj?.shape;
      const copy = /^(.+)_(\d+)$/.exec(name);
      if (!fs && copy) {
        const setStep = evaluation.steps.find((x) => x.name === copy[1] && isShape3(x.value) && (x.value as Shape3).instanced);
        const setObj = evaluation.objects.find((o) => o.name === copy[1] && o.shape.instanced);
        const set = setStep ? (setStep.value as Shape3) : setObj?.shape;
        const pl = set?.instanced?.placements[Number(copy[2]) - 1];
        if (set && pl) {
          let sh = set.instanced!.base;
          if (pl.scale !== 1) sh = scaleShape(sh, pl.scale, pl.scale, pl.scale);
          if (pl.yaw !== 0) sh = rotateShape(sh, 0, pl.yaw, 0);
          fs = move(sh, pl.x, pl.y, pl.z);
          st = setStep;
          obj = setObj;
        }
      }
      if (!fs || isEmpty(fs.bounds)) return undefined;
      // The step's surface, not its box: a joint's box is the box of a turned box (measured: focus on a boom framed the
      // whole machine); carried through the joints and transforms above it, so a bucket inside a turned joint is
      // framed where the pose put it (measured: --focus in a pose framed the rest position).
      const own = tightBounds(fs);
      const fb = (output && st ? placedBounds(output, fs, own) : undefined) ?? own;
      const grow = Math.max(...boundsSize(fb)) * 0.08;
      return { frame: { min: [fb.min[0] - grow, fb.min[1] - grow, fb.min[2] - grow], max: [fb.max[0] + grow, fb.max[1] + grow, fb.max[2] + grow] }, shape: (output && st ? placedShape(output, fs) : undefined) ?? fs };
    };
    if (focusName) {
      const r = resolveFocus(focusName);
      if (r) { focusStep = true; frame = r.frame; focusShape = r.shape; shownName = `${shownName} → ${focusName}`; }
      else warnings.push(`focus ${focusName}: no such step or object; framing the whole model`);
    }
    // A focused sheet is a close-up: the model clipped to the frame and re-extracted at the frame's own cell, so a
    // lantern in a market is drawn with a lantern's detail rather than the market's (measured: a blob of six cells).
    let viewMesh = mesh, viewCell = cellSize;
    // On a focus sheet, the rest of the model inside the frame, drawn faint (round 7: the drone's body, clipped to
    // the gimbal's frame, was read as an unknown plate); its cell, for the ghost's depth margin.
    let viewGhost: Mesh | undefined, ghostCell = 0;
    if (focusName && frame !== (trueBounds ?? bounds)) {
      const sharp = opts.sharp ?? evaluation.settings.sharp !== 0;
      const clip = clipTo(output, frame);
      const close = time("focus", () => surfaceNets(clip, { resolution: grid, sharp, crease, bounds: frame }));
      if (triangleCount(close.mesh) > 0) {
        viewMesh = close.mesh; viewCell = close.cellSize;
        if (focusShape) {
          // The part on its own at the frame's cell, and everything else at twice it: a ghost is faint and is most
          // of the model, so it need not be sharp.
          const split = focusSplit(output, focusShape, frame, close.cellSize * GHOST_CELL);
          const part = time("focus:part", () => surfaceNets(split.focus, { resolution: grid, sharp, crease, bounds: frame }));
          if (triangleCount(part.mesh) > 0) {
            viewMesh = part.mesh;
            const ghost = time("focus:ghost", () => surfaceNets(split.ghost, { resolution: Math.max(8, Math.round(grid / GHOST_CELL)), sharp, crease, bounds: frame }));
            if (triangleCount(ghost.mesh) > 0) { viewGhost = ghost.mesh; ghostCell = ghost.cellSize; ghosted = focusName; }
          }
        }
        // The close-up is meshed at its own, finer cell, so its edges are a second reading of the same surface: the
        // clip faces are open by construction, so only edges away from the frame's faces count.
        const inside = (p: [number, number, number]) => [0, 1, 2].every((k) => p[k] > frame.min[k] + close.cellSize * 1.5 && p[k] < frame.max[k] - close.cellSize * 1.5);
        const w = watertightReport(close.mesh);
        const clusters = (w.clusters ?? []).filter((cl) => inside(cl.at));
        closeUpNote = clusters.length
          ? `not watertight at cell ${fmt(close.cellSize)}: ${clusters.map((cl) => `${cl.count} edges at (${cl.at.map(fmt).join(", ")})${stepsNear(evaluation, cl.at, close.cellSize * 2, 2).length ? ` in ${stepsNear(evaluation, cl.at, close.cellSize * 2, 2).join(", ")}` : ""}`).join("; ")} (edges on the frame's own faces are not counted)`
          : `yes at cell ${fmt(close.cellSize)} (the clip faces of the frame are not counted)`;
      }
    }
    const info = { name: shownName, bounds: frame, triangles: triangleCount(viewMesh), cellSize: viewCell, warnings: warnings.length, azimuth, elevation };
    time("sheet", () => write("sheet.png", renderSheet(viewMesh, info, size, viewGhost, ghostCell).toPng()));
    // The perspective view with the largest visible steps named, a leader line each: what maps a picture back to
    // the program (roadmap 9: "the thing at the top left is lantern_ring" as a fact). Not on a quick pass.
    if (!opts.quick && opts.callouts !== false) {
      // Every part and cutter but the output (a union a later union flattened is still a name the program reads);
      // a region only an assert or a decal reads is not geometry and gets no label (round 9: eye regions labelled).
      const named = evaluation.steps.filter((s) => isShape3(s.value) && evaluation.used.has(s.name) && !evaluation.displaced.has(s.name) && s.value !== output && !isEmpty((s.value as Shape3).bounds)).map((s) => ({ name: s.name, shape: s.value as Shape3, cut: evaluation.roles.get(s.name) === "cut", derived: s.cuts === true }));
      if (named.length) {
        const co = time("callouts", () => renderCallouts(viewMesh, named, info, size, viewCell, 20, azimuth, elevation, output));
        write("callouts.png", co.canvas.toPng());
        const label = (l: { name: string; cut?: boolean }) => (l.cut ? `${l.name} (cut)` : l.name);
        calloutNote = co.labelled.length ? `${co.labelled.map(label).join(", ")}${co.unlabelled.length ? ` (in view but smaller, not labelled: ${co.unlabelled.map(label).join(", ")})` : ""}` : "no named step has a visible surface from this view";
        calloutData = { labelled: co.labelled.map((l) => ({ name: l.name, cut: l.cut || undefined, visible: l.visible })), unlabelled: co.unlabelled.map(label) };
      }
    }
    for (const v of views) time(`view:${v}`, () => write(`${v}.png`, renderView(viewMesh, info, v, size, { azimuth, elevation, ghost: viewGhost, ghostMargin: ghostCell }).toPng()));
    if (opts.slices !== false) {
      const at: Partial<Record<"x" | "y" | "z", number>> = {};
      for (const axis of ["x", "y", "z"] as const) {
        const v = evaluation.settings[`slice_${axis}`];
        if (typeof v === "number") at[axis] = v;
      }
      // A scene's default cut goes through its first object, which is the one to list first; a focus wins over that.
      const first = evaluation.objects.length > 1 && !focusName ? evaluation.objects[0].shape.bounds : undefined;
      const sliceInfo = first && !isEmpty(first) ? { ...info, bounds: first, name: `${info.name} → ${evaluation.objects[0].name}` } : info;
      // A focus sheet's slices cut the part, with the cut through the rest of the model faint around it.
      time("slices", () => write("slices.png", renderSlices(viewGhost && focusShape ? focusShape : output, sliceInfo, Math.round(size * 0.75), at, viewGhost && focusShape ? output : undefined).toPng()));
    }
    if (opts.turntable !== false) time("turntable", () => write("turntable.png", renderTurntable(mesh!, info, Math.round(size / 2)).toPng()));
    const textureSize = Math.round(opts.texture ?? (evaluation.settings.texture as number | undefined) ?? 1024);
    if (opts.obj !== false || opts.glb !== false) {
      // Exports come from the node tree at rest: an object per scene entry, a node per joint and per placement.
      const stepNames = new Map<Shape3, string>();
      for (const st of rest.steps) if (isShape3(st.value) && !stepNames.has(st.value)) stepNames.set(st.value, st.name);
      const hierarchy = time("hierarchy", () => buildHierarchy(rest.objects, { cellSize, sharp: opts.sharp ?? evaluation.settings.sharp !== 0, crease, texture: textureSize > 0 ? Math.max(64, textureSize) : 0, names: stepNames }));
      warnings.push(...hierarchy.notes);
      const nodes = flatten(hierarchy).length;
      log(`exports: ${hierarchy.meshes.length} mesh${hierarchy.meshes.length === 1 ? "" : "es"} in ${nodes} node${nodes === 1 ? "" : "s"}, ${hierarchy.triangles} triangles${hierarchy.atlas ? `, atlas ${textureSize}px with ${hierarchy.atlasCharts} charts` : ""}, in ${timings.hierarchy} ms`);
      if (hierarchy.atlas) write("model.png", hierarchy.atlas.toPng());
      const glbAnimations: GlbAnimation[] = clips.map((c) => {
        const rotations: Record<string, [number, number, number, number][]> = {};
        const moves: Record<string, Vec3[]> = {};
        const scales: Record<string, Vec3[]> = {};
        for (const j of joints) {
          const jn = j.joint!.name;
          const axis = j.joint!.axis;
          // Only the joints a clip turns, moves or scales get channels (round 7: a lid's identity keys in the crank's clip).
          if (c.samples.some((s) => s[jn]?.angles.some((v) => v !== 0))) rotations[jn] = c.samples.map((s) => { const an = s[jn]?.angles ?? [0, 0, 0]; return axis ? axisAngleToQuat(axis, an[0]) : eulerToQuat(an[0], an[1], an[2]); });
          // Translation and scale channels only where a key moves or scales the joint: most joints only turn.
          if (c.samples.some((s) => s[jn]?.move.some((v) => v !== 0))) moves[jn] = c.samples.map((s) => [...(s[jn]?.move ?? [0, 0, 0])] as Vec3);
          if (c.samples.some((s) => s[jn]?.scale.some((v) => v !== 1))) scales[jn] = c.samples.map((s) => [...(s[jn]?.scale ?? [1, 1, 1])] as Vec3);
        }
        return { name: c.name, times: c.times, rotations, moves, scales };
      });
      if (opts.obj !== false) {
        const { obj, mtl } = toObjScene(hierarchy, name, "model.mtl", hierarchy.atlas ? "model.png" : undefined);
        write("model.obj", obj);
        write("model.mtl", mtl);
        // The STL is the model as shown, posed if a pose is set: what a printer would print.
        write("model.stl", toStl(mesh!, name));
      }
      if (opts.glb !== false) {
        const glb = toGlbScene(hierarchy, name, glbAnimations);
        write("model.glb", glb);
        if (opts.viewer !== false) write("viewer.html", viewerHtml(glb, evaluation.outputName, bounds, hierarchy.triangles, glbAnimations.map((a) => a.name)));
      }
      // Roblox: the meshes decimated to the budget (an accessory's 4000 when an Attachment anchor is present, a
      // MeshPart's 10000 otherwise), their own atlas, under a root turned to face -Z with the attachments as nodes.
      if (opts.roblox ?? evaluation.settings.roblox === 1) {
        const anchors = rest.output ? anchorsOf(rest.output) : {};
        const accessory = Object.keys(anchors).some((n) => /Attachment$/.test(n));
        const budget = accessory ? ACCESSORY_TRIANGLES : MESHPART_TRIANGLES;
        const rbHierarchy = time("roblox", () => buildHierarchy(rest.objects, { cellSize, sharp: opts.sharp ?? evaluation.settings.sharp !== 0, crease, texture: textureSize > 0 ? Math.max(64, textureSize) : 0, names: stepNames, maxTriangles: budget }));
        const rb = toRoblox(rbHierarchy, name, { anchors, size: bounds ? boundsSize(bounds) : [0, 0, 0], animations: glbAnimations, before: hierarchy.triangles });
        write("model.roblox.glb", rb.glb);
        warnings.push(...rb.warnings);
        robloxNote = rb.note;
        log(`roblox: ${rb.note}, in ${timings.roblox} ms`);
      }
    }
    // Minecraft Bedrock geometry: the field voxelised at so many pixels per block and merged into cuboids, with a
    // texture of the materials. Written at rest, an object per bone, joints left to the game's own animation.
    const minecraftPx = opts.minecraft ?? (typeof evaluation.settings.minecraft === "number" ? evaluation.settings.minecraft : 0);
    if (minecraftPx > 0) {
      const entity = minecraftEntity;
      const bedrock = time("minecraft", () => toBedrock(rest.objects, name, { pixelsPerUnit: minecraftPx, entity }));
      write("model.geo.json", JSON.stringify(bedrock.geometry, null, 2) + "\n");
      write("model.geo.png", bedrock.texture.toPng());
      warnings.push(...bedrock.warnings);
      // A material the mesh shows but no face texel took is a decal smaller than a texel or off the lattice (round 8:
      // two 0.035 eyes painted the sheet and reached no texel, found only by reading the PNG texel by texel).
      if (mesh) for (const m of mesh.materials) if (!(bedrock.painted[m.name] > 0)) warnings.push(`minecraft: material "${m.name}" paints no texel of model.geo.png; a decal region must cover a texel centre (about a pixel across, on the ${bedrock.pixelsPerUnit}-pixel lattice), or the part it is on is thinner than a voxel`);
      // The animations as Bedrock keyframes on the joint bones, when the model has both.
      if (clips.length && bedrock.joints.length) write("model.animation.json", JSON.stringify(toBedrockAnimations(clips, name, bedrock.joints, { entity }), null, 2) + "\n");
      // A voxel is the geometry's cell: a part thinner than one is lost there whatever the render's grid. A whole
      // voxel always holds a sample centre, so the threshold is one voxel, not the mesher's 1.2 cells: a one-pixel
      // plate is the ordinary member of a block model.
      warnings.push(...minecraftThinWarnings(rest, minecraftPx, grid));
      const animNote = clips.length && bedrock.joints.length ? `; animation${clips.length === 1 ? "" : "s"} ${clips.map((c) => `animation.${name.replace(/[^A-Za-z0-9_]/g, "_")}.${c.name.replace(/[^A-Za-z0-9_]/g, "_")}`).join(", ")} in model.animation.json` : "";
      minecraftNote = `${bedrock.cubes} cube${bedrock.cubes === 1 ? "" : "s"} from ${bedrock.voxels} voxels at ${bedrock.pixelsPerUnit} pixels per block, texture ${bedrock.texture.width} × ${bedrock.texture.height}, bone${bedrock.bones.length === 1 ? "" : "s"} ${bedrock.bones.join(", ") || "none"}${bedrock.joints.length ? ` (${bedrock.joints.length} joint${bedrock.joints.length === 1 ? "" : "s"})` : ""}; identifier geometry.${name.replace(/[^A-Za-z0-9_]/g, "_")}${entity ? ", an entity facing north" : ", a block facing south"}${animNote}`;
      log(`minecraft: ${minecraftNote}, in ${timings.minecraft} ms`);
    }
    if (joints.length > 0 && opts.poses !== false) {
      // Pose thumbnails are meshed at 1.5 cells: measured, 2 cells at a 0.35 sheet was too coarse to tell a
      // bent elbow from a broken one; a full-size check of one pose is `set pose name` or `--pose name`.
      let poseCell = cellSize * 1.5;
      let poseShapeAt = shapeAt;
      // With a focus, the sheet and the strips are close-ups of that step where each pose puts it, at the frame's
      // own cell, so a gimbal's pan or a crank's turn is readable (round 7: a 10 px gimbal on a whole-drone strip);
      // the rest of the model in the frame is a ghost behind it.
      let poseGhostAt: ShapeAt | undefined;
      if (focusName && focusStep) {
        const focusAt = (ev: Evaluation): { fs: Shape3; frame: Bounds } | undefined => {
          const st = ev.steps.find((x) => x.name === focusName && isShape3(x.value));
          const fs = st ? (st.value as Shape3) : ev.objects.find((o) => o.name === focusName)?.shape;
          if (!fs || isEmpty(fs.bounds) || !ev.output) return undefined;
          const own = tightBounds(fs);
          const fb = placedBounds(ev.output, fs, own) ?? own;
          const grow = Math.max(...boundsSize(fb)) * 0.08;
          return { fs, frame: { min: [fb.min[0] - grow, fb.min[1] - grow, fb.min[2] - grow], max: [fb.max[0] + grow, fb.max[1] + grow, fb.max[2] + grow] } };
        };
        const restFocus = focusAt(evaluation);
        if (restFocus) poseCell = (Math.max(...boundsSize(restFocus.frame)) / grid) * 1.5;
        const splitAt = new Map<Evaluation, { focus: Shape3; ghost: Shape3 } | undefined>();
        const split = (ev: Evaluation) => {
          if (!splitAt.has(ev)) {
            const f = focusAt(ev);
            splitAt.set(ev, f && ev.output ? focusSplit(ev.output, placedShape(ev.output, f.fs) ?? f.fs, f.frame, poseCell * GHOST_CELL) : undefined);
          }
          return splitAt.get(ev);
        };
        poseShapeAt = (j) => { const ev = evalAt(j); return split(ev)?.focus ?? ev.output; };
        poseGhostAt = (j) => split(evalAt(j))?.ghost;
      }
      const cache: PoseCache = new Map();
      time("poses", () => write("poses.png", renderPoses(poseShapeAt, jointNames, poseViews, Math.round(size * 0.5), poseCell, azimuth, elevation, cache, !!(focusName && focusStep), poseGhostAt).toPng()));
      // A quick pass is for the geometry: the strips wait for the full render (round 7: 12 of a quick pass's 15 s).
      if (opts.quick) log(`quick pass: ${evaluation.animations.length} animation strip${evaluation.animations.length === 1 ? "" : "s"} skipped; the full render draws them`);
      else if (opts.animations === false) log(`${evaluation.animations.length} animation strip${evaluation.animations.length === 1 ? "" : "s"} skipped (--no-anims)`);
      else for (const a of evaluation.animations.filter((a) => !Array.isArray(opts.animations) || opts.animations.includes(a.name))) {
        const keys = a.poses.map((pn) => poseViews.find((v) => v.name === pn) ?? { name: "rest", joints: {} });
        time(`anim:${a.name}`, () => write(`anim_${a.name}.png`, renderAnimation(poseShapeAt, jointNames, a.name, keys, a.seconds, Math.round(size * 0.35), poseCell, 8, azimuth, elevation, { times: a.times, ease: a.ease, easeEnds: a.easeEnds, loop: a.loop }, cache, poseGhostAt).toPng()));
      }
    }
    if (opts.beauty || evaluation.settings.beauty === 1) {
      const bsize = Math.max(64, Math.round(opts.beautySize ?? size));
      const lightSize = typeof evaluation.settings.light_size === "number" ? evaluation.settings.light_size : undefined;
      const dof = typeof evaluation.settings.dof === "number" ? evaluation.settings.dof : undefined;
      const lightAzimuth = typeof evaluation.settings.light_azimuth === "number" ? evaluation.settings.light_azimuth : undefined;
      const lightElevation = typeof evaluation.settings.light_elevation === "number" ? evaluation.settings.light_elevation : undefined;
      const ambient = typeof evaluation.settings.ambient === "number" ? evaluation.settings.ambient : undefined;
      const zoom = opts.zoom ?? shot?.zoom ?? (typeof evaluation.settings.zoom === "number" ? evaluation.settings.zoom : undefined);
      // The program's lights, when it declares any; else the one key light the settings describe.
      const lights: BeautyLight[] | undefined = evaluation.lights.length ? evaluation.lights.map((l) => ({ name: l.name, azimuth: l.azimuth, elevation: l.elevation, size: l.size, color: l.color, power: l.power, position: l.position, range: l.range })) : undefined;
      // Framed like the views: on the focused step when there is one.
      // Framed on the surface the mesh found, not the box a blend or a displace padded (measured: a tree's box was
      // 10% wider than its surface on every side, and the zoom could not reach past it).
      const beautyFrame = focusName ? frame : triangleCount(mesh!) > 0 ? meshBounds(mesh!) : frame;
      // The camera fits the mesh's points inside the frame, so a focus, or a camera's focus=, frames that part
      // (measured: a focused beauty render fitted every point and framed the whole mug).
      // A focus shot frames its part but marches the whole model, so a hole under a counterbore still reads as
      // through and the floor's shadow is the model's (round 9: a focused counterbore looked blind).
      const modelBounds = triangleCount(mesh!) > 0 ? meshBounds(mesh!) : frame;
      const shoot = (file: string, b: Bounds, focused: boolean, az: number, el: number, zm: number | undefined, df: number | undefined, label: string) =>
        write(file, renderBeauty(output, mesh!, b, { size: bsize, cellSize, azimuth: az, elevation: el, lightSize, dof: df, lightAzimuth, lightElevation, ambient, zoom: zm, lights, environment, fitPoints: focused ? pointsWithin(mesh!, b) : undefined, reachBounds: focused ? modelBounds : undefined, label }).toPng());
      time("beauty", () => shoot("beauty.png", beautyFrame, !!focusName, azimuth, elevation, zoom, shot?.dof ?? dof, `${shownName}  ${dimsLabel(beautyFrame)}`));
      log(`beauty render ${bsize}px in ${timings.beauty} ms`);
      // Every declared camera is a shot of its own, framed on its focus= when it has one.
      // Each declared light alone, in a strip, so what a rim light adds can be seen rather than guessed from two
      // near-identical pictures (round 9: two agents could not tell whether a light did anything).
      if (lights && lights.length >= 2) {
        const frame = Math.max(96, Math.round(bsize * 0.4));
        const gutter = 6, bar = 26;
        const strip = new Canvas((frame + gutter) * (lights.length + 1) + gutter, bar + frame + gutter * 2, INK.page);
        strip.fill(0, 0, strip.width, bar, INK.bar);
        drawText(strip, 10, 7, `LIGHTS   each alone, then all ${lights.length}`, INK.barText, 2);
        const one = (ls: BeautyLight[] | undefined, label: string) =>
          renderBeauty(output, mesh!, beautyFrame, { size: frame, cellSize, azimuth, elevation, lightSize, lightAzimuth, lightElevation, ambient, zoom, lights: ls, environment, fitPoints: focusName ? pointsWithin(mesh!, beautyFrame) : undefined, reachBounds: focusName ? modelBounds : undefined, label });
        time("lights", () => {
          lights.forEach((l, i) => {
            const desc = l.position ? `at ${l.position.map(fmt).join(", ")}` : `az ${fmt(l.azimuth)} el ${fmt(l.elevation)}`;
            strip.blit(one([l], `${l.name}  ${desc}${l.power !== 1 ? `  power ${fmt(l.power)}` : ""}`), gutter + i * (frame + gutter), bar + gutter);
          });
          strip.blit(one(lights, "all"), gutter + lights.length * (frame + gutter), bar + gutter);
        });
        write("lights.png", strip.toPng());
      }
      for (const c of evaluation.cameras) {
        if (shot && opts.camera && c.name !== shot.name) continue;
        const r = c.focus ? resolveFocus(c.focus) : undefined;
        const b = r ? r.frame : beautyFrame;
        time(`beauty:${c.name}`, () => shoot(`beauty_${c.name}.png`, b, !!(r || focusName), c.azimuth ?? azimuth, c.elevation ?? elevation, c.zoom ?? zoom, c.dof ?? dof, `${shownName}, camera ${c.name}${r ? ` → ${c.focus}` : ""}  ${dimsLabel(b)}`));
      }
    }
  }

  const shapeSteps = evaluation.steps.filter((s) => isShape3(s.value));
  if (opts.steps !== false && shapeSteps.length > 0) {
    const views: StepView[] = time("steps:mesh", () =>
      meshSteps(
        shapeSteps.map((s) => ({ name: s.name, shape: s.value as Shape3, used: evaluation.used.has(s.name), role: evaluation.roles.get(s.name), line: s.line })),
        cellSize,
        96,
        output && mesh ? { shape: output, mesh } : undefined,
      ),
    );
    for (const st of views)
      if (st.used && st.mesh && !st.coarse && triangleCount(st.mesh) === 0)
        warnings.push(`'${st.name}' (line ${st.line}) has bounds ${dimsLabel(st.shape.bounds)} but no surface: it is missing from the model. A zero blend radius or scale, or a part thinner than a cell?`);
    time("steps", () => write("steps.png", renderSteps(views, Math.round(size * 0.35)).toPng()));
  }

  // Physical checks: mass, centre of mass, stability, pieces.
  let physics: Physics | undefined;
  if (mesh && bounds && triangleCount(mesh) > 0) {
    const ph = time("physics", () => analyse(mesh!, cellSize));
    physics = ph;
    const main = ph.pieces[0];
    // A cavity (an inward shell, a lidded cup's inside) is not a piece; a speck is tiny in volume and in extent, so a
    // small real part (a star finial 0.6 wide) is a loose piece, not a sliver (measured: the two were swapped).
    const cavities = ph.pieces.filter((pc) => pc.cavity && !isSpeck(pc, ph, cellSize));
    const specks = ph.pieces.filter((pc) => !pc.cavity && isSpeck(pc, ph, cellSize));
    // Sub-cell cavities are grazing contacts, the watertight row's business, not voids; they count for nothing here.
    const parts = ph.pieces.length - specks.length - cavities.length - ph.pieces.filter((pc) => pc.cavity && isSpeck(pc, ph, cellSize)).length;
    if (parts > 1 && !evaluation.objects.some((o) => o.shape.instanced) && evaluation.objects.length === 1) {
      // Name the steps whose surface is near each loose piece's centre, smallest first (by the field, not the box:
      // measured, a blended step's box named the wrong part). A piece's centre can be inside a hollow, so the
      // tolerance is the piece's own size.
      const stepsAt = (pc: Piece) => stepsNear(evaluation, pc.centre, Math.cbrt(Math.abs(pc.volume)) + cellSize * 2);
      const loose = physics.pieces.filter((pc) => !specks.includes(pc) && !pc.cavity && pc !== main).slice(0, 4);
      const where = loose.map((pc) => `volume ${fmt(Math.abs(pc.volume))} at (${pc.centre.map(fmt).join(", ")})${stepsAt(pc).length ? ` in ${stepsAt(pc).join(", ")}` : ""}`).join("; ");
      // A quick pass that dropped thin steps has probably dropped the joins too (round 4: every quick sheet of a
      // railed excavator said "4 pieces"); the note above says so instead.
      if (!quickDropped) warnings.push(`The model is ${parts} separate pieces: the largest is ${fmt(Math.abs(main.volume))}, the loose ${loose.length === 1 ? "piece is" : "pieces are"} ${where}${parts - 1 > loose.length ? ", ..." : ""}. A piece not touching the rest floats free: overlap parts slightly, or use scene for separate objects.`);
    }
    if (specks.length && !quickDropped) {
      const s0 = specks[0];
      const at = stepsNear(evaluation, s0.centre, s0.size + cellSize * 2);
      warnings.push(`${specks.length} tiny speck${specks.length === 1 ? "" : "s"} of mesh (under 0.1% of the volume and a few cells across): a sliver left by a cut or a part thinner than a cell. The largest is at (${s0.centre.map(fmt).join(", ")})${at.length ? ` in ${at.join(", ")}` : ""}.`);
    }
    // A quick pass that dropped thin steps may have dropped the feet (measured: a bicycle's stand), so it does not
    // judge standing either.
    offFloor = !!shownPose && physics.floor > cellSize * 2;
    if (quickDropped) { /* the quick note says the footprint is not judged */ }
    else if (offFloor) { /* the pose lifts the model off the floor: nothing to stand on (round 7: a drone at take-off) */ }
    else if (!physics.stable && physics.footprint.length >= 3 && !robloxAccessory)
      warnings.push(`The centre of mass (${physics.centre.map(fmt).join(", ")}) is ${fmt(-physics.stabilityMargin)} units outside the base's footprint: the model would tip over. Widen the base or move weight over it.`);
    else if (physics.stable && physics.stabilityMargin < cellSize * 3 && !robloxAccessory)
      warnings.push(`The centre of mass is only ${fmt(physics.stabilityMargin)} units inside the base's footprint: the model would balance, barely.`);
  }

  // The report.
  if (mesh && bounds) {
    const s = boundsSize(bounds);
    lines.push(
      "## Model",
      "",
      "| | |",
      "| --- | --- |",
      `| Size (w × h × d) | ${fmt(s[0])} × ${fmt(s[1])} × ${fmt(s[2])} units |`,
      `| Bounds | x ${fmt(bounds.min[0])}..${fmt(bounds.max[0])}, y ${fmt(bounds.min[1])}..${fmt(bounds.max[1])}, z ${fmt(bounds.min[2])}..${fmt(bounds.max[2])} (a box; loose after a cut, a rotation or a twist) |`,
      ...(trueBounds ? [`| Surface extent | x ${fmt(trueBounds.min[0])}..${fmt(trueBounds.max[0])}, y ${fmt(trueBounds.min[1])}..${fmt(trueBounds.max[1])}, z ${fmt(trueBounds.min[2])}..${fmt(trueBounds.max[2])} (from the mesh) |`] : []),
      `| Triangles | ${triangleCount(mesh)} (${vertexCount(mesh)} vertices) |`,
      `| Volume | ${fmt(Math.abs(meshVolume(mesh)))} cubic units |`,
      `| Grid | ${grid} cells on the longest side, cell ${fmt(cellSize)} units |`,
      `| Watertight${shownPose ? ` (in pose ${shownPose}; the exports are at rest)` : ""} | ${(() => { const w = watertightReport(mesh); return watertightNote(w, evaluation, cellSize, edgeList, !!shownJoints) + (w.ok ? "" : nearlyThin(evaluation, cellSize)); })()} |`,
      ...(closeUpNote ? [`| Close-up watertight | ${closeUpNote} |`] : []),
      `| Materials | ${mesh.materials.map((m) => m.name).join(", ") || "none"} |`,
      ...(asserts.length ? [`| Asserts | ${assertsRow(asserts)}${asserts.some((a) => a.pose) ? " (at rest, or in the pose each names)" : shownPose ? " (judged at rest)" : ""} |`] : []),
      ...(robloxNote ? [`| Roblox | ${robloxNote} (model.roblox.glb: import with Studio's 3D Importer, then the Accessory Fitting Tool for an accessory) |`] : []),
      ...(minecraftNote ? [`| Minecraft | ${minecraftNote} (model.geo.json with model.geo.png; ${minecraftEntity ? "z is flipped: the entity's half turn and Bedrock's x mirror together" : "x is authored mirrored, as Bedrock draws it"}) |`] : []),
      "",
    );
    if (physics) {
      const density = opts.density ?? (typeof evaluation.settings.density === "number" ? evaluation.settings.density : 1);
      lines.push(
        "## Physics",
        "",
        "| | |",
        "| --- | --- |",
        `| Mass | ${fmt(Math.abs(physics.volume) * density)} at density ${fmt(density)} |`,
        `| Centre of mass | (${physics.centre.map(fmt).join(", ")}) |`,
        `| Base footprint${shownPose ? ` (in pose ${shownPose})` : ""} | ${offFloor ? `none: the pose lifts the model off the floor (lowest point y = ${fmt(physics.floor)})` : physics.footprint.length >= 3 ? `${physics.footprint.length}-sided hull of the points within ${fmt(cellSize * 1.5)} of y = ${fmt(physics.floor)}` : "none (fewer than three contact points)"} |`,
        `| Stands${shownPose ? ` (in pose ${shownPose})` : ""} | ${offFloor ? "not judged: off the floor in this pose" : physics.footprint.length < 3 ? "unknown" : physics.stable ? `yes, centre of mass ${fmt(physics.stabilityMargin)} inside the footprint` : `no, centre of mass ${fmt(-physics.stabilityMargin)} outside the footprint`} |`,
        `| Overhangs | ${(physics.overhang * 100).toFixed(physics.overhang < 0.095 ? 1 : 0)}% of the surface faces down more than 45° above the floor${physics.overhang > 0.005 ? " (a printer would need support there)" : ""} |`,
        `| Pieces | ${quickDropped ? `not judged on this quick pass (${quickDropped} thin step${quickDropped === 1 ? "" : "s"} dropped; the full render counts them)` : piecesRow(physics, evaluation, cellSize)} |`,
        `| Cavities | ${cavitiesRow(physics, cellSize)} |`,
        "",
      );
    }
  }
  if (evaluation.objects.length > 1 || joints.length > 0 || evaluation.poses.length > 0) {
    lines.push("## Assembly", "");
    if (evaluation.objects.length > 1) lines.push(`Objects: ${evaluation.objects.map((o) => `${o.name}${o.shape.instanced ? ` (${o.shape.instanced.placements.length} copies)` : ""}`).join(", ")}`, "");
    // A print-ready set is judged one object at a time: the scene's rows above are for the fused union, in which
    // thirty-two chess pieces resting on their board count as one piece (measured). Each object is meshed on its
    // own at the scene's cell (a placed set once, its base) and gets the same rows; a quick pass skips this.
    if (evaluation.objects.length > 1 && mesh && !opts.quick && cellSize > 0) {
      lines.push("Each object on its own, at the scene's cell:", "", "| Object | Watertight | Pieces | Stands | Overhangs |", "| --- | --- | --- | --- | --- |");
      for (const o of evaluation.objects) {
        const shape = o.shape.instanced ? o.shape.instanced.base : o.shape;
        if (isEmpty(shape.bounds)) { lines.push(`| ${o.name} | empty | | | |`); continue; }
        const own = time(`object:${o.name}`, () => surfaceNets(shape, { resolution: Math.max(8, Math.round(Math.max(...boundsSize(shape.bounds)) / cellSize)), sharp: opts.sharp ?? evaluation.settings.sharp !== 0, crease }));
        if (triangleCount(own.mesh) === 0) { lines.push(`| ${o.name} | no surface | | | |`); continue; }
        const w = watertightReport(own.mesh);
        const ph = analyse(own.mesh, own.cellSize);
        const solid = ph.pieces.filter((pc) => !pc.cavity && !isSpeck(pc, ph, own.cellSize)).length;
        const label = o.shape.instanced ? `${o.name} (each of ${o.shape.instanced.placements.length} copies)` : o.name;
        lines.push(`| ${label} | ${w.ok ? "yes" : `no: ${w.nonManifold + w.holes} edges`} | ${solid} | ${ph.footprint.length < 3 ? "unknown" : ph.stable ? `yes, ${fmt(ph.stabilityMargin)} inside` : `no, ${fmt(-ph.stabilityMargin)} outside`} | ${(ph.overhang * 100).toFixed(ph.overhang < 0.095 ? 1 : 0)}% |`);
      }
      lines.push("");
    }
    if (joints.length && output) lines.push("Joints, each under the joint it turns with:", "", "```", ...jointTreeLines(output, fmt), "```", "");
    if (evaluation.poses.length) lines.push(`Poses: ${evaluation.poses.map((p) => p.name).join(", ")}${shownPose ? ` (sheet shows "${shownPose}")` : ""}`, "");
    if (evaluation.animations.length) lines.push(`Animations: ${evaluation.animations.map((a) => `${a.name} (${a.poses.map((pn, i) => (a.times ? `${pn} ${fmt(a.times[i])}s` : pn)).join(" → ")}, ${fmt(a.seconds)}s, ${a.loop ? "loop" : "once"}${a.ease ? `, ease ${fmt(a.ease)}` : ""}${a.easeEnds !== a.ease ? `, ends ${fmt(a.easeEnds)}` : ""})`).join("; ")}`, "");
  }
  if (calloutNote) lines.push(`Callouts (callouts.png, the largest visible steps named): ${calloutNote}`, "");
  if (evaluation.images.length) lines.push(`Images: ${evaluation.images.map((i) => `${i.name} ${i.width} × ${i.height} (${i.projection === "box" ? i.size : `${i.projection}, ${i.size}`}; line ${i.line})`).join("; ")}`, "");
  for (const l of presentationLines(evaluation, shot?.name, environment, opts.azimuth !== undefined || opts.elevation !== undefined || opts.zoom !== undefined)) lines.push(l, "");
  lines.push("## Steps", "", "Sizes and spans are bounding boxes: exact for primitives and unions, loose after a cut (`a - b` keeps a's box), a rotation or a twist; `a & b` tightens to the overlap. In output: yes for a part, cut for a shape subtracted from one, region for a shape only an assert, a decal or a camera reads.", "", "| # | Name | Line | Size | x | y | z | In output |", "| --- | --- | --- | --- | --- | --- | --- | --- |");
  shapeSteps.forEach((st, i) => {
    const sh = st.value as Shape3;
    const b = sh.bounds;
    const span = (k: number) => (isEmpty(b) ? "" : `${fmt(b.min[k])}..${fmt(b.max[k])}`);
    lines.push(`| ${i + 1} | ${st.name} | ${st.line} | ${isEmpty(b) ? "empty" : dimsLabel(b)} | ${span(0)} | ${span(1)} | ${span(2)} | ${roleLabel(evaluation.roles.get(st.name))} |`);
  });
  lines.push("");
  if (warnings.length) {
    lines.push("## Warnings", "");
    for (const w of warnings) lines.push(`- ${w}`);
    lines.push("");
  }
  lines.push("## Files", "");
  const focusNote = ghosted ? `, a close-up on ${ghosted}: the rest of the model in the frame is drawn faint` : "";
  const cameraFiles: Record<string, string> = {};
  for (const c of evaluation.cameras) cameraFiles[`beauty_${c.name}.png`] = `the beauty render from camera ${c.name}${c.focus ? `, framed on ${c.focus}` : ""}`;
  const descriptions: Record<string, string> = {
    "sheet.png": `perspective, front, right and top views with grids${focusNote}`,
    "persp.png": "perspective view", "front.png": "front view (from +z)", "right.png": "right view (from +x)", "top.png": "top view (from +y)",
    "back.png": "back view", "left.png": "left view", "bottom.png": "bottom view",
    "slices.png": "cross-sections through the centre on each axis",
    "steps.png": "one thumbnail per named shape, in program order; red frames are not in the output",
    "callouts.png": "the perspective view with the largest visible steps named, a leader line from each label to its part",
    "turntable.png": "eight views around the model",
    "model.obj": "Wavefront mesh (with model.mtl and UVs)", "model.stl": "binary STL for a slicer, the model as shown", "model.mtl": "materials for the OBJ, mapped to model.png", "model.glb": "binary glTF with the texture atlas embedded",
    "model.png": "the texture atlas: the materials baked per chart",
    "model.roblox.glb": "the GLB for Roblox Studio's 3D Importer: a Handle node facing -Z with _Att attachment nodes from the anchors",
    "model.geo.json": "Minecraft Bedrock geometry: the model voxelised and merged into cuboids, a bone per object and per joint",
    "model.geo.png": "the Bedrock geometry's texture: one window per cube face, painted with the materials",
    "model.animation.json": "the animations as Bedrock keyframes on the joint bones",
    "poses.png": `every pose, rest first${focusNote}`,
    "viewer.html": "orbit the GLB in a browser (self-contained; loads three.js from a CDN)",
    "beauty.png": "the field ray-marched with soft shadows and ambient occlusion",
    "lights.png": "the beauty render under each declared light alone, then all of them, so each light's contribution can be seen",
    ...cameraFiles,
  };
  for (const f of files) lines.push(`- \`${f}\`: ${descriptions[f] ?? (f.startsWith("anim_") ? "frames through the animation" : "")}`);
  lines.push("", `Timings (ms): ${Object.entries(timings).map(([k, v]) => `${k} ${v}`).join(", ")}`, "");
  const report = lines.join("\n");
  write("report.md", report);
  write(
    "report.json",
    JSON.stringify(
      {
        name,
        output: evaluation.outputName,
        bounds,
        size: bounds ? boundsSize(bounds) : undefined,
        triangles: mesh ? triangleCount(mesh) : 0,
        cellSize,
        grid,
        materials: mesh?.materials.map((m) => m.name) ?? [],
        objects: evaluation.objects.map((o) => ({ name: o.name, copies: o.shape.instanced?.placements.length ?? 1 })),
        physics: physics ? { volume: Math.abs(physics.volume), centre: physics.centre, stable: physics.stable, stabilityMargin: physics.stabilityMargin, pieces: physics.pieces.length, overhang: physics.overhang } : undefined,
        watertight: edgeList.length ? { clusters: edgeList } : undefined,
        asserts: asserts.length ? asserts : undefined,
        joints: joints.map((j) => ({ name: j.joint!.name, pivot: j.joint!.pivot })),
        poses: evaluation.poses.map((p) => p.name),
        animations: evaluation.animations.map((a) => a.name),
        steps: shapeSteps.map((st) => ({
          name: st.name,
          line: st.line,
          bounds: isEmpty((st.value as Shape3).bounds) ? null : (st.value as Shape3).bounds,
          used: evaluation.used.has(st.name),
          role: evaluation.roles.get(st.name) ?? "unused",
        })),
        callouts: calloutData,
        warnings,
        files,
        timings,
      },
      null,
      2,
    ),
  );
  return { name, outDir, evaluation, mesh, bounds, files, warnings, report, timings, physics };
}

/**
 * Two programs side by side: each rendered quickly, their perspective and
 * front views paired, with the size of each in its own bar. For comparing
 * a change against the version before it.
 */
export function diff(a: { source: string; name: string }, b: { source: string; name: string }, outFile: string, opts: { size?: number; grid?: number } = {}): { warnings: string[] } {
  const size = opts.size ?? 320;
  const warnings: string[] = [];
  const side = (prog: { source: string; name: string }) => {
    const ev = check(prog.source, prog.name);
    if (!ev.output || isEmpty(ev.output.bounds)) return { canvases: [] as import("./render/canvas.js").Canvas[], label: `${prog.name}: nothing to show` };
    const nets = surfaceNets(ev.output, { resolution: opts.grid ?? 64 });
    const info = { name: ev.outputName, bounds: ev.output.bounds };
    warnings.push(...ev.warnings.map((w) => `${prog.name}: ${w}`));
    return { canvases: [renderView(nets.mesh, info, "persp", size), renderView(nets.mesh, info, "front", size)], label: `${prog.name}   ${dimsLabel(ev.output.bounds)}   ${triangleCount(nets.mesh)} tris` };
  };
  const left = side(a), right = side(b);
  const out = new Canvas(size * 2 + 12, size * 2 + 12 + 60, INK.page);
  out.fill(0, 0, out.width, 30, INK.bar);
  drawText(out, 10, 8, `A: ${left.label}`, INK.barText, 2);
  out.fill(0, 30, out.width, 30, INK.bar);
  drawText(out, 10, 38, `B: ${right.label}`, 0xf0d060, 2);
  left.canvases.forEach((c, i) => out.blit(c, 4, 64 + i * (size + 4)));
  right.canvases.forEach((c, i) => out.blit(c, size + 8, 64 + i * (size + 4)));
  writeFileSync(outFile, out.toPng());
  return { warnings };
}

/** The report's In output column for a step's role. */
export function roleLabel(role: StepRole | undefined): string {
  return role === "part" ? "yes" : role === "cut" ? "cut" : role === "region" ? "region" : "no";
}

/** The Lights, Cameras and Environment lines of the report, printed by `check` too. */
export function presentationLines(evaluation: Evaluation, shotName: string | undefined, environment: string | undefined, overridden = false): string[] {
  const lines: string[] = [];
  if (evaluation.lights.length) lines.push(`Lights: ${evaluation.lights.map((l) => `${l.name} (${l.position ? `at (${l.position.map(fmt).join(", ")}), range ${fmt(l.range ?? 2)}` : `azimuth ${fmt(l.azimuth)}, elevation ${fmt(l.elevation)}`}, size ${fmt(l.size)}, ${l.colorName}${l.power !== 1 ? `, power ${fmt(l.power)}` : ""})`).join("; ")}${evaluation.lights.length >= 2 ? " (lights.png shows each alone)" : ""}`);
  if (evaluation.cameras.length) lines.push(`Cameras: ${evaluation.cameras.map((c) => `${c.name} (${[c.azimuth !== undefined ? `azimuth ${fmt(c.azimuth)}` : "", c.elevation !== undefined ? `elevation ${fmt(c.elevation)}` : "", c.zoom !== undefined ? `zoom ${fmt(c.zoom)}` : "", c.focus ? `on ${c.focus}` : "", c.dof !== undefined ? `dof ${fmt(c.dof)}` : ""].filter(Boolean).join(", ") || "the render's view"}) → beauty_${c.name}.png`).join("; ")}${shotName ? ` (the sheet and beauty.png use "${shotName}"${overridden ? ", its angles overridden from the command line" : ""})` : ""}`);
  if (environment) lines.push(`Environment: ${environment}`);
  return lines;
}
