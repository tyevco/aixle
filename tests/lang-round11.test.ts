import { describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { exprText, type Expr, type Stmt } from "../src/lang/ast.js";
import { parse } from "../src/lang/parser.js";
import { assertLine, assertPassLine, commentCodeWarnings, evaluate } from "../src/lang/interpreter.js";
import { format } from "../src/lang/format.js";
import { run as render } from "../src/pipeline.js";

const run = (src: string) => evaluate(parse(src));
/** The CLI from source, its output whether it passes or fails. */
const cli = (...args: string[]): string => {
  try { return execFileSync("npx", ["tsx", "src/cli.ts", ...args], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }); } catch (err) { const e = err as { stdout?: string; stderr?: string }; return `${e.stdout ?? ""}${e.stderr ?? ""}`; }
};
const dir = mkdtempSync(join(tmpdir(), "aixle-round11-"));
/** A program written to a scratch file, for the CLI. */
const file = (name: string, src: string): string => { const f = join(dir, name); writeFileSync(f, src); return f; };

/** Every program in the repo: the examples, the shipped libraries and every dogfood round's. */
function programs(): string[] {
  const files: string[] = [];
  const walk = (dir: string) => {
    for (const f of readdirSync(dir).sort()) {
      const p = join(dir, f);
      if (f === "renders") continue;
      if (statSync(p).isDirectory()) walk(p);
      else if (f.endsWith(".aix")) files.push(p);
    }
  };
  for (const d of ["examples", "std", "dogfood"]) walk(d);
  return files;
}

/** An expression's tree without its lines and the parser's notes, to compare two parses. */
const tree = (e: Expr): string => JSON.stringify(e, (k, v) => (k === "line" || k === "grouped" ? undefined : v));

describe("an expression printed back (round 11: parentheses dropped)", () => {
  it("keeps the parentheses its precedence needs, so the text means what was tested", () => {
    const test = (src: string) => exprText((parse(`assert ${src}`).body[0] as { test: Expr }).test);
    expect(test("F * (stack_y > 0) * clearance(bk, prev) < 0.005")).toBe("F * (stack_y > 0) * clearance(bk, prev) < 0.005");
    expect(test("(a + b) * c > 1")).toBe("(a + b) * c > 1");
    expect(test("a - (b - c) > 0")).toBe("a - (b - c) > 0");
    expect(test("a - b - c > 0")).toBe("a - b - c > 0");
    expect(test("-(a + b) < 0")).toBe("-(a + b) < 0");
    expect(test("(a ^ b) ^ c == 1")).toBe("(a ^ b) ^ c == 1");
    expect(test("a ^ b ^ c == 1")).toBe("a ^ b ^ c == 1");
    expect(test("width((a + b) | move(1, 0, 0)) > 0")).toBe("width((a + b) | move(1, 0, 0)) > 0");
    // A pipeline the author put in parentheses on the right of a union keeps them: without, it reads as moving both.
    expect(test("overlap(a + (b | move(1, 0, 0)), c) == 0")).toBe("overlap(a + (b | move(1, 0, 0)), c) == 0");
    expect(test("(pts | f)[0] > 1")).toBe("(pts | f)[0] > 1");
  });
  it("parses back to the same tree for every assert and every assignment in the repo's programs", () => {
    const problems: string[] = [];
    const exprs = (body: Stmt[]): Expr[] => body.flatMap((s) => (s.type === "assert" ? [s.test] : s.type === "assign" ? [s.value] : s.type === "for" ? exprs(s.body) : []));
    let count = 0;
    for (const f of programs()) {
      for (const e of exprs(parse(readFileSync(f, "utf8")).body)) {
        count++;
        const text = exprText(e);
        let back: Expr;
        try { back = (parse(`__x = ${text}`).body[0] as { value: Expr }).value; } catch (err) { problems.push(`${f}: ${text}: ${(err as Error).message}`); continue; }
        if (tree(back) !== tree(e)) problems.push(`${f}: ${text}`);
      }
    }
    expect(count).toBeGreaterThan(1000);
    expect(problems).toEqual([]);
  });
  it("prints an assert's text with its parentheses in check's line", () => {
    const ev = run("F = 1\nstack_y = 0\nc = 0.001\nassert F * (stack_y > 0) * c < 0.005, \"rests\"");
    expect(ev.asserts[0].text).toBe("F * (stack_y > 0) * c < 0.005");
  });
});

describe("check prints a value's small numbers (round 11: a bump of 0.002 printed 0)", () => {
  it("prints the numbers in a record, a list and a number step to four significant figures", { timeout: 30000 }, () => {
    const out = cli("check", file("bump.aix", "oak_bump = {bump: 0.002, bump_scale: 0.02, seed: 3}\nwear = [0.0015, 0.25, 12.5]\ntiny = 0.0004\nm = box(1)\n"));
    expect(out).toMatch(/(^|\n)oak_bump +=  ?\{bump: 0\.002, bump_scale: 0\.02, seed: 3\}\n/);
    expect(out).toMatch(/\nwear +=  ?\[0\.0015, 0\.25, 12\.5\]\n/);
    expect(out).toMatch(/\ntiny +=  ?0\.0004\n/);
  });
});

describe("a name read before the line that assigns it (round 11: show above its steps)", () => {
  const error = (src: string): string => { try { run(src); } catch (err) { return (err as Error).message; } return "no error"; };
  it("says the name is assigned further down, and where", () => {
    expect(error("board = box(4, 0.2, 2)\nshow board + lean\nlean = box(0.3, 2, 1.5) | rotate(z=18)\n")).toBe("line 2: 'lean' is not defined yet: it is assigned on line 3, after this line; statements run in order, top to bottom");
    expect(error("a = f(1)\ndef f(x) = box(x)\n")).toBe("line 1: 'f' is not defined yet: its def is on line 2, after this line; statements run in order, top to bottom");
    expect(error("w = c.w\nc = {w: 2}\n")).toBe("line 1: 'c' is not defined yet: it is assigned on line 2, after this line; statements run in order, top to bottom");
    // A def reading a top-level name that the file assigns after the line calling it.
    expect(error("def leg(h) = box(gap, h, gap)\nl = leg(1)\ngap = 0.1\n")).toBe("line 1: 'gap' is not defined yet: it is assigned on line 3, after line 2, which calls leg(); statements run in order, top to bottom");
    // A name in a loop's body read above its assignment there.
    expect(error("for i in range(2) {\n  b = a + 1\n  a = i\n}\n")).toMatch(/^line 2: 'a' is not defined yet: it is assigned on line 3, after this line/);
  });
  it("says only 'not defined' for a name the file never assigns", () => {
    expect(error("show lean\n")).toBe("line 1: 'lean' is not defined");
  });
});

describe("a comment that holds code (round 11: a move pasted after a #)", () => {
  it("warns when a trailing comment holds | and a call of a builtin, a def or a used library's", () => {
    const w = run("pivot = [0.28, 1.27, 0.1]\neye = torus(0.05, 0.015) | rotate(z=90)   # its hole clears the ring | move(pivot[0], pivot[1], pivot[2])\n").warnings;
    expect(w).toContain("line 2: the comment holds code (| move(...)): everything after # is ignored, so it is not applied; end the comment before the code, or move the comment to the line above");
    const def = commentCodeWarnings(parse("def seat(w) = box(w)\na = box(1)  // then | seat(2)\n"));
    expect(def).toEqual(["line 2: the comment holds code (| seat(...)): everything after // is ignored, so it is not applied; end the comment before the code, or move the comment to the line above"]);
    expect(commentCodeWarnings(parse("use \"std/hardware\" as hw\na = box(1)  # | hw.nut(0.1)\n"))).toHaveLength(1);
  });
  it("says nothing of a comment on its own line, a | before a word that is no call, or a name the program does not know", () => {
    expect(commentCodeWarnings(parse("# a = box(1) | move(0, 1, 0)\na = box(1)\n"))).toEqual([]);
    expect(commentCodeWarnings(parse("a = box(1)  # the lid | the base\n"))).toEqual([]);
    expect(commentCodeWarnings(parse("a = box(1)  # | lift(2) by hand\n"))).toEqual([]);
  });
  it("fires on no program in the repo but the door's probe of this very slip", () => {
    const hits = programs().filter((f) => commentCodeWarnings(parse(readFileSync(f, "utf8"))).length > 0);
    expect(hits).toEqual(["dogfood/round-11/door_probe_eye.aix"]);
  });
});

describe("a material named in a loop (round 11: the name taken on the first iteration only)", () => {
  it("names every iteration's material, the second distinct one name_2, in the report and the GLB", () => {
    const out = mkdtempSync(join(tmpdir(), "aixle-round11-mat-"));
    try {
      const src = "stone = material(\"#77716a\", \"brick\")\nwall = box(4, 2, 0.2) | paint(stone) | move(1, 0, -0.3)\nplanks = empty()\nfor i in range(3) {\n  oak_plank = material(\"#8e6438\", \"wood\", seed=i)\n  planks = planks + (box(0.9, 2, 0.2) | paint(oak_plank) | move(i, 0, 0))\n}\nshow wall + planks\n";
      render(src, "planks.aix", out, { grid: 24, size: 64, views: [], steps: false, slices: false, turntable: false, callouts: false, obj: false, viewer: false, texture: 64 });
      const json = JSON.parse(readFileSync(join(out, "report.json"), "utf8"));
      expect([...json.materials].sort()).toEqual(["oak_plank", "oak_plank_2", "oak_plank_3", "stone"]);
      const glb = readFileSync(join(out, "model.glb"));
      const gltf = JSON.parse(glb.subarray(20, 20 + glb.readUInt32LE(12)).toString("utf8"));
      expect(gltf.materials.map((m: { name: string }) => m.name).sort()).toEqual(["oak_plank", "oak_plank_2", "oak_plank_3", "stone"]);
    } finally {
      rmSync(out, { recursive: true, force: true });
    }
  });
  it("names the material once outside a loop, and leaves a named one passed on as it was", () => {
    const ev = run("m = material(\"red\", \"stripes\")\nn = m\nb = box(1) | paint(n)\n");
    expect((ev.steps.find((s) => s.name === "n")!.value as { name: string }).name).toBe("m");
  });
});

describe("a def with a block body (round 11: a library part had no local names and no loops)", () => {
  const BOOK = [
    "def book(b) {",
    "  cover = box(b.w, b.h, b.d) | paint(b.color)",
    "  bands = empty()",
    "  for i in range(2) { bands = bands + (box(b.w + 0.01, 0.06, 0.02) | move(0, 0.3 + i * 0.4, b.d / 2)) }",
    "  return cover + bands",
    "}",
  ].join("\n");
  const error = (src: string): string => { try { run(src); } catch (err) { return (err as Error).message; } return "no error"; };
  it("parses to a def with its statements, the return last", () => {
    const d = parse(BOOK).body[0];
    expect(d.type).toBe("def");
    if (d.type !== "def") return;
    expect(d.body).toBeUndefined();
    expect(d.block!.map((st) => st.type)).toEqual(["assign", "assign", "for", "return"]);
    // The one-expression form stays as it was.
    const e = parse("def leg(h=1) = cylinder(0.1, h)").body[0];
    expect(e.type === "def" && e.body?.type).toBe("call");
  });
  it("runs its statements with names of its own and a loop, and returns the value", () => {
    const ev = run(`${BOOK}\nnavy = book({w: 0.3, h: 2, d: 1.5, color: "navy"})\n`);
    const v = ev.steps.find((st) => st.name === "navy")!.value as { bounds: { min: number[]; max: number[] } };
    // The cover's 0.3 and the bands' 0.31 across; the bands stand out 0.01 in front of the cover's face.
    expect(v.bounds.max[0] - v.bounds.min[0]).toBeCloseTo(0.31, 6);
    expect(v.bounds.max[2]).toBeCloseTo(0.76, 6);
    // Its names are not steps, and not seen outside the call.
    expect(ev.steps.map((st) => st.name)).toEqual(["navy"]);
    expect(error(`${BOOK}\nnavy = book({w: 0.3, h: 2, d: 1.5, color: "navy"})\nx = cover\n`)).toMatch(/^line 8: 'cover' is not defined/);
  });
  it("reads its parameters, the file's defs and constants, and keeps a step of the same name apart", () => {
    const src = "sink = 0.04\ncover = sphere(3)\ndef wide(w) = w + 2 * sink\ndef panel(w) {\n  cover = box(wide(w), 1, 0.1)\n  return cover\n}\np = panel(1)\nshow p\n";
    const ev = run(src);
    const p = ev.steps.find((st) => st.name === "p")!.value as { bounds: { min: number[]; max: number[] } };
    expect(p.bounds.max[0] - p.bounds.min[0]).toBeCloseTo(1.08, 6);
    // The step called cover is not what the def's own cover is: it is unused, and p does not read it.
    expect(ev.roles.has("cover")).toBe(false);
    expect([...ev.steps.find((st) => st.name === "p")!.deps]).toEqual(["sink"]);
    expect(ev.warnings.join("\n")).toMatch(/'cover' \(line 2\) is not part of the output/);
  });
  it("recurses as an expression-bodied def does: into the depth guard, since nothing can stop it", () => {
    expect(error("def stack(n) {\n  one = box(1, 0.2, 1)\n  rest = stack(n - 1) | move(0, 0.2, 0)\n  return one + rest\n}\nt = stack(3)\n")).toMatch(/^line 3: 'stack' recursed more than 64 deep/);
    expect(error("def stack(n) = box(1) + stack(n - 1)\nt = stack(3)\n")).toMatch(/^line 1: 'stack' recursed more than 64 deep/);
  });
  it("judges an assert in its body on every call, naming the call's line", () => {
    const ev = run(`def book(b) {\n  cover = box(b.w, b.h, b.d)\n  assert width(cover) < 0.5, "a book is thin"\n  return cover\n}\na = book({w: 0.3, h: 2, d: 1})\nb = book({w: 0.6, h: 2, d: 1})\n`);
    expect(ev.asserts.map((a) => [a.line, a.call?.line, a.passed])).toEqual([[3, 6, true], [3, 7, false]]);
    expect(assertLine(ev.asserts[1])).toBe("assert (line 3, in book() called on line 7) fails: width(cover) < 0.5 is 0.6 < 0.5: a book is thin");
    expect(assertPassLine(ev.asserts[0])).toBe("assert (line 3, in book() called on line 6) holds: width(cover) < 0.5 is 0.3 < 0.5: a book is thin");
  });
  it("says what is wrong with a body that does not end with its return, or holds what belongs at the top", () => {
    expect(error("def f(x) {\n  a = box(x)\n  a + sphere(1)\n}\n")).toBe("line 3: def f (line 1): its body ends on a value with no return; write return a + sphere(1)");
    expect(error("def f(x) {\n  a = box(x)\n}\n")).toBe("line 2: def f (line 1): its body ends without a return; end it with return and the value the def makes (return a)");
    expect(error("def f(x) {\n  return box(x)\n  a = 1\n}\n")).toBe("line 3: def f (line 1): the return on line 2 must end the body, but line 3 follows it");
    expect(error("def f(x) {\n  for i in range(2) {\n    return box(i)\n  }\n  return box(x)\n}\n")).toMatch(/^line 3: def f \(line 1\): the return on line 3 is inside a for loop/);
    for (const kw of ["show box(x)", "set grid 64", "use \"std/hardware\"", "def g(y) = y", "scene box(x)"])
      expect(error(`def f(x) {\n  ${kw}\n  return box(x)\n}\n`)).toMatch(new RegExp(`^line 2: def f \\(line 1\\): ${kw.split(" ")[0]} belongs at the top level`));
    expect(error("def f(x) {\n  a = box(x)\n  box(2)\n  return a\n}\n")).toBe("line 3: def f (line 1): line 3 computes a value and drops it; a def's body names its values (part = ...) and ends with return");
    expect(error("return box(1)\n")).toMatch(/^line 1: return ends a def's block body/);
    expect(error("def f(x) {\n  return box(x)\n")).toBe("line 1: the body of def f opened on line 1 is never closed: missing '}'");
    expect(error("def f(x) {w: 1}\n")).toMatch(/a body in braces is statements; for a def that makes a record, write def f\(\.\.\.\) = \{w: \.\.\.\}/);
  });
  it("is laid out by fmt, the body two in, and the layout is idempotent and keeps the meaning", () => {
    const messy = "def book(b) {\ncover = box(b.w,b.h, b.d)|paint(b.color)\n    bands = empty()\n for i in range(2) {\nbands = bands + box(1)\n}\n      return(cover + bands)\n  }\ndef f(x) {  return box(x)  }\n";
    const once = format(messy);
    expect(once).toBe("def book(b) {\n  cover = box(b.w,b.h, b.d) | paint(b.color)\n  bands = empty()\n  for i in range(2) {\n    bands = bands + box(1)\n  }\n  return (cover + bands)\n}\ndef f(x) { return box(x) }\n");
    expect(format(once)).toBe(once);
    const meaning = (src: string) => JSON.stringify(parse(src).body, (k, v) => (k === "line" ? undefined : v));
    expect(meaning(once)).toBe(meaning(messy));
  });
});

describe("a library's def with a block body", () => {
  const libs: Record<string, string> = {
    "books.aix": [
      "# books",
      "book_default = {w: 0.35, h: 2.2, d: 1.7}",
      "# A book standing on y = 0.",
      "def book(b) {",
      "  cover = box(b.w, b.h, b.d) | move(0, b.h / 2, 0)",
      "  assert tall(cover) > 0.5, \"a book stands at least half a unit\"",
      "  return cover",
      "}",
    ].join("\n"),
  };
  const resolve = (path: string) => ({ source: libs[path] ?? libs[`${path}.aix`], file: path });
  const ev = (src: string) => evaluate(parse(src), { resolveModule: resolve });
  it("says an assert in its body is the library's line, called from the program's", () => {
    const e = ev('use "books"\na = books.book({w: 0.3, h: 0.3, d: 1.5})\nb = books.book(books.book_default)\nshow a + b\n');
    expect(e.asserts.filter((a) => !a.passed).map(assertLine)).toEqual(["books: assert (line 6, in book() called on line 2) fails: tall(cover) > 0.5 is 0.3 > 0.5: a book stands at least half a unit"]);
  });
  it("leaves a caller's step that shares a parameter's name out of what a call reads (a library's names are its own)", () => {
    const e = ev('use "books"\na = books.book({w: 0.3, h: 2, d: 1.5})\nb = books.book(books.book_default) | move(1, 0, 0)\nshow a + b\n');
    expect([...e.steps.find((st) => st.name === "a")!.deps]).not.toContain("b");
  });
});

describe("a loop's own names and named() (round 11: BK on the steps sheet, a loop counter exported)", () => {
  const SHELF = [
    "stud = sphere(0.1)",
    "books = empty()",
    "n = 0",
    "for i in range(3) {",
    "  board = box(3, 0.1, 1) | move(i * 4, 0, 0)",
    "  bk = box(0.3, 2, 1) | move(i * 4, 1.05, 0)",
    "  knob = stud | move(i * 4, 2.1, 0)",
    "  assert clearance(bk, board) > -0.01, \"on its board\"",
    "  books = books + bk + knob + board",
    "  n = n + 1",
    "}",
    "show books",
  ].join("\n");
  it("keeps a name first assigned inside a loop off the steps, the warnings and the roles' table of steps", () => {
    const ev = run(SHELF);
    expect(ev.steps.map((st) => st.name)).toEqual(["stud", "books", "n"]);
    expect(ev.warnings).toEqual([]);
    // stud is read only through the loop's own knob, and is still a part of the output; n, an accumulator, a step.
    expect(ev.roles.get("stud")).toBe("part");
    expect(ev.steps.find((st) => st.name === "n")!.value).toBe(3);
    // Its last value can still be read below the loop.
    expect(run(`${SHELF}\nlast = bk\n`).steps.map((st) => st.name)).toEqual(["stud", "books", "n", "last"]);
  });
  it("keeps a loop's own names out of a library's exports", () => {
    const lib = "for i in range(1, 3) {\n  a = i * 22.5\n}\nlean = 65\ndef seat(w) = box(w)\n";
    const e = evaluate(parse('use "stand"\nx = stand.lean\n'), { resolveModule: () => ({ source: lib, file: "stand.aix" }) });
    expect(e.modules[0].names).toEqual(["lean", "seat"]);
  });
  it("gives a loop's copy a step of its own with named(), readable below the loop, a part of the output", () => {
    const src = SHELF.replace("books = books + bk + knob + board", "books = books + named(\"book_\" + i, bk) + knob + board") + "\nset slice book_1\nprobe = book_1 | move(0, 0, 0)\nassert clearance(probe, books) < 0.01\n";
    const ev = run(src);
    expect(ev.steps.map((st) => st.name)).toEqual(["stud", "books", "n", "book_0", "book_1", "book_2", "probe"]);
    const b1 = ev.steps.find((st) => st.name === "book_1")!;
    expect(b1.line).toBe(9);
    expect((b1.value as { bounds: { min: number[] } }).bounds.min[0]).toBeCloseTo(3.85, 6);
    expect(ev.roles.get("book_1")).toBe("part");
    expect(ev.warnings).toEqual([]);
  });
  it("refuses a name twice, a name that is no name, and a name the program already has", () => {
    const error = (src: string): string => { try { run(src); } catch (err) { return (err as Error).message; } return "no error"; };
    expect(error("all = empty()\nfor i in range(2) {\n  all = all + named(\"book\", box(1))\n}\n")).toBe("line 3: named(\"book\"): 'book' is already a step (line 3); each named() makes a step of its own, so build the name from the loop's index, named(\"book_\" + i, ...)");
    expect(error("a = named(\"book 3\", box(1))\n")).toMatch(/named\(\): "book 3" is not a name/);
    expect(error("a = named(\"box\", box(1))\n")).toMatch(/named\("box"\): box is a builtin/);
    expect(error("w = 2\na = named(\"w\", box(1))\n")).toMatch(/named\("w"\): 'w' is already a step \(line 1\)/);
    expect(error("a = named(3, box(1))\n")).toMatch(/named\(\): name: expected a string, got the number 3/);
  });
  it("warns about a named step that is not part of the output, as about any step", () => {
    const ev = run("for i in range(2) {\n  p = named(\"peg_\" + i, box(1) | move(i * 2, 0, 0))\n}\nm = sphere(1)\nshow m\n");
    expect(ev.warnings).toEqual(["'peg_0' (line 2) is not part of the output; add it to the model or remove it", "'peg_1' (line 2) is not part of the output; add it to the model or remove it"]);
  });
});
