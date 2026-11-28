import { describe, expect, it } from "vitest";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import * as P from "../src/sdf/primitives.js";
import * as O from "../src/sdf/ops.js";
import { customMaterial, materialFromString } from "../src/sdf/materials.js";
import type { Material, Shape3 } from "../src/sdf/types.js";
import { surfaceNets } from "../src/mesh/surfaceNets.js";
import { beautyCamera, beautyPrime, renderBeauty, renderBeautyResult, type BeautyLight, type BeautyOptions } from "../src/render/beauty.js";
import { allocBuffers, beautyCache, materialIds, materialKey, type Buffers } from "../src/render/kernel.js";
import { pbr, sceneLights, type PbrTables } from "../src/render/pbr.js";
import { perspective, project, toView, type Camera } from "../src/render/camera.js";
import { buildEnvironment, DEFAULT_LIGHT_DIRECTION, defaultKey, ENVIRONMENTS, environmentPalette, lightDirection, prefilterLevels, projectSh, skyAt, STEEP, type EnvironmentState } from "../src/render/environment.js";
import { encode, FLAG_EDGE, KEY, KIND_FLOOR, KIND_MASK, KIND_MODEL } from "../src/render/photometry.js";
import { lastPoolRows, openBeautyPool } from "../src/render/beauty-pool.js";
import { check } from "../src/pipeline.js";

/**
 * The pbr kernel's shading, measured in linear radiance: the units a light's power is in, energy kept by the BRDF in a
 * constant sky, a metal's reflectance, a point light's falloff, the split slots, the bytes on the pool, glass.
 */

/** A render through the kernel's own passes, for its HDR and its buffers; `env` stands in for the palette's sky. */
function shade(shape: Shape3, opts: Omit<BeautyOptions, "cellSize">, resolution = 40, env?: EnvironmentState): { hdr: Float32Array; slots: Float32Array[]; buffers: Buffers; size: number; camera: Camera } {
  const nets = surfaceNets(shape, { resolution });
  const mesh = nets.mesh, bounds = shape.bounds, size = opts.size;
  const o: BeautyOptions = { ...opts, cellSize: nets.cellSize };
  const camera = beautyCamera(mesh, bounds, o);
  const prime = beautyPrime(mesh, camera, size);
  const tables = pbr.prepare!({ shape, mesh, bounds, opts: o, camera, prime, size, cell: nets.cellSize, cache: beautyCache(), shared: false }) as PbrTables;
  if (env) tables.env = env;
  const buffers = allocBuffers(pbr.layout(o, size), size, false);
  const ctx = { shape, mesh, bounds, opts: o, camera, prime, size, cell: nets.cellSize, buffers, tables, ids: materialIds(mesh.materials.map(materialKey)) };
  const rows = pbr.rows(ctx);
  for (let y = 0; y < size; y++) rows.primary(y);
  for (let y = 0; y < size; y++) rows.edges(y);
  const res = pbr.finish(ctx);
  const slots = res.hdr!;
  const hdr = new Float32Array(size * size * 3);
  for (const s of slots) for (let k = 0; k < hdr.length; k++) hdr[k] += s[k];
  return { hdr, slots, buffers, size, camera };
}

/**
 * The kernel's first pass alone, no edge pass and no filter: each pixel's one centre sample, its radiance per slot
 * (R, 3 floats a slot) as it leaves the rows. Two renders that differ only in a budget the centre samples share can be
 * compared pixel for pixel.
 */
function primaryOnly(shape: Shape3, opts: Omit<BeautyOptions, "cellSize">, resolution = 40): { R: Float32Array; size: number; W: number } {
  const nets = surfaceNets(shape, { resolution });
  const mesh = nets.mesh, bounds = shape.bounds, size = opts.size;
  const o: BeautyOptions = { ...opts, cellSize: nets.cellSize };
  const camera = beautyCamera(mesh, bounds, o);
  const prime = beautyPrime(mesh, camera, size);
  const tables = pbr.prepare!({ shape, mesh, bounds, opts: o, camera, prime, size, cell: nets.cellSize, cache: beautyCache(), shared: false }) as PbrTables;
  const buffers = allocBuffers(pbr.layout(o, size), size, false);
  const rows = pbr.rows({ shape, mesh, bounds, opts: o, camera, prime, size, cell: nets.cellSize, buffers, tables, ids: materialIds(mesh.materials.map(materialKey)) });
  for (let y = 0; y < size; y++) rows.primary(y);
  return { R: buffers.R as Float32Array, size, W: (buffers.R as Float32Array).length / (size * size) };
}

/** The studio's tables with the sky replaced by a constant radiance L everywhere: no structure, cards, sun or stars. */
function constantSky(L: number): EnvironmentState {
  const s = buildEnvironment("studio", { cameraAzimuth: 35, lights: [] });
  const flat = (_x: number, _y: number, _z: number, out: Float64Array) => { out[0] = L; out[1] = L; out[2] = L; };
  return {
    ...s, ambient: 1, walls: 0, zenith: 1, flag: 0, shadow: 0, stars: 0, reflect: { ...s.reflect, walls: 0, zenith: 1, flag: 0 },
    grad: new Float64Array(s.grad.length).fill(L), below: new Float64Array(3).fill(L),
    cards: new Float64Array(0), disc: new Float64Array(0), boxes: new Float64Array(0),
    sh: projectSh(flat), levels: prefilterLevels(flat),
  };
}

const white = (rough: number, metal = 0): Material => customMaterial({ color: [1, 1, 1], rough, metal });
const dark: BeautyLight = { azimuth: 0, elevation: 90, size: 1, color: [1, 1, 1], power: 0 };

/** The mean of channel c (or of all three) over the pixels a predicate picks. */
function meanOver(hdr: Float32Array, pick: (i: number) => boolean, n: number, c = -1): number {
  let s = 0, k = 0;
  for (let i = 0; i < n; i++) if (pick(i)) { s += c < 0 ? (hdr[i * 3] + hdr[i * 3 + 1] + hdr[i * 3 + 2]) / 3 : hdr[i * 3 + c]; k++; }
  return k ? s / k : NaN;
}

describe("shading: units and energy", () => {
  it("a white Lambert face square to a power-1 key and no sky sends back KEY, less the share Fresnel's reflection takes", () => {
    // A slab's top lit from straight above, the sky's light off (ambient 0): every top pixel away from the edges.
    const slab = O.paint(O.move(P.box(4, 0.4, 4), 0, 0.2, 0), white(1));
    const r = shade(slab, { size: 64, ambient: 0, elevation: 35, lights: [{ azimuth: 0, elevation: 90, size: 0.5, color: [1, 1, 1], power: 1 }] });
    const { flags, normal } = r.buffers as { flags: Uint8Array; normal: Float32Array };
    const top = (i: number) => (flags[i] & KIND_MASK) === KIND_MODEL && !(flags[i] & FLAG_EDGE) && normal[i * 3 + 1] > 0.99;
    const got = meanOver(r.hdr, top, 64 * 64);
    // The diffuse part is KEY·(1 − F) with F Schlick's 0.04 at the half vector (the camera 35° up: v·h = cos 27.5°),
    // and the rough lobe returns F·D·V·π: at rough 1 that is under 0.4 of F. So KEY within 3%, and above 1.
    const F = 0.04 + 0.96 * Math.pow(1 - Math.cos((27.5 * Math.PI) / 180), 5);
    expect(got).toBeGreaterThan(KEY * (1 - F) * 0.99);
    expect(got).toBeLessThan(KEY * (1 - F + F * 0.45) * 1.01);
    expect(Math.abs(got - KEY) / KEY).toBeLessThan(0.03);
  });

  it("keeps the energy of a constant sky: a white sphere of any roughness, dielectric or metal, returns E·L within 5%", () => {
    // The sky's intensity E is `set ambient` times the palette's, neither of them 1 here, so a kernel that dropped
    // either from its diffuse or its reflected light, or took one of them twice, is out by far more than 5%.
    const L = 0.8, ambient = 0.5, palette = 1.3, EL = L * ambient * palette;
    for (const metal of [0, 1])
      for (const rough of [0.2, 0.3, 0.5, 1]) {
        // High above the floor, so nothing but the sky is round it.
        const ball = O.paint(O.move(P.sphere(1), 0, 6, 0), white(rough, metal));
        const r = shade(ball, { size: 64, ambient, lights: [dark] }, 32, { ...constantSky(L), ambient: palette });
        const { flags } = r.buffers as { flags: Uint8Array };
        const got = meanOver(r.hdr, (i) => (flags[i] & KIND_MASK) === KIND_MODEL && !(flags[i] & FLAG_EDGE), 64 * 64);
        expect(Math.abs(got - EL) / EL, `rough ${rough} metal ${metal}: ${got}`).toBeLessThan(0.05);
      }
  });

  it("a polished metal seen square-on returns its F0 times the sky", () => {
    const L = 0.5, f0 = [0.95, 0.64, 0.54];
    const copper = customMaterial({ color: f0.map((v) => (v <= 0.0031308 ? v * 12.92 : 1.055 * Math.pow(v, 1 / 2.4) - 0.055)) as [number, number, number], rough: 0.05, metal: 1 });
    // A slab's front face, the camera square to it.
    const face = O.paint(O.move(P.box(4, 4, 0.4), 0, 6, 0), copper);
    const r = shade(face, { size: 64, azimuth: 0, elevation: 0, lights: [dark] }, 32, constantSky(L));
    const { flags, normal } = r.buffers as { flags: Uint8Array; normal: Float32Array };
    const front = (i: number) => (flags[i] & KIND_MASK) === KIND_MODEL && !(flags[i] & FLAG_EDGE) && normal[i * 3 + 2] > 0.99;
    for (let c = 0; c < 3; c++) expect(Math.abs(meanOver(r.hdr, front, 64 * 64, c) - f0[c] * L) / (f0[c] * L), `channel ${c}`).toBeLessThan(0.03);
  });

  it("a point light's radiance halves at its range", () => {
    const range = 2, size = 48;
    const slab = O.paint(O.move(P.box(8, 0.4, 8), 0, 0.2, 0), white(1));
    const opts = { size, ambient: 0, elevation: 35 };
    const sun = shade(slab, { ...opts, lights: [{ azimuth: 0, elevation: 90, size: 0.2, color: [1, 1, 1], power: 1 }] }, 32);
    // The point the middle pixel sees, from its depth along its ray.
    const cam = sun.camera, i = (size / 2) * size + size / 2;
    const f = size / 2 / Math.tan(((cam.fov ?? 30) * Math.PI) / 360), u = 0.5 / f;
    const d = [0, 1, 2].map((k) => cam.right[k] * u - cam.up[k] * u + cam.forward[k]);
    const dl = Math.hypot(d[0], d[1], d[2]), t = (sun.buffers.depth as Float32Array)[i];
    const p = [0, 1, 2].map((k) => cam.eye[k] + (d[k] / dl) * t);
    // A point light straight above it at its range: the same light direction and view, so the BRDF cancels and the
    // ratio to a directional light of the same power straight above is the falloff, range² / (range² + d²) = 1/2.
    const lamp = shade(slab, { ...opts, lights: [{ azimuth: 0, elevation: 0, size: 0.2, color: [1, 1, 1], power: 1, position: [p[0], p[1] + range, p[2]], range }] }, 32);
    for (let c = 0; c < 3; c++) expect(lamp.hdr[i * 3 + c] / sun.hdr[i * 3 + c]).toBeCloseTo(0.5, 2);
  });

  it("shows the open floor near the model as the old renderer displayed it, in every sky", () => {
    // The old renderer lit its floor colour and faded it, so the open floor it displayed was darker than the colour
    // (studio 211 levels, not 224; a night's 13, not 36). Solved to the colour itself, a night's floor came out three
    // times as bright and the studio's merged with the sweep behind it.
    const clay = materialFromString("clay")!;
    const pair = O.union([O.paint(O.move(P.sphere(0.3), -2, 0.3, 0), clay), O.paint(O.move(P.sphere(0.3), 2, 0.3, 0), clay)]);
    for (const env of ENVIRONMENTS) {
      const size = 64;
      const r = shade(pair, { size, environment: env }, 24);
      const { flags, V } = r.buffers as { flags: Uint8Array; V: Float32Array };
      // The bottom middle: open floor between the two balls, lit by the key, near enough to be solved, past any contact.
      const out = [0, 0, 0], shown: number[][] = [];
      for (let y = size - 8; y < size; y++)
        for (let x = 24; x < 40; x++) {
          const i = y * size + x;
          if ((flags[i] & KIND_MASK) !== KIND_FLOOR || flags[i] & FLAG_EDGE || V[i] < 0.999) continue;
          encode(r.hdr[i * 3], r.hdr[i * 3 + 1], r.hdr[i * 3 + 2], out);
          shown.push(out.map((v) => v * 255));
        }
      expect(shown.length, env).toBeGreaterThan(100);
      const open = environmentPalette(env).open;
      for (let c = 0; c < 3; c++) {
        const mean = shown.reduce((a, p) => a + p[c], 0) / shown.length;
        expect(Math.abs(mean - open[c] * 255), `${env} channel ${c}`).toBeLessThan(2.5);
      }
    }
  });

  it("splits the light into slots that sum to the unsplit render", () => {
    const scene = O.union([
      O.paint(O.move(P.sphere(0.6), -0.7, 0.6, 0), materialFromString("chrome")!),
      O.paint(O.move(P.box(0.8, 1, 0.8), 0.6, 0.5, 0), materialFromString("amber")!),
      O.paint(O.move(P.sphere(0.4), 0.2, 0.4, 0.9), customMaterial({ color: [0.6, 0.6, 0.6], rough: 0.8 })),
    ]);
    const lights: BeautyLight[] = [
      { azimuth: -40, elevation: 50, size: 1, color: [1, 1, 1], power: 1 },
      { azimuth: 150, elevation: 25, size: 2, color: [0.8, 0.9, 1], power: 0.5 },
      { azimuth: 0, elevation: 0, size: 1, color: [1, 0.7, 0.4], power: 1, position: [0.1, 1.4, 0.9], range: 1.2 },
    ];
    const one = shade(scene, { size: 64, lights }, 36);
    const split = shade(scene, { size: 64, lights, splitLights: true }, 36);
    expect(split.slots.length).toBe(4);
    let worst = 0;
    for (let k = 0; k < one.hdr.length; k++) worst = Math.max(worst, Math.abs(split.hdr[k] - one.hdr[k]) / Math.max(1e-3, one.hdr[k]));
    expect(worst).toBeLessThan(1e-5);
    // Each light's slot holds light where that light reaches and nothing it cannot: the sky's slot is not the whole.
    for (const s of split.slots) expect(s.some((v) => v > 0.01)).toBe(true);
    // And all of it: the point light's slot is what the render gains by it, directly, on the floor, through the amber
    // and in the chrome. (The point light is the one the floor's albedo does not depend on, and no surface here takes
    // the glossy rays' clamp, so the light adds linearly; edge pixels, which the brightness test picks from the total,
    // are left out.)
    const dark = shade(scene, { size: 64, lights: lights.map((l, i) => (i === 2 ? { ...l, power: 0 } : l)) }, 36);
    const fa = split.buffers.flags as Uint8Array, fb = dark.buffers.flags as Uint8Array;
    let added = 0, gap = 0;
    for (let i = 0; i < 64 * 64; i++) {
      if ((fa[i] | fb[i]) & FLAG_EDGE) continue;
      for (let c = 0; c < 3; c++) {
        const gain = one.hdr[i * 3 + c] - dark.hdr[i * 3 + c];
        added += gain;
        gap = Math.max(gap, Math.abs(split.slots[3][i * 3 + c] - gain) / Math.max(1e-2, one.hdr[i * 3 + c]));
      }
    }
    expect(added).toBeGreaterThan(1);
    expect(gap).toBeLessThan(1e-4);
  });

  it("draws the same bytes on one thread and on four", () => {
    const src = 'ball = sphere(0.5) | move(-0.6, 0.5, 0) | paint("gold")\npane = box(0.8, 1.2, 0.8) | move(0.6, 0.6, 0) | paint("amber")\nember = sphere(0.15) | move(0, 0.15, 0.7) | paint(material("#ffd27a", glow=1.5))\nshow ball + pane + ember';
    const shape = check(src, "glass.aix").output!;
    const nets = surfaceNets(shape, { resolution: 40 });
    const opts: BeautyOptions = { size: 96, cellSize: nets.cellSize, environment: "sunset", dof: 1, lights: [{ azimuth: -40, elevation: 55, size: 1, color: [1, 1, 1], power: 1 }, { azimuth: 0, elevation: 0, size: 0.5, color: [1, 0.8, 0.6], power: 0.8, position: [0.2, 1.4, 1.0], range: 1.5 }] };
    const sha = (b: Uint8Array) => createHash("sha256").update(b).digest("hex");
    const one = sha(renderBeauty(shape, nets.mesh, shape.bounds, opts).data);
    const pool = openBeautyPool(4)!;
    pool.warm({ source: src, sourceName: "glass.aix" });
    expect(pool.waitReady()).toBe(true);
    const four = sha(renderBeauty(shape, nets.mesh, shape.bounds, { ...opts, pool }).data);
    pool.close();
    expect(four).toBe(one);
  });

  it("draws the same linear light, bit for bit, on one thread and on three, at an odd size, twice on one pool", () => {
    // Glass seen through glass, a mirror, a glossy metal, a point light and a glow, the light split per slot: every
    // float of every slot, not only the bytes the tone curve and the dither keep. An odd size gives the threads rows of
    // uneven work, and the second render on the same pool finds whatever the first one left.
    const src = 'cup = revolve(polygon(0,0, 0.45,0, 0.55,1.1, 0.48,1.1, 0.38,0.08, 0,0.08)) | paint("glass")\ntea = cylinder(0.37, 0.6) | move(0, 0.33, 0) | paint("amber")\norb = sphere(0.3) | move(0.8, 0.3, 0.3) | paint("chrome")\nnut = sphere(0.25) | move(-0.8, 0.25, 0.2) | paint("gold")\nember = sphere(0.08) | move(0.3, 0.08, 0.6) | paint(material("#ffb050", glow=2))\nshow cup + tea + orb + nut + ember';
    const shape = check(src, "cup.aix").output!;
    const nets = surfaceNets(shape, { resolution: 48 });
    const opts: BeautyOptions = { size: 77, cellSize: nets.cellSize, splitLights: true, lights: [{ azimuth: -40, elevation: 50, size: 1.5, color: [1, 1, 1], power: 1 }, { azimuth: 0, elevation: 0, size: 1, color: [1, 0.7, 0.4], power: 1.2, position: [0.3, 0.5, 0.6], range: 1.2 }] };
    const bits = (r: { canvas: { data: Uint8Array }; hdr?: Float32Array[] }) => createHash("sha256").update(r.canvas.data).update(new Uint8Array(r.hdr!.flatMap((h) => Array.from(new Uint8Array(h.buffer))))).digest("hex");
    const one = bits(renderBeautyResult(shape, nets.mesh, shape.bounds, opts));
    const pool = openBeautyPool(3)!;
    pool.warm({ source: src, sourceName: "cup.aix" });
    expect(pool.waitReady()).toBe(true);
    const a = bits(renderBeautyResult(shape, nets.mesh, shape.bounds, { ...opts, pool }));
    const b = bits(renderBeautyResult(shape, nets.mesh, shape.bounds, { ...opts, pool }));
    // The workers drew rows of it, not the main thread alone.
    const rows = lastPoolRows();
    pool.close();
    expect(rows.length).toBe(3);
    expect(rows.slice(1).some((n) => n > 0)).toBe(true);
    expect(a).toBe(one);
    expect(b).toBe(one);
  });
});

describe("shading: glass", () => {
  it("draws a tumbler's base with no white triangles and its drink with no contour bands", () => {
    // The example tumbler without its depth of field, which would blur away what this looks for.
    const src = readFileSync(new URL("../examples/tumbler.aix", import.meta.url), "utf8").replace(/^set dof .*$/m, "");
    const shape = check(src, "tumbler.aix").output!;
    const size = 256;
    const nets = surfaceNets(shape, { resolution: 64 });
    const opts = { size, cellSize: nets.cellSize, lightSize: 2.5 };
    const r = renderBeautyResult(shape, nets.mesh, shape.bounds, opts);
    const c = r.canvas;
    // The drink seen through the side wall starts below where its surface meets the near wall: above that row the
    // camera looks down through the glass onto the drink's surface, a face of its own (lighter for the sky it reflects),
    // and the step between the two is the drink's front rim, not a contour band.
    const a = (35 * Math.PI) / 180, cam = beautyCamera(nets.mesh, shape.bounds, opts);
    const rim = Math.ceil(project(cam, toView(cam, [1.32 * Math.sin(a), 0.26 + 2.4, 1.32 * Math.cos(a)]))!.y) + 4;
    const rgbAt = (x: number, y: number) => { const p = c.get(x, y); return [(p >> 16) & 255, (p >> 8) & 255, p & 255]; };
    const lum = (x: number, y: number) => { const [R, G, B] = rgbAt(x, y); return 0.2126 * R + 0.7152 * G + 0.0722 * B; };
    // The drink's body seen through the wall: orange, mid-bright. Down the middle column, its longest run of rows.
    const body = (x: number, y: number) => { const [R, , B] = rgbAt(x, y); const l = lum(x, y); return R - B > 50 && l > 60 && l < 200; };
    const cx = size / 2 - 4;
    let best = [0, 0], run = -1;
    for (let y = rim; y <= size; y++) {
      if (y < size && body(cx, y)) { if (run < 0) run = y; continue; }
      if (run >= 0 && y - run > best[1] - best[0]) best = [run, y];
      run = -1;
    }
    const [top, foot] = best;
    expect(foot - top).toBeGreaterThan(size / 6);
    // No row-to-row step above 6 levels down it (a few columns either side of the middle, its ends left out).
    let step = 0, prev = -1;
    for (let y = top + 2; y < foot - 2; y++) {
      let s = 0;
      for (let x = cx - 3; x <= cx + 3; x++) s += lum(x, y);
      if (prev >= 0) step = Math.max(step, Math.abs(s / 7 - prev));
      prev = s / 7;
    }
    expect(step).toBeLessThanOrEqual(6);
    // Below the drink, in the glass's base, nothing brighter than the backdrop behind the glass (the old renderer's
    // total internal reflection drew white triangles there).
    const backdrop = lum(2, 2);
    let brightest = 0;
    for (let x = 0; x < size; x++) {
      if (!body(x, foot - 3)) continue;
      for (let y = foot; y < Math.min(size, foot + Math.round(size * 0.12)); y++) brightest = Math.max(brightest, lum(x, y));
    }
    expect(brightest).toBeGreaterThan(0);
    expect(brightest).toBeLessThanOrEqual(backdrop);
  });

  it("tints a shadow through amber glass and leaves one through clear glass its own colour", () => {
    const ratio = (m: Material) => {
      // A pane on legs over the floor, lit from behind it so its shadow falls towards the camera.
      const pane = O.paint(O.move(P.box(1.6, 0.2, 1.6), 0, 1.2, 0), m);
      const legs = O.union([-0.7, 0.7].flatMap((x) => [-0.7, 0.7].map((z) => O.paint(O.move(P.box(0.08, 1.1, 0.08), x, 0.55, z), customMaterial({ color: [0.6, 0.6, 0.6], rough: 0.8 })))));
      const r = shade(O.union([pane, legs]), { size: 96, lights: [{ azimuth: 215, elevation: 45, size: 0.5, color: [1, 1, 1], power: 1 }] }, 48);
      const { flags, V } = r.buffers as { flags: Uint8Array; V: Float32Array };
      const floor = (i: number) => (flags[i] & KIND_MASK) === KIND_FLOOR && !(flags[i] & FLAG_EDGE);
      // The pane's shadow: floor the light reaches only through it (the legs' shadows, which it does not reach at
      // all, are left out); the open floor: floor it reaches unhindered.
      const shadow = (i: number) => floor(i) && V[i] > 0.1 && V[i] < 0.9, open = (i: number) => floor(i) && V[i] > 0.999;
      const n = 96 * 96;
      expect(r.buffers.V.some((_, i) => shadow(i))).toBe(true);
      const rb = (pick: (i: number) => boolean) => meanOver(r.hdr, pick, n, 0) / meanOver(r.hdr, pick, n, 2);
      return rb(shadow) / rb(open);
    };
    expect(ratio(materialFromString("amber")!)).toBeGreaterThan(1.3);
    expect(Math.abs(ratio(customMaterial({ color: [1, 1, 1], transmit: 0.9, rough: 0.05 })) - 1)).toBeLessThan(0.05);
  });

  it("keeps the absorption of glass seen through glass: a clear pane behind an amber slab leaves it amber", () => {
    // A thick amber slab in front of the camera, and behind it, in the line of sight or not, a thin clear pane. Two
    // small opaque balls fix the model's box, so the reach Beer's law is measured in is the same in both.
    const amber = customMaterial({ color: [1, 0.55, 0.1], transmit: 1, rough: 0.05 });
    const clear = customMaterial({ color: [1, 1, 1], transmit: 1, rough: 0.05 });
    const grey = customMaterial({ color: [0.6, 0.6, 0.6], rough: 0.8 });
    const centre = (paneBehind: boolean) => {
      const parts = [
        O.paint(O.move(P.box(2, 2, 1), 0, 3, 1), amber),
        paneBehind ? O.paint(O.move(P.box(2, 2, 0.2), 0, 3, -1), clear) : O.paint(O.move(P.box(0.2, 0.2, 0.2), 1.2, 2.2, -1.2), clear),
        O.paint(O.move(P.sphere(0.1), -1.3, 2.1, -1.4), grey), O.paint(O.move(P.sphere(0.1), 1.3, 3.9, 1.6), grey),
      ];
      // Off the line of sight, the pane is a small block in a corner of the same box.
      const r = shade(O.union(parts), { size: 48, azimuth: 0, elevation: 0, lights: [dark] }, 48);
      const i = 24 * 48 + 24;
      return [r.hdr[i * 3], r.hdr[i * 3 + 1], r.hdr[i * 3 + 2]];
    };
    const alone = centre(false), behind = centre(true);
    // Through the amber, green and blue are mostly absorbed; a clear pane behind it takes a little more, never less.
    expect(alone[1] / alone[0]).toBeLessThan(0.4);
    for (let c = 1; c < 3; c++) expect(behind[c], `channel ${c}: ${behind} against ${alone}`).toBeLessThan(alone[c] * 1.1);
  });

  it("lights a glass seen past the reflection budget once: its reflection's softbox is its highlight", () => {
    // A glass ball in front of a mirror, lit from straight above; the camera sees it in the mirror, at depth 1. In
    // full quality its reflection is traced (depth 1 < 2), in draft it is not (1 = the draft's budget) and takes the
    // sky a mirror sees, the key's softbox included. Pixel for pixel the centre samples must then agree in the key's
    // slot: an analytic highlight added on top in draft lit the ball's highlight half as bright again.
    const mirror = customMaterial({ color: [1, 1, 1], metal: 1, rough: 0.03 });
    const glass = customMaterial({ color: [1, 1, 1], transmit: 1, rough: 0.05 });
    const scene = O.union([O.paint(O.move(P.box(5, 4, 0.2), 0, 2, 0), mirror), O.paint(O.move(P.sphere(0.5), 0, 2.6, 1.3), glass)]);
    const opts = { size: 200, azimuth: 28, elevation: 8, splitLights: true, lights: [{ azimuth: 0, elevation: 90, size: 1, color: [1, 1, 1], power: 1 } as BeautyLight] };
    const peak = (quality: "full" | "draft") => {
      const { R, size, W } = primaryOnly(scene, { ...opts, quality }, 64);
      // The ball's reflection: right of the ball itself, from a camera to its right.
      let p = 0;
      for (let y = 50; y < 100; y++) for (let x = 105; x < 145; x++) p = Math.max(p, R[(y * size + x) * W + 4]);
      return p;
    };
    const full = peak("full"), draft = peak("draft");
    expect(full).toBeGreaterThan(1);
    expect(Math.abs(draft - full) / full).toBeLessThan(0.05);
  });
});

describe("shading: the default key in a steep shot", () => {
  const unit = { min: [-1, 0, -1] as [number, number, number], max: [1, 1, 1] as [number, number, number] };
  /** Where a light lies in a camera's frame: its share along the frame's right and up. */
  const inFrame = (az: number, el: number, l: readonly number[]) => {
    const cam = perspective(unit, 64, 64, az, el);
    return { right: l[0] * cam.right[0] + l[1] * cam.right[1] + l[2] * cam.right[2], up: l[0] * cam.up[0] + l[1] * cam.up[1] + l[2] * cam.up[2] };
  };

  it("is the default key below STEEP's first elevation, at any azimuth", () => {
    for (const az of [-170, -40, 0, 35, 90, 180]) for (let el = -10; el <= STEEP[0]; el += 5) expect(defaultKey(az, el)).toBe(DEFAULT_LIGHT_DIRECTION);
  });

  it("comes from the frame's top left when the camera looks steeply down, at every azimuth", () => {
    for (const az of [-170, -90, -40, 0, 35, 90, 135, 180]) {
      // The default key from a plan view comes from the frame's bottom for most azimuths: the reason for the rule.
      if (az === 0 || az === 35) expect(inFrame(az, 90, DEFAULT_LIGHT_DIRECTION).up, `default key at ${az}`).toBeLessThan(0);
      for (const el of [STEEP[1], 80, 89, 90]) {
        const { right, up } = inFrame(az, el, defaultKey(az, el));
        expect(up, `up at ${az}, ${el}`).toBeGreaterThan(0.3);
        expect(right, `right at ${az}, ${el}`).toBeLessThan(-0.3);
      }
      // At the default key's own elevation.
      expect(defaultKey(az, 90)[1]).toBeCloseTo(DEFAULT_LIGHT_DIRECTION[1], 12);
    }
  });

  it("turns smoothly with the elevation, never by more than 10 degrees a degree (a step would turn it up to 180 at once)", () => {
    for (const az of [0, 35, -85, -120, 180]) {
      let prev = defaultKey(az, STEEP[0] - 1);
      for (let el = STEEP[0]; el <= 90; el += 1) {
        const k = defaultKey(az, el);
        const turn = (Math.acos(Math.min(1, prev[0] * k[0] + prev[1] * k[1] + prev[2] * k[2])) * 180) / Math.PI;
        expect(turn, `${az} at ${el}`).toBeLessThan(10);
        prev = k;
      }
    }
  });

  it("turns smoothly with the camera's azimuth too: two cameras a twentieth of a degree apart never get keys a degree apart", () => {
    // Turned by azimuth the shortest way round, a camera at azimuth −85.2 and one at −85.3, both at elevation 65, had
    // keys 87° apart: the target lay straight across from the default key, and the two went round opposite ways.
    const ang = (a: readonly number[], b: readonly number[]): number => (Math.acos(Math.min(1, a[0] * b[0] + a[1] * b[1] + a[2] * b[2])) * 180) / Math.PI;
    for (let el = STEEP[0] + 1; el < STEEP[1]; el += 2) {
      let worst = 0, at = 0;
      for (let az = -180; az < 180; az += 0.05) {
        const t = ang(defaultKey(az, el), defaultKey(az + 0.05, el));
        if (t > worst) { worst = t; at = az; }
      }
      expect(worst, `at elevation ${el}, azimuth ${at.toFixed(2)}`).toBeLessThan(1);
    }
  });

  it("is taken only when the program places no light and sets no light direction", () => {
    const model = { min: [-1, 0, -1] as [number, number, number], max: [1, 2, 1] as [number, number, number] };
    const plan = { size: 64, cellSize: 0.05, azimuth: 0, elevation: 90 };
    expect(sceneLights(plan, model)[0].dir).toEqual(defaultKey(0, 90));
    expect(sceneLights({ ...plan, elevation: 25 }, model)[0].dir).toBe(DEFAULT_LIGHT_DIRECTION);
    // A program's own lights, and `set light_azimuth`, are kept as they are in a plan view.
    const key: BeautyLight = { azimuth: -40, elevation: 55, size: 3, color: [1, 1, 1], power: 1 };
    expect(sceneLights({ ...plan, lights: [key] }, model)[0].dir).toEqual(lightDirection(-40, 55));
    expect(sceneLights({ ...plan, lightAzimuth: -40 }, model)[0].dir).toEqual(lightDirection(-40, 55));
    expect(sceneLights({ ...plan, lightElevation: 30 }, model)[0].dir).toEqual(lightDirection(-40, 30));
  });

  it("lights a plan view from the frame's top left: a block's shadow falls to its bottom right", () => {
    const block = O.paint(O.move(P.box(1, 0.6, 1), 0, 0.3, 0), customMaterial({ color: [0.8, 0.8, 0.8], rough: 0.7 }));
    const nets = surfaceNets(block, { resolution: 32 });
    const size = 96;
    const c = renderBeauty(block, nets.mesh, block.bounds, { size, cellSize: nets.cellSize, azimuth: 0, elevation: 90, zoom: 0.5 });
    const cam = beautyCamera(nets.mesh, block.bounds, { size, cellSize: nets.cellSize, azimuth: 0, elevation: 90, zoom: 0.5 });
    // The floor just past two opposite corners of the block, one towards the frame's top left, one its bottom right.
    const luma = (p: [number, number, number]): number => {
      const q = project(cam, toView(cam, p))!;
      const v = c.get(Math.round(q.x), Math.round(q.y));
      return 0.2126 * ((v >> 16) & 255) + 0.7152 * ((v >> 8) & 255) + 0.0722 * (v & 255);
    };
    const corner = (sx: number, sy: number): number => {
      // The frame's right and up on the floor.
      const r = [cam.right[0], cam.right[2]], u = [cam.up[0], cam.up[2]];
      const x = 0.75 * (sx * r[0] + sy * u[0]), z = 0.75 * (sx * r[1] + sy * u[1]);
      return luma([x, 0, z]);
    };
    const corners = { topLeft: corner(-1, 1), topRight: corner(1, 1), bottomLeft: corner(-1, -1), bottomRight: corner(1, -1) };
    // The shadow is past the bottom right corner; the floor past the top left one, towards the light, is lit.
    expect(corners.bottomRight, JSON.stringify(corners)).toBeLessThan(Math.min(corners.topLeft, corners.topRight, corners.bottomLeft) * 0.8);
  });

  it("starts the floor flag (the studio's and the overcast's) past the frame's bottom edge when the camera looks steeply down, out of shot", () => {
    // A camera past 75° sees the floor beyond its own place at the frame's bottom; a flag started at the camera
    // darkened that half of a plan view's floor to a quarter (210 levels to 48).
    const block = O.paint(O.move(P.box(1, 0.6, 1), 0, 0.3, 0), customMaterial({ color: [0.8, 0.8, 0.8], rough: 0.7 }));
    const nets = surfaceNets(block, { resolution: 32 });
    for (const [azimuth, elevation, environment] of [[0, 90, "studio"], [35, 90, "studio"], [0, 80, "studio"], [-120, 85, "studio"], [35, 90, "overcast"], [-120, 85, "overcast"]] as const) {
      const o = { size: 96, cellSize: nets.cellSize, azimuth, elevation, zoom: 0.5, environment };
      const c = renderBeauty(block, nets.mesh, block.bounds, o);
      const cam = beautyCamera(nets.mesh, block.bounds, o);
      // The open floor near the frame's top and bottom edges, on its left, clear of the block and its shadow.
      const edge = (sy: number): number => {
        const p: [number, number, number] = [1.1 * sy * cam.up[0] - 0.9 * cam.right[0], 0, 1.1 * sy * cam.up[2] - 0.9 * cam.right[2]];
        const q = project(cam, toView(cam, p))!;
        expect(q.x > 0 && q.x < 95 && q.y > 0 && q.y < 95, `in frame at ${azimuth}, ${elevation}`).toBe(true);
        const v = c.get(Math.round(q.x), Math.round(q.y));
        return 0.2126 * ((v >> 16) & 255) + 0.7152 * ((v >> 8) & 255) + 0.0722 * (v & 255);
      };
      const top = edge(1), bottom = edge(-1);
      expect(Math.abs(bottom - top), `top ${top}, bottom ${bottom} at ${azimuth}, ${elevation}, ${environment}`).toBeLessThan(top * 0.05);
    }
  });
});

describe("shading: the overcast's flags", () => {
  it("darken a metal's face turned to the camera, which mirrors the ground on the camera's side, and barely touch a matte part", () => {
    // A key behind on the right, so the ground behind the camera is away from it and flagged in full.
    const key: BeautyLight = { azimuth: 150, elevation: 45, size: 1, color: [1, 1, 1], power: 1 };
    const opts = { size: 64, azimuth: 0, elevation: 20, environment: "overcast" as const, lights: [key] };
    const flagged = buildEnvironment("overcast", { cameraAzimuth: 0, lights: [{ dir: lightDirection(150, 45), size: 1, color: [1, 1, 1], power: 1 }] });
    // The same sky with the flags taken down, its reflections' maps drawn again from it: the overcast before its rig.
    const down = { ...flagged, reflect: { ...flagged.reflect, walls: 0, flag: 0 } };
    const bare: EnvironmentState = { ...down, levels: prefilterLevels((x, y, z, out, mode) => skyAt(down, x, y, z, out, 0, mode)) };
    const front = (r: ReturnType<typeof shade>) => {
      const { flags, normal } = r.buffers as { flags: Uint8Array; normal: Float32Array };
      return meanOver(r.hdr, (i) => (flags[i] & KIND_MASK) === KIND_MODEL && !(flags[i] & FLAG_EDGE) && normal[i * 3 + 2] > 0.85 && Math.abs(normal[i * 3 + 1]) < 0.3, 64 * 64);
    };
    const model = (r: ReturnType<typeof shade>) => {
      const { flags } = r.buffers as { flags: Uint8Array };
      return meanOver(r.hdr, (i) => (flags[i] & KIND_MASK) === KIND_MODEL && !(flags[i] & FLAG_EDGE), 64 * 64);
    };
    // Steel takes its reflection from the prefiltered sky, chrome from a traced ray that meets the flagged floor.
    for (const name of ["steel", "chrome", "silver"]) {
      const ball = O.paint(O.move(P.sphere(1), 0, 1, 0), materialFromString(name)!);
      const a = front(shade(ball, opts, 32, flagged)), b = front(shade(ball, opts, 32, bare));
      expect(a, `${name}: ${a} against ${b}`).toBeLessThan(b * 0.6);
    }
    // A matte part's light is the bare dome's (the same SH); only its faint gloss sees the flags.
    const clay = O.paint(O.move(P.sphere(1), 0, 1, 0), materialFromString("clay")!);
    const a = model(shade(clay, opts, 32, flagged)), b = model(shade(clay, opts, 32, bare));
    expect(Math.abs(a - b) / b, `clay: ${a} against ${b}`).toBeLessThan(0.025);
  });
});

describe("shading: the floor is opaque to lights", () => {
  // A block, a mirror ball and a glass pane on the floor, under a key from above: primary surfaces, a mirror's traced
  // reflection, its secondary shading and glass's paths all evaluate the lights.
  const src = 'block = box(0.6, 0.8, 0.6) | move(0.5, 0.4, 0) | paint("amber")\nball = sphere(0.4) | move(-0.5, 0.4, 0) | paint("chrome")\npane = box(0.7, 0.6, 0.12) | move(0, 0.3, 0.6) | paint("glass")\nshow block + ball + pane';
  const shape = check(src, "under.aix").output!;
  const nets = surfaceNets(shape, { resolution: 40 });
  const key: BeautyLight = { azimuth: -40, elevation: 50, size: 1, color: [1, 1, 1], power: 1 };
  const draw = (extra: BeautyLight, splitLights = false) => renderBeautyResult(shape, nets.mesh, shape.bounds, { size: 72, cellSize: nets.cellSize, splitLights, lights: [key, extra] });
  const sha = (b: Uint8Array) => createHash("sha256").update(b).digest("hex");
  const off = (l: BeautyLight): BeautyLight => ({ ...l, power: 0 });

  it("passes over a directional light below the horizon: the picture is the one with that light switched off", () => {
    // Before, a light from 60 degrees below lit the block's sides through the floor (lights.png: 'under adds' x9).
    const under: BeautyLight = { azimuth: 30, elevation: -60, size: 1, color: [1, 1, 1], power: 1.5 };
    expect(sha(draw(under).canvas.data)).toBe(sha(draw(off(under)).canvas.data));
    // Its slot is black at every pixel (before, 1,190 of them took its light, on the model and at its edges).
    const split = draw(under, true);
    expect(split.hdr![2].every((v) => v === 0)).toBe(true);
    // The same light just above the horizon does light the scene, so the test can tell.
    const low = { ...under, elevation: 5 };
    expect(sha(draw(low).canvas.data)).not.toBe(sha(draw(off(low)).canvas.data));
  });

  it("passes over a point light below the floor: the picture is the one with that light switched off", () => {
    const under: BeautyLight = { azimuth: 0, elevation: 0, size: 0.5, color: [1, 0.8, 0.6], power: 2, position: [0.1, -0.3, 0.5], range: 1.5 };
    expect(sha(draw(under).canvas.data)).toBe(sha(draw(off(under)).canvas.data));
    const split = draw(under, true);
    expect(split.hdr![2].every((v) => v === 0)).toBe(true);
    // Raised to just above the floor, it lights the pane and the block.
    const above = { ...under, position: [0.1, 0.05, 0.5] as [number, number, number] };
    expect(sha(draw(above).canvas.data)).not.toBe(sha(draw(off(above)).canvas.data));
  });
});

describe("shading: an engraving in polished metal", () => {
  it("reads as dark marks: grooves under two cells wide in gold sit well under the face round them, with the key's highlight on their lips", () => {
    // Four grooves cut into a gold plate, 1.9 cells wide and 2.9 deep (the ring's FOREVER is 1.75 and 2.9), seen low
    // with the key above and behind the camera, so the half vector between them is the normal of the grooves' far lips
    // and corners. Without the cavity term on the highlights of creases and edges in a hollow those caught the key, and
    // the grooves read 9 levels brighter than the face; with it they read 21 under.
    const gold = materialFromString("gold")!;
    const plate = O.paint(O.move(P.box(2, 0.2, 1), 0, 0.1, 0), gold);
    const grooves = O.union([-0.3, -0.1, 0.1, 0.3].map((z) => O.move(P.box(1.6, 0.24, 0.08), 0, 0.2, z)));
    const cut = O.difference(plate, grooves);
    // The same plate uncut with the grooves' mouths painted a green glow: which pixels are the grooves.
    const marked = O.decal(plate, grooves, customMaterial({ color: [0, 1, 0], glow: 2 }));
    const size = 96;
    const opts = { size, azimuth: 0, elevation: 15, zoom: 1.3, lights: [{ azimuth: 0, elevation: 50, size: 1.5, color: [1, 1, 1], power: 1 }] as BeautyLight[] };
    const draw = (s: Shape3) => {
      const nets = surfaceNets(s, { resolution: 48 });
      return renderBeauty(s, nets.mesh, s.bounds, { ...opts, cellSize: nets.cellSize });
    };
    const picture = draw(cut), mask = draw(marked);
    const rgb = (v: number) => [(v >> 16) & 255, (v >> 8) & 255, v & 255];
    const luma = (v: number) => { const [r, g, b] = rgb(v); return 0.2126 * r + 0.7152 * g + 0.0722 * b; };
    const groove = (x: number, y: number) => { const [r, g, b] = rgb(mask.get(x, y)); return g > r + 40 && g > b + 40; };
    let gs = 0, gn = 0, fs = 0, fn = 0;
    for (let y = 3; y < size - 3; y++)
      for (let x = 3; x < size - 3; x++) {
        if (groove(x, y)) { gs += luma(picture.get(x, y)); gn++; continue; }
        // The face round them: the gold within three pixels of a groove.
        let near = false;
        for (let dy = -3; dy <= 3 && !near; dy++) for (let dx = -3; dx <= 3 && !near; dx++) near = groove(x + dx, y + dy);
        const [r, , b] = rgb(mask.get(x, y));
        if (near && r - b > 50) { fs += luma(picture.get(x, y)); fn++; }
      }
    expect(gn).toBeGreaterThan(200);
    expect(fn).toBeGreaterThan(200);
    expect(fs / fn - gs / gn, `grooves ${(gs / gn).toFixed(1)}, face ${(fs / fn).toFixed(1)}`).toBeGreaterThan(15);
  });

  it("leaves a light's highlight on a flat floor alone: a pocket's floor takes the key as the open face does", () => {
    // A pocket 12 cells across and 2.4 deep in a gold plate, seen from above. Its floor's cavity term is under 1 within
    // six cells of the wall, but the floor is flat, the light's rays find it lit, and its highlight is the face's: the
    // cavity term dims a highlight only where the field bends (a crease or an edge). Taken on every highlight, it
    // took up to 97% of this floor's, and round 10's hub's pockets read as domes from above.
    const gold = materialFromString("gold")!;
    const slab = O.move(P.box(2, 0.2, 2), 0, 0.1, 0);
    const pocket = O.paint(O.difference(slab, O.move(P.box(0.5, 0.24, 0.5), 0, 0.22, 0)), gold);
    const open = O.paint(slab, gold);
    const opts = { size: 64, azimuth: 20, elevation: 60, ambient: 0, lights: [{ azimuth: -40, elevation: 55, size: 1, color: [1, 1, 1], power: 1 }] as BeautyLight[] };
    const a = shade(pocket, opts, 48), b = shade(open, opts, 48);
    const D = (r: typeof a) => r.buffers.D as Float32Array;
    const { flags, normal, depth } = a.buffers as { flags: Uint8Array; normal: Float32Array; depth: Float32Array };
    const depthB = b.buffers.depth as Float32Array;
    let n = 0, worst = 0;
    for (let i = 0; i < 64 * 64; i++) {
      // The pocket's floor: a model pixel facing straight up, farther than the open face at that pixel.
      if ((flags[i] & KIND_MASK) !== KIND_MODEL || flags[i] & FLAG_EDGE || normal[i * 3 + 1] < 0.9999 || !(depth[i] > depthB[i] + 0.05)) continue;
      n++;
      for (let c = 0; c < 3; c++) worst = Math.max(worst, Math.abs(D(a)[i * 3 + c] - D(b)[i * 3 + c]) / D(b)[i * 3 + c]);
    }
    expect(n).toBeGreaterThan(40);
    expect(worst).toBeLessThan(1e-4);
  });
});
