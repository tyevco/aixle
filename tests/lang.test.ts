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
    expect(rope.bounds.max[0]).toBeLessThan(1.3);
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
  it("refuses runaway loops", () => {
    expect(() => run("for i in range(30000) { a = 1 }")).toThrow(/loop iterations/);
  });
});
