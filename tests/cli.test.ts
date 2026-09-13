import { describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";

const cli = (...args: string[]) => execFileSync("npx", ["tsx", "src/cli.ts", ...args], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });

describe("aixle explain", () => {
  it("prints the program as a tree from the output down, with each step's source line, size and anchors", () => {
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

describe("libraries", () => {
  it("documents a library from its defs and comments, and check lists what a program uses", () => {
    const doc = cli("doc", "std/hardware.aix");
    expect(doc).toMatch(/^# hardware\n\nstd\/hardware: bolts, nuts/);
    expect(doc).toMatch(/## hex_bolt\(r=0\.1, len=0\.6\)\n\nA hex-head bolt/);
    expect(doc).toMatch(/Constants: steel, zinc/);
    const check = cli("check", "examples/workshop.aix");
    expect(check).toMatch(/^use f {14}std\/furniture: oak, walnut, table, chair, stool, bench, bench_end, shelf/m);
    expect(check).toMatch(/no warnings/);
    // Each shipped library renders on its own: its plate is its test.
    for (const lib of ["hardware", "furniture", "plants"]) expect(cli("check", `std/${lib}.aix`)).toMatch(/^output: /m);
  });
});
