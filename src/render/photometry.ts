/**
 * The beauty render's photometry: the units light is measured in, the tone curve that turns linear radiance into a
 * display colour, and the few constants every part of the renderer (and the viewer page, and the GLB's lights) must
 * agree on. Pure arithmetic: no state, no allocation in the per-pixel functions.
 *
 * Light is linear radiance throughout. A colour a program gives (a material's, a light's, a palette's) is sRGB, and
 * is decoded with `toLinear` before it lights anything. The picture is encoded back with `encode`: the tone curve,
 * then sRGB.
 *
 * The tone curve is Khronos PBR Neutral, the curve three.js calls NeutralToneMapping: a small toe that lifts nothing
 * above 0.08, then the identity (a base colour lit square-on displays as itself) up to 0.76, then a shoulder that
 * rolls highlights off towards 1 instead of clipping them. One change: the shoulder is taken per channel rather than
 * on the peak with Neutral's desaturation. A flame or a gold glint then goes yellow and then white as it brightens,
 * as film does; Neutral's hue-keeping desaturation turned the lantern's orange flame salmon pink. Below the shoulder
 * the two are the same function, so a model's colours are what three.js's NeutralToneMapping shows.
 */

/** A light of power 1 lights a white surface turned square to it to this radiance: the unit of `light(power=)`. */
export const KEY = 1.05;
/** A glow of 1 gives off its colour at this radiance, brighter than a lit surface, so a flame reads as a source. */
export const GLOW = 1.6;
/** Where the tone curve's shoulder starts (Neutral's 0.8 less its 0.04 toe offset), and its width to 1. */
export const TONE_START = 0.8 - 0.04;
const TONE_D = 1 - TONE_START;
/**
 * Beer's law: a glass of colour c absorbs BEER(1 − c) per `reach` of thickness, per channel. The old renderer dimmed
 * display colours by exp(−10(1 − c)·t/reach); a display value is near linear light to the power 1/2.2, so the same
 * drink in linear light takes 2.2 times that (at 10 a tumbler's whisky came out the colour of milky tea, 47 levels
 * lighter than it was).
 */
export const BEER = 22;

/** sRGB to linear, one channel. */
export const toLinear = (v: number): number => (v <= 0.04045 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4));
/** Linear to sRGB, one channel. */
export const toSrgb = (v: number): number => (v <= 0.0031308 ? v * 12.92 : 1.055 * Math.pow(v, 1 / 2.4) - 0.055);

type Out = Float32Array | Float64Array | number[];

/**
 * The tone curve, linear radiance in, linear display values in [0, 1) out, into out[o..o+2]. Neutral's toe (the
 * smallest channel decides an offset: x − 6.25x² below 0.08, else 0.04), then each channel on its own: the identity
 * below TONE_START, 1 − d² / (v + d − TONE_START) above it, with d = 1 − TONE_START. Inputs are radiance, so ≥ 0.
 */
export function tonemap(r: number, g: number, b: number, out: Out, o = 0): void {
  const x = r < g ? (r < b ? r : b) : g < b ? g : b;
  const offset = x < 0.08 ? x - 6.25 * x * x : 0.04;
  r -= offset; g -= offset; b -= offset;
  out[o] = r < TONE_START ? r : 1 - (TONE_D * TONE_D) / (r + TONE_D - TONE_START);
  out[o + 1] = g < TONE_START ? g : 1 - (TONE_D * TONE_D) / (g + TONE_D - TONE_START);
  out[o + 2] = b < TONE_START ? b : 1 - (TONE_D * TONE_D) / (b + TONE_D - TONE_START);
}

/**
 * The tone curve's exact inverse: the radiance that `tonemap` takes to these display values (each below 1), into
 * out[o..o+2]. The shoulder is undone per channel; then the toe's offset, which the smallest channel decides (the
 * curve keeps the order of the channels, so the smallest stays the smallest). A value of 1 or more, which the curve
 * never reaches, is read as just under 1.
 */
export function untone(r: number, g: number, b: number, out: Out, o = 0): void {
  const top = 1 - 1e-12;
  const pr = r < TONE_START ? r : (TONE_D * TONE_D) / (1 - Math.min(r, top)) - TONE_D + TONE_START;
  const pg = g < TONE_START ? g : (TONE_D * TONE_D) / (1 - Math.min(g, top)) - TONE_D + TONE_START;
  const pb = b < TONE_START ? b : (TONE_D * TONE_D) / (1 - Math.min(b, top)) - TONE_D + TONE_START;
  // After the toe the smallest channel is 6.25x² (x below 0.08, so under 0.04) or x − 0.04.
  const m = Math.max(0, pr < pg ? (pr < pb ? pr : pb) : pg < pb ? pg : pb);
  const offset = m < 0.04 ? 0.4 * Math.sqrt(m) - m : 0.04;
  out[o] = pr + offset; out[o + 1] = pg + offset; out[o + 2] = pb + offset;
}

/** Linear radiance to an sRGB display colour in [0, 1): the tone curve, then the sRGB encoding. */
export function encode(r: number, g: number, b: number, out: Out, o = 0): void {
  tonemap(r, g, b, out, o);
  out[o] = toSrgb(out[o]); out[o + 1] = toSrgb(out[o + 1]); out[o + 2] = toSrgb(out[o + 2]);
}

/** An sRGB display colour to the linear radiance `encode` shows as it: how a palette keeps the look it had. */
export function decode(r: number, g: number, b: number, out: Out, o = 0): void {
  untone(toLinear(r), toLinear(g), toLinear(b), out, o);
}

/** A light's size as an angular radius in radians: 1 is about 3.2°, 3 about 9.5°. Its shadow's disc, its highlight's widening and its softbox in a mirror all take this one angle. */
export const lightAngle = (size: number): number => size / 18;
/** A point light's radius, a sphere: 2% of its range per unit of size. */
export const pointRadius = (size: number, range: number): number => 0.02 * range * size;
/** The fraction of one channel a glass of that channel's colour c lets through over a length `len`, with `reach` the model's scale (Beer's law, σ = BEER(1 − c)/reach). */
export const beer = (c: number, len: number, reach: number): number => Math.exp((-BEER * (1 - c) * len) / reach);

/** A GLSL float literal: always with a decimal point, as GLSL ES requires. */
const glslFloat = (v: number): string => {
  const s = String(v);
  return /[.eE]/.test(s) ? s : `${s}.0`;
};

/**
 * The tone curve as the body of a GLSL function `vec3 f(vec3 color)`, generated from the constants above, for the
 * viewer page: three.js's CustomToneMapping takes it (its exposure first, as three.js's own curves do). Written
 * per channel with plain arithmetic so it means in GLSL exactly what `tonemap` means here.
 */
export const TONEMAP_GLSL = [
  "color *= toneMappingExposure;",
  "float x = min(color.r, min(color.g, color.b));",
  "float offset = x < 0.08 ? x - 6.25 * x * x : 0.04;",
  "color.r -= offset; color.g -= offset; color.b -= offset;",
  ...(["r", "g", "b"] as const).map((c) => `if (color.${c} >= ${glslFloat(TONE_START)}) color.${c} = 1.0 - ${glslFloat(TONE_D * TONE_D)} / (color.${c} + ${glslFloat(TONE_D - TONE_START)});`),
  "return color;",
].join("\n");

/**
 * The kernel's per-pixel flags byte, laid out as the visibility filter (denoise.ts) reads it, with the same names and
 * values: what the pixel sees in the low two bits (KIND_SKY, KIND_MODEL, KIND_FLOOR), FLAG_EDGE for a pixel the edge
 * pass sampled four times; then the kernel's own: FLAG_SHINY, a reflective surface (the edge pass also compares
 * brightness next to one), and FLAG_GLOW, a surface that glows. Only model pixels bloom.
 */
export const KIND_MASK = 0x03, KIND_SKY = 0, KIND_MODEL = 1, KIND_FLOOR = 2, FLAG_EDGE = 0x04, FLAG_SHINY = 0x08, FLAG_GLOW = 0x10;
/** The radiance above which a model pixel spills light into its neighbours (a lit white surface is KEY). */
export const BLOOM_THRESHOLD = 1.25;

/**
 * Bloom, on the linear image before the tone map, in place: what a model pixel has above BLOOM_THRESHOLD in each
 * channel is gathered at a quarter of the size, blurred by two Gaussians (1% and 3.5% of the picture, weights 0.1
 * and 0.08), and added back to every pixel, bilinearly. Only the model blooms: a sunset's
 * bright band is backdrop, and bloomed it washed the sky. A glow and a mirror's sun spill a little light round
 * themselves; a lit part keeps its edges. `hdr` is 3 floats a pixel, `flags` one byte a pixel (KIND_MODEL in its
 * kind bits marks the model). Fixed order throughout.
 */
export function bloom(hdr: Float32Array | Float64Array, flags: Uint8Array, size: number): void {
  const q = 4;
  const w = Math.ceil(size / q);
  const src = new Float64Array(w * w * 3);
  let any = false;
  for (let y = 0; y < size; y++)
    for (let x = 0; x < size; x++) {
      const i = y * size + x;
      if ((flags[i] & KIND_MASK) !== KIND_MODEL) continue;
      const o = (Math.floor(y / q) * w + Math.floor(x / q)) * 3;
      for (let c = 0; c < 3; c++) {
        const v = hdr[i * 3 + c] - BLOOM_THRESHOLD;
        if (v > 0) { src[o + c] += v / (q * q); any = true; }
      }
    }
  if (!any) return;
  const add = new Float64Array(w * w * 3), tmp = new Float64Array(w * w * 3);
  for (const [fr, k] of [[0.01, 0.1], [0.035, 0.08]] as const) {
    const sigma = Math.max(0.5, (size * fr) / q);
    const r = Math.ceil(sigma * 2.5);
    const wt = new Float64Array(r * 2 + 1);
    let ws = 0;
    for (let i = -r; i <= r; i++) { wt[i + r] = Math.exp(-(i * i) / (2 * sigma * sigma)); ws += wt[i + r]; }
    for (let i = 0; i < wt.length; i++) wt[i] /= ws;
    for (let y = 0; y < w; y++)
      for (let x = 0; x < w; x++)
        for (let c = 0; c < 3; c++) {
          let s = 0;
          for (let i = -r; i <= r; i++) { const xx = x + i; if (xx >= 0 && xx < w) s += src[(y * w + xx) * 3 + c] * wt[i + r]; }
          tmp[(y * w + x) * 3 + c] = s;
        }
    for (let y = 0; y < w; y++)
      for (let x = 0; x < w; x++)
        for (let c = 0; c < 3; c++) {
          let s = 0;
          for (let i = -r; i <= r; i++) { const yy = y + i; if (yy >= 0 && yy < w) s += tmp[(yy * w + x) * 3 + c] * wt[i + r]; }
          add[(y * w + x) * 3 + c] += s * k;
        }
  }
  for (let y = 0; y < size; y++)
    for (let x = 0; x < size; x++) {
      // Bilinear from the quarter-size blur, at this pixel's centre.
      const fx = Math.max(0, Math.min(w - 1, (x + 0.5) / q - 0.5)), fy = Math.max(0, Math.min(w - 1, (y + 0.5) / q - 0.5));
      const x0 = Math.floor(fx), y0 = Math.floor(fy), x1 = Math.min(w - 1, x0 + 1), y1 = Math.min(w - 1, y0 + 1);
      const ux = fx - x0, uy = fy - y0;
      const i = (y * size + x) * 3;
      for (let c = 0; c < 3; c++) {
        const a = add[(y0 * w + x0) * 3 + c], b = add[(y0 * w + x1) * 3 + c], e = add[(y1 * w + x0) * 3 + c], f = add[(y1 * w + x1) * 3 + c];
        const v = (a + (b - a) * ux) * (1 - uy) + (e + (f - e) * ux) * uy;
        if (v > 0) hdr[i + c] += v;
      }
    }
}
