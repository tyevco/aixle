import { describe, expect, it } from "vitest";
import * as P from "../src/sdf/primitives.js";
import * as O from "../src/sdf/ops.js";
import { surfaceNets } from "../src/mesh/surfaceNets.js";
import { renderSheet, renderSlices, renderSteps, renderTurntable, renderView, INK, gridStep, defaultLevel, dimsLabel, meshSteps } from "../src/render/views.js";
import { createTarget, renderGhost, renderMesh } from "../src/render/raster.js";
import { attributeVertices, renderCallouts, hiddenFraction } from "../src/render/callouts.js";
import { decodePng, encodePng, encodeApng } from "../src/render/png.js";
import { albedo, coverage, sampleImage } from "../src/sdf/materials.js";
import type { ImageTexture } from "../src/sdf/types.js";
import { orthographic, perspective, project, toView } from "../src/render/camera.js";
import { customMaterial, materialFromString, preset } from "../src/sdf/materials.js";
import { Canvas, rgb } from "../src/render/canvas.js";
import { drawText, textWidth } from "../src/render/font.js";
import { renderBeauty, renderBeautyResult, type BeautyLight, type BeautyOptions } from "../src/render/beauty.js";
import { ADDS_TARGET, addsGain, encodePicture, gainText, lightFrames, lightStudy } from "../src/render/lightstudy.js";
import { BLOOM_THRESHOLD, encode, FLAG_EDGE, FLAG_GLOW, untone } from "../src/render/photometry.js";

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
    // Past the steps a model of a few units uses: a 4 mm part drawn in metres, a 100 m building in millimetres.
    expect(gridStep(0.005)).toBe(0.0005);
    expect(gridStep(1e5)).toBe(5000);
    // Inside them nothing moved (0.01 still for a span of 0.02 to 0.24).
    expect(gridStep(0.1)).toBe(0.01);
    expect(gridStep(24000)).toBe(1000);
    // A size under 0.005 prints its figures, not 0.
    expect(dimsLabel({ min: [0, 0, 0], max: [0.0044, 0.0025, 0.0036] })).toBe("0.0044 × 0.0025 × 0.0036");
    expect(dimsLabel({ min: [0, 0, 0], max: [4.36, 2.48, 3.6] })).toBe("4.36 × 2.48 × 3.6");
  });
  it("renders a model the same at any absolute size: the beauty render's steps follow the cell, a point light's default reach the model", () => {
    // A ball on a slab lit by one point light with no range, built at 1 and at 1/1000 and 100 times that: the same
    // picture. The beauty render's steps had a floor of 1e-4 units, three times the cell of a 4 mm part drawn in
    // metres, and lost its contact shadow; a point light reached 2 units, which lights a model in millimetres to
    // nothing.
    const at = (k: number) => {
      const shape = O.union([O.move(P.sphere(k), 0, 1.4 * k, 0), O.move(P.box(4 * k, 0.4 * k, 4 * k), 0, 0.2 * k, 0)]);
      const nets = surfaceNets(shape, { resolution: 48 });
      const light = { azimuth: 0, elevation: 0, size: 1, color: [1, 1, 1] as [number, number, number], power: 1.5, position: [k, 3 * k, 1.5 * k] as [number, number, number] };
      return renderBeauty(shape, nets.mesh, shape.bounds, { size: 64, cellSize: nets.cellSize, lights: [light] });
    };
    const mean = (c: Canvas) => { let t = 0; for (let y = 0; y < 56; y++) for (let x = 0; x < 64; x++) t += c.get(x, y) & 0xff; return t / (56 * 64); };
    const diff = (a: Canvas, b: Canvas) => { let n = 0; for (let y = 0; y < 56; y++) for (let x = 0; x < 64; x++) { const p = a.get(x, y), q = b.get(x, y); if (Math.abs((p & 0xff) - (q & 0xff)) + Math.abs(((p >> 8) & 0xff) - ((q >> 8) & 0xff)) + Math.abs(((p >> 16) & 0xff) - ((q >> 16) & 0xff)) > 24) n++; } return n / (56 * 64); };
    const one = at(1), tiny = at(0.001), big = at(100);
    expect(diff(one, tiny)).toBeLessThan(0.01);
    expect(diff(one, big)).toBeLessThan(0.01);
    expect(Math.abs(mean(one) - mean(big))).toBeLessThan(2);
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

describe("what a light adds", () => {
  // Glass, a mirror, a matte ball and a glowing ember under a key and a warm point light: every kind of light a slot
  // carries (direct, reflected, through glass, on the floor) and a glow, which is in no light's slot.
  const scene = O.union([
    O.paint(O.move(P.sphere(0.5), -0.6, 0.5, 0), materialFromString("chrome")!),
    O.paint(O.move(P.box(0.7, 1, 0.7), 0.6, 0.5, 0), materialFromString("amber")!),
    O.paint(O.move(P.sphere(0.3), 0.1, 0.3, 0.8), customMaterial({ color: [0.6, 0.6, 0.6], rough: 0.8 })),
    O.paint(O.move(P.sphere(0.12), -0.3, 0.12, 0.9), customMaterial({ color: [1, 0.7, 0.3], rough: 0.9, glow: 2 })),
  ]);
  const nets = surfaceNets(scene, { resolution: 40 });
  const lights: BeautyLight[] = [
    { name: "key", azimuth: -40, elevation: 50, size: 1.5, color: [1, 1, 1], power: 1 },
    { name: "lamp", azimuth: 0, elevation: 0, size: 1, color: [1, 0.75, 0.45], power: 1.2, position: [0.2, 1.3, 1.1], range: 1.2 },
  ];
  const opts: BeautyOptions = { size: 97, cellSize: nets.cellSize, lights, quality: "draft", label: "all" };

  it("is each light's own slot of one render: alone less none is the slot exactly, and 'all' is the render unsplit, byte for byte", () => {
    const r = renderBeautyResult(scene, nets.mesh, scene.bounds, { ...opts, splitLights: true });
    const f = lightFrames(r);
    expect(r.hdr!.length).toBe(3);
    const flags = r.flags!, shown = r.edgeDisplay!;
    expect(shown.length).toBe(97 * 97 * 9);
    const edge = (k: number) => (flags[Math.floor(k / 3)] & FLAG_EDGE) !== 0;
    for (let i = 0; i < lights.length; i++) {
      const slot = r.hdr![i + 1];
      let off = 0, worst = 0, gainOff = 0, lit = 0;
      for (let k = 0; k < slot.length; k++) {
        // What a light adds is its slot times its gain at every pixel, edges included.
        if (f.hdr.adds[i][k] !== slot[k] * f.gains[i]) gainOff++;
        if (slot[k] > 0.01) lit++;
        // At an edge pixel, alone and none are what the render's picture would take there (below); elsewhere slots.
        if (edge(k)) continue;
        const d = f.hdr.alone[i][k] - f.hdr.none[k];
        // Exact, but for a slot under 2^-29 of the sky's radiance there, which the double-precision sum rounds (one
        // value here: 1.7e-10 beside 0.17, off by 1e-17).
        if (d !== slot[k]) { off++; worst = Math.max(worst, Math.abs(d - slot[k]) / (f.hdr.alone[i][k] * Number.EPSILON)); }
      }
      expect(off, lights[i].name).toBeLessThanOrEqual(1);
      expect(worst, lights[i].name).toBeLessThanOrEqual(1);
      expect(gainOff, lights[i].name).toBe(0);
      expect(lit, lights[i].name).toBeGreaterThan(500);
      expect(f.gains[i]).toBe(addsGain(slot));
    }
    // Off the edges the none frame is slot 0, the sky's, unchanged; at an edge pixel each frame is the radiance its
    // samples' mean display colour under that frame's light stands for, as the render untones its own.
    const want = new Float64Array(3);
    let edges = 0;
    for (let p = 0; p < 97 * 97; p++) {
      if (!(flags[p] & FLAG_EDGE)) {
        for (let c = 0; c < 3; c++) expect(f.hdr.none[p * 3 + c]).toBe(r.hdr![0][p * 3 + c]);
        continue;
      }
      edges++;
      for (const [fr, lin] of [f.hdr.none, ...f.hdr.alone].entries()) {
        untone(shown[p * 9 + fr * 3], shown[p * 9 + fr * 3 + 1], shown[p * 9 + fr * 3 + 2], want, 0);
        expect([...lin.subarray(p * 3, p * 3 + 3)]).toEqual([...want]);
      }
    }
    expect(edges).toBeGreaterThan(300);
    // An unsplit render keeps none of it.
    expect(renderBeautyResult(scene, nets.mesh, scene.bounds, { ...opts, size: 32 }).edgeDisplay).toBeUndefined();
    // Each light's frame differs from the other's where they reach.
    let differ = 0;
    for (let k = 0; k < f.alone[0].data.length; k += 4) if (f.alone[0].data[k] !== f.alone[1].data[k]) differ++;
    expect(differ).toBeGreaterThan(97 * 97 * 0.3);
    // 'all' is the render's own picture, and that is the same render without the split, byte for byte.
    expect(f.all).toBe(r.canvas);
    expect(Buffer.from(renderBeauty(scene, nets.mesh, scene.bounds, opts).data).equals(Buffer.from(f.all.data))).toBe(true);
    // In full quality too.
    const full = { ...opts, quality: "full" as const, size: 64 };
    expect(Buffer.from(renderBeauty(scene, nets.mesh, scene.bounds, full).data).equals(Buffer.from(renderBeautyResult(scene, nets.mesh, scene.bounds, { ...full, splitLights: true }).canvas.data))).toBe(true);
  });

  it("finishes a frame as the render finishes its own picture", () => {
    // No pixel bright enough to bloom: then every pixel the edge pass did not resample is the render's own byte.
    const matte = O.union([O.move(P.box(1, 1, 1), 0, 0.5, 0), O.move(P.sphere(0.4), 0.9, 0.4, 0.3)]);
    const m = surfaceNets(matte, { resolution: 32 });
    const r = renderBeautyResult(matte, m.mesh, matte.bounds, { size: 80, cellSize: m.cellSize, lightSize: 2, quality: "draft" });
    expect(Math.max(...r.hdr![0])).toBeLessThan(BLOOM_THRESHOLD);
    const again = encodePicture(r.hdr![0], 80, r.flags);
    let same = 0, edges = 0;
    for (let i = 0; i < 80 * 80; i++) {
      if (r.flags![i] & FLAG_EDGE) { edges++; continue; }
      if ([0, 1, 2].every((c) => again.data[i * 4 + c] === r.canvas.data[i * 4 + c])) same++;
    }
    expect(edges).toBeGreaterThan(50);
    expect(same).toBe(80 * 80 - edges);
    // And a glow that blooms: under two lights of no power the picture is the sky's slot alone, so the picture under
    // no light and each light alone are the render's own, byte for byte, silhouettes and the bloom round them
    // included. Composed from the slots, which keep an edge pixel's four samples only as their linear mean where the
    // picture means them after the tone curve, they differed in 270 edge pixels, by up to 63 levels at the glow's
    // edge, and the bloom spread up to 6 into 369 more round it (roadmap 29). Without the bloom the glow's halo
    // would be missing.
    const ember = O.union([matte, O.paint(O.move(P.sphere(0.25), -0.2, 1.25, 0.2), customMaterial({ color: [1, 0.7, 0.3], glow: 3 }))]);
    const e = surfaceNets(ember, { resolution: 32 });
    const lamps = (powers: number[]): BeautyLight[] => powers.map((power, k) => ({ name: `l${k}`, azimuth: -40 + 90 * k, elevation: 50, size: 1, color: [1, 1, 1], power }));
    const g = renderBeautyResult(ember, e.mesh, ember.bounds, { size: 80, cellSize: e.cellSize, lights: lamps([0, 0]), quality: "draft", splitLights: true });
    const dark = lightFrames(g), flat = encodePicture(g.hdr![0], 80);
    for (const frame of [dark.none, ...dark.alone]) expect(Buffer.from(frame.data).equals(Buffer.from(g.canvas.data))).toBe(true);
    let haloed = 0;
    for (let i = 0; i < 80 * 80; i++) if (dark.none.data[i * 4] !== flat.data[i * 4]) haloed++;
    expect(haloed).toBeGreaterThan(300);
    // One light lit and one of no power: the lit light alone is the render's own picture. At an edge pixel it is the
    // same samples' display mean to the bit; off the edges its slots, each rounded to a float before they are summed,
    // may move a pixel a level. Composed from the slots' linear means it differed in 289 edge channels, by up to 60
    // levels at the glow's edge.
    const half = renderBeautyResult(ember, e.mesh, ember.bounds, { size: 80, cellSize: e.cellSize, lights: lamps([0, 1]), quality: "draft", splitLights: true });
    const lit = lightFrames(half).alone[1];
    let moved = 0, most = 0;
    for (let i = 0; i < 80 * 80; i++)
      for (let c = 0; c < 3; c++) {
        const d = Math.abs(lit.data[i * 4 + c] - half.canvas.data[i * 4 + c]);
        if (d) moved++;
        most = Math.max(most, d);
      }
    expect(most).toBeLessThanOrEqual(1);
    expect(moved).toBeLessThan(10);
  });

  it("draws each frame of a lit study as a render under that frame's lights alone draws its picture, silhouettes included", () => {
    // Both lights lit, so every frame's silhouettes differ from the picture's, and both point lights: a point light's
    // power reaches neither the floor's albedo (solved from the directional lights) nor the sky (only a directional
    // light has a softbox), so the render with the other lights at no power is the frame's exact answer. Composed from
    // the slots' linear means the frames differed from it in 216 to 267 edge pixels, by up to 63 levels at the glow's
    // edge, and the bloom spread up to 6 round it; edges taken from the picture under all the lights differ as well.
    const matte = O.union([O.move(P.box(1, 1, 1), 0, 0.5, 0), O.move(P.sphere(0.4), 0.9, 0.4, 0.3)]);
    const ember = O.union([matte, O.paint(O.move(P.sphere(0.25), -0.2, 1.25, 0.2), customMaterial({ color: [1, 0.7, 0.3], glow: 3 }))]);
    const e = surfaceNets(ember, { resolution: 32 });
    const points = (a: number, b: number): BeautyLight[] => [
      { name: "a", azimuth: 0, elevation: 0, size: 1, color: [1, 1, 1], power: a, position: [-1.2, 2, 1.5], range: 3 },
      { name: "b", azimuth: 0, elevation: 0, size: 1, color: [1, 0.8, 0.6], power: b, position: [1.4, 1.6, 1.2], range: 3 },
    ];
    const render = (a: number, b: number) => renderBeautyResult(ember, e.mesh, ember.bounds, { size: 80, cellSize: e.cellSize, lights: points(a, b), quality: "draft", splitLights: true });
    const lit = render(1, 1);
    const f = lightFrames(lit);
    let edges = 0;
    for (let i = 0; i < 80 * 80; i++) if (lit.flags![i] & FLAG_EDGE) edges++;
    expect(edges).toBeGreaterThan(300);
    for (const [name, frame, a, b] of [["none", f.none, 0, 0], ["a alone", f.alone[0], 1, 0], ["b alone", f.alone[1], 0, 1]] as const) {
      const want = render(a, b);
      // The same pixels are edges whatever the lights' power, in draft.
      expect(Buffer.from(want.flags!).equals(Buffer.from(lit.flags!)), name).toBe(true);
      let moved = 0, most = 0, fromAll = 0;
      for (let i = 0; i < 80 * 80; i++)
        for (let c = 0; c < 3; c++) {
          const d = Math.abs(frame.data[i * 4 + c] - want.canvas.data[i * 4 + c]);
          if (d) moved++;
          most = Math.max(most, d);
          if (lit.flags![i] & FLAG_EDGE && Math.abs(want.canvas.data[i * 4 + c] - lit.canvas.data[i * 4 + c]) > 8) fromAll++;
        }
      // Off the edges a frame's slots are each rounded to a float before they are summed, which may move a level.
      expect(most, name).toBeLessThanOrEqual(1);
      expect(moved, name).toBeLessThan(10);
      // And the frame is not the picture under all the lights: its edges are its own.
      expect(fromAll, name).toBeGreaterThan(50);
    }
  });

  it("brightens a light's share until most of what it reaches shows near white, 1 to 32 times", () => {
    // 990 pixels at 0.1 and five saturated sparks: the sparks do not set the gain, the 99th percentile does.
    const slot = (n: number, v: number, sparks = 0) => {
      const s = new Float32Array((n + sparks + 500) * 3);
      for (let i = 0; i < n; i++) { s[i * 3] = v; s[i * 3 + 1] = v / 2; }
      for (let i = n; i < n + sparks; i++) s[i * 3] = 10;
      return s;
    };
    expect(addsGain(slot(990, 0.1, 5))).toBeCloseTo(ADDS_TARGET / 0.1, 4);
    expect(addsGain(slot(990, 0.001))).toBe(32);
    expect(addsGain(slot(990, 3))).toBe(1);
    // A light that reaches nothing is not brightened.
    expect(addsGain(slot(0, 0))).toBe(1);
    // The target displays at 230 of 255.
    const o = new Float64Array(3);
    encode(ADDS_TARGET, ADDS_TARGET, ADDS_TARGET, o, 0);
    expect(Math.round(o[0] * 255)).toBe(230);
    expect(gainText(1.02)).toBe("");
    expect(gainText(3.27)).toBe(", ×3.3");
  });

  it("lays each light's frames out in its own column, every frame captioned in ink that stands out from the picture under it", () => {
    // A mid-grey sky slot (the lantern's rim and flame frames, and its picture under no light, were mid-grey floors
    // under mid-grey captions: unreadable), a strong key that whitens its frames, a faint fill.
    const size = 96, n = size * size * 3;
    const fill = (v: number) => new Float32Array(n).fill(v);
    const slots = [fill(0.16), fill(0.6), fill(0.03)];
    const total = new Float32Array(n);
    for (const s of slots) for (let k = 0; k < n; k++) total[k] += s[k];
    const r = { canvas: encodePicture(total, size), hdr: slots, flags: new Uint8Array(size * size) };
    const ref = lightFrames({ ...r, canvas: encodePicture(total, size) });
    const study = lightStudy(r, [{ name: "key", caption: "az -40 el 50" }, { name: "fill", caption: "az 150 el 20  power 0.1" }]);
    const luma = (d: Uint8Array, o: number) => 0.2126 * d[o] + 0.7152 * d[o + 1] + 0.0722 * d[o + 2];
    const rowY = 26 + 6, lowY = rowY + size + 6 + 16;
    const frames: [string, Canvas, number, number][] = [
      ["key alone", ref.alone[0], 0, rowY], ["fill alone", ref.alone[1], 1, rowY], ["all", ref.all, 2, rowY],
      ["key adds", ref.adds[0], 0, lowY], ["fill adds", ref.adds[1], 1, lowY], ["no light", ref.none, 2, lowY],
    ];
    for (const [name, frame, col, y0] of frames) {
      const x0 = 6 + col * (size + 6);
      let glyph = 0, faint = 0, other = 0;
      for (let y = 0; y < size; y++)
        for (let x = 0; x < size; x++) {
          const a = ((y0 + y) * study.width + x0 + x) * 4, b = (y * size + x) * 4;
          const same = [0, 1, 2].every((c) => study.data[a + c] === frame.data[b + c]);
          if (same) continue;
          // What differs is the caption, at the frame's foot; anything else is a frame in the wrong place.
          if (y < size - 14) { other++; continue; }
          glyph++;
          if (Math.abs(luma(study.data, a) - luma(frame.data, b)) < 80) faint++;
        }
      expect(other, name).toBe(0);
      expect(glyph, name).toBeGreaterThan(20);
      expect(faint, name).toBe(0);
    }
  });

  it("shows on a glowing part what the light does to its colour, with no glow in it (round 11: a flame read bright green)", () => {
    // The same flame with and without its glow: what each light adds is the same, to the byte, since a glow is in
    // the sky's slot; only the picture under no light changes.
    const flame = (glow: number) => O.union([
      O.paint(O.move(P.box(1.4, 0.6, 1), 0, 0.3, -0.3), customMaterial({ color: [0.5, 0.45, 0.4], rough: 0.9 })),
      O.paint(O.move(P.sphere(0.3), 0, 0.9, 0.2), customMaterial({ color: [1, 0.7, 0.3], rough: 0.9, glow })),
    ]);
    const two: BeautyLight[] = [
      { name: "key", azimuth: -40, elevation: 50, size: 1.5, color: [1, 1, 1], power: 1 },
      { name: "moon", azimuth: 120, elevation: 40, size: 2, color: [0.62, 0.7, 1], power: 0.35 },
    ];
    const study = (glow: number) => {
      const shape = flame(glow);
      const mm = surfaceNets(shape, { resolution: 40 });
      const r = renderBeautyResult(shape, mm.mesh, shape.bounds, { size: 72, cellSize: mm.cellSize, lights: two, quality: "draft", splitLights: true });
      return { r, f: lightFrames(r) };
    };
    const lit = study(2), plain = study(0);
    for (let i = 0; i < 2; i++) {
      expect(Buffer.from(lit.f.adds[i].data).equals(Buffer.from(plain.f.adds[i].data)), two[i].name).toBe(true);
      expect(lit.f.gains[i]).toBe(plain.f.gains[i]);
    }
    expect(Buffer.from(lit.f.none.data).equals(Buffer.from(plain.f.none.data))).toBe(false);
    // On the flame, what the white key adds is the flame's own warm colour, red over green over blue, never grey,
    // wherever it reaches; the two pictures' difference there, as lights.png took it, is blue (253, 249, 131 under no
    // light and 254, 251, 150 under the key: the channels not already full).
    const flags = lit.r.flags!;
    const px = (c: { data: Uint8Array }, i: number) => [...c.data.slice(i * 4, i * 4 + 3)];
    let reached = 0, warm = 0, blue = 0;
    for (let i = 0; i < 72 * 72; i++) {
      if (!(flags[i] & FLAG_GLOW) || flags[i] & FLAG_EDGE) continue;
      const [r, g, b] = px(lit.f.adds[0], i);
      if (r + g + b < 60) continue;
      reached++;
      if (r > g && g > b) warm++;
      const [r0, g0, b0] = px(lit.f.none, i), [r1, g1, b1] = px(lit.f.alone[0], i);
      if (b1 - b0 > Math.max(r1 - r0, g1 - g0)) blue++;
    }
    expect(reached).toBeGreaterThan(80);
    expect(warm).toBe(reached);
    expect(blue / reached).toBeGreaterThan(0.9);
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
  it("credits a face only to a step whose own surface faces the same way there, not to a thin operand running through it", () => {
    // Round 11: the mixer's slab, the 0.06-thick operand of `(cavity | offset(-inset)) & slab`, runs down through the
    // base inside its own box, so on the base's top a strip within a cell of the slab's side faces was "on" the
    // slab's field (the slab is the smaller box) and callouts.png labelled SLAB on the base beside the plate.
    const base = O.move(P.box(2, 0.4, 2), 0, 0.2, 0);
    const slab = O.move(P.box(1.6, 2, 0.12), 0, 1, 0);
    const paddle = O.intersect(slab, O.move(P.sphere(0.5), 0, 1.2, 0));
    const model = O.union([base, paddle]);
    const nets = surfaceNets(model, { resolution: 64 });
    const steps = [{ name: "base", shape: base }, { name: "slab", shape: slab }, { name: "paddle", shape: paddle }];
    const owner = attributeVertices(nets.mesh, steps, nets.cellSize, 1, model);
    let onTop = 0, slabOnTop = 0;
    for (let v = 0; v < owner.length; v++) {
      const y = nets.mesh.positions[v * 3 + 1], ny = nets.mesh.normals[v * 3 + 1];
      if (Math.abs(y - 0.4) > nets.cellSize * 0.5 || ny < 0.9) continue;
      onTop++;
      if (owner[v] === 1) slabOnTop++;
    }
    expect(onTop).toBeGreaterThan(100);
    expect(slabOnTop).toBe(0);
    // The paddle's own faces are still the paddle's.
    expect([...owner].filter((o) => o === 2).length).toBeGreaterThan(50);
  });
});

describe("animated PNG", () => {
  it("writes the acTL, an fcTL per frame, the first frame in IDAT and the rest in fdAT, and decodes to its first frame", () => {
    const w = 3, h = 2;
    const f1 = new Uint8Array(w * h * 4).fill(255), f2 = new Uint8Array(w * h * 4).fill(0);
    const buf = encodeApng(w, h, [f1, f2], 50);
    const types: string[] = [];
    for (let i = 8; i < buf.length; ) { const len = buf.readUInt32BE(i); types.push(buf.toString("latin1", i + 4, i + 8)); i += 12 + len; }
    expect(types).toEqual(["IHDR", "acTL", "fcTL", "IDAT", "fcTL", "fdAT", "IEND"]);
    expect(buf.readUInt32BE(buf.indexOf("acTL") + 4)).toBe(2);
    const first = decodePng(buf);
    expect([first.width, first.height, first.rgba[0]]).toEqual([3, 2, 255]);
    expect(() => encodeApng(w, h, [], 50)).toThrow(/at least one frame/);
  });
});

describe("a hidden focus", () => {
  it("measures how much of a part the rest of the model hides from a view", () => {
    // A small sphere behind a wall: hidden from the front, in the clear from behind, half seen from the side.
    const wall = O.move(P.box(2, 2, 0.2), 0, 0, 1);
    const ball = O.move(P.sphere(0.3), 0, 0, 0);
    const model = O.union([wall, ball]);
    const nets = surfaceNets(model, { resolution: 40 });
    const info = { name: "m", bounds: model.bounds };
    expect(hiddenFraction(nets.mesh, ball.bounds, info, nets.cellSize, 0, 5)).toBeGreaterThan(0.8);
    expect(hiddenFraction(nets.mesh, ball.bounds, info, nets.cellSize, 180, 5)).toBeLessThan(0.2);
    expect(hiddenFraction(nets.mesh, { min: [5, 5, 5], max: [6, 6, 6] }, info, nets.cellSize, 0, 5)).toBe(0);
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
