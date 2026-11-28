import { afterAll, describe, expect, it, vi } from "vitest";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { createRequire } from "node:module";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { check, run, type RunOptions } from "../src/pipeline.js";
import { surfaceNets } from "../src/mesh/surfaceNets.js";
import { renderBeauty, renderBeautyResult, type BeautyOptions } from "../src/render/beauty.js";
import { FLAG_GLOW } from "../src/render/photometry.js";
import { fieldCheck, fieldMatches, lastPoolRows, openBeautyPool, poolWorkerRows } from "../src/render/beauty-pool.js";
import { importResolver, replayedImports } from "../src/resolvers.js";
import { encodePng } from "../src/render/png.js";
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
function pictures(src: string, name: string, threads: number, extra: RunOptions = {}, log?: string[]): Record<string, Buffer> {
  const out = join(dir, `run${runs++}`);
  const r = run(src, name, out, { ...SMALL, ...extra, threads, log: log && ((l) => log.push(l)) });
  const files = r.files.filter((f) => /^(beauty.*|lights)\.png$/.test(f)).sort();
  return Object.fromEntries(files.map((f) => [f, readFileSync(join(out, f))]));
}

// A jointed model shown in a pose, with a slice named, a probe step shown beside it (--show), two lights (one a point
// light) and a second camera.
const POSED = `shell = box(1, 0.6, 2) | move(0, 1.3, 0) | paint("red")
nose = sphere(0.3) | move(0, 1.3, 1.1) | paint("chrome")
probe = sphere(0.25) | move(1.2, 0.25, 0.9) | paint("blue")
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
    const opts = { slice: "nose", show: ["probe"] };
    // The first run on four threads starts the workers; the later ones find the program already built.
    const lines: string[] = [];
    const cold = pictures(POSED, "posed.aix", 4, opts, lines);
    const before = poolWorkerRows();
    const one = pictures(POSED, "posed.aix", 1, opts);
    expect(Object.keys(one)).toEqual(["beauty.png", "beauty_side.png", "lights.png"]);
    for (const [t, got] of [[4, cold], [2, pictures(POSED, "posed.aix", 2, opts, lines)], [4, pictures(POSED, "posed.aix", 4, opts, lines)]] as const) {
      expect(Object.keys(got), `${t} threads`).toEqual(Object.keys(one));
      for (const f of Object.keys(one)) expect(sha(got[f]), `${f} on ${t} threads`).toBe(sha(one[f]));
    }
    // The workers, built under the test runner through tsx, drew rows of those pictures: none built another shape
    // (the pose, the shown probe), which would have it claim no rows and the main thread say so.
    expect(lines.filter((l) => /^beauty: /.test(l))).toEqual([]);
    expect(lastPoolRows().length).toBe(4);
    expect(poolWorkerRows()).toBeGreaterThan(before);
  });

  it("draws an imported mesh the same on 1, 2 and 4 threads", () => {
    const at = join(dir, "crate");
    mkdirSync(at, { recursive: true });
    writeFileSync(join(at, "cube.obj"), CUBE_OBJ);
    const name = join(at, "crate.aix");
    const lines: string[] = [];
    const cold = pictures(IMPORTED, name, 4, {}, lines);
    const before = poolWorkerRows();
    const one = pictures(IMPORTED, name, 1);
    expect(Object.keys(one)).toEqual(["beauty.png", "beauty_low.png", "lights.png"]);
    for (const got of [cold, pictures(IMPORTED, name, 2, {}, lines), pictures(IMPORTED, name, 4, {}, lines)]) for (const f of Object.keys(one)) expect(sha(got[f]), f).toBe(sha(one[f]));
    // Built from the recorded samples, the workers' field is the main thread's, and they drew.
    expect(lines.filter((l) => /^beauty: /.test(l))).toEqual([]);
    expect(poolWorkerRows()).toBeGreaterThan(before);
  });

  it("draws what the files say now: a picture and a library changed between two runs of the same program", () => {
    // The same source run twice in one process (a --watch save, a test, a tool): the workers kept the shape they built
    // from the first run's files, which matched the main thread's field, so they drew their rows with the old ones.
    const at = join(dir, "edited");
    mkdirSync(join(at, "parts"), { recursive: true });
    const name = join(at, "tin.aix");
    const src = 'use "parts/knob"\nlabel = material("cream", image="label.png", projection="cylindrical", scale=0.6)\nbody = cylinder(0.5, 1) | move(0, 0.5, 0) | paint(label)\nshow body + (knob.knob() | move(0, 1.05, 0))';
    const paint = (rgb: [number, number, number]) => writeFileSync(join(at, "label.png"), encodePng(2, 2, new Uint8Array([0, 1, 2, 3].flatMap(() => [...rgb, 255]))));
    const knob = (shape: string) => writeFileSync(join(at, "parts", "knob.aix"), `# a knob on the lid\ndef knob() = ${shape} | paint("gold")\n`);
    paint([200, 40, 30]);
    knob("sphere(0.1)");
    pictures(src, name, 4);
    paint([30, 60, 210]);
    knob("box(0.08, 0.1, 0.08)");
    const before = poolWorkerRows(), lines: string[] = [];
    const now = pictures(src, name, 4, { beautySize: 160 }, lines), fresh = pictures(src, name, 1, { beautySize: 160 });
    expect(sha(now["beauty.png"])).toBe(sha(fresh["beauty.png"]));
    // On the pool, not around it: the workers built the program again and drew rows of it.
    expect(lines.filter((l) => /^beauty: /.test(l))).toEqual([]);
    expect(poolWorkerRows()).toBeGreaterThan(before);
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

describe("the kernel on the pool", () => {
  it("draws the same bytes on one thread and on four, and returns the flags of every thread's rows", () => {
    const s = scene(SPHERE, "sphere.aix", 32);
    const g = scene(GLASS, "glass.aix", 40);
    const sphereOpts: BeautyOptions = { size: 96, cellSize: s.cell };
    const glassOpts: BeautyOptions = { ...GLASS_OPTS, cellSize: g.cell };
    for (const [x, opts] of [[s, sphereOpts], [g, glassOpts]] as const) {
      const one = renderBeautyResult(x.shape, x.mesh, x.shape.bounds, opts);
      const want = sha(one.canvas.data);
      const glowing = one.flags!.reduce((a, f) => a + (f & FLAG_GLOW ? 1 : 0), 0);
      expect(glowing > 0).toBe(x === g);
      const pool = openBeautyPool(4)!;
      pool.warm(x.ref);
      expect(pool.waitReady()).toBe(true);
      const four = renderBeautyResult(x.shape, x.mesh, x.shape.bounds, { ...opts, pool });
      expect(sha(four.canvas.data)).toBe(want);
      // The flags every thread's rows wrote, returned on the main thread (lights.png's bloom reads them).
      expect(sha(four.flags!)).toBe(sha(one.flags!));
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
    // And the same through run() at 1 and 4 threads.
    const a = pictures(src, "twins.aix", 1), b = pictures(src, "twins.aix", 4);
    expect(sha(b["beauty.png"])).toBe(sha(a["beauty.png"]));
  });

  it("tells apart two decals of one picture fitted to different regions", () => {
    // A decal's picture is fitted to its region's box: the same file on two regions is two different paints.
    const at = join(dir, "decals");
    mkdirSync(at, { recursive: true });
    writeFileSync(join(at, "dots.png"), encodePng(2, 2, new Uint8Array([255, 255, 255, 255, 20, 20, 20, 255, 20, 20, 20, 255, 255, 255, 255, 255])));
    const src = 'left = decal(box(1, 1, 1) | move(-0.5, 0.5, 0), box(1, 0.6, 2) | move(-0.5, 0.5, 0), image="dots.png")\nright = decal(box(1, 1, 1) | move(0.5, 0.5, 0), box(1, 0.3, 2) | move(0.5, 0.7, 0), image="dots.png")\nshow left + right';
    const x = scene(src, join(at, "decals.aix"), 24);
    const decals = x.mesh.materials.filter((m) => m.image);
    expect(decals.length).toBe(2);
    const ids = materialIds(x.mesh.materials.map(materialKey));
    expect(ids(decals[0])).not.toBe(ids(decals[1]));
  });

  it("starts its workers under the test runner, through tsx, and they draw rows beside the main thread", () => {
    const g = scene(GLASS, "glass.aix", 40);
    const opts: BeautyOptions = { ...GLASS_OPTS, size: 256, cellSize: g.cell };
    const one = renderBeauty(g.shape, g.mesh, g.shape.bounds, opts);
    const pool = openBeautyPool(4)!;
    pool.warm(g.ref);
    expect(pool.waitReady()).toBe(true);
    expect(sha(renderBeauty(g.shape, g.mesh, g.shape.bounds, { ...opts, pool }).data)).toBe(sha(one.data));
    pool.close();
    const rows = lastPoolRows();
    expect(rows.reduce((a, b) => a + b, 0)).toBe(256);
    for (const r of rows.slice(1)) expect(r).toBeGreaterThan(0);
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

describe("the pool under the command line's own node flags", () => {
  // A flag for V8 or for the whole process (a larger heap for a big model) is one Node will not give a worker thread:
  // passed on as it is, it made every worker's start throw, and the render failed with nothing written.
  const ROOT = fileURLToPath(new URL("..", import.meta.url));
  const program = join(dir, "flags.aix");
  writeFileSync(program, 'show sphere(0.6) | move(0, 0.6, 0) | paint("copper")');
  // bin/aixle.mjs without a build: tsx registered by a call, so the workers need it added to their flags.
  const registered = join(dir, "registered.mjs");
  const tsxApi = pathToFileURL(createRequire(import.meta.url).resolve("tsx/esm/api")).href;
  writeFileSync(registered, `const { register } = await import(${JSON.stringify(tsxApi)});\nregister();\nawait import(${JSON.stringify(pathToFileURL(join(ROOT, "src/cli.ts")).href)});\n`);
  const render = (entry: string[], threads: number): { log: string; png: Buffer } => {
    const out = join(dir, `flags${runs++}`);
    const log = execFileSync(process.execPath, ["--max-old-space-size=2048", ...entry, "render", program, "--beauty-only", "--beauty-size", "96", "--no-caption", "--threads", String(threads), "--out", out], { cwd: ROOT, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
    return { log, png: readFileSync(join(out, "beauty.png")) };
  };
  for (const [how, entry] of [["tsx's flag", ["--import", "tsx", "src/cli.ts"]], ["tsx's register()", [registered]]] as const)
    it(`draws on the pool with a V8 flag on the command line, through ${how}`, () => {
      const four = render([...entry], 4), one = render([...entry], 1);
      expect(four.log).toMatch(/beauty render 96px, full, 4 threads, in [\d.]+ s/);
      expect(four.log).not.toMatch(/^beauty: /m);
      expect(sha(four.png)).toBe(sha(one.png));
    });
});

// Last: a failure turns the pool off for the rest of the process, so each case loads the pool afresh.
describe("a worker that fails", () => {
  for (const kind of ["throw", "exit"] as const)
    it(`still gives the same bytes, says so in one line, and turns the pool off (${kind})`, async () => {
      vi.resetModules();
      const fresh = await import("../src/render/beauty-pool.js");
      const x = scene(GLASS, "glass.aix", 40);
      // Large enough that every worker claims a row before the main thread has drawn them all.
      const opts: BeautyOptions = { ...GLASS_OPTS, size: 192, cellSize: x.cell };
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
