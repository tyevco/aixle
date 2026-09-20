import { describe, expect, it } from "vitest";
import * as P from "../src/sdf/primitives.js";
import * as O from "../src/sdf/ops.js";
import { surfaceNets } from "../src/mesh/surfaceNets.js";
import { renderSheet, renderSlices, renderSteps, renderTurntable, renderView, INK, gridStep, defaultLevel, meshSteps } from "../src/render/views.js";
import { createTarget, renderGhost, renderMesh } from "../src/render/raster.js";
import { attributeVertices, renderCallouts } from "../src/render/callouts.js";
import { decodePng, encodePng } from "../src/render/png.js";
import { albedo, coverage, sampleImage } from "../src/sdf/materials.js";
import type { ImageTexture } from "../src/sdf/types.js";
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
  it("draws a ghost faint where it is in front of nothing, and not at all behind the solid mesh", () => {
    const solid = surfaceNets(P.box(1, 1, 1), { resolution: 16 }).mesh;
    // Two ghost boxes: one behind the solid one (hidden), one off to its right (faint), plus one in front of it.
    const behind = O.move(P.box(1, 1, 0.5), 0, 0, -2), beside = O.move(P.box(1, 1, 1), 3, 0, 0), front = O.move(P.box(0.4, 0.4, 0.2), 0, 0, 2);
    const ghost = surfaceNets(O.union([behind, beside]), { resolution: 32 }).mesh;
    const bounds = { min: [-1, -1, -3] as [number, number, number], max: [4, 1, 3] as [number, number, number] };
    const cam = orthographic(bounds, 160, 160, "front");
    const px = (p: [number, number, number]) => { const q = project(cam, toView(cam, p))!; return [Math.round(q.x), Math.round(q.y)] as const; };
    const [sx, sy] = px([0, 0, 0.5]), [gx, gy] = px([3, 0, 0.5]);
    const plain = renderView(solid, { name: "g", bounds }, "front", 160, { label: false });
    const ghosted = renderView(solid, { name: "g", bounds }, "front", 160, { label: false, ghost, ghostMargin: 0.05 });
    // Over the solid box the ghost behind it changes nothing.
    expect(ghosted.get(sx, sy)).toBe(plain.get(sx, sy));
    // Over the box beside it, the ghost tints the background without covering it.
    // (The plain pixel is the background or one of its grid lines.)
    const bg = plain.get(gx, gy), g = ghosted.get(gx, gy);
    expect(g).not.toBe(bg);
    const solidThere = renderView(surfaceNets(beside, { resolution: 32 }).mesh, { name: "s", bounds }, "front", 160, { label: false }).get(gx, gy);
    const dist = (a: number, b: number) => Math.abs((a >> 16) - (b >> 16)) + Math.abs(((a >> 8) & 255) - ((b >> 8) & 255)) + Math.abs((a & 255) - (b & 255));
    expect(dist(g, bg)).toBeLessThan(dist(solidThere, bg));
    // A ghost in front of the solid mesh is drawn over it, faintly: the pixel moves but the solid still shows.
    const target = createTarget(160, 160, INK.view);
    renderMesh(solid, cam, target, { background: INK.view });
    const before = target.canvas.get(sx, sy);
    renderGhost(surfaceNets(front, { resolution: 16 }).mesh, cam, target, { margin: 0.05 });
    const after = target.canvas.get(sx, sy);
    expect(after).not.toBe(before);
    expect(dist(after, before)).toBeLessThan(dist(after, INK.view) + dist(before, INK.view));
    // A slice with a ghost draws the cut through it faint around the part's own cut.
    const boxInfo = { name: "g", bounds: P.box(4, 4, 4).bounds };
    const slices = renderSlices(sphere, boxInfo, 80, undefined, P.box(4, 4, 4));
    const centre = slices.get(4 + 40, 34 + 40), corner = slices.get(4 + 12, 34 + 68);
    expect(corner).not.toBe(INK.view);
    expect(corner).not.toBe(centre);
    expect(dist(corner, INK.view)).toBeLessThan(dist(centre, INK.view));
    expect(renderSlices(sphere, boxInfo, 80).get(4 + 12, 34 + 68)).not.toBe(corner);
  });
  it("frames each cross-section on its own two axes", () => {
    // A long flat bar: its end cut is 0.4 wide, and framed on the bar's 4-unit length it was a sliver (round 8).
    const bar = P.box(4, 0.4, 0.4);
    const slices = renderSlices(bar, { name: "bar", bounds: bar.bounds }, 100);
    // In the X cut (the first tile) the bar spans 0.4 / (0.4 * 1.15) of the tile: a pixel 40% out from the centre is inside.
    expect(slices.get(4 + 50 + 40, 34 + 50)).not.toBe(INK.view);
    expect(slices.get(4 + 50 + 40, 34 + 50)).not.toBe(INK.grid);
    // In the Y cut (the second tile) the length runs along x and fills the tile, the 0.4 depth a tenth of it.
    expect(slices.get(4 + 104 + 50, 34 + 50 + 20)).not.toBe(slices.get(4 + 104 + 50, 34 + 50));
  });
  it("composes the sheet, slices, steps and turntable at the expected sizes", () => {
    const sheet = renderSheet(mesh, { ...info, triangles: 10, cellSize: 0.1, warnings: 1 }, 100);
    expect([sheet.width, sheet.height]).toEqual([212, 242]);
    const slices = renderSlices(sphere, info, 80);
    expect(slices.width).toBe(80 * 3 + 16);
    // The centre of every slice of a sphere is inside: filled, not background.
    for (let i = 0; i < 3; i++) expect(slices.get(4 + i * 84 + 40, 30 + 4 + 40)).not.toBe(INK.view);
    const steps = renderSteps([{ name: "a", shape: sphere, used: true, line: 1 }, { name: "b", shape: O.empty3(), used: false, line: 2 }], 60, 16);
    const meshed = meshSteps([{ name: "a", shape: sphere, used: true, line: 1 }, { name: "big", shape: O.scale(sphere, 100, 100, 100), used: true, line: 2 }], 0.05, 40);
    expect(meshed[0].coarse).toBe(false);
    expect(meshed[1].coarse).toBe(true);
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

describe("pictures", () => {
  const picture = (): ImageTexture => {
    // 4 by 2: red, green / blue, transparent.
    const rgba = new Uint8Array([255, 0, 0, 255, 0, 255, 0, 255, 255, 0, 0, 255, 0, 255, 0, 255, 0, 0, 255, 255, 0, 0, 0, 0, 0, 0, 255, 255, 0, 0, 0, 0]);
    return { name: "p.png", width: 4, height: 2, rgba, projection: "planar", axis: "z", size: 2 };
  };
  it("decodes what the encoder writes, and filtered rows too", () => {
    const w = 5, h = 3, rgba = new Uint8Array(w * h * 4);
    for (let i = 0; i < rgba.length; i++) rgba[i] = (i * 37) & 255;
    const back = decodePng(encodePng(w, h, rgba));
    expect([back.width, back.height]).toEqual([w, h]);
    expect([...back.rgba]).toEqual([...rgba]);
    // An RGB, 8-bit file with a Sub-filtered row, built by hand: two pixels, the second stored as a difference.
    const { deflateSync } = require("node:zlib") as typeof import("node:zlib");
    const raw = new Uint8Array([1, 10, 20, 30, 5, 5, 5]);
    const chunk = (type: string, body: Uint8Array) => { const t = Buffer.from(type); const c = Buffer.concat([t, Buffer.from(body)]); const len = Buffer.alloc(4); len.writeUInt32BE(body.length); const crc = Buffer.alloc(4); return Buffer.concat([len, c, crc]); };
    const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(2, 0); ihdr.writeUInt32BE(1, 4); ihdr[8] = 8; ihdr[9] = 2;
    const file = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk("IHDR", ihdr), chunk("IDAT", deflateSync(raw)), chunk("IEND", new Uint8Array(0))]);
    expect([...decodePng(file).rgba]).toEqual([10, 20, 30, 255, 15, 25, 35, 255]);
    expect(() => decodePng(new Uint8Array([1, 2, 3]))).toThrow(/not a PNG/);
  });
  it("samples a picture flat, wrapped, and fitted to a box, with its alpha as coverage", () => {
    const flat = picture();
    // Planar along z, 2 units wide (so 1 unit tall): the top-left texel is red, the bottom-right transparent.
    const rgb = (v: number[]) => v.slice(0, 3).map((c) => Math.round(c * 1000) / 1000);
    expect(rgb(sampleImage(flat, -0.75, 0.25, 0))).toEqual([1, 0, 0]);
    expect(sampleImage(flat, 0.75, -0.25, 0)[3]).toBe(0);
    expect(sampleImage(flat, 3, 0, 0)[3]).toBe(0);
    const m = { name: "p", color: [1, 1, 1] as [number, number, number], color2: [1, 1, 1] as [number, number, number], pattern: "solid" as const, scale: 1, metal: 0, rough: 0.5, transmit: 0, seed: 0, axis: "z" as const, glow: 0, image: flat };
    expect(rgb(albedo(m, -0.75, 0.25, 0))).toEqual([1, 0, 0]);
    expect(coverage(m, 0.75, -0.25, 0)).toBe(0);
    // Wrapped round y by arc length, 1 unit wide: the front (+z) starts the picture, a quarter turn on at radius 1
    // is 1.57 units along, so into the second copy's green.
    const wrap: ImageTexture = { ...picture(), projection: "cylindrical", axis: "y", size: 1 };
    // Sampled at texel centres: an eighth of a unit along the arc is the first texel, 1.375 the sixth, a green one.
    expect(rgb(sampleImage(wrap, Math.sin(0.125), 0.125, Math.cos(0.125)))).toEqual([1, 0, 0]);
    expect(rgb(sampleImage(wrap, Math.sin(1.375), 0.125, Math.cos(1.375)))).toEqual([0, 1, 0]);
    expect(sampleImage(wrap, 0, 5, 1)[3]).toBe(0);
    // Fitted to a box thin along z: u along x, v down y.
    const box: ImageTexture = { ...picture(), projection: "box", axis: "y", size: 1, box: { min: [0, 0, 0], max: [4, 2, 0.1] } };
    expect(rgb(sampleImage(box, 0.5, 1.75, 0.05))).toEqual([1, 0, 0]);
    expect(sampleImage(box, 3.5, 0.25, 0.05)[3]).toBe(0);
  });
});

describe("callouts", () => {
  it("attributes vertices to the smallest step they lie on, the later of two the same size, cut faces to the cutter, and labels the visible ones", () => {
    const slab = O.move(P.box(2, 0.4, 2), 0, 0.2, 0);
    const knob = O.move(P.sphere(0.3), 0.5, 0.6, 0.5);
    const hole = O.move(P.cylinder(0.25, 1), -0.5, 0.2, -0.5);
    const cut = O.difference(slab, hole);
    const model = O.union([cut, knob]);
    const nets = surfaceNets(model, { resolution: 40 });
    // The hole is a cutter and the cut was computed with it, as the interpreter marks them.
    const steps = [{ name: "slab", shape: slab }, { name: "knob", shape: knob }, { name: "hole", shape: hole, cut: true }, { name: "cut", shape: cut, derived: true }];
    const owner = attributeVertices(nets.mesh, steps, nets.cellSize, 1, model);
    const counts = [0, 0, 0, 0, 0];
    for (const o of owner) counts[o < 0 ? 4 : o]++;
    // The knob's vertices are the knob's; the slab's faces are the cut's, the later step in the same box (a shell or
    // a painted cut is named, not the primitive it came from); the hole's wall is the hole's, as a cut face.
    expect(counts[1]).toBeGreaterThan(50);
    expect(counts[3]).toBeGreaterThan(counts[1]);
    expect(counts[0]).toBe(0);
    expect(counts[2]).toBeGreaterThan(20);
    // A cutter not marked as one never owns a face: the wall stays the cut's.
    const plain = attributeVertices(nets.mesh, steps.map((st) => ({ name: st.name, shape: st.shape })), nets.cellSize, 1, model);
    expect([...plain].filter((o) => o === 2).length).toBe(0);
    const r = renderCallouts(nets.mesh, steps, { name: "m", bounds: model.bounds }, 160, nets.cellSize, 20, undefined, undefined, model);
    expect(r.labelled.map((l) => l.name).sort()).toEqual(["cut", "hole", "knob"]);
    expect(r.labelled[0].name).toBe("cut");
    expect(r.labelled.find((l) => l.name === "hole")?.cut).toBe(true);
    expect(r.unlabelled).toEqual([]);
    expect([r.canvas.width, r.canvas.height]).toEqual([160, 186]);
    // With one label allowed, the smaller steps are reported as in view but not labelled.
    const one = renderCallouts(nets.mesh, steps, { name: "m", bounds: model.bounds }, 160, nets.cellSize, 1, undefined, undefined, model);
    expect(one.labelled.map((l) => l.name)).toEqual(["cut"]);
    expect(one.unlabelled.map((u) => u.name).sort()).toEqual(["hole", "knob"]);
  });
});

describe("beauty lights and environments", () => {
  it("shadows towards each light, darkens at night and warms a sunset horizon, and is unchanged without lights", () => {
    const nets = surfaceNets(sphere, { resolution: 24 });
    const lum = (p: number) => ((p >> 16) & 255) + ((p >> 8) & 255) + (p & 255);
    const base = { size: 96, cellSize: nets.cellSize };
    const plain = renderBeauty(sphere, nets.mesh, sphere.bounds, base);
    // One white light at the default direction, declared, matches the default key light's picture.
    const declared = renderBeauty(sphere, nets.mesh, sphere.bounds, { ...base, lights: [{ azimuth: -40, elevation: 55, size: 1, color: [1, 1, 1], power: 1 }] });
    expect(declared.get(48, 44)).not.toBe(plain.get(0, 95));
    // A point light just right of the sphere lights its right side and not its left; farther away it does less.
    const point = (x: number) => renderBeauty(sphere, nets.mesh, sphere.bounds, { ...base, lights: [{ azimuth: 0, elevation: 0, size: 1, color: [1, 1, 1], power: 1, position: [x, 0.2, 0.3], range: 1.5 }] });
    const near = point(1.6), off = point(6);
    expect(lum(near.get(70, 48))).toBeGreaterThan(lum(near.get(26, 48)) + 60);
    expect(lum(near.get(70, 48))).toBeGreaterThan(lum(off.get(70, 48)) + 30);
    // A second light from the right lifts the sphere's right side.
    const two = renderBeauty(sphere, nets.mesh, sphere.bounds, { ...base, lights: [{ azimuth: -40, elevation: 55, size: 1, color: [1, 1, 1], power: 1 }, { azimuth: 120, elevation: 30, size: 1, color: [1, 1, 1], power: 1 }] });
    expect(lum(two.get(70, 48))).toBeGreaterThan(lum(declared.get(70, 48)));
    // Night is darker than the studio everywhere in the sky; a sunset's horizon is warmer than its zenith.
    const night = renderBeauty(sphere, nets.mesh, sphere.bounds, { ...base, environment: "night" });
    expect(lum(night.get(48, 2))).toBeLessThan(lum(plain.get(48, 2)) / 3);
    const sunset = renderBeauty(sphere, nets.mesh, sphere.bounds, { ...base, environment: "sunset" });
    // The far floor fades to the sunset's warm ground; in the studio it fades to a near-grey.
    const far = sunset.get(48, 2), farPlain = plain.get(48, 2);
    expect(((far >> 16) & 255) - (far & 255)).toBeGreaterThan(((farPlain >> 16) & 255) - (farPlain & 255) + 20);
    // Somewhere down the left edge the backdrop passes through the warm band.
    let warmest = -255;
    for (let y = 0; y < 96; y++) { const c = sunset.get(1, y); warmest = Math.max(warmest, ((c >> 16) & 255) - (c & 255)); }
    expect(warmest).toBeGreaterThan(40);
    // A camera fitted to the points of one part fills the frame with it.
    const two_ = O.union([sphere, O.move(P.sphere(0.3), 3, 0, 0)]);
    const n2 = surfaceNets(two_, { resolution: 40 });
    const pts: number[] = [];
    for (let i = 0; i < n2.mesh.positions.length; i += 3) if (n2.mesh.positions[i] > 2) pts.push(n2.mesh.positions[i], n2.mesh.positions[i + 1], n2.mesh.positions[i + 2]);
    const small = { min: [2.6, -0.4, -0.4] as [number, number, number], max: [3.4, 0.4, 0.4] as [number, number, number] };
    const whole = renderBeauty(two_, n2.mesh, small, base);
    const fitted = renderBeauty(two_, n2.mesh, small, { ...base, fitPoints: new Float32Array(pts) });
    // Fitted, the small sphere is at the centre; fitted to everything, the centre pixel sees past it to the sky.
    expect(fitted.get(48, 48)).not.toBe(fitted.get(48, 2));
    expect(whole.get(48, 48)).not.toBe(fitted.get(48, 48));
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
