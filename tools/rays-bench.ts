/**
 * The secondary rays' bench (src/render/bvh.ts, rays.ts, denoise.ts), over the seven benchmark scenes at the render
 * sets' grid, and the pictures that prove them:
 *
 *   faith   per scene, the key light's hard-shadow map and every model pixel's mirror ray, answered by rays.ts and by
 *           marching the field alone from the same origins; the disagreements as numbers and as a map
 *   cost    microseconds per ray: occlusion beyond NEAR on the BVH, closest() with its confirmation against the field
 *           march it replaces, areaVisibility(); and the BVH's build
 *   early   areaVisibility's early out against always eight rays, both through the visibility filter
 *   largest the BVH build on the largest mesh any render-set program makes (every program meshed, none rendered)
 *   build   the BVH build on the programs named (paths from the repository's root), cold and then warm
 *   cube    the penumbra behind a unit cube under a directional light of size 1 and 3, against the analytic disc's
 *   door    the round-11 door's stone through the filter: HEAD's render, the raw rays, the whole diffuse term filtered
 *           (accel's washed-out door_v2 crop) and visibility alone filtered
 *
 *   tsx tools/rays-bench.ts [--size 384] [--out DIR] [--modes faith,cost,early] [scene ...]
 *
 * The scenes are captured as the pipeline would render their beauty.png in a render set (grid 112, 384 px) by
 * redirecting the pipeline's import of the beauty renderer to a wrapper that records its arguments and draws nothing.
 */
import { register } from "node:module";
import { mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join, relative } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath, pathToFileURL } from "node:url";
import { normalize, type Vec3 } from "../src/core/vec.js";
import type { Mesh } from "../src/mesh/mesh.js";
import { surfaceNets } from "../src/mesh/surfaceNets.js";
import { box as boxShape, } from "../src/sdf/primitives.js";
import { move } from "../src/sdf/ops.js";
import { albedo, bumpScaleOf, bumpSlope, fieldCurvature, hasFinish, surface, wearProbe } from "../src/sdf/materials.js";
import { boundsDistance, boundsSize, type Bounds, type Shape3 } from "../src/sdf/types.js";
import { DEFAULT_LIGHT_DIRECTION, lightDirection, renderBeauty, type BeautyLight, type BeautyOptions } from "../src/render/beauty.js";
import { buildBvh, type BvhData } from "../src/render/bvh.js";
import { createRays, hash01, softnessFor, type RayLight, type Rays } from "../src/render/rays.js";
import { filterRadius, filterVisibility, FLAG_EDGE, KIND_FLOOR, KIND_MODEL, KIND_SKY, type FilterGuides } from "../src/render/denoise.js";
import { perspective, type Camera } from "../src/render/camera.js";
import { createTarget, renderMesh } from "../src/render/raster.js";
import { Canvas } from "../src/render/canvas.js";
import { drawText } from "../src/render/font.js";

const ROOT = fileURLToPath(new URL("..", import.meta.url));

export const SCENES: Record<string, string> = {
  medal: "examples/medal.aix",
  tumbler: "examples/tumbler.aix",
  lantern: "examples/lantern.aix",
  teapot: "examples/teapot.aix",
  mixer: "dogfood/round-11/mixer.aix",
  door: "dogfood/round-11/door.aix",
  ring: "dogfood/round-10/ring.aix",
};

// ---- capture: the pipeline's beauty.png arguments ----

interface Captured { shape: Shape3; mesh: Mesh; bounds: Bounds; opts: BeautyOptions }
type Run = (source: string, name: string, dir: string, opts: Record<string, unknown>) => unknown;
let runFn: Run | undefined;

/** The pipeline, with its import of the beauty renderer redirected to one that records each call and draws a dot. */
async function pipeline(): Promise<Run> {
  if (runFn) return runFn;
  const real = pathToFileURL(join(ROOT, "src/render/beauty.ts")).href;
  const wrapper = `import * as real from ${JSON.stringify(real + "?real")};
export * from ${JSON.stringify(real + "?real")};
export function renderBeauty(...a) { (globalThis.__raysBenchCalls ??= []).push(a); return globalThis.__raysBenchDraw ? real.renderBeauty(...a) : globalThis.__raysBenchDot(); }`;
  const hooks = `export async function resolve(spec, ctx, next) {
  const r = await next(spec, ctx);
  if (r.url === ${JSON.stringify(real)} && ctx.parentURL && ctx.parentURL.endsWith("/src/pipeline.ts")) return { url: "data:text/javascript," + encodeURIComponent(${JSON.stringify(wrapper)}), shortCircuit: true };
  return r;
}`;
  register("data:text/javascript," + encodeURIComponent(hooks));
  (globalThis as Record<string, unknown>).__raysBenchDot = () => new Canvas(1, 1, 0);
  const mod = (await import(pathToFileURL(join(ROOT, "src/pipeline.ts")).href)) as { run: Run };
  runFn = mod.run;
  return runFn;
}

/** A program's beauty.png arguments as a render set would make them (the first beauty call of the run). */
export async function capture(file: string, size: number): Promise<Captured> {
  const run = await pipeline();
  const g = globalThis as Record<string, unknown>;
  g.__raysBenchCalls = [];
  run(readFileSync(join(ROOT, file), "utf8"), file, join(tmpdir(), `aixle-rays-bench-${file.replace(/[^a-z0-9]/gi, "_")}`), {
    defaultGrid: 112, size, beautySize: size, beauty: true, views: [], steps: false, slices: false, turntable: false, callouts: false,
    poses: false, animations: false, obj: false, glb: false, viewer: false, shots: false, lights: false, asserts: false,
  });
  const calls = g.__raysBenchCalls as [Shape3, Mesh, Bounds, BeautyOptions][];
  if (!calls.length) throw new Error(`${file}: no beauty render`);
  const [shape, mesh, bounds, opts] = calls[0];
  return { shape, mesh, bounds, opts };
}

// ---- a scene as the beauty render frames it ----

interface Light { ray: RayLight; color: Vec3; power: number; range: number; dir: Vec3 }

interface Scene extends Captured {
  name: string;
  model: Bounds;
  cell: number;
  reach: number;
  floorY: number;
  lights: Light[];
  /** The key light: the first directional one, or the default key. */
  key: Vec3;
}

/** photometry.lightAngle and pointRadius, as the plan defines them (the environment package owns them). */
const lightAngle = (size: number): number => size / 18;
const pointRadius = (size: number, range: number): number => 0.02 * range * size;

export function scene(name: string, c: Captured): Scene {
  const model = c.opts.reachBounds ?? c.bounds;
  const cell = c.opts.cellSize > 0 ? c.opts.cellSize : Math.max(...boundsSize(model)) / 128 || 1e-4;
  const reach = Math.hypot(...boundsSize(model)) * 1.5;
  const floorY = Math.min(0, model.min[1]);
  const halfModel = Math.max(...boundsSize(model)) / 2 || 1;
  const centre: Vec3 = [(model.min[0] + model.max[0]) / 2, (model.min[1] + model.max[1]) / 2, (model.min[2] + model.max[2]) / 2];
  const given: BeautyLight[] = c.opts.lights && c.opts.lights.length ? c.opts.lights : [];
  const lights: Light[] = given.length
    ? given.map((l, index) => {
        const range = Math.max(1e-6, l.range ?? halfModel);
        if (l.position) return { ray: { point: true, x: l.position[0], y: l.position[1], z: l.position[2], radius: pointRadius(l.size, range), index }, color: l.color, power: l.power, range, dir: normalize([l.position[0] - centre[0], l.position[1] - centre[1], l.position[2] - centre[2]]) };
        const d = lightDirection(l.azimuth, l.elevation);
        return { ray: { point: false, x: d[0], y: d[1], z: d[2], radius: lightAngle(l.size), index }, color: l.color, power: l.power, range, dir: d };
      })
    : (() => {
        const d = c.opts.lightAzimuth === undefined && c.opts.lightElevation === undefined ? DEFAULT_LIGHT_DIRECTION : lightDirection(c.opts.lightAzimuth ?? -40, c.opts.lightElevation ?? 55);
        return [{ ray: { point: false, x: d[0], y: d[1], z: d[2], radius: lightAngle(c.opts.lightSize ?? 1), index: 0 }, color: [1, 1, 1] as Vec3, power: 1, range: 2, dir: d }];
      })();
  const keyLight = lights.find((l) => !l.ray.point);
  return { ...c, name, model, cell, reach, floorY, lights, key: keyLight ? keyLight.dir : DEFAULT_LIGHT_DIRECTION };
}

/** What each pixel's primary ray meets, as the beauty render finds it: the field in a window the mesh's depth primes, else the floor or the sky. */
interface Primary {
  size: number;
  cam: Camera;
  P: Float64Array;
  N: Float64Array;
  D: Float64Array;
  depth: Float32Array;
  normal: Float32Array;
  mat: Int32Array;
  flags: Uint8Array;
}

export function primary(sc: Scene, size: number): Primary {
  const { shape, mesh, bounds, opts, cell, floorY } = sc;
  const dist = shape.dist;
  const cam = perspective(bounds, size, size, opts.azimuth ?? 35, opts.elevation ?? 25, 30, opts.zoom ?? 1, opts.fitPoints ?? mesh.positions);
  const prime = createTarget(size, size, 0);
  renderMesh(mesh, cam, prime, { background: 0, outline: false, solidGlass: true });
  const f = size / 2 / Math.tan(((cam.fov ?? 30) * Math.PI) / 360);
  const n = size * size;
  const out: Primary = { size, cam, P: new Float64Array(n * 3), N: new Float64Array(n * 3), D: new Float64Array(n * 3), depth: new Float32Array(n), normal: new Float32Array(n * 3), mat: new Int32Array(n), flags: new Uint8Array(n) };
  const eps = cell * 0.5;
  const eye = cam.eye;
  for (let py = 0; py < size; py++)
    for (let px = 0; px < size; px++) {
      const i = py * size + px;
      const x = (px + 0.5 - size / 2) / f, y = -(py + 0.5 - size / 2) / f;
      const dir = normalize([cam.right[0] * x + cam.up[0] * y + cam.forward[0], cam.right[1] * x + cam.up[1] * y + cam.forward[1], cam.right[2] * x + cam.up[2] * y + cam.forward[2]]);
      out.D[i * 3] = dir[0]; out.D[i * 3 + 1] = dir[1]; out.D[i * 3 + 2] = dir[2];
      const along = dir[0] * cam.forward[0] + dir[1] * cam.forward[1] + dir[2] * cam.forward[2];
      let hitT = -1;
      const pd = prime.depth[i];
      if (Number.isFinite(pd)) {
        const c = pd / along;
        let t = Math.max(0, c - cell * 3);
        for (let k = 0; k < 40 && t < c + cell * 3; k++) {
          const d = dist(eye[0] + dir[0] * t, eye[1] + dir[1] * t, eye[2] + dir[2] * t);
          if (d < cell * 0.05) { hitT = t; break; }
          t += Math.max(d * 0.9, cell * 0.02);
        }
        if (hitT < 0) hitT = c;
      }
      if (hitT >= 0) {
        const p: Vec3 = [eye[0] + dir[0] * hitT, eye[1] + dir[1] * hitT, eye[2] + dir[2] * hitT];
        const g = normalize([dist(p[0] + eps, p[1], p[2]) - dist(p[0] - eps, p[1], p[2]), dist(p[0], p[1] + eps, p[2]) - dist(p[0], p[1] - eps, p[2]), dist(p[0], p[1], p[2] + eps) - dist(p[0], p[1], p[2] - eps)]);
        out.P.set(p, i * 3); out.N.set(g, i * 3); out.normal.set(g, i * 3);
        out.depth[i] = hitT;
        out.mat[i] = mesh.materials.indexOf(shape.hit(p[0], p[1], p[2]).mat);
        out.flags[i] = KIND_MODEL;
      } else if (dir[1] < -1e-6) {
        const t = (floorY - eye[1]) / dir[1];
        out.P[i * 3] = eye[0] + dir[0] * t; out.P[i * 3 + 1] = floorY; out.P[i * 3 + 2] = eye[2] + dir[2] * t;
        out.N[i * 3 + 1] = 1; out.normal[i * 3 + 1] = 1;
        out.depth[i] = t;
        out.mat[i] = -2;
        out.flags[i] = KIND_FLOOR;
      } else {
        out.depth[i] = Infinity;
        out.mat[i] = -3;
        out.flags[i] = KIND_SKY;
      }
    }
  // Edge pixels as the kernel finds them: another material, a depth step over 4 cells or a crease, floor and sky
  // pairs exempt.
  const kind = (i: number) => out.flags[i] & 3;
  const differ = (i: number, j: number): boolean => {
    const a = kind(i), b = kind(j);
    if (a !== b) return true;
    if (a !== KIND_MODEL) return false;
    if (out.mat[i] !== out.mat[j]) return true;
    if (Math.abs(out.depth[i] - out.depth[j]) > cell * 4) return true;
    return out.N[i * 3] * out.N[j * 3] + out.N[i * 3 + 1] * out.N[j * 3 + 1] + out.N[i * 3 + 2] * out.N[j * 3 + 2] < 0.6;
  };
  for (let py = 0; py < size; py++)
    for (let px = 0; px < size; px++) {
      const i = py * size + px;
      if ((px + 1 < size && differ(i, i + 1)) || (py + 1 < size && differ(i, i + size)) || (px > 0 && differ(i, i - 1)) || (py > 0 && differ(i, i - size))) out.flags[i] |= FLAG_EDGE;
    }
  return out;
}

const guides = (pr: Primary): FilterGuides => ({ depth: pr.depth, normal: pr.normal, mat: pr.mat, flags: pr.flags });

/** The origin a shadow ray leaves from: a cell along the normal, as the beauty render lifts it. */
export function lifted(sc: Scene, pr: Primary, i: number, out: Float64Array): void {
  for (let k = 0; k < 3; k++) out[k] = pr.P[i * 3 + k] + pr.N[i * 3 + k] * sc.cell;
}

/** The ray's exit from the model's box grown by two cells, or -1 when it misses it. */
function boxExit(r: Rays, o: Float64Array, d: Vec3 | Float64Array, limit: number): number {
  let t0 = 0, t1 = limit;
  for (let a = 0; a < 3; a++) {
    const inv = 1 / d[a];
    let ta = (r.box.min[a] - o[a]) * inv, tb = (r.box.max[a] - o[a]) * inv;
    if (ta > tb) [ta, tb] = [tb, ta];
    t0 = Math.max(t0, ta); t1 = Math.min(t1, tb);
  }
  return t1 < t0 ? -1 : t1;
}

function panel(title: string, pics: { c: Canvas; caption: string }[]): Canvas {
  const gutter = 6, bar = 22, cap = 14;
  const w = pics.reduce((s, p) => s + p.c.width + gutter, gutter), h = bar + gutter + Math.max(...pics.map((p) => p.c.height)) + cap + gutter;
  const out = new Canvas(w, h, 0xf4f2ee);
  out.fill(0, 0, w, bar, 0x2a2a2e);
  drawText(out, 8, 7, title, 0xf4f2ee, 1);
  let x = gutter;
  for (const p of pics) {
    out.blit(p.c, x, bar + gutter);
    drawText(out, x + 2, bar + gutter + p.c.height + 3, p.caption, 0x2a2a2e, 1);
    x += p.c.width + gutter;
  }
  return out;
}

/** The reference field march's least step, in cells (0.5 is today's shadow march). */
let FIELD_STEP = 0.5;
/** Its step cap: 64 is today's; the bench's default is effectively none. */
let FIELD_STEPS = 1 << 16;

const pct = (a: number, b: number) => (b ? (100 * a) / b : 0).toFixed(3) + "%";

// ---- faith ----

interface FaithResult { shadowPixels: number; shadowDis: number; shadowDisOffEdge: number; fieldOnly: number; faced: number; facedDis: number; refl: number; reflDis: number; both: number; within005: number; over2: number; confirmed: number; confirmedWithin005: number; trusted: number }

function faith(sc: Scene, pr: Primary, rays: Rays, outDir: string): FaithResult {
  const { size } = pr;
  const n = size * size;
  const L = sc.key;
  const o = new Float64Array(3);
  // Shadow maps: 0 not tested (sky, facing away), 1 lit, 2 shadow; per answer. Through glass a ray is partly lit:
  // FV and RV keep the transmittance, and two answers differ when they are apart by more than a quarter.
  const fieldMap = new Uint8Array(n), raysMap = new Uint8Array(n);
  const FV = new Float32Array(n), RV = new Float32Array(n);
  const differ = (i: number) => Math.abs(FV[i] - RV[i]) > 0.25;
  let shadowPixels = 0;
  for (let i = 0; i < n; i++) {
    const kind = pr.flags[i] & 3;
    if (kind === KIND_SKY) continue;
    if (pr.N[i * 3] * L[0] + pr.N[i * 3 + 1] * L[1] + pr.N[i * 3 + 2] * L[2] <= 0) continue;
    lifted(sc, pr, i, o);
    if (boxExit(rays, o, L, Infinity) < 0) continue;
    shadowPixels++;
    FV[i] = rays.fieldOcclusion(o[0], o[1], o[2], L[0], L[1], L[2], Infinity, 0, FIELD_STEP, FIELD_STEPS);
    RV[i] = rays.occlusion(o[0], o[1], o[2], L[0], L[1], L[2], Infinity, 0);
    fieldMap[i] = FV[i] < 0.5 ? 2 : 1;
    raysMap[i] = RV[i] < 0.5 ? 2 : 1;
  }
  // A disagreement on a shadow edge: within two pixels of a pixel the field answers the other way.
  let shadowDis = 0, shadowDisOffEdge = 0, fieldOnly = 0, faced = 0, facedDis = 0;
  const shadowPic = new Canvas(size, size, 0xf4f2ee);
  for (let y = 0; y < size; y++)
    for (let x = 0; x < size; x++) {
      const i = y * size + x;
      if (!(pr.flags[i] & 3)) continue;
      if (!fieldMap[i]) { shadowPic.set(x, y, 0x8a8a8a); continue; }
      // Pixels square enough to the light (n.L over 0.1) that a shadow there shows.
      const nl = pr.N[i * 3] * L[0] + pr.N[i * 3 + 1] * L[1] + pr.N[i * 3 + 2] * L[2];
      if (nl > 0.1) { faced++; if (differ(i)) facedDis++; }
      if (!differ(i)) { shadowPic.set(x, y, fieldMap[i] === 2 ? 0x505050 : 0xd0d0d0); continue; }
      shadowDis++;
      if (FV[i] < RV[i]) fieldOnly++;
      let onEdge = false;
      for (let dy = -2; dy <= 2 && !onEdge; dy++)
        for (let dx = -2; dx <= 2; dx++) {
          const xx = x + dx, yy = y + dy;
          if (xx < 0 || yy < 0 || xx >= size || yy >= size) continue;
          const j = yy * size + xx;
          if (fieldMap[j] && Math.abs(FV[j] - FV[i]) > 0.25) { onEdge = true; break; }
        }
      if (!onEdge) shadowDisOffEdge++;
      shadowPic.set(x, y, fieldMap[i] === 2 ? 0xe0301e : 0x2060e0);
    }
  // Mirror rays from every model pixel.
  let refl = 0, reflDis = 0, both = 0, within005 = 0, over2 = 0, confirmed = 0, confirmedWithin005 = 0, trusted = 0;
  const reflPic = new Canvas(size, size, 0xf4f2ee);
  for (let y = 0; y < size; y++)
    for (let x = 0; x < size; x++) {
      const i = y * size + x;
      if ((pr.flags[i] & 3) !== KIND_MODEL) { if (pr.flags[i] & 3) reflPic.set(x, y, 0xe4e2de); continue; }
      const nx = pr.N[i * 3], ny = pr.N[i * 3 + 1], nz = pr.N[i * 3 + 2];
      const vx = pr.D[i * 3], vy = pr.D[i * 3 + 1], vz = pr.D[i * 3 + 2];
      const k = 2 * (vx * nx + vy * ny + vz * nz);
      const rx = vx - k * nx, ry = vy - k * ny, rz = vz - k * nz;
      const ox = pr.P[i * 3] + nx * sc.cell * 2, oy = pr.P[i * 3 + 1] + ny * sc.cell * 2, oz = pr.P[i * 3 + 2] + nz * sc.cell * 2;
      refl++;
      const tf = rays.fieldClosest(ox, oy, oz, rx, ry, rz, sc.reach * 2);
      const tr = rays.closest(ox, oy, oz, rx, ry, rz, sc.reach * 2);
      const how = rays.how;
      if (how === 3) trusted++;
      if ((tf >= 0) !== (tr >= 0)) { reflDis++; reflPic.set(x, y, 0xc020c0); continue; }
      if (tf < 0) { reflPic.set(x, y, 0xb8b8b8); continue; }
      both++;
      const e = Math.abs(tf - tr) / sc.cell;
      if (e <= 0.05) within005++;
      if (e > 2) over2++;
      if (how === 2) { confirmed++; if (e <= 0.05) confirmedWithin005++; }
      reflPic.set(x, y, e <= 0.05 ? 0x68a868 : e <= 2 ? 0xe0b020 : 0xe0301e);
    }
  writeFileSync(join(outDir, `${sc.name}_faith_${size}.png`), panel(`${sc.name} ${size}px against the field alone. shadow: red field only, blue rays only. mirror: green same, red > 2 cells, magenta hit/miss`, [
    { c: shadowPic, caption: `hard shadow: ${pct(shadowDis, shadowPixels)} differ, ${shadowDisOffEdge} off edges` },
    { c: reflPic, caption: `mirror: ${pct(reflDis, refl)} hit/miss, ${pct(over2, both)} > 2 cells` },
  ]).toPng());
  return { shadowPixels, shadowDis, shadowDisOffEdge, fieldOnly, faced, facedDis, refl, reflDis, both, within005, over2, confirmed, confirmedWithin005, trusted };
}

// ---- cost ----

function median(a: Float64Array | number[]): number {
  const s = Array.from(a).sort((x, y) => x - y);
  return s.length ? s[Math.floor(s.length / 2)] : 0;
}

/** One nanosecond clock read, and what reading it twice costs. */
const now = (): bigint => process.hrtime.bigint();
function clockCost(): number {
  const s: number[] = [];
  for (let k = 0; k < 20000; k++) { const a = now(); const b = now(); s.push(Number(b - a)); }
  return median(s);
}

interface CostResult { farMedianUs: number; farMeanUs: number; beyondMedianUs: number; beyondMeanUs: number; farRays: number; occMeanUs: number; fieldOccMeanUs: number; closestUs: number; field128Us: number; fieldFullUs: number; areaUs: number; earlyOutRate: number; buildMs: number; triangles: number }

function cost(sc: Scene, pr: Primary, rays: Rays, buildMs: number): CostResult {
  const { size } = pr;
  const n = size * size;
  const L = sc.key;
  const o = new Float64Array(3);
  // The shadow rays of every lit-facing pixel whose ray goes on past NEAR inside the box.
  const shadow: number[] = [];
  for (let i = 0; i < n; i++) {
    if (!(pr.flags[i] & 3)) continue;
    if (pr.N[i * 3] * L[0] + pr.N[i * 3 + 1] * L[1] + pr.N[i * 3 + 2] * L[2] <= 0) continue;
    lifted(sc, pr, i, o);
    const te = boxExit(rays, o, L, Infinity);
    if (te > rays.near) shadow.push(i);
  }
  const clock = clockCost();
  const tr = rays.tracer;
  const R = tr.ray;
  const per = new Float64Array(shadow.length);
  for (let rep = 0; rep < 2; rep++)
    for (let k = 0; k < shadow.length; k++) {
      lifted(sc, pr, shadow[k], o);
      R[0] = o[0]; R[1] = o[1]; R[2] = o[2]; R[3] = L[0]; R[4] = L[1]; R[5] = L[2]; R[6] = rays.near; R[7] = boxExit(rays, o, L, Infinity);
      const a = now();
      tr.occludedRay();
      const b = now();
      per[k] = Math.max(0, Number(b - a) - clock) / 1000;
    }
  const farMedianUs = median(per), farMeanUs = per.reduce((s, v) => s + v, 0) / Math.max(1, per.length);
  // The same stretch as occlusion() takes it: the BVH, then the glass solids crossed on the field.
  const glassPer = new Float64Array(shadow.length);
  for (let rep = 0; rep < 2; rep++)
    for (let k = 0; k < shadow.length; k++) {
      lifted(sc, pr, shadow[k], o);
      const to = boxExit(rays, o, L, Infinity);
      const a = now();
      rays.beyond(o[0], o[1], o[2], L[0], L[1], L[2], rays.near, to);
      const b = now();
      glassPer[k] = Math.max(0, Number(b - a) - clock) / 1000;
    }
  const beyondMedianUs = median(glassPer), beyondMeanUs = glassPer.reduce((s, v) => s + v, 0) / Math.max(1, glassPer.length);
  // Whole occlusion() calls against the field's march over the whole ray (today's shadow march), batch-timed.
  const time = (f: () => void): number => { f(); const t0 = performance.now(); f(); return performance.now() - t0; };
  const occMs = time(() => { for (const i of shadow) { lifted(sc, pr, i, o); rays.occlusion(o[0], o[1], o[2], L[0], L[1], L[2], Infinity, softnessFor(lightAngle(1))); } });
  const fieldOccMs = time(() => { for (const i of shadow) { lifted(sc, pr, i, o); rays.fieldOcclusion(o[0], o[1], o[2], L[0], L[1], L[2], Infinity, softnessFor(lightAngle(1))); } });
  // Mirror rays: closest() with confirmation, the shading prototype's 128-step field march, and the field uncapped.
  const mirror: number[] = [];
  for (let i = 0; i < n; i++) if ((pr.flags[i] & 3) === KIND_MODEL) mirror.push(i);
  const M = new Float64Array(mirror.length * 6);
  mirror.forEach((i, k) => {
    const nx = pr.N[i * 3], ny = pr.N[i * 3 + 1], nz = pr.N[i * 3 + 2];
    const vx = pr.D[i * 3], vy = pr.D[i * 3 + 1], vz = pr.D[i * 3 + 2];
    const d = 2 * (vx * nx + vy * ny + vz * nz);
    M.set([pr.P[i * 3] + nx * sc.cell * 2, pr.P[i * 3 + 1] + ny * sc.cell * 2, pr.P[i * 3 + 2] + nz * sc.cell * 2, vx - d * nx, vy - d * ny, vz - d * nz], k * 6);
  });
  const reach2 = sc.reach * 2;
  const closestMs = time(() => { for (let k = 0; k < mirror.length; k++) rays.closest(M[k * 6], M[k * 6 + 1], M[k * 6 + 2], M[k * 6 + 3], M[k * 6 + 4], M[k * 6 + 5], reach2); });
  const field128Ms = time(() => { for (let k = 0; k < mirror.length; k++) rays.fieldClosest(M[k * 6], M[k * 6 + 1], M[k * 6 + 2], M[k * 6 + 3], M[k * 6 + 4], M[k * 6 + 5], reach2, 128); });
  const fieldFullMs = time(() => { for (let k = 0; k < mirror.length; k++) rays.fieldClosest(M[k * 6], M[k * 6 + 1], M[k * 6 + 2], M[k * 6 + 3], M[k * 6 + 4], M[k * 6 + 5], reach2); });
  // areaVisibility for the key light at every lit-facing pixel.
  const key = sc.lights.find((l) => !l.ray.point) ?? sc.lights[0];
  const lit: number[] = [];
  for (let i = 0; i < n; i++) {
    if (!(pr.flags[i] & 3)) continue;
    const d = key.dir;
    if (pr.N[i * 3] * d[0] + pr.N[i * 3 + 1] * d[1] + pr.N[i * 3 + 2] * d[2] > 0) lit.push(i);
  }
  const e0 = rays.stats.earlyOut, a0 = rays.stats.area;
  const areaMs = time(() => { for (const i of lit) { lifted(sc, pr, i, o); rays.areaVisibility(o[0], o[1], o[2], key.ray, i % size, Math.floor(i / size)); } });
  const earlyOutRate = (rays.stats.earlyOut - e0) / Math.max(1, rays.stats.area - a0);
  return {
    farMedianUs, farMeanUs, beyondMedianUs, beyondMeanUs, farRays: shadow.length,
    occMeanUs: (occMs * 1000) / Math.max(1, shadow.length), fieldOccMeanUs: (fieldOccMs * 1000) / Math.max(1, shadow.length),
    closestUs: (closestMs * 1000) / Math.max(1, mirror.length), field128Us: (field128Ms * 1000) / Math.max(1, mirror.length), fieldFullUs: (fieldFullMs * 1000) / Math.max(1, mirror.length),
    areaUs: (areaMs * 1000) / Math.max(1, lit.length), earlyOutRate, buildMs, triangles: sc.mesh.indices.length / 3,
  };
}

// ---- early out ----

interface EarlyResult { pixels: number; over2: number; maxLevels: number; rawOver2: number }

function early(sc: Scene, pr: Primary, rays: Rays, outDir: string): EarlyResult {
  const { size } = pr;
  const n = size * size;
  const NL = sc.lights.length;
  const Ve = new Float32Array(n * NL).fill(1), V8 = new Float32Array(n * NL).fill(1);
  const tested = new Uint8Array(n * NL);
  const o = new Float64Array(3);
  for (let i = 0; i < n; i++) {
    if (!(pr.flags[i] & 3)) continue;
    lifted(sc, pr, i, o);
    for (let li = 0; li < NL; li++) {
      const l = sc.lights[li].ray;
      let lx = l.x, ly = l.y, lz = l.z;
      if (l.point) { lx -= pr.P[i * 3]; ly -= pr.P[i * 3 + 1]; lz -= pr.P[i * 3 + 2]; }
      if (pr.N[i * 3] * lx + pr.N[i * 3 + 1] * ly + pr.N[i * 3 + 2] * lz <= 0) continue;
      tested[i * NL + li] = 1;
      Ve[i * NL + li] = rays.areaVisibility(o[0], o[1], o[2], l, i % size, Math.floor(i / size), 0, 8, true);
      V8[i * NL + li] = rays.areaVisibility(o[0], o[1], o[2], l, i % size, Math.floor(i / size), 0, 8, false);
    }
  }
  const g = guides(pr);
  const Fe = filterVisibility(Ve, NL, g, size, sc.cell), F8 = filterVisibility(V8, NL, g, size, sc.cell);
  let pixels = 0, over2 = 0, rawOver2 = 0, maxLevels = 0;
  const pic = new Canvas(size, size, 0xf4f2ee);
  for (let i = 0; i < n; i++) {
    let any = false, worst = 0, rawWorst = 0;
    for (let li = 0; li < NL; li++) {
      if (!tested[i * NL + li]) continue;
      any = true;
      worst = Math.max(worst, Math.abs(Fe[i * NL + li] - F8[i * NL + li]) * 255);
      rawWorst = Math.max(rawWorst, Math.abs(Ve[i * NL + li] - V8[i * NL + li]) * 255);
    }
    if (!any) continue;
    pixels++;
    if (worst > 2) over2++;
    if (rawWorst > 2) rawOver2++;
    maxLevels = Math.max(maxLevels, worst);
    const v = Math.round(F8[i * NL] * 200 + 30);
    pic.set(i % size, Math.floor(i / size), worst > 2 ? 0xe0301e : (v << 16) | (v << 8) | v);
  }
  writeFileSync(join(outDir, `${sc.name}_early_${size}.png`), panel(`${sc.name}: area visibility filtered, early out vs always 8 (red: > 2 levels apart)`, [{ c: pic, caption: `${pct(over2, pixels)} of ${pixels} pixels differ by > 2 levels after filtering` }]).toPng());
  return { pixels, over2, maxLevels, rawOver2 };
}

// ---- noise through the filter ----

/**
 * The key light's visibility through the filter against a reference of 24 independent eight-ray estimates a pixel
 * (filtered the same way, so only noise is left), over the penumbra: with the rays' pattern over the pixel grid, and
 * with each pixel's pattern taken at random coordinates instead, which is a hash per pixel.
 */
function noise(sc: Scene, pr: Primary, rays: Rays): string {
  const { size } = pr;
  const n = size * size;
  const key = sc.lights.find((l) => !l.ray.point) ?? sc.lights[0];
  const l = key.ray;
  const o = new Float64Array(3);
  const white = (i: number, k: number): [number, number] => [Math.floor(hash01(i, 101 + k) * 1e6), Math.floor(hash01(i, 202 + k) * 1e6)];
  const lit = new Uint8Array(n);
  for (let i = 0; i < n; i++) {
    if (!(pr.flags[i] & 3)) continue;
    let lx = l.x, ly = l.y, lz = l.z;
    if (l.point) { lx -= pr.P[i * 3]; ly -= pr.P[i * 3 + 1]; lz -= pr.P[i * 3 + 2]; }
    if (pr.N[i * 3] * lx + pr.N[i * 3 + 1] * ly + pr.N[i * 3 + 2] * lz > 0) lit[i] = 1;
  }
  const REF = new Float32Array(n), GRID = new Float32Array(n), WHITE = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    if (!lit[i]) continue;
    lifted(sc, pr, i, o);
    GRID[i] = rays.areaVisibility(o[0], o[1], o[2], l, i % size, Math.floor(i / size));
    const [wx, wy] = white(i, 0);
    WHITE[i] = rays.areaVisibility(o[0], o[1], o[2], l, wx, wy);
    if (GRID[i] === 0 || GRID[i] === 1) { REF[i] = GRID[i]; continue; }
    let sum = 0;
    for (let k = 1; k <= 24; k++) { const [x, y] = white(i, k); sum += rays.areaVisibility(o[0], o[1], o[2], l, x, y); }
    REF[i] = sum / 24;
  }
  const g = guides(pr);
  const FR = filterVisibility(REF, 1, g, size, sc.cell), FG = filterVisibility(GRID, 1, g, size, sc.cell), FW = filterVisibility(WHITE, 1, g, size, sc.cell);
  const parts: string[] = [];
  for (const [kind, label] of [[KIND_FLOOR, "floor"], [KIND_MODEL, "model"]] as const) {
    let eg = 0, ew = 0, c = 0;
    for (let i = 0; i < n; i++) {
      if ((pr.flags[i] & 3) !== kind || pr.flags[i] & FLAG_EDGE || !(REF[i] > 0.02 && REF[i] < 0.98)) continue;
      eg += (FG[i] - FR[i]) ** 2; ew += (FW[i] - FR[i]) ** 2; c++;
    }
    parts.push(`${label} ${c} penumbra pixels: grid pattern ${(Math.sqrt(eg / Math.max(1, c)) * 255).toFixed(2)} levels, hash per pixel ${(Math.sqrt(ew / Math.max(1, c)) * 255).toFixed(2)}`);
  }
  return `  noise through the filter (key light, RMS against 24x8 rays): ${parts.join("; ")}`;
}

// ---- the cube's penumbra ----

/** The exact fraction of a directional light's disc (angular radius theta about L, uniform over its tangent disc) that a point sees past an axis-aligned box. */
function analyticDisc(o: Vec3, L: Vec3, theta: number, bmin: Vec3, bmax: Vec3, grid = 160): number {
  const sg = L[2] >= 0 ? 1 : -1, ia = -1 / (sg + L[2]), ib = L[0] * L[1] * ia;
  const t1: Vec3 = [1 + sg * L[0] * L[0] * ia, sg * ib, -sg * L[0]], t2: Vec3 = [ib, sg + L[1] * L[1] * ia, -L[1]];
  const tanA = Math.tan(theta);
  let seen = 0, all = 0;
  for (let a = 0; a < grid; a++)
    for (let b = 0; b < grid; b++) {
      const u = ((a + 0.5) / grid) * 2 - 1, v = ((b + 0.5) / grid) * 2 - 1;
      if (u * u + v * v > 1) continue;
      all++;
      const d = normalize([L[0] + tanA * (u * t1[0] + v * t2[0]), L[1] + tanA * (u * t1[1] + v * t2[1]), L[2] + tanA * (u * t1[2] + v * t2[2])]);
      let t0 = 0, t1b = Infinity;
      for (let k = 0; k < 3; k++) {
        const inv = 1 / d[k];
        let ta = (bmin[k] - o[k]) * inv, tb = (bmax[k] - o[k]) * inv;
        if (ta > tb) [ta, tb] = [tb, ta];
        t0 = Math.max(t0, ta); t1b = Math.min(t1b, tb);
      }
      if (!(t1b >= t0)) seen++;
    }
  return seen / all;
}

/** Where a falling profile (1 at z0, 0 beyond) crosses `level`, by linear interpolation; z runs in the order given. */
function crossing(z: number[], v: number[], level: number): number {
  for (let k = 1; k < z.length; k++) if ((v[k - 1] - level) * (v[k] - level) <= 0 && v[k - 1] !== v[k]) return z[k - 1] + ((level - v[k - 1]) / (v[k] - v[k - 1])) * (z[k] - z[k - 1]);
  return NaN;
}

export interface CubeProfile { size: number; edge: number; analytic50: number; measured50: number; filtered50: number; analyticWidth: number; measuredWidth: number; filteredWidth: number; rmsRaw: number; rmsFiltered: number }

/** The penumbra on the floor behind a unit cube standing on it, lit from +z at 45 degrees by a light of `lightSize`. */
export function cubePenumbra(lightSize: number, res = 64, image = 192, earlyOut = true): { profile: CubeProfile; pics: Canvas[] } {
  const cube = move(boxShape(1, 1, 1), 0, 0.5, 0);
  const mesh = surfaceNets(cube, { resolution: res }).mesh;
  const bvh = buildBvh(mesh);
  const cell = 1 / res;
  const model: Bounds = { min: [-0.5, 0, -0.5], max: [0.5, 1, 0.5] };
  const rays = createRays(cube, mesh, bvh, cell, model, Math.hypot(1, 1, 1) * 1.5);
  const L = lightDirection(0, 45);
  const theta = lightAngle(lightSize);
  const light: RayLight = { point: false, x: L[0], y: L[1], z: L[2], radius: theta, index: 0 };
  // The geometric edge on the floor: the cube's top back edge (y 1, z -0.5) along -L.
  const edge = -0.5 - 1 / Math.tan(Math.PI / 4);
  // A top-down picture of the floor: x across [-0.75, 0.75], z down the picture over [edge - 0.9, edge + 0.9].
  const zs = (row: number) => edge + 0.9 - ((row + 0.5) / image) * 1.8;
  const xs = (col: number) => -0.75 + ((col + 0.5) / image) * 1.5;
  const n = image * image;
  const V = new Float32Array(n);
  const g: FilterGuides = { depth: new Float32Array(n).fill(5), normal: new Float32Array(n * 3), mat: new Int32Array(n).fill(-2), flags: new Uint8Array(n).fill(KIND_FLOOR) };
  for (let i = 0; i < n; i++) g.normal[i * 3 + 1] = 1;
  for (let row = 0; row < image; row++)
    for (let col = 0; col < image; col++) {
      const i = row * image + col;
      V[i] = rays.areaVisibility(xs(col), cell, zs(row), light, col, row, 0, 8, earlyOut);
    }
  // The filter at the radius a picture of this size gets.
  const F = filterVisibility(V, 1, g, image, cell, undefined, filterRadius(image));
  // Profiles down the middle third of the picture (where the cube's edge is straight), averaged across x.
  const zArr: number[] = [], mean: number[] = [], fmean: number[] = [], ana: number[] = [];
  const c0 = Math.floor(image / 3), c1 = Math.floor((2 * image) / 3);
  for (let row = 0; row < image; row++) {
    let s = 0, fs = 0;
    for (let col = c0; col < c1; col++) { s += V[row * image + col]; fs += F[row * image + col]; }
    zArr.push(zs(row)); mean.push(s / (c1 - c0)); fmean.push(fs / (c1 - c0));
    ana.push(analyticDisc([0, cell, zs(row)], L, theta, model.min, model.max));
  }
  // z falls down the picture: lit (1) near the cube, shadow (0) behind it, then lit again past the edge. The rows
  // from the cube's back face outward run from shadow into light, so read the profile from the far side inwards.
  const rev = <T,>(a: T[]) => a.slice().reverse();
  const zr = rev(zArr);
  const width = (v: number[]) => Math.abs(crossing(zr, rev(v), 0.9) - crossing(zr, rev(v), 0.1));
  // Noise: each penumbra pixel's distance from the exact value, raw and filtered, in the middle third.
  let e2 = 0, f2 = 0, en = 0;
  for (let row = 0; row < image; row++) {
    if (!(ana[row] > 0.02 && ana[row] < 0.98)) continue;
    for (let col = c0; col < c1; col++) { const i = row * image + col; e2 += (V[i] - ana[row]) ** 2; f2 += (F[i] - ana[row]) ** 2; en++; }
  }
  const profile: CubeProfile = {
    rmsRaw: Math.sqrt(e2 / Math.max(1, en)), rmsFiltered: Math.sqrt(f2 / Math.max(1, en)),
    size: lightSize, edge,
    analytic50: crossing(zr, rev(ana), 0.5), measured50: crossing(zr, rev(mean), 0.5), filtered50: crossing(zr, rev(fmean), 0.5),
    analyticWidth: width(ana), measuredWidth: width(mean), filteredWidth: width(fmean),
  };
  const grey = (v: number) => { const k = Math.max(0, Math.min(255, Math.round(v * 255))); return (k << 16) | (k << 8) | k; };
  const raw = new Canvas(image, image), filt = new Canvas(image, image), an = new Canvas(image, image), plot = new Canvas(image, image, 0xffffff);
  for (let row = 0; row < image; row++)
    for (let col = 0; col < image; col++) {
      raw.set(col, row, grey(V[row * image + col]));
      filt.set(col, row, grey(F[row * image + col]));
      an.set(col, row, grey(ana[row]));
    }
  // The profiles, z down the plot as in the pictures, visibility across: analytic black, raw mean blue, filtered red.
  for (let row = 0; row < image; row++) {
    plot.set(Math.round(ana[row] * (image - 1)), row, 0x000000);
    plot.set(Math.round(mean[row] * (image - 1)), row, 0x2060e0);
    plot.set(Math.round(fmean[row] * (image - 1)), row, 0xe0301e);
  }
  const er = Math.round(((edge + 0.9 - edge) / 1.8) * image);
  for (let col = 0; col < image; col += 2) { plot.set(col, er, 0x909090); }
  return { profile, pics: [raw, filt, an, plot] };
}

// ---- the door through the filter ----

async function door(size: number, outDir: string): Promise<string> {
  const c = await capture(SCENES.door, size);
  const sc = scene("door", c);
  const pr = primary(sc, size);
  const { shape, mesh, cell } = sc;
  const dist = shape.dist;
  const bvh = buildBvh(mesh);
  const rays = createRays(shape, mesh, bvh, cell, sc.model, sc.reach);
  const n = size * size, NL = sc.lights.length;
  const probe = c.opts.wearProbe ?? wearProbe(Math.max(...boundsSize(sc.model)));
  const ambient = Math.max(0, c.opts.ambient ?? 1) * 0.4;
  // The night palette's sky and ground (beauty.ts), for a plain hemisphere ambient.
  const SKY: Vec3 = [0.04, 0.06, 0.14], GROUND: Vec3 = [0.07, 0.07, 0.1];
  const base = new Float64Array(n * 3), amb = new Float64Array(n * 3), Dl = new Float64Array(n * NL * 3);
  const V = new Float32Array(n * NL).fill(1);
  const o = new Float64Array(3);
  for (let i = 0; i < n; i++) {
    const kind = pr.flags[i] & 3;
    if (kind === KIND_SKY) continue;
    const p: Vec3 = [pr.P[i * 3], pr.P[i * 3 + 1], pr.P[i * 3 + 2]];
    let nn: Vec3 = [pr.N[i * 3], pr.N[i * 3 + 1], pr.N[i * 3 + 2]];
    let col: Vec3 = [0.14, 0.14, 0.17];
    if (kind === KIND_MODEL) {
      // The material and the bump's normal, as beauty.ts's finishAt finds them.
      const h = shape.hit(p[0], p[1], p[2]);
      const m = h.mat;
      if (!hasFinish(m)) col = albedo(m, h.lx, h.ly, h.lz);
      else {
        const cv = (m.wear ?? 0) > 0 ? fieldCurvature(dist, p[0], p[1], p[2], probe) : 0;
        col = surface(m, h.lx, h.ly, h.lz, cv).color;
        if ((m.bump ?? 0) > 0) {
          const ref: Vec3 = Math.abs(nn[1]) < 0.9 ? [0, 1, 0] : [1, 0, 0];
          const t1 = normalize([nn[1] * ref[2] - nn[2] * ref[1], nn[2] * ref[0] - nn[0] * ref[2], nn[0] * ref[1] - nn[1] * ref[0]]);
          const t2: Vec3 = [nn[1] * t1[2] - nn[2] * t1[1], nn[2] * t1[0] - nn[0] * t1[2], nn[0] * t1[1] - nn[1] * t1[0]];
          const e = bumpScaleOf(m) * 0.1;
          const along = (t: Vec3): Vec3 => { const q = shape.hit(p[0] + t[0] * e, p[1] + t[1] * e, p[2] + t[2] * e); return q.mat === m ? [(q.lx - h.lx) / e, (q.ly - h.ly) / e, (q.lz - h.lz) / e] : [0, 0, 0]; };
          const [s1, s2] = bumpSlope(m, h.lx, h.ly, h.lz, along(t1), along(t2));
          nn = normalize([nn[0] - s1 * t1[0] - s2 * t2[0], nn[1] - s1 * t1[1] - s2 * t2[1], nn[2] - s1 * t1[2] - s2 * t2[2]]);
        }
      }
      if (m.glow > 0) { for (let k = 0; k < 3; k++) { base[i * 3 + k] = col[k]; amb[i * 3 + k] = 1 + m.glow; } continue; }
    }
    base.set(col, i * 3);
    const hemi = 0.5 + 0.5 * nn[1];
    for (let k = 0; k < 3; k++) amb[i * 3 + k] = (GROUND[k] + (SKY[k] - GROUND[k]) * hemi) * 0.42 * ambient;
    lifted(sc, pr, i, o);
    for (let li = 0; li < NL; li++) {
      const l = sc.lights[li];
      let lx = l.ray.x, ly = l.ray.y, lz = l.ray.z, k = l.power;
      if (l.ray.point) {
        lx -= p[0]; ly -= p[1]; lz -= p[2];
        const d = Math.hypot(lx, ly, lz) || 1e-9;
        lx /= d; ly /= d; lz /= d;
        k *= (l.range * l.range) / (l.range * l.range + d * d);
      }
      // The unshadowed Lambert term with the bump's normal; visibility from the field's normal side.
      const nl = Math.max(0, nn[0] * lx + nn[1] * ly + nn[2] * lz);
      for (let c3 = 0; c3 < 3; c3++) Dl[(i * NL + li) * 3 + c3] = nl * 0.85 * k * l.color[c3];
      if (pr.N[i * 3] * lx + pr.N[i * 3 + 1] * ly + pr.N[i * 3 + 2] * lz > 0) V[i * NL + li] = rays.areaVisibility(o[0], o[1], o[2], l.ray, i % size, Math.floor(i / size));
      else V[i * NL + li] = 0;
    }
  }
  const g = guides(pr);
  // Visibility alone through the filter, the unshadowed terms kept at full resolution.
  const Vf = filterVisibility(V, NL, g, size, cell);
  // The whole diffuse term through the same filter (what accel's first version did): the bump is in it, and the
  // guides do not see the bump.
  const whole = new Float32Array(n * 3);
  for (let i = 0; i < n; i++) for (let c3 = 0; c3 < 3; c3++) { let s = 0; for (let li = 0; li < NL; li++) s += Dl[(i * NL + li) * 3 + c3] * V[i * NL + li]; whole[i * 3 + c3] = s; }
  const wholeF = filterVisibility(whole, 3, g, size, cell);
  const compose = (pick: (i: number, c3: number) => number): Canvas => {
    const out = new Canvas(size, size, 0x101018);
    for (let i = 0; i < n; i++) {
      if (!(pr.flags[i] & 3)) continue;
      const rgb = [0, 1, 2].map((c3) => Math.max(0, Math.min(1, base[i * 3 + c3] * (amb[i * 3 + c3] + pick(i, c3)))));
      out.set(i % size, Math.floor(i / size), (Math.round(rgb[0] * 255) << 16) | (Math.round(rgb[1] * 255) << 8) | Math.round(rgb[2] * 255));
    }
    return out;
  };
  const sumDV = (Vs: Float32Array) => (i: number, c3: number) => { let s = 0; for (let li = 0; li < NL; li++) s += Dl[(i * NL + li) * 3 + c3] * Vs[i * NL + li]; return s; };
  const raw = compose(sumDV(V)), visOnly = compose(sumDV(Vf)), wholeOnly = compose((i, c3) => wholeF[i * 3 + c3]);
  const head = renderBeauty(shape, mesh, c.bounds, { ...c.opts, size, label: undefined });
  // accel's crop: the door's right edge, the torch and the stone round it, at twice the size.
  const cx = Math.round((250 / 384) * size), cy = Math.round((40 / 384) * size), cw = Math.round((120 / 384) * size), ch = Math.round((140 / 384) * size);
  const crop = (src: Canvas) => { const k = 2, out = new Canvas(cw * k, ch * k); for (let y = 0; y < ch * k; y++) for (let x = 0; x < cw * k; x++) out.set(x, y, src.get(cx + Math.floor(x / k), cy + Math.floor(y / k))); return out; };
  const file = join(outDir, `door_filter_crop_${size}.png`);
  writeFileSync(file, panel(`door ${size}px, torch and stone: area-light visibility through the filter (8 rays, radius ${filterRadius(size)} px)`, [
    { c: crop(head), caption: "HEAD's beauty.png" },
    { c: crop(raw), caption: "8 rays, unfiltered" },
    { c: crop(wholeOnly), caption: "whole diffuse filtered" },
    { c: crop(visOnly), caption: "visibility only filtered" },
  ]).toPng());
  writeFileSync(join(outDir, `door_filter_full_${size}.png`), panel(`door ${size}px: unfiltered | visibility filtered`, [{ c: raw, caption: "8 rays, unfiltered" }, { c: visOnly, caption: "visibility only filtered" }]).toPng());
  // How much of the bump survives: the high-pass energy of the light falling on the wall's stone faces (the
  // lighting term alone, so the bricks' printed mortar does not count), in the crop, against the unfiltered rays.
  const stone = shape.hit(pr.P[(cy + ch - 10) * size * 3 + (cx + 12) * 3], pr.P[(cy + ch - 10) * size * 3 + (cx + 12) * 3 + 1], pr.P[(cy + ch - 10) * size * 3 + (cx + 12) * 3 + 2]).mat;
  const stoneId = mesh.materials.indexOf(stone);
  const hp = (light: (i: number) => number) => {
    let e = 0, k = 0;
    for (let y = cy + 1; y < cy + ch - 1; y++)
      for (let x = cx + 1; x < cx + cw - 1; x++) {
        const i = y * size + x;
        const ok = (j: number) => (pr.flags[j] & 3) === KIND_MODEL && !(pr.flags[j] & FLAG_EDGE) && pr.mat[j] === stoneId;
        if (!ok(i) || !ok(i - 1) || !ok(i + 1) || !ok(i - size) || !ok(i + size)) continue;
        const l = light(i) - (light(i - 1) + light(i + 1) + light(i - size) + light(i + size)) / 4;
        e += l * l; k++;
      }
    return Math.sqrt(e / Math.max(1, k)) * 255;
  };
  const lum = (f: (i: number, c3: number) => number) => (i: number) => 0.2126 * f(i, 0) + 0.7152 * f(i, 1) + 0.0722 * f(i, 2);
  return `door crop, ${stone.name} faces: high-pass RMS of the light on them (bump detail, levels of light): unfiltered ${hp(lum(sumDV(V))).toFixed(2)}, whole diffuse filtered ${hp(lum((i, c3) => wholeF[i * 3 + c3])).toFixed(2)}, visibility filtered ${hp(lum(sumDV(Vf))).toFixed(2)}, unshadowed ${hp(lum(sumDV(new Float32Array(n * NL).fill(1)))).toFixed(2)} -> ${file}`;
}

// ---- the largest render-set mesh ----

async function largest(): Promise<string> {
  const programs = (dir: string): string[] => readdirSync(join(ROOT, dir)).sort().flatMap((e) => {
    const full = join(dir, e);
    if (statSync(join(ROOT, full)).isDirectory()) return e === "renders" ? [] : programs(full);
    return e.endsWith(".aix") && !/_probe(_[^/]*)?\.aix$/.test(e) ? [full] : [];
  });
  const files = [...programs("examples"), ...programs("dogfood"), ...programs("std")];
  let best = { file: "", tris: 0 };
  for (const f of files) {
    try {
      const c = await capture(f, 64);
      const t = c.mesh.indices.length / 3;
      console.log(`  ${relative(ROOT, join(ROOT, f)).padEnd(44)} ${t} triangles`);
      if (t > best.tris) best = { file: f, tris: t };
    } catch (e) { console.log(`  ${f}: ${(e as Error).message}`); }
  }
  const c = await capture(best.file, 64);
  const times: number[] = [];
  for (let r = 0; r < 3; r++) { const t0 = performance.now(); buildBvh(c.mesh); times.push(performance.now() - t0); }
  return `largest render-set mesh: ${best.file}, ${best.tris} triangles; BVH build ${times.map((t) => t.toFixed(0)).join("/")} ms`;
}

// ---- main ----

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const flag = (n: string, d: string) => { const i = args.indexOf(n); if (i < 0) return d; const v = args[i + 1]; args.splice(i, 2); return v; };
  const size = Number(flag("--size", "384"));
  const out = flag("--out", join(tmpdir(), "aixle-rays-bench"));
  const modes = new Set(flag("--modes", "faith,cost,early").split(","));
  FIELD_STEP = Number(flag("--field-step", "0.5"));

  FIELD_STEPS = Number(flag("--field-steps", String(1 << 16)));
  mkdirSync(out, { recursive: true });
  const names = args.length && !modes.has("build") ? args : Object.keys(SCENES);
  const lines: string[] = [];
  const log = (s: string) => { console.log(s); lines.push(s); };
  if (modes.has("faith") || modes.has("cost") || modes.has("early") || modes.has("noise"))
    for (const name of names) {
      const c = await capture(SCENES[name], size);
      const sc = scene(name, c);
      const builds: number[] = [];
      let bvh: BvhData | undefined;
      for (let r = 0; r < 3; r++) { const t0 = performance.now(); bvh = buildBvh(sc.mesh); builds.push(performance.now() - t0); }
      const rays = createRays(sc.shape, sc.mesh, bvh!, sc.cell, sc.model, sc.reach);
      const pr = primary(sc, size);
      log(`== ${name}: ${sc.mesh.indices.length / 3} triangles, ${bvh!.nodes} nodes (depth ${bvh!.depth}), built in ${Math.min(...builds).toFixed(0)} ms; cell ${sc.cell.toPrecision(3)}; ${sc.lights.length} light(s)${bvh!.anyGlass ? "; glass" : ""}`);
      if (modes.has("faith")) {
        const f = faith(sc, pr, rays, out);
        log(`  occlusion (key, hard): ${pct(f.shadowDis, f.shadowPixels)} of ${f.shadowPixels} lit-facing pixels differ from the field; ${f.shadowDisOffEdge} of them off a shadow edge; ${f.fieldOnly} the field's shadow the mesh misses; ${pct(f.facedDis, f.faced)} where n.L > 0.1`);
        log(`  closest (mirror rays): ${pct(f.reflDis, f.refl)} of ${f.refl} hit/miss differ; of ${f.both} hits both ways ${pct(f.within005, f.both)} within 0.05 cell, ${pct(f.over2, f.both)} over 2 cells; BVH-confirmed ${f.confirmed}, ${pct(f.confirmedWithin005, f.confirmed)} within 0.05 cell; ${f.trusted} trusted`);
      }
      if (modes.has("cost")) {
        const k = cost(sc, pr, rays, Math.min(...builds));
        log(`  cost: occlusion beyond NEAR (BVH any-hit) median ${k.farMedianUs.toFixed(3)} us, mean ${k.farMeanUs.toFixed(3)} us over ${k.farRays} rays; with glass crossed ${k.beyondMedianUs.toFixed(3)} us median, ${k.beyondMeanUs.toFixed(3)} us mean; occlusion() ${k.occMeanUs.toFixed(2)} us vs field march ${k.fieldOccMeanUs.toFixed(2)} us`);
        log(`        closest() ${k.closestUs.toFixed(2)} us vs field march (128 steps) ${k.field128Us.toFixed(2)} us = ${(k.closestUs / k.field128Us).toFixed(2)}x (uncapped ${k.fieldFullUs.toFixed(2)} us); areaVisibility ${k.areaUs.toFixed(2)} us, early out ${(100 * k.earlyOutRate).toFixed(1)}%`);
      }
      if (modes.has("noise")) log(noise(sc, pr, rays));
      if (modes.has("early")) {
        const e = early(sc, pr, rays, out);
        log(`  early out: ${pct(e.over2, e.pixels)} of ${e.pixels} pixels differ from always-8 by > 2 levels after filtering (max ${e.maxLevels.toFixed(1)}); unfiltered ${pct(e.rawOver2, e.pixels)}`);
      }
    }
  if (modes.has("cube")) {
    const rows: Canvas[] = [];
    for (const s of [1, 3]) {
      for (const eo of [false, true]) {
        const p = cubePenumbra(s, 64, 192, eo).profile;
        log(`cube, light size ${s}, early out ${eo ? "on" : "off"}: 50% line rays ${p.measured50.toFixed(4)}, filtered ${p.filtered50.toFixed(4)} (analytic ${p.analytic50.toFixed(4)}); width rays ${p.measuredWidth.toFixed(4)} (${((p.measuredWidth / p.analyticWidth - 1) * 100).toFixed(1)}%), filtered ${p.filteredWidth.toFixed(4)} (${((p.filteredWidth / p.analyticWidth - 1) * 100).toFixed(1)}%); penumbra RMS raw ${p.rmsRaw.toFixed(4)}, filtered ${p.rmsFiltered.toFixed(4)}`);
      }
      const { profile: p, pics } = cubePenumbra(s);
      log(`cube, light size ${s} (theta ${lightAngle(s).toFixed(4)} rad): geometric edge z ${p.edge.toFixed(3)}; 50% line analytic ${p.analytic50.toFixed(4)}, rays ${p.measured50.toFixed(4)}, filtered ${p.filtered50.toFixed(4)}; 10-90% width analytic ${p.analyticWidth.toFixed(4)}, rays ${p.measuredWidth.toFixed(4)} (${((p.measuredWidth / p.analyticWidth - 1) * 100).toFixed(1)}%), filtered ${p.filteredWidth.toFixed(4)} (${((p.filteredWidth / p.analyticWidth - 1) * 100).toFixed(1)}%)`);
      rows.push(panel(`light size ${s}: the floor behind a unit cube, seen from above (the cube's top edge's shadow across the middle)`, [
        { c: pics[0], caption: "8 rays a pixel" }, { c: pics[1], caption: "filtered" }, { c: pics[2], caption: "exact at x = 0" }, { c: pics[3], caption: "exact black, raw blue, filt red" },
      ]));
    }
    const h = rows.reduce((s, r) => s + r.height, 0), w = Math.max(...rows.map((r) => r.width));
    const all = new Canvas(w, h, 0xf4f2ee);
    let y = 0;
    for (const r of rows) { all.blit(r, 0, y); y += r.height; }
    writeFileSync(join(out, "cube_penumbra.png"), all.toPng());
  }
  if (modes.has("door")) log(await door(size, out));
  if (modes.has("largest")) log(await largest());
  if (modes.has("build"))
    for (const file of args) {
      const c = await capture(file, 64);
      const times: number[] = [];
      for (let r = 0; r < 4; r++) { const t0 = performance.now(); buildBvh(c.mesh); times.push(performance.now() - t0); }
      log(`${file}: ${c.mesh.indices.length / 3} triangles; BVH build cold ${times[0].toFixed(0)} ms, then ${times.slice(1).map((t) => t.toFixed(0)).join("/")} ms`);
    }
  writeFileSync(join(out, `bench_${[...modes].join("_")}_${size}.txt`), lines.join("\n") + "\n");
}

if (process.argv[1] && /rays-bench\.(ts|js)$/.test(process.argv[1])) main().then(() => process.exit(0), (e) => { console.error(e); process.exit(1); });
