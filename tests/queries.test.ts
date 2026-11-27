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
