import { describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";

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
});

describe("asserts", () => {
  it("check prints each failed assert with its numbers and exits with a failure; a passing program says so", { timeout: 60000 }, () => {
    const out = cli("check", "examples/table.aix");
    expect(out).toMatch(/\nasserts: 3 pass\n$/);
    let failed = "";
    try {
      cli("check", "tests/fixtures/broken_promise.aix");
    } catch (e) {
      failed = (e as { stdout: string; status: number }).stdout;
      expect((e as { status: number }).status).toBe(1);
    }
    expect(failed).toMatch(/assert \(line 3\) fails: clearance\(a, b\) > 0.5 is 0.2 > 0.5: apart\n/);
    expect(failed).toMatch(/assert \(line 4\) fails: pieces\(a \+ b\) == 1 is 2 == 1\n/);
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
    const arm = cli("check", "examples/arm.aix");
    expect(arm).toMatch(/^joints:\n  \w+ at \(/m);
    const check = cli("check", "examples/workshop.aix");
    expect(check).toMatch(/^use f {14}std\/furniture: oak, walnut, table, chair, stool, bench, bench_end, shelf/m);
    expect(check).toMatch(/no warnings/);
    // Each shipped library renders on its own: its plate is its test.
    for (const lib of ["hardware", "furniture", "plants"]) expect(cli("check", `std/${lib}.aix`)).toMatch(/^output: /m);
  });
});
