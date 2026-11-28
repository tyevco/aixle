import { describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Every caption the beauty renderer is asked to draw, read where the pipeline hands it over.
const labels = vi.hoisted(() => [] as string[]);
vi.mock("../src/render/beauty.js", async (importOriginal) => {
  const real = await importOriginal<typeof import("../src/render/beauty.js")>();
  return {
    ...real,
    renderBeauty: (...a: Parameters<typeof real.renderBeauty>) => {
      if (a[3].label) labels.push(a[3].label);
      return real.renderBeauty(...a);
    },
  };
});

const { run } = await import("../src/pipeline.js");

describe("beauty captions", () => {
  it("give the model's size the same way in beauty.png and in an unfocused camera's shot", () => {
    const dir = mkdtempSync(join(tmpdir(), "aixle-"));
    try {
      // A sphere of radius 1 meshed at 16 cells: the vertices stray about 0.007 past the surface, which printed as
      // 2.01 in a camera's caption while beauty.png, held within the bounds, said 2.
      labels.length = 0;
      run('m = sphere(1) | move(0, 1, 0)\ncamera("side", azimuth=80)\nshow m', "ball.aix", dir, { grid: 16, size: 64, views: [], steps: false, slices: false, turntable: false, obj: false, glb: false, viewer: false, callouts: false, beauty: true, beautySize: 64 });
      const beauty = labels.find((l) => /^m  /.test(l));
      const side = labels.find((l) => /camera side/.test(l));
      expect(beauty).toBe("m  2 × 2 × 2");
      expect(side).toBe("m, camera side  2 × 2 × 2");
      // The shot set camera names is beauty.png, captioned as the camera's; with --azimuth over the camera's own
      // beauty.png is another picture, and its caption says so rather than read as beauty_hero.png's (round 11: a door
      // rendered at --azimuth 22 over set camera hero read as lights.png ignoring the camera).
      const src = 'm = sphere(1) | move(0, 1, 0)\ncamera("hero", azimuth=-20)\nset camera hero\nshow m';
      const opts = { grid: 16, size: 64, views: [] as never[], steps: false, slices: false, turntable: false, obj: false, glb: false, viewer: false, callouts: false, beauty: true, beautySize: 64 };
      labels.length = 0;
      run(src, "ball.aix", dir, opts);
      expect(labels).toEqual(["m, camera hero  2 × 2 × 2"]);
      labels.length = 0;
      const turned = run(src, "ball.aix", dir, { ...opts, azimuth: 60 });
      expect(labels).toEqual(["m, camera hero with --azimuth 60  2 × 2 × 2", "m, camera hero  2 × 2 × 2"]);
      expect(turned.files).toContain("beauty_hero.png");
      expect(turned.report).toMatch(/`beauty\.png`: the field ray traced: glTF PBR shading, traced reflections, soft shadows from lights with a size, refraction, tone-mapped, from camera hero with --azimuth 60 \(set camera\)/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
