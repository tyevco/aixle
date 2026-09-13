import type { Shape3 } from "../sdf/types.js";
import { surfaceNets } from "./surfaceNets.js";
import { analyse, isSpeck } from "./physics.js";
import { boundsSize, isEmpty } from "../sdf/types.js";

/**
 * How many separate pieces a shape meshes into at `resolution` cells on
 * its longest side: the count the report's Pieces row gives at that grid,
 * cavities and specks left out. Meshed rather than flood-filled on the
 * field, so a seam the mesher opens between two touching parts counts
 * here as it does in the report, and a program can assert `pieces(m) == 1`
 * and mean the same thing the render says.
 */
export function countPieces(shape: Shape3, resolution = 64): number {
  if (isEmpty(shape.bounds)) return 0;
  const nets = surfaceNets(shape, { resolution: Math.max(8, Math.round(resolution)) });
  if (!nets.mesh.indices.length) return 0;
  const size = boundsSize(shape.bounds);
  const cell = Math.max(size[0], size[1], size[2]) / resolution;
  const physics = analyse(nets.mesh, cell);
  return physics.pieces.filter((pc) => !pc.cavity && !isSpeck(pc, physics, cell)).length;
}
