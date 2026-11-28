/**
 * lights.png, the light study: the shot under each declared light alone, then under all of them; under each, exactly
 * what that light adds, brightened; and last the shot under no light at all. All of it from one render.
 *
 * A render with splitLights keeps each light's radiance apart (kernel.ts, pbr.ts): slot 0 holds what no light
 * brings (the sky's light, the glows, the backdrop, the sky in a mirror) and slot i + 1 everything light i brings, on
 * the model and the floor, in a mirror and through glass. The picture is their sum. So each frame is that one pass:
 * - light i alone: slot 0 + slot i + 1;
 * - all: the render's own picture;
 * - none: slot 0;
 * - what light i adds: gain_i · slot i + 1, on black.
 * Each is composed in linear light and finished as the render finishes its own: bloom, the tone curve and the dither
 * (what a light adds without the bloom, so it is that light's radiance and nothing spread from elsewhere).
 *
 * It replaces a render per light, one under no light and one under all (n + 2 of them), which differed in more than
 * the light: the floor's albedo is solved per render from that render's directional lights, so each "alone" and the
 * "none" frame showed the palette's own floor, and the floor in what a light adds under-reported it; and a glow near
 * white in two pictures differs only in the channels not already full, so a flame a light barely touched came out
 * bright green once brightened (round 11), which needed a grey mask. A slot has no such artefacts: a glow lives in slot
 * 0, so what a light adds on a flame is the light on the flame's colour, and nothing else.
 *
 * A frame other than "all" takes an edge pixel's four samples as their mean in linear light (the slots keep no
 * other), where the render's own picture means them after the tone curve. Most silhouettes differ by a level or two
 * there, but one against something far brighter is brighter: a glow's edge by tens of levels (61 in a test scene),
 * which the bloom then spreads a few levels round it. Everywhere else a frame is finished as the render's own.
 */
import { Canvas, rgbDithered } from "./canvas.js";
import { drawText, GLYPH_HEIGHT, textWidth } from "./font.js";
import { bloom, decode, tonemap, toSrgb } from "./photometry.js";
import { INK } from "./views.js";
import type { KernelResult } from "./kernel.js";

/** The linear radiance a grey displays at 230/255: what the brightest part of a light's contribution is brightened to. */
export const ADDS_TARGET = (() => {
  const o = new Float64Array(3);
  decode(230 / 255, 230 / 255, 230 / 255, o, 0);
  return o[0];
})();
/** A pixel a light brings at least this much radiance to, in its brightest channel, is one the light reaches (a thousandth of what a key of power 1 brings a white face). */
export const REACHED = 1e-3;
/** The most and the least a light's contribution is brightened by. */
export const MIN_GAIN = 1, MAX_GAIN = 32;

/**
 * The brightening of one light's contribution (3 floats a pixel): its brightest channel's 99th percentile, over the
 * pixels the light reaches, brought to ADDS_TARGET, so the light's reach and colour fill the frame however small or
 * dim it is (round 10: a ring's spark was a few pixels of a whole picture). A few saturated pixels do not set it:
 * the percentile does. Between MIN_GAIN and MAX_GAIN; MIN_GAIN for a light that reaches nothing.
 */
export function addsGain(slot: Float32Array | Float64Array): number {
  const n = slot.length / 3;
  const peaks = new Float64Array(n);
  let k = 0;
  for (let i = 0; i < n; i++) {
    const r = slot[i * 3], g = slot[i * 3 + 1], b = slot[i * 3 + 2];
    const peak = r > g ? (r > b ? r : b) : g > b ? g : b;
    if (peak > REACHED) peaks[k++] = peak;
  }
  if (!k) return MIN_GAIN;
  const reached = peaks.subarray(0, k).sort();
  const p = reached[Math.min(k - 1, Math.floor(k * 0.99))];
  return Math.max(MIN_GAIN, Math.min(MAX_GAIN, ADDS_TARGET / p));
}

/**
 * A picture from linear radiance (3 floats a pixel), finished as the kernel finishes its own: bloom where the model
 * is (with `flags`; none for a frame on black), the tone curve, sRGB and the dither. Composed in single precision, as
 * the kernel's own picture is, so the same radiance gives the same bytes.
 */
export function encodePicture(lin: Float32Array | Float64Array, size: number, flags?: Uint8Array): Canvas {
  const buf = Float32Array.from(lin);
  if (flags) bloom(buf, flags, size);
  const canvas = new Canvas(size, size, INK.page);
  const tm = new Float64Array(3);
  for (let py = 0; py < size; py++)
    for (let px = 0; px < size; px++) {
      const i = py * size + px;
      tonemap(buf[i * 3], buf[i * 3 + 1], buf[i * 3 + 2], tm, 0);
      canvas.set(px, py, rgbDithered(toSrgb(tm[0]), toSrgb(tm[1]), toSrgb(tm[2]), px, py));
    }
  return canvas;
}

/** The study's frames, uncaptioned ("all" is the render's own picture, as it drew it), and the linear radiance each was finished from. */
export interface LightFrames {
  alone: Canvas[];
  all: Canvas;
  none: Canvas;
  adds: Canvas[];
  /** Each light's brightening, as addsGain gives it. */
  gains: number[];
  /** Linear radiance, 3 floats a pixel, before bloom: slot 0; slot 0 plus each light's; each light's times its gain. */
  hdr: { none: Float64Array; alone: Float64Array[]; adds: Float64Array[] };
}

/** The frames of the study from one square render with splitLights (one slot for the sky and one per light, and its flags). */
export function lightFrames(result: KernelResult): LightFrames {
  const slots = result.hdr;
  if (!slots || slots.length < 2) throw new Error("lights.png needs a render with splitLights: one slot for the sky and one per light");
  const size = result.canvas.width;
  const n = size * size * 3;
  const sky = slots[0];
  const none = Float64Array.from(sky);
  const alone: Float64Array[] = [], adds: Float64Array[] = [], gains: number[] = [];
  for (const slot of slots.slice(1)) {
    const a = new Float64Array(n);
    for (let k = 0; k < n; k++) a[k] = sky[k] + slot[k];
    alone.push(a);
    const gain = addsGain(slot);
    gains.push(gain);
    const d = new Float64Array(n);
    for (let k = 0; k < n; k++) d[k] = slot[k] * gain;
    adds.push(d);
  }
  return {
    alone: alone.map((a) => encodePicture(a, size, result.flags)),
    all: result.canvas,
    none: encodePicture(none, size, result.flags),
    adds: adds.map((d) => encodePicture(d, size)),
    gains,
    hdr: { none, alone, adds },
  };
}

/** One light as the study labels it: its name and what its frame's caption says of it (where it is, its power). */
export interface StudyLight {
  name: string;
  caption: string;
}

/** The gain as its frame prints it: two figures, none at all when it is about 1. */
export const gainText = (gain: number): string => (gain > 1.05 ? `, ×${Number(gain.toPrecision(2))}` : "");

/** Dark ink on a light picture, light ink on a dark one, and the luma between them that picks one. */
const DARK_INK = INK.text, LIGHT_INK = 0xe8e6e0;
const luma = (c: number): number => 0.2126 * ((c >> 16) & 255) + 0.7152 * ((c >> 8) & 255) + 0.0722 * (c & 255);
const INK_SPLIT = (luma(DARK_INK) + luma(LIGHT_INK)) / 2;

/**
 * A frame's caption at its foot, where the beauty render places its own, in whichever ink stands out from the
 * picture under it. The beauty render's mid-grey ink could not be read on a mid-grey floor (the lantern's rim and
 * flame frames and its picture under no light), nor the adds row's light grey on the floor a key lights.
 */
export function caption(c: Canvas, text: string): void {
  const x0 = 8, y0 = c.height - 12, x1 = Math.min(c.width, x0 + textWidth(text, 1)), y1 = Math.min(c.height, y0 + GLYPH_HEIGHT);
  let sum = 0, n = 0;
  for (let y = y0; y < y1; y++)
    for (let x = x0; x < x1; x++) {
      const o = (y * c.width + x) * 4;
      sum += 0.2126 * c.data[o] + 0.7152 * c.data[o + 1] + 0.0722 * c.data[o + 2];
      n++;
    }
  drawText(c, x0, y0, text, n && sum / n < INK_SPLIT ? LIGHT_INK : DARK_INK, 1);
}

/**
 * lights.png: each light alone, then all of them, across the top; under each, what it adds, and under "all" the
 * picture under no light, each frame captioned here. `result` is one render of the shot with splitLights, uncaptioned.
 */
export function lightStudy(result: KernelResult, lights: StudyLight[]): Canvas {
  const f = lightFrames(result);
  const frame = result.canvas.width;
  const gutter = 6, bar = 26, rowBar = 16;
  const cols = lights.length + 1;
  const strip = new Canvas((frame + gutter) * cols + gutter, bar + (frame + gutter) * 2 + rowBar + gutter, INK.page);
  strip.fill(0, 0, strip.width, bar, INK.bar);
  const title = `LIGHTS   each alone, then all ${lights.length}`;
  const big = textWidth(title, 2) + 20 <= strip.width;
  drawText(strip, 10, big ? 7 : 10, title, INK.barText, big ? 2 : 1);
  const rowY = bar + gutter + frame + gutter;
  // The row's key, as much of it as the strip is wide for (a quick pass's strip cut the long one short).
  const key = ["what each adds on its own, exactly, brightened by the gain shown. last: no light at all, the sky's ambient and the glows", "what each adds, brightened by the gain shown. last: no light at all", "what each adds. last: no light"].find((t) => textWidth(t, 1) + 20 <= strip.width) ?? "what each adds";
  drawText(strip, 10, rowY + 3, key, INK.dim, 1);
  lights.forEach((l, i) => {
    caption(f.alone[i], `${l.name}  ${l.caption}`);
    caption(f.adds[i], `${l.name} adds${gainText(f.gains[i])}`);
    strip.blit(f.alone[i], gutter + i * (frame + gutter), bar + gutter);
    strip.blit(f.adds[i], gutter + i * (frame + gutter), rowY + rowBar);
  });
  caption(f.all, "all");
  strip.blit(f.all, gutter + lights.length * (frame + gutter), bar + gutter);
  caption(f.none, "no light");
  strip.blit(f.none, gutter + lights.length * (frame + gutter), rowY + rowBar);
  return strip;
}
