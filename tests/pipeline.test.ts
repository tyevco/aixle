import { describe, expect, it } from "vitest";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { check, run } from "../src/pipeline.js";
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
