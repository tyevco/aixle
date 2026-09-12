/**
 * The beauty render: the distance field itself, ray-marched, with soft
 * shadows, ambient occlusion and a studio floor. The checking views draw
 * the extracted mesh because that is the file you get; this one draws the
 * field because that is the model you meant, at full sharpness.
 *
 * It is kept affordable by starting each ray where the rasterised mesh says
 * the surface is (a few cells short of it) and marching only that window,
 * so empty space costs nothing. Shadow rays are skipped when they cannot
 * reach the model's bounding box. Edge pixels, found by comparing depth,
 * normal and material with their neighbours, are re-rendered with four
 * samples, so silhouettes are smooth without paying for it everywhere.
 */
import { normalize, type Vec3 } from "../core/vec.js";
import { albedo } from "../sdf/materials.js";
import { boundsCenter, boundsDistance, boundsGrow, boundsSize, type Bounds, type Material, type Shape3 } from "../sdf/types.js";
import type { Mesh } from "../mesh/mesh.js";
import { perspective, toView, type Camera } from "./camera.js";
import { Canvas, rgbf, rgbDithered } from "./canvas.js";
import { drawText } from "./font.js";
import { createTarget, renderMesh } from "./raster.js";
import { INK } from "./views.js";

export interface BeautyOptions {
  size: number;
  /** Cell size of the extraction, for step tolerances. */
  cellSize: number;
  azimuth?: number;
  elevation?: number;
  label?: string;
  /** Apparent size of the key light: 0.5 is a small lamp with crisp shadows, 3 a window; default 1. */
  lightSize?: number;
  /** Depth of field: 0 off; 1 blurs a plane one model-size away by about 1% of the image. */
  dof?: number;
  /** Where the key light comes from, in degrees: azimuth about y (0 is +z, the front; 90 is +x) and elevation above the floor. Default -40 and 55. */
  lightAzimuth?: number;
  lightElevation?: number;
  /** Multiplier on the sky and ground light, 1 by default: 2 lifts a shaded interior, 0.5 is a dark room. */
  ambient?: number;
  /** Camera zoom: 1 fits the model's bounding sphere, 1.4 fills the frame with a box-shaped model. */
  zoom?: number;
}

/** The default key light: upper left, from the front. */
const DEFAULT_LIGHT: Vec3 = normalize([-0.55, 0.9, 0.65]);
const SKY: Vec3 = [0.78, 0.83, 0.9];
const GROUND: Vec3 = [0.93, 0.92, 0.9];
const FLOOR: Vec3 = [0.88, 0.87, 0.85];

interface Sample {
  color: Vec3;
  depth: number;
  normal: Vec3;
  matId: number;
}

export function renderBeauty(shape: Shape3, mesh: Mesh, bounds: Bounds, opts: BeautyOptions): Canvas {
  const size = opts.size;
  const LIGHT: Vec3 =
    opts.lightAzimuth === undefined && opts.lightElevation === undefined
      ? DEFAULT_LIGHT
      : (() => {
          const az = ((opts.lightAzimuth ?? -40) * Math.PI) / 180, el = ((opts.lightElevation ?? 55) * Math.PI) / 180;
          return normalize([Math.sin(az) * Math.cos(el), Math.sin(el), Math.cos(az) * Math.cos(el)]);
        })();
  const ambient = Math.max(0, opts.ambient ?? 1);
  const cam: Camera = perspective(bounds, size, size, opts.azimuth ?? 35, opts.elevation ?? 25, 30, opts.zoom ?? 1);
  const cell = Math.max(opts.cellSize, 1e-4);
  const floorY = Math.min(0, bounds.min[1]);
  const shadowBox = boundsGrow(bounds, cell);
  const reach = Math.hypot(...boundsSize(bounds)) * 1.5;
  const dist = shape.dist;

  // Prime with the mesh: view depth per pixel.
  const prime = createTarget(size, size, 0);
  renderMesh(mesh, cam, prime, { background: 0, outline: false, solidGlass: true });
  const f = size / 2 / Math.tan(((cam.fov ?? 30) * Math.PI) / 360);

  const rayDir = (px: number, py: number): Vec3 => {
    const x = (px - size / 2) / f, y = -(py - size / 2) / f;
    return normalize([
      cam.right[0] * x + cam.up[0] * y + cam.forward[0],
      cam.right[1] * x + cam.up[1] * y + cam.forward[1],
      cam.right[2] * x + cam.up[2] * y + cam.forward[2],
    ]);
  };
  const eye = cam.eye;
  const eps = cell * 0.5;
  const gradient = (x: number, y: number, z: number): Vec3 =>
    normalize([dist(x + eps, y, z) - dist(x - eps, y, z), dist(x, y + eps, z) - dist(x, y - eps, z), dist(x, y, z + eps) - dist(x, y, z - eps)]);

  /** 0 = fully shadowed, 1 = lit; skipped when the ray cannot reach the model's box. */
  const softness = 6 / Math.max(0.1, opts.lightSize ?? 1);
  const shadow = (p: Vec3): number => {
    // Ray-box test against the shadow box.
    let tmin = 0, tmax = reach;
    for (let a = 0; a < 3; a++) {
      const inv = 1 / LIGHT[a];
      let t0 = (shadowBox.min[a] - p[a]) * inv, t1 = (shadowBox.max[a] - p[a]) * inv;
      if (t0 > t1) [t0, t1] = [t1, t0];
      tmin = Math.max(tmin, t0);
      tmax = Math.min(tmax, t1);
    }
    if (tmax < tmin) return 1;
    let res = 1;
    let t = Math.max(tmin, cell * 1.5);
    let passes = 0;
    for (let i = 0; i < 64 && t < tmax; i++) {
      const x = p[0] + LIGHT[0] * t, y = p[1] + LIGHT[1] * t, z = p[2] + LIGHT[2] * t;
      const d = dist(x, y, z);
      if (d < cell * 0.05) {
        // Glass lets light through, dimmed; step across it and carry on.
        const tr = shape.hit(x, y, z).mat.transmit;
        if (tr <= 0 || passes++ > 3) { res = 0; break; }
        res *= 0.35 + 0.65 * tr * 0.6;
        let inside = 0;
        while (inside++ < 200 && t < tmax && dist(p[0] + LIGHT[0] * t, p[1] + LIGHT[1] * t, p[2] + LIGHT[2] * t) < cell * 0.05) t += cell * 2;
        t += cell;
        continue;
      }
      res = Math.min(res, (softness * d) / t);
      t += Math.max(d, cell * 0.5);
    }
    return Math.max(0, Math.min(1, res));
  };

  const occlusion = (p: Vec3, n: Vec3): number => {
    let occ = 0, w = 1;
    for (let i = 1; i <= 5; i++) {
      const h = cell * 1.5 * i * i * 0.4 + cell;
      const d = dist(p[0] + n[0] * h, p[1] + n[1] * h, p[2] + n[2] * h);
      occ += w * Math.max(0, h - d);
      w *= 0.7;
    }
    // Never fully black: a concave join still gets bounce light.
    return Math.max(0.3, Math.min(1, 1 - (0.8 * occ) / (cell * 4)));
  };

  const shadePoint = (p: Vec3, n: Vec3, base: Vec3, metal: number, rough: number, view: Vec3, depth = 0, glow = 0): Vec3 => {
    const nl = Math.max(0, n[0] * LIGHT[0] + n[1] * LIGHT[1] + n[2] * LIGHT[2]);
    const sh = nl > 0 ? shadow([p[0] + n[0] * cell, p[1] + n[1] * cell, p[2] + n[2] * cell]) : 1;
    const ao = occlusion(p, n);
    const hemi = 0.5 + 0.5 * n[1];
    const amb: Vec3 = [
      (GROUND[0] + (SKY[0] - GROUND[0]) * hemi) * 0.42 * ao * ambient,
      (GROUND[1] + (SKY[1] - GROUND[1]) * hemi) * 0.42 * ao * ambient,
      (GROUND[2] + (SKY[2] - GROUND[2]) * hemi) * 0.42 * ao * ambient,
    ];
    const diff = nl * sh * 0.85 * (1 - metal * 0.6);
    // Blinn highlight.
    const hx = LIGHT[0] - view[0], hy = LIGHT[1] - view[1], hz = LIGHT[2] - view[2];
    const hl = Math.hypot(hx, hy, hz) || 1;
    const nh = Math.max(0, (n[0] * hx + n[1] * hy + n[2] * hz) / hl);
    const gloss = 1 - rough;
    const spec = Math.pow(nh, 4 + gloss * gloss * 160) * (0.05 + gloss * 0.7) * sh * (0.4 + nl);
    const fres = Math.pow(1 - Math.max(0, -(n[0] * view[0] + n[1] * view[1] + n[2] * view[2])), 4) * 0.08 * ao;
    const tint = (c: number) => (metal > 0 ? c * (0.3 + 0.7 * metal) + (1 - metal) : 1);
    // A metal is mostly what it reflects: the environment along the mirrored view ray, tinted by its own colour.
    // One bounce only (measured: gold and silver read as olive and charcoal without it), and blurred by roughness
    // towards the plain sky/ground average so a matte metal does not mirror.
    let refl: Vec3 = [0, 0, 0];
    if (metal > 0.02 && depth === 0) {
      const r = reflect(view, n);
      const seen = seeThrough([p[0] + n[0] * cell * 2, p[1] + n[1] * cell * 2, p[2] + n[2] * cell * 2], r, depth + 1);
      const soft = backdrop(r);
      const g = gloss * gloss;
      const strength = metal * (0.35 + 0.45 * gloss) * ao;
      refl = [
        (seen[0] * g + soft[0] * (1 - g)) * strength,
        (seen[1] * g + soft[1] * (1 - g)) * strength,
        (seen[2] * g + soft[2] * (1 - g)) * strength,
      ];
    }
    // Glow: light the surface gives off, unshadowed; a flame reads as a flame inside a dark lantern.
    return [
      Math.min(1, base[0] * (amb[0] + diff + refl[0] + glow) + spec * tint(base[0]) + fres * SKY[0]),
      Math.min(1, base[1] * (amb[1] + diff + refl[1] + glow) + spec * tint(base[1]) + fres * SKY[1]),
      Math.min(1, base[2] * (amb[2] + diff + refl[2] + glow) + spec * tint(base[2]) + fres * SKY[2]),
    ];
  };

  /**
   * March from `from` along `dir` until the field crosses zero (entering if
   * `entering`), up to `maxT`. An inside march also averages the colour of
   * the materials it passes through into `tintOut`, so a drink inside a
   * glass wall tints the light the way it should.
   */
  const march = (from: Vec3, dir: Vec3, entering: boolean, maxT: number, tintOut?: Vec3): number => {
    let t = cell * 0.5;
    let samples = 0;
    if (tintOut) { tintOut[0] = 0; tintOut[1] = 0; tintOut[2] = 0; }
    // Inside a solid the nearest surface is often a wall running alongside
    // the ray, so steps stay short; the inside march gets more of them and a
    // larger minimum step.
    const limit = entering ? 96 : 400;
    const minStep = entering ? cell * 0.05 : cell * 0.5;
    for (let i = 0; i < limit && t < maxT; i++) {
      const x = from[0] + dir[0] * t, y = from[1] + dir[1] * t, z = from[2] + dir[2] * t;
      let d = dist(x, y, z);
      if (!entering) d = -d;
      if (d < cell * 0.05) break;
      if (tintOut && i % 4 === 0) {
        const h = shape.hit(x, y, z);
        const c = h.mat.transmit > 0 ? h.mat.color : [0.2, 0.2, 0.2];
        tintOut[0] += c[0]; tintOut[1] += c[1]; tintOut[2] += c[2];
        samples++;
      }
      t += Math.max(d * 0.9, minStep);
    }
    if (tintOut && samples > 0) { tintOut[0] /= samples; tintOut[1] /= samples; tintOut[2] /= samples; }
    return t < maxT ? t : -1;
  };
  const backdrop = (dir: Vec3): Vec3 => {
    if (dir[1] < -1e-6) {
      const fade = 0.6;
      return [FLOOR[0] * 0.95 + (GROUND[0] - FLOOR[0] * 0.95) * fade, FLOOR[1] * 0.95 + (GROUND[1] - FLOOR[1] * 0.95) * fade, FLOOR[2] * 0.95 + (GROUND[2] - FLOOR[2] * 0.95) * fade];
    }
    const k = Math.min(1, Math.max(0, dir[1] * 2.5));
    return [GROUND[0] + (SKY[0] - GROUND[0]) * k, GROUND[1] + (SKY[1] - GROUND[1]) * k, GROUND[2] + (SKY[2] - GROUND[2]) * k];
  };
  const refract = (d: Vec3, n: Vec3, eta: number): Vec3 | undefined => {
    const cosi = -(d[0] * n[0] + d[1] * n[1] + d[2] * n[2]);
    const k = 1 - eta * eta * (1 - cosi * cosi);
    if (k < 0) return undefined;
    const a = eta * cosi - Math.sqrt(k);
    return normalize([eta * d[0] + a * n[0], eta * d[1] + a * n[1], eta * d[2] + a * n[2]]);
  };
  const reflect = (d: Vec3, n: Vec3): Vec3 => {
    const k = 2 * (d[0] * n[0] + d[1] * n[1] + d[2] * n[2]);
    return [d[0] - k * n[0], d[1] - k * n[1], d[2] - k * n[2]];
  };
  /** What a ray sees after leaving a glass surface: another opaque surface (shaded, no further glass), the floor, or the sky. */
  const seeThrough = (from: Vec3, dir: Vec3, depth = 1): Vec3 => {
    const t = march(from, dir, true, reach * 2);
    if (t > 0) {
      const p: Vec3 = [from[0] + dir[0] * t, from[1] + dir[1] * t, from[2] + dir[2] * t];
      const n = gradient(p[0], p[1], p[2]);
      const h = shape.hit(p[0], p[1], p[2]);
      const base = albedo(h.mat, h.lx, h.ly, h.lz);
      if (h.mat.transmit > 0) {
        // Glass again (a second pane, or the same one at a grazing angle): the backdrop through it, tinted, no more bounces.
        const bd = backdrop(dir);
        const tr = h.mat.transmit;
        return [bd[0] * (base[0] * tr + (1 - tr)), bd[1] * (base[1] * tr + (1 - tr)), bd[2] * (base[2] * tr + (1 - tr))];
      }
      return shadePoint(p, n, base, h.mat.metal, h.mat.rough, dir, depth, h.mat.glow);
    }
    if (dir[1] < -1e-6) {
      const tf = (floorY - from[1]) / dir[1];
      const p: Vec3 = [from[0] + dir[0] * tf, floorY, from[2] + dir[2] * tf];
      const sh = shadow([p[0], p[1] + cell, p[2]]);
      const light = 0.62 + 0.38 * sh * LIGHT[1];
      return [FLOOR[0] * light, FLOOR[1] * light, FLOOR[2] * light];
    }
    return backdrop(dir);
  };
  const shadeGlass = (p: Vec3, n: Vec3, mat: Material, base: Vec3, dir: Vec3): Vec3 => {
    const cos = Math.max(0, -(n[0] * dir[0] + n[1] * dir[1] + n[2] * dir[2]));
    const fres = 0.04 + 0.96 * Math.pow(1 - cos, 5);
    // Reflection: the backdrop and the key highlight.
    const r = reflect(dir, n);
    const refl = seeThrough([p[0] + n[0] * cell * 2, p[1] + n[1] * cell * 2, p[2] + n[2] * cell * 2], r);
    const spec = shadePoint(p, n, [0, 0, 0], 0, mat.rough, dir);
    // Refraction: into the glass, across it, and out.
    let through: Vec3 = backdrop(dir);
    const inDir = refract(dir, n, 1 / 1.5);
    if (inDir) {
      const entry: Vec3 = [p[0] - n[0] * cell, p[1] - n[1] * cell, p[2] - n[2] * cell];
      const passed: Vec3 = [base[0], base[1], base[2]];
      const tExit = march(entry, inDir, false, reach * 2, passed);
      if (tExit > 0) {
        const q: Vec3 = [entry[0] + inDir[0] * tExit, entry[1] + inDir[1] * tExit, entry[2] + inDir[2] * tExit];
        const ng = gradient(q[0], q[1], q[2]);
        const nOut: Vec3 = [-ng[0], -ng[1], -ng[2]];
        const outDir = refract(inDir, nOut, 1.5);
        // Total internal reflection would bounce around inside; settle for the backdrop in the ray's direction.
        const seen = outDir ? seeThrough([q[0] + ng[0] * cell * 2, q[1] + ng[1] * cell * 2, q[2] + ng[2] * cell * 2], outDir) : backdrop(inDir);
        // Absorption tints by thickness: the colour of what was passed through is what survives.
        const k = tExit / Math.max(reach * 0.15, 1e-6);
        const tint = (c: number) => Math.exp(-k * (1 - c) * 1.5);
        through = [seen[0] * tint(passed[0]), seen[1] * tint(passed[1]), seen[2] * tint(passed[2])];
      }
    }
    const tr = mat.transmit;
    const opaque = shadePoint(p, n, base, 0, mat.rough, dir);
    return [
      Math.min(1, (through[0] * (1 - fres) + refl[0] * fres) * tr + opaque[0] * (1 - tr) + spec[0] * 0.5),
      Math.min(1, (through[1] * (1 - fres) + refl[1] * fres) * tr + opaque[1] * (1 - tr) + spec[1] * 0.5),
      Math.min(1, (through[2] * (1 - fres) + refl[2] * fres) * tr + opaque[2] * (1 - tr) + spec[2] * 0.5),
    ];
  };

  const sample = (px: number, py: number, primedDepth: number): Sample => {
    const dir = rayDir(px, py);
    const along = dir[0] * cam.forward[0] + dir[1] * cam.forward[1] + dir[2] * cam.forward[2];
    let hitT = -1;
    if (Number.isFinite(primedDepth)) {
      const centre = primedDepth / along;
      let t = Math.max(0, centre - cell * 3);
      const tEnd = centre + cell * 3;
      for (let i = 0; i < 40 && t < tEnd; i++) {
        const d = dist(eye[0] + dir[0] * t, eye[1] + dir[1] * t, eye[2] + dir[2] * t);
        if (d < cell * 0.05) { hitT = t; break; }
        t += Math.max(d * 0.9, cell * 0.02);
      }
      if (hitT < 0) hitT = centre; // the mesh knows where the surface is; trust it
    }
    if (hitT >= 0) {
      const p: Vec3 = [eye[0] + dir[0] * hitT, eye[1] + dir[1] * hitT, eye[2] + dir[2] * hitT];
      const n = gradient(p[0], p[1], p[2]);
      const h = shape.hit(p[0], p[1], p[2]);
      const base = albedo(h.mat, h.lx, h.ly, h.lz);
      const color = h.mat.transmit > 0 ? shadeGlass(p, n, h.mat, base, dir) : shadePoint(p, n, base, h.mat.metal, h.mat.rough, dir, 0, h.mat.glow);
      return { color, depth: hitT, normal: n, matId: mesh.materials.indexOf(h.mat) };
    }
    // Floor or sky.
    if (dir[1] < -1e-6) {
      const t = (floorY - eye[1]) / dir[1];
      const p: Vec3 = [eye[0] + dir[0] * t, floorY, eye[2] + dir[2] * t];
      const n: Vec3 = [0, 1, 0];
      const near = boundsDistance(bounds, p[0], p[1], p[2]) < reach;
      const sh = near ? shadow([p[0], p[1] + cell, p[2]]) : 1;
      const ao = near ? occlusion(p, n) : 1;
      const light = 0.62 + 0.38 * sh * LIGHT[1];
      const fade = Math.min(1, t / (reach * 4));
      const c: Vec3 = [FLOOR[0] * light * ao, FLOOR[1] * light * ao, FLOOR[2] * light * ao];
      return { color: [c[0] + (GROUND[0] - c[0]) * fade, c[1] + (GROUND[1] - c[1]) * fade, c[2] + (GROUND[2] - c[2]) * fade], depth: t, normal: n, matId: -2 };
    }
    const k = Math.min(1, Math.max(0, dir[1] * 2.5));
    return { color: [GROUND[0] + (SKY[0] - GROUND[0]) * k, GROUND[1] + (SKY[1] - GROUND[1]) * k, GROUND[2] + (SKY[2] - GROUND[2]) * k], depth: Infinity, normal: [0, 0, 0], matId: -3 };
  };

  const canvas = new Canvas(size, size, INK.page);
  const samples: Sample[] = new Array(size * size);
  for (let py = 0; py < size; py++)
    for (let px = 0; px < size; px++) {
      const s = sample(px + 0.5, py + 0.5, prime.depth[py * size + px]);
      samples[py * size + px] = s;
      canvas.set(px, py, rgbDithered(s.color[0], s.color[1], s.color[2], px, py));
    }
  // Edge pixels get four samples. The mesh depth primes them with the neighbour that has one.
  const isEdge = (i: number, j: number): boolean => {
    const a = samples[i], b = samples[j];
    if (a.matId !== b.matId) return true;
    if (Number.isFinite(a.depth) !== Number.isFinite(b.depth)) return true;
    if (Number.isFinite(a.depth) && Math.abs(a.depth - b.depth) > cell * 4) return true;
    return a.normal[0] * b.normal[0] + a.normal[1] * b.normal[1] + a.normal[2] * b.normal[2] < 0.6;
  };
  for (let py = 0; py < size; py++)
    for (let px = 0; px < size; px++) {
      const i = py * size + px;
      const edge = (px + 1 < size && isEdge(i, i + 1)) || (py + 1 < size && isEdge(i, i + size)) || (px > 0 && isEdge(i, i - 1)) || (py > 0 && isEdge(i, i - size));
      if (!edge) continue;
      const nearDepths = [prime.depth[i], px + 1 < size ? prime.depth[i + 1] : Infinity, py + 1 < size ? prime.depth[i + size] : Infinity, px > 0 ? prime.depth[i - 1] : Infinity, py > 0 ? prime.depth[i - size] : Infinity];
      let r = 0, g = 0, b = 0;
      const offs = [[0.25, 0.25], [0.75, 0.25], [0.25, 0.75], [0.75, 0.75]];
      for (const [ox, oy] of offs) {
        // Prime with the nearest finite depth among the neighbours; the march window finds the surface if it is there.
        let d = prime.depth[i];
        if (!Number.isFinite(d)) d = Math.min(...nearDepths);
        const s = sample(px + ox, py + oy, d);
        r += s.color[0]; g += s.color[1]; b += s.color[2];
      }
      canvas.set(px, py, rgbDithered(r / 4, g / 4, b / 4, px, py));
    }
  if (opts.dof && opts.dof > 0) depthOfField(canvas, samples, size, opts.dof, boundsCenter(bounds), cam);
  if (opts.label) drawText(canvas, 8, size - 12, opts.label, INK.dim, 1);
  return canvas;
}

/**
 * Depth of field as a post-process: each pixel is blurred by a circle whose
 * radius grows with its distance from the focus plane through the model's
 * centre. A gather blur with three precomputed levels keeps it cheap.
 */
function depthOfField(canvas: Canvas, samples: Sample[], size: number, strength: number, centre: Vec3, cam: Camera): void {
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
      const r = radiusAt(samples[y * size + x].depth);
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
          const w = 0.3 + 0.7 * Math.min(1, radiusAt(samples[sy * size + sx].depth) / Math.max(r, 1e-6));
          sr += get(sx, sy, 0) * w; sg += get(sx, sy, 1) * w; sb += get(sx, sy, 2) * w; n += w;
        }
      if (n > 0) canvas.set(x, y, ((Math.round(sr / n) & 255) << 16) | ((Math.round(sg / n) & 255) << 8) | (Math.round(sb / n) & 255));
    }
}


