/**
 * The beauty render on several threads: a pool of workers kept for the life of the process, each drawing rows of
 * the picture beside the main thread.
 *
 * The shape is a tree of closures the interpreter built, which cannot cross to another thread, so each worker builds
 * its own by evaluating the program again: the same source, pose, slice and shown steps, the libraries and pictures
 * read again, and each import's samples as the main thread recorded them (never sampled again). A worker keeps one
 * shape, the program it was last sent, and builds it while the main thread meshes (run() posts the program first).
 * Everything else crosses as data: the options, the camera, the mesh's arrays (shared, once per mesh), the kernel's
 * tables and, per render, the primed depth and the kernel's buffers, all on SharedArrayBuffers.
 *
 * Rows are claimed one at a time from an atomic counter by every thread, the main thread too, so a worker still
 * building its shape simply claims none. A barrier (every primary row done) comes before the edge pass. Each job
 * carries the main thread's field at 64 points; a worker whose own field differs at any of them, to the bit, claims
 * nothing, and the main thread says once that it drew without it.
 *
 * The pipeline is synchronous, and so is this: the main thread posts the job, draws rows itself, and waits on the
 * counters with Atomics.wait, which Node allows on the main thread. It cannot hear a worker's events while it
 * waits, so failure is read from shared memory: a worker that throws or exits sets the job's error word; a job that
 * stops moving for a minute is taken as failed too. Then the job is dropped and drawn again on the main thread alone
 * (the same bytes), and the pool is off for the rest of the process. The workers are unref'd, so the pool never keeps
 * the process alive.
 */
import { Worker } from "node:worker_threads";
import { createHash } from "node:crypto";
import { createRequire } from "node:module";
import { availableParallelism } from "node:os";
import { pathToFileURL } from "node:url";
import type { MeshSamples } from "../mesh/meshSdf.js";
import type { Mesh } from "../mesh/mesh.js";
import type { Bounds, JointPose, Material, Shape3 } from "../sdf/types.js";
import type { Camera } from "./camera.js";
import type { BeautyOptions } from "./beauty.js";
import { allocBuffers, materialKey, type BufferSpec, type Kernel, type KernelContext, type KernelMesh, type KernelResult } from "./kernel.js";

/** What a worker needs to build the shape again: the program, the pose, slice and steps shown, and each import's samples. */
export interface ProgramRef {
  source: string;
  sourceName: string;
  jointPoses?: Record<string, JointPose>;
  poseName?: string;
  slice?: string;
  show?: string[];
  /** Each import's samples, by importSampleKey, as the main evaluation recorded them. */
  importSamples?: Map<string, MeshSamples>;
}

/** The mesh as it crosses to a worker: its arrays on SharedArrayBuffers, its materials copied, and their keys. */
export interface SharedMesh extends KernelMesh {
  keys: string[];
}

/** A render's control words. Per thread from ROWS: the primary rows it drew (the main thread first); per worker from ROWS + threads: its status. */
export const NEXT = 0, DONE = 1, ENEXT = 2, EDONE = 3, ERROR = 4, ROWS = 8;
/** A worker's status in a job: drawing, its field differs from the main thread's, it has no shape for this program, done, failed. */
export const WORKING = 1, MISMATCH = 2, NO_SHAPE = 3, FINISHED = 4, FAILED = 5;
/** Why a job's error word is set: a worker threw, a worker exited, nothing moved for STALL waits, the main thread stopped it. */
export const THREW = 1, EXITED = 2, STALLED = 3, STOPPED = 4;
/** Waits of 100 ms with no row finished before a job is taken as failed: a minute. */
const STALL = 600;

/** Wait until ctl[at] reaches `target`; false when the job is stopped or nothing has moved for STALL waits. */
export function waitFor(ctl: Int32Array, at: number, target: number): boolean {
  let last = Atomics.load(ctl, at), still = 0;
  for (let v = last; v < target; v = Atomics.load(ctl, at)) {
    if (Atomics.load(ctl, ERROR)) return false;
    if (v !== last) { last = v; still = 0; }
    else if (++still > STALL) { Atomics.compareExchange(ctl, ERROR, 0, STALLED); return false; }
    Atomics.wait(ctl, at, v, 100);
  }
  return true;
}

/** Claim and draw rows until none are left, then, once every primary row is done, the same for the edges. False when the job was stopped. */
export function workRows(ctl: Int32Array, size: number, primary: (y: number) => void, edges: (y: number) => void, who: number): boolean {
  for (let y = Atomics.add(ctl, NEXT, 1); y < size; y = Atomics.add(ctl, NEXT, 1)) {
    primary(y);
    Atomics.add(ctl, ROWS + who, 1);
    if (Atomics.add(ctl, DONE, 1) + 1 === size) Atomics.notify(ctl, DONE);
  }
  if (!waitFor(ctl, DONE, size)) return false;
  for (let y = Atomics.add(ctl, ENEXT, 1); y < size; y = Atomics.add(ctl, ENEXT, 1)) {
    edges(y);
    if (Atomics.add(ctl, EDONE, 1) + 1 === size) Atomics.notify(ctl, EDONE);
  }
  return true;
}

/** Stop a job: nothing more is claimed, and every thread waiting on it wakes and leaves. */
export function stopJob(ctl: Int32Array, why: number): void {
  Atomics.compareExchange(ctl, ERROR, 0, why);
  Atomics.store(ctl, NEXT, 1 << 30);
  Atomics.store(ctl, ENEXT, 1 << 30);
  Atomics.notify(ctl, DONE);
  Atomics.notify(ctl, EDONE);
}

/** The 4 × 4 × 4 lattice in a box the main thread's field is checked at, and its distances there. */
export function fieldCheck(shape: Shape3, b: Bounds): { at: Float64Array; d: Float64Array } {
  const at = new Float64Array(64 * 3), d = new Float64Array(64);
  let k = 0;
  for (let i = 0; i < 4; i++)
    for (let j = 0; j < 4; j++)
      for (let l = 0; l < 4; l++, k++) {
        const x = b.min[0] + ((b.max[0] - b.min[0]) * (i + 0.5)) / 4, y = b.min[1] + ((b.max[1] - b.min[1]) * (j + 0.5)) / 4, z = b.min[2] + ((b.max[2] - b.min[2]) * (l + 0.5)) / 4;
        at[k * 3] = x; at[k * 3 + 1] = y; at[k * 3 + 2] = z;
        d[k] = shape.dist(x, y, z);
      }
  return { at, d };
}

/** Whether a shape's field is, bit for bit, the one the check was taken of. */
export function fieldMatches(shape: Shape3, check: { at: Float64Array; d: Float64Array }): boolean {
  const pair = new Float64Array(2), bits = new BigUint64Array(pair.buffer);
  for (let k = 0; k < check.d.length; k++) {
    pair[0] = shape.dist(check.at[k * 3], check.at[k * 3 + 1], check.at[k * 3 + 2]);
    pair[1] = check.d[k];
    if (bits[0] !== bits[1]) return false;
  }
  return true;
}

/** A hash of everything a worker's shape depends on: the same key, the same field. */
export function programKey(ref: ProgramRef): string {
  const h = createHash("sha256");
  h.update(JSON.stringify([ref.source, ref.sourceName, ref.jointPoses ?? null, ref.poseName ?? null, ref.slice ?? null, ref.show ?? null]));
  for (const [k, s] of [...(ref.importSamples ?? new Map<string, MeshSamples>())].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))) {
    h.update(`\n${k}\n${JSON.stringify([s.dims, s.origin, s.cell, s.openness, s.bounds, s.triangles])}\n`);
    h.update(new Uint8Array(s.samples.buffer, s.samples.byteOffset, s.samples.byteLength));
  }
  return h.digest("hex");
}

type Shareable = Float32Array | Float64Array | Int32Array | Uint32Array | Uint16Array | Uint8Array;

/** A typed array on a SharedArrayBuffer: itself when it already is, else a copy. */
function shared<T extends Shareable>(a: T): T {
  if (a.buffer instanceof SharedArrayBuffer) return a;
  const C = a.constructor as new (b: SharedArrayBuffer) => T;
  const out = new C(new SharedArrayBuffer(a.byteLength));
  out.set(a as never);
  return out;
}

/** Shared copies of a kernel's tables, by the identity of each array, so a table kept in the run's cache is copied once. */
const sharedCopies = new WeakMap<object, unknown>();
function shareTables(v: unknown): unknown {
  if (v === null || typeof v !== "object") return v;
  if (ArrayBuffer.isView(v)) {
    if ((v as Shareable).buffer instanceof SharedArrayBuffer || v instanceof DataView) return v;
    let c = sharedCopies.get(v);
    if (!c) { c = shared(v as Shareable); sharedCopies.set(v, c); }
    return c;
  }
  if (Array.isArray(v)) return v.map(shareTables);
  const out: Record<string, unknown> = {};
  for (const [k, x] of Object.entries(v)) out[k] = shareTables(x);
  return out;
}

/** The shared form of a mesh, once per mesh. */
const sharedMeshes = new WeakMap<Mesh, SharedMesh>();
function shareMesh(m: Mesh): SharedMesh {
  let s = sharedMeshes.get(m);
  if (!s) {
    s = { positions: shared(m.positions), normals: shared(m.normals), local: shared(m.local), materialIndex: shared(m.materialIndex), indices: shared(m.indices), materials: m.materials, keys: m.materials.map(materialKey) };
    sharedMeshes.set(m, s);
  }
  return s;
}

/** Import samples on SharedArrayBuffers, so every worker reads the main thread's copy. */
const sharedSamples = new WeakMap<MeshSamples, MeshSamples>();
function shareSamples(s: MeshSamples): MeshSamples {
  let c = sharedSamples.get(s);
  if (!c) { c = { ...s, samples: shared(s.samples) }; sharedSamples.set(s, c); }
  return c;
}

/** How tsx is loaded into a worker when the parent has it some other way (vitest, or bin/aixle.mjs's register()). */
function tsxImport(): string {
  try {
    return pathToFileURL(createRequire(import.meta.url).resolve("tsx")).href;
  } catch {
    return "tsx";
  }
}

/** One worker: its thread, what it was last sent, and the words it answers in. */
interface Slot {
  worker: Worker;
  /** [0]: the program generation it has built, or minus it when building failed; [1]: the length of `note`. */
  state: Int32Array;
  /** The last error the worker met, UTF-8. */
  note: Uint8Array;
  /** The mesh it was last sent. */
  mesh?: Mesh;
  dead: boolean;
}

const slots: Slot[] = [];
/** Why the pool is off for the rest of the process, once a worker has failed. */
let off: string | undefined;
let generation = 0;
/** Set while the pool's own terminate() runs, so those exits are not failures. */
let stopping = false;
/** The primary rows each thread drew in the last pooled render, the main thread first; and every worker's rows since the process began. */
let lastRows: number[] = [];
let workerRows = 0;

/** For tests and benches: the primary rows each thread drew in the process's last pooled render, the main thread first. */
export function lastPoolRows(): number[] {
  return [...lastRows];
}

/** For tests and benches: the primary rows the workers have drawn since the process began, every pooled render's. */
export function poolWorkerRows(): number {
  return workerRows;
}

function spawn(): Slot {
  const ts = import.meta.url.endsWith(".ts");
  const url = new URL(ts ? "./beauty-worker.ts" : "./beauty-worker.js", import.meta.url);
  // The parent's flags, so a worker loads modules as the parent does; a .ts worker needs tsx when the parent has it
  // some other way than a flag (a test runner's transform, or a register() call).
  const execArgv = [...process.execArgv];
  if (ts && !execArgv.some((a) => a.includes("tsx"))) execArgv.push("--import", tsxImport());
  const state = new Int32Array(new SharedArrayBuffer(8));
  const note = new Uint8Array(new SharedArrayBuffer(512));
  const worker = new Worker(url, { execArgv, workerData: { state, note } });
  worker.unref();
  const slot: Slot = { worker, state, note, dead: false };
  // Heard only when the main thread's event loop runs (between runs, never during one): later runs draw on one thread.
  worker.on("error", (e) => { slot.dead = true; off ??= `a beauty worker failed (${e instanceof Error ? e.message : String(e)})`; });
  worker.on("exit", (code) => { slot.dead = true; if (!stopping) off ??= `a beauty worker exited (code ${code})`; });
  return slot;
}

function readNote(s: Slot): string {
  const n = Math.min(s.note.length, Math.max(0, Atomics.load(s.state, 1)));
  return new TextDecoder().decode(s.note.slice(0, n));
}

/** What a render shares out: the scene and the kernel's layout, as beauty.ts prepared them. */
export interface PoolScene {
  shape: Shape3;
  mesh: Mesh;
  bounds: Bounds;
  opts: BeautyOptions;
  camera: Camera;
  prime: Float32Array;
  size: number;
  cell: number;
  tables: unknown;
  layout: BufferSpec[];
  ids: (m: Material) => number;
}

/** A test's way to make a worker fail: worker `who` (1 for the first) throws, or exits, in the first row it claims. */
export interface PoolFault {
  who: number;
  kind: "throw" | "exit";
}

/**
 * One run's use of the pool: `threads` threads (the main one and threads - 1 workers), the program they build, and
 * the run's log. Open it with openBeautyPool, post the program with warm(), pass it to every beauty render of the run
 * in BeautyOptions.pool, and close() it when the run ends.
 */
export class BeautyPool {
  private key?: string;
  private gen = 0;
  private closed = false;
  private readonly said = new Set<string>();
  /** For tests: a fault the next jobs carry to one worker. */
  fault?: PoolFault;

  constructor(readonly threads: number, private readonly log: (line: string) => void = () => {}) {
    while (slots.length < threads - 1) slots.push(spawn());
  }

  /** Whether renders can be shared out: the pool is not off and this run has not closed it. */
  get live(): boolean {
    if (off) this.say(`beauty: ${off}; drawing on one thread for the rest of this process`);
    return !off && !this.closed;
  }

  private get workers(): Slot[] {
    return slots.slice(0, this.threads - 1);
  }

  private say(line: string): void {
    if (this.said.has(line)) return;
    this.said.add(line);
    this.log(line);
  }

  /** Send the workers the program to build, so they evaluate it while the main thread meshes. */
  warm(ref: ProgramRef): void {
    if (!this.live) return;
    const samples = new Map([...(ref.importSamples ?? new Map<string, MeshSamples>())].map(([k, s]) => [k, shareSamples(s)] as const));
    this.key = programKey(ref);
    this.gen = ++generation;
    const program: ProgramRef = { ...ref, importSamples: samples };
    for (const s of this.workers) s.worker.postMessage({ type: "program", key: this.key, gen: this.gen, program });
  }

  /** For tests and benches: block until every worker has built the program (true), one failed to, or `ms` passed. */
  waitReady(ms = 60000): boolean {
    let left = Math.ceil(ms / 100);
    for (const s of this.workers) {
      for (;;) {
        const v = Atomics.load(s.state, 0);
        if (v === this.gen) break;
        if (v === -this.gen || s.dead || left-- <= 0) return false;
        Atomics.wait(s.state, 0, v, 100);
      }
    }
    return true;
  }

  /**
   * One render, its rows shared out: the kernel's result, the bytes the same as on one thread; undefined when the
   * pool failed during it (said once in the log), so the caller draws it on its own.
   */
  render(kernel: Kernel, s: PoolScene): KernelResult | undefined {
    if (!this.live) return undefined;
    const workers = this.workers;
    const T = workers.length + 1;
    const buffers = allocBuffers(s.layout, s.size, true);
    const ctl = new Int32Array(new SharedArrayBuffer(4 * (ROWS + T + workers.length)));
    const check = fieldCheck(s.shape, s.opts.reachBounds ?? s.bounds);
    // What stays on the main thread: the pool and cache themselves, the caller's glow mask (finish fills it), and the
    // camera's fitting points (the camera crosses made).
    const { pool: _pool, cache: _cache, glowMask: _glow, fitPoints: _fit, ...opts } = s.opts;
    const tables = shareTables(s.tables);
    workers.forEach((w, k) => {
      const mesh = w.mesh === s.mesh ? undefined : shareMesh(s.mesh);
      w.mesh = s.mesh;
      const fault = this.fault?.who === k + 1 ? this.fault : undefined;
      w.worker.postMessage({ type: "job", key: this.key, kernel: kernel.name, who: k + 1, threads: T, opts, bounds: s.bounds, camera: s.camera, prime: s.prime, size: s.size, cell: s.cell, buffers, tables, mesh, check, ctl, fault });
    });
    const ctx: KernelContext = { shape: s.shape, mesh: s.mesh, bounds: s.bounds, opts: s.opts, camera: s.camera, prime: s.prime, size: s.size, cell: s.cell, buffers, tables: s.tables, ids: s.ids };
    let ok = false;
    try {
      const rows = kernel.rows(ctx);
      ok = workRows(ctl, s.size, rows.primary, rows.edges, 0) && waitFor(ctl, EDONE, s.size);
    } finally {
      // Stopped on a failure, or on the main thread's own exception, so no worker waits on this job for ever.
      if (!ok) stopJob(ctl, STOPPED);
    }
    lastRows = Array.from(ctl.slice(ROWS, ROWS + T));
    for (let k = 1; k < T; k++) workerRows += lastRows[k];
    workers.forEach((w, k) => {
      const st = Atomics.load(ctl, ROWS + T + k);
      if (st === MISMATCH) this.say(`beauty: worker ${k + 1}'s field differs from the main thread's at the check points; drew without it`);
      else if (st === NO_SHAPE && Atomics.load(w.state, 0) === -this.gen) this.say(`beauty: worker ${k + 1} could not build the program (${readNote(w)}); drew without it`);
    });
    if (ok) return kernel.finish(ctx);
    const why = Atomics.load(ctl, ERROR);
    const who = workers.findIndex((_, k) => Atomics.load(ctl, ROWS + T + k) === FAILED);
    const what = why === STALLED ? "a beauty render stopped moving for a minute" : who >= 0 ? `beauty worker ${who + 1} failed${readNote(workers[who]) ? ` (${readNote(workers[who])})` : ""}` : why === EXITED ? "a beauty worker exited" : "a beauty worker failed";
    this.turnOff(what);
    return undefined;
  }

  /** The pool is off for the rest of the process: its workers are stopped, and every render after this is drawn on one thread. */
  private turnOff(why: string): void {
    off ??= why;
    this.log(`beauty: ${why}; drew it again on one thread, and the pool is off for the rest of this process`);
    this.said.add(`beauty: ${off}; drawing on one thread for the rest of this process`);
    stopping = true;
    for (const s of slots.splice(0)) { s.dead = true; void s.worker.terminate(); }
  }

  /** The run is over: the workers let go of its mesh (they keep the program's shape, which is small, until the next one). */
  close(): void {
    if (this.closed) return;
    this.closed = true;
    for (const s of this.workers) {
      if (s.dead) continue;
      s.mesh = undefined;
      s.worker.postMessage({ type: "release" });
    }
  }
}

/** The beauty render's threads when nothing says otherwise (the CLI, the render sets): the machine's cores, at most 4. */
export function defaultThreads(): number {
  return Math.max(1, Math.min(4, availableParallelism()));
}

/** The pool for a run of `threads` threads, or undefined for one thread, or when the pool is off for this process. */
export function openBeautyPool(threads: number, log?: (line: string) => void): BeautyPool | undefined {
  const n = Math.max(1, Math.floor(threads));
  if (n <= 1) return undefined;
  if (off) { log?.(`beauty: ${off}; drawing on one thread for the rest of this process`); return undefined; }
  return new BeautyPool(n, log);
}
