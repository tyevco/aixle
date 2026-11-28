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
export function wallThickness(shape: Shape3, mesh: Mesh, cellSize: number, maxRays = 40000, welded?: Uint32Array): WallResult {
  const p = mesh.positions;
  const nv = p.length / 3;
  const empty: WallResult = { rays: 0, exits: 0, thicknesses: new Float32Array(0) };
  if (!nv || !(cellSize > 0)) return empty;
  // One ray per position: a crease's copies are welded to their first.
  const ix = welded ?? weldIndices(mesh);
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

/**
 * The longest bridge, in millimetres, that a print with supports switched off spans: past it, PrusaSlicer's own
 * stability check for such a print (SupportSpotsGenerator, bridge_distance) adds a support point to the line. Hubs
 * gives 5 mm as the span under which a bridge shows no sag at all; this is the span past which it fails.
 */
export const BRIDGE_MM = 16;

/**
 * A point overhang: a place on the underside lower than all the surface around it, off the plate, whose first layer
 * prints in the air whatever its faces' angles (Vanek, Galicia and Benes, 'Clever Support', SGP 2014, section 4): a
 * cone's tip hanging down, a keel whose faces are steeper than 45 degrees with its ends hanging free, a piece floating
 * free. A keel running level into a wall is a line overhang, not a point, and joins the wall at its own height: not one.
 */
export interface Island {
  /** Its lowest point, the top of the column it needs. */
  at: Vec3;
  /** Where that column lands, and whether on the model (else the plate). */
  foot: Vec3;
  onModel: boolean;
  /** The column's height. */
  height: number;
  /** How far it hangs: how much higher its part of the surface joins something lower (a floating piece: its own height). */
  depth: number;
}

export interface SupportResult {
  /**
   * The volume under the overhanging faces that need support, in cubic model units: an upper estimate of what a
   * slicer would fill, since it fills support sparsely. The bridged faces are not in it (see `bridged`).
   */
  volume: number;
  /** Of which standing on the floor, and on the model below. */
  fromFloor: number;
  onModel: number;
  /** Area of the overhanging faces that need support, projected on the plate, square model units. */
  area: number;
  /** The tallest column, where its face is, where it lands, and whether that is on the model (else the plate). */
  tallest: number;
  at?: Vec3;
  foot?: Vec3;
  tallestOnModel?: boolean;
  /**
   * The faces the tallest column stands on, when they are a sliver at a crease (at most eight faces needing support,
   * joined to no others, covering under a cell in plan, beside a face turned more than 60 degrees from them): what a
   * cutter's face laid exactly on the part's own leaves, which half a cell's move of the cutter clears. Their area on
   * the plate and how many.
   */
  sliver?: { area: number; faces: number };
  /**
   * Faces the mesh tilts past 45 degrees where the field does not face down that far, left out: at a sharp edge (a
   * cutter's corner laid on the part's own corner) dual contouring bends the faces next to the edge a few degrees,
   * and a ceiling at 40 degrees from vertical read as a 33 mm column of support (round 11). Their area on the plate.
   */
  skipped: number;
  /**
   * The volume under the bridged faces, which print without support across the span (with supports switched off; a
   * slicer with supports on and bridges not excluded fills them too), and their area on the plate.
   */
  bridged: number;
  bridgedArea: number;
  /** The longest line a bridged face is crossed by, from anchor to anchor, and where that face is. */
  longestBridge: number;
  bridgeAt?: Vec3;
  /** The span the bridges were held to, in model units. */
  span: number;
  /** The point overhangs that no face needing support stands over, lowest first. */
  islands: Island[];
}

/** Options for supportVolume. */
export interface SupportOptions {
  /**
   * The longest bridge, in model units: BRIDGE_MM over the millimetres in a unit (16 units when a unit is read as a
   * millimetre). 0 counts every overhang as needing support, as a slicer with supports on that bridges nothing does.
   */
  span?: number;
  /** The mesh's welded indices, when the caller has them (weldIndices). */
  welded?: Uint32Array;
  /** How far an island must hang, as a share of a cell (ISLAND_DEPTH), for measuring the rule. */
  islandDepth?: number;
}

/**
 * An island hangs more than this share of a cell clear of everything lower before its part of the surface joins it.
 * Measured on every example and print program (docs/design.md): the mesher's dips on a displaced or lettered
 * surface hang at most 0.16 of a cell (0.13 on the trophy's rim text), the cusps in the rope's channels between
 * strands 0.11 to 0.49 with two past it, real tips 12 to 135 cells (cones off a wall at 46 to 80 degrees, a cube on
 * its corner), and the smallest real ones met, a guitar's tuner buttons under their pegs, 0.52 and 0.84.
 */
const ISLAND_DEPTH = 0.5;

/**
 * Support under the faces that face down more than 45 degrees and are
 * clear of the floor (the faces the Overhangs row counts): from each face's
 * centre a ray straight down to the floor or the first surface below, its
 * length times the face's area projected on the plate. A face counts only
 * where the field faces down too, read at the face's centre: a face the
 * mesher bent at a sharp edge is not an overhang of the shape.
 *
 * Bridged faces are counted apart. The faces that face down are grouped
 * into regions, connected and level within half a cell, and each region is
 * crossed in one direction, as a slicer lays a bridge (PrusaSlicer's
 * BridgeDetector picks, per bridge, the direction whose lines are anchored
 * at both ends over the most length, whatever their length, ties going to
 * the shorter longest line): of four, 45 degrees apart, the one under which
 * the most area is anchored, ties to the shorter longest line, and only
 * then is a face bridged whose line that way is within `span`. A face is
 * anchored along a direction when, half a cell under it, a line each way
 * runs under the same ceiling (solid just above the face's height all
 * along) to solid that stands on something (solid a cell lower, straight
 * down or a cell on: a wall or a post, not the overhang's own underside
 * sloping down to meet the line). So a flat ceiling between walls is
 * bridged, and so is a slope closed at both ends along its level (a pitched
 * roof between gables, as PrusaSlicer takes a straight overhanging
 * perimeter that lands on the layer below at both ends), while a dome, a
 * cantilever and a slope or a horizontal hole open along its level are not.
 *
 * Islands are the point overhangs the faces miss: the lowest point of a
 * part of the surface that hangs more than half a cell clear of anything
 * lower before it joins it (the minima of height over the welded mesh that
 * persist, taking the vertices lowest first), facing down with the solid
 * above it (the faces two rings round, and the field), off the plate, and
 * not at a corner of a patch of faces needing support a cell or more in
 * plan (a hanging ball's underside has columns of its own).
 */
export function supportVolume(shape: Shape3, mesh: Mesh, cellSize: number, floor: number, opts: SupportOptions = {}): SupportResult {
  const p = mesh.positions, ix = mesh.indices;
  const span = Math.max(0, opts.span ?? BRIDGE_MM);
  const r: SupportResult = { volume: 0, fromFloor: 0, onModel: 0, area: 0, tallest: 0, skipped: 0, bridged: 0, bridgedArea: 0, longestBridge: 0, span, islands: [] };
  if (!(cellSize > 0) || !ix.length) return r;
  const d = shape.dist;
  const hitEps = cellSize * 0.1;
  const e = cellSize * 0.05;
  const off = floor + cellSize * 1.5;
  // Down from a point to the floor, or the model below when the field comes back to zero first: the bottom's y, with
  // landedOnModel saying which.
  let landedOnModel = false;
  const columnFoot = (x: number, y0: number, z: number): number => {
    let y = y0;
    for (let i = 0; i < 400 && y > floor; i++) {
      const s = d(x, y, z);
      if (s < hitEps) { landedOnModel = true; return y; }
      y -= Math.max(s, cellSize * 0.05);
    }
    landedOnModel = false;
    return floor;
  };

  // A face's unit normal, from its corners in the mesh's order (outward).
  const faceNormal = (t: number): [number, number, number] => {
    const a = ix[t] * 3, b = ix[t + 1] * 3, c = ix[t + 2] * 3;
    const ux = p[b] - p[a], uy = p[b + 1] - p[a + 1], uz = p[b + 2] - p[a + 2];
    const vx = p[c] - p[a], vy = p[c + 1] - p[a + 1], vz = p[c + 2] - p[a + 2];
    const nx = uy * vz - uz * vy, ny = uz * vx - ux * vz, nz = ux * vy - uy * vx;
    const l = Math.sqrt(nx * nx + ny * ny + nz * nz) || 1;
    return [nx / l, ny / l, nz / l];
  };

  // The overhanging faces, each with its centre, its area on the plate and its column.
  const tri: number[] = [], cxs: number[] = [], cys: number[] = [], czs: number[] = [], areas: number[] = [], feet: number[] = [], onModels: boolean[] = [];
  // How fast the ceiling rises along x and along z at each face, from the field: the surface's y goes up by g.e / |gy|
  // per unit along e.
  const rx: number[] = [], rz: number[] = [], y0s: number[] = [];
  for (let t = 0; t < ix.length; t += 3) {
    const a = ix[t] * 3, b = ix[t + 1] * 3, c = ix[t + 2] * 3;
    const ux = p[b] - p[a], uy = p[b + 1] - p[a + 1], uz = p[b + 2] - p[a + 2];
    const vx = p[c] - p[a], vy = p[c + 1] - p[a + 1], vz = p[c + 2] - p[a + 2];
    const nx = uy * vz - uz * vy, ny = uz * vx - ux * vz, nz = ux * vy - uy * vx;
    const len = Math.sqrt(nx * nx + ny * ny + nz * nz);
    if (!(len > 0)) continue;
    const top = Math.max(p[a + 1], p[b + 1], p[c + 1]);
    if (!(ny / len < -Math.SQRT1_2 && top > off)) continue;
    const cx = (p[a] + p[b] + p[c]) / 3, cy = (p[a + 1] + p[b + 1] + p[c + 1]) / 3, cz = (p[a + 2] + p[b + 2] + p[c + 2]) / 3;
    // Projected on the plate: half the cross product's y.
    const area = -ny / 2;
    const xp = d(cx + e, cy, cz), xm = d(cx - e, cy, cz), yq = d(cx, cy + e, cz), ym = d(cx, cy - e, cz), zp = d(cx, cy, cz + e), zm = d(cx, cy, cz - e);
    const gx = xp - xm, gy = yq - ym, gz = zp - zm;
    const gl = Math.sqrt(gx * gx + gy * gy + gz * gz);
    if (gl > 1e-12 && !(gy / gl < -Math.SQRT1_2)) { r.skipped += area; continue; }
    tri.push(t); cxs.push(cx); cys.push(cy); czs.push(cz); areas.push(area);
    rx.push(gl > 1e-12 ? gx / -gy : 0); rz.push(gl > 1e-12 ? gz / -gy : 0);
    // The ceiling's own height over the face's centre, a step of Newton's from the samples just taken: a face of a
    // feature a cell or two across sits a fraction of a cell off it (round 11's engraved word, at a 0.58 mm cell), and
    // the lines under it are run from the surface.
    const d0 = (xp + xm + yq + ym + zp + zm) / 6;
    y0s.push(gy < 0 ? cy + Math.max(-cellSize, Math.min(cellSize, (-2 * e * d0) / gy)) : cy);
    feet.push(columnFoot(cx, cy - cellSize * 0.5, cz)); onModels.push(landedOnModel);
  }
  const nf = tri.length;
  const welded = opts.welded ?? weldIndices(mesh);
  const nv = p.length / 3;

  // Regions: overhanging faces sharing a welded corner, at the same level within half a cell.
  const parent = new Int32Array(nf);
  for (let i = 0; i < nf; i++) parent[i] = i;
  const find = (i: number): number => { while (parent[i] !== i) { parent[i] = parent[parent[i]]; i = parent[i]; } return i; };
  {
    const byVertex = new Map<number, number[]>();
    for (let i = 0; i < nf; i++) for (let k = 0; k < 3; k++) {
      const v = welded[tri[i] + k];
      const list = byVertex.get(v);
      if (list) list.push(i); else byVertex.set(v, [i]);
    }
    const level = cellSize * 0.5;
    for (const list of byVertex.values()) for (let a = 1; a < list.length; a++) for (let b = 0; b < a; b++) {
      if (Math.abs(cys[list[a]] - cys[list[b]]) > level) continue;
      const ra = find(list[a]), rb = find(list[b]);
      if (ra !== rb) parent[ra] = rb;
    }
  }

  // Each face's line along four axes (eight directions), anchored at both ends at whatever length, Infinity where it is
  // not: a slicer picks a bridge's direction by what is anchored, not by what is short (the span is the printer's, and
  // the slicer does not know it), so the direction is chosen from these and the span applied after.
  const spans = new Float64Array(nf * 4).fill(Infinity);
  if (span > 0 && nf) {
    const bb = shape.bounds;
    const x0 = bb.min[0] - cellSize, x1 = bb.max[0] + cellSize, z0 = bb.min[2] - cellSize, z1 = bb.max[2] + cellSize;
    // No line in plan is longer than the model's diagonal.
    const longest = Math.hypot(x1 - x0, z1 - z0);
    const under = cellSize * 0.5, over = cellSize * 0.35, step = cellSize * 0.5;
    const DX = [1, Math.SQRT1_2, 0, -Math.SQRT1_2, -1, -Math.SQRT1_2, 0, Math.SQRT1_2], DZ = [0, Math.SQRT1_2, 1, Math.SQRT1_2, 0, -Math.SQRT1_2, -1, -Math.SQRT1_2];
    // Solid at the line's height that stands on something: solid a cell lower, straight down or a cell on (a wall, a
    // post, a wall leaning out up to 45 degrees), not the overhang's own underside sloping down to meet the line.
    const stands = (x: number, yp: number, z: number, ex: number, ez: number) => d(x, yp - cellSize, z) < 0 || d(x + ex * cellSize, yp - cellSize, z + ez * cellSize) < 0;
    // How far along direction `dir` (of DX, DZ) the line half a cell under the ceiling at height y0 runs to solid that
    // stands, under the same ceiling the whole way (solid just above y0); Infinity when it leaves the ceiling, runs
    // into the overhang's own underside, or goes past `limit` first. With `memo`, the faces of one level share what
    // a line reads, at points half a cell apart along it (a chamfer's row of faces marches along the same lines).
    const reach = (cx: number, y0: number, cz: number, dir: number, limit: number, memo?: Map<string, Map<number, number>>): number => {
      const ex = DX[dir], ez = DZ[dir], yp = y0 - under, yc = y0 + over;
      if (memo) {
        const axis = dir % 4, sign = dir < 4 ? 1 : -1, ax = DX[axis], az = DZ[axis];
        // The line by its axis and its offset across it, to a sixteenth of a cell (a face's row shares a few lines, and
        // a line moved a lattice's half-step across can leave a ceiling at its edge); the points along it by their step.
        const q = Math.round((-az * cx + ax * cz) / (cellSize / 16)), u = (q * cellSize) / 16, t0 = ax * cx + az * cz;
        const key = `${axis} ${q}`;
        let line = memo.get(key);
        if (!line) { line = new Map(); memo.set(key, line); }
        for (let n = Math.round(t0 / step) + sign; ; n += sign) {
          const t = n * step, s = Math.abs(t - t0);
          if (s > limit) return Infinity;
          const x = t * ax - u * az, z = t * az + u * ax;
          if (x < x0 || x > x1 || z < z0 || z > z1) return Infinity;
          // Kept at 4n: what is there; at 4n + 1 and 4n + 2, whether solid there stands, either way along the line
          // (the second test looks a cell on).
          let st = line.get(4 * n);
          if (st === undefined) { st = d(x, yp, z) < 0 ? 1 : d(x, yc, z) < 0 ? 0 : 2; line.set(4 * n, st); }
          if (st === 2) return Infinity;
          if (st === 1) {
            const k = 4 * n + (sign > 0 ? 1 : 2);
            let ok = line.get(k);
            if (ok === undefined) { ok = stands(x, yp, z, ex, ez) ? 1 : 0; line.set(k, ok); }
            return ok ? s : Infinity;
          }
        }
      }
      let ceilingUntil = 0;
      for (let s = step; s <= limit;) {
        const x = cx + ex * s, z = cz + ez * s;
        if (x < x0 || x > x1 || z < z0 || z > z1) return Infinity;
        const dq = d(x, yp, z);
        if (dq < 0) return stands(x, yp, z, ex, ez) ? s : Infinity;
        if (s >= ceilingUntil) {
          const dc = d(x, yc, z);
          if (!(dc < 0)) return Infinity;
          ceilingUntil = s - dc;
        }
        s += Math.max(dq, step);
      }
      return Infinity;
    };
    const march = (i: number, y0 = y0s[i], memo?: Map<string, Map<number, number>>) => {
      const cx = cxs[i], cz = czs[i];
      for (let k = 0; k < 4; k++) {
        // A ceiling rising along the line faster than `over` in a step leaves the band at the first step that way: no
        // span. Otherwise the rising way is marched first, which ends soonest when it is not level.
        const rise = rx[i] * DX[k] + rz[i] * DZ[k];
        if (Math.abs(rise) * step > over * 1.2) continue;
        const first = rise < 0 ? k + 4 : k;
        const fwd = reach(cx, y0, cz, first, longest, memo);
        if (fwd === Infinity) continue;
        const back = reach(cx, y0, cz, (first + 4) % 8, longest, memo);
        if (back !== Infinity) spans[i * 4 + k] = fwd + back;
      }
    };
    // A level ceiling of many faces (a lid's underside, a slab) is read once on a lattice half a cell apart at its
    // height, and each direction's reach swept across the lattice, where marching from every face would read the same
    // points over and over (a chest's lid at a 0.006 cell: 12 s).
    // A line under a ceiling ends within a step of the ceiling's region, at an anchor or where nothing is overhead, so
    // the lattice need reach no further than the region's faces and two cells.
    const raster = (list: number[], y0: number, region: number[]): boolean => {
      let ax0 = Infinity, ax1 = -Infinity, az0 = Infinity, az1 = -Infinity, rx0 = Infinity, rx1 = -Infinity, rz0 = Infinity, rz1 = -Infinity;
      for (const i of list) { ax0 = Math.min(ax0, cxs[i]); ax1 = Math.max(ax1, cxs[i]); az0 = Math.min(az0, czs[i]); az1 = Math.max(az1, czs[i]); }
      for (const i of region) { rx0 = Math.min(rx0, cxs[i]); rx1 = Math.max(rx1, cxs[i]); rz0 = Math.min(rz0, czs[i]); rz1 = Math.max(rz1, czs[i]); }
      const m = cellSize * 2;
      ax0 = Math.max(x0, rx0 - m); ax1 = Math.min(x1, rx1 + m); az0 = Math.max(z0, rz0 - m); az1 = Math.min(z1, rz1 + m);
      const ni = Math.floor((ax1 - ax0) / step) + 2, nj = Math.floor((az1 - az0) / step) + 2;
      if (ni * nj > 4e6) return false;
      // Marching costs about four lines a face, each as long as the ceiling; the lattice, its points.
      const far = Math.max(ax1 - ax0, az1 - az0) / step;
      if (list.length * 4 * far < ni * nj * 1.5) return false;
      const yp = y0 - under, yc = y0 + over;
      // 0: air under the ceiling, 1: solid at the line's height, 2: air with no ceiling over it (a line ends there).
      const state = new Uint8Array(ni * nj);
      for (let a = 0; a < ni; a++) for (let b = 0; b < nj; b++) {
        const x = ax0 + a * step, z = az0 + b * step;
        state[a * nj + b] = d(x, yp, z) < 0 ? 1 : d(x, yc, z) < 0 ? 0 : 2;
      }
      // Each face reads the lattice point nearest its centre that is under the ceiling.
      const node = new Int32Array(list.length).fill(-1);
      list.forEach((i, q) => {
        const a = Math.round((cxs[i] - ax0) / step), b = Math.round((czs[i] - az0) / step);
        let best = -1, bd = Infinity;
        for (let da = -1; da <= 1; da++) for (let db = -1; db <= 1; db++) {
          const aa = a + da, b2 = b + db;
          if (aa < 0 || b2 < 0 || aa >= ni || b2 >= nj || state[aa * nj + b2] !== 0) continue;
          const dd = (ax0 + aa * step - cxs[i]) ** 2 + (az0 + b2 * step - czs[i]) ** 2;
          if (dd < bd) { bd = dd; best = aa * nj + b2; }
        }
        node[q] = best;
      });
      const there = [new Float32Array(ni * nj), new Float32Array(ni * nj)];
      for (let k = 0; k < 4; k++) {
        for (const [w, dir] of [[0, k], [1, k + 4]] as const) {
          const R = there[w], ex = DX[dir], ez = DZ[dir];
          const da = Math.round(ex), db = Math.round(ez), len = da && db ? step * Math.SQRT2 : step;
          // Swept from the far end so that the next point along the line is read before the point itself.
          for (let a = da > 0 ? ni - 1 : 0; da > 0 ? a >= 0 : a < ni; a += da > 0 ? -1 : 1) for (let b = db > 0 ? nj - 1 : 0; db > 0 ? b >= 0 : b < nj; b += db > 0 ? -1 : 1) {
            const n = a * nj + b;
            if (state[n] !== 0) { R[n] = Infinity; continue; }
            const a2 = a + da, b2 = b + db;
            if (a2 < 0 || b2 < 0 || a2 >= ni || b2 >= nj) { R[n] = Infinity; continue; }
            const m = a2 * nj + b2;
            const v = state[m] === 1 ? (stands(ax0 + a2 * step, yp, az0 + b2 * step, ex, ez) ? len : Infinity) : state[m] === 2 ? Infinity : R[m] + len;
            R[n] = v;
          }
        }
        list.forEach((i, q) => {
          const n = node[q];
          if (n < 0) return;
          const sp = there[0][n] + there[1][n];
          if (sp < Infinity) spans[i * 4 + k] = sp;
        });
      }
      return true;
    };
    // The faces of each region taken by the height of their ceiling, in levels a tenth of a cell deep. The level faces
    // of a flat ceiling of many are swept on the lattice; the other faces of a level of many (a chamfer's row, a tilted
    // groove's) march on lines they share; a face with few others at its height marches on its own.
    const byRegion = new Map<number, number[]>();
    for (let i = 0; i < nf; i++) { const root = find(i), list = byRegion.get(root); if (list) list.push(i); else byRegion.set(root, [i]); }
    for (const faces of byRegion.values()) {
      faces.sort((a, b) => y0s[a] - y0s[b]);
      for (let lo = 0; lo < faces.length;) {
        let hi = lo + 1;
        while (hi < faces.length && y0s[faces[hi]] - y0s[faces[lo]] <= cellSize * 0.1) hi++;
        const list = faces.slice(lo, hi), level = (y0s[faces[lo]] + y0s[faces[hi - 1]]) / 2;
        lo = hi;
        // The level ones (a flat ceiling) swept together, the others in one plane (a chamfer, a tilted groove's
        // ceiling) or not (a ring of a curved underside, whose lines soon end) marched, on shared lines when many.
        const flat = list.filter((i) => Math.abs(rx[i]) + Math.abs(rz[i]) <= 0.1);
        const rest = flat.length >= 16 && raster(flat, level, faces) ? list.filter((i) => Math.abs(rx[i]) + Math.abs(rz[i]) > 0.1) : list;
        if (rest.length < 8) { for (const i of rest) march(i); continue; }
        const memo = new Map<string, Map<number, number>>();
        for (const i of rest) march(i, level, memo);
      }
    }
  }

  // Each region's direction, as PrusaSlicer's BridgeDetector picks it: the axis whose lines are anchored at both ends
  // under the most of its area, at any length, and of those within a hundredth of the region's area of the most, the
  // one whose longest line is shortest. Only then is the span applied: a bay walled on three sides and 18 wide is
  // crossed the short way, every line 18 long and none bridged, not on a diagonal that is short in its back corners.
  const regionAxis = new Map<number, number>();
  {
    const stats = new Map<number, Float64Array>(); // per region: total area, then anchored area and longest line per axis
    for (let i = 0; i < nf; i++) {
      const root = find(i);
      let st = stats.get(root);
      if (!st) { st = new Float64Array(9); stats.set(root, st); }
      st[0] += areas[i];
      for (let k = 0; k < 4; k++) {
        const sp = spans[i * 4 + k];
        if (sp === Infinity) continue;
        st[1 + k] += areas[i];
        st[5 + k] = Math.max(st[5 + k], sp);
      }
    }
    for (const [root, st] of stats) {
      const most = Math.max(st[1], st[2], st[3], st[4]);
      if (!(most > 0)) continue;
      let best = -1;
      for (let k = 0; k < 4; k++) if (st[1 + k] >= most - st[0] * 0.01 && (best < 0 || st[5 + k] < st[5 + best])) best = k;
      regionAxis.set(root, best);
    }
  }

  // The split: bridged along its region's direction, or needing support.
  const needs = new Uint8Array(nf);
  let tallestFace = -1;
  for (let i = 0; i < nf; i++) {
    const cy = cys[i], bottom = feet[i];
    const hgt = Math.max(0, cy - bottom);
    const v = hgt * areas[i];
    const axis = regionAxis.get(find(i));
    const sp = axis === undefined ? Infinity : spans[i * 4 + axis];
    if (sp <= span) {
      r.bridged += v;
      r.bridgedArea += areas[i];
      if (sp > r.longestBridge) { r.longestBridge = sp; r.bridgeAt = [cxs[i], cy, czs[i]]; }
      continue;
    }
    needs[i] = 1;
    r.volume += v;
    r.area += areas[i];
    if (onModels[i]) r.onModel += v;
    else r.fromFloor += v;
    if (hgt > r.tallest) { r.tallest = hgt; r.at = [cxs[i], cy, czs[i]]; r.foot = [cxs[i], bottom, czs[i]]; r.tallestOnModel = onModels[i]; tallestFace = i; }
  }

  // The faces needing support joined where they share a corner, whatever their level: a curved underside is one patch.
  // A patch under a cell in plan is a sliver, for the note on the tallest column; one of a cell or more holds up an
  // island at its corner (a ball's underside has support of its own).
  const patch = new Int32Array(nf).fill(-1);
  {
    const firstAt = new Map<number, number>();
    for (let i = 0; i < nf; i++) {
      if (!needs[i]) continue;
      patch[i] = i;
      for (let k = 0; k < 3; k++) {
        const v = welded[tri[i] + k], j = firstAt.get(v);
        if (j === undefined) { firstAt.set(v, i); continue; }
        let a = i, b = j;
        while (patch[a] !== a) a = patch[a] = patch[patch[a]];
        while (patch[b] !== b) b = patch[b] = patch[patch[b]];
        if (a !== b) patch[a] = b;
      }
    }
  }
  const patchOf = (i: number): number => { while (patch[i] !== i) i = patch[i] = patch[patch[i]]; return i; };
  const patchArea = new Map<number, { area: number; faces: number }>();
  for (let i = 0; i < nf; i++) {
    if (!needs[i]) continue;
    const root = patchOf(i), st = patchArea.get(root);
    if (st) { st.area += areas[i]; st.faces++; } else patchArea.set(root, { area: areas[i], faces: 1 });
  }
  const sliverArea = cellSize * cellSize;
  if (tallestFace >= 0) {
    const root = patchOf(tallestFace), st = patchArea.get(root)!;
    if (st.faces <= 8 && st.area < sliverArea) {
      // At a crease: a face meeting the patch at a corner turns more than 60 degrees from it (a curve's facets and a
      // displaced skin's bumps turn a few degrees face to face).
      const corners = new Set<number>();
      let mx = 0, my = 0, mz = 0;
      for (let i = 0; i < nf; i++) if (needs[i] && patchOf(i) === root) {
        const n = faceNormal(tri[i]);
        mx += n[0]; my += n[1]; mz += n[2];
        for (let k = 0; k < 3; k++) corners.add(welded[tri[i] + k]);
      }
      const ml = Math.hypot(mx, my, mz) || 1;
      let crease = false;
      for (let t = 0; t < welded.length && !crease; t += 3) {
        if (!corners.has(welded[t]) && !corners.has(welded[t + 1]) && !corners.has(welded[t + 2])) continue;
        const n = faceNormal(t);
        if ((n[0] * mx + n[1] * my + n[2] * mz) / ml < 0.5) crease = true;
      }
      if (crease) r.sliver = { area: st.area, faces: st.faces };
    }
  }

  // Islands: the minima of height over the welded mesh that persist, each the lowest point of a part of the surface
  // that hangs clear of everything lower by more than ISLAND_DEPTH of a cell before it joins it (the merge tree,
  // vertices taken lowest first). A tip's own vertex is no use alone: the mesher puts a neighbour within a hundredth
  // of a cell of a cone's tip at some grids and half a cell above it at others (measured, docs/design.md).
  const held = new Uint8Array(nv); // a corner of a face needing support in a patch of a cell or more in plan
  for (let i = 0; i < nf; i++) if (needs[i] && patchArea.get(patchOf(i))!.area >= sliverArea) for (let k = 0; k < 3; k++) held[welded[tri[i] + k]] = 1;
  // The welded vertices' neighbours, and the y of their faces' normals summed (negative facing down).
  const deg = new Int32Array(nv + 1), down = new Float64Array(nv), used = new Uint8Array(nv);
  for (let t = 0; t < welded.length; t += 3) {
    const a = welded[t], b = welded[t + 1], c = welded[t + 2];
    deg[a] += 2; deg[b] += 2; deg[c] += 2;
    used[a] = used[b] = used[c] = 1;
    const A = a * 3, B = b * 3, C = c * 3;
    const ny = (p[B + 2] - p[A + 2]) * (p[C] - p[A]) - (p[B] - p[A]) * (p[C + 2] - p[A + 2]);
    down[a] += ny; down[b] += ny; down[c] += ny;
  }
  const start = new Int32Array(nv + 1);
  for (let v = 0; v < nv; v++) start[v + 1] = start[v] + deg[v];
  const fill = start.slice(0, nv), nb = new Int32Array(start[nv]);
  for (let t = 0; t < welded.length; t += 3) {
    const a = welded[t], b = welded[t + 1], c = welded[t + 2];
    nb[fill[a]++] = b; nb[fill[a]++] = c; nb[fill[b]++] = a; nb[fill[b]++] = c; nb[fill[c]++] = a; nb[fill[c]++] = b;
  }
  const order: number[] = [];
  for (let v = 0; v < nv; v++) if (used[v]) order.push(v);
  order.sort((u, w) => p[u * 3 + 1] - p[w * 3 + 1] || u - w);
  const up = new Int32Array(nv).fill(-1), lowestOf = new Int32Array(nv), size = new Int32Array(nv);
  const topOf = new Float64Array(nv);
  const findU = (i: number): number => { while (up[i] !== i) { up[i] = up[up[i]]; i = up[i]; } return i; };
  const depth = cellSize * (opts.islandDepth ?? ISLAND_DEPTH);
  const minima: [number, number][] = []; // the lowest vertex of a part that joined something lower, and how far it hung
  for (const v of order) {
    let root = -1;
    for (let k = start[v]; k < start[v + 1]; k++) {
      const w = nb[k];
      if (up[w] < 0) continue;
      const rw = findU(w);
      if (root < 0) { root = rw; continue; }
      if (rw === root) continue;
      // Two parts meet at v: the one whose lowest point is higher ends here, having hung v's height above it.
      const [elder, younger] = p[lowestOf[rw] * 3 + 1] < p[lowestOf[root] * 3 + 1] ? [rw, root] : [root, rw];
      minima.push([lowestOf[younger], p[v * 3 + 1] - p[lowestOf[younger] * 3 + 1]]);
      up[younger] = elder;
      size[elder] += size[younger];
      root = elder;
    }
    if (root < 0) { up[v] = v; lowestOf[v] = v; root = v; } else up[v] = root;
    size[root]++;
    topOf[root] = p[v * 3 + 1];
  }
  // What never joined anything lower: each piece's lowest point, a floating piece's off the plate, hanging its own
  // height; a speck of a few dozen vertices (a sliver a cut left, which the Pieces row tells of) is not one.
  for (const v of order) if (up[v] === v && size[v] >= 32) minima.push([v, topOf[v] - p[v * 3 + 1]]);
  for (const [v, hung] of minima) {
    const o = v * 3, x = p[o], y = p[o + 1], z = p[o + 2];
    if (!(hung > depth) || !(y > off) || held[v]) continue;
    // Facing down, with the solid above it: a bowl's inner floor is a minimum too, facing up. Read on the faces two
    // rings round, not the vertex's own: at a sharp tip the mesher can fold its last three faces to face up (a cone
    // at 80 degrees sunk 1 into a wall, at 112 to 176 cells), while the ring beyond faces down. And the field must
    // fall going up from it, which a pit in a crease the mesh dips into does not; read upward only, since a piece
    // floating a fraction of a cell over a floor (round 11's cable in its groove) has that floor just under it.
    let ring = down[v];
    for (let k = start[v]; k < start[v + 1]; k++) ring += down[nb[k]];
    if (!(ring < 0) || !(d(x, y + cellSize * 0.5, z) < d(x, y, z))) continue;
    // The column starts clear of the island's own tip, which the mesh's vertex can sit a fraction of a cell above.
    let y1 = y - cellSize * 0.5;
    for (let n = 0; n < 8 && d(x, y1, z) < cellSize * 0.25; n++) y1 -= cellSize * 0.25;
    const bottom = columnFoot(x, y1, z);
    r.islands.push({ at: [x, y, z], foot: [x, bottom, z], onModel: landedOnModel, height: Math.max(0, y - bottom), depth: hung });
  }
  r.islands.sort((a, b) => a.at[1] - b.at[1]);
  return r;
}

/**
 * The support under a shape on its own, meshed at `resolution` cells on its longest side: what `support(shape)`
 * returns (the volume needing support, in cubic model units) and `islands(shape)` counts, and what a failure of
 * either says (the tallest column, the islands' places). `span` is the longest bridge in model units. The
 * evaluation's mesh when pieces(), overhang() or wall() already meshed the shape at this grid; empty for no surface.
 */
export function supportOf(shape: Shape3, resolution = 64, cache?: MeshCache, span = BRIDGE_MM): SupportResult {
  const res = Math.max(8, Math.round(resolution));
  const key = `${res} ${span}`;
  const hit = SUPPORTS.get(shape)?.get(key);
  if (hit) return hit;
  const m = meshedAnalysis(shape, res, cache);
  const r = m ? supportVolume(shape, m.mesh, m.meshCell, m.physics.floor, { span }) : { volume: 0, fromFloor: 0, onModel: 0, area: 0, tallest: 0, skipped: 0, bridged: 0, bridgedArea: 0, longestBridge: 0, span, islands: [] };
  const byKey = SUPPORTS.get(shape) ?? new Map<string, SupportResult>();
  byKey.set(key, r);
  SUPPORTS.set(shape, byKey);
  return r;
}

const SUPPORTS = new WeakMap<Shape3, Map<string, SupportResult>>();

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
