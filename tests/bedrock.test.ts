import { describe, expect, it } from "vitest";
import * as P from "../src/sdf/primitives.js";
import * as O from "../src/sdf/ops.js";
import { materialFromString } from "../src/sdf/materials.js";
import { toBedrock, voxelBoxes } from "../src/export/bedrock.js";

describe("Minecraft Bedrock geometry", () => {
  it("turns a box into one cube at sixteen pixels to the block, authored on the mirrored x", () => {
    const r = toBedrock([{ name: "slab", shape: O.move(P.box(1, 0.5, 1), 0.25, 0.25, 0) }], "slab");
    expect(r.cubes).toBe(1);
    expect(r.voxels).toBe(16 * 8 * 16);
    const geo = r.geometry as { "minecraft:geometry": { description: { identifier: string; texture_width: number }; bones: { name: string; cubes: { origin: number[]; size: number[]; uv: Record<string, { uv: number[]; uv_size: number[] }> }[] }[] }[] };
    const g = geo["minecraft:geometry"][0];
    expect(g.description.identifier).toBe("geometry.slab");
    expect(g.bones[0].name).toBe("slab");
    const cube = g.bones[0].cubes[0];
    // The model spans x -0.25..0.75, y 0..0.5, z -0.5..0.5: in pixels, mirrored on x, the origin is the low corner.
    expect(cube.size).toEqual([16, 8, 16]);
    expect(cube.origin).toEqual([-12, 0, -8]);
    expect(cube.uv.north.uv_size).toEqual([16, 8]);
    expect(cube.uv.east.uv_size).toEqual([16, 8]);
    expect(cube.uv.up.uv_size).toEqual([16, 16]);
    // Every window lies inside the texture.
    for (const f of Object.values(cube.uv)) {
      expect(f.uv[0] + f.uv_size[0]).toBeLessThanOrEqual(r.texture.width);
      expect(f.uv[1] + f.uv_size[1]).toBeLessThanOrEqual(r.texture.height);
    }
  });
  it("paints each window with the model's material, and a sphere becomes stepped cubes within its bounds", () => {
    const red = materialFromString("#ff0000")!;
    const r = toBedrock([{ name: "ball", shape: O.paint(P.sphere(1), red) }], "ball", { pixelsPerUnit: 8 });
    expect(r.cubes).toBeGreaterThan(10);
    // About the sphere's volume in voxels (4/3 pi r^3 at 8 per unit is 2145), within a few percent.
    expect(Math.abs(r.voxels - 2145) / 2145).toBeLessThan(0.05);
    const cubes = (r.geometry as { "minecraft:geometry": { bones: { cubes: { origin: number[]; size: number[] }[] }[] }[] })["minecraft:geometry"][0].bones[0].cubes;
    // Geometry is sixteen to the block whatever the sampling: a unit sphere spans -16..16, in half-pixel steps at 8.
    for (const c of cubes) for (let k = 0; k < 3; k++) { expect(c.origin[k]).toBeGreaterThanOrEqual(-16); expect(c.origin[k] + c.size[k]).toBeLessThanOrEqual(16); expect(c.size[k] % 2).toBe(0); }
    // Every painted texel is red (the packing leaves the rest black).
    let red_ = 0, other = 0;
    for (let i = 0; i < r.texture.data.length; i += 4) {
      const [cr, cg, cb] = [r.texture.data[i], r.texture.data[i + 1], r.texture.data[i + 2]];
      if (cr === 0 && cg === 0 && cb === 0) continue;
      if (cr > 200 && cg < 40 && cb < 40) red_++; else other++;
    }
    expect(red_).toBeGreaterThan(100);
    expect(other).toBe(0);
  });
  it("merges runs greedily: an L of two boxes is two cubes, and a scene is a bone per object", () => {
    const l = O.union([P.box(1, 0.25, 0.25), O.move(P.box(0.25, 1, 0.25), -0.375, 0.5, 0)]);
    const warnings: string[] = [];
    expect(voxelBoxes(l, 8, 256, warnings, "l").boxes.length).toBe(2);
    const r = toBedrock([{ name: "a", shape: P.box(0.5, 0.5, 0.5) }, { name: "b", shape: O.move(P.box(0.5, 0.5, 0.5), 2, 0, 0) }], "pair");
    expect(r.bones).toEqual(["a", "b"]);
    expect(r.cubes).toBe(2);
    // A model too big for the lattice is clipped with a warning rather than sampled a billion times.
    const big = toBedrock([{ name: "big", shape: P.box(40, 1, 1) }], "big", { pixelsPerUnit: 16, maxPixels: 64 });
    expect(big.warnings[0]).toMatch(/'big' is 640 pixels on its longest side/);
  });
});
