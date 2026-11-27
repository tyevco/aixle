/**
 * The beauty render: the distance field itself, ray-marched, with shadows, ambient occlusion and a studio floor. The
 * checking views draw the extracted mesh because that is the file you get; this one draws the field because that is
 * the model you meant, at full sharpness.
 *
 * This file is the orchestrator. The shading is a kernel (kernel.ts: the classic one is classic.ts), which draws a
 * picture in rows, two passes and a finish; here the camera is fitted, the mesh rasterised for the depth every
 * primary ray starts from, the kernel's buffers allocated and its rows run, on this thread or shared out among the
 * run's worker pool (beauty-pool.ts). Every pixel is a pure function of its position and the scene, so the bytes are
 * the same on any number of threads.
 */
import { normalize, type Vec3 } from "../core/vec.js";
import { boundsSize, type Bounds, type Shape3 } from "../sdf/types.js";
import type { Mesh } from "../mesh/mesh.js";
import { perspective, type Camera } from "./camera.js";
import { Canvas, rgbf } from "./canvas.js";
import { createTarget, renderMesh } from "./raster.js";
import type { BeautyPool } from "./beauty-pool.js";
import { classic } from "./classic.js";
import { allocBuffers, beautyCache, materialIds, materialKey, type BeautyCache, type Kernel, type KernelContext, type KernelResult } from "./kernel.js";

export { beautyCache, type BeautyCache, type Kernel, type KernelResult } from "./kernel.js";

/** One light in the beauty render: a direction, an apparent size, a colour and a power. */
export interface BeautyLight {
  name?: string;
  /** Degrees about y (0 is +z, the front; 90 is +x) and above the floor. */
  azimuth: number;
  elevation: number;
  /** Apparent size: 0.5 is a small lamp with crisp shadows, 3 a window. */
  size: number;
  color: Vec3;
  /** 1 is the default key light's strength. */
  power: number;
  /** A point light: its place; azimuth and elevation are unused. Its strength halves `range` away from it (half the model's longest side when unset). */
  position?: Vec3;
  range?: number;
}

/** The procedural skies the metals reflect and the floor sits in. */
export type Environment = "studio" | "overcast" | "sunset" | "night";
export const ENVIRONMENTS: Environment[] = ["studio", "overcast", "sunset", "night"];

interface Palette {
  sky: Vec3;
  /** A band at the horizon between ground and sky; absent, the sky fades straight from the ground colour. */
  horizon?: Vec3;
  ground: Vec3;
  floor: Vec3;
  /** Multiplier on the sky and ground light. */
  ambient: number;
}

const PALETTES: Record<Environment, Palette> = {
  // The studio: the grey-white backdrop every render has had.
  studio: { sky: [0.78, 0.83, 0.9], ground: [0.93, 0.92, 0.9], floor: [0.88, 0.87, 0.85], ambient: 1 },
  // A white sky: soft, even light with little shadow contrast.
  overcast: { sky: [0.84, 0.86, 0.88], horizon: [0.9, 0.9, 0.9], ground: [0.8, 0.8, 0.8], floor: [0.8, 0.8, 0.79], ambient: 1.25 },
  // Evening: a warm band at the horizon under a blue sky, warm ground.
  sunset: { sky: [0.32, 0.36, 0.62], horizon: [0.98, 0.62, 0.36], ground: [0.55, 0.42, 0.36], floor: [0.62, 0.52, 0.45], ambient: 0.9 },
  // Night: a dark blue sky and a dark floor, so a glow material carries the picture.
  night: { sky: [0.04, 0.06, 0.14], horizon: [0.1, 0.11, 0.2], ground: [0.07, 0.07, 0.1], floor: [0.14, 0.14, 0.17], ambient: 0.4 },
};

/** A sky's colours and its ambient strength, 0..1 as the beauty render draws them: what the viewer's scene mode builds its sky from. */
export function environmentPalette(env?: Environment): { sky: Vec3; horizon?: Vec3; ground: Vec3; floor: Vec3; ambient: number } {
  const p = PALETTES[env ?? "studio"];
  return { sky: [...p.sky], ...(p.horizon ? { horizon: [...p.horizon] as Vec3 } : {}), ground: [...p.ground], floor: [...p.floor], ambient: p.ambient };
}

/** The default key light's direction (towards the light), for a viewer that lights the program's scene without declared lights. */
export const DEFAULT_LIGHT_DIRECTION: Vec3 = normalize([-0.55, 0.9, 0.65]);

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
  /** The lights, when the program declares them; otherwise the one key light the light* options describe. */
  lights?: BeautyLight[];
  environment?: Environment;
  /** The points the camera fits instead of the whole mesh: a camera framed on one step fits that step's points. */
  fitPoints?: Float32Array;
  /** The whole model's box when `bounds` is a focus frame: the march, the shadows and the floor reach all of it. */
  reachBounds?: Bounds;
  /** The distance wear reads curvature over (the worn band's width); default `wearProbe` of the model's longest side, as the atlas baker uses. */
  wearProbe?: number;
  /** size * size flags, set to 1 where the surface a pixel sees glows (left as they are elsewhere): what lights.png's frames of what a light adds leave out. */
  glowMask?: Uint8Array;
  /** How much a kernel samples: full for beauty.png and the shots, draft for the strips. The classic kernel has one budget. */
  quality?: "draft" | "full";
  /** Keep what each light brings apart, for lights.png (a kernel without slots ignores it). */
  splitLights?: boolean;
  /** The run's worker pool: the rows are shared out among its threads, the bytes the same as on one. */
  pool?: BeautyPool;
  /** The run's tables kept between its beauty renders (a BVH per mesh, an environment per sky); absent, a render builds its own. */
  cache?: BeautyCache;
  /** The kernel by name, DEFAULT_KERNEL when absent: for tests and benches that compare two. */
  kernel?: string;
}

/** A light's direction from its azimuth about y (0 is +z, 90 is +x) and elevation, in degrees. */
export function lightDirection(azimuth: number, elevation: number): Vec3 {
  const az = (azimuth * Math.PI) / 180, el = (elevation * Math.PI) / 180;
  return normalize([Math.sin(az) * Math.cos(el), Math.sin(el), Math.cos(az) * Math.cos(el)]);
}

/** The kernels by name. The registry is read when a render starts, so a kernel's module may import this one. */
function kernels(): Record<string, Kernel> {
  return { classic: classic as Kernel };
}

/** The kernel every render uses unless its options name another. */
export const DEFAULT_KERNEL = "classic";

/** A kernel by name (the default when none is given); a worker finds the job's kernel here. */
export function kernelByName(name: string = DEFAULT_KERNEL): Kernel {
  const k = kernels()[name];
  if (!k) throw new Error(`no beauty kernel named ${name}; the kernels are ${Object.keys(kernels()).join(", ")}`);
  return k;
}

/** The render's camera: the frame fitted from the azimuth, elevation and zoom, on the mesh's points (or `fitPoints`). */
export function beautyCamera(mesh: Mesh, bounds: Bounds, opts: BeautyOptions): Camera {
  return perspective(bounds, opts.size, opts.size, opts.azimuth ?? 35, opts.elevation ?? 25, 30, opts.zoom ?? 1, opts.fitPoints ?? mesh.positions);
}

/** The rasterised mesh's view depth per pixel from the camera: where each primary ray starts its short march. */
export function beautyPrime(mesh: Mesh, camera: Camera, size: number, shared = false): Float32Array {
  const prime = createTarget(size, size, 0);
  renderMesh(mesh, camera, prime, { background: 0, outline: false, solidGlass: true });
  if (!shared) return prime.depth;
  const out = new Float32Array(new SharedArrayBuffer(size * size * 4));
  out.set(prime.depth);
  return out;
}

/** The beauty render of `shape` (meshed as `mesh`), framed on `bounds`. */
export function renderBeauty(shape: Shape3, mesh: Mesh, bounds: Bounds, opts: BeautyOptions): Canvas {
  return renderBeautyResult(shape, mesh, bounds, opts).canvas;
}

/**
 * The beauty render with what the kernel keeps besides the picture (its linear radiance per slot, when it has it).
 * With `opts.pool` the rows are shared out among the pool's threads; the bytes are the same on any number of threads,
 * and a pool that fails draws the picture again on this one.
 */
export function renderBeautyResult(shape: Shape3, mesh: Mesh, bounds: Bounds, opts: BeautyOptions): KernelResult {
  const kernel = kernelByName(opts.kernel);
  const size = opts.size;
  const model = opts.reachBounds ?? bounds;
  // The mesh's cell sets every step and offset; a floor of 1e-4 units made them three times the cell of a 4 mm mug
  // drawn in metres, which lost its contact shadows. Only an unknown cell falls back, to the model's own.
  const cell = opts.cellSize > 0 ? opts.cellSize : Math.max(...boundsSize(model)) / 128 || 1e-4;
  const camera = beautyCamera(mesh, bounds, opts);
  const pool = opts.pool && opts.pool.live ? opts.pool : undefined;
  const prime = beautyPrime(mesh, camera, size, !!pool);
  const cache = opts.cache ?? beautyCache();
  const tables = kernel.prepare ? kernel.prepare({ shape, mesh, bounds, opts, camera, prime, size, cell, cache, shared: !!pool }) : undefined;
  const layout = kernel.layout(opts, size);
  const ids = materialIds(mesh.materials.map(materialKey));
  if (pool) {
    const done = pool.render(kernel, { shape, mesh, bounds, opts, camera, prime, size, cell, tables, layout, ids });
    if (done) return done;
  }
  const ctx: KernelContext = { shape, mesh, bounds, opts, camera, prime, size, cell, buffers: allocBuffers(layout, size, false), tables, ids };
  const rows = kernel.rows(ctx);
  for (let y = 0; y < size; y++) rows.primary(y);
  for (let y = 0; y < size; y++) rows.edges(y);
  return kernel.finish(ctx);
}

/** What lights.png draws where a glowing part is, in the frames of what a light adds: flat, so no false colour reads there. */
export const GLOW_GREY = 0x585858;

/**
 * What one light adds to a picture: the render under that light alone minus the render under no light at all (the
 * ambient sky, the glows and the reflections), brightened so its brightest part is near white, on black. A small
 * point light adds a few dim pixels to a whole render (round 10: a ring's spark could be seen in lights.png but not
 * judged); here its reach and its colour fill the frame. The gain is the brightening, 1 to 32; both pictures must be
 * the same shot, unlabelled. Where `glow` flags a glowing surface the frame is flat grey and the gain ignores it: a
 * glow near white in both pictures differs only in the channels that were not already full, so a flame a light
 * barely touches came out bright green, brightened (round 11).
 */
export function lightContribution(alone: Canvas, none: Canvas, glow?: Uint8Array): { canvas: Canvas; gain: number } {
  const w = alone.width, h = alone.height;
  const out = new Canvas(w, h, 0);
  const diff = new Float32Array(w * h * 3);
  const peaks: number[] = [];
  for (let i = 0; i < w * h; i++) {
    if (glow?.[i]) continue;
    let peak = 0;
    for (let c = 0; c < 3; c++) {
      const d = Math.max(0, alone.data[i * 4 + c] - none.data[i * 4 + c]);
      diff[i * 3 + c] = d;
      peak = Math.max(peak, d);
    }
    if (peak > 1) peaks.push(peak);
  }
  // The brightest part is a near-white highlight, but a few saturated pixels should not set the gain: the 99th
  // percentile of what the light reaches does.
  peaks.sort((a, b) => a - b);
  const p = peaks.length ? peaks[Math.min(peaks.length - 1, Math.floor(peaks.length * 0.99))] : 0;
  const gain = p > 0 ? Math.max(1, Math.min(32, 230 / p)) : 1;
  for (let i = 0; i < w * h; i++) out.set(i % w, Math.floor(i / w), glow?.[i] ? GLOW_GREY : rgbf((diff[i * 3] * gain) / 255, (diff[i * 3 + 1] * gain) / 255, (diff[i * 3 + 2] * gain) / 255));
  return { canvas: out, gain };
}
