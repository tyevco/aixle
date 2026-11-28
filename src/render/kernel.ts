/**
 * The beauty render's kernel: the shading model, written so the orchestrator (beauty.ts) can run it on one thread or
 * on the worker pool (beauty-pool.ts) and get the same bytes either way.
 *
 * A render is two passes over rows and a finish:
 * - `primary(y)` shades every pixel of row y once, into the kernel's own per-pixel buffers;
 * - every row's primary is done before any row's `edges(y)` starts (the pool's barrier);
 * - `edges(y)` reads row y and its neighbours from the buffers, decides which pixels are edges and resamples them,
 *   writing only row y;
 * - `finish` runs once on the main thread and turns the buffers into the picture.
 *
 * Every pixel must be a pure function of its position and the scene: no Math.random, no clock, no state that one row
 * leaves for the next. Then which thread drew which row cannot change a byte. A kernel's buffers are typed arrays the
 * orchestrator allocates from `layout` (SharedArrayBuffers on the pool); its `prepare` runs once per render on the main
 * thread and returns tables every thread reads (plain typed arrays, shared, never written after prepare).
 *
 * On the pool each worker has its own shape, built by evaluating the program again (closures cannot cross threads),
 * its own copy of the options (without `pool`, `cache` and `fitPoints`, which stay on the main thread),
 * the camera and prime depth the main thread made, and the mesh's arrays shared. Its materials are its own objects,
 * so a kernel names a material by `ids(m)`, which every thread computes alike, never by object identity.
 */
import type { Mesh } from "../mesh/mesh.js";
import type { Bounds, Material, Shape3 } from "../sdf/types.js";
import type { Camera } from "./camera.js";
import type { Canvas } from "./canvas.js";
import type { BeautyOptions } from "./beauty.js";

/** A buffer's element type: Float32Array, Float64Array, Int32Array or Uint8Array. */
export type BufferType = "f32" | "f64" | "i32" | "u8";
export type PixelBuffer = Float32Array | Float64Array | Int32Array | Uint8Array;

/** One per-pixel buffer a kernel asks for: `per` elements for each of the size × size pixels. */
export interface BufferSpec {
  name: string;
  type: BufferType;
  per: number;
}

/** A kernel's buffers by name, as `layout` asked for them. */
export type Buffers = Record<string, PixelBuffer>;

/**
 * What one run keeps between its beauty renders (beauty.png, each camera's shot, the strips): built tables a kernel
 * would otherwise build again, the BVH per mesh and the environment's tables per key. Made by run() and dropped with
 * the run, so nothing grows across a render set's programs.
 */
export interface BeautyCache {
  bvh: WeakMap<Mesh, unknown>;
  env: Map<string, unknown>;
}

export function beautyCache(): BeautyCache {
  return { bvh: new WeakMap(), env: new Map() };
}

/** The scene as the main thread has it, for `prepare`. */
export interface MainContext {
  shape: Shape3;
  mesh: Mesh;
  /** The frame the camera is fitted to. */
  bounds: Bounds;
  opts: BeautyOptions;
  camera: Camera;
  /** The rasterised mesh's view depth per pixel (Infinity where it has none): where each primary ray starts. */
  prime: Float32Array;
  size: number;
  /** The extraction's cell, every step and offset's unit (the model's size / 128 when the mesh's is unknown). */
  cell: number;
  /** The run's cache, or a fresh one for a render on its own. */
  cache: BeautyCache;
  /** True when the render runs on the pool: tables made with `array` are SharedArrayBuffer-backed. */
  shared: boolean;
}

/** The mesh as every thread has it: the main thread's own, or the shared arrays and a copy of the materials in a worker. */
export type KernelMesh = Pick<Mesh, "positions" | "normals" | "local" | "materialIndex" | "indices" | "materials">;

/** What a kernel's rows and finish read: the same fields on every thread, `shape` and `ids` each thread's own. */
export interface KernelContext<T = unknown> {
  shape: Shape3;
  mesh: KernelMesh;
  bounds: Bounds;
  opts: BeautyOptions;
  camera: Camera;
  prime: Float32Array;
  size: number;
  cell: number;
  buffers: Buffers;
  /** What `prepare` returned. */
  tables: T;
  /** A material's id: the index of the first of the mesh's materials with the same materialKey, or -1. */
  ids: (m: Material) => number;
}

export interface KernelRows {
  primary(y: number): void;
  edges(y: number): void;
}

export interface KernelResult {
  canvas: Canvas;
  /** Linear radiance per slot (3 floats a pixel), when the kernel keeps it: one slot, or one per light and the sky's with splitLights. */
  hdr?: Float32Array[];
  /** What each pixel's primary ray met (photometry's KIND_ and FLAG_ bits), when the kernel keeps it: for a picture composed again from the slots (lights.png). */
  flags?: Uint8Array;
  /**
   * With splitLights, at each edge pixel (FLAG_EDGE) the mean of its samples' tone-mapped colours (linear display
   * values, 0 to 1) under no light, then under each light alone: 3 floats a frame, one frame more than the lights, a
   * pixel; zero off the edges. The slots keep an edge pixel's samples only as their linear mean, where the picture
   * means them after the tone curve, so lights.png's frames take their edge pixels from here.
   */
  edgeDisplay?: Float32Array;
}

export interface Kernel<T = unknown> {
  name: string;
  /** The per-pixel buffers this render needs (they may depend on the lights and splitLights). */
  layout(opts: BeautyOptions, size: number): BufferSpec[];
  /** Once per render, on the main thread: the tables every thread shares. */
  prepare?(ctx: MainContext): T;
  /** One thread's rows: called once per render on each thread, so its scratch is that thread's. */
  rows(ctx: KernelContext<T>): KernelRows;
  /** On the main thread, after every row's edges. */
  finish(ctx: KernelContext<T>): KernelResult;
}

/** A typed array of `n` elements, on a SharedArrayBuffer when `shared`. */
export function typedArray(type: BufferType, n: number, shared: boolean): PixelBuffer {
  const bytes = type === "f64" ? 8 : type === "u8" ? 1 : 4;
  const buf = shared ? new SharedArrayBuffer(n * bytes) : new ArrayBuffer(n * bytes);
  return type === "f32" ? new Float32Array(buf) : type === "f64" ? new Float64Array(buf) : type === "i32" ? new Int32Array(buf) : new Uint8Array(buf);
}

/** A kernel's buffers for a size × size render, zeroed. */
export function allocBuffers(layout: BufferSpec[], size: number, shared: boolean): Buffers {
  const out: Buffers = {};
  for (const b of layout) out[b.name] = typedArray(b.type, size * size * b.per, shared);
  return out;
}

/**
 * A material's identity by value, the same in every thread: a worker's materials are its own objects, made by its
 * own evaluation. Two materials alike in all of these are one material to the edge test. A picture is its file and
 * how it is laid on, a decal's box included: one picture fitted to two regions is two paints.
 */
export function materialKey(m: Material): string {
  const im = m.image;
  const box = im?.box ? `:${im.box.min.join(",")}:${im.box.max.join(",")}` : "";
  return [m.name, m.color.join(","), m.color2.join(","), m.pattern, m.scale, m.metal, m.rough, m.transmit, m.seed, m.axis, m.glow, im ? `${im.name}:${im.width}x${im.height}:${im.projection}:${im.axis}:${im.size}${box}` : "", m.bump ?? 0, m.bumpScale ?? 0, m.wear ?? 0].join("|");
}

/**
 * The id function for a mesh's materials, from their keys: the first index with the same key, -1 for a material the
 * mesh does not have. Looked up once per material object, then by identity.
 */
export function materialIds(keys: readonly string[]): (m: Material) => number {
  const first = new Map<string, number>();
  keys.forEach((k, i) => { if (!first.has(k)) first.set(k, i); });
  const seen = new WeakMap<Material, number>();
  return (m) => {
    let id = seen.get(m);
    if (id === undefined) { id = first.get(materialKey(m)) ?? -1; seen.set(m, id); }
    return id;
  };
}
