/**
 * Secondary rays for the beauty render: what a reflection sees, whether a light reaches a point, how much of a
 * light's disc it sees, and how far a refracted ray travels inside glass.
 *
 * Every ray marches the field for its first NEAR (3 cells), where the extracted mesh is least trustworthy (the surface
 * the ray left, creases, contact with the floor). Beyond that the mesh's BVH skips empty space: a shadow ray asks it
 * whether any opaque triangle lies ahead, and a ray that must see something asks it for the closest triangle and then
 * marches the field over a window of 3 cells either side of it, as the primary ray is primed, so every hit the kernel
 * shades has the field's position, normal and material. Glass is never answered by the mesh: a shadow ray crossing it
 * finds the solid's entry on the field and measures its length with the inside march, which gives Beer's law per
 * channel; a reflection that meets glass returns the field's point for the kernel to shade.
 *
 * Pure and deterministic: no file system, no process, no randomness. The area-light rays are stratified over the
 * light's disc and placed by a fixed pattern of the pixel, the light and the subsample (diskPattern), so every value
 * is a function of its arguments alone and a render's bytes cannot depend on which thread drew which row. Nothing here
 * allocates except the shape's own hit(), which the glass paths call.
 */
import type { Mesh } from "../mesh/mesh.js";
import { boundsGrow, type Bounds, type Material, type Shape3 } from "../sdf/types.js";
import { ALL, BvhTracer, GLASS, OPAQUE, type BvhData } from "./bvh.js";
import { BEER, MAX_LIGHT_ANGLE } from "./photometry.js";

/** Cells every secondary ray marches the field before the BVH takes over. */
export const NEAR_CELLS = 3;
/** Cells the model's box is grown by to clip every secondary ray. */
export const BOX_CELLS = 2;
/** Area-light rays per light: four on the outer half of the disc's area, four on the inner. */
export const AREA_RAYS = 8;
/** The widest angular radius a directional light's disc is given, in radians: just short of a right angle. */
const MAX_ANGLE = MAX_LIGHT_ANGLE;

/** A hashed uniform in [0, 1) from two integers (murmur-style finaliser). */
export function hash01(a: number, b: number): number {
  let h = Math.imul(a ^ 0x9e3779b9, 0x85ebca6b) ^ Math.imul((b + 0x632be5ab) | 0, 0xc2b2ae35);
  h = Math.imul(h ^ (h >>> 16), 0x7feb352d);
  h = Math.imul(h ^ (h >>> 15), 0x846ca68b);
  h ^= h >>> 16;
  return (h >>> 0) / 4294967296;
}

/**
 * Where a pixel's area-light rays fall on the light's disc, from the pixel (x, y), the light and the subsample (0
 * the pixel's centre, 1 to 4 an edge pixel's quarter offsets), into out: the rotation (a fraction of a turn) and the
 * two rings' radius offsets, each in [0, 1).
 *
 * The rotation is interleaved gradient noise over the pixel grid (transposed, so it does not follow the dither's,
 * which is the same noise the other way round) and the offsets an R2 lattice over it, each shifted by a hash of the
 * light and the subsample. Neighbouring pixels so take well-spread rotations, and the visibility filter, which averages
 * them, is left with less to smooth: measured through it against 24 times the rays (tools/rays-bench.ts, noise), a
 * penumbra on the medal's floor at 768 keeps 3.0 levels of noise against 3.6 for a hash per pixel, the teapot's 2.0
 * against 2.5, and the cube's (192 px) 4.9 and 3.9 against 5.8 and 5.4. Every value is a function of its arguments.
 */
export function diskPattern(x: number, y: number, light: number, sub: number, out: Float64Array): void {
  const sh = hash01(sub * 131 + light, 0x51ed);
  const g = 52.9829189 * ((0.06711056 * y + 0.00583715 * x) % 1);
  let r = g - Math.floor(g) + sh;
  out[0] = r - Math.floor(r);
  r = 0.5 + x * 0.7548776662466927 + y * 0.5698402909980532 + sh * 1.7;
  out[1] = r - Math.floor(r);
  r = 0.5 + x * 0.5698402909980532 + y * 0.7548776662466927 + sh * 2.3;
  out[2] = r - Math.floor(r);
}

/** The soft march's constant for a light of angular radius `angle` (radians): its penumbra reaches full light at that angle. */
export function softnessFor(angle: number): number {
  return 1 / Math.max(angle, 1e-3);
}

/** A light as the rays see it. Plain numbers, so the kernel can keep one per light and never allocate. */
export interface RayLight {
  /** A point light: x, y, z is its position. A directional light: x, y, z is the unit direction towards it. */
  point: boolean;
  x: number;
  y: number;
  z: number;
  /** A directional light's angular radius in radians (photometry.lightAngle(size)); a point light's sphere radius in model units (photometry.pointRadius(size, range)). */
  radius: number;
  /** Which light this is: two lights at one pixel take different rotations. */
  index: number;
}

/** Counters, read only by tools: they cost an increment each and never change an answer. */
export interface RayStats {
  /** closest() calls; answered by the field's near march; by the BVH; confirmed on the field; trusted from the mesh. */
  closest: number;
  nearHits: number;
  bvhHits: number;
  confirmed: number;
  trusted: number;
  /** Field evaluations in near marches (every kind of ray) and in confirmation windows. */
  nearSteps: number;
  windowSteps: number;
  /** occlusion() and areaVisibility() calls; rays areaVisibility traced beyond NEAR; calls the cone test answered alone. */
  occlusion: number;
  area: number;
  areaRays: number;
  earlyOut: number;
  /** Shadow rays handed to the BVH beyond NEAR; glass solids crossed by shadow rays. */
  farRays: number;
  glassSegments: number;
  /** insideMarch() calls and their field evaluations; hit() calls made here. */
  inside: number;
  insideSteps: number;
  hits: number;
}

export interface RayOptions {
  /** Some material lets light through: the shadow march must ask hit() what it met. Default: some material of the mesh does. */
  glass?: boolean;
}

export interface Rays {
  readonly cell: number;
  /** NEAR in model units. */
  readonly near: number;
  /** The model's box grown by BOX_CELLS: every ray is clipped to it. */
  readonly box: Bounds;
  readonly reach: number;
  readonly glass: boolean;
  readonly tracer: BvhTracer;
  /** Per-channel transmittance of the last occlusion() or areaVisibility(). */
  readonly vis: Float64Array;
  /** Per-channel absorption (sigma times length) of the last insideMarch(). */
  readonly abs: Float64Array;
  readonly stats: RayStats;
  /** How the last closest() was answered: 0 a miss, 1 the near march, 2 confirmed on the field, 3 trusted from the mesh. */
  how: number;
  /**
   * The first surface along the ray within tMax, as the field has it: its distance, or -1 for none. The caller has
   * lifted the origin off its surface (a reflection leaves 2 cells along the normal).
   */
  closest(ox: number, oy: number, oz: number, dx: number, dy: number, dz: number, tMax: number): number;
  /**
   * How much light reaches o from along unit L within tMax, per channel into `vis`; returns their mean. `softness`
   * is the near march's penumbra constant (softnessFor(angle)), 0 for a hard test. The caller has lifted o off its
   * surface (a cell along the normal, as today).
   */
  occlusion(ox: number, oy: number, oz: number, lx: number, ly: number, lz: number, tMax: number, softness: number): number;
  /**
   * The fraction of a light's disc (directional) or sphere (point) that p sees, per channel into `vis` (coloured glass
   * tints it); returns their mean. p is lifted off its surface, as for occlusion(). (x, y) is the pixel and `sub` its
   * subsample, which place the rays on the disc (diskPattern). `rays` is 8, at most 8. `earlyOut` (on by default)
   * answers without them when no triangle can meet the cone they span: exactly what all eight would say.
   */
  areaVisibility(px: number, py: number, pz: number, light: RayLight, x: number, y: number, sub?: number, rays?: number, earlyOut?: boolean): number;
  /**
   * From o just inside a solid along d to where it is left: the exit's distance, or -1. `abs` gets sigma times
   * length per channel, Beer's law being exp(-abs). `entry` is the material the ray went in through.
   */
  insideMarch(ox: number, oy: number, oz: number, dx: number, dy: number, dz: number, entry: Material): number;
  /** The field-only answer closest() stands in for: the same march over the whole ray, up to `steps` steps. For tools and tests. */
  fieldClosest(ox: number, oy: number, oz: number, dx: number, dy: number, dz: number, tMax: number, steps?: number): number;
  /**
   * The field-only answer occlusion() stands in for: its near march over the whole ray (today's shadow march, whose
   * steps are at least `minStep` cells, 0.5), up to `steps` steps (today's 64), into `vis`. For tools and tests.
   */
  fieldOcclusion(ox: number, oy: number, oz: number, lx: number, ly: number, lz: number, tMax: number, softness: number, minStep?: number, steps?: number): number;
  /** occlusion()'s part beyond the near march alone: the BVH and the glass from `from` to `to`, into `vis`. For tools. */
  beyond(ox: number, oy: number, oz: number, lx: number, ly: number, lz: number, from: number, to: number): number;
}

/**
 * Secondary rays for one shape and its mesh. `bvh` is the mesh's (bvhFor), `cell` the extraction's cell, `box` the
 * model's box (the reach bounds when a shot is framed on a part), `reach` the beauty render's (1.5 times the box's
 * diagonal), which scales Beer's law. One per thread: the scratch and the last answers live on it.
 *
 * The public calls take their ray as numbers and are small enough for V8 to inline where they are called; the work is
 * done by inner functions that pass rays and distances in Float64Array registers and return small integers, since a
 * number passed to or returned from a call V8 does not inline is a boxed heap number, and a number kept in a variable
 * these closures share is boxed on every assignment.
 */
export function createRays(shape: Shape3, mesh: Mesh, bvh: BvhData, cell: number, box: Bounds, reach: number, opts: RayOptions = {}): Rays {
  const dist = shape.dist;
  const tracer = new BvhTracer(bvh);
  const glass = opts.glass ?? (bvh.anyGlass || mesh.materials.some((m) => m.transmit > 0));
  const near = NEAR_CELLS * cell;
  const hitEps = cell * 0.05;
  const grown = boundsGrow(box, cell * BOX_CELLS);
  const bx0 = grown.min[0], by0 = grown.min[1], bz0 = grown.min[2], bx1 = grown.max[0], by1 = grown.max[1], bz1 = grown.max[2];
  const vis = new Float64Array(3);
  const abs = new Float64Array(3);
  const stats: RayStats = { closest: 0, nearHits: 0, bvhHits: 0, confirmed: 0, trusted: 0, nearSteps: 0, windowSteps: 0, occlusion: 0, area: 0, areaRays: 0, earlyOut: 0, farRays: 0, glassSegments: 0, inside: 0, insideSteps: 0, hits: 0 };
  const sigmaOf = (m: Material, c: number): number => (m.transmit > 0 ? (BEER * (1 - m.color[c])) / reach : 8 / reach);

  // Registers. RY: the ray of closest() and occlusion(), and areaVisibility()'s centre ray: origin, direction, unused,
  // tMax. FR: one far shadow ray: origin, direction, from, to. IR: an inside march's origin and direction, then its
  // exit. AP: areaVisibility()'s point. ST: what the inner functions leave: [0] the last clip's entry, [1] its exit,
  // [2] where a near march stopped, [3] closest()'s distance, [4] the near march's penumbra term, [5] its limit (the
  // light's distance), [6] its softness, [7] how far it marches (NEAR, or the whole ray for the reference), [8] its
  // least step. WN: a window march's from, to and answer. XG: a glass crossing's entry and exit distances along the
  // ray it is given. FT: one far ray's transmittance. OUT, SUM: the area rays' sums on the disc's outer and inner
  // halves. DP: diskPattern's answer.
  const RY = new Float64Array(8), FR = new Float64Array(8), IR = new Float64Array(8), AP = new Float64Array(3);
  const ST = new Float64Array(9), WN = new Float64Array(3), XG = new Float64Array(2);
  const FT = new Float64Array(3), SUM = new Float64Array(3), OUT = new Float64Array(3), DP = new Float64Array(3);
  const TR = tracer.ray, TH = tracer.hit;

  /** The ray in `reg` (origin, direction, [7] tMax) against the grown box: ST[0], ST[1] its entry and exit within [0, tMax]; false when it misses. */
  function clip(reg: Float64Array): boolean {
    const ox = reg[0], oy = reg[1], oz = reg[2];
    let t0 = 0, t1 = reg[7];
    let ia = 1 / reg[3], a = (bx0 - ox) * ia, b = (bx1 - ox) * ia;
    if (a > b) { const s = a; a = b; b = s; }
    if (a > t0) t0 = a;
    if (b < t1) t1 = b;
    ia = 1 / reg[4]; a = (by0 - oy) * ia; b = (by1 - oy) * ia;
    if (a > b) { const s = a; a = b; b = s; }
    if (a > t0) t0 = a;
    if (b < t1) t1 = b;
    ia = 1 / reg[5]; a = (bz0 - oz) * ia; b = (bz1 - oz) * ia;
    if (a > b) { const s = a; a = b; b = s; }
    if (a > t0) t0 = a;
    if (b < t1) t1 = b;
    ST[0] = t0; ST[1] = t1;
    return t1 >= t0;
  }

  /**
   * The field's zero along `reg`'s ray within [WN[0], WN[1]) by closest()'s march: 1 found, 2 found at the first
   * sample with the field already negative there (the window began inside a solid), with WN[2] its distance; 0 the
   * window marched clear to its end; 3 the march gave up before its end (a ray running along a surface), with WN[2]
   * as far as it showed the ray clear.
   */
  function windowMarch(reg: Float64Array): number {
    const ox = reg[0], oy = reg[1], oz = reg[2], dx = reg[3], dy = reg[4], dz = reg[5];
    let t = WN[0];
    const t1 = WN[1];
    for (let i = 0; i < 64 && t < t1; i++) {
      const d = dist(ox + dx * t, oy + dy * t, oz + dz * t);
      stats.windowSteps++;
      if (d < hitEps) { WN[2] = t; return i === 0 && d < 0 ? 2 : 1; }
      t += d * 0.9 > hitEps ? d * 0.9 : hitEps;
    }
    WN[2] = t;
    return t < t1 ? 3 : 0;
  }

  /** closest() on RY: how it was answered (0 a miss), and ST[3] the distance. */
  function closestCore(): number {
    stats.closest++;
    if (!clip(RY)) return 0;
    const ox = RY[0], oy = RY[1], oz = RY[2], dx = RY[3], dy = RY[4], dz = RY[5];
    const tEnd = ST[1];
    // The field for the first NEAR.
    let t = ST[0] > cell * 0.5 ? ST[0] : cell * 0.5;
    const nearEnd = near < tEnd ? near : tEnd;
    for (let i = 0; i < 128 && t < nearEnd; i++) {
      const d = dist(ox + dx * t, oy + dy * t, oz + dz * t);
      stats.nearSteps++;
      if (d < hitEps) { stats.nearHits++; ST[3] = t; return 1; }
      t += d * 0.9 > hitEps ? d * 0.9 : hitEps;
    }
    if (t >= tEnd) return 0;
    // Beyond it, the mesh says where; the field says exactly, over a window of three cells either side. The field
    // has shown the ray clear up to `cleared`, but the mesh of a surface just past it may lie a little short of it,
    // so the mesh is asked from two cells back. A triangle whose window the field marches clear to its end is the
    // mesh's alone (a thin part's mesh is fatter than the part: on the lantern 110 of 120 such hits were rays that
    // pass a bar's field by a tenth of a cell, and the field met nothing there): the window joins the cleared stretch
    // and the mesh is asked again past it, so the ray goes on to what the field has behind. Only a window whose
    // march gave up (a ray running along a surface) takes the mesh's distance on trust.
    TR[0] = ox; TR[1] = oy; TR[2] = oz; TR[3] = dx; TR[4] = dy; TR[5] = dz; TR[7] = tEnd;
    let cleared = t;
    for (let pass = 0; pass < 8; pass++) {
      TR[6] = cleared - cell * 2;
      if (tracer.closestRay(ALL) < 0) return 0;
      stats.bvhHits++;
      const tm = TH[0];
      WN[0] = tm - cell * 3 > cleared ? tm - cell * 3 : cleared; WN[1] = tm + cell * 3;
      const w = windowMarch(RY);
      if (w === 1 || w === 2) { stats.confirmed++; ST[3] = WN[2]; return 2; }
      if (w === 3 && tm >= cleared) { stats.trusted++; ST[3] = tm; return 3; }
      // Clear as far as the march went: at least a cell past the last, since the mesh was asked from two back.
      cleared = WN[2];
      if (cleared >= tEnd) return 0;
    }
    return 0;
  }

  /**
   * insideMarch() on IR: 1 with IR[6] the exit's distance and `abs` filled, 0 when the solid is not left.
   *
   * The absorption is integrated stretch by stretch: hit() is asked every six cells and just short of the exit, and
   * where two samples differ the boundary between them is found by bisection, so each material's sigma counts for the
   * length the ray spends in it. Averaging the samples instead counted a stretch by how many samples happened to fall in it, a whole sample more
   * or less from one ray to the next: a tumbler's base, where the ray crosses the glass floor into the drink, drew a
   * stripe every few rows.
   */
  /** Where along the ray, between a (in the stretch of sigma r, g, b) and b (past it), the stretch ends: five bisections on hit(). */
  function boundary(ox: number, oy: number, oz: number, dx: number, dy: number, dz: number, a: number, b: number, r: number, g: number, bl: number): number {
    for (let k = 0; k < 5; k++) {
      const mid = (a + b) / 2;
      stats.hits++;
      const q = shape.hit(ox + dx * mid, oy + dy * mid, oz + dz * mid).mat;
      if (sigmaOf(q, 0) === r && sigmaOf(q, 1) === g && sigmaOf(q, 2) === bl) a = mid; else b = mid;
    }
    return (a + b) / 2;
  }

  function insideCore(entry: Material): number {
    stats.inside++;
    const ox = IR[0], oy = IR[1], oz = IR[2], dx = IR[3], dy = IR[4], dz = IR[5];
    let t = cell * 0.25;
    // The sigma of the stretch being crossed, where it began, and sigma times length so far.
    let cr = 0, cg = 0, cb = 0, seg = 0, ar = 0, ag = 0, ab = 0, have = false;
    let prevT = 0, nextHit = 0, lastHit = 0;
    const tEnd = reach * 2;
    for (let i = 0; i < 400 && t < tEnd; i++) {
      const x = ox + dx * t, y = oy + dy * t, z = oz + dz * t;
      const d = -dist(x, y, z);
      stats.insideSteps++;
      if (d < hitEps) {
        // A zero the field touches without crossing (two coincident faces of a union; a revolved outline's axis did
        // before round 11): still inside a cell on, so it is no exit (the tumbler's drink drew contour bands from it).
        if (-dist(x + dx * cell, y + dy * cell, z + dz * cell) > hitEps) { prevT = t; t += cell; continue; }
        // Nor is a sliver of outside thinner than two cells that the ray runs along (a liquid's floor a hundredth
        // above its glass's, as the tumbler's is): inside a cell away on either side of it, across it.
        {
          const e = cell * 0.5;
          let gx = dist(x + e, y, z) - dist(x - e, y, z), gy = dist(x, y + e, z) - dist(x, y - e, z), gz = dist(x, y, z + e) - dist(x, y, z - e);
          const gl = Math.sqrt(gx * gx + gy * gy + gz * gz);
          if (gl > 0) {
            gx *= cell / gl; gy *= cell / gl; gz *= cell / gl;
            if (-dist(x + gx, y + gy, z + gz) > hitEps && -dist(x - gx, y - gy, z - gz) > hitEps) { prevT = t; t += cell; continue; }
          }
        }
        // The exit, refined between the last inside sample and this one, so a coarse step does not move it.
        let a = prevT, b = t;
        for (let k = 0; k < 5; k++) { const m = (a + b) / 2; if (-dist(ox + dx * m, oy + dy * m, oz + dz * m) < hitEps) b = m; else a = m; }
        if (!have) { cr = sigmaOf(entry, 0); cg = sigmaOf(entry, 1); cb = sigmaOf(entry, 2); }
        else if (b - lastHit > cell * 0.5) {
          // The last stretch: what the ray passes through just short of the exit (a far wall thinner than the samples'
          // spacing), its start found as the others are.
          const te = b - cell * 0.25;
          stats.hits++;
          const m = shape.hit(ox + dx * te, oy + dy * te, oz + dz * te).mat;
          const s0 = sigmaOf(m, 0), s1 = sigmaOf(m, 1), s2 = sigmaOf(m, 2);
          if (s0 !== cr || s1 !== cg || s2 !== cb) {
            const tb = boundary(ox, oy, oz, dx, dy, dz, lastHit, te, cr, cg, cb);
            ar += cr * (tb - seg); ag += cg * (tb - seg); ab += cb * (tb - seg);
            seg = tb; cr = s0; cg = s1; cb = s2;
          }
        }
        abs[0] = ar + cr * (b - seg); abs[1] = ag + cg * (b - seg); abs[2] = ab + cb * (b - seg);
        IR[6] = b;
        return 1;
      }
      // What the ray passes through, every six cells of its length (hit() allocates).
      if (t >= nextHit) {
        stats.hits++;
        const m = shape.hit(x, y, z).mat;
        const s0 = sigmaOf(m, 0), s1 = sigmaOf(m, 1), s2 = sigmaOf(m, 2);
        if (!have) { cr = s0; cg = s1; cb = s2; have = true; }
        else if (s0 !== cr || s1 !== cg || s2 !== cb) {
          // Where the stretch ended, between the last sample (in it) and this one (past it).
          const tb = boundary(ox, oy, oz, dx, dy, dz, lastHit, t, cr, cg, cb);
          ar += cr * (tb - seg); ag += cg * (tb - seg); ab += cb * (tb - seg);
          seg = tb; cr = s0; cg = s1; cb = s2;
        }
        lastHit = t;
        nextHit = t + cell * 6;
      }
      prevT = t;
      t += d * 0.9 > cell * 0.5 ? d * 0.9 : cell * 0.5;
    }
    abs[0] = 0; abs[1] = 0; abs[2] = 0;
    IR[6] = -1;
    return 0;
  }

  /**
   * Dim `out` by one glass solid of material m, entered on the field at distance XG[0] along `reg`'s ray: its two
   * faces' loss and Beer's law over the length the inside march measures. 1 with XG[1] the exit's distance; 0 when
   * the ray is stopped (no exit, an exit through an opaque part, or next to nothing left).
   */
  function crossGlass(reg: Float64Array, m: Material, out: Float64Array): number {
    stats.glassSegments++;
    const t = XG[0];
    IR[0] = reg[0] + reg[3] * t; IR[1] = reg[1] + reg[4] * t; IR[2] = reg[2] + reg[5] * t;
    IR[3] = reg[3]; IR[4] = reg[4]; IR[5] = reg[5];
    if (!insideCore(m)) return 0;
    // A ray that leaves through an opaque part's face (a straw standing out of a drink: the union has no face
    // between them) went through that part.
    stats.hits++;
    const e = IR[6];
    if (shape.hit(IR[0] + IR[3] * e, IR[1] + IR[4] * e, IR[2] + IR[5] * e).mat.transmit <= 0) return 0;
    const k = m.transmit * 0.92;
    out[0] *= k * Math.exp(-abs[0]); out[1] *= k * Math.exp(-abs[1]); out[2] *= k * Math.exp(-abs[2]);
    if (out[0] < 1e-3 && out[1] < 1e-3 && out[2] < 1e-3) return 0;
    XG[1] = t + IR[6];
    return 1;
  }

  /**
   * The field's soft march along RY (towards a light) from the last clip's entry to min(ST[7], ST[1]), at most `cap`
   * steps: Quilez's closest approach with softness ST[6], counting only surfaces the ray is closing on and that lie
   * short of the light (ST[5]); glass is crossed and dims `out`. 0 when blocked; else 1, with ST[4] the penumbra term
   * and ST[2] where the field's part of the ray ended.
   */
  function nearMarch(out: Float64Array, cap: number): number {
    const ox = RY[0], oy = RY[1], oz = RY[2], lx = RY[3], ly = RY[4], lz = RY[5];
    const limit = ST[5], softness = ST[6];
    let res = 1, passes = 0, prev = Infinity;
    // tp: the last place known outside, the origin (lifted off its surface) to begin with.
    let t = ST[0] > cell * 1.5 ? ST[0] : cell * 1.5, tp = ST[0];
    const stop = ST[7] < ST[1] ? ST[7] : ST[1];
    for (let i = 0; i < cap && t < stop; i++) {
      const x = ox + lx * t, y = oy + ly * t, z = oz + lz * t;
      const d = dist(x, y, z);
      stats.nearSteps++;
      if (d < hitEps) {
        if (!glass) return 0;
        stats.hits++;
        const m = shape.hit(x, y, z).mat;
        if (m.transmit <= 0) return 0;
        // A step of half a cell may have gone into the glass: its entry, between the last sample and this one, so
        // the length Beer's law reads is the solid's.
        let te = t;
        if (d < 0 && tp < t) {
          let a = tp, b = t;
          for (let k = 0; k < 6; k++) { const mid = (a + b) / 2; if (dist(ox + lx * mid, oy + ly * mid, oz + lz * mid) < 0) b = mid; else a = mid; }
          te = a;
        }
        // Glass the ray only grazes (the field outside still a quarter cell on) is not crossed: an inside march from
        // there measures nothing and would dim the ray by two faces it never passed.
        const tq = te + cell * 0.25;
        if (dist(ox + lx * tq, oy + ly * tq, oz + lz * tq) > -hitEps) { prev = d; tp = t; t += ST[8]; continue; }
        if (passes++ > 3) return 0;
        XG[0] = te;
        if (!crossGlass(RY, m, out)) return 0;
        t = XG[1] + cell * 1.5;
        tp = t;
        prev = Infinity;
        continue;
      }
      if (softness > 0 && i > 0 && d < prev && t + d < limit) {
        let isGlass = false;
        if (glass && d < cell * 2) { stats.hits++; isGlass = shape.hit(x, y, z).mat.transmit > 0; }
        if (!isGlass) {
          const yy = (d * d) / (2 * prev);
          const s = Math.sqrt(Math.max(0, d * d - yy * yy));
          const r = (softness * s) / Math.max(1e-9, t - yy);
          if (r < res) res = r;
        }
      }
      prev = d;
      tp = t;
      t += d > ST[8] ? d : ST[8];
    }
    ST[2] = t > ST[7] ? t : ST[7];
    ST[4] = res < 0 ? 0 : res > 1 ? 1 : res;
    return 1;
  }

  /**
   * The shadow ray in FR beyond the near march, against the mesh: blocked by any opaque triangle in [FR[6], FR[7]),
   * dimmed by each glass solid it crosses (found on the BVH's glass triangles, confirmed and measured on the field).
   * Writes FT; returns 0 blocked, 1 clear, 2 through glass.
   */
  function farRay(): number {
    FT[0] = 1; FT[1] = 1; FT[2] = 1;
    if (!clip(FR)) return 1;
    const start = FR[6] > ST[0] ? FR[6] : ST[0], end = ST[1];
    if (start >= end) return 1;
    stats.farRays++;
    TR[0] = FR[0]; TR[1] = FR[1]; TR[2] = FR[2]; TR[3] = FR[3]; TR[4] = FR[4]; TR[5] = FR[5]; TR[6] = start; TR[7] = end;
    if (tracer.occludedRay(OPAQUE)) { FT[0] = 0; FT[1] = 0; FT[2] = 0; return 0; }
    if (!bvh.anyGlass) return 1;
    let t = start, crossed = 0;
    for (let passes = 0; passes < 8; passes++) {
      TR[6] = t; TR[7] = end;
      if (tracer.closestRay(GLASS) < 0) break;
      const tm = TH[0];
      // The solid's entry on the field. A window that starts inside is the exit face of a solid already crossed, or
      // a mesh face the field does not have: neither dims the ray again; but before any crossing it may be the far
      // face of a solid the near march's last step (half a cell at least) went into, and then that solid is crossed
      // from where the near march left off.
      WN[0] = tm - cell * 3 > t ? tm - cell * 3 : t; WN[1] = tm + cell * 3;
      const w = windowMarch(FR);
      if (w === 0 || w === 3) { t = tm + cell; continue; }
      if (w === 2) {
        if (crossed > 0 || t !== start || dist(FR[0] + FR[3] * start, FR[1] + FR[4] * start, FR[2] + FR[5] * start) >= 0) { t = tm + cell; continue; }
        WN[2] = start;
      }
      // What the field has there, not the triangle: a triangle where glass meets an opaque part (a straw leaving a
      // drink) is glass by its vertices but may be the opaque part's face.
      const te = WN[2];
      stats.hits++;
      const m = shape.hit(FR[0] + FR[3] * te, FR[1] + FR[4] * te, FR[2] + FR[5] * te).mat;
      if (m.transmit <= 0 || crossed++ > 3) { FT[0] = 0; FT[1] = 0; FT[2] = 0; return 0; }
      XG[0] = te;
      if (!crossGlass(FR, m, FT)) { FT[0] = 0; FT[1] = 0; FT[2] = 0; return 0; }
      t = XG[1] + cell * 2;
      if (t >= end) break;
    }
    return crossed ? 2 : 1;
  }

  /** occlusion() on RY, with ST[5] the light's distance, ST[6] the softness and ST[7] the near march's reach: fills vis. */
  function occlusionCore(cap: number): void {
    stats.occlusion++;
    vis[0] = 1; vis[1] = 1; vis[2] = 1;
    if (!clip(RY)) return;
    const end = ST[1];
    if (!nearMarch(vis, cap)) { vis[0] = 0; vis[1] = 0; vis[2] = 0; return; }
    const res = ST[4], from = ST[2];
    if (from < end) {
      FR[0] = RY[0]; FR[1] = RY[1]; FR[2] = RY[2]; FR[3] = RY[3]; FR[4] = RY[4]; FR[5] = RY[5]; FR[6] = from; FR[7] = end;
      farRay();
      vis[0] *= FT[0] * res; vis[1] *= FT[1] * res; vis[2] *= FT[2] * res;
    } else { vis[0] *= res; vis[1] *= res; vis[2] *= res; }
  }

  /** areaVisibility() at AP: fills vis. */
  function areaCore(light: RayLight, x: number, y: number, sub: number, rays: number, earlyOut: boolean): void {
    stats.area++;
    vis[0] = 1; vis[1] = 1; vis[2] = 1;
    const px = AP[0], py = AP[1], pz = AP[2];
    // The light's centre direction, how far it is, the tangent of its angular radius and the near march's softness.
    let lx = light.x, ly = light.y, lz = light.z, far = Infinity, tanA: number, r = 0;
    if (light.point) {
      lx -= px; ly -= py; lz -= pz;
      far = Math.sqrt(lx * lx + ly * ly + lz * lz);
      r = light.radius;
      if (far <= r) return;
      lx /= far; ly /= far; lz /= far;
      const s = r / far;
      tanA = s / Math.sqrt(1 - s * s);
      ST[6] = softnessFor(Math.asin(s));
    } else {
      // A light's size has no upper bound in the language, and size/18 passes a right angle at 28: its tangent
      // turns negative there, which turned the cone test's grown boxes into shrunk ones and let its early out call
      // a shadowed point clear. No disc is wider than a hemisphere.
      const ang = light.radius < MAX_ANGLE ? light.radius : MAX_ANGLE;
      tanA = Math.tan(ang);
      ST[6] = softnessFor(ang);
    }
    ST[5] = far - r;
    // The field near p, towards the centre.
    RY[0] = px; RY[1] = py; RY[2] = pz; RY[3] = lx; RY[4] = ly; RY[5] = lz; RY[7] = far - r;
    ST[7] = near; ST[8] = cell * 0.5;
    // A centre ray that misses the box has nothing to march near p, but the disc's other rays may still meet the
    // model (a floor point just past a shadow's edge). Nor has one that enters the box only beyond NEAR (a floor
    // point well behind the model): the march then cleared none of the way, and the disc's rays, which enter the box
    // where they each do, are traced from NEAR. Starting them where the centre ray enters let a ray that went in
    // earlier cross a thin wall before that and count as clear (a size-3 light leaked a fifth of its disc through a
    // 3-cell plate's umbra).
    let res = 1, from = near;
    if (clip(RY)) {
      const entry = ST[0];
      if (!nearMarch(vis, 64)) { vis[0] = 0; vis[1] = 0; vis[2] = 0; return; }
      res = ST[4];
      if (entry < near) from = ST[2];
    }
    // The early out: when no triangle can meet the cone of every ray the disc could send beyond NEAR, all of them are
    // clear, and the answer is exactly what eight rays would give.
    if (earlyOut) {
      TR[0] = px; TR[1] = py; TR[2] = pz; TR[3] = lx; TR[4] = ly; TR[5] = lz; TR[6] = from; TR[7] = far; TR[8] = tanA * (1 + 1e-9) + 1e-12;
      if (tracer.coneClearRay()) { stats.earlyOut++; vis[0] *= res; vis[1] *= res; vis[2] *= res; return; }
    }
    // A frame about the centre direction (Duff et al.'s, branch-free but for the sign).
    const sg = lz >= 0 ? 1 : -1, ia = -1 / (sg + lz), ib = lx * ly * ia;
    const t1x = 1 + sg * lx * lx * ia, t1y = sg * ib, t1z = -sg * lx;
    const t2x = ib, t2y = sg + ly * ly * ia, t2z = -ly;
    // The pixel's rotation and radii, from the pixel, the light and the subsample.
    diskPattern(x, y, light.index, sub, DP);
    const o1 = DP[1], o2 = DP[2], rot = DP[0] * 2 * Math.PI;
    const cr = Math.cos(rot), sr = Math.sin(rot);
    const c45 = (cr - sr) * Math.SQRT1_2, s45 = (sr + cr) * Math.SQRT1_2;
    const n = rays < 1 ? 1 : rays > AREA_RAYS ? AREA_RAYS : rays | 0;
    // Eight rays: four on the outer half of the disc's area (radius squared in [1/2, 1]), a quarter turn apart at one
    // radius the pattern gives, then four on the inner half, turned an eighth further. Over the pattern each ray is
    // uniform over its half, so the mean is the disc's visible fraction without bias (the cube's penumbra measures
    // within 2.5% of the exact disc's width). Fewer than five rays share one ring over the whole disc.
    const ring = n <= 4;
    const rOut = ring ? Math.sqrt(o1) : Math.sqrt(0.5 + 0.5 * o1), rIn = Math.sqrt(0.5 * o2);
    const step = ring ? (2 * Math.PI) / n : 0, cs = Math.cos(step), ss = Math.sin(step);
    OUT[0] = 0; OUT[1] = 0; OUT[2] = 0; SUM[0] = 0; SUM[1] = 0; SUM[2] = 0;
    let inner = 0;
    let ca = cr, sa = sr;
    FR[0] = px; FR[1] = py; FR[2] = pz; FR[6] = from;
    for (let k = 0; k < n; k++) {
      const rr = k < 4 ? rOut : rIn;
      const ua = rr * ca, ub = rr * sa;
      // The next direction: a quarter turn (1/n of a turn on a single ring); after the fourth, the inner ring's first,
      // an eighth of a turn on from the outer's.
      if (ring) { const c2 = ca * cs - sa * ss; sa = ca * ss + sa * cs; ca = c2; }
      else if (k === 3) { ca = c45; sa = s45; }
      else { const c2 = -sa; sa = ca; ca = c2; }
      if (light.point) {
        // A point on the disc of radius r about the light's centre, square to the centre direction; the ray stops r
        // short of it, so a light set against its own flame is not shadowed by it.
        const sx = light.x + r * (ua * t1x + ub * t2x) - px, sy = light.y + r * (ua * t1y + ub * t2y) - py, sz = light.z + r * (ua * t1z + ub * t2z) - pz;
        const len = Math.sqrt(sx * sx + sy * sy + sz * sz);
        FR[3] = sx / len; FR[4] = sy / len; FR[5] = sz / len; FR[7] = len - r;
      } else {
        const dx = lx + tanA * (ua * t1x + ub * t2x), dy = ly + tanA * (ua * t1y + ub * t2y), dz = lz + tanA * (ua * t1z + ub * t2z);
        const len = Math.sqrt(dx * dx + dy * dy + dz * dz);
        FR[3] = dx / len; FR[4] = dy / len; FR[5] = dz / len; FR[7] = Infinity;
      }
      stats.areaRays++;
      farRay();
      if (k < 4) { OUT[0] += FT[0]; OUT[1] += FT[1]; OUT[2] += FT[2]; }
      else { SUM[0] += FT[0]; SUM[1] += FT[1]; SUM[2] += FT[2]; inner++; }
    }
    // The two halves of the disc's area weigh the same, however many rays each took.
    const outer = n < 4 ? n : 4;
    for (let c = 0; c < 3; c++) vis[c] *= res * (inner ? 0.5 * (OUT[c] / outer + SUM[c] / inner) : OUT[c] / outer);
  }

  /** The field-only march closest() stands in for, over the whole ray in RY: ST[3] its distance; 1 for a hit. */
  function fieldCore(steps: number): number {
    if (!clip(RY)) return 0;
    const ox = RY[0], oy = RY[1], oz = RY[2], dx = RY[3], dy = RY[4], dz = RY[5];
    let t = ST[0] > cell * 0.5 ? ST[0] : cell * 0.5;
    const tEnd = ST[1];
    for (let i = 0; i < steps && t < tEnd; i++) {
      const d = dist(ox + dx * t, oy + dy * t, oz + dz * t);
      if (d < hitEps) { ST[3] = t; return 1; }
      t += d * 0.9 > hitEps ? d * 0.9 : hitEps;
    }
    return 0;
  }

  const self: Rays = {
    cell, near, box: grown, reach, glass, tracer, vis, abs, stats, how: 0,
    closest(ox, oy, oz, dx, dy, dz, tMax) {
      RY[0] = ox; RY[1] = oy; RY[2] = oz; RY[3] = dx; RY[4] = dy; RY[5] = dz; RY[7] = tMax;
      const how = closestCore();
      self.how = how;
      return how ? ST[3] : -1;
    },
    occlusion(ox, oy, oz, lx, ly, lz, tMax, softness) {
      RY[0] = ox; RY[1] = oy; RY[2] = oz; RY[3] = lx; RY[4] = ly; RY[5] = lz; RY[7] = tMax;
      ST[5] = tMax; ST[6] = softness; ST[7] = near; ST[8] = cell * 0.5;
      occlusionCore(64);
      return (vis[0] + vis[1] + vis[2]) / 3;
    },
    fieldOcclusion(ox, oy, oz, lx, ly, lz, tMax, softness, minStep = 0.5, steps = 64) {
      RY[0] = ox; RY[1] = oy; RY[2] = oz; RY[3] = lx; RY[4] = ly; RY[5] = lz; RY[7] = tMax;
      ST[5] = tMax; ST[6] = softness; ST[7] = Infinity; ST[8] = cell * minStep;
      occlusionCore(steps);
      return (vis[0] + vis[1] + vis[2]) / 3;
    },
    beyond(ox, oy, oz, lx, ly, lz, from, to) {
      FR[0] = ox; FR[1] = oy; FR[2] = oz; FR[3] = lx; FR[4] = ly; FR[5] = lz; FR[6] = from; FR[7] = to;
      farRay();
      vis[0] = FT[0]; vis[1] = FT[1]; vis[2] = FT[2];
      return (vis[0] + vis[1] + vis[2]) / 3;
    },
    areaVisibility(px, py, pz, light, x, y, sub = 0, rays = AREA_RAYS, earlyOut = true) {
      AP[0] = px; AP[1] = py; AP[2] = pz;
      areaCore(light, x, y, sub, rays, earlyOut);
      return (vis[0] + vis[1] + vis[2]) / 3;
    },
    insideMarch(ox, oy, oz, dx, dy, dz, entry) {
      IR[0] = ox; IR[1] = oy; IR[2] = oz; IR[3] = dx; IR[4] = dy; IR[5] = dz;
      return insideCore(entry) ? IR[6] : -1;
    },
    fieldClosest(ox, oy, oz, dx, dy, dz, tMax, steps = 4096) {
      RY[0] = ox; RY[1] = oy; RY[2] = oz; RY[3] = dx; RY[4] = dy; RY[5] = dz; RY[7] = tMax;
      return fieldCore(steps) ? ST[3] : -1;
    },
  };
  return self;
}
