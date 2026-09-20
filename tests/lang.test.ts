import { describe, expect, it } from "vitest";
import { tokenize } from "../src/lang/lexer.js";
import { parse } from "../src/lang/parser.js";
import { assertLine, evaluate } from "../src/lang/interpreter.js";
import { isShape2, isShape3 } from "../src/lang/values.js";
import type { Shape3 } from "../src/sdf/types.js";

const run = (src: string) => evaluate(parse(src));
const shape = (src: string, name: string): Shape3 => run(src).steps.find((s) => s.name === name)!.value as Shape3;

describe("lexer", () => {
  it("tokenises numbers, strings, names and operators", () => {
    const t = tokenize('a = box(1.5, "x") | move(-2)').map((x) => x.value);
    expect(t).toEqual(["a", "=", "box", "(", "1.5", ",", "x", ")", "|", "move", "(", "-", "2", ")", "\n", ""]);
  });
  it("drops comments and keeps line numbers", () => {
    const t = tokenize("# one\na = 1 // two\n\nb = 2");
    expect(t.find((x) => x.value === "b")!.line).toBe(4);
    expect(t.filter((x) => x.type === "ident").map((x) => x.value)).toEqual(["a", "b"]);
  });
  it("continues a statement across a line break inside parentheses, after an operator, or before one", () => {
    const inside = tokenize("a = box(1,\n 2)").filter((x) => x.type === "newline").length;
    const after = tokenize("a = box(1) +\n sphere(1)").filter((x) => x.type === "newline").length;
    const before = tokenize("a = box(1)\n  | move(1)\n  + sphere(2)").filter((x) => x.type === "newline").length;
    expect([inside, after, before]).toEqual([1, 1, 1]);
  });
  it("a blank line ends the statement even before an operator", () => {
    expect(() => parse("a = box(1)\n\n- sphere(1)")).not.toThrow();
    const p = parse("a = box(1)\n\n- sphere(1)");
    expect(p.body).toHaveLength(2);
  });
  it("reports unterminated strings with the line", () => {
    expect(() => tokenize('a = 1\nb = "oops')).toThrow(/line 2/);
  });
});

describe("parser", () => {
  it("binds | tighter than + and & tighter than +", () => {
    const p = parse("a = b + c | move(1) & d");
    const e = (p.body[0] as { value: unknown }).value as { op: string; left: unknown; right: { op: string; left: { callee: string } } };
    expect(e.op).toBe("+");
    expect(e.right.op).toBe("&");
    expect(e.right.left.callee).toBe("move");
  });
  it("turns a pipeline into a call with the left side first", () => {
    const p = parse("a = sphere(1) | move(1, 2, z=3)");
    const e = (p.body[0] as { value: { callee: string; args: { name?: string }[] } }).value;
    expect(e.callee).toBe("move");
    expect(e.args.map((a) => a.name)).toEqual([undefined, undefined, undefined, "z"]);
  });
  it("parses def, for, show and set", () => {
    const p = parse("def f(a, b=2) = box(a, b)\nfor i in range(3) {\n  x = f(i)\n}\nshow x\nset grid 64");
    expect(p.body.map((s) => s.type)).toEqual(["def", "for", "show", "set"]);
  });
  it("parses comparisons loosest of all, and assert with an optional message", () => {
    const p = parse("assert 1 + 2 < 4 * 1, \"sum\"\nassert a == b");
    expect(p.body[0]).toMatchObject({ type: "assert", test: { type: "binary", op: "<", left: { op: "+" }, right: { op: "*" } }, message: { type: "str", value: "sum" } });
    expect(p.body[1]).toMatchObject({ type: "assert", test: { op: "==" }, message: undefined });
    expect(() => parse("assert = 1")).toThrow(/'assert' is a keyword/);
    // A pose name after the message, or before it, as a bare word or a string.
    expect(parse('assert tall(m) < 2, "shut", pose=shut').body[0]).toMatchObject({ type: "assert", message: { value: "shut" }, pose: "shut" });
    expect(parse('assert tall(m) < 2, pose="shut", "closed"').body[0]).toMatchObject({ type: "assert", message: { value: "closed" }, pose: "shut" });
    expect(parse("assert tall(m) < 2, pose=shut").body[0]).toMatchObject({ type: "assert", message: undefined, pose: "shut" });
    expect(() => parse("assert 1, pose=2")).toThrow(/pose= names a pose/);
    expect(() => parse('assert 1, "a", "b"')).toThrow(/a message and pose=name/);
  });
  it("refuses a keyword as a name with a plain message", () => {
    expect(() => parse("scene = box(1)")).toThrow(/line 1: 'scene' is a keyword and cannot be a name/);
    expect(() => parse("show = 1")).toThrow(/'show' is a keyword/);
  });
  it("names the line an unclosed call opened on", () => {
    expect(() => parse("a = move(box(1),\nshow a")).toThrow(/line 1: the call to move opened on line 1 is never closed: missing '\)' before 'show' on line 2/);
    expect(() => parse("a = move(box(1)\n  b = 2")).toThrow(/found 'b' \(the call opened on line 1\)/);
    expect(() => parse("a = box(1,")).toThrow(/call to box opened on line 1 is never closed/);
  });
  it("names the line of a syntax error", () => {
    expect(() => parse("a = 1\nb = box(1,")).toThrow(/line 2/);
    expect(() => parse("for i in range(3) {\n x = 1")).toThrow(/never closed/);
  });
});

describe("interpreter", () => {
  it("does arithmetic with the usual precedence and degrees", () => {
    const ev = run("a = 1 + 2 * 3 ^ 2\nb = -a / 2\nc = sin(90) + cos(0)\nd = 7 % 3");
    expect(ev.steps.map((s) => s.value)).toEqual([19, -9.5, 2, 1]);
  });
  it("unions with +, cuts with -, intersects with &", () => {
    const ev = run("a = sphere(1)\nb = box(1)\nu = a + b\nd = a - b\ni = a & b");
    const u = shape("a = sphere(1)\nb = box(1)\nu = a + b", "u");
    expect(u.dist(0, 0, 0)).toBeCloseTo(-1, 5);
    const d = ev.steps.find((s) => s.name === "d")!.value as Shape3;
    expect(d.dist(0, 0, 0)).toBeCloseTo(0.5, 5);
    const i = ev.steps.find((s) => s.name === "i")!.value as Shape3;
    expect(i.dist(0, 0, 0)).toBeCloseTo(-0.5, 5);
  });
  it("passes the blend radius of a variadic union as k, not the rest list", () => {
    const soft = shape("s = union(sphere(1), sphere(1) | move(1.5, 0, 0), sphere(1) | move(3, 0, 0), k = 0.4)", "s");
    const hard = shape("h = union(sphere(1), sphere(1) | move(1.5, 0, 0), sphere(1) | move(3, 0, 0))", "h");
    expect(Number.isNaN(soft.dist(0.75, 1, 0))).toBe(false);
    expect(soft.dist(0.75, 1, 0)).toBeLessThan(hard.dist(0.75, 1, 0));
    expect(soft.dist(3, 0, 0)).toBeCloseTo(-1, 5);
    const soft2 = run("p = union(circle(1), circle(1) | move(1.5, 0), k = 0.4)").steps[0].value as { dist: (x: number, y: number) => number };
    expect(Number.isNaN(soft2.dist(0.75, 1))).toBe(false);
  });
  it("binds arguments by position or name, with defaults", () => {
    const a = shape("a = cylinder(1, 2)", "a");
    const b = shape("b = cylinder(h=2, r=1)", "b");
    expect(a.bounds).toEqual(b.bounds);
    expect(shape("c = box(2)", "c").bounds.max).toEqual([1, 1, 1]);
  });
  it("accepts string arguments for axes and materials", () => {
    const m = shape('a = sphere(1) | move(2, 0, 0)\nm = mirror(a, "x") | paint("wood")', "m");
    expect(m.bounds.min[0]).toBeCloseTo(-3);
    expect(m.hit(2, 0, 1).mat.name).toBe("wood");
    expect(() => run('a = sphere(1) | mirror("q")')).toThrow(/"x", "y" or "z"/);
  });
  it("dispatches on 2D versus 3D", () => {
    const ev = run("p = circle(1) | move(1, 0) | rotate(90)\ns = extrude(p, 1)\nr = revolve(rect(0.2, 1) | move(1, 0))");
    expect(isShape2(ev.steps[0].value)).toBe(true);
    expect(isShape3(ev.steps[1].value)).toBe(true);
    expect((ev.steps[2].value as Shape3).dist(1, 0, 0)).toBeCloseTo(-0.1, 5);
  });
  it("builds tubes, sweeps and lofts from point lists", () => {
    const t = shape("t = tube(0.2, [0,0,0, 1,0,0, 1,1,0], smooth=4)", "t");
    expect(t.dist(1, 1, 0)).toBeCloseTo(-0.2);
    const s = shape("s = sweep(rect(0.4, 0.1), [0,0,0, 0,0,3])", "s");
    expect(s.dist(0, 0, 1.5)).toBeCloseTo(-0.05);
    const l = shape("l = loft(circle(1), circle(0.5), 2)", "l");
    expect(l.dist(0, 0.9, 0)).toBeLessThan(0);
    expect(() => run("t = tube(0.2, [0, 0])")).toThrow(/triples/);
  });
  it("makes text profiles, helix paths and twisted sweeps from the language", () => {
    const sign = shape('s = extrude(text("HI", size=2, align="center"), 0.3)', "s");
    expect(sign.bounds.min[0]).toBeLessThan(0);
    expect(sign.bounds.max[0]).toBeGreaterThan(0);
    const spring = shape("s = tube(0.1, helix(1, 3, 4), taper=0.5)", "s");
    expect(spring.bounds.max[1]).toBeCloseTo(3.1);
    const rope = shape("r = sweep(circle(0.2), helix(1, 2, 2), twist=360)", "r");
    expect(rope.bounds.max[0]).toBeGreaterThan(1.19);
    // The box also allows for the mitres at the helix joins (about a third of the reach at these turns).
    expect(rope.bounds.max[0]).toBeLessThan(1.4);
  });
  it("queries heights and bounds, and derives materials from presets", () => {
    const ev = run('r = sphere(1) | displace(0.1, 0.4)\nh = height(r, 0, 0)\nt = top(r)\nw = width(r)\nm = material("granite", scale=0.4)\ns = r | paint(m)');
    const h = ev.steps.find((s) => s.name === "h")!.value as number;
    expect(h).toBeGreaterThan(0.85);
    expect(h).toBeLessThan(1.15);
    expect(ev.steps.find((s) => s.name === "t")!.value).toBeCloseTo(1.1);
    expect(ev.steps.find((s) => s.name === "w")!.value).toBeCloseTo(2.2);
    const m = ev.steps.find((s) => s.name === "m")!.value as { pattern: string; scale: number; name: string };
    expect(m.pattern).toBe("speckle");
    expect(m.scale).toBe(0.4);
    expect(() => run("h = height(sphere(1), 5, 5)")).toThrow(/no surface above \(5, 5\)/);
    expect(() => run('m = material("nonsense")')).toThrow(/not a preset or a colour/);
  });
  it("runs user functions with defaults and loops that build up a shape", () => {
    const src = "def peg(h, r=0.1) = cylinder(r, h)\nall = empty()\nfor i in range(4) {\n all = all + (peg(1) | move(i, 0, 0))\n}";
    const all = shape(src, "all");
    expect(all.bounds.min[0]).toBeCloseTo(-0.1);
    expect(all.bounds.max[0]).toBeCloseTo(3.1);
    expect(all.dist(3, 0, 0)).toBeCloseTo(-0.1, 5);
  });
  it("uses show for the output, else the last shape, and warns about unused shapes", () => {
    const ev = run("a = sphere(1)\nb = box(1)\nshow a");
    expect(ev.outputName).toBe("a");
    expect(ev.used.has("b")).toBe(false);
    expect(ev.warnings.join()).toMatch(/'b' \(line 2\) is not part of the output/);
    const last = run("a = sphere(1)\nb = box(1)");
    expect(last.outputName).toBe("b");
  });
  it("tracks dependencies through intermediate names", () => {
    const ev = run("r = 1\na = sphere(r)\nb = a | move(1, 0, 0)\nc = box(1)\nshow b");
    expect([...ev.used].sort()).toEqual(["a", "b", "r"]);
  });
  it("reports only the overload that fits the first argument", () => {
    let msg = "";
    try { run("a = sphere(1) | rotate(y=45, pitch=3)"); } catch (e) { msg = (e as Error).message; }
    expect(msg).toMatch(/no parameter named 'pitch'/);
    expect(msg).not.toMatch(/profile/);
    expect(msg).toMatch(/rotate\(shape, x=0, y=0, z=0\)/);
    expect(msg).not.toMatch(/rotate\(profile/);
  });
  it("explains errors with the line and the usage", () => {
    expect(() => run("a = sphere()")).toThrow(/line 1: sphere\(\): missing 'r'/);
    expect(() => run("a = sphere(1)\nb = a | move(\"x\")")).toThrow(/line 2: move\(\)[\s\S]*x: expected a number, got the string "x"/);
    expect(() => run("a = spehre(1)")).toThrow(/unknown function 'spehre'/);
    expect(() => run("a = b")).toThrow(/'b' is not defined/);
    expect(() => run("a = circle(1) + sphere(1)")).toThrow(/extrude or revolve/);
  });
  it("compares numbers and strings to 1 or 0, and refuses to compare shapes", () => {
    const ev = run("a = 2 < 3\nb = 3 <= 2\nc = 1 == 1\nd = \"x\" != \"y\"\ne = max(0.2, 1 > 0)");
    expect(ev.steps.map((s) => s.value)).toEqual([1, 0, 1, 1, 1]);
    expect(() => run("a = sphere(1) < 2")).toThrow(/'<' compares two numbers, not a shape and a number; measure the shape first/);
    expect(() => run("a = \"x\" < \"y\"")).toThrow(/'<' compares two numbers/);
  });
  it("records every assert with its text, both sides and the message, passed or not", () => {
    const ev = run("m = box(2, 1, 1)\nassert width(m) < 5, \"fits\"\nassert tall(m) > 3\nassert m | tall == 1\nfor i in range(2) { assert i < 1 }");
    expect(ev.asserts.map((a) => [a.line, a.passed, a.text, a.detail, a.message])).toEqual([
      [2, true, "width(m) < 5", "2 < 5", "fits"],
      [3, false, "tall(m) > 3", "1 > 3", undefined],
      [4, true, "m | tall == 1", "1 == 1", undefined],
      [5, true, "i < 1", "0 < 1", undefined],
      [5, false, "i < 1", "1 < 1", undefined],
    ]);
    expect(() => run("assert sphere(1)")).toThrow(/assert tests a number/);
    expect(() => run("assert 1 < 2, 3")).toThrow(/message is a string/);
  });
  it("measures a step under other joints where the pose puts it, inside an assert only", () => {
    // A lid on a hinge, the hinge inside a body joint that lifts everything: the lid's own step is at rest in its
    // own frame, and a pose assert reads it through the body joint (round 8: a tucked wrist measured at rest).
    const src = 'lid = joint(box(1, 0.2, 1) | move(0, 1.1, 0), "hinge", 0, 1, 0.5)\nbody = joint(box(1) | move(0, 0.5, 0) + lid, "body", 0, 0, 0)\nb = bottom(lid)\nassert bottom(lid) > 2, "lifted", pose=up\nassert bottom(lid) < 2, "at rest"\npose("up", body=xform(move=[0, 2, 0]))\nshow body';
    const rest = run(src);
    expect(rest.asserts.map((a) => [a.line, a.passed, a.pending])).toEqual([[4, true, true], [5, true, undefined]]);
    const up = evaluate(parse(src), { jointPoses: rest.poses[0].joints, poseName: "up" });
    // The assert saw the lifted lid; the step computed outside an assert did not move.
    expect(up.asserts[0]).toMatchObject({ passed: true, detail: "3 > 2" });
    expect(up.steps.find((s) => s.name === "b")?.value).toBeCloseTo(1, 6);
    // Without a pose there is nothing to place.
    expect(rest.asserts[1].detail).toBe("1 < 2");
  });
  it("starts a pose from another with from=, and warns about a two-key clip that eases nothing at its ends", () => {
    const src = 'a = joint(box(1), "a", 0, 0, 0)\nb = joint(box(1) | move(2, 0, 0), "b", 2, 0, 0)\nm = a + b\npose("reach", a=[0, 0, 60])\npose("hold", from="reach", b=xform(move=[0, 0.1, 0]))\npose("open", from="rest", b=[10, 0, 0])\nanimation("flick", ["rest", "reach"], loop=0, ease=1, ease_ends=0)\nanimation("wave", ["rest", "reach", "rest"], ease=1, ease_ends=0)\nshow m';
    const ev = run(src);
    expect(ev.poses.find((p) => p.name === "hold")?.joints).toEqual({ a: { angles: [0, 0, 60], move: [0, 0, 0], scale: [1, 1, 1] }, b: { angles: [0, 0, 0], move: [0, 0.1, 0], scale: [1, 1, 1] } });
    expect(Object.keys(ev.poses.find((p) => p.name === "open")!.joints)).toEqual(["b"]);
    expect(ev.warnings).toContainEqual(expect.stringMatching(/animation "flick" \(line 7\): with two keys both are ends, so ease_ends=0 leaves nothing for ease=1 to do; hold the last pose as a third key \(\["rest", "reach", "reach"\]/));
    expect(ev.warnings.filter((w) => /"wave"/.test(w))).toEqual([]);
    expect(() => run('pose("x", from="nope", a=[1, 0, 0])')).toThrow(/from="nope" names no pose defined above/);
    expect(() => run('pose("x", from=3)')).toThrow(/from= names a pose defined above, as a string/);
  });
  it("warns about a decal whose region touches none of the surface, counts pieces at the program's grid, and does not double a prefix", () => {
    const miss = run('m = sphere(1)\nspot = box(0.2, 0.2, 0.2) | move(3, 0, 0)\nd = decal(m, spot, "black")\nshow d');
    expect(miss.warnings).toContainEqual('line 3: decal(): the region `spot` touches none of the shape\'s surface, so it paints nothing; the region must cross the surface (a sphere centred on the skin, a box through it)');
    const hit = run('m = sphere(1)\nspot = sphere(0.2) | move(1, 0, 0)\nd = decal(m, spot, "black")\nshow d');
    expect(hit.warnings.filter((w) => /decal/.test(w))).toEqual([]);
    // Two balls on a rod thinner than a coarse cell: one piece at 64 cells, two at the program's 24.
    const bridge = 'a = sphere(0.5) | move(-1.5, 0, 0)\nb = sphere(0.5) | move(1.5, 0, 0)\nrod = box(3, 0.08, 0.08)\nm = a + b + rod\n';
    expect(run(`${bridge}n = pieces(m)\nshow m`).steps.find((s) => s.name === "n")?.value).toBe(1);
    expect(run(`set grid 24\n${bridge}n = pieces(m)\nshow m`).steps.find((s) => s.name === "n")?.value).toBe(2);
    expect(run(`set grid 24\n${bridge}n = pieces(m, resolution=64)\nshow m`).steps.find((s) => s.name === "n")?.value).toBe(1);
    expect(() => run('s = sphere(1)\np = at(s, "tp")')).toThrow(/^line 2: at\(\): no anchor "tp"/);
  });
  it("judges an assert that names a pose only in that pose's evaluation", () => {
    const src = 'lid = joint(box(1, 0.2, 1) | move(0, 1.1, 0), "hinge", 0, 1, 0.5)\npose("open", hinge=[-90, 0, 0])\nassert tall(lid) < 0.5, "lies flat", pose=open\nassert tall(lid) < 0.5, "at rest"\nassert tall(lid) < 0.5, pose=rest';
    const rest = run(src);
    // At rest the posed assert is pending, not judged; pose=rest is the rest evaluation.
    expect(rest.asserts.map((a) => [a.line, a.passed, a.pose, a.pending])).toEqual([[3, true, "open", true], [4, true, undefined, undefined], [5, true, "rest", undefined]]);
    expect(rest.warnings.filter((w) => /assert/.test(w))).toEqual([]);
    const open = evaluate(parse(src), { jointPoses: rest.poses[0].joints, poseName: "open" });
    // Opened, the lid stands up: its own assert fails with the numbers it saw; the unposed one is evaluated here too
    // (the pipeline takes its verdict from the rest evaluation) and the pose=rest one is pending.
    expect(open.asserts.map((a) => [a.line, a.passed, a.pending])).toEqual([[3, false, undefined], [4, false, undefined], [5, true, true]]);
    expect(open.asserts[0].detail).toMatch(/^1 < 0\.5$/);
    expect(assertLine(open.asserts[0])).toBe("assert (line 3) in pose open fails: tall(lid) < 0.5 is 1 < 0.5: lies flat");
    // An assert for a pose that does not exist is never tested, and says so.
    expect(run(`${src}\nassert 1, pose=shut`).warnings).toContainEqual('assert (line 6) is for pose "shut", which is not defined; poses: open; it is never tested');
  });
  it("warns when a shape expression is not assigned", () => {
    const ev = run("a = sphere(1)\na | move(1, 0, 0)");
    expect(ev.warnings[0]).toMatch(/thrown away/);
  });
  it("reads settings", () => {
    expect(run("set grid 200\na = sphere(1)").settings.grid).toBe(200);
  });
  it("lets an animation use the implicit rest pose and names a missing one once", () => {
    const src = 'j = joint(box(1), "hinge", 0, 0, 0)\npose("open", hinge=[30, 0, 0])\nanimation("swing", ["rest", "open", "rest"], seconds=1)\nanimation("bad", ["nope", "open", "nope"], seconds=1)\nshow j';
    const w = run(src).warnings.filter((x) => x.includes("animation"));
    expect(w).toHaveLength(1);
    expect(w[0]).toMatch(/"bad" .*uses pose "nope", which is not defined; poses: open/);
  });
  it("takes a bare word as the name in set pose and set focus", () => {
    // A dogfooding agent wrote `set pose reading`, as the docs show, and was told 'reading' is not defined.
    const ev = run('lid = box(1)\nj = joint(lid, "hinge", 0, 0.5, 0)\npose("open", hinge=[30, 0, 0])\nset pose open\nset focus lid\nshow j');
    expect(ev.settings.pose).toBe("open");
    expect(ev.settings.focus).toBe("lid");
    expect(run('a = box(1)\nset pose "open"').settings.pose).toBe("open");
    expect(() => run("set grid nope")).toThrow(/nope/);
  });
  it("refuses runaway loops", () => {
    expect(() => run("for i in range(30000) { a = 1 }")).toThrow(/loop iterations/);
  });
});

describe("curves and faces in the language", () => {
  it("passes a bezier or curve to tube and sweep, and rejects a list where a curve is needed", () => {
    const ev = run('rail = tube(0.2, bezier([0,0,0, 1,0,0, 3,0,0, 4,0,0]))\nband = sweep(rect(0.5, 0.2), curve([0,0,0, 1,1,0, 2,0,0]), twist=90)\nm = rail + band');
    expect(isShape3(ev.steps.find((s) => s.name === "rail")!.value)).toBe(true);
    expect(isShape3(ev.steps.find((s) => s.name === "band")!.value)).toBe(true);
    expect(() => run("t = tube(0.2, bezier([0,0,0, 1,0,0]))")).toThrow(/4, 7, 10/);
    expect(() => run('t = sweep(rect(1, 1), "nope")')).toThrow(/sweep/);
  });
  it("text takes face=\"serif\"", () => {
    const ev = run('a = extrude(text("Ab", 1, face="serif"), 0.2)\nb = extrude(text("Ab", 1), 0.2)');
    const wa = (ev.steps.find((s) => s.name === "a")!.value as Shape3).bounds, wb = (ev.steps.find((s) => s.name === "b")!.value as Shape3).bounds;
    expect(wa.max[0] - wa.min[0]).toBeGreaterThan(wb.max[0] - wb.min[0]);
    expect(() => run('a = text("A", face="bold")')).toThrow(/sans.*serif/);
  });
});

describe("wrap in the language", () => {
  it("wraps standing text round a radius", () => {
    const ev = run('rim = extrude(text("ABC", 0.3, align="center"), 0.05, "z") | wrap(1) | move(0, 2, 0)');
    const b = (ev.steps.find((s) => s.name === "rim")!.value as Shape3).bounds;
    expect(b.max[2]).toBeGreaterThan(1);
    expect(b.max[2]).toBeLessThan(1.2);
    expect(b.min[1]).toBeGreaterThan(1.8);
  });
});

describe("round-4 findings in the language", () => {
  it("flattens nested point lists in paths, names a material after its step, and warns on a shadowed builtin that is called", () => {
    const ev = run("hip = [0, 0, 0]\nknee = [0, 2, 0]\nleg = tube(0.1, [hip, knee])\nbody = material(\"#e9b125\", rough=0.5)\nm = leg | paint(body)");
    expect(ev.warnings).toEqual([]);
    const leg = ev.steps.find((s) => s.name === "leg")!.value as Shape3;
    expect(leg.bounds.max[1]).toBeCloseTo(2.1, 5);
    expect(leg.bounds.min[1]).toBeCloseTo(-0.1, 5);
    expect(ev.output!.hit(0, 1, 0.1).mat.name).toBe("body");
    const shadow = run("top = box(1)\nlid = box(2) | move(0, top(top), 0)\nm = top + lid");
    expect(shadow.warnings.join()).toMatch(/top\(\.\.\.\) calls the builtin, but 'top' is also a step/);
    expect(run("top = box(1)\nm = top + box(2)").warnings).toEqual([]);
  });
  it("surface() finds the nearest surface point, so a rod can meet a curved body", () => {
    const ev = run("body = sphere(2)\np = surface(body, 0, 5, 0)\nrod = tube(0.1, [p, [0, 5, 0]])\nm = body + rod");
    const p = ev.steps.find((s) => s.name === "p")!.value as number[];
    expect(p[1]).toBeCloseTo(2, 4);
  });
});

describe("anchors", () => {
  it("carry through moves, rotations, warps and posed joints, and attach() places by them", () => {
    const src = [
      'post = cylinder(0.08, 1) | anchor("top", 0, 0.5, 0) | move(0, 0.5, 0)',
      'arm = box(1, 0.2, 0.2) | anchor("root", -0.5, 0, 0) | anchor("tip", 0.5, 0, 0)',
      'arm2 = arm | rotate(z=90) | attach("root", post, "top")',
      'p = at(arm2, "tip")',
      'lamp = sphere(0.15) | attach("bottom", arm2, "tip")',
      'j = joint(arm2 + lamp, "swing", 0, 1, 0)',
      'q = at(j, "tip")',
      'bar = box(2, 0.1, 0.1) | anchor("end", 1, 0, 0) | bend(45)',
      'e = at(bar, "end")',
      'm = post + j',
      'pose("up", swing=[0, 0, -90])',
    ].join("\n");
    const ev = run(src);
    const p = ev.steps.find((s) => s.name === "p")!.value as number[];
    expect(p[0]).toBeCloseTo(0, 6);
    expect(p[1]).toBeCloseTo(2, 6);
    const lamp = ev.steps.find((s) => s.name === "lamp")!.value as Shape3;
    expect(lamp.bounds.min[1]).toBeCloseTo(2, 6);
    // In the pose the joint turns the arm about (0, 1, 0), so the tip swings out to x = 1.
    const posed = evaluate(parse(src), { jointPoses: { swing: { angles: [0, 0, -90], move: [0, 0, 0], scale: [1, 1, 1] } } });
    const q = posed.steps.find((s) => s.name === "q")!.value as number[];
    expect(q[0]).toBeCloseTo(1, 6);
    expect(q[1]).toBeCloseTo(1, 6);
    // A bent bar's end rides the arc: 45 degrees per unit over one unit, radius 57.3 / 45.
    const e = ev.steps.find((s) => s.name === "e")!.value as number[];
    const R = 1 / (Math.PI / 4);
    expect(e[0]).toBeCloseTo(R * Math.sin(Math.PI / 4), 6);
    expect(e[1]).toBeCloseTo(R - R * Math.cos(Math.PI / 4), 6);
    // Free anchors come from the box; a missing name lists what there is.
    expect(() => run('a = box(1)\np = at(a, "nose")')).toThrow(/no anchor "nose".*top, bottom/);
  });
});

describe("joints about an axis", () => {
  it("turns about the given axis by one angle, and a pose gives a number", () => {
    const src = [
      "fork = box(0.2, 2, 0.2) | move(0, -1, 0)",
      'steer = joint(fork, "steer", 0, 0, 0, axis=[cos(72), sin(72), 0])',
      "m = box(1, 0.2, 0.2) | move(0, 1, 0) + steer",
      'pose("turned", steer=25)',
    ].join("\n");
    const ev = run(src);
    expect(ev.warnings).toEqual([]);
    expect(ev.poses[0].joints.steer.angles).toEqual([25, 0, 0]);
    // Turned 90 about the axis through the origin: a point on the fork's bottom (0, -2, 0) sweeps about the raked axis.
    const posed = evaluate(parse(src), { jointPoses: { steer: { angles: [90, 0, 0], move: [0, 0, 0], scale: [1, 1, 1] } } });
    const j = posed.steps.find((s) => s.name === "steer")!.value as Shape3;
    const p = j.warp!(0, -2, 0);
    const ax = Math.cos(Math.PI * 0.4), ay = Math.sin(Math.PI * 0.4);
    // Rotation about the axis keeps the component along it: dot(p, axis) is unchanged.
    expect(p[0] * ax + p[1] * ay).toBeCloseTo(-2 * ay, 6);
    expect(Math.hypot(p[0], p[1], p[2])).toBeCloseTo(2, 6);
    expect(p[2]).not.toBeCloseTo(0, 3);
    // A triple on an axis joint, or a number on a plain joint, is named.
    expect(run(src.replace("steer=25", "steer=[25, 0, 5]")).warnings.join()).toMatch(/turns about its axis, so it takes one angle/);
    expect(run('a = joint(box(1), "hinge", 0, 0, 0)\nm = a\npose("p", hinge=25)').warnings.join()).toMatch(/has no axis=, so it takes \[x, y, z\]/);
  });
});

describe("a transform on the right of a union", () => {
  it("warns when a named step is moved alone after '+', not when a fresh primitive is placed that way", () => {
    expect(run("a = box(1)\nb = box(1)\nm = a + b | move(0, 2, 0)").warnings.join()).toMatch(/line 3: '\+ \.\.\. \| move\(\.\.\.\)' applies move to the right side only/);
    expect(run("a = box(1)\nb = box(1)\nm = (a + b) | move(0, 2, 0)").warnings).toEqual([]);
    expect(run("a = box(1)\nm = a + sphere(0.3) | move(0, 2, 0)").warnings).toEqual([]);
    expect(run("a = box(1)\nb = box(1)\nm = a + (b | move(0, 2, 0))").warnings).toEqual([]);
  });
});

describe("use: libraries", () => {
  const libs: Record<string, string> = {
    "parts/hardware.aix": [
      "zinc = material(\"#b8bcc2\", metal=0.9)",
      "head_h = 0.07",
      "def head(r) = prism(6, r * 1.15, head_h)",
      "def bolt(r=0.1, len=0.6) = (head(r) + (cylinder(r / 2, len) | move(0, -len / 2, 0))) | paint(zinc)",
      "plate = bolt()",
      "show plate",
    ].join("\n"),
    "parts/nested.aix": 'use "hardware.aix" as hw\ndef two() = hw.bolt() + (hw.bolt() | move(1, 0, 0))',
  };
  const resolve = (path: string, from?: string) => {
    const key = from && !path.startsWith("std/") ? `${from.replace(/[^/]*$/, "")}${path}` : path;
    const source = libs[key];
    if (!source) throw new Error(`cannot read ${key}`);
    return { source, file: key };
  };
  const ev = (src: string) => evaluate(parse(src), { resolveModule: resolve });
  it("brings a library's defs and constants under a prefix, keeps its shapes to itself, and scopes its defs to its own names", () => {
    const e = ev('use "parts/hardware.aix"\nb = hardware.bolt(0.1, 0.5)\nm = b | paint(hardware.zinc)\nh = hardware.head_h');
    expect(e.warnings).toEqual([]);
    expect(e.modules).toEqual([{ prefix: "hardware", path: "parts/hardware.aix", names: ["zinc", "head_h", "head", "bolt"] }]);
    // prism is centred on y, so the head reaches half its height above the origin.
    expect((e.steps.find((s) => s.name === "b")!.value as Shape3).bounds.max[1]).toBeCloseTo(0.035, 6);
    expect(e.steps.find((s) => s.name === "h")!.value).toBe(0.07);
    // The library's plate is not a step of the program, and head_h inside bolt() came from the library, not from here.
    expect(e.steps.map((s) => s.name)).not.toContain("plate");
    const shadowed = ev('head_h = 5\nuse "parts/hardware.aix"\nb = hardware.bolt()');
    expect((shadowed.steps.find((s) => s.name === "b")!.value as Shape3).bounds.max[1]).toBeCloseTo(0.035, 6);
  });
  it("takes an alias, resolves a library's own uses beside it, and names what is missing", () => {
    const e = ev('use "parts/nested.aix" as n\nm = n.two()');
    expect(e.warnings).toEqual([]);
    expect((e.steps.find((s) => s.name === "m")!.value as Shape3).bounds.max[0]).toBeCloseTo(1.115, 3);
    expect(() => ev('use "parts/hardware.aix"\nm = hardware.nut()')).toThrow(/has no 'nut'; it has zinc, head_h, head, bolt/);
    expect(() => ev('m = hardware.bolt()')).toThrow(/'hardware' is not a used library/);
    expect(() => ev('use "parts/missing.aix"')).toThrow(/cannot read parts\/missing.aix/);
    expect(() => ev('use "parts/hardware.aix"\nuse "parts/nested.aix" as hardware')).toThrow(/already a used library/);
  });
});
