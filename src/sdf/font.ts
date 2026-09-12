/**
 * A single-stroke font, so `text("ABC")` is a 2D profile: every glyph is a
 * few polylines on a grid 4 wide and 6 tall (cap height), baseline at 0,
 * and the profile is everything within half the stroke weight of those
 * lines (a chain of 2D capsules, exact). Uppercase, lowercase (x-height 4
 * of the cap height 6, descenders to -2), digits and punctuation. Curves
 * are short polylines, which the weight rounds off.
 */
import { shape2 } from "./shapes2d.js";
import { type Bounds2, type Shape2, EMPTY_BOUNDS2 } from "./types.js";

/** Each glyph: strokes as flat x,y lists on the 4x6 grid, plus its advance width. */
type Glyph = { strokes: number[][]; width: number };

const G: Record<string, Glyph> = {
  A: { strokes: [[0, 0, 2, 6, 4, 0], [0.8, 2.4, 3.2, 2.4]], width: 4 },
  B: { strokes: [[0, 0, 0, 6, 2.6, 6, 3.4, 5.4, 3.4, 3.8, 2.6, 3.2, 0, 3.2], [2.6, 3.2, 3.6, 2.6, 3.6, 0.8, 2.8, 0, 0, 0]], width: 4 },
  C: { strokes: [[3.6, 5, 2.8, 5.8, 1.2, 5.8, 0.2, 4.8, 0.2, 1.2, 1.2, 0.2, 2.8, 0.2, 3.6, 1]], width: 4 },
  D: { strokes: [[0, 0, 0, 6, 2.2, 6, 3.4, 5, 3.6, 3, 3.4, 1, 2.2, 0, 0, 0]], width: 4 },
  E: { strokes: [[3.4, 0, 0, 0, 0, 6, 3.4, 6], [0, 3.2, 2.6, 3.2]], width: 3.8 },
  F: { strokes: [[0, 0, 0, 6, 3.4, 6], [0, 3.2, 2.6, 3.2]], width: 3.8 },
  G: { strokes: [[3.6, 5, 2.8, 5.8, 1.2, 5.8, 0.2, 4.8, 0.2, 1.2, 1.2, 0.2, 2.8, 0.2, 3.6, 1, 3.6, 2.8, 2.2, 2.8]], width: 4 },
  H: { strokes: [[0, 0, 0, 6], [3.6, 0, 3.6, 6], [0, 3.2, 3.6, 3.2]], width: 4 },
  I: { strokes: [[0.2, 0, 2.2, 0], [1.2, 0, 1.2, 6], [0.2, 6, 2.2, 6]], width: 2.6 },
  J: { strokes: [[0.2, 1.2, 1, 0.2, 2.2, 0.2, 3, 1.2, 3, 6]], width: 3.4 },
  K: { strokes: [[0, 0, 0, 6], [3.4, 6, 0, 2.6], [1.2, 3.6, 3.6, 0]], width: 4 },
  L: { strokes: [[0, 6, 0, 0, 3.4, 0]], width: 3.8 },
  M: { strokes: [[0, 0, 0, 6, 2, 2.6, 4, 6, 4, 0]], width: 4.4 },
  N: { strokes: [[0, 0, 0, 6, 3.6, 0, 3.6, 6]], width: 4 },
  O: { strokes: [[1.2, 0.2, 0.2, 1.2, 0.2, 4.8, 1.2, 5.8, 2.6, 5.8, 3.6, 4.8, 3.6, 1.2, 2.6, 0.2, 1.2, 0.2]], width: 4.2 },
  P: { strokes: [[0, 0, 0, 6, 2.6, 6, 3.6, 5.2, 3.6, 3.8, 2.6, 3, 0, 3]], width: 4 },
  Q: { strokes: [[1.2, 0.2, 0.2, 1.2, 0.2, 4.8, 1.2, 5.8, 2.6, 5.8, 3.6, 4.8, 3.6, 1.2, 2.6, 0.2, 1.2, 0.2], [2.2, 1.6, 3.8, -0.2]], width: 4.2 },
  R: { strokes: [[0, 0, 0, 6, 2.6, 6, 3.6, 5.2, 3.6, 3.8, 2.6, 3, 0, 3], [1.8, 3, 3.6, 0]], width: 4 },
  S: { strokes: [[3.4, 5, 2.6, 5.8, 1.1, 5.8, 0.3, 5, 0.3, 4, 1.1, 3.2, 2.7, 2.8, 3.5, 2, 3.5, 1, 2.7, 0.2, 1.1, 0.2, 0.3, 1]], width: 4 },
  T: { strokes: [[0, 6, 3.6, 6], [1.8, 6, 1.8, 0]], width: 3.8 },
  U: { strokes: [[0, 6, 0, 1.2, 1, 0.2, 2.6, 0.2, 3.6, 1.2, 3.6, 6]], width: 4 },
  V: { strokes: [[0, 6, 1.9, 0, 3.8, 6]], width: 4 },
  W: { strokes: [[0, 6, 1, 0, 2.2, 4, 3.4, 0, 4.4, 6]], width: 4.8 },
  X: { strokes: [[0, 0, 3.6, 6], [0, 6, 3.6, 0]], width: 4 },
  Y: { strokes: [[0, 6, 1.8, 3, 3.6, 6], [1.8, 3, 1.8, 0]], width: 4 },
  Z: { strokes: [[0, 6, 3.6, 6, 0, 0, 3.6, 0]], width: 4 },
  "0": { strokes: [[1.2, 0.2, 0.2, 1.2, 0.2, 4.8, 1.2, 5.8, 2.4, 5.8, 3.4, 4.8, 3.4, 1.2, 2.4, 0.2, 1.2, 0.2], [0.6, 1, 3, 5]], width: 4 },
  "1": { strokes: [[0.4, 4.6, 1.8, 6, 1.8, 0], [0.4, 0, 3.2, 0]], width: 3.6 },
  "2": { strokes: [[0.2, 4.8, 1.2, 5.8, 2.6, 5.8, 3.4, 4.8, 3.4, 3.8, 0, 0, 3.6, 0]], width: 4 },
  "3": { strokes: [[0.2, 6, 3.4, 6, 1.8, 3.4, 2.8, 3.4, 3.6, 2.6, 3.6, 1, 2.6, 0.2, 1.2, 0.2, 0.2, 1]], width: 4 },
  "4": { strokes: [[2.8, 0, 2.8, 6, 0, 1.8, 3.6, 1.8]], width: 4 },
  "5": { strokes: [[3.4, 6, 0.4, 6, 0.2, 3.2, 1.4, 3.6, 2.6, 3.6, 3.6, 2.6, 3.6, 1, 2.6, 0.2, 1.2, 0.2, 0.2, 1]], width: 4 },
  "6": { strokes: [[3.2, 5.8, 1.8, 5.8, 0.4, 4.4, 0.2, 1.4, 1.2, 0.2, 2.6, 0.2, 3.6, 1.2, 3.6, 2.4, 2.6, 3.4, 1.2, 3.4, 0.2, 2.4]], width: 4 },
  "7": { strokes: [[0.2, 6, 3.6, 6, 1.4, 0]], width: 4 },
  "8": { strokes: [[1.2, 3.2, 0.3, 4, 0.3, 5, 1.1, 5.8, 2.7, 5.8, 3.5, 5, 3.5, 4, 2.6, 3.2, 1.2, 3.2, 0.2, 2.4, 0.2, 1, 1.1, 0.2, 2.7, 0.2, 3.6, 1, 3.6, 2.4, 2.6, 3.2]], width: 4 },
  "9": { strokes: [[0.6, 0.2, 2, 0.2, 3.4, 1.6, 3.6, 4.6, 2.6, 5.8, 1.2, 5.8, 0.2, 4.8, 0.2, 3.6, 1.2, 2.6, 2.6, 2.6, 3.6, 3.6]], width: 4 },
  // Lowercase: x-height 4, ascenders to 6, descenders to -2.
  a: { strokes: [[3.2, 4, 3.2, 0], [3.2, 3.2, 2.4, 4, 1, 4, 0.2, 3.2, 0.2, 0.8, 1, 0, 2.4, 0, 3.2, 0.8]], width: 3.6 },
  b: { strokes: [[0.2, 6, 0.2, 0], [0.2, 3.2, 1, 4, 2.4, 4, 3.2, 3.2, 3.2, 0.8, 2.4, 0, 1, 0, 0.2, 0.8]], width: 3.6 },
  c: { strokes: [[3.2, 3.2, 2.4, 4, 1, 4, 0.2, 3.2, 0.2, 0.8, 1, 0, 2.4, 0, 3.2, 0.8]], width: 3.6 },
  d: { strokes: [[3.2, 6, 3.2, 0], [3.2, 3.2, 2.4, 4, 1, 4, 0.2, 3.2, 0.2, 0.8, 1, 0, 2.4, 0, 3.2, 0.8]], width: 3.6 },
  e: { strokes: [[0.2, 2, 3.2, 2, 3.2, 3.2, 2.4, 4, 1, 4, 0.2, 3.2, 0.2, 0.8, 1, 0, 2.4, 0, 3.2, 0.6]], width: 3.6 },
  f: { strokes: [[2.6, 5.8, 1.8, 5.8, 1.2, 5.2, 1.2, 0], [0.2, 4, 2.4, 4]], width: 2.8 },
  g: { strokes: [[3.2, 4, 3.2, -1, 2.4, -2, 1, -2, 0.4, -1.4], [3.2, 3.2, 2.4, 4, 1, 4, 0.2, 3.2, 0.2, 0.8, 1, 0, 2.4, 0, 3.2, 0.8]], width: 3.6 },
  h: { strokes: [[0.2, 6, 0.2, 0], [0.2, 3.2, 1, 4, 2.4, 4, 3.2, 3.2, 3.2, 0]], width: 3.6 },
  i: { strokes: [[0.6, 4, 0.6, 0], [0.6, 5.6, 0.6, 5.6]], width: 1.4 },
  j: { strokes: [[1.4, 4, 1.4, -1, 0.8, -2, 0, -1.8], [1.4, 5.6, 1.4, 5.6]], width: 1.8 },
  k: { strokes: [[0.2, 6, 0.2, 0], [2.8, 4, 0.2, 1.6], [1.2, 2.4, 3, 0]], width: 3.2 },
  l: { strokes: [[0.6, 6, 0.6, 0.6, 1.2, 0]], width: 1.6 },
  m: { strokes: [[0.2, 4, 0.2, 0], [0.2, 3.2, 0.9, 4, 1.8, 4, 2.4, 3.2, 2.4, 0], [2.4, 3.2, 3.1, 4, 4, 4, 4.6, 3.2, 4.6, 0]], width: 5 },
  n: { strokes: [[0.2, 4, 0.2, 0], [0.2, 3.2, 1, 4, 2.4, 4, 3.2, 3.2, 3.2, 0]], width: 3.6 },
  o: { strokes: [[1, 4, 2.4, 4, 3.2, 3.2, 3.2, 0.8, 2.4, 0, 1, 0, 0.2, 0.8, 0.2, 3.2, 1, 4]], width: 3.6 },
  p: { strokes: [[0.2, 4, 0.2, -2], [0.2, 3.2, 1, 4, 2.4, 4, 3.2, 3.2, 3.2, 0.8, 2.4, 0, 1, 0, 0.2, 0.8]], width: 3.6 },
  q: { strokes: [[3.2, 4, 3.2, -2], [3.2, 3.2, 2.4, 4, 1, 4, 0.2, 3.2, 0.2, 0.8, 1, 0, 2.4, 0, 3.2, 0.8]], width: 3.6 },
  r: { strokes: [[0.2, 4, 0.2, 0], [0.2, 2.8, 1, 4, 2.4, 4]], width: 2.6 },
  s: { strokes: [[2.8, 3.4, 2.2, 4, 0.8, 4, 0.2, 3.3, 0.8, 2.4, 2.2, 1.8, 2.8, 1, 2.2, 0, 0.8, 0, 0.2, 0.6]], width: 3.2 },
  t: { strokes: [[1, 5.6, 1, 0.8, 1.8, 0, 2.6, 0.4], [0.2, 4, 2.2, 4]], width: 2.8 },
  u: { strokes: [[0.2, 4, 0.2, 0.8, 1, 0, 2.4, 0, 3.2, 0.8], [3.2, 4, 3.2, 0]], width: 3.6 },
  v: { strokes: [[0.2, 4, 1.6, 0, 3, 4]], width: 3.4 },
  w: { strokes: [[0.2, 4, 1.1, 0, 2.2, 3, 3.3, 0, 4.2, 4]], width: 4.6 },
  x: { strokes: [[0.2, 4, 3, 0], [0.2, 0, 3, 4]], width: 3.4 },
  y: { strokes: [[0.2, 4, 1.6, 0], [3, 4, 1.2, -1.2, 0.4, -2]], width: 3.4 },
  z: { strokes: [[0.2, 4, 3, 4, 0.2, 0, 3, 0]], width: 3.4 },
  " ": { strokes: [], width: 2.4 },
  ".": { strokes: [[0.5, 0.3, 0.5, 0.3]], width: 1.6 },
  ",": { strokes: [[0.7, 0.4, 0.3, -0.8]], width: 1.6 },
  "-": { strokes: [[0.2, 3, 2.6, 3]], width: 3 },
  "+": { strokes: [[0.3, 3, 3.1, 3], [1.7, 1.6, 1.7, 4.4]], width: 3.4 },
  "!": { strokes: [[0.6, 6, 0.6, 2], [0.6, 0.3, 0.6, 0.3]], width: 1.8 },
  "?": { strokes: [[0.2, 4.8, 1.2, 5.8, 2.6, 5.8, 3.4, 4.8, 3.4, 4, 1.8, 2.8, 1.8, 2], [1.8, 0.3, 1.8, 0.3]], width: 4 },
  ":": { strokes: [[0.5, 1, 0.5, 1], [0.5, 4, 0.5, 4]], width: 1.6 },
  "'": { strokes: [[0.5, 6, 0.5, 4.6]], width: 1.6 },
  "/": { strokes: [[0, 0, 3.2, 6]], width: 3.6 },
  "&": { strokes: [[3.6, 0, 1, 3, 1, 5, 1.9, 5.8, 2.8, 5, 2.4, 3.8, 0.4, 2.2, 0.4, 0.8, 1.2, 0, 2.2, 0, 3.6, 2]], width: 4 },
  "(": { strokes: [[1.6, 6.2, 0.6, 4.6, 0.4, 3, 0.6, 1.4, 1.6, -0.2]], width: 2.2 },
  ")": { strokes: [[0.2, 6.2, 1.2, 4.6, 1.4, 3, 1.2, 1.4, 0.2, -0.2]], width: 2.2 },
  "#": { strokes: [[1, 0, 1.6, 6], [2.4, 0, 3, 6], [0.2, 2, 3.6, 2], [0.4, 4, 3.8, 4]], width: 4.2 },
  "*": { strokes: [[1.8, 5.6, 1.8, 2.4], [0.4, 4.8, 3.2, 3.2], [0.4, 3.2, 3.2, 4.8]], width: 4 },
  "=": { strokes: [[0.2, 2.2, 3.2, 2.2], [0.2, 3.8, 3.2, 3.8]], width: 3.6 },
};

export const FONT_GLYPHS: ReadonlyMap<string, Glyph> = new Map(Object.entries(G));

function glyph(ch: string): Glyph {
  return G[ch] ?? G[ch.toUpperCase()] ?? G[ch.toLowerCase()] ?? G["?"];
}

/**
 * The text as a 2D profile, laid out left to right from x = 0 with its
 * baseline on y = 0. `size` is the cap height; `weight` the stroke width
 * in the same units; `spacing` extra room between glyphs.
 */
/**
 * The text as a 2D profile, laid out left to right from x = 0 with its
 * baseline on y = 0. `size` is the cap height; `weight` the stroke width
 * in the same units; `spacing` extra room between glyphs. With `arc`, the
 * baseline is bent onto a circle of that radius centred on the origin,
 * the text centred at the top (arc > 0) or the bottom (arc < 0) and
 * reading left to right; long strokes are split so they follow the curve.
 */
export function textProfile(text: string, size = 1, weight = 0.15, spacing = 0, arc = 0): Shape2 {
  const scale = size / 6;
  const half = weight / 2;
  // Segments in world units.
  const seg: number[] = []; // x0, y0, x1, y1
  let cursor = 0;
  let bounds: Bounds2 = EMPTY_BOUNDS2;
  const grow = (x: number, y: number) => {
    bounds = {
      min: [Math.min(bounds.min[0], x - half), Math.min(bounds.min[1], y - half)],
      max: [Math.max(bounds.max[0], x + half), Math.max(bounds.max[1], y + half)],
    };
  };
  for (const ch of text) {
    const g = glyph(ch);
    for (const st of g.strokes) {
      if (st.length === 2) {
        const x = cursor + st[0] * scale, y = st[1] * scale;
        seg.push(x, y, x, y);
        grow(x, y);
        continue;
      }
      for (let i = 0; i + 3 < st.length; i += 2) {
        const x0 = cursor + st[i] * scale, y0 = st[i + 1] * scale;
        const x1 = cursor + st[i + 2] * scale, y1 = st[i + 3] * scale;
        seg.push(x0, y0, x1, y1);
        grow(x0, y0);
        grow(x1, y1);
      }
    }
    cursor += (g.width + 0.8) * scale + spacing;
  }
  if (seg.length === 0) return shape2(() => 1e6, EMPTY_BOUNDS2, 0);
  if (arc !== 0) {
    // Bend: x along the baseline becomes an angle, y a radius; split each stroke into short pieces first.
    const total = cursor - 0.8 * scale - spacing;
    const r = Math.abs(arc), sign = Math.sign(arc);
    const bent: number[] = [];
    bounds = EMPTY_BOUNDS2;
    const map = (x: number, y: number): [number, number] => {
      const a = ((x - total / 2) / r) * sign;
      const rr = r + y * sign;
      return [rr * Math.sin(a), rr * Math.cos(a) * sign];
    };
    for (let i = 0; i < seg.length; i += 4) {
      const x0 = seg[i], y0 = seg[i + 1], x1 = seg[i + 2], y1 = seg[i + 3];
      const pieces = Math.max(1, Math.ceil(Math.abs(x1 - x0) / (r * 0.05)));
      for (let k = 0; k < pieces; k++) {
        const t0 = k / pieces, t1 = (k + 1) / pieces;
        const a = map(x0 + (x1 - x0) * t0, y0 + (y1 - y0) * t0), b = map(x0 + (x1 - x0) * t1, y0 + (y1 - y0) * t1);
        bent.push(a[0], a[1], b[0], b[1]);
        grow(a[0], a[1]);
        grow(b[0], b[1]);
      }
    }
    seg.length = 0;
    seg.push(...bent);
  }
  const s = new Float64Array(seg);
  const n = s.length / 4;
  const out = shape2((x, y) => {
    let best = Infinity;
    for (let i = 0; i < n; i++) {
      const ax = s[i * 4], ay = s[i * 4 + 1];
      const dx = s[i * 4 + 2] - ax, dy = s[i * 4 + 3] - ay;
      const px = x - ax, py = y - ay;
      const l2 = dx * dx + dy * dy;
      let t = l2 > 0 ? (px * dx + py * dy) / l2 : 0;
      t = t < 0 ? 0 : t > 1 ? 1 : t;
      const qx = px - dx * t, qy = py - dy * t;
      const d2 = qx * qx + qy * qy;
      if (d2 < best) best = d2;
    }
    return Math.sqrt(best) - half;
  }, bounds, n);
  out.feature = weight;
  return out;
}

/** The advance width of `text` at `size`, for centring. */
export function textWidth(text: string, size = 1, spacing = 0): number {
  const scale = size / 6;
  let w = 0;
  for (const ch of text) w += (glyph(ch).width + 0.8) * scale + spacing;
  return Math.max(0, w - 0.8 * scale - spacing);
}
