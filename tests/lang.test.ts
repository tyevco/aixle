import { describe, expect, it } from "vitest";
import { tokenize } from "../src/lang/lexer.js";
import { parse } from "../src/lang/parser.js";
import { evaluate } from "../src/lang/interpreter.js";
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
