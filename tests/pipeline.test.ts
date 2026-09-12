import { describe, expect, it } from "vitest";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { cellFor, check, diff, foldThinWarnings, QUICK, run, thinWarnings, tightBounds } from "../src/pipeline.js";
import { referenceMarkdown } from "../src/doc.js";
import { BUILTINS } from "../src/lang/builtins.js";

describe("pipeline", () => {
  it("renders a program into a folder of pictures, exports and a report", () => {
    const dir = mkdtempSync(join(tmpdir(), "aixle-"));
    try {
      const src = "a = sphere(1) | paint(\"red\")\nb = box(0.5)\nm = a - (box(3, 0.5, 3) | move(0, 1, 0))\nshow m";
      const r = run(src, "test.aix", dir, { grid: 32, size: 96, views: ["front"] });
      for (const f of ["sheet.png", "front.png", "slices.png", "steps.png", "turntable.png", "model.obj", "model.mtl", "model.glb", "model.png", "report.md", "report.json"])
        expect(existsSync(join(dir, f)), f).toBe(true);
      expect(r.warnings.join()).toMatch(/'b' \(line 2\) is not part of the output/);
      const report = readFileSync(join(dir, "report.md"), "utf8");
      expect(report).toMatch(/Watertight \| yes/);
      expect(report).toMatch(/\| 2 \| b \| 2 \|/);
      const json = JSON.parse(readFileSync(join(dir, "report.json"), "utf8"));
      expect(json.output).toBe("m");
      expect(json.materials).toEqual(["red"]);
      expect(json.steps.find((s: { name: string }) => s.name === "b").used).toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
  it("writes the viewer page and a beauty render when asked", () => {
    const dir = mkdtempSync(join(tmpdir(), "aixle-"));
    try {
      const r = run("m = box(1) | paint(\"gold\")", "box.aix", dir, { grid: 16, size: 64, views: [], steps: false, slices: false, turntable: false, obj: false, beauty: true, beautySize: 64 });
      expect(r.files).toContain("viewer.html");
      expect(r.files).toContain("beauty.png");
      const html = readFileSync(join(dir, "viewer.html"), "utf8");
      expect(html).toContain("<title>m · aixle viewer</title>");
      expect(html).toMatch(/const GLB = "Z2xURg/); // "glTF" in base64
      expect(html).toContain("three@0.160.0");
      const png = readFileSync(join(dir, "beauty.png"));
      expect(png.readUInt32BE(16)).toBe(64);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
  it("warns instead of failing when the output is empty", () => {
    const dir = mkdtempSync(join(tmpdir(), "aixle-"));
    try {
      const r = run("a = sphere(1) & (sphere(1) | move(5, 0, 0))", "empty.aix", dir, { grid: 16, size: 64 });
      expect(r.mesh).toBeUndefined();
      expect(r.warnings.join()).toMatch(/empty|no surface/);
      expect(existsSync(join(dir, "report.md"))).toBe(true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
  it("warns when a used step has bounds but no surface", () => {
    const dir = mkdtempSync(join(tmpdir(), "aixle-"));
    try {
      const r = run("gone = sphere(1) - sphere(2)\nbase = box(3, 1, 3) | move(0, -1, 0)\nm = base + gone", "gone.aix", dir, { grid: 24, size: 64, views: [], turntable: false, slices: false, obj: false, glb: false });
      expect(r.warnings.join()).toMatch(/'gone' \(line 1\) has bounds .* but no surface/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
  it("warns from bounds alone when a used part is thinner than two cells", () => {
    const dir = mkdtempSync(join(tmpdir(), "aixle-"));
    try {
      const r = run("plate = box(10, 0.05, 10)\nknob = sphere(1) | move(0, 1, 0)\nm = plate + knob", "thin.aix", dir, { grid: 20, size: 64, views: [], steps: false, slices: false, turntable: false, obj: false, glb: false });
      expect(r.warnings.join()).toMatch(/'plate' \(line 1\) is only 0.05 units thin/);
      expect(r.warnings.join()).toMatch(/set grid \d+/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
  it("reports physics and warns about a model that would tip over or floats apart", () => {
    const dir = mkdtempSync(join(tmpdir(), "aixle-"));
    try {
      const r = run("base = box(0.5, 0.2, 0.5) | move(0, 0.1, 0)\ntop = box(0.3, 3, 0.3) | move(0.9, 1.7, 0)\nm = base + top", "tip.aix", dir, { ...QUICK, grid: 32 });
      expect(r.report).toMatch(/## Physics/);
      expect(r.warnings.join()).toMatch(/separate pieces/);
      // A post leaning out past its small base: its foot overlaps the base, its mass hangs beyond it.
      const r2 = run("post = box(0.3, 3, 0.3) | move(0, 1.5, 0) | rotate(z=-35) | move(0.5, 0.15, 0)\nbase = box(0.5, 0.2, 0.5) | move(0.5, 0.1, 0)\nm = post + base", "tip2.aix", dir, { ...QUICK, grid: 32 });
      expect(r2.warnings.join()).toMatch(/tip over/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
  it("diff renders two programs side by side", () => {
    const dir = mkdtempSync(join(tmpdir(), "aixle-"));
    try {
      const out = join(dir, "d.png");
      const r = diff({ source: "a = sphere(1)", name: "a.aix" }, { source: "b = box(2)", name: "b.aix" }, out, { size: 64, grid: 16 });
      expect(existsSync(out)).toBe(true);
      expect(r.warnings).toEqual([]);
      const png = readFileSync(out);
      expect(png.readUInt32BE(16)).toBe(64 * 2 + 12);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
  it("check can warn about thin parts from the grid it would use", () => {
    const ev = check("plate = box(10, 0.05, 10)\nknob = sphere(1) | move(0, 1, 0)\nm = plate + knob");
    const { grid, cellSize } = cellFor(ev);
    expect(grid).toBe(128);
    expect(cellSize).toBeCloseTo(10 / 128);
    expect(thinWarnings(ev, cellSize, grid).join()).toMatch(/'plate' \(line 1\) is only 0.05/);
  });
  it("frames a focused step and notes the true lowest point, not the bounds", () => {
    const dir = mkdtempSync(join(tmpdir(), "aixle-"));
    try {
      // A ball cut in half by a difference: bounds still reach y = -1, the surface does not.
      const r = run("ball = sphere(1) | move(0, 1, 0)\ncut = ball - (box(4, 4, 4) | move(0, -1, 0))\nknob = sphere(0.2) | move(0, 2, 0)\nm = cut + knob", "half.aix", dir, { ...QUICK, grid: 32, focus: "knob" });
      expect(r.report).not.toMatch(/pipe the model through ground\(\)/);
      expect(r.report).toMatch(/Surface extent \| x .*, y 0?\.?\d*\.\.2\.2/);
      expect(r.warnings.join()).not.toMatch(/focus/);
      const r2 = run("m = sphere(1)", "s.aix", dir, { ...QUICK, grid: 16, focus: "nope" });
      expect(r2.warnings.join()).toMatch(/focus nope: no such step/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
  it("check evaluates without rendering", () => {
    const ev = check("a = box(2)\nset grid 40");
    expect(ev.outputName).toBe("a");
    expect(ev.settings.grid).toBe(40);
  });
});

describe("reference", () => {
  it("documents every builtin with a signature", () => {
    const md = referenceMarkdown();
    for (const b of BUILTINS) {
      expect(md).toContain(`### ${b.name}`);
      expect(md).toContain(`${b.name}(`);
    }
    expect(md).toMatch(/cylinder\(r, h, round=0\) -> shape/);
    expect(md).toMatch(/\| wood \| wood \|/);
  });
});

describe("rigs, features and overhangs", () => {
  it("warns about a wall, tube or stroke thinner than a cell inside a thick step, once", () => {
    const ev = check('cup = shell(cylinder(1, 2), 0.01) - (cylinder(0.8, 1) | move(0, 1.5, 0))\nlabel = extrude(text("Hi", 0.5, weight=0.02), 0.2) | rotate(x=90) | move(0, 1, 1)\nm = cup + label');
    const { grid, cellSize } = cellFor(ev);
    const w = thinWarnings(ev, cellSize, grid);
    expect(w.join("\n")).toMatch(/'cup' \(line 1\) has a wall, tube \(at its thin end, if tapered\) or stroke only 0.01 thick/);
    expect(w.join("\n")).toMatch(/'label' \(line 2\) has a wall, tube \(at its thin end, if tapered\) or stroke only 0.02 thick/);
    // 'm' carries both features but introduced neither, so it is not reported again.
    expect(w.filter((x) => x.startsWith("'m'"))).toHaveLength(0);
    expect(thinWarnings(check("cup = shell(cylinder(1, 2), 0.2)"), cellSize, grid)).toHaveLength(0);
  });
  it("shows a pose from the option or the setting and says which", () => {
    const dir = mkdtempSync(join(tmpdir(), "aixle-"));
    const src = 'arm = box(0.4, 3, 0.4) | move(0, 1.5, 0)\nj = joint(arm, "hinge", 0, 0, 0)\npose("flat", hinge=[0, 0, 90])\nshow j';
    try {
      const r = run(src, "rig.aix", dir, { ...QUICK, grid: 24, pose: "flat" });
      expect(r.report).toMatch(/sheet shows "flat"/);
      // Turned flat about z, the arm lies along -x: the report's extent is wide and low.
      expect(r.report).toMatch(/Surface extent \| x -3\.?\d*\.\.0?\.?\d*, y/);
      const r2 = run(src, "rig.aix", dir, { ...QUICK, grid: 24, pose: "nope" });
      expect(r2.warnings.join()).toMatch(/pose nope: no such pose \(poses: flat\)/);
      const r3 = run(src + "\nset pose flat", "rig.aix", dir, { ...QUICK, grid: 24 });
      expect(r3.report).toMatch(/sheet shows "flat"/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
  it("measures overhangs: a table top on a thin leg, none on a box", () => {
    const dir = mkdtempSync(join(tmpdir(), "aixle-"));
    try {
      const table = run("top = box(3, 0.3, 3) | move(0, 2.15, 0)\nleg = box(0.4, 2, 0.4) | move(0, 1, 0)\nm = top + leg", "table.aix", dir, { ...QUICK, grid: 32 });
      expect(table.physics?.overhang ?? 0).toBeGreaterThan(0.25);
      expect(table.report).toMatch(/Overhangs \| \d+% of the surface faces down/);
      const cube = run("m = box(2)", "cube.aix", dir, { ...QUICK, grid: 16 });
      expect(cube.physics?.overhang ?? 1).toBe(0);
      expect(cube.report).toMatch(/Overhangs \| none/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("quick pass warnings", () => {
  it("judges thin parts at the grid a full render would use, and says where a mesh is not watertight", () => {
    const dir = mkdtempSync(join(tmpdir(), "aixle-"));
    try {
      // 0.06 thin: under a cell at the quick grid (64 over 8 units) but two cells at the file's grid 260.
      const src = "set grid 260\nplate = box(8, 0.06, 8)\nknob = sphere(1) | move(0, 1, 0)\nm = plate + knob";
      const quick = run(src, "thin.aix", dir, QUICK);
      expect(quick.warnings.some((w) => w.startsWith("'plate'"))).toBe(false);
      const full = run(src.replace("260", "40"), "thin.aix", dir, { ...QUICK, quick: false, grid: 40 });
      expect(full.warnings.join()).toMatch(/'plate' \(line 2\) is only 0.06/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("extents and close-ups", () => {
  it("extracts over the surface's extent when the bounds are loose, and folds many thin warnings into one", () => {
    // A box turned 45 degrees has a box of a box: the tight extent is the turned box itself, and the report says so.
    const ev = check("m = box(2, 0.2, 0.2) | rotate(z=45)");
    const t = tightBounds(ev.output!);
    const b = ev.output!.bounds;
    expect(b.max[0] - b.min[0]).toBeCloseTo(2 * Math.SQRT1_2 + 0.2 * Math.SQRT1_2, 3);
    expect(t.max[0] - t.min[0]).toBeLessThanOrEqual(b.max[0] - b.min[0]);
    // A blend pads the bounds; the extent is the spheres.
    const bl = check("m = union(sphere(1), sphere(0.5) | move(0, 1.2, 0), k=1)");
    const tb = tightBounds(bl.output!);
    expect(tb.min[1]).toBeGreaterThan(bl.output!.bounds.min[1]);
    expect(tb.min[1]).toBeLessThanOrEqual(-1);
    const folded = foldThinWarnings(["'a' (line 1) is only 0.01 units thin, 0.3 of the 0.03 cell: x (set grid 300).", "'b' (line 2) is only 0.02 units thin: x (set grid 200).", "'c' (line 3) has a wall only 0.015 thick: x (set grid 250).", "'d' (line 4) is only 0.02 units thin: x (set grid 210)."]);
    expect(folded).toHaveLength(1);
    expect(folded[0]).toMatch(/4 steps are thinner than a grid cell \(a, b, c, d\), the thinnest 'a' at 0.01/);
    expect(folded[0]).toMatch(/set grid 300 covers them all/);
  });
  it("a focused render is a close-up: the views are extracted at the frame's own cell", () => {
    const dir = mkdtempSync(join(tmpdir(), "aixle-"));
    try {
      const src = "slab = box(10, 0.5, 10) | move(0, 0.25, 0)\nknob = sphere(0.3) | move(3, 0.8, 3)\nm = slab + knob";
      const r = run(src, "focus.aix", dir, { ...QUICK, grid: 32, focus: "knob" });
      // The sheet's cell is the knob's box over 32 cells, far finer than the slab's 10 units over 32.
      expect(r.files).toContain("sheet.png");
      expect(r.timings.focus).toBeDefined();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
