/**
 * Binary glTF 2.0 writer: positions, normals, vertex colours (the procedural
 * pattern baked per vertex) and one primitive per material with a PBR
 * metallic/roughness. No dependency; the file is a JSON chunk and one buffer.
 */
import { albedo } from "../sdf/materials.js";
import type { Mesh } from "../mesh/mesh.js";

export function toGlb(mesh: Mesh, name: string): Buffer {
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
    bufferViews.push({ buffer: 0, byteOffset: offset, byteLength: data.length, target });
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
  const colAcc = vec3Accessor(colors, false);

  const primitives: object[] = [];
  const materials: object[] = [];
  mesh.materials.forEach((m, i) => {
    const tris = perMaterial[i];
    if (tris.length === 0) return;
    const arr = new Uint32Array(tris);
    const view = pushView(Buffer.from(arr.buffer), 34963);
    accessors.push({ bufferView: view, componentType: 5125, count: arr.length, type: "SCALAR" });
    materials.push({
      name: m.name,
      pbrMetallicRoughness: { baseColorFactor: [1, 1, 1, 1], metallicFactor: m.metal, roughnessFactor: m.rough },
    });
    primitives.push({
      attributes: { POSITION: posAcc, NORMAL: nrmAcc, COLOR_0: colAcc },
      indices: accessors.length - 1,
      material: materials.length - 1,
    });
  });

  const json = {
    asset: { version: "2.0", generator: "aixle" },
    scene: 0,
    scenes: [{ nodes: [0] }],
    nodes: [{ mesh: 0, name }],
    meshes: [{ name, primitives }],
    materials,
    accessors,
    bufferViews,
    buffers: [{ byteLength: offset }],
  };
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
