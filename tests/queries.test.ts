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
