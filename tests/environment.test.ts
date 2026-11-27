import { describe, expect, it } from "vitest";
import {
  BACKDROP, buildEnvironment, buildSky, DEFAULT_LIGHT_DIRECTION, DIFFUSE, ENVIRONMENTS, environmentLatLong, environmentPalette, FILTERED, horizonRadiance,
  irradiance, keyDirection, lightDirection, MIRROR, prefiltered, prefilterLevels, projectSh, REFLECT, skyAt, softboxAt, type Environment, type SkyMode, type SkySampler, type SkyTables,
} from "../src/render/environment.js";
import { beer, bloom, BLOOM_THRESHOLD, decode, encode, FLAG_EDGE, FLAG_SHINY, KIND_FLOOR, KIND_MODEL, KEY, lightAngle, pointRadius, tonemap, TONEMAP_GLSL, TONE_START, toLinear, toSrgb, untone } from "../src/render/photometry.js";
import type { Vec3 } from "../src/core/vec.js";

/** three.js's NeutralToneMapping (r162 on), as its shader chunk writes it, with exposure 1. */
function threeNeutral(r: number, g: number, b: number): Vec3 {
  const StartCompression = 0.8 - 0.04, Desaturation = 0.15;
  const x = Math.min(r, Math.min(g, b));
  const offset = x < 0.08 ? x - 6.25 * x * x : 0.04;
  r -= offset; g -= offset; b -= offset;
  const peak = Math.max(r, Math.max(g, b));
  if (peak < StartCompression) return [r, g, b];
  const d = 1 - StartCompression;
  const newPeak = 1 - (d * d) / (peak + d - StartCompression);
  r *= newPeak / peak; g *= newPeak / peak; b *= newPeak / peak;
  const gg = 1 - 1 / (Desaturation * (peak - newPeak) + 1);
  return [r + (newPeak - r) * gg, g + (newPeak - g) * gg, b + (newPeak - b) * gg];
}

/** HEAD's palettes and backdrop() (src/render/beauty.ts before the renderer rebuild): what the camera saw. */
const HEAD: Record<Environment, { sky: Vec3; horizon?: Vec3; ground: Vec3; floor: Vec3 }> = {
  studio: { sky: [0.78, 0.83, 0.9], ground: [0.93, 0.92, 0.9], floor: [0.88, 0.87, 0.85] },
  overcast: { sky: [0.84, 0.86, 0.88], horizon: [0.9, 0.9, 0.9], ground: [0.8, 0.8, 0.8], floor: [0.8, 0.8, 0.79] },
  sunset: { sky: [0.32, 0.36, 0.62], horizon: [0.98, 0.62, 0.36], ground: [0.55, 0.42, 0.36], floor: [0.62, 0.52, 0.45] },
  night: { sky: [0.04, 0.06, 0.14], horizon: [0.1, 0.11, 0.2], ground: [0.07, 0.07, 0.1], floor: [0.14, 0.14, 0.17] },
};
function headBackdrop(env: Environment, dir: Vec3): Vec3 {
  const { sky: SKY, ground: GROUND, floor: FLOOR, horizon } = HEAD[env];
  if (dir[1] < -1e-6) {
    const fade = 0.6;
    return [FLOOR[0] * 0.95 + (GROUND[0] - FLOOR[0] * 0.95) * fade, FLOOR[1] * 0.95 + (GROUND[1] - FLOOR[1] * 0.95) * fade, FLOOR[2] * 0.95 + (GROUND[2] - FLOOR[2] * 0.95) * fade];
  }
  const k = Math.min(1, Math.max(0, dir[1] * 2.5));
  if (horizon) {
    const H = horizon;
    if (k < 0.3) { const u = k / 0.3; return [GROUND[0] + (H[0] - GROUND[0]) * u, GROUND[1] + (H[1] - GROUND[1]) * u, GROUND[2] + (H[2] - GROUND[2]) * u]; }
    const u = (k - 0.3) / 0.7;
    return [H[0] + (SKY[0] - H[0]) * u, H[1] + (SKY[1] - H[1]) * u, H[2] + (SKY[2] - H[2]) * u];
  }
  return [GROUND[0] + (SKY[0] - GROUND[0]) * k, GROUND[1] + (SKY[1] - GROUND[1]) * k, GROUND[2] + (SKY[2] - GROUND[2]) * k];
}

/** A unit direction from azimuth and elevation in degrees (azimuth 0 is +z, 90 is +x). */
const dirOf = (az: number, el: number): Vec3 => {
  const a = (az * Math.PI) / 180, e = (el * Math.PI) / 180;
  return [Math.sin(a) * Math.cos(e), Math.sin(e), Math.cos(a) * Math.cos(e)];
};
const azimuthOf = (d: Vec3): number => (Math.atan2(d[0], d[2]) * 180) / Math.PI;
/** Display colour (0..255 levels) of a radiance. */
const levels = (c: ArrayLike<number>): Vec3 => {
  const o = [0, 0, 0];
  encode(c[0], c[1], c[2], o);
  return [o[0] * 255, o[1] * 255, o[2] * 255];
};
const maxDiff = (a: ArrayLike<number>, b: ArrayLike<number>): number => Math.max(Math.abs(a[0] - b[0]), Math.abs(a[1] - b[1]), Math.abs(a[2] - b[2]));
/** A deterministic sequence in [0, 1). */
const seq = (i: number, k: number): number => {
  const v = Math.sin(i * 12.9898 + k * 78.233) * 43758.5453;
  return v - Math.floor(v);
};

const KEY_AZ = azimuthOf(DEFAULT_LIGHT_DIRECTION);
const look = (s: SkyTables, d: Vec3, mode: SkyMode): Float64Array => {
  const out = new Float64Array(3);
  skyAt(s, d[0], d[1], d[2], out, 0, mode);
  return out;
};

describe("photometry: the tone curve", () => {
  it("is three.js's NeutralToneMapping below the shoulder (1,000 colours, within 1e-7)", () => {
    let n = 0, worst = 0;
    for (let i = 0; n < 1000; i++) {
      const c: Vec3 = [seq(i, 1) * 0.8, seq(i, 2) * 0.8, seq(i, 3) * 0.8];
      // Below the shoulder: Neutral's peak after its toe under TONE_START.
      const x = Math.min(...c), off = x < 0.08 ? x - 6.25 * x * x : 0.04;
      if (Math.max(...c) - off >= TONE_START) continue;
      const ours = [0, 0, 0];
      tonemap(c[0], c[1], c[2], ours);
      worst = Math.max(worst, maxDiff(ours, threeNeutral(c[0], c[1], c[2])));
      n++;
    }
    expect(worst).toBeLessThan(1e-7);
  });

  it("rolls each channel off on its own above it: a bright orange stays orange and goes to white", () => {
    const o = [0, 0, 0];
    tonemap(4, 1.2, 0.2, o);
    expect(o[0]).toBeGreaterThan(o[1]);
    expect(o[1]).toBeGreaterThan(o[2]);
    expect(o[0]).toBeLessThan(1);
    tonemap(200, 60, 10, o);
    expect(o[0]).toBeGreaterThan(0.99);
    expect(o[1]).toBeGreaterThan(0.99);
  });

  it("untone is its exact inverse over [0, 20] (within 1e-6)", () => {
    const t = [0, 0, 0], u = [0, 0, 0];
    let worst = 0;
    for (let i = 0; i <= 4000; i++) {
      const v = (i / 4000) * 20;
      for (const c of [[v, v, v], [v, v * 0.5, v * 0.05], [v * 0.02, v, v * 0.7], [v, 0, 0.3 * v]] as Vec3[]) {
        tonemap(c[0], c[1], c[2], t);
        untone(t[0], t[1], t[2], u);
        worst = Math.max(worst, maxDiff(u, c));
      }
    }
    expect(worst).toBeLessThan(1e-6);
  });

  it("encode is the tone curve then sRGB, and decode its inverse on display colours", () => {
    const e = [0, 0, 0], d = [0, 0, 0], t = [0, 0, 0];
    encode(0.3, 0.9, 2.5, e);
    tonemap(0.3, 0.9, 2.5, t);
    expect(e).toEqual([toSrgb(t[0]), toSrgb(t[1]), toSrgb(t[2])]);
    for (let i = 0; i < 200; i++) {
      const c: Vec3 = [seq(i, 4) * 0.99, seq(i, 5) * 0.99, seq(i, 6) * 0.99];
      decode(c[0], c[1], c[2], d);
      encode(d[0], d[1], d[2], e);
      expect(maxDiff(e, c)).toBeLessThan(1e-9);
    }
    expect(toLinear(toSrgb(0.37))).toBeCloseTo(0.37, 12);
  });

  it("TONEMAP_GLSL is the same curve: its body, read as JavaScript, gives tonemap's values", () => {
    expect(TONEMAP_GLSL).toContain("toneMappingExposure");
    expect(TONEMAP_GLSL).toContain(String(TONE_START));
    // Every float literal has a decimal point, as GLSL ES needs.
    for (const lit of TONEMAP_GLSL.match(/(?<![\w.])\d+(?:\.\d+)?(?![\w.])/g) ?? []) expect(lit).toContain(".");
    const js = TONEMAP_GLSL.replace(/\bfloat\s+/g, "let ").replace(/\bmin\(/g, "Math.min(").replace("color *= toneMappingExposure;", "color.r *= toneMappingExposure; color.g *= toneMappingExposure; color.b *= toneMappingExposure;");
    const f = new Function("color", "toneMappingExposure", js) as (c: { r: number; g: number; b: number }, e: number) => { r: number; g: number; b: number };
    const o = [0, 0, 0];
    for (let i = 0; i < 300; i++) {
      const c: Vec3 = [seq(i, 7) * 6, seq(i, 8) * 3, seq(i, 9) * 0.5];
      const g = f({ r: c[0], g: c[1], b: c[2] }, 1);
      tonemap(c[0], c[1], c[2], o);
      expect(maxDiff([g.r, g.g, g.b], o)).toBeLessThan(1e-12);
    }
  });
});

describe("photometry: the constants", () => {
  it("a light's size is an angle, a point light a sphere, and glass absorbs by Beer's law as today", () => {
    expect((lightAngle(1) * 180) / Math.PI).toBeCloseTo(3.18, 2);
    expect((lightAngle(3) * 180) / Math.PI).toBeCloseTo(9.55, 2);
    expect(pointRadius(2, 5)).toBeCloseTo(0.2, 12);
    // Today's absorption, exp(−1.5(1 − c)·t / (0.15·reach)), is the same law.
    for (const [c, t, reach] of [[0.8, 0.3, 2], [0.2, 1.5, 4], [1, 2, 1]]) expect(beer(c, t, reach)).toBeCloseTo(Math.exp((-1.5 * (1 - c) * t) / (0.15 * reach)), 12);
    expect(KEY).toBe(1.05);
  });

  it("bloom spills only what a model pixel has above the threshold", () => {
    const size = 64;
    const hdr = new Float32Array(size * size * 3).fill(0.5);
    const flags = new Uint8Array(size * size);
    // A bright backdrop pixel does not bloom.
    hdr[(10 * size + 10) * 3] = 50;
    const before = Float32Array.from(hdr);
    bloom(hdr, flags, size);
    expect(hdr).toEqual(before);
    // A bright model pixel does, and only by what it has above the threshold.
    const c = 40 * size + 40;
    flags[c] = KIND_MODEL | FLAG_SHINY | FLAG_EDGE;
    // A floor pixel just as bright does not.
    flags[20 * size + 20] = KIND_FLOOR;
    hdr[(20 * size + 20) * 3] = 50;
    hdr[c * 3] = BLOOM_THRESHOLD + 8; hdr[c * 3 + 1] = 0.5; hdr[c * 3 + 2] = 0.5;
    bloom(hdr, flags, size);
    expect(hdr[(40 * size + 43) * 3]).toBeGreaterThan(0.5);
    expect(hdr[(40 * size + 43) * 3 + 1]).toBe(0.5);
    expect(hdr[(5 * size + 5) * 3]).toBeLessThan(0.5 + 1e-3);
    expect(hdr[(20 * size + 23) * 3]).toBe(0.5);
  });
});

describe("environments: the backdrop", () => {
  it("is HEAD's backdrop at 33 elevations, within 2 levels, in every environment (away from the new sun and moon)", () => {
    for (const env of ENVIRONMENTS) {
      const s = buildSky(env, 35, DEFAULT_LIGHT_DIRECTION);
      // The studio's and the overcast's backdrop does not change with azimuth; sunset's and night's is read on the
      // meridian opposite the key, at least 60° from the disc (the moon's halo reaches 37° to 1/e, by design).
      const azimuths = env === "studio" || env === "overcast" ? [0, 45, 90, 135, 180, 225, 270, 315] : [KEY_AZ + 180];
      let worst = 0, read = 0;
      for (const az of azimuths)
        for (let k = 0; k < 33; k++) {
          const d = dirOf(az, -90 + (180 * k) / 32);
          if (s.disc.length && d[0] * s.disc[0] + d[1] * s.disc[1] + d[2] * s.disc[2] > Math.cos(Math.PI / 3)) continue;
          const head = headBackdrop(env, d).map((v) => v * 255);
          // A star only adds light and is 0.0018 rad across: of two looks 0.006 rad apart, the darker has none.
          const a = look(s, d, BACKDROP), b = look(s, dirOf(az + 0.35, -90 + (180 * k) / 32), BACKDROP);
          const seen = a[2] <= b[2] ? a : b;
          worst = Math.max(worst, maxDiff(levels(seen), head));
          read++;
        }
      expect(worst, env).toBeLessThan(2);
      expect(read, env).toBeGreaterThanOrEqual(30);
    }
  });

  it("the sun's and the moon's glow end 90° from them without a step", () => {
    for (const env of ["sunset", "night"] as Environment[]) {
      const s = buildSky(env, 35, DEFAULT_LIGHT_DIRECTION);
      const D: Vec3 = [s.disc[0], s.disc[1], s.disc[2]];
      // A point 90° from the disc, high on the meridian through it (off the horizon, whose step is HEAD's), and a
      // look either side of the circle there.
      const hz: Vec3 = [D[2], 0, -D[0]];
      const u: Vec3 = [D[1] * hz[2] - D[2] * hz[1], D[2] * hz[0] - D[0] * hz[2], D[0] * hz[1] - D[1] * hz[0]];
      const ul = Math.hypot(...u); u[0] /= ul; u[1] /= ul; u[2] /= ul;
      if (u[1] < 0) { u[0] = -u[0]; u[1] = -u[1]; u[2] = -u[2]; }
      expect(Math.abs(u[0] * D[0] + u[1] * D[1] + u[2] * D[2])).toBeLessThan(1e-12);
      expect(u[1]).toBeGreaterThan(0.3);
      for (const e of [1e-4, -1e-4]) {
        const d: Vec3 = [u[0] + D[0] * e, u[1] + D[1] * e, u[2] + D[2] * e];
        const l = Math.hypot(...d);
        const with_ = look(s, [d[0] / l, d[1] / l, d[2] / l], BACKDROP);
        const flat = look(s, [u[0], u[1], u[2]], BACKDROP);
        expect(maxDiff(levels(with_), levels(flat)), env).toBeLessThan(0.05);
      }
    }
  });

  it("the far floor's fade target is the sky at dy = +0, and the lit skies have no seam at the horizon", () => {
    for (const env of ENVIRONMENTS) {
      const s = buildEnvironment(env, { cameraAzimuth: 35, lights: [{ dir: DEFAULT_LIGHT_DIRECTION, size: 1, color: [1, 1, 1], power: 1 }] });
      const h = new Float64Array(3);
      for (let i = 0; i < 72; i++) {
        const az = i * 5;
        const flat = dirOf(az, 0);
        horizonRadiance(s, flat[0] * 3, flat[2] * 3, h, 0);
        expect(maxDiff(levels(h), levels(look(s, flat, BACKDROP))), `${env} ${az}`).toBeLessThan(1);
        for (const mode of [DIFFUSE, FILTERED, REFLECT, MIRROR] as SkyMode[]) {
          const up = look(s, dirOf(az, 0.01), mode), down = look(s, dirOf(az, -0.01), mode);
          expect(maxDiff(levels(up), levels(down)), `${env} mode ${mode} at ${az}`).toBeLessThan(1);
        }
      }
    }
  });

  it("the sun and the moon stand where the key light comes from; the stars are round dots", () => {
    const key = lightDirection(70, 40);
    for (const env of ["sunset", "night"] as Environment[]) {
      const s = buildSky(env, 35, key);
      let best = -1, bestAz = 0, bestEl = 0;
      for (let az = -180; az < 180; az += 1)
        for (let el = 1; el < 80; el += 0.5) {
          const v = look(s, dirOf(az, el), BACKDROP);
          if (v[0] + v[1] + v[2] > best) { best = v[0] + v[1] + v[2]; bestAz = az; bestEl = el; }
        }
      expect(Math.abs(bestAz - 70), env).toBeLessThanOrEqual(1);
      expect(bestEl, env).toBeCloseTo(env === "sunset" ? 3 : 40, -0.5);
      // Neither is in the light the sky gives: the disc is BACKDROP's and MIRROR's.
      const at = dirOf(70, env === "sunset" ? 3 : 40);
      expect(look(s, at, DIFFUSE)[0]).toBeLessThan(look(s, at, BACKDROP)[0] / 3);
      expect(look(s, at, MIRROR)[0]).toBeCloseTo(look(s, at, BACKDROP)[0] + (look(s, at, MIRROR)[0] - look(s, at, BACKDROP)[0]), 9);
    }
    // The moon's elevation is the key's, kept between 25° and 60°, whatever the key's length.
    for (const [el, want] of [[10, 25], [45, 45], [80, 60]]) {
      const k = lightDirection(-30, el);
      const s = buildSky("night", 0, [k[0] * 3, k[1] * 3, k[2] * 3]);
      expect((Math.asin(s.disc[1]) * 180) / Math.PI).toBeCloseTo(want, 6);
    }
    // Stars: find some in a patch of night sky and measure each across and up the sky.
    const s = buildSky("night", 35, DEFAULT_LIGHT_DIRECTION);
    for (const el0 of [20, 50, 75]) {
      const step = 0.0002, n = 500; // a 0.1 rad square: about 150 cells, 6 stars
      const e0 = (el0 * Math.PI) / 180, a0 = 1.3;
      const lit: boolean[] = [];
      const base = look(s, dirOf((a0 * 180) / Math.PI, el0), DIFFUSE);
      for (let j = 0; j < n; j++)
        for (let i = 0; i < n; i++) {
          // Local angular coordinates: x across the sky (along the horizon), y up it.
          const e = e0 + (j - n / 2) * step, a = a0 + ((i - n / 2) * step) / Math.cos(e0);
          const d: Vec3 = [Math.sin(a) * Math.cos(e), Math.sin(e), Math.cos(a) * Math.cos(e)];
          const v = look(s, d, BACKDROP);
          lit.push(v[2] - base[2] > 0.01);
        }
      // Each star's extent across and up.
      const seen = new Uint8Array(n * n);
      let stars = 0;
      for (let p = 0; p < n * n; p++) {
        if (!lit[p] || seen[p]) continue;
        let x0 = n, x1 = -1, y0 = n, y1 = -1;
        const stack = [p];
        seen[p] = 1;
        while (stack.length) {
          const q = stack.pop()!, x = q % n, y = Math.floor(q / n);
          x0 = Math.min(x0, x); x1 = Math.max(x1, x); y0 = Math.min(y0, y); y1 = Math.max(y1, y);
          for (const r of [q - 1, q + 1, q - n, q + n]) if (r >= 0 && r < n * n && lit[r] && !seen[r] && Math.abs((r % n) - x) <= 1) { seen[r] = 1; stack.push(r); }
        }
        if (x0 === 0 || y0 === 0 || x1 === n - 1 || y1 === n - 1) continue;
        const w = x1 - x0 + 1, h = y1 - y0 + 1;
        expect(w / h, `star at ${el0}°: ${w} × ${h}`).toBeGreaterThan(0.8);
        expect(w / h, `star at ${el0}°: ${w} × ${h}`).toBeLessThan(1.25);
        stars++;
      }
      expect(stars, `stars near ${el0}°`).toBeGreaterThan(0);
    }
  });
});

describe("environments: the studio's structure", () => {
  it("is dark on the camera's side and light on the far side; its cards are in reflections only", () => {
    const camAz = 35;
    const s = buildSky("studio", camAz, DEFAULT_LIGHT_DIRECTION);
    const toward = look(s, dirOf(camAz, 20), DIFFUSE), away = look(s, dirOf(camAz + 180, 20), DIFFUSE);
    expect(toward[1]).toBeLessThan(away[1] * 0.3);
    // The flag: the ground on the camera's side is darker than the ground behind the model on the key's side (which
    // neither the flag nor the model's shadow reaches).
    const clear = look(s, dirOf(camAz + 225, -30), DIFFUSE)[1];
    expect(clear).toBeGreaterThan(look(s, dirOf(camAz + 180, -30), DIFFUSE)[1] - 1e-9);
    expect(look(s, dirOf(camAz, -30), DIFFUSE)[1]).toBeLessThan(clear * 0.6);
    // The overhead strip, above and a little towards the camera.
    const strip = dirOf(camAz, 81.5);
    expect(look(s, strip, FILTERED)[1] - look(s, strip, DIFFUSE)[1]).toBeGreaterThan(3);
    expect(look(s, strip, BACKDROP)[1]).toBeLessThan(1);
    // The walls and the flag reach their darkness at the horizon: no bright band there on the camera's side.
    expect(look(s, dirOf(camAz, 2), DIFFUSE)[1]).toBeLessThan(away[1] * 0.15);
    expect(look(s, dirOf(camAz, -2), DIFFUSE)[1]).toBeLessThan(look(s, dirOf(camAz + 180, -2), DIFFUSE)[1] * 0.55);
    // The model's shadow on the floor: the ground away from the key is darker than the ground towards it, at the
    // same angle from the camera's side.
    const keyAz = KEY_AZ, side = (keyAz - camAz + 360) % 360;
    const towardKey = look(s, dirOf(camAz + side, -40), DIFFUSE)[1], awayFromKey = look(s, dirOf(camAz - side, -40), DIFFUSE)[1];
    expect(awayFromKey).toBeLessThan(towardKey * 0.75);
    // The rig turns with the camera, and the shadow with the key.
    const t = buildSky("studio", camAz + 90, lightDirection(KEY_AZ + 90, 40));
    expect(look(t, dirOf(camAz + 90, 20), DIFFUSE)[1]).toBeCloseTo(toward[1], 9);
    expect(look(t, dirOf(camAz + 90 - side, -40), DIFFUSE)[1]).toBeCloseTo(awayFromKey, 9);
  });

  it("a mirror sees each directional light as a softbox that gives the light's own irradiance", () => {
    const lights = [
      { dir: lightDirection(-40, 55), size: 1, color: [1, 1, 1] as Vec3, power: 1 },
      { dir: lightDirection(120, 30), size: 3, color: [1, 0.5, 0.25] as Vec3, power: 0.6 },
      { dir: [0, 1, 0] as Vec3, size: 1, color: [1, 1, 1] as Vec3, power: 2, position: [0, 3, 0] as Vec3 },
    ];
    const s = buildEnvironment("studio", { cameraAzimuth: 35, lights });
    lights.forEach((l, i) => {
      // ∫ L cos dΩ over the box about its axis, on a fine polar grid.
      const t = lightAngle(l.size) * 1.3, n = 400, m = 64;
      const sum = [0, 0, 0];
      const d = l.dir, ref: Vec3 = Math.abs(d[1]) < 0.9 ? [0, 1, 0] : [1, 0, 0];
      const u: Vec3 = [d[1] * ref[2] - d[2] * ref[1], d[2] * ref[0] - d[0] * ref[2], d[0] * ref[1] - d[1] * ref[0]];
      const ul = Math.hypot(...u); u[0] /= ul; u[1] /= ul; u[2] /= ul;
      const v: Vec3 = [d[1] * u[2] - d[2] * u[1], d[2] * u[0] - d[0] * u[2], d[0] * u[1] - d[1] * u[0]];
      for (let a = 0; a < n; a++) {
        const th = ((a + 0.5) / n) * t, dw = (t / n) * ((2 * Math.PI) / m) * Math.sin(th);
        for (let b = 0; b < m; b++) {
          const ph = ((b + 0.5) / m) * 2 * Math.PI;
          const x = Math.sin(th) * Math.cos(ph), y = Math.sin(th) * Math.sin(ph), z = Math.cos(th);
          const box = [0, 0, 0];
          softboxAt(s, i, u[0] * x + v[0] * y + d[0] * z, u[1] * x + v[1] * y + d[1] * z, u[2] * x + v[2] * y + d[2] * z, box, 0);
          for (let c = 0; c < 3; c++) sum[c] += box[c] * z * dw;
        }
      }
      for (let c = 0; c < 3; c++) {
        const want = l.position ? 0 : Math.PI * KEY * l.power * toLinear(l.color[c]);
        expect(Math.abs(sum[c] - want), `light ${i} channel ${c}`).toBeLessThanOrEqual(0.01 * Math.max(want, 1e-9) + 1e-12);
      }
    });
    // MIRROR is REFLECT and the boxes; the boxes are no part of what lights or what the backdrop is.
    const at = lights[0].dir;
    const box = [0, 0, 0];
    softboxAt(s, 0, at[0], at[1], at[2], box, 0);
    expect(maxDiff(look(s, at, MIRROR), [look(s, at, REFLECT)[0] + box[0], look(s, at, REFLECT)[1] + box[1], look(s, at, REFLECT)[2] + box[2]])).toBeLessThan(1e-9);
    expect(box[0]).toBeGreaterThan(50);
    expect(look(s, at, FILTERED)[0]).toBeLessThan(5);
  });

  it("the key is the first directional light, or the default key", () => {
    expect(keyDirection()).toEqual(DEFAULT_LIGHT_DIRECTION);
    expect(keyDirection([{ dir: [0, 1, 0], position: [0, 2, 0] }, { dir: [1, 0, 0] }, { dir: [0, 0, 1] }])).toEqual([1, 0, 0]);
  });
});

describe("environments: image-based light", () => {
  const L: Vec3 = [0.7, 0.35, 1.3];
  const constant: SkySampler = (_x, _y, _z, out) => { out[0] = L[0]; out[1] = L[1]; out[2] = L[2]; };

  it("a constant sky gives SH irradiance over π of L within 1%, and prefiltered maps of L within 0.5%", () => {
    const sh = projectSh(constant), levels = prefilterLevels(constant);
    const o = [0, 0, 0];
    for (let i = 0; i < 500; i++) {
      const y = 1 - (2 * (i + 0.5)) / 500, r = Math.sqrt(1 - y * y), ph = i * 2.399963;
      const n: Vec3 = [Math.cos(ph) * r, y, Math.sin(ph) * r];
      irradiance({ sh }, n[0], n[1], n[2], o, 0);
      for (let c = 0; c < 3; c++) expect(Math.abs(o[c] / L[c] - 1)).toBeLessThan(0.01);
      for (const rough of [0, 0.1, 0.15, 0.22, 0.3, 0.5, 0.7, 0.9, 1]) {
        const p = [0, 0, 0];
        prefiltered({ levels }, n[0], n[1], n[2], rough, 1, p, 0);
        for (let c = 0; c < 3; c++) expect(Math.abs(p[c] / L[c] - 1)).toBeLessThan(0.005);
      }
    }
  });

  it("irradiance follows the sky: the studio lights a face turned from the camera more than one turned to it", () => {
    const s = buildSky("studio", 35, DEFAULT_LIGHT_DIRECTION);
    const a = [0, 0, 0], b = [0, 0, 0], up = [0, 0, 0], down = [0, 0, 0];
    const t = dirOf(35, 0), f = dirOf(215, 0);
    irradiance(s, t[0], t[1], t[2], a, 0);
    irradiance(s, f[0], f[1], f[2], b, 0);
    irradiance(s, 0, 1, 0, up, 0);
    irradiance(s, 0, -1, 0, down, 0);
    expect(a[1]).toBeLessThan(b[1] * 0.8);
    expect(up[1]).toBeGreaterThan(0.1);
    expect(down[1]).toBeGreaterThan(0.1);
  });
});

describe("environments: building and caching", () => {
  const bytes = (t: SkyTables): Uint8Array[] => [t.grad, t.below, t.cards, t.disc, t.sh, ...t.levels].map((a) => new Uint8Array(a.buffer, a.byteOffset, a.byteLength));
  const same = (a: SkyTables, b: SkyTables): boolean => {
    const x = bytes(a), y = bytes(b);
    return x.length === y.length && x.every((v, i) => v.length === y[i].length && v.every((q, j) => q === y[i][j]));
  };

  it("cached and fresh tables are byte-identical, on the pool's shared memory too", () => {
    const lights = [{ dir: lightDirection(30, 50), size: 2, color: [1, 0.9, 0.8] as Vec3, power: 1 }];
    for (const env of ENVIRONMENTS) {
      const cache = { env: new Map<string, unknown>() };
      const miss = buildEnvironment(env, { cameraAzimuth: 35.25, lights, cache });
      const hit = buildEnvironment(env, { cameraAzimuth: 35.25, lights, cache });
      const fresh = buildSky(env, 35.25, lights[0].dir);
      const shared = buildEnvironment(env, { cameraAzimuth: 35.25, lights, cache, shared: true });
      expect(hit.sh).toBe(miss.sh);
      expect(same(miss, fresh), env).toBe(true);
      expect(same(hit, fresh), env).toBe(true);
      expect(same(shared, fresh), env).toBe(true);
      expect(shared.levels[0].buffer).toBeInstanceOf(SharedArrayBuffer);
      expect(shared.boxes.buffer).toBeInstanceOf(SharedArrayBuffer);
      expect(cache.env.size).toBe(1);
      // A sky depends only on what it uses: sunset and night not on the camera, studio and overcast not on the key.
      buildEnvironment(env, { cameraAzimuth: 80, key: lightDirection(-10, 30), lights, cache });
      expect(cache.env.size, env).toBe(env === "overcast" ? 1 : 2);
    }
  });

  it("posts to a worker whole: a structured clone looks up the same light, and shared tables stay shared", () => {
    const lights = [{ dir: lightDirection(-40, 55), size: 1, color: [1, 1, 1] as Vec3, power: 1 }];
    for (const shared of [false, true]) {
      const s = buildEnvironment("studio", { cameraAzimuth: 35, lights, shared });
      const c = structuredClone(s);
      if (shared) {
        // The same memory: a write through the clone is seen by the original (and put back).
        const before = s.levels[2][0];
        c.levels[2][0] = 12345;
        expect(s.levels[2][0]).toBe(12345);
        c.levels[2][0] = before;
      }
      for (let i = 0; i < 50; i++) {
        const d: Vec3 = dirOf(i * 37, -80 + i * 3.2);
        for (const mode of [DIFFUSE, FILTERED, BACKDROP, REFLECT, MIRROR] as SkyMode[]) expect(look(c, d, mode)).toEqual(look(s, d, mode));
        const a = [0, 0, 0], b = [0, 0, 0];
        prefiltered(s, d[0], d[1], d[2], 0.37, 1, a, 0);
        prefiltered(c, d[0], d[1], d[2], 0.37, 1, b, 0);
        expect(b).toEqual(a);
        irradiance(s, d[0], d[1], d[2], a, 0);
        irradiance(c, d[0], d[1], d[2], b, 0);
        expect(b).toEqual(a);
      }
    }
  });

  it("logs each sky's build time, at most 170 ms", () => {
    const times: string[] = [];
    for (const env of ENVIRONMENTS) {
      const t0 = performance.now();
      buildSky(env, 35, DEFAULT_LIGHT_DIRECTION);
      const t1 = performance.now();
      buildSky(env, 36, DEFAULT_LIGHT_DIRECTION);
      const t2 = performance.now();
      times.push(`${env} ${(t1 - t0).toFixed(0)} ms, again ${(t2 - t1).toFixed(0)} ms`);
      expect(Math.min(t1 - t0, t2 - t1), env).toBeLessThanOrEqual(170);
      // The first build of a process also compiles the code; a generous bound keeps it honest under load.
      expect(t1 - t0, env).toBeLessThanOrEqual(400);
    }
    console.log(`sky build times: ${times.join("; ")}`);
  });
});

describe("environments: the viewer's map", () => {
  it("is FILTERED as a 128 × 64 lat-long in three.js's equirectangular layout, with the backdrop's parameters", () => {
    const s = buildSky("studio", 35, DEFAULT_LIGHT_DIRECTION);
    const m = environmentLatLong(s);
    expect(m.width).toBe(128);
    expect(m.height).toBe(64);
    expect(m.data.length).toBe(128 * 64 * 3);
    expect(m.ambient).toBe(environmentPalette("studio").ambient);
    expect(m.backdrop.ground).toEqual(environmentPalette("studio").ground);
    // three.js: u = atan2(z, x) / 2π + 0.5, v = asin(y) / π + 0.5, row 0 the nadir.
    const texel = (d: Vec3): Vec3 => {
      const u = Math.atan2(d[2], d[0]) / (2 * Math.PI) + 0.5, v = Math.asin(d[1]) / Math.PI + 0.5;
      const i = Math.min(127, Math.floor(u * 128)), j = Math.min(63, Math.floor(v * 64)), o = (j * 128 + i) * 3;
      return [m.data[o], m.data[o + 1], m.data[o + 2]];
    };
    // Smooth places agree with FILTERED; the overhead strip is where it is; the camera's side is dark.
    for (const d of [dirOf(215, 30), dirOf(215, -40), dirOf(100, 10)]) expect(maxDiff(texel(d), look(s, d, FILTERED))).toBeLessThan(0.03);
    expect(texel(dirOf(35, 81.5))[1]).toBeGreaterThan(2);
    expect(texel(dirOf(35, 30))[1]).toBeLessThan(texel(dirOf(215, 30))[1] * 0.3);
    // three.js's LightProbe (shGetIrradianceAt, then a Lambert BRDF's 1/π) from diffuseSH is the beauty render's irradiance.
    const threeIrradiance = (sh: Float32Array, x: number, y: number, z: number, c: number): number =>
      (sh[c] * 0.886227 + sh[3 + c] * 2 * 0.511664 * y + sh[6 + c] * 2 * 0.511664 * z + sh[9 + c] * 2 * 0.511664 * x +
        sh[12 + c] * 2 * 0.429043 * x * y + sh[15 + c] * 2 * 0.429043 * y * z + sh[18 + c] * (0.743125 * z * z - 0.247708) +
        sh[21 + c] * 2 * 0.429043 * x * z + sh[24 + c] * 0.429043 * (x * x - y * y)) / Math.PI;
    for (const n of [dirOf(35, 0), dirOf(110, -10), dirOf(215, 40), [0, 1, 0] as Vec3, [0, -1, 0] as Vec3]) {
      const ours = [0, 0, 0];
      irradiance(s, n[0], n[1], n[2], ours, 0);
      for (let c = 0; c < 3; c++) expect(threeIrradiance(m.diffuseSH, n[0], n[1], n[2], c)).toBeCloseTo(ours[c], 4);
    }
    const sunset = environmentLatLong(buildSky("sunset", 35, DEFAULT_LIGHT_DIRECTION));
    expect(sunset.backdrop.disc?.radius).toBeCloseTo(0.022, 9);
    expect(azimuthOf(sunset.backdrop.disc!.dir)).toBeCloseTo(KEY_AZ, 6);
    expect(environmentLatLong(buildSky("night", 35, DEFAULT_LIGHT_DIRECTION)).backdrop.stars).toBe(true);
  });
});
