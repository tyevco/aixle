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
import { boundsCenter, boundsDistance, boundsGrow, boundsSize, type Bounds, type Shape3 } from "../sdf/types.js";
import type { Mesh } from "../mesh/mesh.js";
import { perspective, type Camera } from "./camera.js";
import { Canvas, rgbf } from "./canvas.js";
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
}

const LIGHT: Vec3 = normalize([-0.55, 0.9, 0.65]);
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
  const cam: Camera = perspective(bounds, size, size, opts.azimuth ?? 35, opts.elevation ?? 25);
  const cell = Math.max(opts.cellSize, 1e-4);
  const floorY = Math.min(0, bounds.min[1]);
  const shadowBox = boundsGrow(bounds, cell);
  const reach = Math.hypot(...boundsSize(bounds)) * 1.5;
  const dist = shape.dist;

  // Prime with the mesh: view depth per pixel.
  const prime = createTarget(size, size, 0);
  renderMesh(mesh, cam, prime, { background: 0, outline: false });
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
    for (let i = 0; i < 48 && t < tmax; i++) {
      const d = dist(p[0] + LIGHT[0] * t, p[1] + LIGHT[1] * t, p[2] + LIGHT[2] * t);
      if (d < cell * 0.05) { res = 0; break; }
      res = Math.min(res, (6 * d) / t);
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

  const shadePoint = (p: Vec3, n: Vec3, base: Vec3, metal: number, rough: number, view: Vec3): Vec3 => {
    const nl = Math.max(0, n[0] * LIGHT[0] + n[1] * LIGHT[1] + n[2] * LIGHT[2]);
    const sh = nl > 0 ? shadow([p[0] + n[0] * cell, p[1] + n[1] * cell, p[2] + n[2] * cell]) : 1;
    const ao = occlusion(p, n);
    const hemi = 0.5 + 0.5 * n[1];
    const amb: Vec3 = [
      (GROUND[0] + (SKY[0] - GROUND[0]) * hemi) * 0.42 * ao,
      (GROUND[1] + (SKY[1] - GROUND[1]) * hemi) * 0.42 * ao,
      (GROUND[2] + (SKY[2] - GROUND[2]) * hemi) * 0.42 * ao,
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
    return [
      Math.min(1, base[0] * (amb[0] + diff) + spec * tint(base[0]) + fres * SKY[0]),
      Math.min(1, base[1] * (amb[1] + diff) + spec * tint(base[1]) + fres * SKY[1]),
      Math.min(1, base[2] * (amb[2] + diff) + spec * tint(base[2]) + fres * SKY[2]),
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
      return { color: shadePoint(p, n, base, h.mat.metal, h.mat.rough, dir), depth: hitT, normal: n, matId: mesh.materials.indexOf(h.mat) };
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
      canvas.set(px, py, rgbf(s.color[0], s.color[1], s.color[2]));
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
      canvas.set(px, py, rgbf(r / 4, g / 4, b / 4));
    }
  if (opts.label) drawText(canvas, 8, size - 12, opts.label, INK.dim, 1);
  return canvas;
}

export { boundsCenter };
