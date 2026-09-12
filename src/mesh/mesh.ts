/** The extracted surface: indexed triangles with a normal, a material and a local point per vertex. */
import type { Vec3 } from "../core/vec.js";
import type { Bounds, Material } from "../sdf/types.js";
import { EMPTY_BOUNDS, boundsUnion } from "../sdf/types.js";

export interface Mesh {
  /** xyz per vertex. */
  positions: Float32Array;
  /** Unit normal per vertex, from the field's gradient. */
  normals: Float32Array;
  /** Point in the painted part's frame per vertex, for procedural patterns. */
  local: Float32Array;
  /** Index into `materials` per vertex. */
  materialIndex: Uint16Array;
  materials: Material[];
  /** Three vertex indices per triangle, counter-clockwise seen from outside. */
  indices: Uint32Array;
}

export const vertexCount = (m: Mesh): number => m.positions.length / 3;
export const triangleCount = (m: Mesh): number => m.indices.length / 3;

export function meshBounds(m: Mesh): Bounds {
  let b = EMPTY_BOUNDS;
  const p = m.positions;
  for (let i = 0; i < p.length; i += 3) {
    const v: Vec3 = [p[i], p[i + 1], p[i + 2]];
    b = boundsUnion(b, { min: v, max: v });
  }
  return b;
}

/** Signed volume by the divergence theorem; positive for an outward-wound closed mesh. */
export function meshVolume(m: Mesh): number {
  const p = m.positions, ix = m.indices;
  let v = 0;
  for (let i = 0; i < ix.length; i += 3) {
    const a = ix[i] * 3, b = ix[i + 1] * 3, c = ix[i + 2] * 3;
    v +=
      p[a] * (p[b + 1] * p[c + 2] - p[b + 2] * p[c + 1]) -
      p[a + 1] * (p[b] * p[c + 2] - p[b + 2] * p[c]) +
      p[a + 2] * (p[b] * p[c + 1] - p[b + 1] * p[c]);
  }
  return v / 6;
}

/** True when every edge is shared by exactly two triangles in opposite directions. */
export function isWatertight(m: Mesh): boolean {
  const seen = new Map<string, number>();
  const ix = m.indices;
  for (let i = 0; i < ix.length; i += 3) {
    for (let e = 0; e < 3; e++) {
      const a = ix[i + e], b = ix[i + ((e + 1) % 3)];
      seen.set(`${a},${b}`, (seen.get(`${a},${b}`) ?? 0) + 1);
    }
  }
  for (const [key, count] of seen) {
    if (count !== 1) return false;
    const [a, b] = key.split(",");
    if (seen.get(`${b},${a}`) !== 1) return false;
  }
  return true;
}
