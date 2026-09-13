/**
 * The 3D primitives. Every one is centred on the origin, and anything with an
 * axis stands along y. Distance formulas are the standard exact ones (Inigo
 * Quilez's catalogue), so booleans built on them stay exact.
 */
import { length2, length3, type Vec3 } from "../core/vec.js";
import { DEFAULT_MATERIAL } from "./materials.js";
import { EMPTY_BOUNDS, FAR, type Bounds, type DistFn3, type Shape3 } from "./types.js";

/** Wrap a distance function as a shape with the default material and `bounds`. */
export function primitive(dist: DistFn3, bounds: Bounds, cost = 1): Shape3 {
  return {
    kind: "shape3",
    dist,
    hit: (x, y, z) => ({ d: dist(x, y, z), mat: DEFAULT_MATERIAL, lx: x, ly: y, lz: z }),
    bounds,
    cost,
  };
}

const symmetric = (hx: number, hy: number, hz: number): Bounds => ({ min: [-hx, -hy, -hz], max: [hx, hy, hz] });

export function empty(): Shape3 {
  return primitive(() => FAR, EMPTY_BOUNDS, 0);
}

export function sphere(r: number): Shape3 {
  return primitive((x, y, z) => length3(x, y, z) - r, symmetric(r, r, r));
}

/** A box `w` wide (x), `h` tall (y), `d` deep (z), edges rounded by `round`. */
export function box(w: number, h: number, d: number, round = 0): Shape3 {
  const hx = Math.max(w / 2 - round, 0), hy = Math.max(h / 2 - round, 0), hz = Math.max(d / 2 - round, 0);
  const out = primitive((x, y, z) => {
    const qx = Math.abs(x) - hx, qy = Math.abs(y) - hy, qz = Math.abs(z) - hz;
    const ox = Math.max(qx, 0), oy = Math.max(qy, 0), oz = Math.max(qz, 0);
    return length3(ox, oy, oz) + Math.min(Math.max(qx, Math.max(qy, qz)), 0) - round;
  }, symmetric(w / 2, h / 2, d / 2));
  // A box's thinnest side is a feature it carries into any union, so a slat inside a library's bench is judged
  // against the cell like a wall is (round 6: a bench's 0.03 slats under a 0.039 cell drew no warning and left a
  // loose sliver). Only when clearly flat: a cube is not a wall.
  const thin = Math.min(w, h, d), thick = Math.max(w, h, d);
  if (thin > 0 && thin < thick * 0.25) out.feature = thin;
  return out;
}

/** A cylinder of radius `r` and height `h` along y, edges rounded by `round`. */
export function cylinder(r: number, h: number, round = 0): Shape3 {
  const rr = Math.max(r - round, 0), hh = Math.max(h / 2 - round, 0);
  const out = primitive((x, y, z) => {
    const dx = length2(x, z) - rr, dy = Math.abs(y) - hh;
    return Math.min(Math.max(dx, dy), 0) + length2(Math.max(dx, 0), Math.max(dy, 0)) - round;
  }, symmetric(r, h / 2, r));
  // A disc much thinner than it is wide is a plate, a rod much longer than it is wide is a tube; see box.
  const thin = Math.min(2 * r, h), thick = Math.max(2 * r, h);
  if (thin > 0 && thin < thick * 0.25) out.feature = thin;
  return out;
}

/** A cone (frustum) of height `h` along y: radius `r1` at the bottom, `r2` at the top. */
export function cone(r1: number, r2: number, h: number): Shape3 {
  const hh = h / 2;
  const ra = r1, rb = r2;
  const out = primitive((x, y, z) => {
    // Quilez's capped cone, radius ra at y=-hh and rb at y=+hh.
    const qx = length2(x, z), qy = y;
    const k1x = rb, k1y = hh;
    const k2x = rb - ra, k2y = 2 * hh;
    const cax = qx - Math.min(qx, qy < 0 ? ra : rb), cay = Math.abs(qy) - hh;
    const t = Math.max(0, Math.min(1, ((k1x - qx) * k2x + (k1y - qy) * k2y) / (k2x * k2x + k2y * k2y)));
    const cbx = qx - k1x + k2x * t, cby = qy - k1y + k2y * t;
    const s = cbx < 0 && cay < 0 ? -1 : 1;
    return s * Math.sqrt(Math.min(cax * cax + cay * cay, cbx * cbx + cby * cby));
  }, symmetric(Math.max(r1, r2), hh, Math.max(r1, r2)));  // A spike much longer than it is wide is a rod, a flat frustum a disc; judged by its wider end, like a tapered tube.
  const thin = Math.min(2 * Math.max(r1, r2), h), thick = Math.max(2 * Math.max(r1, r2), h);
  if (thin > 0 && thin < thick * 0.25) out.feature = thin;
  return out;
}

/** A capsule of radius `r` and total height `h` (caps included) along y. */
export function capsule(r: number, h: number): Shape3 {
  const seg = Math.max(h / 2 - r, 0);
  return primitive((x, y, z) => {
    const cy = Math.max(-seg, Math.min(seg, y));
    return length3(x, y - cy, z) - r;
  }, symmetric(r, seg + r, r));
}

/** A torus lying flat: ring radius `R` around y, tube radius `r`. */
export function torus(R: number, r: number): Shape3 {
  return primitive((x, y, z) => length2(length2(x, z) - R, y) - r, symmetric(R + r, r, R + r));
}

export function ellipsoid(rx: number, ry: number, rz: number): Shape3 {
  return primitive((x, y, z) => {
    const k0 = length3(x / rx, y / ry, z / rz);
    const k1 = length3(x / (rx * rx), y / (ry * ry), z / (rz * rz));
    return k1 === 0 ? -Math.min(rx, ry, rz) : (k0 * (k0 - 1)) / k1;
  }, symmetric(rx, ry, rz));
}

export function octahedron(s: number): Shape3 {
  return primitive((x, y, z) => {
    const px = Math.abs(x), py = Math.abs(y), pz = Math.abs(z);
    const m = px + py + pz - s;
    let qx: number, qy: number, qz: number;
    if (3 * px < m) { qx = px; qy = py; qz = pz; }
    else if (3 * py < m) { qx = py; qy = pz; qz = px; }
    else if (3 * pz < m) { qx = pz; qy = px; qz = py; }
    else return m * 0.57735027;
    const k = Math.max(0, Math.min(s, 0.5 * (qz - qy + s)));
    return length3(qx, qy - s + k, qz - k);
  }, symmetric(s, s, s));
}

/** A regular `sides`-gon of circumradius `r`, extruded to height `h` along y, one flat facing +z. */
export function prism(sides: number, r: number, h: number): Shape3 {
  const n = Math.max(3, Math.round(sides));
  const hh = h / 2;
  // Distance to the polygon is the max over its edge half-planes when inside the
  // polygon's angular sector, so use the exact fold: rotate into one sector.
  const sector = Math.PI / n;
  const apothem = r * Math.cos(sector);
  return primitive((x, y, z) => {
    let a = Math.atan2(x, z);
    a = ((a % (2 * sector)) + 2 * sector + sector) % (2 * sector) - sector;
    const rr = length2(x, z);
    const px = rr * Math.sin(a), pz = rr * Math.cos(a);
    // In the sector the nearest edge is the flat at z = apothem, |x| <= r*sin(sector).
    const ex = Math.max(Math.abs(px) - r * Math.sin(sector), 0);
    const ez = pz - apothem;
    const d2 = ez > 0 ? length2(ex, ez) : ez;
    const dy = Math.abs(y) - hh;
    return Math.min(Math.max(d2, dy), 0) + length2(Math.max(d2, 0), Math.max(dy, 0));
  }, symmetric(r, hh, r));
}

/** A plane-bounded slab of the whole space above y = 0, clipped to `size` so it has bounds. */
export function halfspace(size: number): Shape3 {
  return primitive((x, y, z) => Math.max(-y, Math.abs(x) - size, Math.abs(z) - size, y - size), {
    min: [-size, 0, -size],
    max: [size, size, size],
  });
}

export const primitiveNames: string[] = [
  "sphere", "box", "cylinder", "cone", "capsule", "torus", "ellipsoid", "octahedron", "prism", "halfspace", "empty",
];

export type { Vec3 };
