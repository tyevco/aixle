import { describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const cli = (...args: string[]) => execFileSync("npx", ["tsx", "src/cli.ts", ...args], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });

describe("aixle explain", () => {
  it("prints the program as a tree from the output down, with each step's source line, size and anchors", { timeout: 30000 }, () => {
    const out = cli("explain", "examples/windmill.aix");
    const lines = out.split("\n");
    expect(lines[0]).toMatch(/^windmill \(line \d+\)  [\d.]+ × [\d.]+ × [\d.]+  painted  anchors: crown/);
    expect(lines[1]).toMatch(/^    = \(tower \+ cap_on \+ rotor \+ door_on \+ step\) \| ground\(\)/);
    // A child is indented under its parent, a repeated step is not printed twice, a number step shows its value.
    expect(out).toMatch(/\n  cap_on \(line \d+\)[^\n]*anchors: seat, hub\n      = cap \| attach\("seat", tower, "crown"\)/);
    expect(out).toMatch(/\n    tower \(see above\)/);
    expect(out).toMatch(/hub_pt \(line \d+\)  = \[0, 6\.85, 1\.6\]/);
    expect(out).toMatch(/joint "rotor" at \(0, 6\.85, 1\.6\)/);
    expect(out).toMatch(/\nposes: quarter/);
  });
  it("explains an output that is no one step: a record's field, an expression, several names", { timeout: 60000 }, () => {
    const dir = mkdtempSync(join(tmpdir(), "aixle-explain-"));
    const write = (name: string, src: string) => { const f = join(dir, name); writeFileSync(f, src); return f; };
    const field = cli("explain", write("field.aix", "w = 2\nparts = {lid: box(w, 1, 1), cup: sphere(1)}\nshow parts.lid\n"));
    expect(field).toMatch(/^parts\.lid  2 × 1 × 1  \(shown, not a step\)\n  parts \(line 2\)  = \{lid: a shape 2 × 1 × 1, cup: a shape 2 × 2 × 2\}\n/);
    expect(field).toMatch(/\n    w \(line 1\)  = 2\n/);
    const two = cli("explain", write("two.aix", "a = box(1)\nb = sphere(1) | move(3, 0, 0)\nshow a, b\n"));
    expect(two).toMatch(/^a\+b  4\.5 × 2 × 2  \(shown, not a step\)\n  a \(line 1\)[^\n]*\n[^\n]*\n  b \(line 2\)/);
  });
});

describe("asserts", () => {
  it("check prints each failed assert with its numbers and exits with a failure; a passing program says so", { timeout: 60000 }, () => {
    const out = cli("check", "examples/table.aix");
    expect(out).toMatch(/\nasserts: 3 pass\n$/);
    // A passing promise prints its numbers too (round 8: the gap between closed fingers was only in report.json).
    expect(out).toMatch(/\nassert \(line 34\) holds: pieces\(chair\(\)\) == 1 is 1 == 1: a chair is one piece\n/);
    let failed = "";
    try {
      cli("check", "tests/fixtures/broken_promise.aix");
    } catch (e) {
      failed = (e as { stdout: string; status: number }).stdout;
      expect((e as { status: number }).status).toBe(1);
    }
    expect(failed).toMatch(/assert \(line 3\) fails: clearance\(a, b\) > 0.5 is 0.2 > 0.5, closest at \([-\d., ]+\): apart\n/);
    expect(failed).toMatch(/assert \(line 4\) fails: pieces\(a \+ b\) == 1 is 2 == 1, the smallest piece is [\d.]+ at \([-\d., ]+\)\n/);
    expect(failed).toMatch(/asserts: 1 pass, 2 fail\n$/);
  });
});

describe("libraries", () => {
  // Five CLI launches under tsx: a few seconds each on a CI runner, so this test gets its own timeout.
  it("documents a library from its defs and comments, and check lists what a program uses", { timeout: 60000 }, () => {
    const doc = cli("doc", "std/hardware.aix");
    expect(doc).toMatch(/^# hardware\n\nstd\/hardware: bolts, nuts/);
    expect(doc).toMatch(/## hex_bolt\(r=0\.1, len=0\.6\)\n\nA hex-head bolt/);
    expect(doc).toMatch(/Constants: steel, zinc/);
    // A record default is printed whole, and a default is read for its own name, not one that ends like it.
    const dir = mkdtempSync(join(tmpdir(), "aixle-doc-"));
    writeFileSync(join(dir, "seat.aix"), "# seats\nx = 1\n\n# A seat sized by a record.\ndef seat(s={w: 0.9, h: 0.45}, wh=2, h=3) = box(s.w, s.h, wh + h)\nshow seat()\n");
    expect(cli("doc", join(dir, "seat.aix"))).toMatch(/## seat\(s=\{w: 0\.9, h: 0\.45\}, wh=2, h=3\)\n\nA seat sized by a record\./);
    const arm = cli("check", "examples/arm.aix");
    expect(arm).toMatch(/^joints:\n  \w+ at \(/m);
    const check = cli("check", "examples/workshop.aix");
    expect(check).toMatch(/^use f {14}std\/furniture: oak, walnut, table, chair, stool, bench, bench_end, shelf/m);
    expect(check).toMatch(/no warnings/);
    // Each shipped library renders on its own: its plate is its test.
    for (const lib of ["hardware", "furniture", "plants"]) expect(cli("check", `std/${lib}.aix`)).toMatch(/^output: /m);
  });
});

describe("aixle fmt", () => {
  it("prints the program in the one layout, rewrites with --write, and fails --check naming the file", { timeout: 60000 }, () => {
    const dir = mkdtempSync(join(tmpdir(), "aixle-fmt-"));
    const file = join(dir, "messy.aix");
    writeFileSync(file, "a=box(1,2, 3)|move( 0 , 1, 0 )   # up\nshow a\n");
    const tidy = "a = box(1,2, 3) | move(0, 1, 0)  # up\nshow a\n";
    expect(cli("fmt", file)).toBe(tidy);
    // An already formatted program passes --check silently.
    expect(cli("fmt", "--check", "examples/mug.aix")).toBe("");
    let failed = "";
    try {
      cli("fmt", "--check", file, "examples/mug.aix");
    } catch (e) {
      failed = (e as { stdout: string; status: number }).stdout;
      expect((e as { status: number }).status).toBe(1);
    }
    expect(failed).toBe(`${file}: not formatted; aixle fmt --write ${file}\n`);
    expect(cli("fmt", "--write", file)).toBe(`formatted ${file}\n`);
    expect(readFileSync(file, "utf8")).toBe(tidy);
    expect(cli("fmt", "--check", file)).toBe("");
  });
});
