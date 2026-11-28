import { describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
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
    expect(failed).toMatch(/assert \(line 4\) fails: pieces\(a \+ b\) == 1 is 2 == 1, the smallest piece is [\d.]+ cubic units at \([-\d., ]+\) in 'b'\n/);
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
  it("prints one entry of the reference by name, and the nearest names for one it lacks", { timeout: 60000 }, () => {
    const sweep = cli("doc", "sweep");
    expect(sweep).toMatch(/^## Paths\n\n### sweep\n\nA 2D profile carried along a path/);
    expect(sweep).toMatch(/\n    sweep\(profile, points, smooth=0, twist=0, taper=1\) -> shape\n    sweep\(profile, curve, twist=0, taper=1\) -> shape\n/);
    expect(sweep).toMatch(/\n- `points`: a flat list/);
    expect(sweep).not.toMatch(/### tube|# Aixle reference/);
    // A section the reference writes by hand, a setting by its name, a preset's row, and several at once.
    expect(cli("doc", "joint")).toMatch(/^## Poses and animation\n\n### joint\n\nMake a part turn about a pivot/);
    expect(cli("doc", "environment")).toMatch(/^## Lights, cameras and environments\n\n### set environment\n/);
    expect(cli("doc", "oak")).toMatch(/### oak\n[\s\S]*\n\| oak \| wood \|/);
    const two = cli("doc", "box", "Sphere");
    expect(two).toMatch(/### box\n[\s\S]*\n## 3D primitives\n\n### sphere\n/);
    // A misspelt name fails, with the names it is nearest, and the names found are still printed.
    let err = "", out = "", status = 0;
    try { execFileSync("npx", ["tsx", "src/cli.ts", "doc", "cylnder", "tube"], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }); } catch (e) { const x = e as { stderr: string; stdout: string; status: number }; err = x.stderr; out = x.stdout; status = x.status; }
    expect(status).toBe(1);
    expect(err).toMatch(/no entry named 'cylnder' in the reference; the nearest: cylinder/);
    expect(out).toMatch(/^## Paths\n\n### tube\n/);
    // With no name it is the whole reference, as committed.
    expect(cli("doc")).toBe(readFileSync("docs/reference.md", "utf8"));
  });
  it("documents a library from its defs and comments, and check lists what a program uses", { timeout: 60000 }, () => {
    const doc = cli("doc", "std/hardware.aix");
    expect(doc).toMatch(/^# hardware\n\nstd\/hardware: bolts, nuts/);
    expect(doc).toMatch(/## hex_bolt\(r=0\.1, len=0\.6\)\n\nA hex-head bolt/);
    expect(doc).toMatch(/## Constants\n\n- `steel = material\("steel", rough=0\.4\)`\n- `zinc = material\("#b8bcc2", metal=0\.9, rough=0\.5\)`/);
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
  it("prints the program in the one layout, rewrites with --write, and fails --check with the lines that differ", { timeout: 60000 }, () => {
    const dir = mkdtempSync(join(tmpdir(), "aixle-fmt-"));
    const file = join(dir, "messy.aix");
    writeFileSync(file, "a=box(1,2, 3)|move( 0 , 1, 0 )   # up\nshow a\n");
    const tidy = "a = box(1,2, 3) | move(0, 1, 0)  # up\nshow a\n";
    expect(cli("fmt", file)).toBe(tidy);
    // An already formatted program passes --check with a word, so a pass is not taken for a skipped file (round 11).
    expect(cli("fmt", "--check", "examples/mug.aix")).toBe("examples/mug.aix: formatted\n");
    let failed = "";
    try {
      cli("fmt", "--check", file, "examples/mug.aix");
    } catch (e) {
      failed = (e as { stdout: string; status: number }).stdout;
      expect((e as { status: number }).status).toBe(1);
    }
    // The line that differs, as it is and as fmt writes it (round 11: "not formatted" alone cost a diff by hand).
    expect(failed).toBe(`${file}: not formatted, 1 line differs; aixle fmt --write ${file}\n  line 1 is:  "a=box(1,2, 3)|move( 0 , 1, 0 )   # up"\n  fmt writes: "a = box(1,2, 3) | move(0, 1, 0)  # up"\nexamples/mug.aix: formatted\n`);
    expect(cli("fmt", "--write", file)).toBe(`formatted ${file}\n`);
    expect(readFileSync(file, "utf8")).toBe(tidy);
    expect(cli("fmt", "--check", file)).toBe(`${file}: formatted\n`);
    expect(cli("fmt", "--write", file)).toBe(`${file}: already formatted\n`);
  });
});

describe("check in a pose", () => {
  it("keeps the warnings a promise at rest raised, though the pose does not judge it again", { timeout: 30000 }, () => {
    // A void() whose probe is nowhere near the shape is warned about as it is judged; judged at rest only, its warning
    // went missing from check --pose, which prints the posed evaluation's warnings.
    const dir = mkdtempSync(join(tmpdir(), "aixle-pose-"));
    const file = join(dir, "far.aix");
    writeFileSync(file, 'body = box(1)\nfar = sphere(0.1) | move(0, 5, 0)\nlid = joint(box(1, 0.1, 1) | move(0, 0.55, 0), "lid", 0, 0.5, 0.5)\npose("open", lid=[-60, 0, 0])\nassert void(far, body)\nshow body + lid\n');
    for (const out of [cli("check", file, "--brief"), cli("check", file, "--brief", "--pose", "open")]) {
      expect(out).toMatch(/\nwarning: line 5: void\(far, body\) holds trivially: their boxes are 4\.4 apart/);
      expect(out).not.toMatch(/\nno warnings/);
    }
  });
  it("prints a posed line for a step assigned twice, and for a union a larger union flattened", { timeout: 30000 }, () => {
    const out = cli("check", "tests/fixtures/posed_lines.aix", "--pose", "up");
    // Round 11: the mixer's agent missed a posed line under a step assigned twice, while the asserts measured it posed.
    expect(out).toMatch(/\nshell {14}1 × 0\.6 × 2 .*\n {2}posed shell {6}1 × 2\.03 × 1\.52 {6}x -0\.5\.\.0\.5 {2}y 1\.\.3\.03 {2}z -1\.52\.\.0\n/);
    expect(out).toMatch(/\nhinged .*\n {2}posed hinged {5}1 × 2\.18 × 1\.52 /);
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

describe("render --show", () => {
  it("fails on a name that is no shape step, naming the shapes", { timeout: 30000 }, () => {
    const dir = mkdtempSync(join(tmpdir(), "aixle-show-"));
    const file = join(dir, "s.aix");
    writeFileSync(file, "stand = box(2, 0.2, 1)\nprobe = box(0.5, 0.5, 0.5) | move(0, 0.45, 0)\nshow stand\n");
    let err = "", status = 0;
    try {
      cli("render", file, "--quick", "--show", "prob", "--out", join(dir, "out"));
    } catch (e) {
      err = (e as { stderr: string }).stderr;
      status = (e as { status: number }).status;
    }
    expect(status).toBe(1);
    expect(err).toMatch(/s\.aix: --show prob: no such step; the shapes are stand, probe\n/);
  });
});

describe("--quality", () => {
  it("takes draft or full, draft with --quick --beauty, and refuses anything else", { timeout: 60000 }, () => {
    const dir = mkdtempSync(join(tmpdir(), "aixle-quality-"));
    const file = join(dir, "q.aix");
    writeFileSync(file, 'ball = sphere(0.4) | move(-0.5, 0.4, 0) | paint("chrome")\nblock = box(0.6, 0.8, 0.6) | move(0.5, 0.4, 0)\nshow ball + block\n');
    const beautyLine = (...args: string[]) => cli("render", file, "--out", join(dir, "out"), "--size", "64", "--grid", "16", "--threads", "1", ...args).split("\n").find((l) => l.startsWith("beauty render"));
    expect(beautyLine("--beauty-only", "--quality", "draft")).toMatch(/^beauty render 64px, draft, 1 thread, in [\d.]+ s$/);
    expect(beautyLine("--quick", "--beauty")).toMatch(/^beauty render 64px, draft, /);
    expect(beautyLine("--quick", "--beauty", "--quality", "full")).toMatch(/^beauty render 64px, full, /);
    let err = "", status = 0;
    try {
      cli("render", file, "--out", join(dir, "out"), "--quality", "best");
    } catch (e) {
      err = (e as { stderr: string }).stderr;
      status = (e as { status: number }).status;
    }
    rmSync(dir, { recursive: true, force: true });
    expect(status).toBe(2);
    expect(err).toMatch(/^--quality best: the quality is draft or full$/m);
  });
});
