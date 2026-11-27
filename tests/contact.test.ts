import { describe, expect, it } from "vitest";
import { parse } from "../src/lang/parser.js";
import { evaluate } from "../src/lang/interpreter.js";
import { contactLines } from "../src/pipeline.js";
import { clearance, leanOn, overlapVolume, restOn, type Contact } from "../src/sdf/measure.js";
import { anchorsOf } from "../src/sdf/ops.js";
import type { Shape3 } from "../src/sdf/types.js";

// Roadmap 16: rest() and lean() place a part by contact. The exact answers below are worked out by hand; the
// search is held to a millionth of the part's size of motion and its clearance to touching.
const run = (src: string) => evaluate(parse(src));
const step = (ev: ReturnType<typeof run>, name: string) => ev.steps.find((s) => s.name === name)!.value as Shape3;
const contact = (r: ReturnType<typeof restOn>): Contact => {
  if (!r.shape) throw new Error(`no contact: ${JSON.stringify(r)}`);
  return r;
};
const deg = (r: number) => (r * 180) / Math.PI;

describe("rest()", () => {
  it("drops a tilted box onto a board to the corner that meets first, between lattice points", () => {
    // The lowest corner is 1.0 above the board's top: a lattice over the box put no point on it (0.0046 too far).
    const ev = run("board = box(4, 0.2, 2) | move(0, -0.1, 0)\nbook = box(0.3, 2, 1.4) | rotate(z=18) | move(0, 1 + 1 * cos(18) + 0.15 * sin(18), 0)\nshow board + book");
    const board = step(ev, "board"), r = contact(restOn(step(ev, "book"), board, [0, -1, 0]));
    expect(Math.abs(r.amount - 1)).toBeLessThan(2e-6);
    expect(r.gap).toBeGreaterThanOrEqual(-2e-7);
    expect(r.gap).toBeLessThan(2e-6);
    expect(clearance(r.shape, board)).toBeLessThan(2e-6);
    expect(overlapVolume(r.shape, board)).toBe(0);
    expect(r.backed).toBe(false);
  });

  it("finds a contact off the drop line: a ball into a ring", () => {
    // A sphere of 1.2 rests on a torus (1, 0.2) where its centre is 1.4 from the tube's circle: y = sqrt(1.96 - 1).
    const ev = run("ring = torus(1, 0.2)\nball = sphere(1.2) | move(0, 3, 0)\nshow ring + ball");
    const r = contact(restOn(step(ev, "ball"), step(ev, "ring"), [0, -1, 0]));
    expect(Math.abs(r.amount - (3 - Math.sqrt(0.96)))).toBeLessThan(3e-6);
    expect(Math.abs(r.gap)).toBeLessThan(3e-6);
  });

  it("slides along a ledge to a wall, 0.01 above the ledge or standing on it, square or rounded", () => {
    // The grazing case: conservative advancement on the clearance stalls at the ledge's 0.01 (200 steps and more).
    for (const [y, round] of [["0.51", ""], ["0.5", ""], ["0.5", ", round=0.05"]]) {
      const ev = run(`slab = box(6, 0.2, 2) | move(0, -0.1, 0)\nwall = box(0.2, 2, 2) | move(-2.1, 1, 0)\nbase = slab + wall\nblock = box(1, 1, 1${round}) | move(0.5, ${y}, 0)\nshow base + block`);
      const base = step(ev, "base"), r = contact(restOn(step(ev, "block"), base, [-1, 0, 0]));
      expect(Math.abs(r.amount - 2)).toBeLessThan(1e-6);
      expect(clearance(r.shape, step(ev, "wall"))).toBeLessThan(1e-6);
      expect(clearance(r.shape, step(ev, "wall"))).toBeGreaterThan(-1e-6);
    }
  });

  it("drops off the axis onto a ramp and along a diagonal into a corner", () => {
    // The ramp's top face is n.p = 0.1 with n = (-sin 20, cos 20); the cube's lowest corner is (0.85, 2.75).
    const s = Math.sin((20 * Math.PI) / 180), c = Math.cos((20 * Math.PI) / 180);
    const ramp = run("ramp = box(4, 0.2, 2) | rotate(z=20)\ncube = box(0.5, 0.5, 0.5) | move(0.6, 3, 0)\nshow ramp + cube");
    const r1 = contact(restOn(step(ramp, "cube"), step(ramp, "ramp"), [0, -1, 0]));
    expect(Math.abs(r1.amount - (-s * 0.85 + c * 2.75 - 0.1) / c)).toBeLessThan(1e-6);
    // A ball of 0.5 at (1, 2) moved along (-1, -1): the floor first, when its centre is 0.5 up, 1.5 * sqrt(2) along.
    const corner = run("corner = (box(3, 0.2, 3) | move(0, -0.1, 0)) + (box(0.2, 3, 3) | move(-1.6, 1.5, 0))\nball = sphere(0.5) | move(1, 2, 0)\nshow corner + ball");
    const r2 = contact(restOn(step(corner, "ball"), step(corner, "corner"), [-1, -1, 0]));
    expect(Math.abs(r2.amount - 1.5 * Math.SQRT2)).toBeLessThan(1e-6);
  });

  it("backs a part that starts inside out against the motion, to the first place it is clear", () => {
    // A book built standing on y = 0 through a board whose top is 0.8 rests on the board, not under it.
    const ev = run("board = box(4, 0.2, 2) | move(0, 0.7, 0)\nbook = box(0.3, 2.5, 1.4) | move(0, 1.25, 0)\nshow board + book");
    const r = contact(restOn(step(ev, "book"), step(ev, "board"), [0, -1, 0]));
    expect(r.backed).toBe(true);
    expect(Math.abs(r.amount + 0.8)).toBeLessThan(1e-6);
    expect(overlapVolume(r.shape, step(ev, "board"))).toBe(0);
  });

  it("lifts a part out of a sliver it is sunk in first, so it can slide along what it stands on", () => {
    // ground() leaves a box turned 18 degrees with rounded edges about 4.5e-5 into the floor (its rays stop that
    // short of the surface); slid along the shelf into its neighbour, it would never come clear going back.
    const ev = run(`board = box(6, 0.2, 2) | move(0, -0.1, 0)
prev = box(0.3, 2.45, 1.9, round=0.02) | move(-1, 1.225, 0)
book = box(0.34, 2.5, 1.9, round=0.02) | move(0.17, 1.25, 0) | rotate(z=18) | ground() | move(1, 0, 0)
on = prev + board
show on + book`);
    const board = step(ev, "board"), prev = step(ev, "prev"), book = step(ev, "book");
    expect(clearance(book, board)).toBeLessThan(-1e-5);
    const r = contact(restOn(book, step(ev, "on"), [-1, 0, 0]));
    expect(r.lifted).toBeGreaterThan(1e-5);
    expect(r.lifted).toBeLessThan(1e-4);
    // Touching the neighbour, not short of it: the shelf it slides along reads zero all the way and is not the contact.
    expect(Math.abs(clearance(r.shape, prev))).toBeLessThan(3e-6);
    expect(clearance(r.shape, board)).toBeGreaterThan(-3e-7);
  });

  it("stops on a small part the lattice of a large one steps over: a tab on a hook's lip", () => {
    // A plate 2.4 across with a tab 0.11 by 0.045 under its edge, dropped onto a floor with a lip 0.05 thick that
    // overlaps the tab by 0.055 in plan: the tab lands on the lip, 0.12 above the floor (round 11's mixer bowl).
    const ev = run(`floor = box(3, 0.2, 3) | move(0, -0.1, 0)
lip = box(0.155, 0.05, 0.22, round=0.01) | move(0.6625, 0.095, 0)
on = floor + (lip | mirror("x"))
bowl = (cylinder(1.2, 0.3) | move(0, 0.2, 0)) + (box(0.11, 0.045, 0.18, round=0.01) | move(0.585, 0.0225, 0) | mirror("x"))
up = bowl | move(0, 2, 0)
show on + up`);
    const r = contact(restOn(step(ev, "up"), step(ev, "on"), [0, -1, 0]));
    expect(Math.abs(r.amount - (2 - 0.12))).toBeLessThan(1e-5);
    // On the floor alone it falls the whole way.
    const floorOnly = contact(restOn(step(ev, "up"), step(ev, "floor"), [0, -1, 0]));
    expect(Math.abs(floorOnly.amount - 2)).toBeLessThan(1e-5);
  });

  it("sinks by `sink` past the touch, stops short by a negative sink, and carries anchors", () => {
    const ev = run(`board = box(4, 0.2, 2) | move(0, -0.1, 0)
cube = box(1, 1, 1) | anchor("top", 0, 0.5, 0) | move(0.2, 3.5, 0)
sunk = cube | rest(board, sink=0.02)
short = cube | rest(board, sink=-0.06)
show board + sunk`);
    const board = step(ev, "board");
    expect(clearance(step(ev, "sunk"), board)).toBeCloseTo(-0.02, 5);
    expect(clearance(step(ev, "short"), board)).toBeCloseTo(0.06, 5);
    expect(anchorsOf(step(ev, "sunk")).top[1]).toBeCloseTo(1 - 0.02, 5);
    expect(anchorsOf(step(ev, "short")).top[1]).toBeCloseTo(1 + 0.06, 5);
  });

  it("is deterministic: the same call gives the same number to the last bit", () => {
    const src = "ring = torus(1, 0.2)\nball = sphere(1.2) | move(0, 3, 0)\nshow ring + ball";
    const a = contact(restOn(step(run(src), "ball"), step(run(src), "ring"), [0, -1, 0]));
    const b = contact(restOn(step(run(src), "ball"), step(run(src), "ring"), [0, -1, 0]));
    expect(a.amount).toBe(b.amount);
    expect(a.gap).toBe(b.gap);
  });

  it("is an error naming the part, the target and the direction when nothing is in the way", () => {
    expect(() => run("board = box(4, 0.2, 2)\nbowl = sphere(0.5) | move(0, 2, 0)\nb = bowl | rest(board, dir=[0, 1, 0])\nshow b")).toThrow(/line 3: rest\(\): bowl \(x -0\.5\.\.0\.5 {2}y 1\.5\.\.2\.5 {2}z -0\.5\.\.0\.5\) never touches board \(x -2\.\.2 {2}y -0\.1\.\.0\.1 {2}z -1\.\.1\) moving along \[0, 1, 0\]/);
    expect(() => run("board = box(4, 0.2, 2)\nb = sphere(0.5) | rest(board, dir=[0, 0, 0])\nshow b")).toThrow(/dir is \[0, 0, 0\], which points nowhere/);
  });

  it("meshes a face resting on a face as one piece, so sink defaults to 0", () => {
    // Measured for roadmap 16: a touch is one piece at every grid tried, the lattice on the contact plane or not.
    const ev = run(`board = box(2, 0.2, 2) | move(0, -0.1, 0)
cube = box(1, 1, 1) | move(0.13, 2.37, 0.21) | rest(board)
lower = box(2, 1, 2) | move(0, -0.5, 0)
upper = box(2, 1, 2) | move(0, 3, 0) | rest(lower)
a = pieces(cube + board, 64)
b = pieces(cube + board, 128)
c = pieces(upper + lower, 32)
show board + cube`);
    for (const k of ["a", "b", "c"]) expect(ev.steps.find((s) => s.name === k)!.value).toBe(1);
  });
});

describe("lean()", () => {
  const books = run(`neighbour = box(0.3, 2.2, 1.4) | move(-0.25, 1.1, 0)
book = box(0.3, 2, 1.4) | anchor("heel", -0.15, -1, 0) | move(0.15, 1, 0)
rounded = box(0.3, 2, 1.4, round=0.02) | anchor("heel", -0.15, -1, 0) | move(0.15, 1, 0)
show neighbour + book`);
  const neighbour = step(books, "neighbour");

  it("turns a book about its heel until its corner meets the neighbour", () => {
    // The top-left corner (0, 2) swings to x = -0.1: sin(a) = 0.05.
    const r = contact(leanOn(step(books, "book"), neighbour, [0, 0, 0], [0, 0, 1]));
    expect(Math.abs(r.amount - deg(Math.asin(0.05)))).toBeLessThan(1e-4);
    expect(Math.abs(r.gap)).toBeLessThan(2e-6);
    // Rounded 0.02, the corner's arc centre (0.02, 1.98) turned: 0.02 cos a - 1.98 sin a = -0.08.
    const rr = contact(leanOn(step(books, "rounded"), neighbour, [0, 0, 0], [0, 0, 1]));
    let lo = 0, hi = 0.2;
    for (let i = 0; i < 80; i++) { const m = (lo + hi) / 2; if (0.02 * Math.cos(m) - 1.98 * Math.sin(m) + 0.08 > 0) lo = m; else hi = m; }
    expect(Math.abs(rr.amount - deg(lo))).toBeLessThan(1e-4);
    expect(overlapVolume(rr.shape, neighbour)).toBe(0);
  });

  it("takes an anchor's name for the pivot and turns the anchors with the part", () => {
    const ev = run(`neighbour = box(0.3, 2.2, 1.4) | move(-0.25, 1.1, 0)
book = box(0.3, 2, 1.4) | anchor("heel", -0.15, -1, 0) | anchor("head", 0.15, 1, 0) | move(0.15, 1, 0)
leaned = book | lean(neighbour, pivot="heel", axis=[0, 0, 1])
by_point = book | lean(neighbour, pivot=[0, 0, 0], axis=[0, 0, 1])
show neighbour + leaned`);
    const a = anchorsOf(step(ev, "leaned"));
    expect(a.heel.map((v) => Math.abs(v) < 1e-12 ? 0 : v)).toEqual([0, 0, 0]);
    const t = (Math.asin(0.05) * 180) / Math.PI;
    // The head (0.3, 2) turned by the angle found.
    expect(a.head[0]).toBeCloseTo(0.3 * Math.cos((t * Math.PI) / 180) - 2 * Math.sin((t * Math.PI) / 180), 4);
    expect(ev.contacts.map((c) => c.note.amount)[0]).toBe(ev.contacts.map((c) => c.note.amount)[1]);
  });

  it("turns the right-handed way about the axis, as rotate() does, and says so when that never touches", () => {
    // Turned the other way about [0, 0, -1], the book swings right and down and never reaches a neighbour that
    // stands clear of the floor: an error that names the other axis.
    expect(() => run(`neighbour = box(0.3, 1.7, 1.4) | move(-0.25, 1.35, 0)
book = box(0.3, 2, 1.4) | anchor("heel", -0.15, -1, 0) | move(0.15, 1, 0)
l = book | lean(neighbour, pivot="heel", axis=[0, 0, -1])
show l`)).toThrow(/line 3: lean\(\): book \([^)]*\) turned about \[0, 0, -1\] through \(0, 0, 0\) never touches neighbour \([^)]*\) in half a turn: it turns the right-handed way about the axis, so axis=\[0, 0, 1\] turns it the other way/);
    expect(() => run(`n = box(1)\nl = box(1) | move(3, 0, 0) | lean(n, pivot="nowhere", axis=[0, 0, 1])\nshow l`)).toThrow(/no anchor "nowhere" to turn about/);
  });
});

describe("check's lines for rest() and lean()", () => {
  it("say how far each call moved or turned, a line per call in the source", () => {
    const ev = run(`board = box(4, 0.2, 2) | move(0, 0.7, 0)
book = box(0.3, 2.5, 1.4) | anchor("heel", -0.15, -1.25, 0) | move(0, 1.25, 0) | rest(board)
prev = box(0.3, 2.2, 1.4) | move(-0.6, 3, 0) | rest(board)
leaned = book | lean(prev, pivot="heel", axis=[0, 0, 1])
row = empty()
for i in range(3) {
  bk = box(0.2, 1, 1) | move(0.5 + i * 0.4, 2, 0) | rest(board, sink=0.01)
  row = row + bk
}
show board + leaned + prev + row`);
    const lines = contactLines(ev.contacts);
    expect(lines).toHaveLength(4);
    expect(lines[0]).toMatch(/^rest \(line 2\) {6}book onto board: moved -0\.8 along \[0, -1, 0\] \(it started inside board and was backed out\); gap /);
    expect(lines[1]).toMatch(/^rest \(line 3\) {6}prev onto board: moved 1\.1 along \[0, -1, 0\]; gap /);
    expect(lines[2]).toMatch(/^lean \(line 4\) {6}book onto prev: turned 7\.7\d+ degrees about \[0, 0, 1\] through \(-0\.15, 0\.8, 0\); gap /);
    expect(lines[3]).toMatch(/^rest \(line 7\) {6}3 calls, bk onto board: moved 0\.7 along \[0, -1, 0\], then sunk 0\.01; gaps up to /);
  });

  it("point out a turn of more than a quarter, and the axis that turns the other way", () => {
    const lines = contactLines([{ callee: "lean", line: 9, part: "book", on: "prev", note: { amount: 170, along: [0, 0, -1], pivot: [0, 0, 0], gap: 1e-7, backed: false, lifted: 0, sink: 0 } }]);
    expect(lines[0]).toMatch(/turned 170 degrees about \[0, 0, -1\] through \(0, 0, 0\); gap 1e-7; more than a quarter turn: axis=\[0, 0, 1\] turns the other way$/);
  });

  it("warn of a rest piped after a union without parentheses, as for move", () => {
    const ev = run("a = box(1)\nb = box(1) | move(2, 0, 0)\nfloor = box(5, 0.1, 5) | move(0, -2, 0)\nc = a + b | rest(floor)\nshow c + floor");
    expect(ev.warnings.join("\n")).toMatch(/applies rest to the right side only/);
  });
});
