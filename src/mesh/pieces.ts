import type { Shape3 } from "../sdf/types.js";
import { surfaceNets } from "./surfaceNets.js";
import { analyse, isSpeck, type Physics } from "./physics.js";
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

/** The smallest solid piece other than the largest, when the shape meshes into more than one: what a pieces() promise names. */
export function loosePiece(shape: Shape3, resolution = 64, cache?: MeshCache): { count: number; volume: number; centre: [number, number, number] } | undefined {
  const m = meshedAnalysis(shape, resolution, cache);
  if (!m) return undefined;
  const solid = m.physics.pieces.filter((pc) => !pc.cavity && !isSpeck(pc, m.physics, m.cell));
  if (solid.length < 2) return undefined;
  const last = solid[solid.length - 1];
  return { count: solid.length, volume: Math.abs(last.volume), centre: [last.centre[0], last.centre[1], last.centre[2]] };
}
