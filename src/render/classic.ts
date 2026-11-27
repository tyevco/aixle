/**
 * The classic beauty render as a kernel: the distance field itself, ray-marched, with soft shadows, ambient
 * occlusion and a studio floor, exactly as every committed render has drawn it. Temporary: the new shading kernel
 * replaces it.
 *
 * Each ray starts where the rasterised mesh says the surface is (a few cells short of it) and marches only that
 * window, so empty space costs nothing. Shadow rays are skipped when they cannot reach the model's bounding box. Edge
 * pixels, found by comparing depth, normal and material with their neighbours, are drawn again with four samples.
 *
 * Split into rows for the pool: pass 1 writes each pixel's display colour, depth, normal, material id and glow flag;
 * pass 2 decides its row's edge pixels from those and overwrites their colour with four samples' mean; finish
 * dithers, blurs for depth of field and captions. The shading allocates nothing of its own (scalars, and scratch made
 * once per thread per render); hit(), albedo() and surface() still allocate once per shading point. Every expression
 * that feeds a pixel keeps the order of operations it had in one function, so the bytes are the same as they were,
 * on any number of threads. The colour, depth and normal are kept as doubles: rounding any of them to a float moves
 * a pixel across a quantisation level or an edge decision now and then.
 */
import { normalize, type Vec3 } from "../core/vec.js";
import { albedo, bumpScaleOf, bumpSlope, fieldCurvature, hasFinish, surface, wearProbe } from "../sdf/materials.js";
import { boundsCenter, boundsDistance, boundsGrow, boundsSize, type Hit, type Material, type Shape3 } from "../sdf/types.js";
import { toView, type Camera } from "./camera.js";
import { Canvas, rgbDithered } from "./canvas.js";
import { drawText } from "./font.js";
import { INK } from "./views.js";
import { DEFAULT_LIGHT_DIRECTION, environmentPalette, lightDirection } from "./beauty.js";
import type { Kernel, KernelContext, KernelRows } from "./kernel.js";

interface ClassicTables {
  /** Some material lets light through: the shadow march then asks hit() what it met. */
  glass: boolean;
}

/** True when some material in the shape lets light through: the shadow march then has to ask hit() what it met. */
export function anyGlass(shape: Shape3): boolean {
  const seen = new Set<Shape3>();
  const stack: Shape3[] = [shape];
  while (stack.length) {
    const s = stack.pop()!;
    if (seen.has(s)) continue;
    seen.add(s);
    if ((s.material && s.material.transmit > 0) || (s.decal && s.decal.transmit > 0)) return true;
    if (s.inner) stack.push(...s.inner);
    if (s.parts) stack.push(...s.parts);
    if (s.instanced) stack.push(s.instanced.base);
    if (s.joint) stack.push(s.joint.child);
  }
  return false;
}

export const classic: Kernel<ClassicTables> = {
  name: "classic",
  layout: () => [
    { name: "col", type: "f64", per: 3 },
    { name: "depth", type: "f64", per: 1 },
    { name: "normal", type: "f64", per: 3 },
    { name: "mat", type: "i32", per: 1 },
    { name: "glow", type: "u8", per: 1 },
  ],
  // A material the walk cannot see is still in the mesh unless it is thinner than a cell: both are asked.
  prepare: (ctx) => ({ glass: anyGlass(ctx.shape) || ctx.mesh.materials.some((m) => m.transmit > 0) }),
  rows: (ctx) => classicRows(ctx),
  finish: (ctx) => {
    const { size, opts, buffers, camera, bounds } = ctx;
    const col = buffers.col as Float64Array, depth = buffers.depth as Float64Array, glow = buffers.glow as Uint8Array;
    const canvas = new Canvas(size, size, INK.page);
    for (let py = 0; py < size; py++)
      for (let px = 0; px < size; px++) {
        const i = py * size + px;
        canvas.set(px, py, rgbDithered(col[i * 3], col[i * 3 + 1], col[i * 3 + 2], px, py));
      }
    if (opts.glowMask) for (let i = 0; i < size * size; i++) if (glow[i]) opts.glowMask[i] = 1;
    if (opts.dof && opts.dof > 0) depthOfField(canvas, depth, size, opts.dof, boundsCenter(bounds), camera);
    if (opts.label) drawText(canvas, 8, size - 12, opts.label, INK.dim, 1);
    return { canvas };
  },
};

function classicRows(ctx: KernelContext<ClassicTables>): KernelRows {
  const { shape, bounds, opts, camera: cam, prime, size, cell, buffers, ids } = ctx;
  const glass = ctx.tables.glass;
  const pal = environmentPalette(opts.environment);
  const SKY = pal.sky, GROUND = pal.ground, FLOOR = pal.floor;
  // The lights: the program's, or the one key light the settings describe (its default direction kept as it was).
  type Lit = { dir: Vec3; softness: number; color: Vec3; power: number; pos?: Vec3; range: number };
  const centre = boundsCenter(opts.reachBounds ?? bounds);
  // A point light with no range of its own reaches half the model's longest side, whatever the unit.
  const halfModel = Math.max(...boundsSize(opts.reachBounds ?? bounds)) / 2 || 1;
  const lights: Lit[] = (opts.lights && opts.lights.length
    ? opts.lights.map((l) => ({ dir: l.position ? normalize([l.position[0] - centre[0], l.position[1] - centre[1], l.position[2] - centre[2]]) : lightDirection(l.azimuth, l.elevation), size: l.size, color: l.color, power: l.power, pos: l.position, range: l.range ?? halfModel }))
    : [{ dir: opts.lightAzimuth === undefined && opts.lightElevation === undefined ? DEFAULT_LIGHT_DIRECTION : lightDirection(opts.lightAzimuth ?? -40, opts.lightElevation ?? 55), size: opts.lightSize ?? 1, color: [1, 1, 1] as Vec3, power: 1, pos: undefined, range: 2 }]
  ).map((l) => ({ dir: l.dir, softness: 6 / Math.max(0.1, l.size), color: l.color, power: Math.max(0, l.power), pos: l.pos, range: Math.max(1e-6, l.range) }));
  const NL = lights.length;
  const totalPower = Math.max(1e-6, lights.reduce((s, l) => s + l.power, 0));
  const ambient = Math.max(0, opts.ambient ?? 1) * pal.ambient;
  const model = opts.reachBounds ?? bounds;
  const floorY = Math.min(0, model.min[1]);
  const shadowBox = boundsGrow(model, cell);
  const reach = Math.hypot(...boundsSize(model)) * 1.5;
  const dist = shape.dist;
  const probe = opts.wearProbe ?? wearProbe(Math.max(...boundsSize(model)));
  const f = size / 2 / Math.tan(((cam.fov ?? 30) * Math.PI) / 360);
  const eye = cam.eye;
  const eps = cell * 0.5;
  const SBx = shadowBox.min[0], SBy = shadowBox.min[1], SBz = shadowBox.min[2], SXx = shadowBox.max[0], SXy = shadowBox.max[1], SXz = shadowBox.max[2];
  const col = buffers.col as Float64Array, depthBuf = buffers.depth as Float64Array, normalBuf = buffers.normal as Float64Array, matBuf = buffers.mat as Int32Array, glowBuf = buffers.glow as Uint8Array;

  // Scratch: every vector the shading needs, made once for this thread's rows. Each is written and read by one
  // function at one depth of the recursion (primary sample, a reflection or refraction it traces, the floor).
  const RD = new Float64Array(3), COL = new Float64Array(3);
  const G0 = new Float64Array(3), G1 = new Float64Array(3), G2 = new Float64Array(3);
  const SEEN = new Float64Array(3), SOFT = new Float64Array(3), FL = new Float64Array(3), BD2 = new Float64Array(3);
  const GREFL = new Float64Array(3), GSPEC = new Float64Array(3), GTHRU = new Float64Array(3), GIN = new Float64Array(3), GOUT = new Float64Array(3), GPASS = new Float64Array(3), GSEEN = new Float64Array(3), GOPQ = new Float64Array(3);
  // finishAt's answer.
  const fin = { r: 0, g: 0, b: 0, metal: 0, rough: 0, glow: 0, nx: 0, ny: 0, nz: 0 };
  // The sample's registers besides its colour (in COL).
  let sDepth = 0, sNx = 0, sNy = 0, sNz = 0, sMat = 0, sGlow = false;

  const rayDirInto = (px: number, py: number, out: Float64Array): void => {
    const x = (px - size / 2) / f, y = -(py - size / 2) / f;
    const vx = cam.right[0] * x + cam.up[0] * y + cam.forward[0];
    const vy = cam.right[1] * x + cam.up[1] * y + cam.forward[1];
    const vz = cam.right[2] * x + cam.up[2] * y + cam.forward[2];
    const l = Math.sqrt(vx * vx + vy * vy + vz * vz) || 1;
    out[0] = vx / l; out[1] = vy / l; out[2] = vz / l;
  };
  const gradientInto = (x: number, y: number, z: number, out: Float64Array): void => {
    const gx = dist(x + eps, y, z) - dist(x - eps, y, z), gy = dist(x, y + eps, z) - dist(x, y - eps, z), gz = dist(x, y, z + eps) - dist(x, y, z - eps);
    const l = Math.sqrt(gx * gx + gy * gy + gz * gz) || 1;
    out[0] = gx / l; out[1] = gy / l; out[2] = gz / l;
  };

  /**
   * What the shader needs at a surface point, into `fin`: the material's own colour and fields, or, for a material
   * with a finish (wear, bump, rust), `surface()` with the curvature wear reads and the normal tilted by the bump's
   * slope, which is the same function and the same slope the atlas baker writes into the GLB's maps. A plain material
   * pays nothing for this. The bump's branch allocates (bumpSlope takes vectors).
   */
  const finishAt = (px: number, py: number, pz: number, nx: number, ny: number, nz: number, h: Hit): void => {
    const m = h.mat;
    if (!hasFinish(m)) {
      const a = albedo(m, h.lx, h.ly, h.lz);
      fin.r = a[0]; fin.g = a[1]; fin.b = a[2]; fin.metal = m.metal; fin.rough = m.rough; fin.glow = m.glow; fin.nx = nx; fin.ny = ny; fin.nz = nz;
      return;
    }
    const c = (m.wear ?? 0) > 0 ? fieldCurvature(dist, px, py, pz, probe) : 0;
    const sf = surface(m, h.lx, h.ly, h.lz, c);
    let ox = nx, oy = ny, oz = nz;
    if ((m.bump ?? 0) > 0) {
      // Two tangents, and how far the paint frame's point moves along each per world unit (from two nearby hits),
      // so the slope is measured in the frame the bumps were painted in: they move and turn with the part.
      const n: Vec3 = [nx, ny, nz];
      const ref: Vec3 = Math.abs(n[1]) < 0.9 ? [0, 1, 0] : [1, 0, 0];
      const t1 = normalize([n[1] * ref[2] - n[2] * ref[1], n[2] * ref[0] - n[0] * ref[2], n[0] * ref[1] - n[1] * ref[0]]);
      const t2: Vec3 = [n[1] * t1[2] - n[2] * t1[1], n[2] * t1[0] - n[0] * t1[2], n[0] * t1[1] - n[1] * t1[0]];
      const e = bumpScaleOf(m) * 0.1;
      const along = (t: Vec3): Vec3 => {
        const q = shape.hit(px + t[0] * e, py + t[1] * e, pz + t[2] * e);
        // A neighbour in another material (a decal's edge) is no slope.
        return q.mat === m ? [(q.lx - h.lx) / e, (q.ly - h.ly) / e, (q.lz - h.lz) / e] : [0, 0, 0];
      };
      const [s1, s2] = bumpSlope(m, h.lx, h.ly, h.lz, along(t1), along(t2));
      const nn = normalize([n[0] - s1 * t1[0] - s2 * t2[0], n[1] - s1 * t1[1] - s2 * t2[1], n[2] - s1 * t1[2] - s2 * t2[2]]);
      ox = nn[0]; oy = nn[1]; oz = nn[2];
    }
    fin.r = sf.color[0]; fin.g = sf.color[1]; fin.b = sf.color[2]; fin.metal = sf.metal; fin.rough = sf.rough; fin.glow = sf.glow; fin.nx = ox; fin.ny = oy; fin.nz = oz;
  };

  /** 0 = fully shadowed, 1 = lit, towards one light; skipped when the ray cannot reach the model's box. */
  const shadow = (px: number, py: number, pz: number, Lx: number, Ly: number, Lz: number, softness: number, limit: number): number => {
    // Ray-box test against the shadow box; a point light's ray stops at the light.
    let tmin = 0, tmax = Math.min(reach, limit);
    {
      const inv = 1 / Lx;
      let t0 = (SBx - px) * inv, t1 = (SXx - px) * inv;
      if (t0 > t1) { const s = t0; t0 = t1; t1 = s; }
      tmin = Math.max(tmin, t0); tmax = Math.min(tmax, t1);
    }
    {
      const inv = 1 / Ly;
      let t0 = (SBy - py) * inv, t1 = (SXy - py) * inv;
      if (t0 > t1) { const s = t0; t0 = t1; t1 = s; }
      tmin = Math.max(tmin, t0); tmax = Math.min(tmax, t1);
    }
    {
      const inv = 1 / Lz;
      let t0 = (SBz - pz) * inv, t1 = (SXz - pz) * inv;
      if (t0 > t1) { const s = t0; t0 = t1; t1 = s; }
      tmin = Math.max(tmin, t0); tmax = Math.min(tmax, t1);
    }
    if (tmax < tmin) return 1;
    let res = 1;
    let t = Math.max(tmin, cell * 1.5);
    let passes = 0;
    // The penumbra term counts a surface only while the ray is closing on it (a ray leaving a flat face moves away
    // from that face, which cannot shadow its own points), only while that surface can lie short of the light (a
    // bulb just beyond a point light drew rings on the pavement under it, round 10), and not when it is glass,
    // which dims the ray where it is crossed rather than as it is approached. With no glass in the model, hit() is
    // never asked: what it would answer is known.
    let prev = Infinity;
    for (let i = 0; i < 64 && t < tmax; i++) {
      const x = px + Lx * t, y = py + Ly * t, z = pz + Lz * t;
      const d = dist(x, y, z);
      if (d < cell * 0.05) {
        // Glass lets light through, dimmed; step across it and carry on.
        const tr = glass ? shape.hit(x, y, z).mat.transmit : 0;
        if (tr <= 0 || passes++ > 3) { res = 0; break; }
        res *= 0.35 + 0.65 * tr * 0.6;
        let inside = 0;
        while (inside++ < 200 && t < tmax && dist(px + Lx * t, py + Ly * t, pz + Lz * t) < cell * 0.05) t += cell * 2;
        t += cell;
        continue;
      }
      if (i > 0 && d < prev && t + d < limit && !(glass && d < cell * 2 && shape.hit(x, y, z).mat.transmit > 0)) {
        // The closest approach between this sample and the last, from the two distances (Quilez), so the
        // penumbra does not band with where the steps happen to land.
        const yy = (d * d) / (2 * prev);
        const s = Math.sqrt(Math.max(0, d * d - yy * yy));
        res = Math.min(res, (softness * s) / Math.max(1e-9, t - yy));
      }
      prev = d;
      t += Math.max(d, cell * 0.5);
    }
    return Math.max(0, Math.min(1, res));
  };

  const occlusion = (px: number, py: number, pz: number, nx: number, ny: number, nz: number): number => {
    let occ = 0, w = 1;
    for (let i = 1; i <= 5; i++) {
      const h = cell * 1.5 * i * i * 0.4 + cell;
      const d = dist(px + nx * h, py + ny * h, pz + nz * h);
      occ += w * Math.max(0, h - d);
      w *= 0.7;
    }
    // Never fully black: a concave join still gets bounce light.
    return Math.max(0.3, Math.min(1, 1 - (0.8 * occ) / (cell * 4)));
  };

  /** The light on the floor at p, into `out`: the ambient floor plus each light's share, shadowed, in the light's colour. */
  const floorLight = (px: number, py: number, pz: number, out: Float64Array): void => {
    out[0] = 0.62 * pal.ambient; out[1] = 0.62 * pal.ambient; out[2] = 0.62 * pal.ambient;
    for (let li = 0; li < NL; li++) {
      const l = lights[li];
      // The light as seen from p: its direction there and its strength (a point light falls off with distance).
      let dx = l.dir[0], dy = l.dir[1], dz = l.dir[2], k = 1, far = Infinity;
      if (l.pos) {
        const ex = l.pos[0] - px, ey = l.pos[1] - py, ez = l.pos[2] - pz;
        far = Math.hypot(ex, ey, ez) || 1e-9;
        dx = ex / far; dy = ey / far; dz = ez / far;
        k = (l.range * l.range) / (l.range * l.range + far * far);
      }
      const sh = shadow(px, py, pz, dx, dy, dz, l.softness, far);
      const kk = (0.38 * sh * Math.max(0, dy) * l.power * k) / totalPower;
      out[0] += kk * l.color[0]; out[1] += kk * l.color[1]; out[2] += kk * l.color[2];
    }
  };

  /** The sky or the ground's far colour seen along a direction with this y. */
  const backdrop = (dy: number, out: Float64Array): void => {
    if (dy < -1e-6) {
      const fade = 0.6;
      out[0] = FLOOR[0] * 0.95 + (GROUND[0] - FLOOR[0] * 0.95) * fade; out[1] = FLOOR[1] * 0.95 + (GROUND[1] - FLOOR[1] * 0.95) * fade; out[2] = FLOOR[2] * 0.95 + (GROUND[2] - FLOOR[2] * 0.95) * fade;
      return;
    }
    const k = Math.min(1, Math.max(0, dy * 2.5));
    if (pal.horizon) {
      // A band at the horizon: ground to the band low down, the band to the sky above.
      const H = pal.horizon;
      if (k < 0.3) { const u = k / 0.3; out[0] = GROUND[0] + (H[0] - GROUND[0]) * u; out[1] = GROUND[1] + (H[1] - GROUND[1]) * u; out[2] = GROUND[2] + (H[2] - GROUND[2]) * u; return; }
      const u = (k - 0.3) / 0.7;
      out[0] = H[0] + (SKY[0] - H[0]) * u; out[1] = H[1] + (SKY[1] - H[1]) * u; out[2] = H[2] + (SKY[2] - H[2]) * u;
      return;
    }
    out[0] = GROUND[0] + (SKY[0] - GROUND[0]) * k; out[1] = GROUND[1] + (SKY[1] - GROUND[1]) * k; out[2] = GROUND[2] + (SKY[2] - GROUND[2]) * k;
  };

  /** Shade a surface point into `out`: the sky's light, each light's diffuse and highlight, a metal's reflection, the glow. */
  const shadePoint = (out: Float64Array, px: number, py: number, pz: number, nx: number, ny: number, nz: number, br: number, bg: number, bb: number, metal: number, rough: number, vx: number, vy: number, vz: number, depth: number, glow: number): void => {
    const ao = occlusion(px, py, pz, nx, ny, nz);
    const hemi = 0.5 + 0.5 * ny;
    const ambR = (GROUND[0] + (SKY[0] - GROUND[0]) * hemi) * 0.42 * ao * ambient;
    const ambG = (GROUND[1] + (SKY[1] - GROUND[1]) * hemi) * 0.42 * ao * ambient;
    const ambB = (GROUND[2] + (SKY[2] - GROUND[2]) * hemi) * 0.42 * ao * ambient;
    // Each light adds its diffuse and its Blinn highlight in its own colour, shadowed towards itself.
    let dR = 0, dG = 0, dB = 0, sR = 0, sG = 0, sB = 0;
    const gloss = 1 - rough;
    for (let li = 0; li < NL; li++) {
      const l = lights[li];
      let Lx = l.dir[0], Ly = l.dir[1], Lz = l.dir[2], k = 1, far = Infinity;
      if (l.pos) {
        const ex = l.pos[0] - px, ey = l.pos[1] - py, ez = l.pos[2] - pz;
        far = Math.hypot(ex, ey, ez) || 1e-9;
        Lx = ex / far; Ly = ey / far; Lz = ez / far;
        k = (l.range * l.range) / (l.range * l.range + far * far);
      }
      const nl = Math.max(0, nx * Lx + ny * Ly + nz * Lz);
      const sh = nl > 0 ? shadow(px + nx * cell, py + ny * cell, pz + nz * cell, Lx, Ly, Lz, l.softness, far) : 1;
      const d = nl * sh * 0.85 * (1 - metal * 0.6) * l.power * k;
      const hx = Lx - vx, hy = Ly - vy, hz = Lz - vz;
      const hl = Math.hypot(hx, hy, hz) || 1;
      const nh = Math.max(0, (nx * hx + ny * hy + nz * hz) / hl);
      const s = Math.pow(nh, 4 + gloss * gloss * 160) * (0.05 + gloss * 0.7) * sh * (0.4 + nl) * l.power * k;
      dR += d * l.color[0]; dG += d * l.color[1]; dB += d * l.color[2];
      sR += s * l.color[0]; sG += s * l.color[1]; sB += s * l.color[2];
    }
    const fres = Math.pow(1 - Math.max(0, -(nx * vx + ny * vy + nz * vz)), 4) * 0.08 * ao;
    const tR = metal > 0 ? br * (0.3 + 0.7 * metal) + (1 - metal) : 1;
    const tG = metal > 0 ? bg * (0.3 + 0.7 * metal) + (1 - metal) : 1;
    const tB = metal > 0 ? bb * (0.3 + 0.7 * metal) + (1 - metal) : 1;
    // A metal is mostly what it reflects: the environment along the mirrored view ray, tinted by its own colour.
    // One bounce only (measured: gold and silver read as olive and charcoal without it), and blurred by roughness
    // towards the plain sky/ground average so a matte metal does not mirror.
    let rR = 0, rG = 0, rB = 0;
    if (metal > 0.02 && depth === 0) {
      const kk = 2 * (vx * nx + vy * ny + vz * nz);
      const qx = vx - kk * nx, qy = vy - kk * ny, qz = vz - kk * nz;
      seeThrough(px + nx * cell * 2, py + ny * cell * 2, pz + nz * cell * 2, qx, qy, qz, SEEN, depth + 1);
      backdrop(qy, SOFT);
      const g = gloss * gloss;
      const strength = metal * (0.35 + 0.45 * gloss) * ao;
      rR = (SEEN[0] * g + SOFT[0] * (1 - g)) * strength;
      rG = (SEEN[1] * g + SOFT[1] * (1 - g)) * strength;
      rB = (SEEN[2] * g + SOFT[2] * (1 - g)) * strength;
    }
    // Glow: light the surface gives off, unshadowed; a flame reads as a flame inside a dark lantern.
    out[0] = Math.min(1, br * (ambR + dR + rR + glow) + sR * tR + fres * SKY[0]);
    out[1] = Math.min(1, bg * (ambG + dG + rG + glow) + sG * tG + fres * SKY[1]);
    out[2] = Math.min(1, bb * (ambB + dB + rB + glow) + sB * tB + fres * SKY[2]);
  };

  /**
   * March from `from` along `dir` until the field crosses zero (entering if `entering`), up to `maxT`. An inside
   * march also averages the colour of the materials it passes through into `tintOut`, so a drink inside a glass wall
   * tints the light the way it should.
   */
  const march = (fx: number, fy: number, fz: number, dx: number, dy: number, dz: number, entering: boolean, maxT: number, tintOut?: Float64Array): number => {
    let t = cell * 0.5;
    let samples = 0;
    if (tintOut) { tintOut[0] = 0; tintOut[1] = 0; tintOut[2] = 0; }
    // Inside a solid the nearest surface is often a wall running alongside the ray, so steps stay short; the inside
    // march gets more of them and a larger minimum step.
    const limit = entering ? 96 : 400;
    const minStep = entering ? cell * 0.05 : cell * 0.5;
    for (let i = 0; i < limit && t < maxT; i++) {
      const x = fx + dx * t, y = fy + dy * t, z = fz + dz * t;
      let d = dist(x, y, z);
      if (!entering) d = -d;
      if (d < cell * 0.05) break;
      if (tintOut && i % 4 === 0) {
        const h = shape.hit(x, y, z);
        if (h.mat.transmit > 0) { const c = h.mat.color; tintOut[0] += c[0]; tintOut[1] += c[1]; tintOut[2] += c[2]; }
        else { tintOut[0] += 0.2; tintOut[1] += 0.2; tintOut[2] += 0.2; }
        samples++;
      }
      t += Math.max(d * 0.9, minStep);
    }
    if (tintOut && samples > 0) { tintOut[0] /= samples; tintOut[1] /= samples; tintOut[2] /= samples; }
    return t < maxT ? t : -1;
  };

  /** Refract d about n by eta into out; false on total internal reflection. */
  const refractInto = (dx: number, dy: number, dz: number, nx: number, ny: number, nz: number, eta: number, out: Float64Array): boolean => {
    const cosi = -(dx * nx + dy * ny + dz * nz);
    const k = 1 - eta * eta * (1 - cosi * cosi);
    if (k < 0) return false;
    const a = eta * cosi - Math.sqrt(k);
    const x = eta * dx + a * nx, y = eta * dy + a * ny, z = eta * dz + a * nz;
    const l = Math.sqrt(x * x + y * y + z * z) || 1;
    out[0] = x / l; out[1] = y / l; out[2] = z / l;
    return true;
  };

  /** What a ray sees after leaving a surface, into `out`: another opaque surface (shaded, no further glass), the floor, or the sky. */
  const seeThrough = (fx: number, fy: number, fz: number, dx: number, dy: number, dz: number, out: Float64Array, depth = 1): void => {
    const t = march(fx, fy, fz, dx, dy, dz, true, reach * 2);
    if (t > 0) {
      const px = fx + dx * t, py = fy + dy * t, pz = fz + dz * t;
      gradientInto(px, py, pz, G1);
      const h = shape.hit(px, py, pz);
      if (h.mat.transmit > 0) {
        // Glass again (a second pane, or the same one at a grazing angle): the backdrop through it, tinted, no more bounces.
        const base = albedo(h.mat, h.lx, h.ly, h.lz);
        backdrop(dy, BD2);
        const tr = h.mat.transmit;
        out[0] = BD2[0] * (base[0] * tr + (1 - tr)); out[1] = BD2[1] * (base[1] * tr + (1 - tr)); out[2] = BD2[2] * (base[2] * tr + (1 - tr));
        return;
      }
      finishAt(px, py, pz, G1[0], G1[1], G1[2], h);
      shadePoint(out, px, py, pz, fin.nx, fin.ny, fin.nz, fin.r, fin.g, fin.b, fin.metal, fin.rough, dx, dy, dz, depth, fin.glow);
      return;
    }
    if (dy < -1e-6) {
      const tf = (floorY - fy) / dy;
      floorLight(fx + dx * tf, floorY + cell, fz + dz * tf, FL);
      out[0] = FLOOR[0] * FL[0]; out[1] = FLOOR[1] * FL[1]; out[2] = FLOOR[2] * FL[2];
      return;
    }
    backdrop(dy, out);
  };

  const shadeGlass = (out: Float64Array, px: number, py: number, pz: number, nx: number, ny: number, nz: number, mat: Material, br: number, bg: number, bb: number, dx: number, dy: number, dz: number): void => {
    const cos = Math.max(0, -(nx * dx + ny * dy + nz * dz));
    const fres = 0.04 + 0.96 * Math.pow(1 - cos, 5);
    // Reflection: the backdrop and the key highlight.
    const kk = 2 * (dx * nx + dy * ny + dz * nz);
    const qx = dx - kk * nx, qy = dy - kk * ny, qz = dz - kk * nz;
    seeThrough(px + nx * cell * 2, py + ny * cell * 2, pz + nz * cell * 2, qx, qy, qz, GREFL);
    shadePoint(GSPEC, px, py, pz, nx, ny, nz, 0, 0, 0, 0, mat.rough, dx, dy, dz, 0, 0);
    // Refraction: into the glass, across it, and out.
    backdrop(dy, GTHRU);
    if (refractInto(dx, dy, dz, nx, ny, nz, 1 / 1.5, GIN)) {
      const ex = px - nx * cell, ey = py - ny * cell, ez = pz - nz * cell;
      const ix = GIN[0], iy = GIN[1], iz = GIN[2];
      const tExit = march(ex, ey, ez, ix, iy, iz, false, reach * 2, GPASS);
      if (tExit > 0) {
        const qx2 = ex + ix * tExit, qy2 = ey + iy * tExit, qz2 = ez + iz * tExit;
        gradientInto(qx2, qy2, qz2, G2);
        const gx = G2[0], gy = G2[1], gz = G2[2];
        // Total internal reflection would bounce around inside; settle for the backdrop in the ray's direction.
        if (refractInto(ix, iy, iz, -gx, -gy, -gz, 1.5, GOUT)) seeThrough(qx2 + gx * cell * 2, qy2 + gy * cell * 2, qz2 + gz * cell * 2, GOUT[0], GOUT[1], GOUT[2], GSEEN);
        else backdrop(iy, GSEEN);
        // Absorption tints by thickness: the colour of what was passed through is what survives.
        const k = tExit / Math.max(reach * 0.15, 1e-6);
        GTHRU[0] = GSEEN[0] * Math.exp(-k * (1 - GPASS[0]) * 1.5);
        GTHRU[1] = GSEEN[1] * Math.exp(-k * (1 - GPASS[1]) * 1.5);
        GTHRU[2] = GSEEN[2] * Math.exp(-k * (1 - GPASS[2]) * 1.5);
      }
    }
    const tr = mat.transmit;
    shadePoint(GOPQ, px, py, pz, nx, ny, nz, br, bg, bb, 0, mat.rough, dx, dy, dz, 0, 0);
    out[0] = Math.min(1, (GTHRU[0] * (1 - fres) + GREFL[0] * fres) * tr + GOPQ[0] * (1 - tr) + GSPEC[0] * 0.5);
    out[1] = Math.min(1, (GTHRU[1] * (1 - fres) + GREFL[1] * fres) * tr + GOPQ[1] * (1 - tr) + GSPEC[1] * 0.5);
    out[2] = Math.min(1, (GTHRU[2] * (1 - fres) + GREFL[2] * fres) * tr + GOPQ[2] * (1 - tr) + GSPEC[2] * 0.5);
  };

  // The far floor's light: the ambient floor and each directional light's share (a point light does not reach it).
  const farR = 0.62 * pal.ambient + 0.38 * lights.reduce((s, l) => s + (l.pos ? 0 : (Math.max(0, l.dir[1]) * l.power * l.color[0]) / totalPower), 0);
  const farG = 0.62 * pal.ambient + 0.38 * lights.reduce((s, l) => s + (l.pos ? 0 : (Math.max(0, l.dir[1]) * l.power * l.color[1]) / totalPower), 0);
  const farB = 0.62 * pal.ambient + 0.38 * lights.reduce((s, l) => s + (l.pos ? 0 : (Math.max(0, l.dir[1]) * l.power * l.color[2]) / totalPower), 0);

  /** One sample through (px, py), primed at the mesh's depth: its colour into COL, and its depth, normal, material and glow. */
  const sample = (px: number, py: number, primedDepth: number): void => {
    rayDirInto(px, py, RD);
    const dx = RD[0], dy = RD[1], dz = RD[2];
    const along = dx * cam.forward[0] + dy * cam.forward[1] + dz * cam.forward[2];
    let hitT = -1;
    if (Number.isFinite(primedDepth)) {
      const centre = primedDepth / along;
      let t = Math.max(0, centre - cell * 3);
      const tEnd = centre + cell * 3;
      for (let i = 0; i < 40 && t < tEnd; i++) {
        const d = dist(eye[0] + dx * t, eye[1] + dy * t, eye[2] + dz * t);
        if (d < cell * 0.05) { hitT = t; break; }
        t += Math.max(d * 0.9, cell * 0.02);
      }
      if (hitT < 0) hitT = centre; // the mesh knows where the surface is; trust it
    }
    if (hitT >= 0) {
      const px3 = eye[0] + dx * hitT, py3 = eye[1] + dy * hitT, pz3 = eye[2] + dz * hitT;
      gradientInto(px3, py3, pz3, G0);
      const h = shape.hit(px3, py3, pz3);
      if (h.mat.transmit > 0) {
        const a = albedo(h.mat, h.lx, h.ly, h.lz);
        shadeGlass(COL, px3, py3, pz3, G0[0], G0[1], G0[2], h.mat, a[0], a[1], a[2], dx, dy, dz);
        sGlow = h.mat.glow > 0;
      } else {
        finishAt(px3, py3, pz3, G0[0], G0[1], G0[2], h);
        // Read before shading: a metal's reflection shades what it sees through finishAt too.
        sGlow = fin.glow > 0;
        shadePoint(COL, px3, py3, pz3, fin.nx, fin.ny, fin.nz, fin.r, fin.g, fin.b, fin.metal, fin.rough, dx, dy, dz, 0, fin.glow);
      }
      // The edge test reads the field's normal, not the bumped one: a bump is texture, not a silhouette to supersample.
      sDepth = hitT; sNx = G0[0]; sNy = G0[1]; sNz = G0[2]; sMat = ids(h.mat);
      return;
    }
    sGlow = false;
    // Floor or sky.
    if (dy < -1e-6) {
      const t = (floorY - eye[1]) / dy;
      const fx = eye[0] + dx * t, fz = eye[2] + dz * t;
      // Near the model the floor is lit and shadowed properly; far off a flat estimate stands in. The two are
      // blended over the last third of the reach, since a hard switch drew a seam across a top-down shot (round 9).
      const away = boundsDistance(model, fx, floorY, fz);
      const w = away >= reach ? 0 : away <= reach * 0.66 ? 1 : (reach - away) / (reach * 0.34);
      let nR = farR, nG = farG, nB = farB, nearAo = 1;
      if (w > 0) {
        floorLight(fx, floorY + cell, fz, FL);
        nR = FL[0]; nG = FL[1]; nB = FL[2];
        nearAo = occlusion(fx, floorY, fz, 0, 1, 0);
      }
      const litR = farR + (nR * nearAo - farR) * w, litG = farG + (nG * nearAo - farG) * w, litB = farB + (nB * nearAo - farB) * w;
      const fade = Math.min(1, t / (reach * 4));
      const cR = FLOOR[0] * litR * 1, cG = FLOOR[1] * litG * 1, cB = FLOOR[2] * litB * 1;
      COL[0] = cR + (GROUND[0] - cR) * fade; COL[1] = cG + (GROUND[1] - cG) * fade; COL[2] = cB + (GROUND[2] - cB) * fade;
      sDepth = t; sNx = 0; sNy = 1; sNz = 0; sMat = -2;
      return;
    }
    backdrop(dy, COL);
    sDepth = Infinity; sNx = 0; sNy = 0; sNz = 0; sMat = -3;
  };

  const primary = (py: number): void => {
    for (let px = 0; px < size; px++) {
      const i = py * size + px;
      sample(px + 0.5, py + 0.5, prime[i]);
      col[i * 3] = COL[0]; col[i * 3 + 1] = COL[1]; col[i * 3 + 2] = COL[2];
      depthBuf[i] = sDepth; normalBuf[i * 3] = sNx; normalBuf[i * 3 + 1] = sNy; normalBuf[i * 3 + 2] = sNz; matBuf[i] = sMat;
      glowBuf[i] = sGlow ? 1 : 0;
    }
  };

  // Edge pixels get four samples. The mesh depth primes them with the neighbour that has one.
  const isEdge = (i: number, j: number): boolean => {
    if (matBuf[i] !== matBuf[j]) return true;
    const a = depthBuf[i], b = depthBuf[j];
    if (Number.isFinite(a) !== Number.isFinite(b)) return true;
    if (Number.isFinite(a) && Math.abs(a - b) > cell * 4) return true;
    return normalBuf[i * 3] * normalBuf[j * 3] + normalBuf[i * 3 + 1] * normalBuf[j * 3 + 1] + normalBuf[i * 3 + 2] * normalBuf[j * 3 + 2] < 0.6;
  };
  const OFFS = [0.25, 0.25, 0.75, 0.25, 0.25, 0.75, 0.75, 0.75];
  // Writes only row py's colours; the edge test reads depth, normal and material, which no edge pass writes.
  const edges = (py: number): void => {
    for (let px = 0; px < size; px++) {
      const i = py * size + px;
      const edge = (px + 1 < size && isEdge(i, i + 1)) || (py + 1 < size && isEdge(i, i + size)) || (px > 0 && isEdge(i, i - 1)) || (py > 0 && isEdge(i, i - size));
      if (!edge) continue;
      // Prime with the nearest finite depth among the neighbours; the march window finds the surface if it is there.
      let d = prime[i];
      if (!Number.isFinite(d)) d = Math.min(prime[i], px + 1 < size ? prime[i + 1] : Infinity, py + 1 < size ? prime[i + size] : Infinity, px > 0 ? prime[i - 1] : Infinity, py > 0 ? prime[i - size] : Infinity);
      let r = 0, g = 0, b = 0;
      for (let k = 0; k < 4; k++) {
        sample(px + OFFS[k * 2], py + OFFS[k * 2 + 1], d);
        r += COL[0]; g += COL[1]; b += COL[2];
      }
      col[i * 3] = r / 4; col[i * 3 + 1] = g / 4; col[i * 3 + 2] = b / 4;
    }
  };

  return { primary, edges };
}

/**
 * Depth of field as a post-process: each pixel is blurred by a circle whose radius grows with its distance from the
 * focus plane through the model's centre. A gather blur keeps it cheap.
 */
function depthOfField(canvas: Canvas, depths: Float64Array, size: number, strength: number, centre: Vec3, cam: Camera): void {
  const focus = -toView(cam, centre)[2];
  const maxRadius = Math.max(1, Math.round(size * 0.012 * strength * 3));
  const radiusAt = (d: number): number => {
    if (!Number.isFinite(d)) return maxRadius;
    return Math.min(maxRadius, (Math.abs(d - focus) / Math.max(focus, 1e-6)) * size * 0.012 * strength * 4);
  };
  const src = new Uint8Array(canvas.data);
  const get = (x: number, y: number, k: number) => src[(y * size + x) * 4 + k];
  for (let y = 0; y < size; y++)
    for (let x = 0; x < size; x++) {
      const r = radiusAt(depths[y * size + x]);
      if (r < 0.75) continue;
      const ir = Math.ceil(r);
      let sr = 0, sg = 0, sb = 0, n = 0;
      const step = ir > 4 ? 2 : 1;
      for (let dy = -ir; dy <= ir; dy += step)
        for (let dx = -ir; dx <= ir; dx += step) {
          if (dx * dx + dy * dy > r * r) continue;
          const sx = x + dx, sy = y + dy;
          if (sx < 0 || sy < 0 || sx >= size || sy >= size) continue;
          // A sharp foreground pixel should not bleed into a blurred one behind it much: weight by its own blur.
          const w = 0.3 + 0.7 * Math.min(1, radiusAt(depths[sy * size + sx]) / Math.max(r, 1e-6));
          sr += get(sx, sy, 0) * w; sg += get(sx, sy, 1) * w; sb += get(sx, sy, 2) * w; n += w;
        }
      if (n > 0) canvas.set(x, y, ((Math.round(sr / n) & 255) << 16) | ((Math.round(sg / n) & 255) << 8) | (Math.round(sb / n) & 255));
    }
}
