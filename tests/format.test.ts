import { describe, expect, it } from "vitest";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { format } from "../src/lang/format.js";
import { parse } from "../src/lang/parser.js";
import { tokenize } from "../src/lang/lexer.js";

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

/** The syntax tree without positions: what the program means. */
const meaning = (source: string): string =>
  JSON.stringify(parse(source).body, (k, v) => (k === "line" ? undefined : v));
/** Every token as written, numbers and strings included, in order. */
const spelled = (source: string): string[] => tokenize(source).filter((t) => t.type !== "newline").map((t) => source.slice(t.start, t.end));
/** Every comment's text, in order. */
function comments(source: string): string[] {
  const out: string[] = [];
  let prev = 0;
  for (const t of tokenize(source)) {
    for (const m of source.slice(prev, t.start).matchAll(/(#|\/\/)[^\n]*/g)) out.push(m[0].trimEnd());
    prev = Math.max(prev, t.end);
  }
  return out;
}

describe("aixle fmt over every program in the repo", () => {
  const files = programs();
  it("finds the programs", () => {
    expect(files.length).toBeGreaterThan(100);
  });
  it("is idempotent, keeps the meaning, every token as written and every comment in order", () => {
    const problems: string[] = [];
    for (const f of files) {
      const src = readFileSync(f, "utf8");
      const once = format(src);
      if (format(once) !== once) problems.push(`${f}: not idempotent`);
      if (meaning(once) !== meaning(src)) problems.push(`${f}: the syntax tree changed`);
      if (spelled(once).join("\u0001") !== spelled(src).join("\u0001")) problems.push(`${f}: a token changed`);
      if (comments(once).join("\n") !== comments(src).join("\n")) problems.push(`${f}: a comment was lost or moved out of order`);
      // No line is joined or split: the lines with something on them are the same in number.
      const filled = (s: string) => s.split("\n").filter((l) => l.trim()).length;
      if (filled(once) !== filled(src)) problems.push(`${f}: lines were joined or split`);
    }
    expect(problems).toEqual([]);
  });
  it("is idempotent on every program re-indented and respaced at random, and keeps its meaning", () => {
    // The corpus is laid out by people with steady hands; a program with a stray indent or a padded name lines
    // things up by accident, and a second run of fmt must agree with the first all the same.
    let seed = 7;
    const rnd = () => ((seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff);
    const problems: string[] = [];
    for (const f of files) {
      const src = readFileSync(f, "utf8");
      let messy = "", prev = 0;
      for (const t of tokenize(src).filter((t) => t.type !== "newline" && t.type !== "eof")) {
        const gap = src.slice(prev, t.start);
        if (gap.includes("\n")) messy += gap.split("\n").map((s, i) => (i === 0 ? s : " ".repeat(Math.floor(rnd() * 6)) + s.trimStart())).join("\n");
        else messy += gap.length ? " ".repeat(1 + Math.floor(rnd() * 4)) : "";
        messy += src.slice(t.start, t.end);
        prev = t.end;
      }
      messy += src.slice(prev);
      const once = format(messy);
      if (format(once) !== once) problems.push(`${f}: not idempotent`);
      if (meaning(once) !== meaning(src)) problems.push(`${f}: the syntax tree changed`);
    }
    expect(problems).toEqual([]);
  });
});

describe("aixle fmt's layout", () => {
  it("spaces operators, |, = and keywords; tightens named arguments, unary minus, calls and brackets", () => {
    expect(format("a=box(1, 2, 3)|move( 1 , 2, 3 )|rotate(x = -15)\n")).toBe("a = box(1, 2, 3) | move(1, 2, 3) | rotate(x=-15)\n");
    expect(format("def f( x , y = 2 )=x*y-(  -x )^2\n")).toBe("def f(x, y=2) = x * y - (-x) ^ 2\n");
    expect(format("b = a  -  -1\nc = pts[ len(pts)-1 ][0]\nset light_azimuth -40\nshow  a\n")).toBe("b = a - -1\nc = pts[len(pts) - 1][0]\nset light_azimuth -40\nshow a\n");
    expect(format('use "std/furniture"  as  f\nassert width(m)<5 , "fits", pose = open\n')).toBe('use "std/furniture" as f\nassert width(m) < 5, "fits", pose=open\n');
  });
  it("prints numbers and strings exactly as written", () => {
    expect(format("a = [0.50, 1e3, .5, 2.0]\nb = 'single'\n")).toBe("a = [0.50, 1e3, .5, 2.0]\nb = 'single'\n");
  });
  it("keeps the space after a comma as written, so points stay x,y,z and a table of numbers stays lined up", () => {
    expect(format("p = polygon(0,0, 1.5,0,   1.5,0.14)\n")).toBe("p = polygon(0,0, 1.5,0,   1.5,0.14)\n");
    expect(format("q = [1 ,2 , 3]\n")).toBe("q = [1,2, 3]\n");
  });
  it("lays out records: none inside the braces, one after the colon, a spread tight to its record", () => {
    expect(format("p = {  x:1, y : [1, 2], ...{z: 3} }\nq = p.x+ legs[0].y\n")).toBe("p = {x: 1, y: [1, 2], ...{z: 3}}\nq = p.x + legs[0].y\n");
  });
  it("indents loop bodies two spaces, keeps a one-line body on its line, and closes the brace at the loop", () => {
    expect(format("for i in range( 3 ){\nc = f(i)\n    for j in [1] {\n d = j }\n    }\nfor i in [p] {  r = i  }\n")).toBe(
      "for i in range(3) {\n  c = f(i)\n  for j in [1] {\n    d = j }\n}\nfor i in [p] { r = i }\n",
    );
  });
  it("keeps a broken line broken: a hanging indent two in from its bracket's line, an aligned argument under its first", () => {
    expect(format("wall = polygon(\n0,0, 1,0,\n      1,1\n    )\n")).toBe("wall = polygon(\n  0,0, 1,0,\n  1,1\n)\n");
    // Lined up under the first argument, which the formatting moved two columns right.
    expect(format("x=union(a,\n        b, k = 0.2)\n  | move(0, 1, 0)\n")).toBe("x = union(a,\n          b, k=0.2)\n  | move(0, 1, 0)\n");
    // An operator lined up under the `=` stays there; one lined up under nothing is a hanging indent.
    expect(format("spots = sphere(1)\n      + sphere(2)\ndef part(r) =\n  cylinder(r, 1)\n     + sphere(r)\n")).toBe("spots = sphere(1)\n      + sphere(2)\ndef part(r) =\n  cylinder(r, 1)\n  + sphere(r)\n");
    expect(format("p = {\nx: 1,\n   y: 2,\n  }\n")).toBe("p = {\n  x: 1,\n  y: 2,\n}\n");
  });
  it("keeps a column of = or of record values that the author lined up, and nothing else", () => {
    expect(format("post_front = a\npost_back  = b\nx  = 1\n\ny   = 2\n")).toBe("post_front = a\npost_back  = b\nx = 1\n\ny = 2\n");
    expect(format("q = {\n  w:   1,\n  hh:  2,\n  d:    3,\n}\n")).toBe("q = {\n  w:   1,\n  hh:  2,\n  d: 3,\n}\n");
  });
  it("settles a column on what it prints, so a second run changes nothing", () => {
    // A stray indent taken off one line of a column: the column stays where the author wrote it.
    expect(format("width  = 2\n depth = 1\n")).toBe("width  = 2\ndepth  = 1\n");
    // A table of records on continuation lines keeps the column its values were padded into.
    expect(format("legs = [{x: 0.38, z:  0.33},\n        {x: -0.38, z: 0.33}]\n")).toBe("legs = [{x: 0.38, z:  0.33},\n        {x: -0.38, z: 0.33}]\n");
    // A def's head respaced shorter stays in the column the author lined it up in.
    expect(format("def leg( h ) = cylinder(0.1, h)\nheight       = 2\n")).toBe("def leg(h)   = cylinder(0.1, h)\nheight       = 2\n");
    // Code that now reaches past the column pushes the whole column right, rather than leaving one line out of it.
    expect(format("for i in a+b { x = 1 }\ny                = 2\n")).toBe("for i in a + b { x = 1 }\ny                  = 2\n");
    // A one-line loop's body, and a record's second value lined up with the entry above.
    expect(format("x                 = 1\nfor i in [1] {  a = 2 }\n")).toBe("x                 = 1\nfor i in [1] { a  = 2 }\n");
    expect(format("p = {\n  a:            1,\n  b: f( 1 ), c: 2,\n}\n")).toBe("p = {\n  a:            1,\n  b: f(1), c:   2,\n}\n");
    for (const src of ["width  = 2\n depth = 1\n", "def leg( h ) = cylinder(0.1, h)\nheight       = 2\n", "x                 = 1\nfor i in [1] {  a = 2 }\n", "p = {\n  a:            1,\n  b: f( 1 ), c: 2,\n}\n"])
      expect(format(format(src))).toBe(format(src));
  });
  it("keeps a lone carriage return as it was, so what follows one in a comment stays in the comment", () => {
    expect(format("a = 1 # x\rb = 2\n")).toBe("a = 1  # x\rb = 2\n");
    expect(format("a = 1\r\nb = 2\r\n")).toBe("a = 1\nb = 2\n");
  });
  it("keeps one blank line where there were several, none at either end, and every comment in its place", () => {
    const src = "\n\n# header\n\n\n\na = 1   # one\nb = 2# two\n\n\n  # about c\nc = 3\nfor i in [1] {\n  d = i\n\n    # last in the loop\n}\n// the end\n\n\n";
    expect(format(src)).toBe("# header\n\na = 1   # one\nb = 2  # two\n\n# about c\nc = 3\nfor i in [1] {\n  d = i\n\n  # last in the loop\n}\n// the end\n");
  });
  it("keeps a trailing comment's column as its line moves, and pushes it out only when the code reaches it", () => {
    expect(format("for i in [1] {\nabc = 1      # a\nd = 22222222 # b\n}\n")).toBe("for i in [1] {\n  abc = 1      # a\n  d = 22222222  # b\n}\n");
  });
  it("refuses a program that does not parse, and accepts one with nothing but comments", () => {
    expect(() => format("a = (1\n")).toThrow(/line/);
    expect(format("\n# only a comment\n\n")).toBe("# only a comment\n");
    expect(format("")).toBe("");
  });
});
