import { describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { exprText, type Expr, type Stmt } from "../src/lang/ast.js";
import { parse } from "../src/lang/parser.js";
import { evaluate } from "../src/lang/interpreter.js";

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
