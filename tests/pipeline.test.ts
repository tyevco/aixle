import { afterAll, describe, expect, it } from "vitest";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BEAUTY_ONLY, cameraSight, cellFor, check, clampBounds, cutWarnings, diff, foldThinWarnings, geometrySteps, glassWarnings, nearlyThin, paintWarnings, QUICK, run, thinWarnings, tightBounds, watertightNote } from "../src/pipeline.js";
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
      // Read before the next run into the folder, which removes what this one wrote and it does not.
      expect(r.files).toContain("viewer.html");
      expect(r.files).toContain("beauty.png");
      const html = readFileSync(join(dir, "viewer.html"), "utf8");
      expect(html).toContain("<title>m · aixle viewer</title>");
      expect(html).toMatch(/const GLB = "Z2xURg/); // "glTF" in base64
      expect(html).toContain("three@0.187.0");
      const png = readFileSync(join(dir, "beauty.png"));
      expect(png.readUInt32BE(16)).toBe(64);
      // A declared camera is a shot of its own, framed on its focus; the report lists lights, cameras and the sky.
      const shots = run('m = box(1)\nk = sphere(0.2) | move(1, 0.5, 0)\nboth = m + k\nlight("key", azimuth=-30, elevation=40)\nlight("rim", azimuth=160, elevation=20, power=0.5, color="#cfe0ff")\ncamera("hero", azimuth=20, zoom=1.2)\ncamera("knob", focus="k")\nset environment night\nshow both', "shots.aix", dir, { grid: 16, size: 64, views: [], steps: false, slices: false, turntable: false, obj: false, glb: false, viewer: false, beauty: true, beautySize: 64 });
      expect(shots.files).toEqual(expect.arrayContaining(["beauty.png", "beauty_hero.png", "beauty_knob.png", "lights.png"]));
      expect(shots.report).toMatch(/\(lights\.png shows each alone, and what each adds\)/);
      expect(shots.timings.lights).toBeDefined();
      expect(shots.report).toMatch(/Lights: key \(azimuth -30, elevation 40, size 1, white\); rim \(azimuth 160, elevation 20, size 1, #cfe0ff, power 0\.5\)/);
      expect(shots.report).toMatch(/Cameras: hero \(azimuth 20, zoom 1\.2\) → beauty_hero\.png; knob \(on k\) → beauty_knob\.png/);
      expect(shots.report).toMatch(/Environment: night/);
      expect(shots.report).toMatch(/`beauty_knob\.png`: the beauty render from camera knob, framed on k/);
      expect(shots.timings["beauty:knob"]).toBeDefined();
      // lights.png: each light alone, then all, and under them what each adds on its own and the picture under none.
      const lit = readFileSync(join(dir, "lights.png"));
      expect([lit.readUInt32BE(16), lit.readUInt32BE(20)]).toEqual([(96 + 6) * 3 + 6, 26 + (96 + 6) * 2 + 16 + 6]);
      // One camera and another sky from the command line: only that shot, as beauty.png, the sky noted.
      const one = run('m = box(1)\ncamera("hero", azimuth=20)\ncamera("side", azimuth=90)\nset environment night\nshow m', "one.aix", dir, { grid: 16, size: 64, views: [], steps: false, slices: false, turntable: false, obj: false, glb: false, viewer: false, beauty: true, beautySize: 64, camera: "side", environment: "sunset" });
      expect(one.files.filter((f) => f.startsWith("beauty"))).toEqual(["beauty.png"]);
      expect(one.report).toMatch(/\(the sheet and beauty\.png use "side"\)/);
      expect(one.report).toMatch(/Environment: sunset/);
      const all = run('m = box(1)\nset environment night\nshow m', "all.aix", dir, { grid: 16, size: 64, views: [], steps: false, slices: false, turntable: false, obj: false, glb: false, viewer: false, beauty: true, beautySize: 64, environment: "all" });
      expect(all.files).toContain("environments.png");
      expect(all.warnings.filter((w) => /environment/.test(w))).toEqual([]);
      // `all` leaves beauty.png the program's own sky; a list gives it the first listed, and the strip only those.
      expect(all.report).toMatch(/Environment: night/);
      expect(readFileSync(join(dir, "environments.png")).readUInt32BE(16)).toBe((96 + 6) * 4 + 6);
      const pair = run('m = box(1)\nshow m', "pair.aix", dir, { grid: 16, size: 64, views: [], steps: false, slices: false, turntable: false, obj: false, glb: false, viewer: false, beauty: true, beautySize: 64, environment: "overcast, sunset,mars" });
      expect(pair.report).toMatch(/Environment: overcast/);
      expect(pair.report).toMatch(/`environments\.png`: the beauty render under overcast, sunset, from --environment/);
      expect(readFileSync(join(dir, "environments.png")).readUInt32BE(16)).toBe((96 + 6) * 2 + 6);
      expect(pair.warnings).toEqual(expect.arrayContaining([expect.stringMatching(/^--environment mars: no such environment/)]));
      // A focus hidden behind the rest of the model from its camera is warned about; from the other side it is not.
      const hid = run('wall = box(2, 2, 0.2) | move(0, 1, 1)\nball = sphere(0.3) | move(0, 1, 0)\nboth = wall + ball\ncamera("front", focus="ball", azimuth=0, elevation=5)\ncamera("back", focus="ball", azimuth=180, elevation=5)\nshow both', "hid.aix", dir, { grid: 24, size: 64, views: [], steps: false, slices: false, turntable: false, obj: false, glb: false, viewer: false, beauty: true, beautySize: 64 });
      expect(hid.warnings.filter((w) => /hidden behind/.test(w))).toEqual([expect.stringMatching(/^camera "front" \(line 4\): \d+% of ball is hidden behind the rest of the model from azimuth 0, elevation 5; from azimuth \d+ it is \d+%$/)]);
      expect(run('m = box(1)\nshow m', "bad.aix", dir, { grid: 16, size: 64, views: [], steps: false, slices: false, turntable: false, obj: false, glb: false, viewer: false, camera: "nope", environment: "mars" }).warnings).toEqual(expect.arrayContaining([expect.stringMatching(/^--camera nope: no such camera \(declare one/), expect.stringMatching(/^--environment mars: no such environment; the skies are studio/)]));
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
  it("writes callouts.png on a full render and says which steps it labelled", () => {
    const dir = mkdtempSync(join(tmpdir(), "aixle-"));
    try {
      const src = "slab = box(2, 0.4, 2) | move(0, 0.2, 0)\nknob = sphere(0.3) | move(0.5, 0.6, 0.5)\nhole = cylinder(0.25, 1) | move(-0.5, 0.2, -0.5)\nm = (slab - hole) + knob";
      const r = run(src, "co.aix", dir, { grid: 32, size: 96, views: [], steps: false, slices: false, turntable: false, obj: false, glb: false, viewer: false, beauty: false });
      expect(r.files).toContain("callouts.png");
      // The hole's wall is a cut face, credited to the hole though the only cut step is the output.
      expect(r.report).toMatch(/Callouts \(callouts\.png, the largest visible steps named\): slab, knob, hole \(cut\)\n/);
      expect(r.timings.callouts).toBeDefined();
      const quick = run(src, "co.aix", dir, { ...QUICK, grid: 32 });
      expect(quick.files).not.toContain("callouts.png");
      const off = run(src, "co.aix", dir, { grid: 32, size: 96, views: [], steps: false, slices: false, turntable: false, obj: false, glb: false, viewer: false, beauty: false, callouts: false });
      expect(off.files).not.toContain("callouts.png");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
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
  it("slices through a named step: the planes through its solid, framed on it, the rest faint", () => {
    const dir = mkdtempSync(join(tmpdir(), "aixle-"));
    try {
      const src = "slab = box(2, 0.1, 2) | move(0, -0.05, 0)\npost = cylinder(0.05, 1) | move(0.6, 0.5, 0.3)\nglobe = sphere(0.25) | move(0.6, 1.2, 0.3)\nm = slab + post + globe\nshow m";
      const r = run(src, "post.aix", dir, { grid: 32, size: 96, views: [], steps: false, turntable: false, obj: false, glb: false, viewer: false, callouts: false, slice: "post" });
      expect(r.files).toContain("slices.png");
      // The post stands on the slab, so the planes across that contact go through it (round 11).
      expect(r.report).toMatch(/`slices\.png`: cross-sections through post, where it meets the rest of the model \(X and Z; Y at its own level\), framed on it/);
      const air = run("slab = box(2, 0.1, 2) | move(0, -0.05, 0)\nball = sphere(0.3) | move(0.5, 1, 0)\nm = slab + ball\nshow m", "air.aix", dir, { grid: 32, size: 96, views: [], steps: false, turntable: false, obj: false, glb: false, viewer: false, callouts: false, slice: "ball" });
      expect(air.report).toMatch(/`slices\.png`: cross-sections through ball at its centroid/);
      expect(r.warnings.join()).not.toMatch(/slice/);
      // A probe only the slice reads is a region, not an unused step; a name that is no step is said.
      const probe = check("m = box(1)\nrod = cylinder(0.05, 2) | move(0.2, 0, 0)\nset slice rod\nshow m");
      expect(probe.roles.get("rod")).toBe("region");
      expect(probe.warnings.join()).not.toMatch(/rod/);
      expect(check("m = box(1)\nset slice nope").warnings.join()).toMatch(/set slice nope: no such step or object/);
      // --slice from the command line makes the same probe a region as `set slice` does: not an unused step, and
      // its volume places the planes while the model is drawn in full.
      const cli = run("m = box(1)\nrod = cylinder(0.05, 2) | move(0.2, 0, 0)\nshow m", "rod.aix", dir, { grid: 16, size: 64, views: [], steps: false, turntable: false, obj: false, glb: false, viewer: false, callouts: false, slice: "rod" });
      expect(cli.warnings.join()).not.toMatch(/'rod'.*not part of the output/);
      expect(cli.report).toMatch(/`slices\.png`: cross-sections through rod \(a region: its volume places the planes/);
      const bad = run("m = box(1)", "b.aix", dir, { grid: 16, size: 64, views: [], steps: false, turntable: false, obj: false, glb: false, viewer: false, callouts: false, slice: "nope" });
      expect(bad.warnings.join()).toMatch(/slice nope: no such step or object with a surface/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
  it("says which named steps the callouts never saw, tags a cut named at open edges, and leaves the caption off when asked", () => {
    const dir = mkdtempSync(join(tmpdir(), "aixle-"));
    try {
      const r = run("plate = box(2, 0.2, 2)\nunder = box(0.4, 0.05, 0.4) | move(0, -0.2, 0)\nslot = box(0.2, 1, 1) | move(0.5, 0.2, 0)\nm = (plate - slot) + under\nshow m", "slot.aix", dir, { grid: 32, size: 96, views: [], steps: false, slices: false, turntable: false, obj: false, glb: false, viewer: false, elevation: 40 });
      expect(r.report).toMatch(/not seen from this view, hidden or every visible face of theirs a smaller step's: under/);
      const w = { ok: false, note: "Watertight: no.", where: { min: [0, 0, 0], max: [1, 1, 1] }, clusters: [{ at: [0.4, 0.1, 0] as [number, number, number], count: 4, box: { min: [0.4, 0.05, -0.1], max: [0.4, 0.15, 0.1] } }] } as unknown as Parameters<typeof watertightNote>[0];
      const ev = check("plate = box(2, 0.2, 2)\nslot = box(0.2, 1, 1) | move(0.5, 0.2, 0)\nm = plate - slot\nshow m");
      const note = watertightNote(w, ev, 0.05);
      expect(note).toMatch(/'slot' \(cut: the face it cut\)/);
      expect(note).toMatch(/move the part by half a cell \(0\.025\) along x/);
      const plain = run('m = box(1)\nset caption 0\nshow m', "cap.aix", dir, { grid: 16, size: 64, views: [], steps: false, slices: false, turntable: false, obj: false, glb: false, viewer: false, callouts: false, beauty: true, beautySize: 64 });
      expect(plain.files).toContain("beauty.png");
      const bare = readFileSync(join(dir, "beauty.png"));
      run('m = box(1)\nshow m', "cap.aix", dir, { grid: 16, size: 64, views: [], steps: false, slices: false, turntable: false, obj: false, glb: false, viewer: false, callouts: false, beauty: true, beautySize: 64 });
      expect(readFileSync(join(dir, "beauty.png")).equals(bare)).toBe(false);
      run('m = box(1)\nshow m', "cap.aix", dir, { grid: 16, size: 64, views: [], steps: false, slices: false, turntable: false, obj: false, glb: false, viewer: false, callouts: false, beauty: true, beautySize: 64, caption: false });
      expect(readFileSync(join(dir, "beauty.png")).equals(bare)).toBe(true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
  it("titles a sheet with the surface's size held within the bounds", () => {
    expect(clampBounds({ min: [-1.001, -0.0005, -1], max: [1.001, 0.513, 1] }, { min: [-1, 0, -1], max: [1, 0.5, 1] })).toEqual({ min: [-1, 0, -1], max: [1, 0.5, 1] });
    // A mesh smaller than its loose bounds keeps its own extent.
    expect(clampBounds({ min: [0, 0, 0], max: [1, 1, 1] }, { min: [-2, -2, -2], max: [2, 2, 2] })).toEqual({ min: [0, 0, 0], max: [1, 1, 1] });
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
    // curve2 takes centripetal tangents, so on uneven points it is not the curve curve() draws (round 11's stand).
    expect(md).not.toMatch(/curve2[\s\S]{0,200}the curve curve\(\) draws, closed/);
    expect(md).toMatch(/### curve2\n\n[^\n]*centripetal Catmull-Rom/);
  });
});

describe("rigs, features and overhangs", () => {
  it("warns about a wall, tube or stroke thinner than a cell inside a thick step, once", () => {
    const ev = check('cup = shell(cylinder(1, 2), 0.01) - (cylinder(0.8, 1) | move(0, 1.5, 0))\nlabel = extrude(text("Hi", 0.5, weight=0.02), 0.2) | rotate(x=90) | move(0, 1, 1)\nm = cup + label');
    const { grid, cellSize } = cellFor(ev);
    const w = thinWarnings(ev, cellSize, grid);
    expect(w.join("\n")).toMatch(/'cup' \(line 1\) has a part \(a wall, slat, rod, tube at its thin end, or stroke\) only 0.01 thick/);
    expect(w.join("\n")).toMatch(/'label' \(line 2\) has a part \(a wall, slat, rod, tube at its thin end, or stroke\) only 0.02 thick/);
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
      expect(cube.report).toMatch(/Overhangs \| 0\.0% of the surface faces down more than 45° above the floor \|/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("thin parts, named and placed", () => {
  it("names a curve2 band beside a part of the same thickness, whatever its centre line does", () => {
    // Round 11's mixer: a bowl revolved from curve2(..., wall=0.05) with a three-quarter curl at its rim, beside a
    // 0.05 hook. The thin parts were reported once per size, so the hook, named first, hid the bowl.
    const src = [
      "def curl_pt(deg) = [1.145 - 0.055 * cos(deg), 1.65 + 0.055 * sin(deg)]",
      "line = [0,0.14, 0.5,0.17, 0.88,0.5, 1.06,1.25, 1.09,1.65] + curl_pt(45) + curl_pt(90) + curl_pt(135) + curl_pt(180) + curl_pt(225)",
      "hook = box(0.05, 0.3, 0.2) | move(1.5, 0.2, 0)",
      "wall = revolve(curve2(line, wall=0.05))",
      "m = hook + wall",
    ].join("\n");
    const w = thinWarnings(check(src), 0.06, 64).join("\n");
    expect(w).toMatch(/'hook' \(line 3\) is only 0.05 units thin/);
    expect(w).toMatch(/'wall' \(line 4\) has a part \(a wall, slat, rod, tube at its thin end, or stroke\) only 0.05 thick/);
    // 'm' brings in nothing new: both its 0.05 parts were named at their own steps.
    expect(w).not.toMatch(/'m'/);
    // Two copies of one part are one thin part, named once.
    const twice = thinWarnings(check("rod = cylinder(0.02, 1)\nrods = rod + (rod | move(0.5, 0, 0))\nm = rods + box(1, 1, 1)"), 0.05, 64);
    expect(twice.filter((x) => /0.04 (units thin|thick)/.test(x))).toHaveLength(1);
    // So are the copies one call makes, each a new node: slats a loop builds are named once, at the step that
    // gathers them (the loop's own `slat` is no step), and not again under the output, which folds that union in.
    const loop = check("slats = empty()\nfor i in range(0, 5) {\n  slat = box(0.02, 1, 0.3) | move(i * 0.2, 0.5, 0)\n  slats = slats + slat\n}\nm = slats + (box(1.2, 0.1, 0.4) | move(0.4, 1.05, 0))");
    const lw = thinWarnings(loop, 0.03, 40);
    expect(lw.filter((x) => /0.02 (units thin|thick)/.test(x))).toHaveLength(1);
    expect(lw.join()).toMatch(/^'slats' \(line 1\) has a part .* only 0.02 thick, .*made by box\(\) at line 3/);
    expect(lw.join()).not.toMatch(/'m'/);
    // And a def's part in two steps that each call it, in the 1.2-to-2-cell note: one chair named, not each.
    const chairs = check("def chair(x) = box(0.5, 1, 0.05) | move(x, 0.5, 0)\nc1 = chair(0)\nc2 = chair(1)\nm = c1 + c2 + (box(2, 0.2, 2) | move(0.5, -0.1, 0))");
    expect(nearlyThin(chairs, 0.035)).toMatch(/'c1' \(1\.4 cells: box\(\) in def chair at line 1/);
    expect(nearlyThin(chairs, 0.035)).not.toMatch(/'c2'/);
  });
  it("says where a thin wall of an outline is, in the profile's plane and in the model", () => {
    // Two blocks joined by a 0.02 neck along y = 2, x 4..6 in the profile; extruded along x, turned and moved.
    const src = "side = curve2([0,0, 0,0, 4,0, 4,0, 4,1.99, 4,1.99, 6,1.99, 6,1.99, 6,0, 6,0, 10,0, 10,0, 10,4, 10,4, 6,4, 6,4, 6,2.01, 6,2.01, 4,2.01, 4,2.01, 4,4, 4,4, 0,4, 0,4])\nbody = extrude(side, 3, \"x\") | flip(\"z\") | move(1, 0, 2)";
    const w = thinWarnings(check(src), 0.08, 128).join("\n");
    const m = w.match(/'body' \(line 2\) has a part .* only 0.02 thick, [\d.]+ of the 0.08 cell, at \(1, 2, ([\d.]+)\) in the model, \(([\d.]+), 2\) in the profile 'side' \(line 1\):/);
    expect(m).not.toBeNull();
    // The profile's x is the model's z after the flip, moved by 2; the point is on the neck.
    expect(Number(m![1])).toBeCloseTo(Number(m![2]) + 2, 2);
    expect(Number(m![2])).toBeGreaterThan(4);
    expect(Number(m![2])).toBeLessThan(6);
  });
  it("names the member a def built, its line and its library, and where it is, for a def called inline", () => {
    const dir = mkdtempSync(join(tmpdir(), "aixle-"));
    try {
      // Round 11's bookcase: a 0.1 back panel built inside a library's case(), called inline in 'plate'.
      writeFileSync(join(dir, "shelves.aix"), "# a case\ndef back(w) = box(w, 2, 0.05) | move(0, 1, -0.52)\ndef case(w) = box(w, 2, 1) | move(0, 1, 0) + back(w)\n");
      const prog = join(dir, "room.aix");
      const src = 'use "shelves" as lib\nball = sphere(0.3) | move(0, 2.2, 0)\ncap = box(0.6, 0.2, 0.6) | move(0, 2.05, 0)\nleg = box(0.5, 0.5, 0.5) | move(0.6, 2.2, 0)\nplate = lib.case(2) + ball + cap + leg';
      writeFileSync(prog, src);
      const ev = check(src, prog);
      const w = thinWarnings(ev, 0.1, 64).join("\n");
      expect(w).toMatch(/'plate' \(line 5\) has a part \(a wall, slat, rod, tube at its thin end, or stroke\) only 0.05 thick, 0.5 of the 0.1 cell, made by box\(\) in def back at shelves.aix line 2, within x -1..1 y 0..2 z -0.545..-0.495 in the model:/);
      // Between 1.2 and 2 cells, the note names it the same way.
      expect(nearlyThin(ev, 0.035)).toMatch(/'plate' \(1.4 cells: box\(\) in def back at shelves.aix line 2, within x -1..1 y 0..2 z -0.545..-0.495 in the model\)/);
      // A def in the program itself has no file to name.
      const own = check("def case(w) = box(w, 2, 1) + (box(w, 2, 0.05) | move(0, 0, -0.52))\nplate = case(2) + sphere(0.3)");
      expect(thinWarnings(own, 0.1, 64).join()).toMatch(/made by box\(\) in def case at line 1, within x -1..1 y -1..1 z -0.545..-0.495 in the model/);
      // The quick pass's list names the member beside the step.
      const q = run(src, prog, join(dir, "out"), { ...QUICK, grid: 24 });
      expect(q.warnings.join()).toMatch(/quick pass: 1 step is thinner than this pass's [\d.]+ cell and may be missing or broken on this sheet: plate \(box\(\) in def back at shelves.aix line 2\); and 1 step is under two of its cells and may show holes or seams here: cap\./);
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
      // The slab's top reaches into the knob's frame: it is meshed as a ghost and the report says so (round 7: a
      // clipped body over a gimbal read as a plate).
      expect(r.timings["focus:ghost"]).toBeDefined();
      expect(r.report).toMatch(/`sheet.png`: .*a close-up on knob: the rest of the model in the frame is drawn faint/);
      // A focus on the whole model leaves nothing to ghost.
      const whole = run(src, "focus.aix", dir, { ...QUICK, grid: 32, focus: "m" });
      expect(whole.report).not.toMatch(/drawn faint/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("extents that cannot clip", () => {
  it("keeps a plate thinner than any sampling pass whole, and a decal region out of the geometry", () => {
    const dir = mkdtempSync(join(tmpdir(), "aixle-"));
    try {
      // A 0.12-thick disc under a ball: a coarse pass once found only its middle (measured: 1.8 of 4.4 wide).
      const r = run("pad = cylinder(2.2, 0.12)\nball = sphere(1) | move(0, 1, 0)\nm = pad + ball", "plate.aix", dir, { ...QUICK, grid: 40 });
      expect(r.report).toMatch(/Surface extent \| x -2\.[12]\d*\.\.2\.[12]/);
      const ev = check('eye = sphere(1)\nspot = box(0.4, 0.4, 0.03) | move(0, 0, 1)\nm = decal(eye, spot, "black")');
      expect(geometrySteps(ev).has("spot")).toBe(false);
      expect(geometrySteps(ev).has("eye")).toBe(true);
      expect(thinWarnings(ev, 0.05, 40)).toHaveLength(0);
      // The decal is a skin: at the surface it answers black, deep inside the base shows.
      const m = ev.output!;
      expect(m.hit(0, 0, 1).mat.name).toBe("black");
      expect(m.hit(0, 0, 0.5).mat.name).not.toBe("black");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("round-3 findings", () => {
  it("tells a cavity from a loose piece and a small part from a speck", () => {
    const dir = mkdtempSync(join(tmpdir(), "aixle-"));
    try {
      // A hollow closed box: one piece with one cavity, no loose-piece warning.
      const r = run("m = box(2, 2, 2) | shell(0.2)", "hollow.aix", dir, { ...QUICK, grid: 32 });
      expect(r.warnings.join()).not.toMatch(/separate pieces/);
      expect(r.report).toMatch(/\| Cavities \| volume/);
      expect(r.report).toMatch(/\| Pieces \| 1 \|/);
      // A small star floating above a post is a loose piece named by its step, not a speck.
      const r2 = run("post = cylinder(0.08, 1) | move(0, 0.5, 0)\nstar = extrude(star(5, 0.3, 0.13), 0.08) | move(0, 1.3, 0)\nm = post + star", "star.aix", dir, { ...QUICK, grid: 48 });
      expect(r2.warnings.join()).toMatch(/separate pieces.*'star'/);
      expect(r2.warnings.join()).not.toMatch(/speck/);
      // A lug built at the origin and moved into place, inside a posed joint, is named by the lug: the innermost step,
      // found by walking the tree with each transform's inverse (round 4: the arm's union was named instead).
      const rig = "lug = sphere(0.2)\narm = box(0.3, 2, 0.3) | move(0, 1, 0)\nboom = arm + (lug | move(0, 2.6, 0))\nrig = joint(boom, \"hinge\", 0, 0, 0)\nbase = box(2, 0.3, 2)\nm = base + rig";
      const r3 = run(rig, "rig.aix", dir, { ...QUICK, grid: 48, poses: false });
      expect(r3.warnings.join()).toMatch(/separate pieces.*'lug'/);
      expect(r3.warnings.join()).not.toMatch(/'arm'/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
  it("warns about an empty intersection, a painted-plus-unpainted union, and letter counters under a cell", () => {
    const ev = check("a = box(1)\nb = box(1) | move(5, 0, 0)\nm = a & b | move(0, 1, 0)");
    expect(ev.warnings.join()).toMatch(/line 3: '&' removed everything/);
    const lid = check('lid = cone(1, 0.5, 0.3) + ellipsoid(0.5, 0.2, 0.5) | paint("gold")');
    expect(paintWarnings(lid).join()).toMatch(/'lid' \(line 1\) joins painted and unpainted parts/);
    expect(paintWarnings(check('lid = (cone(1, 0.5, 0.3) + ellipsoid(0.5, 0.2, 0.5)) | paint("gold")'))).toHaveLength(0);
    const small = check('t = extrude(text("Best in Show", 0.12, weight=0.05), 0.1)\nbase = box(5, 0.2, 5)\nm = t + base');
    // The warning names the gap: the counter of a lowercase letter here, since the letters are spaced.
    expect(thinWarnings(small, 0.04, 128).join()).toMatch(/'t' \(line 1\): the counter of e \(the gap inside the letter\) (is only|closes up)/);
    expect(thinWarnings(check('t = extrude(text("Best in Show", 0.4, weight=0.06), 0.1)'), 0.02, 128)).toHaveLength(0);
  });
  it("angle() reads the pose being evaluated, and numbers print whole", () => {
    const src = 'arm = box(0.2, 2, 0.2) | move(0, 1, 0)\nj = joint(arm, "hinge", 0, 0, 0)\na = angle("hinge")[0]\nshow j';
    expect(check(src).steps.find((s) => s.name === "a")!.value).toBe(0);
    expect(check(src, "rig.aix", undefined, { hinge: { angles: [30, 0, 0], move: [0, 0, 0], scale: [1, 1, 1] } }).steps.find((s) => s.name === "a")!.value).toBe(30);
  });
});

describe("printing", () => {
  it("writes a binary STL of the shown model and hollow() leaves no enclosed cavity", () => {
    const dir = mkdtempSync(join(tmpdir(), "aixle-"));
    try {
      const r = run("m = box(2, 2, 2) | hollow(0.2, 0, -1, 0)", "print.aix", dir, { ...QUICK, grid: 32, obj: true });
      expect(r.files).toContain("model.stl");
      const stl = readFileSync(join(dir, "model.stl"));
      const count = stl.readUInt32LE(80);
      expect(count).toBe(r.mesh!.indices.length / 3);
      expect(stl.length).toBe(84 + count * 50);
      // The drain joins the void to the outside: one surface, no cavity, and the wall is there.
      expect(r.report).toMatch(/\| Cavities \| none \|/);
      expect(r.evaluation.output!.dist(0, 0, 0)).toBeGreaterThan(0.5);
      expect(r.evaluation.output!.dist(0.9, 0.5, 0)).toBeLessThan(0);
      expect(r.evaluation.output!.dist(0, -0.9, 0)).toBeGreaterThan(0);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("round-6 findings", () => {
  it("warns about a cut that removes almost nothing, but not about a trim under the floor", () => {
    const tangent = check("mitre = ellipsoid(0.08, 0.12, 0.08) | move(0, 0.4, 0)\nslot = box(0.3, 0.06, 0.014) | rotate(x=-35) | move(0, 0.36, 0.1)\nbishop = mitre - slot");
    expect(cutWarnings(tangent, 0.0125).join()).toMatch(/'bishop' \(line 3\): the cut removes nothing the samples could find/);
    const slot = check("mitre = ellipsoid(0.08, 0.12, 0.08) | move(0, 0.4, 0)\nslot = box(0.3, 0.06, 0.03) | rotate(x=-35) | move(0, 0.36, 0.03)\nbishop = mitre - slot");
    expect(cutWarnings(slot, 0.0125)).toEqual([]);
    const trim = check("trunk = sphere(1) | displace(0.1, 0.5)\nbelow = box(4, 1, 4) | move(0, -1.4, 0)\ntree = trunk - below");
    expect(cutWarnings(trim, 0.03)).toEqual([]);
  });
  it("a slat or a rod inside a union is judged against the cell, and a curve bent tighter than its tube is noted", () => {
    const bench = check("bench = (box(1, 0.03, 0.1) | move(0, 0.5, 0)) + box(0.1, 0.5, 0.1)");
    expect(thinWarnings(bench, 0.04, 128).join()).toMatch(/'bench' \(line 1\) has a part \(a wall, slat, rod, tube at its thin end, or stroke\) only 0.03 thick/);
    const posts = check("posts = box(0.1, 0.5, 0.1) + (cylinder(0.05, 0.5) | move(0.3, 0, 0))");
    expect(thinWarnings(posts, 0.04, 128)).toEqual([]);
    const hoop = check("hoop = tube(0.03, curve([0,0,0, 0.1,0,0, 0.1,0.1,0, 0,0.1,0]))");
    expect(thinWarnings(hoop, 0.01, 128).join()).toMatch(/'hoop' \(line 1\): its curve bends to a radius of [\d.]+, tighter than the tube's 0.03/);
  });
  it("open edges in one step are 'alone', or 'twice' when two placements of it cross", () => {
    const cluster = (at: [number, number, number], count: number) => ({ centre: at, at, box: { min: [at[0] - 0.01, at[1] - 0.1, at[2] - 0.1] as [number, number, number], max: [at[0] + 0.01, at[1] + 0.1, at[2] + 0.1] as [number, number, number] }, count });
    const w = (at: [number, number, number]) => ({ ok: false, holes: 4, nonManifold: 0, note: "no: 4 open edges.", where: cluster(at, 4).box, clusters: [cluster(at, 4)] });
    const rod = check("rod = cylinder(0.1, 2)");
    expect(watertightNote(w([0.1, 0, 0]), rod, 0.02)).toMatch(/4 at \(0.1, 0, 0\) in 'rod' alone/);
    const boards = check("panel = box(1, 0.1, 1)\na = panel | move(0, 0.02, 0)\nb = panel | rotate(x=90)\nboth = a + b");
    const edges: { at: [number, number, number]; count: number; steps: string[] }[] = [];
    expect(watertightNote(w([0.5, 0, 0]), boards, 0.02, edges)).toMatch(/in 'panel' twice, as 'a' and 'b'/);
    expect(edges).toEqual([{ at: [0.5, 0, 0], count: 4, steps: ["panel"] }]);
  });
  it("a failed assert is a warning on the render and a row in the report", () => {
    const dir = mkdtempSync(join(tmpdir(), "aixle-"));
    try {
      const r = run("m = box(2, 1, 1)\nassert width(m) < 1, \"narrow\"\nassert tall(m) == 1", "promise.aix", dir, { grid: 24, views: [], steps: false, slices: false, turntable: false, obj: false, glb: false, viewer: false, beauty: false });
      expect(r.warnings).toContain("assert (line 2) fails: width(m) < 1 is 2 < 1: narrow");
      expect(r.report).toMatch(/\| Asserts \| 1 pass, 1 fail: \(line 2\) fails: width\(m\) < 1 is 2 < 1: narrow \|/);
      const json = JSON.parse(readFileSync(join(dir, "report.json"), "utf8"));
      expect(json.asserts).toEqual([
        // The margin is how far each passed by (negative: failed by), for a reader that wants the nearest to failing.
        { line: 2, text: "width(m) < 1", detail: "2 < 1", message: "narrow", passed: false, margin: -1 },
        { line: 3, text: "tall(m) == 1", detail: "1 == 1", passed: true, margin: 0 },
      ]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
  it("a scene's report judges each object on its own", () => {
    const dir = mkdtempSync(join(tmpdir(), "aixle-"));
    try {
      const r = run("board = box(2, 0.2, 2) | move(0, -0.1, 0)\npawn = cylinder(0.15, 0.4) | move(0, 0.2, 0)\npawns = place(pawn, [-0.5,0,0,0, 0.5,0,0,0])\nscene board, pawns", "set.aix", dir, { grid: 40, views: [], steps: false, slices: false, turntable: false, obj: false, glb: false, viewer: false, beauty: false });
      expect(r.report).toMatch(/\| board \| yes \| 1 \| yes/);
      expect(r.report).toMatch(/\| pawns \(each of 2 copies\) \| yes \| 1 \| yes/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("glass on a bound", () => {
  it("warns when a transmit material sits on a loft, a blend or a warp, and not on an exact shape", () => {
    const ev = check('body = loft(rect(1, 0.6, round=0.2), rect(0.8, 0.5, round=0.1), 1.2)\nglass = body | paint("glass")\nblob = union(sphere(0.5), sphere(0.5) | move(0.6, 0, 0), k=0.2) | paint(material("glass", transmit=0.6))\nfine = box(1, 1, 1, round=0.1) | paint("glass")\nbent = box(1, 0.2, 2) | bend(20) | paint("gold")\nshow glass + blob + fine + bent', "g.aix");
    expect(glassWarnings(ev)).toEqual([
      "'glass' (line 2) is glass on a field that is a bound, not a distance ('body': a loft, a smooth union, a warp or a non-uniform scale): the beauty render bands behind it. Build glass from exact shapes (a rounded box, a cylinder, a revolve) or drop transmit.",
      "'blob' (line 3) is glass on a field that is a bound, not a distance (a loft, a smooth union, a warp or a non-uniform scale): the beauty render bands behind it. Build glass from exact shapes (a rounded box, a cylinder, a revolve) or drop transmit.",
    ]);
    // A smooth profile is an exact distance, so a bottle revolved from one is glass the march can trust.
    const bottle = check('wall = curve2([0,0.02, 0.5,0.02, 0.55,1.2, 0.2,1.6, 0.18,2], wall=0.04)\nbottle = revolve(wall) | paint("glass")\nflask = extrude(bezier2([0,0, 0.6,0, 0.6,1, 0,1]), 0.3, "z") | paint("glass")\nshow bottle + flask', "b.aix");
    expect(glassWarnings(bottle)).toEqual([]);
  });
});

describe("round 11: a promise at rest is judged once", () => {
  it("keeps the warnings a promise at rest raised on a render shown in a pose", () => {
    // The pose's evaluation no longer judges the promise at rest, so its warning comes from the rest evaluation.
    const dir = mkdtempSync(join(tmpdir(), "aixle-"));
    try {
      const src = 'body = box(1)\nfar = sphere(0.1) | move(0, 5, 0)\nlid = joint(box(1, 0.1, 1) | move(0, 0.55, 0), "lid", 0, 0.5, 0.5)\npose("open", lid=[-60, 0, 0])\nassert void(far, body)\nshow body + lid';
      for (const pose of [undefined, "open"]) {
        const r = run(src, "far.aix", dir, { ...QUICK, grid: 24, poses: false, pose });
        expect(r.warnings.filter((w) => /holds trivially/.test(w))).toHaveLength(1);
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("round 11: check aims a camera", () => {
  it("says how much of a camera's focus is hidden from its angle, from rays, and warns as the render does when another azimuth shows more", () => {
    // A lantern behind a wall: from the front (azimuth 0, +z) the wall hides it, from the back nothing does.
    const src = 'wall = box(3, 2, 0.2) | move(0, 1, 0.6)\nlantern = sphere(0.3) | move(0, 1, -0.4)\ncamera("front", focus="lantern", azimuth=0, elevation=10)\ncamera("back", focus="lantern", azimuth=180, elevation=10)\nshow wall + lantern';
    const ev = check(src);
    const sight = cameraSight(ev, cellFor(ev).cellSize);
    expect(sight.lines).toHaveLength(2);
    const [front, back] = sight.lines;
    expect(Number(/^ {2}front: (\d+)% of lantern hidden behind the rest of the model from azimuth 0, elevation 10; 0% from azimuth (\d+)$/.exec(front)?.[1])).toBeGreaterThan(90);
    expect(back).toBe("  back: 0% of lantern hidden behind the rest of the model from azimuth 180, elevation 10");
    expect(sight.warnings).toHaveLength(1);
    expect(sight.warnings[0]).toMatch(/^camera "front" \(line 3\): \d+% of lantern is hidden behind the rest of the model from azimuth 0, elevation 10; from azimuth \d+ it is 0%$/);
  });
});

describe("round-11 renders", () => {
  const opts = { grid: 16, size: 64, views: [] as never[], steps: false, slices: false, turntable: false, obj: false, glb: false, viewer: false, callouts: false, beauty: true, beautySize: 64 };
  const lit = 'm = box(1, 1, 1)\nk = sphere(0.2) | move(1, 0.5, 0)\nboth = m + k\nlight("key", azimuth=-30, elevation=40)\nlight("rim", azimuth=160, elevation=20, power=0.5)\ncamera("hero", azimuth=-20, elevation=10, zoom=1.2)\ncamera("knob", focus="k", azimuth=60, elevation=30, zoom=1)\n';
  const dirs: string[] = [];
  const tmp = () => { const d = mkdtempSync(join(tmpdir(), "aixle-r11-")); dirs.push(d); return d; };
  const bytes = (dir: string, f: string) => readFileSync(join(dir, f));
  afterAll(() => { for (const d of dirs) rmSync(d, { recursive: true, force: true }); });

  it("renders the shot beauty.png shows once, and --beauty-only renders that one shot alone", () => {
    // Round 11: with set camera hero, beauty.png and beauty_hero.png were the same camera marched twice, and
    // --beauty-only --camera iron wrote the shot twice and lights.png: 28 s against the shot's 8.
    const a = tmp(), b = tmp(), c = tmp();
    const full = run(lit + "set camera hero\nshow both", "lit.aix", a, opts);
    expect(full.files.filter((f) => f.startsWith("beauty"))).toEqual(["beauty.png", "beauty_knob.png"]);
    expect(full.files).toContain("lights.png");
    expect(full.timings["beauty:hero"]).toBeUndefined();
    expect(full.report).toMatch(/Cameras: hero \(azimuth -20, elevation 10, zoom 1\.2\) → beauty\.png; knob \(azimuth 60, elevation 30, zoom 1, on k\) → beauty_knob\.png/);
    expect(full.report).toMatch(/`beauty\.png`: the field ray-marched with soft shadows and ambient occlusion, from camera hero \(set camera\)/);
    // --camera knob: beauty.png is knob's shot, the very picture the full run wrote as beauty_knob.png, and the only one.
    const one = run(lit + "set camera hero\nshow both", "lit.aix", b, { ...opts, camera: "knob" });
    expect(one.files.filter((f) => f.startsWith("beauty"))).toEqual(["beauty.png"]);
    expect(bytes(b, "beauty.png").equals(bytes(a, "beauty_knob.png"))).toBe(true);
    // --beauty-only: the sheet and the one shot, the same picture as the full run's beauty.png; no light study.
    const only = run(lit + "set camera hero\nshow both", "lit.aix", c, { ...BEAUTY_ONLY, grid: 16, size: 64, beautySize: 64 });
    expect(only.files).toEqual(["sheet.png", "beauty.png", "report.md", "report.json"]);
    expect(bytes(c, "beauty.png").equals(bytes(a, "beauty.png"))).toBe(true);
    expect(only.report).toMatch(/knob \([^)]*\) → not rendered \(one shot\)/);
    // --camera naming no camera renders every shot, as its warning says; in the one-shot loop beauty.png is the
    // render's own view and the warning says that instead.
    const none = run(lit + "set camera hero\nshow both", "lit.aix", b, { ...opts, camera: "nope" });
    expect(none.files.filter((f) => f.startsWith("beauty"))).toEqual(["beauty.png", "beauty_hero.png", "beauty_knob.png"]);
    expect(none.warnings).toEqual(expect.arrayContaining([expect.stringMatching(/^--camera nope: no such camera; cameras: hero, knob; every shot is rendered$/)]));
    const noneOnly = run(lit + "set camera hero\nshow both", "lit.aix", b, { ...BEAUTY_ONLY, grid: 16, size: 64, beautySize: 64, camera: "nope" });
    expect(noneOnly.files.filter((f) => f.startsWith("beauty"))).toEqual(["beauty.png"]);
    expect(noneOnly.warnings).toEqual(expect.arrayContaining([expect.stringMatching(/^--camera nope: no such camera; cameras: hero, knob; beauty\.png takes the render's own view$/)]));
    // --lights asks for the study in the loop; --no-lights leaves it off a full run.
    expect(run(lit + "set camera hero\nshow both", "lit.aix", c, { ...BEAUTY_ONLY, grid: 16, size: 64, beautySize: 64, lights: true }).files).toContain("lights.png");
    expect(run(lit + "show both", "lit.aix", c, { ...opts, lights: false }).files).not.toContain("lights.png");
  });

  it("draws lights.png from the shot beauty.png shows, whether set camera or --camera chose it", () => {
    const a = tmp(), b = tmp(), c = tmp();
    run(lit + "set camera hero\nshow both", "lit.aix", a, opts);
    run(lit + "show both", "lit.aix", b, { ...opts, camera: "hero" });
    run(lit + "show both", "lit.aix", c, opts);
    expect(bytes(a, "lights.png").equals(bytes(b, "lights.png"))).toBe(true);
    expect(bytes(a, "lights.png").equals(bytes(c, "lights.png"))).toBe(false);
  });

  it("removes what an earlier run of the tool wrote into the folder and this one did not, and nothing else", () => {
    // Round 11: beauty_iron.png, beauty_torch.png and lights.png from earlier runs sat beside a quick sheet.
    const dir = tmp();
    writeFileSync(join(dir, "notes.txt"), "mine");
    writeFileSync(join(dir, "beauty_old.png"), "not written by a run");
    const first = run(lit + "set camera hero\nshow both", "lit.aix", dir, opts);
    expect(first.removed).toEqual([]);
    const second = run(lit + "set camera hero\nshow both", "lit.aix", dir, { ...QUICK, grid: 16, size: 64 });
    expect(second.removed).toEqual(["beauty.png", "lights.png", "beauty_knob.png"]);
    for (const f of second.removed!) expect(existsSync(join(dir, f)), f).toBe(false);
    for (const f of [...second.files, "notes.txt", "beauty_old.png"]) expect(existsSync(join(dir, f)), f).toBe(true);
    expect(JSON.parse(readFileSync(join(dir, "report.json"), "utf8")).files).toEqual(second.files.filter((f) => f !== "report.json"));
    // A file list that names something outside the folder, or a file the tool never writes, is not followed.
    const outside = tmp();
    writeFileSync(join(outside, "keep.png"), "x");
    writeFileSync(join(dir, "report.json"), JSON.stringify({ files: [`../${outside.split("/").pop()}/keep.png`, "notes.txt", "sheet.png"] }));
    const third = run(lit + "show both", "lit.aix", dir, { ...QUICK, grid: 16, size: 64 });
    expect(third.removed).toEqual([]);
    expect(existsSync(join(outside, "keep.png"))).toBe(true);
    expect(existsSync(join(dir, "notes.txt"))).toBe(true);
  });

  it("meshes a shown pose at the rest pose's cell, and says so in the report", () => {
    // Round 11: the mixer's tilted head left the posed model's box loose (y to 5.5 against a 5.22 surface), and the
    // whole model was meshed a third coarser at the same grid, the bowl it does not move included.
    const dir = tmp();
    const src = 'base = box(2, 0.3, 2) | move(0, 0.15, 0)\nlid = joint(box(2, 0.1, 2) | move(1, 0.05, 0), "hinge", -1, 0.3, 0, axis=[0, 0, 1])\npose("open", hinge=50)\nshow base + lid';
    const cell = () => JSON.parse(readFileSync(join(dir, "report.json"), "utf8")).cellSize as number;
    const rest = run(src, "lid.aix", dir, { ...QUICK, grid: 32 });
    const restCell = cell();
    const posed = run(src, "lid.aix", dir, { ...QUICK, grid: 32, pose: "open" });
    expect(cell()).toBeCloseTo(restCell, 9);
    expect(posed.report).toMatch(/\| Grid \| \d+ cells on the longest side, cell [\d.]+ units \(the rest pose's cell, kept for pose open: \d+ cells along its longest side\) \|/);
    expect(rest.report).not.toMatch(/the rest pose's cell/);
    // Past the 500 cells the extractor takes along the posed model the rest cell cannot be kept, and the report says
    // the cell is coarser rather than "kept" (an arm folded over its base at rest, unfolded to twice the length).
    const fold = 'base = box(1, 0.1, 0.1) | move(0, 0.05, 0)\narm = joint(box(1, 0.1, 0.1) | move(-0.5, 0.15, 0), "hinge", 0.5, 0.1, 0, axis=[0, 0, 1])\npose("open", hinge=-180)\nshow base + arm';
    run(fold, "fold.aix", dir, { ...QUICK, grid: 400 });
    const foldCell = cell();
    const far = run(fold, "fold.aix", dir, { ...QUICK, grid: 400, pose: "open" });
    expect(cell()).toBeGreaterThan(foldCell * 1.1);
    expect(far.report).toMatch(/\| Grid \| 400 cells on the longest side, cell [\d.]+ units \(pose open: the rest pose's cell, [\d.]+, would be more than the 500 cells the extractor takes along the posed model, so this one is coarser than at rest\) \|/);
  });

  it("draws named steps with the output for a picture, each its own object in a scene, and names an unknown one", () => {
    const dir = tmp();
    const src = "stand = box(2, 0.2, 1) | move(0, 0.1, 0)\nprobe = box(0.5, 0.5, 0.5) | move(0, 0.45, 0)\nshow stand\nassert clearance(probe, stand) > -1";
    const r = run(src, "s.aix", dir, { ...QUICK, grid: 16, size: 64, show: ["probe"] });
    expect(r.evaluation.outputName).toBe("stand+probe");
    expect(r.evaluation.output!.bounds.max[1]).toBeCloseTo(0.7);
    expect(r.warnings.join()).not.toMatch(/'probe'.*not part of the output/);
    const scene = run("a = box(1, 1, 1)\nb = sphere(0.3) | move(2, 0, 0)\nprobe = sphere(0.1) | move(0, 1, 0)\nscene a, b", "sc.aix", dir, { ...QUICK, grid: 16, size: 64, show: ["probe"] });
    expect(scene.evaluation.objects.map((o) => o.name)).toEqual(["a", "b", "probe"]);
    expect(() => run(src, "s.aix", dir, { ...QUICK, grid: 16, size: 64, show: ["nope"] })).toThrow(/^--show nope: no such step; the shapes are stand, probe$/);
  });
});
