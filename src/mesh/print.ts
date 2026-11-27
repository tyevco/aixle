/**
 * What a slicer's user wants to know before opening the file: what a unit
 * is, how big the model prints, whether it fits the bed (turned on the
 * plate if need be), how thin its thinnest wall is and where, and how much
 * support the overhangs would stand on.
 *
 * The wall is measured by rays: from each vertex of the mesh inward, along
 * the field's own gradient, through the solid to where the field turns
 * positive again. The march is in the field, not the mesh, so a wall is
 * measured at its true thickness whatever the cell, and a step is never
 * longer than the distance to the nearest surface, so the far wall cannot
 * be stepped over. A ray at a vertex on an edge runs diagonally into the
 * solid and reads long, never short, so the minimum over all the vertices
 * is the thinnest wall's own reading. Support is the volume under the
 * overhanging faces: a ray straight down from each one to the floor or to
 * the model below, its height times the face's area on the plate.
 */
import type { Vec3 } from "../core/vec.js";
import type { Shape3 } from "../sdf/types.js";
import { isEmpty, boundsSize } from "../sdf/types.js";
import { hull2 } from "./physics.js";
import { weldIndices, type Mesh } from "./mesh.js";
import { surfaceNets } from "./surfaceNets.js";
import { meshedAnalysis, type MeshCache } from "./pieces.js";

/** Millimetres in one model unit, for `set units`. */
export const UNITS: Record<string, number> = { mm: 1, cm: 10, dm: 100, m: 1000, in: 25.4, ft: 304.8 };
/**
 * The 3MF names of the units (its `unit` attribute). 3MF has micron, millimeter, centimeter, inch, foot and meter
 * and no decimetre, so a unit missing here is written as millimetres, the coordinates scaled (see threemfUnit).
 */
export const UNIT_3MF: Record<string, string> = { mm: "millimeter", cm: "centimeter", m: "meter", in: "inch", ft: "foot" };

/** The 3MF unit for a model unit and the factor its coordinates are multiplied by: its own unit as is, or millimetres. */
export function threemfUnit(units: string): { unit: string; scale: number } {
  const own = UNIT_3MF[units];
  return own ? { unit: own, scale: 1 } : { unit: "millimeter", scale: UNITS[units] ?? 1 };
}

export interface WallReading {
  /** Thickness along the ray, in model units. */
  thickness: number;
  /** The surface point the ray started from. */
  at: Vec3;
  /** Where it left the solid on the other side. */
  to: Vec3;
}

export interface WallResult {
  /** The thinnest reading, undefined when no ray found a far side. */
  thinnest?: WallReading;
  /** Rays cast and how many came out the other side. */
  rays: number;
  exits: number;
  /** Every exit's thickness, in the order the rays were cast (one per sampled vertex), for a share under a threshold. */
  thicknesses: Float32Array;
}

/**
 * The wall thickness under every vertex (or every `stride`-th, to stay
 * under `maxRays`), measured through the field. Vertices that share a
 * position (the copies a crease split makes) are cast once.
 */
export function wallThickness(shape: Shape3, mesh: Mesh, cellSize: number, maxRays = 40000): WallResult {
  const p = mesh.positions;
  const nv = p.length / 3;
  const empty: WallResult = { rays: 0, exits: 0, thicknesses: new Float32Array(0) };
  if (!nv || !(cellSize > 0)) return empty;
  // One ray per position: a crease's copies are welded to their first.
  const ix = weldIndices(mesh);
  const used = new Uint8Array(nv);
  for (let i = 0; i < ix.length; i++) used[ix[i]] = 1;
  const verts: number[] = [];
  for (let v = 0; v < nv; v++) if (used[v]) verts.push(v);
  const stride = Math.max(1, Math.ceil(verts.length / maxRays));
  const d = shape.dist;
  const h = cellSize * 0.1;
  const minStep = cellSize * 0.05;
  const b = shape.bounds;
  const sz = boundsSize(b);
  const maxT = Math.hypot(sz[0], sz[1], sz[2]) + cellSize * 4;
  const out: number[] = [];
  let thinnest: WallReading | undefined;
  let rays = 0;
  for (let k = 0; k < verts.length; k += stride) {
    const o = verts[k] * 3;
    const x = p[o], y = p[o + 1], z = p[o + 2];
    // The inward direction is the field's own gradient here: on an edge it points between the faces and the ray
    // reads long, where a face normal from the edge would run along the other face and read nothing.
    let gx = d(x + h, y, z) - d(x - h, y, z), gy = d(x, y + h, z) - d(x, y - h, z), gz = d(x, y, z + h) - d(x, y, z - h);
    const gl = Math.sqrt(gx * gx + gy * gy + gz * gz);
    if (!(gl > 1e-12)) continue;
    gx /= -gl; gy /= -gl; gz /= -gl;
    rays++;
    const at = (t: number) => d(x + gx * t, y + gy * t, z + gz * t);
    // Where the ray enters the solid: the vertex is within a fraction of a cell of the surface, on either side.
    // A vertex in the crease where two parts meet sits in a sliver of air, and its gradient runs along the crease
    // into the join: the ray is marched in until it is inside, not assumed to start there.
    const s0 = at(0);
    let lo: number, hi: number;
    if (s0 >= 0) {
      let t = 0, s = s0, prev = 0;
      for (let i = 0; i < 64 && s >= 0 && t < cellSize * 2; i++) { prev = t; t += Math.max(s, minStep); s = at(t); }
      if (s >= 0) continue;
      lo = prev; hi = t; // outside, inside
    } else {
      let t = 0, s = s0, prev = 0;
      for (let i = 0; i < 64 && s < 0 && t > -cellSize * 2; i++) { prev = t; t -= Math.max(-s, minStep); s = at(t); }
      if (s < 0) continue;
      lo = t; hi = prev;
    }
    for (let i = 0; i < 8; i++) { const m = (lo + hi) / 2; if (at(m) < 0) hi = m; else lo = m; }
    const entry = hi;
    // Through the solid to the far side, never stepping further than the nearest surface.
    let t = entry + minStep, prev = entry;
    let s = at(t);
    for (let steps = 0; s < 0 && t < maxT && steps < 400; steps++) { prev = t; t += Math.max(-s, minStep); s = at(t); }
    if (!(s >= 0) || t >= maxT) continue;
    lo = prev; hi = t;
    for (let i = 0; i < 8; i++) { const m = (lo + hi) / 2; if (at(m) < 0) lo = m; else hi = m; }
    const thickness = hi - entry;
    if (!(thickness > 0)) continue;
    // A wall is two faces back to back: the far side must face along the ray. Near a corner sharper than a right
    // angle (a rim's lip, a chamfer's edge) the ray leaves through the side face at a slant and reads a fraction of
    // a cell, which is the corner, not a wall; a blade, whose faces meet at under this angle (the far face then faces
    // back within it, measured: a 28-degree wedge reads its edge, a 32-degree one does not), counts.
    const ex = x + gx * hi, ey = y + gy * hi, ez = z + gz * hi;
    const nx = d(ex + h, ey, ez) - d(ex - h, ey, ez), ny = d(ex, ey + h, ez) - d(ex, ey - h, ez), nz = d(ex, ey, ez + h) - d(ex, ey, ez - h);
    const nl = Math.sqrt(nx * nx + ny * ny + nz * nz);
    if (nl > 1e-12 && (nx * gx + ny * gy + nz * gz) / nl < FACING) continue;
    out.push(thickness);
    if (!thinnest || thickness < thinnest.thickness)
      thinnest = { thickness, at: [x + gx * entry, y + gy * entry, z + gz * entry], to: [ex, ey, ez] };
  }
  return { thinnest, rays, exits: out.length, thicknesses: Float32Array.from(out) };
}

/**
 * The far side of a wall faces along the ray within 30 degrees. At 45 the star points of a medal (43 degrees) and
 * the sliver of rim under a rounded edge read as walls a third of a cell thick; at 30 the medal's thinnest is its
 * lettering's stroke, as the feature size says (measured on the examples, docs/roadmap.md).
 */
const FACING = Math.cos(Math.PI / 6);

export interface SupportResult {
  /** The volume under the overhanging faces, in cubic model units: an upper estimate of what a slicer would fill. */
  volume: number;
  /** Of which standing on the floor, and on the model below. */
  fromFloor: number;
  onModel: number;
  /** Area of the overhanging faces projected on the plate, square model units. */
  area: number;
  /** The tallest column, where its face is, where it lands, and whether that is on the model (else the plate). */
  tallest: number;
  at?: Vec3;
  foot?: Vec3;
  tallestOnModel?: boolean;
  /**
   * Faces the mesh tilts past 45 degrees where the field does not face down that far, left out: at a sharp edge (a
   * cutter's corner laid on the part's own corner) dual contouring bends the faces next to the edge a few degrees,
   * and a ceiling at 40 degrees from vertical read as a 33 mm column of support (round 11). Their area on the plate.
   */
  skipped: number;
}

/**
 * Support under the faces that face down more than 45 degrees and are
 * clear of the floor (the faces the Overhangs row counts): from each face's
 * centre a ray straight down to the floor or the first surface below, its
 * length times the face's area projected on the plate. A face counts only
 * where the field faces down too, read at the face's centre: a face the
 * mesher bent at a sharp edge is not an overhang of the shape.
 */
export function supportVolume(shape: Shape3, mesh: Mesh, cellSize: number, floor: number): SupportResult {
  const p = mesh.positions, ix = mesh.indices;
  const r: SupportResult = { volume: 0, fromFloor: 0, onModel: 0, area: 0, tallest: 0, skipped: 0 };
  if (!(cellSize > 0)) return r;
  const d = shape.dist;
  const hitEps = cellSize * 0.1;
  const e = cellSize * 0.05;
  for (let t = 0; t < ix.length; t += 3) {
    const a = ix[t] * 3, b = ix[t + 1] * 3, c = ix[t + 2] * 3;
    const ux = p[b] - p[a], uy = p[b + 1] - p[a + 1], uz = p[b + 2] - p[a + 2];
    const vx = p[c] - p[a], vy = p[c + 1] - p[a + 1], vz = p[c + 2] - p[a + 2];
    const nx = uy * vz - uz * vy, ny = uz * vx - ux * vz, nz = ux * vy - uy * vx;
    const len = Math.sqrt(nx * nx + ny * ny + nz * nz);
    if (!(len > 0)) continue;
    const top = Math.max(p[a + 1], p[b + 1], p[c + 1]);
    if (!(ny / len < -Math.SQRT1_2 && top > floor + cellSize * 1.5)) continue;
    const cx = (p[a] + p[b] + p[c]) / 3, cy = (p[a + 1] + p[b + 1] + p[c + 1]) / 3, cz = (p[a + 2] + p[b + 2] + p[c + 2]) / 3;
    // Projected on the plate: half the cross product's y.
    const area = -ny / 2;
    const gx = d(cx + e, cy, cz) - d(cx - e, cy, cz), gy = d(cx, cy + e, cz) - d(cx, cy - e, cz), gz = d(cx, cy, cz + e) - d(cx, cy, cz - e);
    const gl = Math.sqrt(gx * gx + gy * gy + gz * gz);
    if (gl > 1e-12 && !(gy / gl < -Math.SQRT1_2)) { r.skipped += area; continue; }
    // Down from just under the face: the floor, or the model below when the field comes back to zero first.
    let y = cy - cellSize * 0.5, hitModel = false;
    for (let i = 0; i < 400 && y > floor; i++) {
      const s = d(cx, y, cz);
      if (s < hitEps) { hitModel = true; break; }
      y -= Math.max(s, cellSize * 0.05);
    }
    const bottom = hitModel ? y : floor;
    const hgt = Math.max(0, cy - bottom);
    const v = hgt * area;
    r.volume += v;
    r.area += area;
    if (hitModel) r.onModel += v;
    else r.fromFloor += v;
    if (hgt > r.tallest) { r.tallest = hgt; r.at = [cx, cy, cz]; r.foot = [cx, bottom, cz]; r.tallestOnModel = hitModel; }
  }
  return r;
}

/**
 * The support under a shape on its own, meshed at `resolution` cells on its longest side: what `support(shape)`
 * returns (its volume, in cubic model units) and what a failure of it says (the tallest column). The evaluation's
 * mesh when pieces(), overhang() or wall() already meshed the shape at this grid; empty for no surface.
 */
export function supportOf(shape: Shape3, resolution = 64, cache?: MeshCache): SupportResult {
  const res = Math.max(8, Math.round(resolution));
  const hit = SUPPORTS.get(shape)?.get(res);
  if (hit) return hit;
  const m = meshedAnalysis(shape, res, cache);
  const r = m ? supportVolume(shape, m.mesh, m.meshCell, m.physics.floor) : { volume: 0, fromFloor: 0, onModel: 0, area: 0, tallest: 0, skipped: 0 };
  const byRes = SUPPORTS.get(shape) ?? new Map<number, SupportResult>();
  byRes.set(res, r);
  SUPPORTS.set(shape, byRes);
  return r;
}

const SUPPORTS = new WeakMap<Shape3, Map<number, SupportResult>>();

export interface BedFit {
  /** The model's size on the plate (x, depth z) and its height (y), in millimetres. */
  size: Vec3;
  /** Fits as it stands, square to the bed. */
  fits: boolean;
  /**
   * When it does not fit square: the smallest turn about the vertical at which it does, if any, in degrees as
   * `rotate(y=)` turns (counter-clockwise seen from above, as a slicer turns about z), -89 to 90.
   */
  turned?: number;
  /** When it fits neither way standing: an axis that, turned up, makes it fit ("x" or "z" up: lying on its side). */
  lying?: { up: "x" | "z"; turned: number };
}

/**
 * The smallest turn at which a set of points on the plate fits w by d, tried 0, 1, -1, 2, -2 ... 90 degrees (a half
 * turn more is the same footprint), each as `rotate(y=deg)` turns (x, z); undefined when none does.
 */
function turnToFit(pts: [number, number][], w: number, dd: number): number | undefined {
  const hull = hull2(pts);
  if (!hull.length) return 0;
  for (let k = 0; k < 180; k++) {
    const deg = k === 0 ? 0 : k % 2 ? (k + 1) / 2 : -k / 2;
    const a = (deg * Math.PI) / 180, c = Math.cos(a), s = Math.sin(a);
    let x0 = Infinity, x1 = -Infinity, z0 = Infinity, z1 = -Infinity;
    for (const [x, z] of hull) {
      const u = x * c + z * s, v = -x * s + z * c;
      x0 = Math.min(x0, u); x1 = Math.max(x1, u); z0 = Math.min(z0, v); z1 = Math.max(z1, v);
    }
    if (x1 - x0 <= w && z1 - z0 <= dd) return deg;
  }
  return undefined;
}

/**
 * Whether a model fits a bed `bed` = [width, depth, height] in millimetres,
 * from its points (x, y, z per point, `mm` millimetres to the unit): square,
 * turned on the plate, or lying on a side. The footprint is the hull of the
 * points on the plate, so a round model turned 45 degrees is judged by its
 * own outline; given a box's eight corners it is judged by the box.
 */
export function bedFit(p: ArrayLike<number>, mm: number, bed: number[]): BedFit {
  const lo = [Infinity, Infinity, Infinity], hi = [-Infinity, -Infinity, -Infinity];
  for (let i = 0; i < p.length; i += 3) for (let k = 0; k < 3; k++) { lo[k] = Math.min(lo[k], p[i + k]); hi[k] = Math.max(hi[k], p[i + k]); }
  const size: Vec3 = [(hi[0] - lo[0]) * mm, (hi[2] - lo[2]) * mm, (hi[1] - lo[1]) * mm];
  const [W, D, H] = bed;
  const fits = size[0] <= W && size[1] <= D && size[2] <= H;
  const r: BedFit = { size, fits };
  if (fits) return r;
  const plate = (a: number, b: number): [number, number][] => {
    const out: [number, number][] = [];
    for (let i = 0; i < p.length; i += 3) out.push([p[i + a] * mm, p[i + b] * mm]);
    return out;
  };
  if (size[2] <= H) {
    const t = turnToFit(plate(0, 2), W, D);
    if (t !== undefined) { r.turned = t; return r; }
  }
  // Lying on its side: x up (the plate is z by y), or z up (the plate is x by y).
  for (const up of ["x", "z"] as const) {
    const k = up === "x" ? 0 : 2;
    if ((hi[k] - lo[k]) * mm > H) continue;
    const t = turnToFit(up === "x" ? plate(2, 1) : plate(0, 1), W, D);
    if (t !== undefined) { r.lying = { up, turned: t }; return r; }
  }
  return r;
}

/** The eight corners of a box, as bedFit takes points. */
export function boxCorners(min: ArrayLike<number>, max: ArrayLike<number>): number[] {
  const out: number[] = [];
  for (let i = 0; i < 8; i++) out.push(i & 1 ? max[0] : min[0], i & 2 ? max[1] : min[1], i & 4 ? max[2] : min[2]);
  return out;
}

/**
 * The thinnest wall of a shape on its own, meshed at `resolution` cells on its longest side: what `wall(shape)`
 * returns, in model units. 0 when the mesh has no surface at all (an empty shape, or one thinner than a cell
 * everywhere, which the mesh and so the print drop), with `empty` saying so: a promise of a wall then fails rather
 * than holding of nothing. Infinity when there is a surface but no ray found a far side.
 */
export function thinnestWall(shape: Shape3, resolution = 64, cache?: MeshCache): WallQuery {
  const res = Math.max(8, Math.round(resolution));
  const memo = WALLS.get(shape);
  const hit = memo?.get(res);
  if (hit) return hit;
  let r: WallQuery = { thickness: 0, empty: { cellSize: 0 } };
  if (!isEmpty(shape.bounds)) {
    // The evaluation's mesh when pieces() or overhang() already meshed this shape at this grid, so a program that
    // promises one piece and a wall meshes once.
    const shared = cache ? meshedAnalysis(shape, res, cache) : null;
    const nets = shared ? { mesh: shared.mesh, cellSize: shared.meshCell } : surfaceNets(shape, { resolution: res });
    if (nets.mesh.indices.length) {
      const w = wallThickness(shape, nets.mesh, nets.cellSize);
      r = w.thinnest ? { thickness: w.thinnest.thickness, at: w.thinnest.at, to: w.thinnest.to } : { thickness: Infinity };
    } else r = { thickness: 0, empty: { cellSize: nets.cellSize } };
  }
  // An assert asks twice, once for the number and once for where (its failure says), so the reading is kept.
  if (memo) memo.set(res, r);
  else WALLS.set(shape, new Map([[res, r]]));
  return r;
}

/** What `wall()` reads: the thickness, where, and whether there was no surface to measure (at that cell). */
export interface WallQuery {
  thickness: number;
  at?: Vec3;
  to?: Vec3;
  empty?: { cellSize: number };
}

const WALLS = new WeakMap<Shape3, Map<number, WallQuery>>();

/**
 * The area resting on the plate: faces within a cell and a half of the floor that face down within 25 degrees of
 * straight down, projected, in square model units. What holds the first layer to the bed.
 */
export function contactArea(mesh: Mesh, cellSize: number, floor: number): number {
  const p = mesh.positions, ix = mesh.indices;
  let area = 0;
  for (let t = 0; t < ix.length; t += 3) {
    const a = ix[t] * 3, b = ix[t + 1] * 3, c = ix[t + 2] * 3;
    if (Math.max(p[a + 1], p[b + 1], p[c + 1]) > floor + cellSize * 1.5) continue;
    const ux = p[b] - p[a], uy = p[b + 1] - p[a + 1], uz = p[b + 2] - p[a + 2];
    const vx = p[c] - p[a], vy = p[c + 1] - p[a + 1], vz = p[c + 2] - p[a + 2];
    const nx = uy * vz - uz * vy, ny = uz * vx - ux * vz, nz = ux * vy - uy * vx;
    const len = Math.sqrt(nx * nx + ny * ny + nz * nz);
    if (len > 0 && ny / len < -0.9) area += -ny / 2;
  }
  return area;
}
