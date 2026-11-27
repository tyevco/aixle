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
  it("check --brief names a library by its count, keeps a near-thin note on the warnings' line, and prints a loop's promise once", { timeout: 60000 }, () => {
    let out = "";
    try {
      cli("check", "tests/fixtures/brief_loop.aix", "--brief");
    } catch (e) {
      out = (e as { stdout: string }).stdout;
      expect((e as { status: number }).status).toBe(1);
    }
    // Round 11: a library's 24 names opened every brief check; the full check keeps the list.
    expect(out).toMatch(/^use lib {12}brief_lib: 3 names \(check without --brief lists them\)\n/);
    // Round 11: "no warnings" read as the verdict, and the note on the line under it went unread.
    expect(out).toMatch(/\nno warnings; note: Parts between 1\.2 and 2 cells thick mesh but often not watertight: 'cup' \(1\.6 cells\)/);
    // One line for the passes of a promise judged three times, then the failure in full, above the count.
    expect(out).toMatch(/\nassert \(line 7\) holds 2 of 3 times: tall\(peg\) < 1\.15, nearest to failing 1\.1 < 1\.15: peg 1 is short enough\nassert \(line 7\) fails: tall\(peg\) < 1\.15 is 1\.2 < 1\.15: peg 2 is short enough\nasserts: 2 pass, 1 fail\n$/);
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

describe("printing", () => {
  it("check prints the size in millimetres and the bed's verdict when a program sets units or a bed", { timeout: 30000 }, () => {
    const out = cli("check", "tests/fixtures/print_bed.aix");
    expect(out).toMatch(/\nprint: units cm: one unit is a centimetre \(10 mm\); 50 × 50 × 50 mm \(x and z on the plate, y up\); does not fit the 30 × 30 × 30 mm bed whichever way it lies \(50 wide for 30, 50 deep for 30, 50 tall for 30\)/);
    expect(out).toMatch(/\nwarning: The model is 50 × 50 × 50 mm and does not fit the 30 × 30 × 30 mm bed/);
    // A program that says nothing about printing gets no print line.
    expect(cli("check", "examples/mug.aix")).not.toMatch(/^print:/m);
  });
  it("check judges the outline turned, as the render does, where the box would not fit", { timeout: 30000 }, () => {
    // The box of a bar across the diagonal fits only lying down; check warned so while the render said it fits turned.
    const out = cli("check", "tests/fixtures/print_turned.aix");
    expect(out).toMatch(/\nprint: .*does not fit the 200 × 200 × 200 mm bed square \([\d.]+ wide for 200\); turned (\d+)° about the vertical on the plate \(as rotate\(y=\1\) turns it/);
    expect(out).toMatch(/\nno warnings\n/);
  });
});

describe("the import cache", () => {
  it("check samples an import once and reads it back after, unless --no-cache", { timeout: 60000 }, async () => {
    const { mkdtempSync, readdirSync, rmSync } = await import("node:fs");
    const { tmpdir } = await import("node:os");
    const { join } = await import("node:path");
    const dir = mkdtempSync(join(tmpdir(), "aixle-cache-"));
    try {
      const run = (...args: string[]) => execFileSync("npx", ["tsx", "src/cli.ts", ...args], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], env: { ...process.env, AIXLE_CACHE_DIR: dir } });
      expect(run("check", "examples/garden.aix", "--brief")).toMatch(/import assets\/rock.obj: 4440 triangles sampled at cell [\d.]+ in \d+ ms; cached in /);
      expect(readdirSync(dir).filter((f) => f.endsWith(".samples")).length).toBe(1);
      expect(run("check", "examples/garden.aix", "--brief")).toMatch(/import assets\/rock.obj: 4440 triangles at cell [\d.]+, read from the cache in \d+ ms/);
      const fresh = run("check", "examples/garden.aix", "--brief", "--no-cache");
      expect(fresh).toMatch(/import assets\/rock.obj: 4440 triangles sampled at cell [\d.]+ in \d+ ms\n/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
