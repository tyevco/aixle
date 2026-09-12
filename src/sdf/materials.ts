/**
 * Materials: a base colour, an optional second colour, and a procedural
 * pattern evaluated at a point in the painted part's own frame. There are no
 * UVs anywhere in the pipeline: the renderer asks `albedo()` per pixel with
 * the interpolated local point, and the exporters bake the same function into
 * vertex colours, so the OBJ and GLB carry what the render shows.
 */
import { fbm3, noise3, white3 } from "../core/noise.js";
import type { Vec3 } from "../core/vec.js";
import type { Material, PatternKind } from "./types.js";

export const PATTERNS: readonly PatternKind[] = [
  "solid", "checker", "stripes", "wood", "marble", "noise", "speckle", "brick", "tiles", "dots",
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
  };
}

/** The material every unpainted shape has: a warm neutral that shows form. */
export const DEFAULT_MATERIAL: Material = make("clay", { color: hex("#c9b8a6"), rough: 0.7 });

const PRESET_LIST: Material[] = [
  DEFAULT_MATERIAL,
  ...Object.entries(NAMED_COLORS)
    .filter(([n]) => n !== "clay" && n !== "grey")
    .map(([n, c]) => make(n, { color: c })),
  make("gold", { color: hex("#e2b13c"), metal: 1, rough: 0.3 }),
  make("silver", { color: hex("#d4d6da"), metal: 1, rough: 0.25 }),
  make("copper", { color: hex("#c67a4a"), metal: 1, rough: 0.35 }),
  make("bronze", { color: hex("#a5772f"), metal: 1, rough: 0.4 }),
  make("steel", { color: hex("#8e949c"), metal: 1, rough: 0.45 }),
  make("iron", { color: hex("#5c5e62"), metal: 1, rough: 0.6 }),
  make("brass", { color: hex("#c9a54a"), metal: 1, rough: 0.35 }),
  make("chrome", { color: hex("#e8eaee"), metal: 1, rough: 0.1 }),
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
  name?: string;
}): Material {
  return make(opts.name ?? "custom", {
    color: opts.color,
    color2: opts.color2 ?? (opts.pattern && opts.pattern !== "solid" ? darken(opts.color, 0.6) : opts.color),
    pattern: opts.pattern,
    scale: opts.scale,
    metal: opts.metal,
    rough: opts.rough,
    transmit: opts.transmit,
    seed: opts.seed,
    axis: opts.axis,
    glow: opts.glow,
  });
}

const darken = (c: Vec3, f: number): Vec3 => [c[0] * f, c[1] * f, c[2] * f];
const lerp3 = (a: Vec3, b: Vec3, t: number): Vec3 => [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t];
const frac = (v: number): number => v - Math.floor(v);

/**
 * The surface colour of `m` at a point in the painted part's frame. The
 * pattern's own frame has its axis along y: stripes are bands stacked
 * along it, wood rings go round it, brick courses and tile rows are
 * perpendicular to it. `axis` swaps world x or z into that role.
 */
export function albedo(m: Material, x: number, y: number, z: number): Vec3 {
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
      // Growth rings around the part's y axis, wobbled by noise; fine grain along y.
      const r = Math.sqrt(x * x + z * z);
      const wobble = noise3(x * 0.7, y * 0.15, z * 0.7, m.seed) * 1.6;
      const ring = frac(r / s + wobble);
      const grain = noise3(x * 6, y * 0.6, z * 6, m.seed + 7) * 0.25;
      const t = Math.min(1, Math.pow(ring, 2.2) + grain);
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
  }
}
