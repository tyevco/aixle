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

/**
 * Why a mesh is not watertight, when it is not: edges with only one
 * triangle (a hole) or with more than two (two sheets of surface through
 * one cell, which is what a feature about a cell thin produces).
 */
export interface EdgeCluster {
  /** The mean of the cluster's edge midpoints: for sorting, not a place (a ring of edges averages to its middle). */
  centre: Vec3;
  /** The midpoint of the edge nearest the mean: a point that is on the model. */
  at: Vec3;
  /** The box the cluster's edges span. */
  box: Bounds;
  count: number;
}

export function watertightReport(m: Mesh): { ok: boolean; holes: number; nonManifold: number; note: string; where?: Bounds; clusters?: EdgeCluster[] } {
  const count = new Map<string, number>();
  const ix = m.indices;
  for (let i = 0; i < ix.length; i += 3)
    for (let e = 0; e < 3; e++) {
      const a = ix[i + e], b = ix[i + ((e + 1) % 3)];
      const key = a < b ? `${a},${b}` : `${b},${a}`;
      count.set(key, (count.get(key) ?? 0) + 1);
    }
  let holes = 0, nonManifold = 0;
  // Where the bad edges are, so the report can say which part to look at.
  const where: Bounds = { min: [Infinity, Infinity, Infinity], max: [-Infinity, -Infinity, -Infinity] };
  const p = m.positions;
  const mids: Vec3[] = [];
  for (const [key, c] of count) {
    if (c === 2) continue;
    if (c === 1) holes++;
    else nonManifold++;
    const mid: Vec3 = [0, 0, 0];
    for (const v of key.split(",")) {
      const o = Number(v) * 3;
      for (let k = 0; k < 3; k++) {
        where.min[k] = Math.min(where.min[k], p[o + k]);
        where.max[k] = Math.max(where.max[k], p[o + k]);
        mid[k] += p[o + k] / 2;
      }
    }
    mids.push(mid);
  }
  // Where the bad edges bunch: an 8-cell grid over their box, the fullest cells first (measured: one box over a
  // whole trophy named only the final step).
  const clusters: EdgeCluster[] = [];
  if (mids.length) {
    const size = [0, 1, 2].map((k) => Math.max(1e-9, where.max[k] - where.min[k]));
    const buckets = new Map<string, { sum: Vec3; count: number; mids: Vec3[] }>();
    for (const mid of mids) {
      const key = [0, 1, 2].map((k) => Math.min(7, Math.floor(((mid[k] - where.min[k]) / size[k]) * 8))).join(",");
      const b = buckets.get(key) ?? { sum: [0, 0, 0], count: 0, mids: [] };
      for (let k = 0; k < 3; k++) b.sum[k] += mid[k];
      b.count++;
      b.mids.push(mid);
      buckets.set(key, b);
    }
    // Every bucket, fullest first: the report prints the top three and tallies all of them, and report.json
    // carries the whole list (round 6: a tally of the top three left most edges unattributed).
    for (const b of [...buckets.values()].sort((x, y) => y.count - x.count)) {
      const centre: Vec3 = [b.sum[0] / b.count, b.sum[1] / b.count, b.sum[2] / b.count];
      // The mean of a ring of edges round a hub is inside the hub (measured: a bicycle's report pointed there);
      // the edge nearest the mean is on the surface, and the box says whether the edges lie along a line or a plane.
      let at = b.mids[0], best = Infinity;
      const box: Bounds = { min: [Infinity, Infinity, Infinity], max: [-Infinity, -Infinity, -Infinity] };
      for (const mid of b.mids) {
        const d = (mid[0] - centre[0]) ** 2 + (mid[1] - centre[1]) ** 2 + (mid[2] - centre[2]) ** 2;
        if (d < best) { best = d; at = mid; }
        for (let k = 0; k < 3; k++) { box.min[k] = Math.min(box.min[k], mid[k]); box.max[k] = Math.max(box.max[k], mid[k]); }
      }
      clusters.push({ centre, at, box, count: b.count });
    }
  }
  const ok = holes === 0 && nonManifold === 0;
  const note = ok
    ? "yes"
    : `no: ${nonManifold ? `${nonManifold} edge${nonManifold === 1 ? "" : "s"} shared by more than two triangles, where two surfaces pass through one grid cell (a feature about a cell thin; raise the grid or thicken it)` : ""}${nonManifold && holes ? "; " : ""}${holes ? `${holes} open edge${holes === 1 ? "" : "s"}` : ""}. Renders and most viewers are unaffected; a slicer or a boolean tool may complain.`;
  return ok ? { ok, holes, nonManifold, note } : { ok, holes, nonManifold, note, where, clusters };
}
