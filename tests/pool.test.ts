import { afterAll, describe, expect, it, vi } from "vitest";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { check, run, type RunOptions } from "../src/pipeline.js";
import { surfaceNets } from "../src/mesh/surfaceNets.js";
import { renderBeauty, type BeautyOptions } from "../src/render/beauty.js";
import { fieldCheck, fieldMatches, lastPoolRows, openBeautyPool } from "../src/render/beauty-pool.js";
import { importResolver, replayedImports } from "../src/resolvers.js";
import { evaluate } from "../src/lang/interpreter.js";
import { parse } from "../src/lang/parser.js";
import type { MeshSamples } from "../src/mesh/meshSdf.js";
import { materialIds, materialKey } from "../src/render/kernel.js";
import type { Shape3 } from "../src/sdf/types.js";

const dir = mkdtempSync(join(tmpdir(), "aixle-pool-"));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

const sha = (b: Uint8Array) => createHash("sha256").update(b).digest("hex");

/** A run small enough for a test, with the beauty render, its camera shots and lights.png. */
const SMALL: RunOptions = { grid: 28, size: 64, views: [], steps: false, slices: false, turntable: false, callouts: false, obj: false, glb: false, viewer: false, beauty: true, beautySize: 96 };

/** The beauty pictures a run wrote, by file name, as bytes. */
let runs = 0;
function pictures(src: string, name: string, threads: number, extra: RunOptions = {}): Record<string, Buffer> {
  const out = join(dir, `run${runs++}`);
  const r = run(src, name, out, { ...SMALL, ...extra, threads });
  const files = r.files.filter((f) => /^(beauty.*|lights)\.png$/.test(f)).sort();
  return Object.fromEntries(files.map((f) => [f, readFileSync(join(out, f))]));
}

// A jointed model shown in a pose, with a slice named, two lights (one a point light) and a second camera.
const POSED = `shell = box(1, 0.6, 2) | move(0, 1.3, 0) | paint("red")
nose = sphere(0.3) | move(0, 1.3, 1.1) | paint("chrome")
head = joint(shell + nose, "tilt", 0, 1, -1, axis=[1, 0, 0])
base = box(1.2, 1, 2.4) | move(0, 0.5, 0) | paint("oak")
pose("up", tilt=-30)
set pose up
light("key", azimuth=-30, elevation=45)
light("lamp", position=[1.2, 2.2, 1.4], color="#ffd8a0", power=0.8)
camera("side", azimuth=80, elevation=15)
show base + head`;

// An imported mesh: a unit cube read from an OBJ beside the program.
const CUBE_OBJ = ["v -0.5 0 -0.5", "v 0.5 0 -0.5", "v 0.5 0 0.5", "v -0.5 0 0.5", "v -0.5 1 -0.5", "v 0.5 1 -0.5", "v 0.5 1 0.5", "v -0.5 1 0.5", "f 1 2 3", "f 1 3 4", "f 5 8 7", "f 5 7 6", "f 1 5 6", "f 1 6 2", "f 2 6 7", "f 2 7 3", "f 3 7 8", "f 3 8 4", "f 4 8 5", "f 4 5 1"].join("\n");
const IMPORTED = `crate = import("cube.obj", size=1.2, resolution=24) | paint("copper")
ball = sphere(0.35) | move(0, 1.5, 0) | paint("amber")
light("key", azimuth=-40, elevation=50)
light("rim", azimuth=150, elevation=25, power=0.6, color="#cfe0ff")
camera("low", azimuth=10, elevation=5)
show crate + ball`;

describe("the beauty render on the pool", () => {
  it("draws beauty.png, a camera's shot and lights.png the same on 1, 2 and 4 threads, for a posed and sliced program", () => {
    const opts = { slice: "nose" };
    // The first run on four threads starts the workers; the later ones find the program already built.
    const cold = pictures(POSED, "posed.aix", 4, opts);
    const one = pictures(POSED, "posed.aix", 1, opts);
    expect(Object.keys(one)).toEqual(["beauty.png", "beauty_side.png", "lights.png"]);
    for (const [t, got] of [[4, cold], [2, pictures(POSED, "posed.aix", 2, opts)], [4, pictures(POSED, "posed.aix", 4, opts)]] as const) {
      expect(Object.keys(got), `${t} threads`).toEqual(Object.keys(one));
      for (const f of Object.keys(one)) expect(sha(got[f]), `${f} on ${t} threads`).toBe(sha(one[f]));
    }
    // The workers ran under the test runner (through tsx) and drew rows of the last picture.
    const rows = lastPoolRows();
    expect(rows.length).toBe(4);
    expect(rows.slice(1).reduce((a, b) => a + b, 0)).toBeGreaterThan(0);
  });

  it("draws an imported mesh the same on 1, 2 and 4 threads", () => {
    const at = join(dir, "crate");
    mkdirSync(at, { recursive: true });
    writeFileSync(join(at, "cube.obj"), CUBE_OBJ);
    const name = join(at, "crate.aix");
    const cold = pictures(IMPORTED, name, 4);
    const one = pictures(IMPORTED, name, 1);
    expect(Object.keys(one)).toEqual(["beauty.png", "beauty_low.png", "lights.png"]);
    for (const got of [cold, pictures(IMPORTED, name, 2), pictures(IMPORTED, name, 4)]) for (const f of Object.keys(one)) expect(sha(got[f]), f).toBe(sha(one[f]));
    expect(lastPoolRows().slice(1).reduce((a, b) => a + b, 0)).toBeGreaterThan(0);
  });

  it("builds an import from the samples the main evaluation recorded, never from the file", () => {
    const at = join(dir, "replay");
    mkdirSync(at, { recursive: true });
    writeFileSync(join(at, "cube.obj"), CUBE_OBJ);
    const name = join(at, "crate.aix");
    const recorded = new Map<string, MeshSamples>();
    const src = 'show import("cube.obj", size=1.2, resolution=24)';
    const main = evaluate(parse(src), { resolveImport: importResolver(name, undefined, undefined, recorded), moduleFrom: name }).output!;
    expect([...recorded.keys()]).toEqual([`${join(at, "cube.obj")}@24`]);
    // The file is gone: the replay reads only the record, and its field is the main thread's to the bit.
    rmSync(join(at, "cube.obj"));
    const replayed = evaluate(parse(src), { resolveImport: replayedImports(name, recorded), moduleFrom: name, skipAsserts: true }).output!;
    expect(fieldMatches(replayed, fieldCheck(main, main.bounds))).toBe(true);
    // An import the record does not have is an error, not a fresh sampling.
    expect(() => evaluate(parse('show import("other.obj", resolution=24)'), { resolveImport: replayedImports(name, recorded), moduleFrom: name })).toThrow(/was not sampled by the main evaluation/);
  });
});

/** A program evaluated and meshed, and the reference a worker builds it from. */
function scene(source: string, name: string, resolution: number): { shape: Shape3; mesh: ReturnType<typeof surfaceNets>["mesh"]; cell: number; ref: { source: string; sourceName: string } } {
  const shape = check(source, name).output!;
  const nets = surfaceNets(shape, { resolution });
  return { shape, mesh: nets.mesh, cell: nets.cellSize, ref: { source, sourceName: name } };
}

const SPHERE = "show sphere(1) | move(0, 1, 0)";
const GLASS = 'ball = sphere(0.5) | move(-0.6, 0.5, 0) | paint("gold")\npane = box(0.8, 1.2, 0.8) | move(0.6, 0.6, 0) | paint("amber")\nember = sphere(0.15) | move(0, 0.15, 0.7) | paint(material("#ffd27a", glow=1.5))\nshow ball + pane + ember';
const GLASS_OPTS: Omit<BeautyOptions, "cellSize"> = { size: 96, environment: "sunset", dof: 1, label: "glass and metal", lights: [{ azimuth: -40, elevation: 55, size: 1, color: [1, 1, 1], power: 1 }, { azimuth: 0, elevation: 0, size: 0.5, color: [1, 0.8, 0.6], power: 0.8, position: [0.2, 1.4, 1.0], range: 1.5 }] };

describe("the classic kernel", () => {
  // sha256 of the RGBA bytes the renderer drew before it was split into a kernel (commit 2ec0531), for these fixtures.
  const HEAD_SPHERE = "dae2567a6a29ac4d68801cc1f4f2718da200e51d4966d80c46af2a14970a4ed6";
  const HEAD_GLASS = "f0e500bbb77e13a2dc3c41c80f9523571e7ed5b9b00e259c9bf4c69be39910ef";

  it("draws what the renderer drew before, byte for byte, on one thread and on four", () => {
    const s = scene(SPHERE, "sphere.aix", 32);
    const g = scene(GLASS, "glass.aix", 40);
    const sphereOpts: BeautyOptions = { size: 96, cellSize: s.cell };
    const glassOpts: BeautyOptions = { ...GLASS_OPTS, cellSize: g.cell };
    expect(sha(renderBeauty(s.shape, s.mesh, s.shape.bounds, sphereOpts).data)).toBe(HEAD_SPHERE);
    const glow = new Uint8Array(96 * 96);
    expect(sha(renderBeauty(g.shape, g.mesh, g.shape.bounds, { ...glassOpts, glowMask: glow }).data)).toBe(HEAD_GLASS);
    expect(glow.reduce((a, b) => a + b, 0)).toBe(97);
    for (const [x, opts, want] of [[s, sphereOpts, HEAD_SPHERE], [g, glassOpts, HEAD_GLASS]] as const) {
      const pool = openBeautyPool(4)!;
      pool.warm(x.ref);
      expect(pool.waitReady()).toBe(true);
      const mask = new Uint8Array(96 * 96);
      expect(sha(renderBeauty(x.shape, x.mesh, x.shape.bounds, { ...opts, glowMask: mask, pool }).data)).toBe(want);
      // The glow mask is filled on the main thread from every thread's rows.
      expect(mask.reduce((a, b) => a + b, 0)).toBe(x === g ? 97 : 0);
      expect(lastPoolRows().slice(1).reduce((a, b) => a + b, 0)).toBeGreaterThan(0);
      pool.close();
    }
  });

  it("gives two materials alike in every way one id, on the main thread and in the workers", () => {
    // material() makes a new material at each call: two of them alike, painted on two boxes that touch.
    const src = 'left = box(1, 1, 1) | move(-0.5, 0.5, 0) | paint(material("#c83c32", rough=0.4))\nright = box(1, 1, 1) | move(0.5, 0.5, 0) | paint(material("#c83c32", rough=0.4))\nlid = box(0.6, 0.2, 0.6) | move(0, 1.1, 0) | paint("blue")\nshow left + right + lid';
    const x = scene(src, "twins.aix", 32);
    const reds = x.mesh.materials.filter((m) => m.rough === 0.4);
    expect(reds.length).toBe(2);
    expect(reds[0]).not.toBe(reds[1]);
    const ids = materialIds(x.mesh.materials.map(materialKey));
    expect(ids(reds[0])).toBe(ids(reds[1]));
    expect(ids(x.mesh.materials.find((m) => m.rough !== 0.4)!)).not.toBe(ids(reds[0]));
    // A copy, as a worker's evaluation makes, has the same id.
    expect(ids({ ...reds[1], color: [...reds[1].color] })).toBe(ids(reds[0]));
    const opts: BeautyOptions = { size: 96, cellSize: x.cell };
    const one = renderBeauty(x.shape, x.mesh, x.shape.bounds, opts);
    const pool = openBeautyPool(4)!;
    pool.warm(x.ref);
    expect(pool.waitReady()).toBe(true);
    const four = renderBeauty(x.shape, x.mesh, x.shape.bounds, { ...opts, pool });
    pool.close();
    expect(sha(four.data)).toBe(sha(one.data));
    expect(lastPoolRows().slice(1).reduce((a, b) => a + b, 0)).toBeGreaterThan(0);
    // And the same through run() at 1 and 4 threads.
    const a = pictures(src, "twins.aix", 1), b = pictures(src, "twins.aix", 4);
    expect(sha(b["beauty.png"])).toBe(sha(a["beauty.png"]));
  });

  it("draws without a worker whose field differs from the main thread's, and says so once", () => {
    const a = scene(SPHERE, "sphere.aix", 32);
    const b = scene("show box(1.4) | move(0, 0.7, 0)", "box.aix", 32);
    const lines: string[] = [];
    const pool = openBeautyPool(4, (l) => lines.push(l))!;
    // The workers build the sphere; the render is of the box.
    pool.warm(a.ref);
    expect(pool.waitReady()).toBe(true);
    const opts: BeautyOptions = { size: 96, cellSize: b.cell };
    const one = renderBeauty(b.shape, b.mesh, b.shape.bounds, opts);
    expect(sha(renderBeauty(b.shape, b.mesh, b.shape.bounds, { ...opts, pool }).data)).toBe(sha(one.data));
    expect(lastPoolRows()).toEqual([96, 0, 0, 0]);
    expect(sha(renderBeauty(b.shape, b.mesh, b.shape.bounds, { ...opts, pool }).data)).toBe(sha(one.data));
    pool.close();
    // One line per worker, not one per render.
    expect(lines.length).toBe(3);
    for (const l of lines) expect(l).toMatch(/^beauty: worker \d's field differs from the main thread's at the check points; drew without it$/);
  });
});

// Last: a failure turns the pool off for the rest of the process, so each case loads the pool afresh.
describe("a worker that fails", () => {
  for (const kind of ["throw", "exit"] as const)
    it(`still gives the same bytes, says so in one line, and turns the pool off (${kind})`, async () => {
      vi.resetModules();
      const fresh = await import("../src/render/beauty-pool.js");
      const x = scene(GLASS, "glass.aix", 40);
      const opts: BeautyOptions = { ...GLASS_OPTS, cellSize: x.cell };
      const one = renderBeauty(x.shape, x.mesh, x.shape.bounds, opts);
      const lines: string[] = [];
      const pool = fresh.openBeautyPool(4, (l) => lines.push(l))!;
      pool.warm(x.ref);
      expect(pool.waitReady()).toBe(true);
      pool.fault = { who: 2, kind };
      expect(sha(renderBeauty(x.shape, x.mesh, x.shape.bounds, { ...opts, pool }).data)).toBe(sha(one.data));
      expect(lines.length).toBe(1);
      expect(lines[0]).toMatch(kind === "throw" ? /^beauty: beauty worker 2 failed \(a fault made for the test at row \d+\); drew it again on one thread, and the pool is off for the rest of this process$/ : /^beauty: a beauty worker exited; drew it again on one thread/);
      // Off for the process: later renders through this pool, and pools opened later, draw on one thread.
      expect(pool.live).toBe(false);
      expect(sha(renderBeauty(x.shape, x.mesh, x.shape.bounds, { ...opts, pool }).data)).toBe(sha(one.data));
      const later: string[] = [];
      expect(fresh.openBeautyPool(4, (l) => later.push(l))).toBeUndefined();
      expect(later).toEqual([expect.stringMatching(/drawing on one thread for the rest of this process$/)]);
      expect(lines.length).toBe(1);
      pool.close();
    });
});
