import { describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { exprText, type Expr, type Stmt } from "../src/lang/ast.js";
import { parse } from "../src/lang/parser.js";
import { commentCodeWarnings, evaluate } from "../src/lang/interpreter.js";

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
