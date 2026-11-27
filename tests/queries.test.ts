import { describe, expect, it } from "vitest";
import { parse } from "../src/lang/parser.js";
import { evaluate } from "../src/lang/interpreter.js";
import * as C_ from "../src/sdf/measure.js";
import type { Vec3 } from "../src/core/vec.js";

const run = (src: string) => evaluate(parse(src));
const timed = <T>(f: () => T): { value: T; ms: number } => {
  const t0 = performance.now();
  const value = f();
  return { value, ms: performance.now() - t0 };
};

describe("overlap on a near contact (round 11)", () => {
  it("keeps its lattice within the sample budget whatever the shared box", () => {
    const count = (s: Vec3, c: number) => Math.ceil(s[0] / c) * Math.ceil(s[1] / c) * Math.ceil(s[2] / c);
    // The shared boxes of the two hangs: a face on a face within floating point, a turned corner on a face; then a
    // corner sunk a thousandth, a box thin on two sides, and an ordinary one.
    const boxes: Vec3[] = [[0.35, 1.1102230246251565e-16, 1.7], [5.551115123125783e-17, 2.45, 1.9], [0.001, 2.45, 1.9], [1e-12, 1e-12, 3], [0.02, 1.3, 1.3], [1, 1, 1]];
    for (const s of boxes) expect(count(s, C_.latticeCell(s, 24))).toBeLessThanOrEqual(200000);
  });
  it("returns 0 at once for a book ground()ed onto a board and for a turned corner on a face", () => {
    // dogfood/round-11/shelf_probe_hang.aix: the board's top is 0.8000000000000002.
    const hang = timed(() => run('board = box(7.68, 0.2, 2.94) | move(0, 0.8 - 0.2 / 2, 0.03)\nbk = box(0.35, 2.55, 1.7) | move(0, 2.55 / 2, 0) | ground() | move(-2, 0.8, 0.3)\nshow board + bk\nassert overlap(bk, board) < 0.0001, "resting"\nassert overlap(bk, board) > 0'));
    expect(hang.ms).toBeLessThan(5000);
    expect(hang.value.asserts.map((a) => a.detail)).toEqual(["0 < 0.0001", "0 > 0"]);
    expect(hang.value.asserts[1].where).toMatch(/^they only touch, at \(/);
    // dogfood/round-11/shelf_probe_hang2.aix: a box leaning 18 degrees with its top corner on an upright's face; and
    // both rounded, which leaves 0.005 between them.
    const lean = (r: string) => `prev = box(0.30, 2.45, 1.9${r}) | move(0.15, 1.225, 0)\nlean = box(0.34, 2.5, 1.9${r}) | move(0.17, 1.25, 0) | rotate(z=18) | move(0.30 + 2.5 * sin(18), 0, 0)\nshow prev + lean\nassert overlap(lean, prev) < 0.0001, "no overlap"`;
    for (const r of ["", ", round=0.02"]) {
      const t = timed(() => run(lean(r)));
      expect(t.ms).toBeLessThan(5000);
      expect(t.value.asserts[0].detail).toBe("0 < 0.0001");
    }
    // A corner sunk a thousandth into the face is an overlap, measured within the budget.
    const sunk = timed(() => C_.overlapVolume(run(lean("").replace("0.30 + 2.5", "0.299 + 2.5")).steps.find((s) => s.name === "lean")!.value as never, run(lean("")).steps.find((s) => s.name === "prev")!.value as never));
    expect(sunk.ms).toBeLessThan(5000);
    expect(sunk.value).toBeGreaterThanOrEqual(0);
  });
});

describe("clearance (round 11)", () => {
  const P_ = () => import("../src/sdf/primitives.js");
  const O_ = () => import("../src/sdf/ops.js");
  it("is minus the depth they must be moved apart to touch, the same from either side", async () => {
    const P = await P_(), O = await O_();
    // dogfood/round-11/shelf_probe_fail.aix: a board 0.2 thick, a book under it whose top is 0.15 into it (the board's
    // own field at the book's top says 0.05, the nearer way out of the board being up), and a book sunk 0.03 into
    // the shelf it stands on.
    // The reading used to depend on where the board's seeds fell against the book: -0.15, -0.13 or -0.05 along the
    // shelf, and -0.05845 for the rounded book at x = -1.5.
    const board = O.move(P.box(7.68, 0.2, 2.94), 0, 9.85, 0.03);
    for (const x of [-1.89, -1.5, -1.2, -0.7, 0.33])
      for (const round of [0, 0.02]) {
        const tall = O.move(P.box(0.42, 3.0, 2.0, round), x, 6.9 + 1.5, 0.35);
        expect(C_.clearance(tall, board)).toBeCloseTo(-0.15, 4);
        expect(C_.clearance(board, tall)).toBeCloseTo(-0.15, 4);
      }
    const shelf = O.move(P.box(7.68, 0.2, 2.94), 0, 0.7, 0.03);
    const sunk = O.move(P.box(0.25, 2.3, 1.8), -1.7, 0.8 - 0.03 + 1.15, -0.3);
    expect(C_.clearance(sunk, shelf)).toBeCloseTo(-0.03, 4);
    expect(C_.clearance(shelf, sunk)).toBeCloseTo(-0.03, 4);
  });
  it("converges on a rounded edge resting on a plane and on a turned corner against a face", async () => {
    const P = await P_(), O = await O_();
    // dogfood/round-11/shelf_probe_ground.aix: a box 0.34 x 2.5 x 1.9 rounded 0.02, turned 18 degrees about its
    // bottom edge, set down by the rounded edge's lift so its lowest line is on the floor.
    const floor = O.move(P.box(4, 0.2, 3), 0, -0.1, 0);
    const s = Math.sin(Math.PI / 10), c = Math.cos(Math.PI / 10), lift = 0.02 * (s + c - 1);
    const book = (x: number) => O.move(O.rotate(O.move(P.box(0.34, 2.5, 1.9, 0.02), 0.17, 1.25, 0), 0, 0, 18), x, -lift, 0);
    for (const x of [-1, 0.5]) expect(Math.abs(C_.clearance(book(x), floor))).toBeLessThan(1e-4);
    // At x = 2 the rounded edge's lowest line (0.0128 right of the turned corner) is past the floor's edge, so
    // the gap is from that edge to the arc, 0.00377: true, not an error.
    expect(C_.clearance(book(2), floor)).toBeCloseTo(Math.hypot(0.02 * (c - s), 0.02) - 0.02, 4);
    // dogfood/round-11/shelf_probe_hang2.aix: a box leaning 18 degrees with its top corner on an upright's face.
    const prev = O.move(P.box(0.3, 2.45, 1.9), 0.15, 1.225, 0);
    const lean = O.move(O.rotate(O.move(P.box(0.34, 2.5, 1.9), 0.17, 1.25, 0), 0, 0, 18), 0.3 + 2.5 * s, 0, 0);
    expect(Math.abs(C_.clearance(lean, prev))).toBeLessThan(1e-4);
    expect(C_.clearance(O.move(lean, 0.01, 0, 0), prev)).toBeCloseTo(0.01, 4);
  });
});

describe("void and inside on a skin thinner than the lattice (round 11)", () => {
  it("catch a tube a little wider than the slot it runs along, as clearance does", async () => {
    const P = await import("../src/sdf/primitives.js"), O = await import("../src/sdf/ops.js");
    const C = await import("../src/sdf/curves.js");
    // dogfood/round-11/stand.aix with slot_w = 3: a 3.6 cable along a 3 slot, 0.3 into both walls for 60 along it,
    // first straight, then along a path that turns up out of the slot like the stand's.
    const slab = O.difference(O.move(P.box(20, 10, 60), 0, 5, 0), O.move(P.box(3, 10, 70), 0, 7, 0));
    const straight = (r: number) => O.move(O.rotate(P.cylinder(r, 70), 90, 0, 0), 0, 5, 0);
    const bent = (r: number) => C.tubeCurve(C.curveThrough([[0, 5, -40], [0, 5, 20], [0, 12, 30], [0, 25, 32]]), r);
    for (const cable of [straight, bent]) {
      expect(C_.clearance(cable(1.8), slab)).toBeCloseTo(-0.3, 3);
      expect(C_.isVoid(cable(1.8), slab)).toBe(false);
      expect(C_.insideFraction(cable(1.8), slab)).toBeGreaterThan(0);
      // A cable that fits keeps both promises.
      expect(C_.isVoid(cable(1.4), slab)).toBe(true);
      expect(C_.insideFraction(cable(1.4), slab)).toBe(0);
    }
    // In the language, both failures say where the cable is in the slab, and in which step.
    const ev = run('slab = box(20, 10, 60) | move(0, 5, 0)\nslot = box(3, 10, 70) | move(0, 7, 0)\nplate = slab - slot\ncable = cylinder(1.8, 70) | rotate(x=90) | move(0, 5, 0)\nassert void(cable, plate)\nassert inside(cable, plate) == 0\nshow plate');
    expect(ev.asserts.map((a) => a.passed)).toEqual([false, false]);
    expect(ev.asserts[0].where).toMatch(/^solid at \(-?1\.[5-8]\d*, [\d.]+, -?[\d.]+\) in 'slab'$/);
    expect(ev.asserts[1].where).toMatch(/^cable is inside plate at \(-?1\.[5-8]\d*, [\d.]+, -?[\d.]+\) in 'slab'/);
  });
});

describe("the decal region test (round 11)", () => {
  it("finds a union of thin bands on the surface, and still warns of one beside it", () => {
    // dogfood/round-11/shelf_probe_band.aix: two gold bands 0.06 tall across a book's spine, 1.6 apart.
    const book = 'set grid 44\nb = {w: 0.35, h: 2.2, d: 1.7}\nbase = box(b.w, b.h, b.d, round=0.02) | paint("navy")\n';
    const warned = (src: string) => run(book + src + "\nshow m").warnings.filter((w) => /paints nothing/.test(w));
    expect(warned('m = decal(base, box(b.w + 0.1, 0.06, 0.2) | move(0, 0.8, b.d / 2), "gold")')).toEqual([]);
    expect(warned('m = decal(base, (box(b.w + 0.1, 0.06, 0.2) | move(0, 0.8, b.d / 2)) + (box(b.w + 0.1, 0.06, 0.2) | move(0, -0.8, b.d / 2)), "gold")')).toEqual([]);
    expect(warned('def bands(r) = (box(r.w + 0.1, 0.06, 0.2) | move(0, r.h * 0.36, r.d / 2)) + (box(r.w + 0.1, 0.06, 0.2) | move(0, -r.h * 0.36, r.d / 2))\nm = decal(base, bands(b), "gold")')).toEqual([]);
    // The union moved as a whole, which hides its parts from a walk of the union's members.
    expect(warned('m = decal(base, ((box(b.w + 0.1, 0.06, 0.2) | move(0, 0.8, 0)) + (box(b.w + 0.1, 0.06, 0.2) | move(0, -0.8, 0))) | move(0, 0, b.d / 2), "gold")')).toEqual([]);
    // The same bands 0.2 in front of the spine paint nothing, and are said to.
    expect(warned('m = decal(base, (box(b.w + 0.1, 0.06, 0.2) | move(0, 0.8, b.d / 2 + 0.2)) + (box(b.w + 0.1, 0.06, 0.2) | move(0, -0.8, b.d / 2 + 0.2)), "gold")')).toHaveLength(1);
  });
  it("finds thin bands round a curved surface, where a slide along the surface's normal leaves the band", () => {
    // Two bands 0.02 thick across a ball, at mid height and near the poles, where the ball's surface crosses them at
    // 60 and at 18 degrees: a point slid from a band's face onto the ball moves along the ball's normal, off the band.
    const warned = (src: string) => run(`set grid 64\nball = sphere(1) | paint("navy")\n${src}\nshow m`).warnings.filter((w) => /paints nothing/.test(w));
    const bands = (y: number) => `m = decal(ball, (box(2.2, 0.02, 2.2) | move(0, ${y}, 0)) + (box(2.2, 0.02, 2.2) | move(0, -${y}, 0)), "gold")`;
    expect(warned(bands(0.5))).toEqual([]);
    expect(warned(bands(0.95))).toEqual([]);
    // Bands just past the poles, and bands wholly inside the ball, paint nothing and are said to.
    expect(warned(bands(1.02))).toHaveLength(1);
    expect(warned('m = decal(ball, (box(1, 0.02, 1) | move(0, 0.5, 0)) + (box(1, 0.02, 1) | move(0, -0.5, 0)), "gold")')).toHaveLength(1);
  });
});

describe("failing pieces() and wall() name the step (round 11)", () => {
  it("give a loose piece its volume's unit and its step", () => {
    // dogfood/round-11/stand.aix with the slot through the whole width: the support plate floats free.
    const src = (units: string) => `${units}base = box(70, 6, 95) | move(0, 3, 0)\nsupport = box(70, 6, 85) | move(0, 76, -12)\nstand = base + support\nassert pieces(stand, 64) == 1\nshow stand`;
    expect(run(src("set units mm\n")).asserts[0].where).toMatch(/^the smallest piece is 3[45]\d00 mm³ at \(.*\) in 'support'$/);
    expect(run(src("")).asserts[0].where).toMatch(/^the smallest piece is 3[45]\d00 cubic units at \(.*\) in 'support'$/);
  });
  it("name the innermost steps on both sides of the thinnest wall, where the part was moved to", () => {
    // dogfood/round-11/mixer_probe_fail_thin.aix: the bowl's wall is built at the origin and moved into the bowl.
    const ev = run('bowl_wall = cylinder(1, 1.2) - (cylinder(0.97, 1.2) | move(0, 0.1, 0))\nhandle = box(0.3, 0.1, 0.1) | move(1.1, 0.3, 0)\nbowl = (bowl_wall + handle) | move(0, 1, 0.45)\nassert wall(bowl, 96) > 0.04\nshow bowl');
    expect(ev.asserts[0].passed).toBe(false);
    expect(ev.asserts[0].where).toMatch(/^thinnest at \(.*\) in 'bowl_wall', through to \(.*\) in 'bowl_wall'$/);
    // A wall between two cuts names the cutters: an engraving's floor against a slot's face.
    const cut = run('body = box(10, 10, 10)\nslot = box(4, 20, 3) | move(0, 0, 1.5)\nword = box(4, 4, 2) | move(0, 0, 5)\nstand = body - slot - word\nassert wall(stand, 128) > 1.5\nshow stand');
    expect(cut.asserts[0].detail).toBe("1 > 1.5");
    expect(cut.asserts[0].where).toMatch(/^thinnest at \(.*\) in '(word|slot)', through to \(.*\) in '(word|slot)'$/);
    expect(cut.asserts[0].where).toMatch(/'word'.*'slot'|'slot'.*'word'/);
  });
});

describe("the meshed queries' default cell (round 11)", () => {
  it("is the model's own cell, at least 64 across the part, so a part costs what the model's mesh does", () => {
    // Two boxes 0.008 apart in a model 4 long at grid 200: the model's 0.02 cell fuses them, as the report's mesh does;
    // the grid laid across the part's own 1.0 (a 0.005 cell) parted them, and meshed the part four times finer.
    const ev = run('set grid 200\nfloor = box(4, 0.1, 1) | move(0, -0.05, 0)\npart = (box(0.496, 0.3, 0.3) | move(-0.252, 0.5, 0)) + (box(0.496, 0.3, 0.3) | move(0.252, 0.5, 0))\nshow floor + part\nassert pieces(part) == pieces(part, 64)\nassert pieces(part) == 1\nassert pieces(part, 200) == 2\nassert overhang(floor + part) == overhang(floor + part, 200)\nassert wall(part) == wall(part, 64)');
    expect(ev.asserts.map((a) => [a.passed, a.detail])).toEqual([[true, "1 == 1"], [true, "1 == 1"], [true, "2 == 2"], [true, expect.any(String)], [true, expect.any(String)]]);
    // The mixer's bowl, 2.68 of a model 3.66 long at grid 200: 147 cells, not 200.
    const bowl = run('set grid 200\nbase = box(3.66, 0.4, 2) | move(0, 0.2, 0)\nbowl = cylinder(1.34, 1.5) - (cylinder(1.3, 1.5) | move(0, 0.05, 0))\nshow base + (bowl | move(0, 1.2, 0))\nassert wall(bowl) == wall(bowl, 147)');
    expect(bowl.asserts[0].passed).toBe(true);
  });
});

describe("support() (round 11)", () => {
  it("is the volume under the overhangs, the report's Supports row, and says where the tallest column stands", async () => {
    // A table top 1 x 0.1 x 1 on a post 0.2 square: 0.96 in plan overhangs the plate by about 1.
    const ev = run('set units mm\nset grid 128\npost = box(0.2, 1, 0.2) | move(0, 0.5, 0)\ntop = box(1, 0.1, 1) | move(0, 1.05, 0)\nt = post + top\nshow t\nassert support(t) > 0.85\nassert support(t) < 1.0\nassert support(t) < 0.5\nassert support(post) == 0');
    expect(ev.asserts.map((a) => a.passed)).toEqual([true, true, false, true]);
    expect(ev.asserts[2].where).toMatch(/^the tallest column is 1(\.\d+)? mm under \([-\d., ]+\) in 'top', standing on the plate at y = 0, of 0\.9\d* mm³ under 0\.9\d* mm² in plan$/);
    // On the model below: a shelf over a slab.
    const on = run('slab = box(1, 0.2, 1) | move(0, 0.1, 0)\npost = box(0.2, 1, 0.2) | move(-0.4, 0.5, 0)\nshelf = box(1, 0.1, 1) | move(0, 1.05, 0)\nm = slab + post + shelf\nshow m\nassert support(m) < 0.1');
    expect(on.asserts[0].where).toMatch(/standing on the model at \([-\d., ]+\) in 'slab', of .* cubic units under .* square units in plan$/);
  });
  it("leaves out faces the mesher bends past 45 degrees where the shape faces down less", async () => {
    const { supportVolume } = await import("../src/mesh/print.js");
    // A ceiling falling back at 50 degrees from the horizontal (its normal 50 degrees from straight down, ny -0.64),
    // above the plate, and one mesh face over it tilted to ny -0.73, as dual contouring left the faces beside the
    // stand's coincident corner (dogfood/round-11/stand.aix, before its slot's corner moved).
    const n = [0, -Math.cos((50 * Math.PI) / 180), Math.sin((50 * Math.PI) / 180)];
    const plane = (ny: number[]) => ({ kind: "shape3", dist: (x: number, y: number, z: number) => ny[0] * x + ny[1] * (y - 30) + ny[2] * z, hit: () => ({ d: 0 }), bounds: { min: [-10, 0, -10], max: [10, 40, 10] }, cost: 1 }) as never;
    // The face through (0, 30, 0) along x, its normal (0, -0.73, 0.683).
    const w = Math.sqrt(1 - 0.73 * 0.73);
    const mesh = { positions: new Float32Array([0, 30, 0, 1, 30, 0, 0, 30 + w, 0.73]), normals: new Float32Array(9), indices: new Uint32Array([0, 1, 2]) } as never;
    const r = supportVolume(plane(n), mesh, 0.5, 0);
    expect(r.volume).toBe(0);
    expect(r.skipped).toBeCloseTo(0.73 / 2, 3);
    // Under a field that does face down that far (the face's own plane), the same face is support, about 30 tall.
    const real = supportVolume(plane([0, -0.73, w]), mesh, 0.5, 0);
    expect(real.skipped).toBe(0);
    expect(real.volume).toBeCloseTo((0.73 / 2) * (30 + w / 3), 1);
  });
});

describe("the report's Supports row (round 11)", () => {
  it("says what it leaves out without calling a curve's facets a sharp edge", async () => {
    const { mkdtempSync, rmSync } = await import("node:fs");
    const { tmpdir } = await import("node:os");
    const { join } = await import("node:path");
    const { run: render } = await import("../src/pipeline.js");
    // A ball has no sharp edge, but its mesh facets along the 45 degree line tilt either side of it, and those past
    // it where the field is not are left out: the row said they were "bent past 45° at a sharp edge".
    const dir = mkdtempSync(join(tmpdir(), "aixle-"));
    try {
      const r = render("set units mm\nset grid 48\nball = sphere(20) | move(0, 20, 0)\nshow ball", "ball.aix", dir, { views: [], steps: false, slices: false, turntable: false, callouts: false, glb: false, viewer: false, beauty: false });
      const row = r.report.split("\n").find((l) => l.startsWith("| Supports |")) ?? "";
      expect(row).toMatch(/about [\d.]+ (mm|cm)³ under the overhangs that need it \(.*\), over [\d.]+ mm² in plan;/);
      expect(row).toMatch(/mm² of mesh faces tilted past 45° where the shape itself faces down less \(bent beside a sharp edge, or faceted along a curve's 45° line\) are left out \|$/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
  it("splits the bridged volume off and lists the islands, in report.json too (roadmap 20)", async () => {
    const { mkdtempSync, readFileSync, rmSync } = await import("node:fs");
    const { tmpdir } = await import("node:os");
    const { join } = await import("node:path");
    const { run: render } = await import("../src/pipeline.js");
    const dir = mkdtempSync(join(tmpdir(), "aixle-"));
    try {
      // A slab on posts 8 apart, and a cone hanging tip down off the right post.
      const src = "set units mm\nset grid 96\na = box(10, 20, 10) | move(-9, 10, 0)\nb = box(10, 20, 10) | move(9, 10, 0)\nslab = box(28, 3, 10) | move(0, 21.5, 0)\ntip = cone(4, 0, 6.93) | rotate(x=180) | move(9, 16.5, 7.5)\nshow a + b + slab + tip";
      const r = render(src, "bridge.aix", dir, { views: [], steps: false, slices: false, turntable: false, callouts: false, glb: false, viewer: false, beauty: false });
      const row = r.report.split("\n").find((l) => l.startsWith("| Supports |")) ?? "";
      expect(row).toMatch(/^\| Supports \| none needed under the overhangs; 1\.\d+ cm³ under bridges over \d+(\.\d+)? mm², level ceilings spanning at most 16 mm to solid that stands on both sides \(the longest [\d.]+ mm, at \(.*\)\): they print without support with supports off/);
      expect(row).toMatch(/; 1 island, a point lower than all the surface around it, which prints in the air whatever its faces' angles and needs a column: at \([-\d., ]+\) in 'tip', a column 1\d(\.\d+)? mm down to the plate(; [\d.]+ mm² of mesh faces tilted past 45° .* are left out)? \|$/);
      expect(r.report).toMatch(/\| Summary \| [^|]*1 island needing a column/);
      const json = JSON.parse(readFileSync(join(dir, "report.json"), "utf8"));
      expect(json.print.support.mm3).toBe(0);
      expect(json.print.support.bridged.spanMm).toBe(16);
      expect(json.print.support.bridged.mm3).toBeGreaterThan(1500);
      expect(json.print.support.islandCount).toBe(1);
      expect(json.print.support.islands[0].steps).toEqual(["tip"]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("islands() and the bridges support() leaves out (roadmap 20)", () => {
  // Posts 8 apart under a slab that runs on 10 past the right post: the span between them is a bridge, the end a
  // cantilever, 10 x 10 in plan and 20 tall.
  const slab = "set units mm\na = box(10, 20, 10) | move(-9, 10, 0)\nb = box(10, 20, 10) | move(9, 10, 0)\nslab = box(38, 3, 10) | move(5, 21.5, 0)\nm = a + b + slab\nshow m\n";
  it("support() reads only what needs support, says what it left out, and span=0 counts the bridge too", () => {
    const ev = run(`${slab}assert support(m) > 1800\nassert support(m) < 2200\nassert support(m, span=0) > 3400\nassert support(m, span=5) > 3400\nassert support(m) < 100`);
    expect(ev.asserts.map((a) => a.passed)).toEqual([true, true, true, true, false]);
    expect(ev.asserts[4].where).toMatch(/^the tallest column is 2\d(\.\d+)? mm under \([-\d., ]+\) in 'slab', standing on the plate at y = 0, of \d+ mm³ under \d+(\.\d+)? mm² in plan \(1[56]\d\d mm³ more under bridges up to 16 mm, left out\)$/);
  });
  it("islands() counts a cone hanging tip down off a wall, and a failure says where", () => {
    const src = "set units mm\nwall = box(20, 40, 6) | move(0, 20, -3)\ntip = cone(5, 0, 8.66) | rotate(x=180) | move(0, 31.67, 4)\nm = wall + tip\nshow m\nassert support(m) < 1\nassert islands(m) == 0\nassert islands(wall) == 0";
    const ev = run(src);
    expect(ev.asserts.map((a) => a.passed)).toEqual([true, false, true]);
    expect(ev.asserts[1].detail).toBe("1 == 0");
    expect(ev.asserts[1].where).toMatch(/^the island is at \(-?[\d.]+, 27\.\d+, [\d.]+\) in 'tip', a column 2\d(\.\d+)? mm down to the plate$/);
  });
});

describe("stands() (round 11)", () => {
  it("is the margin of the centre of mass inside the footprint, and says which way it tips", () => {
    const ev = run('top = box(1.2, 0.05, 0.8) | move(0, 0.75, 0)\nleg = box(0.05, 0.725, 0.05) | move(0.55, 0.3625, 0.35)\ntable = top + (leg | mirror("x") | mirror("z"))\ntall = box(0.3, 2, 0.3) | move(0, 1, 0) | rotate(z=12) | move(3, 0, 0)\nshow table + tall\nassert stands(table) > 0.3\nassert stands(table) < 0.4\nassert stands(tall) > 0\nassert stands(table) > 1');
    expect(ev.asserts.map((a) => a.passed)).toEqual([true, true, false, false]);
    // Leaning 12 degrees towards -x, its centre of mass is past the edge it rests on.
    expect(ev.asserts[2].detail).toMatch(/^-0\.0\d+ > 0$/);
    expect(ev.asserts[2].where).toMatch(/^the centre of mass \(2\.79, 0\.98, 0\) is 0\.0\d+ outside the footprint, so it tips towards -x$/);
    expect(ev.asserts[3].where).toMatch(/^the centre of mass \(0, 0\.7\d?, 0\) is 0\.37\d* inside the footprint, nearest its edge towards [+-]z$/);
  });
  it("reads a margin about a cell wide for a cube balanced on its edge, and -Infinity only with no surface", async () => {
    // The footprint is what lies within a cell and a half of the lowest point, so an edge or a point has one: a strip
    // of cells. The reference said such a shape "has no footprint and reads -Infinity"; it reads a small margin that
    // shrinks with the cell, and a promise of > 0 holds of a cube on its edge.
    const { standing } = await import("../src/mesh/pieces.js");
    const edge = run("edge = box(1, 1, 1) | rotate(z=45) | ground()\nshow edge").steps.find((s) => s.name === "edge")!.value as never;
    const at64 = standing(edge, 64).margin, at200 = standing(edge, 200).margin;
    expect(at64).toBeGreaterThan(0);
    expect(at64).toBeLessThan((Math.SQRT2 / 64) * 2);
    expect(at200).toBeGreaterThan(0);
    expect(at200).toBeLessThan(at64 / 2);
    const empty = run("e = box(1, 1, 1) - box(2, 2, 2)\nshow box(1)").steps.find((s) => s.name === "e")!.value as never;
    expect(standing(empty, 64).margin).toBe(-Infinity);
  });
});
