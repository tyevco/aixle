/**
 * Binary glTF 2.0 writer: positions, normals, vertex colours (the procedural
 * pattern baked per vertex) and one primitive per material with a PBR
 * metallic/roughness. No dependency; the file is a JSON chunk and one buffer.
 */
import { albedo } from "../sdf/materials.js";
import type { Mesh } from "../mesh/mesh.js";
import type { Material } from "../sdf/types.js";
import { KEY } from "../render/photometry.js";

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
  /** Per joint name: one offset per keyframe, added to the node's rest translation. Joints not named do not move. */
  moves?: Record<string, [number, number, number][]>;
  /** Per joint name: one [sx, sy, sz] per keyframe about the pivot. Joints not named keep their size. */
  scales?: Record<string, [number, number, number][]>;
}

/** A light the program declares, as the beauty render takes it. */
export interface SceneLight {
  name?: string;
  azimuth: number;
  elevation: number;
  /** 0..1, sRGB as written. */
  color: [number, number, number];
  power: number;
  position?: [number, number, number];
  range?: number;
}

/** A KHR_lights_punctual light and the node that places it. */
export interface GlbLight {
  name: string;
  type: "point" | "directional";
  /** Linear RGB. */
  color: [number, number, number];
  /** Candela for a point light, lux for a directional one. */
  intensity: number;
  /** A point light's cutoff, where an engine takes it to zero. */
  range?: number;
  translation: [number, number, number];
  /** A directional light's node turned so its -z points the way the light travels. */
  rotation?: [number, number, number, number];
}

/**
 * The program's lights as glTF punctual lights (round 11: a torch that lit a door in beauty.png lit nothing in an
 * engine), in the units that make an engine light the model as the beauty render does.
 *
 * Both work in linear light. The beauty render gives a white face turned square to a light of power p the radiance
 * KEY·p (photometry.ts: KEY = 1.05), Lambert in the cosine of the face's angle, and a point light's strength at a
 * distance d is range² / (range² + d²) of that. A physically lit engine (three.js, Blender, Godot, Filament) gives
 * a white Lambert face albedo / π times its irradiance: lux × cos θ from a directional light, candela × cos θ / d²
 * from a point light. So:
 * - a directional light is π·KEY·p lux, 3.30 for power 1, and agrees with beauty.png on every face at every angle
 *   (the display-space renderer it replaces could agree at one angle only, 60 degrees);
 * - a point light is π·KEY·p·range² candela, and the two laws agree only far off. At `range` the engine is twice as
 *   bright as beauty.png, at half of it five times; with glTF's cutoff (below) they cross at about 1.8 ranges, the
 *   engine is 0.8 of beauty.png at two and a third at two and a half, and dark at three, where beauty.png keeps a
 *   tenth. A point light with no range has the beauty render's: half the model's longest side (`defaultRange`).
 * glTF's `range` is that cutoff, three times the program's range. Colours go from sRGB to linear. The apparent size
 * (soft shadows, a mirror's softbox) has no glTF counterpart and is left out. A directional light's node sits three
 * radii out from the model's centre along its direction, for an engine whose shadow camera needs a place.
 */
/** glTF's range for a point light, where an engine takes it to zero: this many times the program's range. */
export const GLB_RANGE_CUTOFF = 3;

export function glbLights(lights: SceneLight[], centre: [number, number, number], radius: number, defaultRange = 2): GlbLight[] {
  return lights.map((l, i) => {
    const color = l.color.map((c) => Number(srgbToLinear(c).toFixed(5))) as [number, number, number];
    const name = l.name ?? `light_${i + 1}`;
    const lux = Math.PI * KEY * Math.max(0, l.power);
    if (l.position) {
      const range = l.range ?? defaultRange;
      return { name, type: "point" as const, color, intensity: Number((lux * range * range).toPrecision(6)), range: Number((range * GLB_RANGE_CUTOFF).toPrecision(6)), translation: [l.position[0], l.position[1], l.position[2]] };
    }
    const az = (l.azimuth * Math.PI) / 180, el = (l.elevation * Math.PI) / 180;
    // Towards the light; the light travels the other way, which is the node's -z.
    const to: [number, number, number] = [Math.sin(az) * Math.cos(el), Math.sin(el), Math.cos(az) * Math.cos(el)];
    return {
      name, type: "directional" as const, color,
      intensity: Number(lux.toPrecision(6)),
      translation: [centre[0] + to[0] * radius * 3, centre[1] + to[1] * radius * 3, centre[2] + to[2] * radius * 3],
      rotation: rotationFromZ(to),
    };
  });
}

/** The quaternion that turns +z onto `d` (a unit vector), the shorter way round. */
export function rotationFromZ(d: [number, number, number]): [number, number, number, number] {
  // q = (z × d, 1 + z · d), normalised; opposite vectors turn half a turn about x.
  const w = 1 + d[2];
  if (w < 1e-9) return [1, 0, 0, 0];
  const x = -d[1], y = d[0], z = 0;
  const l = Math.hypot(x, y, z, w);
  return [x / l, y / l, z / l, w / l];
}

/** sRGB-encoded 0..1 to linear, for a factor where the texture it stands in for would have been sRGB. */
export const srgbToLinear = (v: number): number => (v <= 0.04045 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4));

/** Quaternion for rotations about x, then y, then z, in degrees (the joint convention). */
/** A quaternion for `deg` degrees about an axis, for a joint declared with one: the animation then turns about it. */
export function axisAngleToQuat(axis: [number, number, number], deg: number): [number, number, number, number] {
  const len = Math.hypot(axis[0], axis[1], axis[2]) || 1;
  const h = (deg * Math.PI) / 360, s = Math.sin(h);
  return [(axis[0] / len) * s, (axis[1] / len) * s, (axis[2] / len) * s, Math.cos(h)];
}

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

export function toGlbScene(h: SceneHierarchy, name: string, animations: GlbAnimation[] = [], lights: GlbLight[] = []): Buffer {
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

  // Textures: the colour atlas first, then whichever of the normal, metallic-roughness and emissive maps the bake
  // found worth writing, all on the atlas's UVs.
  const textured = !!h.atlas;
  const images: object[] = [];
  const addImage = (png: Buffer, what: string): number => {
    images.push({ bufferView: pushView(png, 0), mimeType: "image/png", name: `${name} ${what}` });
    return images.length - 1;
  };
  const baseTex = h.atlas ? addImage(h.atlas.toPng(), "atlas") : -1;
  const normalTex = textured && h.normalMap && h.tangents ? addImage(h.normalMap.toPng(), "normal") : -1;
  const mrTex = textured && h.metalRoughMap ? addImage(h.metalRoughMap.toPng(), "metallic-roughness") : -1;
  const emTex = textured && h.emissiveMap ? addImage(h.emissiveMap.toPng(), "emissive") : -1;
  const extensionsUsed = new Set<string>();

  // Materials, shared across meshes.
  const materials: object[] = [];
  const matIds = new Map<Material, number>();
  const materialId = (m: Material): number => {
    let id = matIds.get(m);
    if (id !== undefined) return id;
    const maps = h.materialMaps?.get(m);
    const pbr: Record<string, unknown> = { baseColorFactor: [1, 1, 1, 1], metallicFactor: maps?.metal ?? m.metal, roughnessFactor: maps?.rough ?? m.rough };
    if (textured) pbr.baseColorTexture = { index: baseTex };
    const def: Record<string, unknown> = { name: m.name, pbrMetallicRoughness: pbr };
    // A map multiplies its factor, so a material that reads one has factors of 1.
    if (mrTex >= 0 && maps?.metalRough) { pbr.metallicRoughnessTexture = { index: mrTex }; pbr.metallicFactor = 1; pbr.roughnessFactor = 1; }
    if (normalTex >= 0 && maps?.normal) def.normalTexture = { index: normalTex };
    if (m.glow > 0 && h.pbr !== false) {
      // glTF's emissive factor is at most 1; a glow above that is the emissive strength extension's.
      const k = Math.min(1, m.glow);
      if (emTex >= 0 && maps?.emissive) { def.emissiveTexture = { index: emTex }; def.emissiveFactor = [k, k, k]; }
      else {
        // One colour: a factor, linear where the atlas is sRGB.
        const c = maps?.emissiveColor ?? m.color;
        def.emissiveFactor = c.map((v) => Number((srgbToLinear(v) * k).toFixed(4)));
      }
      if (m.glow > 1) { def.extensions = { KHR_materials_emissive_strength: { emissiveStrength: m.glow } }; extensionsUsed.add("KHR_materials_emissive_strength"); }
    }
    materials.push(def);
    id = materials.length - 1;
    matIds.set(m, id);
    return id;
  };

  // Meshes.
  const meshes: object[] = [];
  h.meshes.forEach((mesh, mi) => {
    const n = mesh.positions.length / 3;
    const posAcc = floatAccessor(mesh.positions, "VEC3", true);
    const nrmAcc = floatAccessor(mesh.normals, "VEC3", false);
    let uvAcc = -1, colAcc = -1, tanAcc = -1;
    if (textured && h.uvs) uvAcc = floatAccessor(h.uvs[mi], "VEC2", false);
    else {
      const colors = new Float32Array(n * 3);
      for (let v = 0; v < n; v++) {
        const c = albedo(mesh.materials[mesh.materialIndex[v]], mesh.local[v * 3], mesh.local[v * 3 + 1], mesh.local[v * 3 + 2]);
        colors[v * 3] = c[0]; colors[v * 3 + 1] = c[1]; colors[v * 3 + 2] = c[2];
      }
      colAcc = floatAccessor(colors, "VEC3", false);
    }
    // Tangents only for a mesh with a normal-mapped material: sixteen bytes a vertex, and the bulk of the growth.
    const mapped = normalTex >= 0 && h.tangents && [...new Set(mesh.materialIndex)].some((i) => h.materialMaps?.get(mesh.materials[i])?.normal);
    if (mapped) tanAcc = floatAccessor(h.tangents![mi], "VEC4", false);
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
      if (tanAcc >= 0) attributes.TANGENT = tanAcc;
      if (uvAcc >= 0) attributes.TEXCOORD_0 = uvAcc; else attributes.COLOR_0 = colAcc;
      primitives.push({ attributes, indices: accessors.length - 1, material: materialId(mesh.materials[m]) });
    }
    meshes.push({ name: `mesh_${mi}`, primitives });
  });

  // Nodes.
  const nodes: Record<string, unknown>[] = [];
  const jointNodeIndex = new Map<string, number>();
  const jointNodeRest = new Map<string, { translation: [number, number, number]; scale: number }>();
  const addNode = (n: SceneNode): number => {
    const node: Record<string, unknown> = { name: n.name };
    if (n.mesh >= 0) node.mesh = n.mesh;
    if (n.translation.some((v) => v !== 0)) node.translation = n.translation;
    if (n.yaw !== 0) node.rotation = eulerToQuat(0, n.yaw, 0);
    if (n.scale !== 1) node.scale = [n.scale, n.scale, n.scale];
    const index = nodes.length;
    nodes.push(node);
    if (n.joint) { jointNodeIndex.set(n.joint, index); jointNodeRest.set(n.joint, { translation: [n.translation[0], n.translation[1], n.translation[2]], scale: n.scale }); }
    const children = n.children.map(addNode);
    if (children.length) node.children = children;
    return index;
  };
  const rootIndices = h.roots.map(addNode);
  // The program's lights, each on a node of its own at the scene's root.
  for (const [i, l] of lights.entries()) {
    const node: Record<string, unknown> = { name: l.name, translation: l.translation, extensions: { KHR_lights_punctual: { light: i } } };
    if (l.rotation) node.rotation = l.rotation;
    rootIndices.push(nodes.length);
    nodes.push(node);
  }

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
    // A move is on top of where the joint sits at rest; a scale on top of the node's own (1 for a joint).
    for (const [jointName, offsets] of Object.entries(a.moves ?? {})) {
      const nodeIndex = jointNodeIndex.get(jointName);
      const rest = jointNodeRest.get(jointName);
      if (nodeIndex === undefined || !rest) continue;
      const flat = new Float32Array(offsets.length * 3);
      offsets.forEach((o, i) => flat.set([rest.translation[0] + o[0], rest.translation[1] + o[1], rest.translation[2] + o[2]], i * 3));
      const outAcc = floatAccessor(flat, "VEC3", false, 0);
      samplers.push({ input: inputAcc, output: outAcc, interpolation: "LINEAR" });
      channels.push({ sampler: samplers.length - 1, target: { node: nodeIndex, path: "translation" } });
    }
    for (const [jointName, sizes] of Object.entries(a.scales ?? {})) {
      const nodeIndex = jointNodeIndex.get(jointName);
      const rest = jointNodeRest.get(jointName);
      if (nodeIndex === undefined || !rest) continue;
      const flat = new Float32Array(sizes.length * 3);
      sizes.forEach((sc, i) => flat.set([sc[0] * rest.scale, sc[1] * rest.scale, sc[2] * rest.scale], i * 3));
      const outAcc = floatAccessor(flat, "VEC3", false, 0);
      samplers.push({ input: inputAcc, output: outAcc, interpolation: "LINEAR" });
      channels.push({ sampler: samplers.length - 1, target: { node: nodeIndex, path: "scale" } });
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
    json.images = images;
    json.samplers = [{ magFilter: 9729, minFilter: 9987, wrapS: 33071, wrapT: 33071 }];
    json.textures = images.map((_, i) => ({ sampler: 0, source: i }));
  }
  if (lights.length) {
    json.extensions = { KHR_lights_punctual: { lights: lights.map((l) => ({ name: l.name, type: l.type, color: l.color, intensity: l.intensity, ...(l.range !== undefined ? { range: l.range } : {}) })) } };
    extensionsUsed.add("KHR_lights_punctual");
  }
  if (extensionsUsed.size) json.extensionsUsed = [...extensionsUsed];
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
