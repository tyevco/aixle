/**
 * Binary glTF 2.0 writer: positions, normals, vertex colours (the procedural
 * pattern baked per vertex) and one primitive per material with a PBR
 * metallic/roughness. No dependency; the file is a JSON chunk and one buffer.
 */
import { albedo } from "../sdf/materials.js";
import type { Mesh } from "../mesh/mesh.js";
import type { Material } from "../sdf/types.js";

export interface GlbTexture {
  /** u, v per vertex, glTF convention. */
  uv: Float32Array;
  /** PNG bytes of the atlas. */
  png: Buffer;
}

/**
 * With `texture`, the mesh's UVs and the atlas PNG go into the file and the
 * material samples it; vertex colours are left out then, since a viewer
 * multiplies the two and would show the pattern squared.
 */
export function toGlb(mesh: Mesh, name: string, texture?: GlbTexture): Buffer {
  const n = mesh.positions.length / 3;
  const colors = new Float32Array(n * 3);
  for (let v = 0; v < n; v++) {
    const m = mesh.materials[mesh.materialIndex[v]];
    const c = albedo(m, mesh.local[v * 3], mesh.local[v * 3 + 1], mesh.local[v * 3 + 2]);
    colors[v * 3] = c[0]; colors[v * 3 + 1] = c[1]; colors[v * 3 + 2] = c[2];
  }
  // Index buffers per material.
  const perMaterial = mesh.materials.map(() => [] as number[]);
  const ix = mesh.indices;
  for (let t = 0; t < ix.length; t += 3) perMaterial[mesh.materialIndex[ix[t]]].push(ix[t], ix[t + 1], ix[t + 2]);

  const chunks: Buffer[] = [];
  const bufferViews: object[] = [];
  const accessors: object[] = [];
  let offset = 0;
  const pushView = (data: Buffer, target: number): number => {
    const padded = Buffer.concat([data, Buffer.alloc((4 - (data.length % 4)) % 4)]);
    chunks.push(padded);
    bufferViews.push(target ? { buffer: 0, byteOffset: offset, byteLength: data.length, target } : { buffer: 0, byteOffset: offset, byteLength: data.length });
    offset += padded.length;
    return bufferViews.length - 1;
  };
  const minMax = (arr: Float32Array): { min: number[]; max: number[] } => {
    const min = [Infinity, Infinity, Infinity], max = [-Infinity, -Infinity, -Infinity];
    for (let i = 0; i < arr.length; i += 3)
      for (let k = 0; k < 3; k++) {
        min[k] = Math.min(min[k], arr[i + k]);
        max[k] = Math.max(max[k], arr[i + k]);
      }
    return { min, max };
  };
  const vec3Accessor = (arr: Float32Array, withBounds: boolean): number => {
    const view = pushView(Buffer.from(arr.buffer, arr.byteOffset, arr.byteLength), 34962);
    const acc: Record<string, unknown> = { bufferView: view, componentType: 5126, count: arr.length / 3, type: "VEC3" };
    if (withBounds) Object.assign(acc, minMax(arr));
    accessors.push(acc);
    return accessors.length - 1;
  };
  const posAcc = vec3Accessor(mesh.positions, true);
  const nrmAcc = vec3Accessor(mesh.normals, false);
  const colAcc = texture ? -1 : vec3Accessor(colors, false);
  let uvAcc = -1, imageView = -1;
  if (texture) {
    if (texture.uv.length !== n * 2) throw new Error(`texture uv count ${texture.uv.length / 2} does not match ${n} vertices`);
    const view = pushView(Buffer.from(texture.uv.buffer, texture.uv.byteOffset, texture.uv.byteLength), 34962);
    accessors.push({ bufferView: view, componentType: 5126, count: n, type: "VEC2" });
    uvAcc = accessors.length - 1;
    imageView = pushView(texture.png, 0);
  }

  const primitives: object[] = [];
  const materials: object[] = [];
  mesh.materials.forEach((m, i) => {
    const tris = perMaterial[i];
    if (tris.length === 0) return;
    const arr = new Uint32Array(tris);
    const view = pushView(Buffer.from(arr.buffer), 34963);
    accessors.push({ bufferView: view, componentType: 5125, count: arr.length, type: "SCALAR" });
    const pbr: Record<string, unknown> = { baseColorFactor: [1, 1, 1, 1], metallicFactor: m.metal, roughnessFactor: m.rough };
    if (texture) pbr.baseColorTexture = { index: 0 };
    materials.push({ name: m.name, pbrMetallicRoughness: pbr });
    const attributes: Record<string, number> = { POSITION: posAcc, NORMAL: nrmAcc };
    if (texture) attributes.TEXCOORD_0 = uvAcc;
    else attributes.COLOR_0 = colAcc;
    primitives.push({ attributes, indices: accessors.length - 1, material: materials.length - 1 });
  });

  const json: Record<string, unknown> = {
    asset: { version: "2.0", generator: "aixle" },
    scene: 0,
    scenes: [{ nodes: [0] }],
    nodes: [{ mesh: 0, name }],
    meshes: [{ name, primitives }],
    materials,
    accessors,
    bufferViews,
    buffers: [{ byteLength: 0 }],
  };
  if (texture) {
    json.images = [{ bufferView: imageView, mimeType: "image/png", name: `${name} atlas` }];
    json.samplers = [{ magFilter: 9729, minFilter: 9987, wrapS: 33071, wrapT: 33071 }];
    json.textures = [{ sampler: 0, source: 0 }];
  }
  (json.buffers as { byteLength: number }[])[0].byteLength = offset;
  let jsonBuf = Buffer.from(JSON.stringify(json), "utf8");
  jsonBuf = Buffer.concat([jsonBuf, Buffer.alloc((4 - (jsonBuf.length % 4)) % 4, 0x20)]);
  const bin = Buffer.concat(chunks);
  const header = Buffer.alloc(12);
  header.write("glTF", 0, "ascii");
  header.writeUInt32LE(2, 4);
  header.writeUInt32LE(12 + 8 + jsonBuf.length + 8 + bin.length, 8);
  const jsonHeader = Buffer.alloc(8);
  jsonHeader.writeUInt32LE(jsonBuf.length, 0);
  jsonHeader.write("JSON", 4, "ascii");
  const binHeader = Buffer.alloc(8);
  binHeader.writeUInt32LE(bin.length, 0);
  binHeader.write("BIN\0", 4, "ascii");
  return Buffer.concat([header, jsonHeader, jsonBuf, binHeader, bin]);
}

// --- scenes: a node tree, shared atlas, animations ---------------------------

import type { SceneHierarchy, SceneNode } from "./hierarchy.js";

export interface GlbAnimation {
  name: string;
  /** Keyframe times in seconds. */
  times: number[];
  /** Per joint name: one [x, y, z, w] quaternion per keyframe. */
  rotations: Record<string, [number, number, number, number][]>;
}

/** Quaternion for rotations about x, then y, then z, in degrees (the joint convention). */
export function eulerToQuat(x: number, y: number, z: number): [number, number, number, number] {
  const r = (d: number) => (d * Math.PI) / 180 / 2;
  const cx = Math.cos(r(x)), sx = Math.sin(r(x)), cy = Math.cos(r(y)), sy = Math.sin(r(y)), cz = Math.cos(r(z)), sz = Math.sin(r(z));
  // q = qz * qy * qx
  const qx: [number, number, number, number] = [sx, 0, 0, cx];
  const qy: [number, number, number, number] = [0, sy, 0, cy];
  const qz: [number, number, number, number] = [0, 0, sz, cz];
  const mul = (a: [number, number, number, number], b: [number, number, number, number]): [number, number, number, number] => [
    a[3] * b[0] + a[0] * b[3] + a[1] * b[2] - a[2] * b[1],
    a[3] * b[1] - a[0] * b[2] + a[1] * b[3] + a[2] * b[0],
    a[3] * b[2] + a[0] * b[1] - a[1] * b[0] + a[2] * b[3],
    a[3] * b[3] - a[0] * b[0] - a[1] * b[1] - a[2] * b[2],
  ];
  return mul(qz, mul(qy, qx));
}

export function toGlbScene(h: SceneHierarchy, name: string, animations: GlbAnimation[] = []): Buffer {
  const chunks: Buffer[] = [];
  const bufferViews: object[] = [];
  const accessors: object[] = [];
  let offset = 0;
  const pushView = (data: Buffer, target: number): number => {
    const padded = Buffer.concat([data, Buffer.alloc((4 - (data.length % 4)) % 4)]);
    chunks.push(padded);
    bufferViews.push(target ? { buffer: 0, byteOffset: offset, byteLength: data.length, target } : { buffer: 0, byteOffset: offset, byteLength: data.length });
    offset += padded.length;
    return bufferViews.length - 1;
  };
  const floatAccessor = (arr: Float32Array, type: "VEC2" | "VEC3" | "VEC4" | "SCALAR", withBounds: boolean, target = 34962): number => {
    const n = type === "VEC2" ? 2 : type === "VEC3" ? 3 : type === "VEC4" ? 4 : 1;
    const view = pushView(Buffer.from(arr.buffer, arr.byteOffset, arr.byteLength), target);
    const acc: Record<string, unknown> = { bufferView: view, componentType: 5126, count: arr.length / n, type };
    if (withBounds) {
      const min = new Array(n).fill(Infinity), max = new Array(n).fill(-Infinity);
      for (let i = 0; i < arr.length; i += n) for (let k = 0; k < n; k++) { min[k] = Math.min(min[k], arr[i + k]); max[k] = Math.max(max[k], arr[i + k]); }
      acc.min = min; acc.max = max;
    }
    accessors.push(acc);
    return accessors.length - 1;
  };

  // Materials, shared across meshes.
  const materials: object[] = [];
  const matIds = new Map<Material, number>();
  const textured = !!h.atlas;
  const materialId = (m: Material): number => {
    let id = matIds.get(m);
    if (id !== undefined) return id;
    const pbr: Record<string, unknown> = { baseColorFactor: [1, 1, 1, 1], metallicFactor: m.metal, roughnessFactor: m.rough };
    if (textured) pbr.baseColorTexture = { index: 0 };
    materials.push({ name: m.name, pbrMetallicRoughness: pbr });
    id = materials.length - 1;
    matIds.set(m, id);
    return id;
  };
  let imageView = -1;
  if (h.atlas) imageView = pushView(h.atlas.toPng(), 0);

  // Meshes.
  const meshes: object[] = [];
  h.meshes.forEach((mesh, mi) => {
    const n = mesh.positions.length / 3;
    const posAcc = floatAccessor(mesh.positions, "VEC3", true);
    const nrmAcc = floatAccessor(mesh.normals, "VEC3", false);
    let uvAcc = -1, colAcc = -1;
    if (textured && h.uvs) uvAcc = floatAccessor(h.uvs[mi], "VEC2", false);
    else {
      const colors = new Float32Array(n * 3);
      for (let v = 0; v < n; v++) {
        const c = albedo(mesh.materials[mesh.materialIndex[v]], mesh.local[v * 3], mesh.local[v * 3 + 1], mesh.local[v * 3 + 2]);
        colors[v * 3] = c[0]; colors[v * 3 + 1] = c[1]; colors[v * 3 + 2] = c[2];
      }
      colAcc = floatAccessor(colors, "VEC3", false);
    }
    const perMaterial = new Map<number, number[]>();
    const ix = mesh.indices;
    for (let t = 0; t < ix.length; t += 3) {
      const m = mesh.materialIndex[ix[t]];
      let list = perMaterial.get(m);
      if (!list) perMaterial.set(m, (list = []));
      list.push(ix[t], ix[t + 1], ix[t + 2]);
    }
    const primitives: object[] = [];
    for (const [m, tris] of perMaterial) {
      const arr = new Uint32Array(tris);
      const view = pushView(Buffer.from(arr.buffer), 34963);
      accessors.push({ bufferView: view, componentType: 5125, count: arr.length, type: "SCALAR" });
      const attributes: Record<string, number> = { POSITION: posAcc, NORMAL: nrmAcc };
      if (uvAcc >= 0) attributes.TEXCOORD_0 = uvAcc; else attributes.COLOR_0 = colAcc;
      primitives.push({ attributes, indices: accessors.length - 1, material: materialId(mesh.materials[m]) });
    }
    meshes.push({ name: `mesh_${mi}`, primitives });
  });

  // Nodes.
  const nodes: Record<string, unknown>[] = [];
  const jointNodeIndex = new Map<string, number>();
  const addNode = (n: SceneNode): number => {
    const node: Record<string, unknown> = { name: n.name };
    if (n.mesh >= 0) node.mesh = n.mesh;
    if (n.translation.some((v) => v !== 0)) node.translation = n.translation;
    if (n.yaw !== 0) node.rotation = eulerToQuat(0, n.yaw, 0);
    if (n.scale !== 1) node.scale = [n.scale, n.scale, n.scale];
    const index = nodes.length;
    nodes.push(node);
    if (n.joint) jointNodeIndex.set(n.joint, index);
    const children = n.children.map(addNode);
    if (children.length) node.children = children;
    return index;
  };
  const rootIndices = h.roots.map(addNode);

  // Animations.
  const anims: object[] = [];
  for (const a of animations) {
    const times = new Float32Array(a.times);
    const inputAcc = floatAccessor(times, "SCALAR", true, 0);
    const samplers: object[] = [], channels: object[] = [];
    for (const [jointName, quats] of Object.entries(a.rotations)) {
      const nodeIndex = jointNodeIndex.get(jointName);
      if (nodeIndex === undefined) continue;
      const flat = new Float32Array(quats.length * 4);
      quats.forEach((q, i) => flat.set(q, i * 4));
      const outAcc = floatAccessor(flat, "VEC4", false, 0);
      samplers.push({ input: inputAcc, output: outAcc, interpolation: "LINEAR" });
      channels.push({ sampler: samplers.length - 1, target: { node: nodeIndex, path: "rotation" } });
    }
    if (channels.length) anims.push({ name: a.name, samplers, channels });
  }

  const json: Record<string, unknown> = {
    asset: { version: "2.0", generator: "aixle" },
    scene: 0,
    scenes: [{ name, nodes: rootIndices }],
    nodes,
    meshes,
    materials,
    accessors,
    bufferViews,
    buffers: [{ byteLength: offset }],
  };
  if (textured) {
    json.images = [{ bufferView: imageView, mimeType: "image/png", name: `${name} atlas` }];
    json.samplers = [{ magFilter: 9729, minFilter: 9987, wrapS: 33071, wrapT: 33071 }];
    json.textures = [{ sampler: 0, source: 0 }];
  }
  if (anims.length) json.animations = anims;
  let jsonBuf = Buffer.from(JSON.stringify(json), "utf8");
  jsonBuf = Buffer.concat([jsonBuf, Buffer.alloc((4 - (jsonBuf.length % 4)) % 4, 0x20)]);
  const bin = Buffer.concat(chunks);
  const header = Buffer.alloc(12);
  header.write("glTF", 0, "ascii");
  header.writeUInt32LE(2, 4);
  header.writeUInt32LE(12 + 8 + jsonBuf.length + 8 + bin.length, 8);
  const jsonHeader = Buffer.alloc(8);
  jsonHeader.writeUInt32LE(jsonBuf.length, 0);
  jsonHeader.write("JSON", 4, "ascii");
  const binHeader = Buffer.alloc(8);
  binHeader.writeUInt32LE(bin.length, 0);
  binHeader.write("BIN\0", 4, "ascii");
  return Buffer.concat([header, jsonHeader, jsonBuf, binHeader, bin]);
}
