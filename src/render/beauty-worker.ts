/**
 * One beauty worker (see beauty-pool.ts). It builds the program's shape by evaluating it again, keeps it while the
 * program stays the same, and for each job checks its field against the main thread's, then claims and draws rows
 * into the shared buffers until there are none left. It answers only through shared memory: the main thread is
 * blocked in Atomics.wait while it works, and hears no messages.
 */
import { parentPort, workerData } from "node:worker_threads";
import { parse } from "../lang/parser.js";
import { evaluate } from "../lang/interpreter.js";
import { imageResolver, moduleResolver, replayedImports } from "../resolvers.js";
import type { MeshSamples } from "../mesh/meshSdf.js";
import type { Bounds, Material, Shape3 } from "../sdf/types.js";
import type { Camera } from "./camera.js";
import { kernelByName, type BeautyOptions } from "./beauty.js";
import { materialIds, type Buffers, type KernelContext } from "./kernel.js";
import { DONE, EDONE, ERROR, EXITED, FAILED, FINISHED, fieldMatches, MISMATCH, NO_SHAPE, ROWS, THREW, WORKING, workRows, type PoolFault, type ProgramRef, type SharedMesh } from "./beauty-pool.js";

const { state, note } = workerData as { state: Int32Array; note: Uint8Array };

/** The program this worker last built: its key and its shape, or why it could not. */
let program: { key: string; shape?: Shape3 } | undefined;
let mesh: { mesh: SharedMesh; ids: (m: Material) => number } | undefined;
/** The job being drawn, so an exit mid-row can say so. */
let current: Int32Array | undefined;

function write(e: unknown): void {
  const text = new TextEncoder().encode(e instanceof Error ? e.message : String(e)).slice(0, note.length);
  note.set(text);
  Atomics.store(state, 1, text.length);
}

function fail(ctl: Int32Array, why: number): void {
  Atomics.compareExchange(ctl, ERROR, 0, why);
  Atomics.notify(ctl, DONE);
  Atomics.notify(ctl, EDONE);
}

// A worker that exits in the middle of a job (process.exit in a kernel, a fatal error) says so before it goes.
process.on("exit", () => { if (current) fail(current, EXITED); });

function build(ref: ProgramRef): Shape3 {
  const ev = evaluate(parse(ref.source), {
    resolveImport: replayedImports(ref.sourceName, ref.importSamples ?? new Map<string, MeshSamples>()),
    resolveModule: moduleResolver(ref.sourceName),
    resolveImage: imageResolver(ref.sourceName),
    moduleFrom: ref.sourceName,
    skipAsserts: true,
    jointPoses: ref.jointPoses,
    poseName: ref.poseName,
    slice: ref.slice,
    show: ref.show,
  });
  if (!ev.output) throw new Error("the program shows no shape");
  return ev.output;
}

interface Job {
  type: "job";
  key: string;
  kernel: string;
  who: number;
  threads: number;
  opts: BeautyOptions;
  bounds: Bounds;
  camera: Camera;
  prime: Float32Array;
  size: number;
  cell: number;
  buffers: Buffers;
  tables: unknown;
  mesh?: SharedMesh;
  check: { at: Float64Array; d: Float64Array };
  ctl: Int32Array;
  fault?: PoolFault;
}

function job(j: Job): void {
  const ctl = j.ctl;
  const status = ROWS + j.threads + j.who - 1;
  current = ctl;
  try {
    if (j.mesh) mesh = { mesh: j.mesh, ids: materialIds(j.mesh.keys) };
    const shape = program?.key === j.key ? program.shape : undefined;
    if (!shape || !mesh) { Atomics.store(ctl, status, NO_SHAPE); return; }
    if (!fieldMatches(shape, j.check)) { Atomics.store(ctl, status, MISMATCH); return; }
    Atomics.store(ctl, status, WORKING);
    const ctx: KernelContext = { shape, mesh: mesh.mesh, bounds: j.bounds, opts: j.opts, camera: j.camera, prime: j.prime, size: j.size, cell: j.cell, buffers: j.buffers, tables: j.tables, ids: mesh.ids };
    const rows = kernelByName(j.kernel).rows(ctx);
    const fault = j.fault;
    const primary = fault ? (y: number) => {
      if (fault.kind === "exit") process.exit(3);
      throw new Error(`a fault made for the test at row ${y}`);
    } : rows.primary;
    workRows(ctl, j.size, primary, rows.edges, j.who);
    Atomics.store(ctl, status, FINISHED);
  } catch (e) {
    write(e);
    Atomics.store(ctl, status, FAILED);
    fail(ctl, THREW);
  } finally {
    current = undefined;
  }
}

parentPort!.on("message", (msg: { type: "program"; key: string; gen: number; program: ProgramRef } | Job | { type: "release" }) => {
  if (msg.type === "program") {
    if (program?.key !== msg.key || !program.shape) {
      // One program at a time: the last one's shape goes before the next is built.
      program = undefined;
      mesh = undefined;
      try {
        program = { key: msg.key, shape: build(msg.program) };
      } catch (e) {
        program = { key: msg.key };
        write(e);
        Atomics.store(state, 0, -msg.gen);
        Atomics.notify(state, 0);
        return;
      }
    }
    Atomics.store(state, 0, msg.gen);
    Atomics.notify(state, 0);
  } else if (msg.type === "job") job(msg);
  else mesh = undefined;
});
