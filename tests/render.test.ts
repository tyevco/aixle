import { describe, expect, it } from "vitest";
import * as P from "../src/sdf/primitives.js";
import * as O from "../src/sdf/ops.js";
import { surfaceNets } from "../src/mesh/surfaceNets.js";
import { renderSheet, renderSlices, renderSteps, renderTurntable, renderView, INK, gridStep, defaultLevel } from "../src/render/views.js";
import { orthographic, perspective, project, toView } from "../src/render/camera.js";
import { preset } from "../src/sdf/materials.js";
import { Canvas } from "../src/render/canvas.js";
import { drawText, textWidth } from "../src/render/font.js";
import { renderBeauty } from "../src/render/beauty.js";

const sphere = P.sphere(1);
const mesh = surfaceNets(sphere, { resolution: 32 }).mesh;
const info = { name: "ball", bounds: sphere.bounds };

describe("cameras", () => {
  it("frame the bounds: the centre projects to the middle and the extent stays inside", () => {
    const cam = perspective(sphere.bounds, 200, 200);
    const c = project(cam, toView(cam, [0, 0, 0]))!;
    expect(c.x).toBeCloseTo(100, 0);
    expect(c.y).toBeCloseTo(100, 0);
    for (const p of [[1, 0, 0], [0, 1, 0], [0, 0, 1], [-1, 0, 0]] as const) {
      const q = project(cam, toView(cam, [p[0], p[1], p[2]]))!;
      expect(q.x).toBeGreaterThan(0);
      expect(q.x).toBeLessThan(200);
      expect(q.y).toBeGreaterThan(0);
      expect(q.y).toBeLessThan(200);
    }
  });
  it("front looks from +z with x to the right; right looks from +x; top has -z up", () => {
    const front = orthographic(sphere.bounds, 100, 100, "front");
    expect(project(front, toView(front, [1, 0, 0]))!.x).toBeGreaterThan(50);
    expect(project(front, toView(front, [0, 1, 0]))!.y).toBeLessThan(50);
    expect(project(front, toView(front, [0, 0, 1]))!.depth).toBeLessThan(project(front, toView(front, [0, 0, -1]))!.depth);
    const right = orthographic(sphere.bounds, 100, 100, "right");
    expect(project(right, toView(right, [0, 0, -1]))!.x).toBeGreaterThan(50);
    expect(project(right, toView(right, [1, 0, 0]))!.depth).toBeLessThan(project(right, toView(right, [-1, 0, 0]))!.depth);
    const top = orthographic(sphere.bounds, 100, 100, "top");
    expect(project(top, toView(top, [0, 0, -1]))!.y).toBeLessThan(50);
    expect(project(top, toView(top, [1, 0, 0]))!.x).toBeGreaterThan(50);
  });
});

describe("views", () => {
  it("draws the model in the middle of every view and leaves the background at the corners", () => {
    for (const v of ["persp", "front", "right", "top"] as const) {
      const c = renderView(mesh, info, v, 120);
      expect(c.width).toBe(120);
      const mid = c.get(60, 60);
      expect(mid).not.toBe(INK.view);
      expect(mid).not.toBe(INK.viewPersp);
      // A corner is background or grid, never model.
      const corner = c.get(118, 118);
      expect([INK.view, INK.viewPersp, INK.grid, INK.gridMajor, 0x1a1a20]).not.toContain(0x000000);
      expect(corner).not.toBe(mid);
    }
  });
  it("hides nothing behind nearer geometry in orthographic views", () => {
    // A small sphere in front of a big box: the front view must show the sphere's material in the middle.
    const box = O.paint(P.box(4, 4, 0.5), preset("blue")!);
    const ball = O.paint(O.move(P.sphere(0.5), 0, 0, 2), preset("red")!);
    const m = surfaceNets(O.union([box, ball]), { resolution: 48 }).mesh;
    const c = renderView(m, { name: "t", bounds: O.union([box, ball]).bounds }, "front", 160, { label: false });
    const px = c.get(80, 80);
    const r = (px >> 16) & 255, b = px & 255;
    expect(r).toBeGreaterThan(b);
  });
  it("composes the sheet, slices, steps and turntable at the expected sizes", () => {
    const sheet = renderSheet(mesh, { ...info, triangles: 10, cellSize: 0.1, warnings: 1 }, 100);
    expect([sheet.width, sheet.height]).toEqual([212, 242]);
    const slices = renderSlices(sphere, info, 80);
    expect(slices.width).toBe(80 * 3 + 16);
    // The centre of every slice of a sphere is inside: filled, not background.
    for (let i = 0; i < 3; i++) expect(slices.get(4 + i * 84 + 40, 30 + 4 + 40)).not.toBe(INK.view);
    const steps = renderSteps([{ name: "a", shape: sphere, used: true, line: 1 }, { name: "b", shape: O.empty3(), used: false, line: 2 }], 60, 16);
    expect(steps.width).toBe(2 * 66 + 6);
    const tt = renderTurntable(mesh, info, 40, 4);
    expect(tt.width).toBe(4 * 44 + 4);
  });
  it("picks slice planes through the origin when the model straddles it", () => {
    expect(defaultLevel({ min: [-1, 0, -1], max: [3, 2, 1] }, "x")).toBe(0);
    expect(defaultLevel({ min: [2, 0, -1], max: [3, 2, 1] }, "x")).toBe(2.5);
    expect(defaultLevel({ min: [-1, 0, -1], max: [3, 2, 1] }, "y")).toBe(1);
  });
  it("chooses a readable grid step", () => {
    expect(gridStep(3)).toBe(0.2);
    expect(gridStep(30)).toBe(2);
    expect(gridStep(0.5)).toBe(0.05);
  });
});

describe("canvas and font", () => {
  it("encodes a PNG with the right signature and size", () => {
    const c = new Canvas(3, 2, 0xff0000);
    const png = c.toPng();
    expect([...png.subarray(0, 8)]).toEqual([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
    expect(png.readUInt32BE(16)).toBe(3);
    expect(png.readUInt32BE(20)).toBe(2);
  });
  it("draws text of a predictable width", () => {
    const c = new Canvas(80, 10, 0xffffff);
    const end = drawText(c, 0, 0, "AB 1", 0x000000);
    expect(end).toBe(textWidth("AB 1"));
    expect(c.get(1, 0)).toBe(0x000000);
  });
});

describe("beauty", () => {
  it("ray-marches the field: the model in the middle, a shadow on the floor beside it, open floor behind", () => {
    const nets = surfaceNets(sphere, { resolution: 24 });
    const c = renderBeauty(sphere, nets.mesh, sphere.bounds, { size: 96, cellSize: nets.cellSize });
    const mid = c.get(48, 44);
    const back = c.get(48, 2);
    const shadowSide = c.get(70, 78); // the light comes from the upper left, so the shadow falls right and down
    const lum = (p: number) => ((p >> 16) & 255) + ((p >> 8) & 255) + (p & 255);
    expect(mid).not.toBe(back);
    // The sphere is clay: its lit side is warmer than the floor.
    expect((mid >> 16) & 255).toBeGreaterThan(mid & 255);
    expect(lum(shadowSide)).toBeLessThan(lum(back));
  });
});
