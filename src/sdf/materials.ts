/**
 * Materials: a base colour, an optional second colour, and a procedural
 * pattern evaluated at a point in the painted part's own frame. There are no
 * UVs anywhere in the pipeline: the renderer asks `albedo()` per pixel with
 * the interpolated local point, and the exporters bake the same function into
 * vertex colours, so the OBJ and GLB carry what the render shows.
 *
 * `surface()` is the whole of it: the colour, roughness, metalness, glow and
 * bump height at a point, with the wear a material reads from the field's
 * curvature. The beauty render and the atlas baker both call it, so the
 * normal, metallic-roughness and emissive maps in the GLB are the beauty
 * render's surface; `albedo()` is its colour without the wear, which is what
 * the checking views draw.
 */
import { fbm3, noise3, white3 } from "../core/noise.js";
import type { Vec3 } from "../core/vec.js";
import type { DistFn3, ImageTexture, Material, PatternKind } from "./types.js";

export const PATTERNS: readonly PatternKind[] = [
  "solid", "checker", "stripes", "wood", "marble", "noise", "speckle", "brick", "tiles", "dots", "rust",
];

function parseHex(text: string): Vec3 | undefined {
  const m = /^#?([0-9a-f]{6})$/i.exec(text.trim());
  if (!m) {
    const s = /^#?([0-9a-f]{3})$/i.exec(text.trim());
    if (!s) return undefined;
    const h = s[1];
    return [parseInt(h[0] + h[0], 16) / 255, parseInt(h[1] + h[1], 16) / 255, parseInt(h[2] + h[2], 16) / 255];
  }
  const h = m[1];
  return [parseInt(h.slice(0, 2), 16) / 255, parseInt(h.slice(2, 4), 16) / 255, parseInt(h.slice(4, 6), 16) / 255];
}

const hex = (h: string): Vec3 => parseHex(h)!;

const NAMED_COLORS: Record<string, Vec3> = {
  white: hex("#f2f2f0"), black: hex("#1a1a1c"), gray: hex("#8a8a8a"), grey: hex("#8a8a8a"),
  red: hex("#c8342a"), green: hex("#3f9a45"), blue: hex("#2f66c4"), yellow: hex("#e8c53a"),
  orange: hex("#e07a2a"), purple: hex("#7a4bb0"), pink: hex("#e58cb8"), brown: hex("#7a4d2b"),
  teal: hex("#2a9b8f"), cream: hex("#f0e6c8"), navy: hex("#213a6b"), tan: hex("#c9a97a"),
  olive: hex("#7a7a2e"), maroon: hex("#6e1f2a"), sky: hex("#8cc4ea"), lime: hex("#9ad13a"),
  clay: hex("#c9b8a6"), charcoal: hex("#3a3a3e"), ivory: hex("#f4f0e2"), coral: hex("#e8735a"),
};

export function parseColor(text: string): Vec3 | undefined {
  return NAMED_COLORS[text.toLowerCase()] ?? parseHex(text);
}

function make(name: string, partial: Partial<Material> & { color: Vec3 }): Material {
  return {
    name,
    color: partial.color,
    color2: partial.color2 ?? partial.color,
    pattern: partial.pattern ?? "solid",
    scale: partial.scale ?? 1,
    metal: partial.metal ?? 0,
    rough: partial.rough ?? 0.6,
    transmit: partial.transmit ?? 0,
    seed: partial.seed ?? 0,
    axis: partial.axis ?? "y",
    glow: partial.glow ?? 0,
    bump: partial.bump ?? 0,
    bumpScale: partial.bumpScale,
    wear: partial.wear ?? 0,
  };
}

/** The colour a `rust` pattern's patches take when no second colour is given: oxide, orange-brown. */
export const RUST_COLOR: Vec3 = hex("#8a4422");

/** The material every unpainted shape has: a warm neutral that shows form. */
export const DEFAULT_MATERIAL: Material = make("clay", { color: hex("#c9b8a6"), rough: 0.7 });

const PRESET_LIST: Material[] = [
  DEFAULT_MATERIAL,
  ...Object.entries(NAMED_COLORS)
    .filter(([n]) => n !== "clay" && n !== "grey")
    .map(([n, c]) => make(n, { color: c })),
  // A metal's colour is its reflectance at normal incidence (F0), as glTF means it: measured values, linear, written
  // in sRGB. Gold is Lagarde's ("Feeding a physically based shading model", 2011: linear 1.000, 0.766, 0.336);
  // silver, copper, iron, brass (C260 cartridge brass) and chrome (chromium) are Real-Time Rendering 4th ed., table
  // 9.2; steel is stainless steel from physicallybased.info (refractiveindex.info's data: 0.669, 0.639, 0.598). No
  // table measures bronze: it is the mean of the copper and brass rows, the alloys either side of it (0.933, 0.708,
  // 0.481). A metal reads by what it reflects, so a measured F0 is pale: the beauty render's environment gives it its
  // colour, and the GLB means the same.
  make("gold", { color: hex("#ffe39d"), metal: 1, rough: 0.3 }),
  make("silver", { color: hex("#fcfaf5"), metal: 1, rough: 0.25 }),
  make("copper", { color: hex("#fad1c2"), metal: 1, rough: 0.35 }),
  make("bronze", { color: hex("#f7dbb8"), metal: 1, rough: 0.4 }),
  make("steel", { color: hex("#d6d1cb"), metal: 1, rough: 0.45 }),
  make("iron", { color: hex("#c6c6c8"), metal: 1, rough: 0.6 }),
  make("brass", { color: hex("#f5e4ae"), metal: 1, rough: 0.35 }),
  make("chrome", { color: hex("#c4c5c4"), metal: 1, rough: 0.1 }),
  make("wood", { color: hex("#b07d4a"), color2: hex("#7a4f2a"), pattern: "wood", scale: 0.25, rough: 0.7 }),
  make("oak", { color: hex("#c69a63"), color2: hex("#8f6539"), pattern: "wood", scale: 0.3, rough: 0.7 }),
  make("walnut", { color: hex("#6b4327"), color2: hex("#3e2414"), pattern: "wood", scale: 0.22, rough: 0.6 }),
  make("pine", { color: hex("#e0c08a"), color2: hex("#b48c55"), pattern: "wood", scale: 0.35, rough: 0.75 }),
  make("ebony", { color: hex("#2c2420"), color2: hex("#171210"), pattern: "wood", scale: 0.2, rough: 0.4 }),
  make("marble", { color: hex("#ececea"), color2: hex("#9a9aa0"), pattern: "marble", scale: 1.2, rough: 0.3 }),
  make("granite", { color: hex("#8e8a86"), color2: hex("#3c3a38"), pattern: "speckle", scale: 0.05, rough: 0.5 }),
  make("stone", { color: hex("#9a9590"), color2: hex("#6e6a66"), pattern: "noise", scale: 0.5, rough: 0.9 }),
  make("sandstone", { color: hex("#d9b98a"), color2: hex("#b8945f"), pattern: "noise", scale: 0.6, rough: 0.9 }),
  make("concrete", { color: hex("#a9a8a4"), color2: hex("#8c8b87"), pattern: "speckle", scale: 0.03, rough: 0.95 }),
  make("brick", { color: hex("#b0503a"), color2: hex("#d8cbb8"), pattern: "brick", scale: 0.5, rough: 0.9 }),
  make("tiles", { color: hex("#e8e4dc"), color2: hex("#7a7670"), pattern: "tiles", scale: 0.5, rough: 0.3 }),
  make("checker", { color: hex("#f0f0ec"), color2: hex("#2a2a2e"), pattern: "checker", scale: 0.5, rough: 0.5 }),
  make("stripes", { color: hex("#e8e4dc"), color2: hex("#c8342a"), pattern: "stripes", scale: 0.25, rough: 0.6 }),
  make("dots", { color: hex("#f4f0e2"), color2: hex("#2f66c4"), pattern: "dots", scale: 0.5, rough: 0.6 }),
  make("grass", { color: hex("#5a9a3a"), color2: hex("#3e7228"), pattern: "noise", scale: 0.3, rough: 0.95 }),
  make("dirt", { color: hex("#6e4e32"), color2: hex("#4d341f"), pattern: "noise", scale: 0.2, rough: 0.95 }),
  make("sand", { color: hex("#e2cf9a"), color2: hex("#c8b27a"), pattern: "speckle", scale: 0.04, rough: 0.95 }),
  make("water", { color: hex("#3a8ad8"), color2: hex("#6fb4ee"), pattern: "noise", scale: 0.8, rough: 0.1 }),
  make("glass", { color: hex("#dff0f6"), rough: 0.05, transmit: 0.9 }),
  make("amber", { color: hex("#e0a030"), rough: 0.1, transmit: 0.7 }),
  make("emerald", { color: hex("#40b070"), rough: 0.08, transmit: 0.7 }),
  make("leather", { color: hex("#6b3f24"), color2: hex("#4a2a16"), pattern: "speckle", scale: 0.06, rough: 0.7 }),
  make("rubber", { color: hex("#2a2a2c"), rough: 0.95 }),
  make("plastic", { color: hex("#e8e8e8"), rough: 0.35 }),
  make("porcelain", { color: hex("#f6f4ee"), rough: 0.2 }),
  make("snow", { color: hex("#f8f9fb"), color2: hex("#dfe6ef"), pattern: "noise", scale: 0.3, rough: 0.9 }),
  make("lava", { color: hex("#f06a1a"), color2: hex("#3a1a10"), pattern: "marble", scale: 0.8, rough: 0.6 }),
  // Iron with patches of rust: the patches are rough and not metal, so it bakes a metallic-roughness map.
  make("rust", { color: hex("#c6c6c8"), color2: RUST_COLOR, pattern: "rust", scale: 0.3, metal: 1, rough: 0.55 }),
];

export const PRESETS: ReadonlyMap<string, Material> = new Map(PRESET_LIST.map((m) => [m.name, m]));

export function preset(name: string): Material | undefined {
  return PRESETS.get(name.toLowerCase());
}

/** A material from a preset name or a colour (`"#a0522d"`, `"red"`); undefined if neither. */
export function materialFromString(text: string): Material | undefined {
  const p = preset(text);
  if (p) return p;
  const c = parseColor(text);
  if (c) return make(text, { color: c });
  return undefined;
}

export function customMaterial(opts: {
  color: Vec3;
  color2?: Vec3;
  pattern?: PatternKind;
  scale?: number;
  metal?: number;
  rough?: number;
  transmit?: number;
  seed?: number;
  axis?: "x" | "y" | "z";
  glow?: number;
  bump?: number;
  bumpScale?: number;
  wear?: number;
  name?: string;
}): Material {
  return make(opts.name ?? "custom", {
    color: opts.color,
    color2: opts.color2 ?? (opts.pattern === "rust" ? RUST_COLOR : opts.pattern && opts.pattern !== "solid" ? darken(opts.color, 0.6) : opts.color),
    pattern: opts.pattern,
    scale: opts.scale,
    metal: opts.metal,
    rough: opts.rough,
    transmit: opts.transmit,
    seed: opts.seed,
    axis: opts.axis,
    glow: opts.glow,
    bump: opts.bump,
    bumpScale: opts.bumpScale,
    wear: opts.wear,
  });
}

const darken = (c: Vec3, f: number): Vec3 => [c[0] * f, c[1] * f, c[2] * f];
const lerp3 = (a: Vec3, b: Vec3, t: number): Vec3 => [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t];
const frac = (v: number): number => v - Math.floor(v);

/**
 * The surface colour of `m` at a point in the painted part's frame. The
 * pattern's own frame has its axis along y: stripes are bands stacked
 * along it, wood is boards laid across it with the grain along it, brick courses and tile rows are
 * perpendicular to it. `axis` swaps world x or z into that role.
 */
export function albedo(m: Material, x: number, y: number, z: number): Vec3 {
  if (m.image) {
    const px = sampleImage(m.image, x, y, z);
    return [px[0], px[1], px[2]];
  }
  const s = m.scale > 0 ? m.scale : 1;
  if (m.axis === "x") { const t = x; x = y; y = t; }
  else if (m.axis === "z") { const t = z; z = y; y = t; }
  switch (m.pattern) {
    case "solid":
      return m.color;
    case "checker": {
      const parity = (Math.floor(x / s) + Math.floor(y / s) + Math.floor(z / s)) & 1;
      return parity ? m.color2 : m.color;
    }
    case "stripes":
      return Math.floor(y / s) & 1 ? m.color2 : m.color;
    case "wood": {
      // Flat-sawn boards side by side across x, their grain running along y (and along a horizontal face): straight
      // lines a scale apart that drift, each board with its own figure and a dark seam at its edge. Rings round the
      // axis before this: a top read as a bullseye and every face as bands, when most wooden things are planks
      // (measured on the dining table and the workshop bench). The lines lean a little through the thickness (z)
      // so an edge face shows grain too, not one flat colour.
      const bw = s * 2.5;
      const board = Math.floor(x / bw);
      const bx = x - board * bw;
      const figure = white3(board, 0, 0, m.seed) * 7;
      const lean = 0.25 + (white3(board, 1, 0, m.seed) - 0.5) * 0.1;
      const drift = (noise3(x / s * 0.35, y / s * 0.09, z / s * 0.35, m.seed + board) - 0.5) * 1.8;
      const g = frac((bx + z * lean) / s + figure + drift);
      // Late wood is a thin dark line in a wide light band, softened so it does not read as a stripe.
      const band = Math.pow(1 - Math.abs(g - 0.5) * 2, 4);
      const fleck = (noise3(x / s * 7, y / s * 0.9, z / s * 7, m.seed + 7) - 0.5) * 0.3;
      const seam = Math.min(bx, bw - bx) < s * 0.1 ? 0.5 : 0;
      const t = Math.max(0, Math.min(1, band * 0.75 + 0.1 + fleck + seam));
      return lerp3(m.color, m.color2, t);
    }
    case "marble": {
      const v = fbm3(x / s, y / s, z / s, m.seed, 5);
      const vein = Math.pow(Math.abs(Math.sin((x + y * 0.4 + z * 0.2) / s * 2 + v * 6)), 3);
      return lerp3(m.color, m.color2, 0.15 + 0.85 * vein);
    }
    case "noise": {
      const v = fbm3(x / s, y / s, z / s, m.seed, 4);
      return lerp3(m.color, m.color2, v);
    }
    case "speckle": {
      const v = white3(x / s, y / s, z / s, m.seed);
      return lerp3(m.color, m.color2, v * v);
    }
    case "brick": {
      // Courses along y, bricks 2:1, alternate rows offset by half a brick; mortar is color2.
      // Shifted by half a mortar line so a face at a whole-unit height is not all mortar.
      const h = s, w = s * 2, mortar = s * 0.08;
      const yy = y + mortar / 2, xx = x + mortar / 2;
      const row = Math.floor(yy / h);
      const bx = xx + (row & 1 ? w / 2 : 0);
      const fx = frac(bx / w) * w, fy = frac(yy / h) * h;
      if (fx < mortar || fy < mortar) return m.color2;
      const shade = 0.85 + 0.3 * white3(Math.floor(bx / w), row, Math.floor(z / w), m.seed);
      return [Math.min(1, m.color[0] * shade), Math.min(1, m.color[1] * shade), Math.min(1, m.color[2] * shade)];
    }
    case "tiles": {
      const g = s * 0.06;
      const fx = frac(x / s) * s, fz = frac(z / s) * s;
      if (fx < g || fz < g) return m.color2;
      return m.color;
    }
    case "dots": {
      const fx = frac(x / s) - 0.5, fz = frac(z / s) - 0.5, fy = frac(y / s) - 0.5;
      const d = Math.min(fx * fx + fz * fz, fx * fx + fy * fy, fy * fy + fz * fz);
      return d < 0.06 ? m.color2 : m.color;
    }
    case "rust": {
      const r = rustAt(m, x, y, z);
      return lerp3(m.color, r.shade, r.mask);
    }
  }
}

/** Where a `rust` pattern has eaten the base (0..1) and the oxide's colour there, mottled finer than the patches. */
function rustAt(m: Material, x: number, y: number, z: number): { mask: number; shade: Vec3 } {
  const s = m.scale > 0 ? m.scale : 1;
  // Patches about a scale across covering a little under half the surface, with soft edges; a finer noise
  // mottles the oxide between its own colour and a darker scale.
  const v = fbm3(x / s, y / s, z / s, m.seed + 5, 4);
  const mask = smoothstep(0.47, 0.6, v);
  const fine = noise3((x / s) * 6, (y / s) * 6, (z / s) * 6, m.seed + 11);
  return { mask, shade: lerp3(m.color2, darken(m.color2, 0.62), fine) };
}

const smoothstep = (a: number, b: number, v: number): number => {
  const t = Math.max(0, Math.min(1, (v - a) / (b - a)));
  return t * t * (3 - 2 * t);
};

/** What a surface is at a point: the inputs of a physically based shader, and the bump's height there. */
export interface SurfaceSample {
  color: Vec3;
  rough: number;
  metal: number;
  /** Light given off, multiplying `color`: 0 for none. */
  glow: number;
  /** Height above the field's surface from `bump`, in model units; 0 without a bump. */
  height: number;
}

/** The material's finish varies over the surface (wear, bumps, rust), so a renderer must ask `surface()` rather than read the fields. */
export const hasFinish = (m: Material): boolean => (m.wear ?? 0) > 0 || (m.bump ?? 0) > 0 || (m.pattern === "rust" && !m.image);
/** Roughness or metalness varies over the surface, which a metallic-roughness map can carry and factors cannot. */
export const variesRoughMetal = (m: Material): boolean => (m.wear ?? 0) > 0 || (m.pattern === "rust" && !m.image);
/** The colour varies over the surface, so a glow does too and needs a map rather than a factor. */
export const variesColor = (m: Material): boolean => m.pattern !== "solid" || !!m.image || (m.wear ?? 0) > 0;

/**
 * The surface at a local point. `curvature` is what `fieldCurvature()` reads
 * at the world point (+1 a sharp convex edge, -1 a sharp crease, 0 flat), and
 * matters only to a material with `wear`: a convex edge is rubbed toward bare
 * metal (on a metal) or a lighter, smoother finish, a cavity collects grime,
 * darker and rougher, and a `rust` pattern's patches come off the edges. A
 * material with no wear, no bump and no rust returns exactly `albedo()` and
 * its own rough, metal and glow, so a plain material renders as it did.
 */
export function surface(m: Material, x: number, y: number, z: number, curvature = 0): SurfaceSample {
  const wear = Math.max(0, Math.min(1, m.wear ?? 0));
  let edge = 0, cavity = 0;
  if (wear > 0) {
    // The threshold falls as the wear rises, so more of the surface counts as an edge, and the effect strengthens.
    const lo = 0.45 - 0.35 * wear, amount = Math.min(1, 0.35 + wear);
    edge = smoothstep(lo, lo + 0.3, curvature) * amount;
    cavity = smoothstep(lo, lo + 0.3, -curvature) * amount;
  }
  let color: Vec3;
  let rough = m.rough, metal = m.metal;
  if (m.pattern === "rust" && !m.image) {
    // Rust is rough oxide, not metal; a worn edge is rubbed back through it to the iron.
    const r = rustAt(m, x, y, z);
    const k = r.mask * (1 - edge);
    color = lerp3(m.color, r.shade, k);
    metal = m.metal * (1 - k);
    rough = m.rough + (Math.max(m.rough, 0.92) - m.rough) * k;
  } else color = albedo(m, x, y, z);
  if (edge > 0) {
    const under = m.pattern === "rust" && !m.image ? m.color : color;
    const bare: Vec3 = m.metal >= 0.5
      ? [Math.min(1, under[0] * 1.3 + 0.16), Math.min(1, under[1] * 1.3 + 0.16), Math.min(1, under[2] * 1.3 + 0.16)]
      : [under[0] + (1 - under[0]) * 0.35, under[1] + (1 - under[1]) * 0.35, under[2] + (1 - under[2]) * 0.35];
    color = lerp3(color, bare, edge);
    rough *= 1 - 0.55 * edge;
    if (m.metal >= 0.5) metal += (1 - metal) * edge;
  }
  const bump = m.bump ?? 0;
  const height = bump > 0 ? bumpHeight(m, x, y, z) : 0;
  // Grime gathers in cavities and, on a bumped surface, in the bumps' hollows.
  const low = bump > 0 && wear > 0 ? Math.max(0, -height / bump) * wear * 0.5 : 0;
  const grime = Math.min(1, cavity + low);
  if (grime > 0) {
    color = [color[0] * (1 - 0.5 * grime), color[1] * (1 - 0.5 * grime), color[2] * (1 - 0.5 * grime)];
    rough += (1 - rough) * 0.6 * grime;
    metal *= 1 - 0.5 * grime;
  }
  return { color, rough, metal, glow: m.glow, height };
}

/**
 * The bumps' feature size: `bump_scale`, or ten times the height, which tilts the surface about ten degrees on
 * average (measured: at five times, about twenty, and a candle read as stucco).
 */
export const bumpScaleOf = (m: Material): number => (m.bumpScale !== undefined && m.bumpScale > 0 ? m.bumpScale : Math.max(1e-6, (m.bump ?? 0) * 10));

/** The bump's height at a local point: fractal noise of the bump's feature size, `bump` high either way of the surface. */
export function bumpHeight(m: Material, x: number, y: number, z: number): number {
  const bump = m.bump ?? 0;
  if (!(bump > 0)) return 0;
  const f = 1 / bumpScaleOf(m);
  return bump * (fbm3(x * f, y * f, z * f, m.seed + 29, 3) * 2 - 1);
}

/**
 * The bump's slope along two directions on the surface: `u1` and `u2` are
 * how far the local point moves per world unit along each (the paint frame's
 * image of two world tangents). The bumps' height and size are both in the
 * paint frame, so a part scaled after painting keeps its bumps' look, as it
 * keeps its pattern's: the slope is taken in the frame's own units, central
 * differences a tenth of the feature size apart along each direction, and
 * weighted by how much that direction stretches against the frame's mean,
 * which is exact for a turn and a uniform scale. A step of a tenth of the
 * feature in world units instead spanned whole bumps on a part scaled down,
 * and made a part scaled by s bumpier by 1/s (measured: one ball built at
 * size, ten times big and scaled down, ten times small and scaled up, read
 * as three finishes). The beauty render (which finds `u` from two nearby
 * hits) and the baker (from a triangle's corners) measure the same slope.
 */
export function bumpSlope(m: Material, x: number, y: number, z: number, u1: Vec3, u2: Vec3): [number, number] {
  if (!((m.bump ?? 0) > 0)) return [0, 0];
  const e = bumpScaleOf(m) * 0.1;
  const k1 = Math.hypot(u1[0], u1[1], u1[2]), k2 = Math.hypot(u2[0], u2[1], u2[2]);
  const k = k1 > 0 && k2 > 0 ? Math.sqrt(k1 * k2) : k1 || k2;
  const along = (u: Vec3, ku: number): number => {
    if (!(ku > 0)) return 0;
    const dx = (u[0] / ku) * e, dy = (u[1] / ku) * e, dz = (u[2] / ku) * e;
    return ((bumpHeight(m, x + dx, y + dy, z + dz) - bumpHeight(m, x - dx, y - dy, z - dz)) / (2 * e)) * (ku / k);
  };
  return [along(u1, k1), along(u2, k2)];
}

/**
 * How convex the field's surface is near a point, at the scale `h`, from
 * second differences of the distance: +1 on a sharp convex edge, -1 in a
 * sharp crease, 0 on a flat face, h/R on a sphere of radius R; a point
 * within `h` of an edge reads the edge, so `h` is the width of the band
 * wear brightens. The level set's curvature is the Laplacian less the
 * second derivative along the normal, over the gradient's length, which is
 * exact for any field whose sign is right, not only a true distance (a
 * loft, a smooth blend, a displace): the Laplacian alone counts the field's
 * own bending off the surface as curvature. Nine calls to `dist`.
 */
export function fieldCurvature(dist: DistFn3, x: number, y: number, z: number, h: number): number {
  const d0 = dist(x, y, z);
  const xp = dist(x + h, y, z), xm = dist(x - h, y, z);
  const yp = dist(x, y + h, z), ym = dist(x, y - h, z);
  const zp = dist(x, y, z + h), zm = dist(x, y, z - h);
  const gx = xp - xm, gy = yp - ym, gz = zp - zm;
  const gl = Math.hypot(gx, gy, gz);
  if (!(gl > 1e-12)) return 0;
  const nx = gx / gl, ny = gy / gl, nz = gz / gl;
  const lap = xp + xm + yp + ym + zp + zm - 6 * d0;
  const dnn = dist(x + nx * h, y + ny * h, z + nz * h) + dist(x - nx * h, y - ny * h, z - nz * h) - 2 * d0;
  // lap and dnn are h^2 times the derivatives, gl is 2h times the gradient: kappa * h / 2 = (lap - dnn) / gl.
  const c = (lap - dnn) / gl;
  return Math.max(-1, Math.min(1, c));
}

/** The probe `fieldCurvature()` takes for wear: about one and a half cells at the default grid, so the worn band is a look, not a resolution. */
export const wearProbe = (longestSide: number): number => Math.max(1e-6, longestSide * 0.012);

/** The picture's (u, v) in 0..1 for a local point, or undefined off a planar picture's edge. */
export function imageUV(img: ImageTexture, x: number, y: number, z: number): [number, number] | undefined {
  // The picture's own frame has its axis along y, like a pattern's.
  if (img.axis === "x") { const t = x; x = y; y = t; }
  else if (img.axis === "z") { const t = z; z = y; y = t; }
  const size = img.size > 0 ? img.size : 1;
  const aspect = img.height / Math.max(1, img.width);
  switch (img.projection) {
    case "planar": {
      // Across the axis: u along x, v along the third axis, the picture `size` wide and centred on the origin.
      const u = x / size + 0.5, v = 0.5 - z / (size * aspect);
      if (u < 0 || u > 1 || v < 0 || v > 1) return undefined;
      return [u, v];
    }
    case "cylindrical": {
      // Round the axis by arc length, so the picture keeps its shape and repeats as many times as fit: `size` is
      // its width along the surface (measured: stretching one copy round a lid smeared its lettering five to one).
      const r = Math.hypot(x, z);
      const arc = Math.atan2(x, z) * r;
      const u = arc / size - Math.floor(arc / size);
      const v = 0.5 - y / (size * aspect);
      if (v < 0 || v > 1) return undefined;
      return [u, v];
    }
    case "spherical": {
      const r = Math.hypot(x, y, z) || 1;
      const u = Math.atan2(x, z) / (2 * Math.PI) + 0.5;
      const v = Math.acos(Math.max(-1, Math.min(1, y / r))) / Math.PI;
      return [u, v];
    }
    case "box": {
      // The picture fitted to the box's face across its shortest side: u along the longer of the other two, v the other.
      const b = img.box;
      if (!b) return undefined;
      const size3 = [b.max[0] - b.min[0], b.max[1] - b.min[1], b.max[2] - b.min[2]];
      const p = [x, y, z];
      // Undo the axis swap above: box projection works in the raw frame.
      if (img.axis === "x") { const t = p[0]; p[0] = p[1]; p[1] = t; }
      else if (img.axis === "z") { const t = p[2]; p[2] = p[1]; p[1] = t; }
      let thin = 0;
      for (let k = 1; k < 3; k++) if (size3[k] < size3[thin]) thin = k;
      // Screen-like reading: u runs along x where it can, v down the up axis where it can.
      const others = [0, 1, 2].filter((k) => k !== thin);
      const uAxis = others.includes(0) ? 0 : others[0], vAxis = others.find((k) => k !== uAxis)!;
      const u = (p[uAxis] - b.min[uAxis]) / Math.max(1e-9, size3[uAxis]);
      const vRaw = (p[vAxis] - b.min[vAxis]) / Math.max(1e-9, size3[vAxis]);
      // The picture's top is the box's top (or its far side, on a floor).
      const v = vAxis === 1 ? 1 - vRaw : thin === 1 ? 1 - vRaw : 1 - vRaw;
      if (u < 0 || u > 1 || v < 0 || v > 1) return undefined;
      return [u, v];
    }
  }
}

/** The picture's colour and alpha at a local point, bilinear between texels; off a picture's edge, transparent. */
export function sampleImage(img: ImageTexture, x: number, y: number, z: number): [number, number, number, number] {
  const uv = imageUV(img, x, y, z);
  if (!uv) return [0, 0, 0, 0];
  const wrapU = img.projection === "cylindrical" || img.projection === "spherical";
  let fx = uv[0] * img.width - 0.5, fy = uv[1] * img.height - 0.5;
  if (wrapU) fx = ((fx % img.width) + img.width) % img.width;
  const x0 = Math.floor(fx), y0 = Math.floor(fy);
  const tx = fx - x0, ty = fy - y0;
  const px = (ix: number, iy: number): [number, number, number, number] => {
    const cx = wrapU ? ((ix % img.width) + img.width) % img.width : Math.max(0, Math.min(img.width - 1, ix));
    const cy = Math.max(0, Math.min(img.height - 1, iy));
    const o = (cy * img.width + cx) * 4;
    return [img.rgba[o] / 255, img.rgba[o + 1] / 255, img.rgba[o + 2] / 255, img.rgba[o + 3] / 255];
  };
  const a = px(x0, y0), b = px(x0 + 1, y0), c = px(x0, y0 + 1), d = px(x0 + 1, y0 + 1);
  const out: [number, number, number, number] = [0, 0, 0, 0];
  for (let k = 0; k < 4; k++) out[k] = (a[k] * (1 - tx) + b[k] * tx) * (1 - ty) + (c[k] * (1 - tx) + d[k] * tx) * ty;
  return out;
}

/** How opaque a material is at a local point: a picture's alpha, else fully. */
export function coverage(m: Material, x: number, y: number, z: number): number {
  return m.image ? sampleImage(m.image, x, y, z)[3] : 1;
}
