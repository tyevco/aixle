/**
 * Parse a binary glTF into triangles: every mesh primitive of every node,
 * with node transforms applied, positions and indices only.
 */
import type { ImportedMesh } from "./obj.js";

interface Accessor { bufferView?: number; byteOffset?: number; componentType: number; count: number; type: string }
interface BufferView { byteOffset?: number; byteLength: number; byteStride?: number }
interface Node { mesh?: number; children?: number[]; matrix?: number[]; translation?: number[]; rotation?: number[]; scale?: number[] }
interface Gltf {
  accessors?: Accessor[];
  bufferViews?: BufferView[];
  meshes?: { primitives: { attributes: Record<string, number>; indices?: number; mode?: number }[] }[];
  nodes?: Node[];
  scenes?: { nodes: number[] }[];
  scene?: number;
}

const SIZES: Record<string, number> = { SCALAR: 1, VEC2: 2, VEC3: 3, VEC4: 4, MAT4: 16 };

type Mat4 = number[];
const identity = (): Mat4 => [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];
function mul(a: Mat4, b: Mat4): Mat4 {
  const r = new Array(16).fill(0);
  for (let c = 0; c < 4; c++) for (let rr = 0; rr < 4; rr++) for (let k = 0; k < 4; k++) r[c * 4 + rr] += a[k * 4 + rr] * b[c * 4 + k];
  return r;
}
function trs(n: Node): Mat4 {
  if (n.matrix) return n.matrix;
  const t = n.translation ?? [0, 0, 0], q = n.rotation ?? [0, 0, 0, 1], s = n.scale ?? [1, 1, 1];
  const [x, y, z, w] = q;
  const m: Mat4 = [
    (1 - 2 * (y * y + z * z)) * s[0], 2 * (x * y + z * w) * s[0], 2 * (x * z - y * w) * s[0], 0,
    2 * (x * y - z * w) * s[1], (1 - 2 * (x * x + z * z)) * s[1], 2 * (y * z + x * w) * s[1], 0,
    2 * (x * z + y * w) * s[2], 2 * (y * z - x * w) * s[2], (1 - 2 * (x * x + y * y)) * s[2], 0,
    t[0], t[1], t[2], 1,
  ];
  return m;
}

export function parseGlb(buf: Buffer): ImportedMesh {
  if (buf.length < 20 || buf.toString("ascii", 0, 4) !== "glTF") throw new Error("not a GLB file");
  const jsonLen = buf.readUInt32LE(12);
  if (buf.toString("ascii", 16, 20) !== "JSON") throw new Error("GLB has no JSON chunk");
  const gltf = JSON.parse(buf.toString("utf8", 20, 20 + jsonLen)) as Gltf;
  let bin: Buffer | undefined;
  let at = 20 + jsonLen;
  while (at + 8 <= buf.length) {
    const len = buf.readUInt32LE(at);
    const type = buf.toString("ascii", at + 4, at + 8);
    if (type === "BIN\0") { bin = buf.subarray(at + 8, at + 8 + len); break; }
    at += 8 + len;
  }
  if (!bin) throw new Error("GLB has no binary chunk");
  const read = (ai: number): Float64Array => {
    const acc = gltf.accessors![ai];
    const view = gltf.bufferViews![acc.bufferView!];
    const n = SIZES[acc.type];
    const out = new Float64Array(acc.count * n);
    const base = (view.byteOffset ?? 0) + (acc.byteOffset ?? 0);
    const compSize = acc.componentType === 5126 || acc.componentType === 5125 ? 4 : acc.componentType === 5123 ? 2 : 1;
    const stride = view.byteStride ?? n * compSize;
    for (let i = 0; i < acc.count; i++)
      for (let k = 0; k < n; k++) {
        const off = base + i * stride + k * compSize;
        out[i * n + k] =
          acc.componentType === 5126 ? bin!.readFloatLE(off)
          : acc.componentType === 5125 ? bin!.readUInt32LE(off)
          : acc.componentType === 5123 ? bin!.readUInt16LE(off)
          : bin!.readUInt8(off);
      }
    return out;
  };
  const pos: number[] = [], idx: number[] = [];
  const visit = (ni: number, parent: Mat4) => {
    const node = gltf.nodes![ni];
    const m = mul(parent, trs(node));
    if (node.mesh !== undefined) {
      for (const prim of gltf.meshes![node.mesh].primitives) {
        if (prim.mode !== undefined && prim.mode !== 4) continue;
        const p = read(prim.attributes.POSITION);
        const base = pos.length / 3;
        for (let i = 0; i < p.length; i += 3) {
          const x = p[i], y = p[i + 1], z = p[i + 2];
          pos.push(m[0] * x + m[4] * y + m[8] * z + m[12], m[1] * x + m[5] * y + m[9] * z + m[13], m[2] * x + m[6] * y + m[10] * z + m[14]);
        }
        if (prim.indices !== undefined) {
          const ix = read(prim.indices);
          for (let i = 0; i < ix.length; i++) idx.push(base + ix[i]);
        } else for (let i = 0; i < p.length / 3; i++) idx.push(base + i);
      }
    }
    for (const c of node.children ?? []) visit(c, m);
  };
  const roots = gltf.scenes?.[gltf.scene ?? 0]?.nodes ?? (gltf.nodes ?? []).map((_, i) => i);
  for (const r of roots) visit(r, identity());
  if (pos.length === 0 || idx.length === 0) throw new Error("no triangles found in the GLB");
  return { positions: new Float32Array(pos), indices: new Uint32Array(idx) };
}
