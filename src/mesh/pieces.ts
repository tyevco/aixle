import type { Shape3 } from "../sdf/types.js";
import { surfaceNets } from "./surfaceNets.js";
import { analyse, isSpeck, type Physics } from "./physics.js";
import type { Vec3 } from "../core/vec.js";
import { boundsSize, isEmpty } from "../sdf/types.js";
import type { Mesh } from "./mesh.js";

/** A shape meshed at a resolution and analysed: what pieces(), overhang() and a failing pieces() promise all read. */
export interface MeshedAnalysis {
  physics: Physics;
  cell: number;
  /** The mesh itself and the mesher's own cell, for a query that reads the surface rather than the analysis (wall()). */
  mesh: Mesh;
  meshCell: number;
}

/**
 * One analysis per shape and resolution, shared by every query on that shape in one evaluation (`wall()` reads its
 * mesh): `pieces(hub)` and
 * `overhang(hub)` at grid 160 meshed the hub twice, and a failing `pieces()` a third time to name its loose piece
 * (round 10: check took 4.9 s on a small flange). Keyed by the shape itself, which never changes once built, so a
 * shape posed by a different evaluation is a different key.
 */
export type MeshCache = Map<Shape3, Map<number, MeshedAnalysis | null>>;

/** The shape meshed at `resolution` cells on its longest side and analysed, from the cache when it holds it; null for no surface. */
export function meshedAnalysis(shape: Shape3, resolution = 64, cache?: MeshCache): MeshedAnalysis | null {
  if (isEmpty(shape.bounds)) return null;
  const byRes = cache?.get(shape);
  const known = byRes?.get(resolution);
  if (known !== undefined) return known;
  const nets = surfaceNets(shape, { resolution: Math.max(8, Math.round(resolution)) });
  let out: MeshedAnalysis | null = null;
  if (nets.mesh.indices.length) {
    const size = boundsSize(shape.bounds);
    const cell = Math.max(size[0], size[1], size[2]) / resolution;
    out = { physics: analyse(nets.mesh, cell), cell, mesh: nets.mesh, meshCell: nets.cellSize };
  }
  if (cache) {
    if (byRes) byRes.set(resolution, out);
    else cache.set(shape, new Map([[resolution, out]]));
  }
  return out;
}

/**
 * How many separate pieces a shape meshes into at `resolution` cells on
 * its longest side: the count the report's Pieces row gives at that grid,
 * cavities and specks left out. Meshed rather than flood-filled on the
 * field, so a seam the mesher opens between two touching parts counts
 * here as it does in the report, and a program can assert `pieces(m) == 1`
 * and mean the same thing the render says.
 */
export function countPieces(shape: Shape3, resolution = 64, cache?: MeshCache): number {
  const m = meshedAnalysis(shape, resolution, cache);
  if (!m) return 0;
  return m.physics.pieces.filter((pc) => !pc.cavity && !isSpeck(pc, m.physics, m.cell)).length;
}

/**
 * The fraction of the shape's surface that faces down more than 45 degrees, other than the faces resting on the
 * floor: the report's Overhangs row at `resolution` cells, 0 to 1. For assert overhang(model) < 0.05.
 */
export function overhangFraction(shape: Shape3, resolution = 64, cache?: MeshCache): number {
  const m = meshedAnalysis(shape, resolution, cache);
  return m ? m.physics.overhang : 0;
}

/**
 * The smallest solid piece other than the largest, when the shape meshes into more than one: what a pieces() promise
 * names. `inside` is a point in the piece's solid, half a cell in from one of its vertices along the field, for naming
 * the step it is made of (its centre can be in the air: a ring's is in its hole).
 */
export function loosePiece(shape: Shape3, resolution = 64, cache?: MeshCache): { count: number; volume: number; centre: [number, number, number]; inside: [number, number, number] } | undefined {
  const m = meshedAnalysis(shape, resolution, cache);
  if (!m) return undefined;
  const solid = m.physics.pieces.filter((pc) => !pc.cavity && !isSpeck(pc, m.physics, m.cell));
  if (solid.length < 2) return undefined;
  const last = solid[solid.length - 1];
  const [x, y, z] = last.at, e = m.cell * 0.05, d = shape.dist;
  const g = [d(x + e, y, z) - d(x - e, y, z), d(x, y + e, z) - d(x, y - e, z), d(x, y, z + e) - d(x, y, z - e)];
  const gl = Math.hypot(g[0], g[1], g[2]) || 1;
  const k = m.cell * 0.5 / gl;
  const inward: [number, number, number] = [x - g[0] * k, y - g[1] * k, z - g[2] * k];
  return { count: solid.length, volume: Math.abs(last.volume), centre: [last.centre[0], last.centre[1], last.centre[2]], inside: d(inward[0], inward[1], inward[2]) < 0 ? inward : [x, y, z] };
}

/**
 * Whether a shape on its own stands: the margin by which its centre of mass, projected on the floor, lies inside the
 * footprint of what rests within a cell and a half of its lowest point, in model units, positive inside and negative
 * outside (the report's Stands row, at `resolution` cells). With the centre of mass and the footprint, and, for a
 * failure, the way it would tip: from the footprint's nearest edge towards the centre of mass, on the plan (x, z).
 * -Infinity when the shape rests on a point or an edge (no footprint) or has no surface at that cell.
 */
export function standing(shape: Shape3, resolution = 64, cache?: MeshCache): { margin: number; centre?: Vec3; footprint: [number, number][]; towards?: [number, number] } {
  const m = meshedAnalysis(shape, Math.max(8, Math.round(resolution)), cache);
  if (!m) return { margin: -Infinity, footprint: [] };
  const ph = m.physics, hull = ph.footprint;
  const [cx, , cz] = ph.centre;
  let towards: [number, number] | undefined;
  if (hull.length >= 3) {
    // The nearest point of the footprint's edge to the centre of mass.
    let best = Infinity, near: [number, number] = [cx, cz];
    for (let i = 0; i < hull.length; i++) {
      const a = hull[i], b = hull[(i + 1) % hull.length];
      const ex = b[0] - a[0], ez = b[1] - a[1], l2 = ex * ex + ez * ez || 1;
      const t = Math.max(0, Math.min(1, ((cx - a[0]) * ex + (cz - a[1]) * ez) / l2));
      const px = a[0] + ex * t, pz = a[1] + ez * t, dd = Math.hypot(cx - px, cz - pz);
      if (dd < best) { best = dd; near = [px, pz]; }
    }
    // Outside, it tips from the edge towards the centre of mass; inside, the nearest edge is the way it would go.
    const dx = ph.stabilityMargin < 0 ? cx - near[0] : near[0] - cx, dz = ph.stabilityMargin < 0 ? cz - near[1] : near[1] - cz;
    const l = Math.hypot(dx, dz);
    if (l > 0) towards = [dx / l, dz / l];
  }
  return { margin: ph.stabilityMargin, centre: [ph.centre[0], ph.centre[1], ph.centre[2]], footprint: hull, towards };
}
