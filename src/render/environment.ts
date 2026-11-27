/**
 * The beauty render's environments: four procedural skies that are the backdrop the camera sees, the light a surface
 * takes from all around, and what a metal reflects.
 *
 * Each sky is a gradient with structure, as linear radiance:
 *
 * - **studio**, rigged to the camera as a photographer rigs one: the white sweep the camera sees, dark walls on the
 *   camera's side above the horizon and a black flag on the floor there, a dim ceiling, the model's own shadow on
 *   the floor away from the key, and three cards that only reflections see (a fill card right and low, an overhead
 *   strip across the frame, a rim strip behind on the left). A metal facing the camera reflects the dark and the
 *   cards, so its form reads; a model's shaded side faces the dark, so it is modelled.
 * - **overcast**: a white dome, brighter towards the zenith.
 * - **sunset**: a blue sky over a warm band, and a sun 3° up where the key light comes from, with its glow.
 * - **night**: a dark blue sky, a moon where the key light comes from, and stars.
 *
 * The gradient is the old backdrop's: its display colours are interpolated as the old renderer did and run through
 * the tone curve's inverse, so the backdrop the camera sees is the one every render had. The structure (walls,
 * ceiling, flag, the overcast dome) is the studio's rigging out of shot: lighting and reflections see it, the
 * backdrop does not.
 *
 * A sky is looked at in one of five modes:
 * - DIFFUSE: the gradient, the structure and the sun's or moon's glow; what lights a surface (its SH irradiance).
 * - FILTERED: adds the cards; what a glossy surface reflects (the GGX-prefiltered maps).
 * - BACKDROP: the gradient as the old backdrop, the glow, the sun's or moon's disc and the stars; what the camera sees.
 * - REFLECT: everything a mirror sees but the lights: the structure, the cards, the glow, the disc and the stars.
 * - MIRROR: REFLECT and each directional light as a softbox of its own angular size, bright enough that a mirror
 *   shows it as strongly as it lights.
 *
 * `set ambient` and the palette's ambient make one intensity E that scales everything the environment gives a
 * surface, diffuse and reflected alike, but not the lights' softboxes (they are the lights) and not the backdrop.
 *
 * The heavy tables (nine SH coefficients and six prefiltered maps) are plain typed arrays, built once per run per
 * sky on the main thread and shared with the pool's workers; `buildEnvironment` keeps them in the run's cache, keyed
 * by what each sky depends on, so a hit and a miss give the same bytes. Nothing here allocates per look-up.
 */
import { normalize, type Vec3 } from "../core/vec.js";
import { decode, KEY, lightAngle, toLinear } from "./photometry.js";

/** The procedural skies the metals reflect and the floor sits in. */
export type Environment = "studio" | "overcast" | "sunset" | "night";
export const ENVIRONMENTS: Environment[] = ["studio", "overcast", "sunset", "night"];

interface Palette {
  /** The backdrop's display colours (sRGB 0..1): the sky high up, a band at the horizon, the ground just above it. */
  sky: Vec3;
  horizon?: Vec3;
  ground: Vec3;
  /** The open floor's display colour near the model: the kernel solves the floor's albedo to show it. */
  floor: Vec3;
  /** The environment's intensity E for `set ambient 1`: it scales the sky's light on diffuse and reflections alike. */
  ambient: number;
}

/**
 * The palettes: the old renderer's display colours, unchanged, so the backdrop and the open floor look as they did.
 * The ambient is E, which scales the sky's light on diffuse and reflections alike. The shading prototype lit diffuse
 * with 0.6, 0.9, 0.9 and 0.4 of its sky and reflected all of it; three.js cannot do that, so: the studio keeps E = 1
 * (its reflections as the prototype's) and wins a shaded side's darkness back through its structure (STUDIO), and the
 * other skies keep the prototype's diffuse light, their reflections dimmed with it (measured on the teapot's shaded
 * side against the prototype: within 1.5 levels in all four).
 */
const PALETTES: Record<Environment, Palette> = {
  studio: { sky: [0.78, 0.83, 0.9], ground: [0.93, 0.92, 0.9], floor: [0.88, 0.87, 0.85], ambient: 1 },
  overcast: { sky: [0.84, 0.86, 0.88], horizon: [0.9, 0.9, 0.9], ground: [0.8, 0.8, 0.8], floor: [0.8, 0.8, 0.79], ambient: 0.9 },
  sunset: { sky: [0.32, 0.36, 0.62], horizon: [0.98, 0.62, 0.36], ground: [0.55, 0.42, 0.36], floor: [0.62, 0.52, 0.45], ambient: 0.9 },
  night: { sky: [0.04, 0.06, 0.14], horizon: [0.1, 0.11, 0.2], ground: [0.07, 0.07, 0.1], floor: [0.14, 0.14, 0.17], ambient: 0.4 },
};

/** A sky's display colours and its intensity E for `set ambient 1`: what the viewer's scene mode builds its sky from. */
export function environmentPalette(env?: Environment): { sky: Vec3; horizon?: Vec3; ground: Vec3; floor: Vec3; ambient: number } {
  const p = PALETTES[env ?? "studio"];
  return { sky: [...p.sky], ...(p.horizon ? { horizon: [...p.horizon] as Vec3 } : {}), ground: [...p.ground], floor: [...p.floor], ambient: p.ambient };
}

/** The default key light's direction (towards the light): upper left, from the front. */
export const DEFAULT_LIGHT_DIRECTION: Vec3 = normalize([-0.55, 0.9, 0.65]);

/** A light's direction from its azimuth about y (0 is +z, 90 is +x) and elevation, in degrees. */
export function lightDirection(azimuth: number, elevation: number): Vec3 {
  const az = (azimuth * Math.PI) / 180, el = (elevation * Math.PI) / 180;
  return normalize([Math.sin(az) * Math.cos(el), Math.sin(el), Math.cos(az) * Math.cos(el)]);
}

/** A light as the environment needs it: a mirror sees each directional one as a softbox. */
export interface EnvironmentLight {
  /** Towards the light. */
  dir: Vec3;
  /** Its size: the softbox's angular radius is lightAngle(size). */
  size: number;
  /** sRGB, as the program gives it. */
  color: Vec3;
  power: number;
  /** A point light has a position; it has no softbox. */
  position?: Vec3;
}

/** The key: the program's first directional light, or the default key. The sun and the moon stand where it comes from, so every shot and every frame of a run shares one sky. */
export function keyDirection(lights?: readonly { dir: Vec3; position?: Vec3 }[]): Vec3 {
  const l = lights?.find((l) => !l.position);
  return l ? l.dir : DEFAULT_LIGHT_DIRECTION;
}

// ---------------------------------------------------------------------------------------------------------------
// Modes and structure.

/** What a look at the sky includes (see the module's comment). */
export const DIFFUSE = 0, FILTERED = 1, BACKDROP = 2, MIRROR = 3, REFLECT = 4;
export type SkyMode = typeof DIFFUSE | typeof FILTERED | typeof BACKDROP | typeof MIRROR | typeof REFLECT;
const STRUCT = 1, CARDS = 2, DISC = 4, STARS = 8, BOXES = 16;
const MODE_BITS = [STRUCT, STRUCT | CARDS, DISC | STARS, STRUCT | CARDS | DISC | STARS | BOXES, STRUCT | CARDS | DISC | STARS];

/**
 * The studio's rigging, in the frame of the camera: `r` to its right, `y` up, `f` towards it. Darkness is the share
 * of the gradient taken away; the cards are rectangles on the plane one unit along their direction (half-widths on
 * that plane, a soft edge) of linear radiance.
 *
 * Tuned against the shading prototype on the teapot, the medal and the mixer (tools/environment-maps.ts draws the
 * skies; the measurement is in the environment package's notes). A model's shaded side takes 70% of its sky light
 * from the ground on its own side and the camera's, so the prototype's walls and ceiling could not darken it without
 * the 0.6 it took off diffuse light alone. What does: the walls and the flag reach their darkness right at the
 * horizon (the bright band either side of it lit a shaded side and almost no reflection), and the model's own shadow
 * on the floor opposite the key, which is what a shaded side faces and what the old uniform ground left out.
 */
export const STUDIO = {
  /** The walls on the camera's side, above the horizon, reaching their darkness `wallsRise` of dy up. */
  walls: 0.92,
  wallsRise: 0.02,
  /** The ceiling: the gradient at the zenith, as a share of the sky colour (reached from dy = 0.4 up). */
  zenith: 0.2,
  /** The flag on the floor on the camera's side, below the horizon, reaching its darkness `flagRise` of −dy down. */
  flag: 0.6,
  flagRise: 0.02,
  /**
   * The model's shadow on the floor: the ground away from the key darkened by `strength`, as the look's horizontal
   * part along the key's way (horizontal, away from it) runs from `from` to `to`, reached `rise` of −dy down (the far
   * floor at the horizon is lit).
   */
  shadow: { strength: 0.4, from: -0.2, to: 0.5, rise: 0.1 },
  cards: [
    // A fill card, right and low, towards the camera.
    { at: [0.95, 0.35, 0.45], half: [0.3, 0.55], soft: 0.06, radiance: [1.6, 1.62, 1.7] },
    // The overhead strip, across the frame.
    { at: [0, 1, 0.15], half: [1.4, 0.09], soft: 0.03, radiance: [4, 4, 4] },
    // A rim strip behind, on the left.
    { at: [-0.7, 0.45, -0.7], half: [0.1, 0.7], soft: 0.03, radiance: [2.4, 2.45, 2.6] },
  ],
} as const;
/** The overcast dome: the gradient at the zenith, as a share of the sky colour. */
export const OVERCAST_ZENITH = 1.9;
/** Below the horizon, the lighting modes go from the horizon's colour to the ground's over this much of −dy, as the far floor fades into the horizon: no seam in a reflection. */
const HORIZON_BLEND = 0.05;
/** The sun: its angular radius and how high it stands. */
export const SUN_RADIUS = 0.022;
export const SUN_ELEVATION = 3;
/** The moon: its angular radius, and the range of elevations it takes from the key. */
export const MOON_RADIUS = 0.018;
export const MOON_ELEVATION: readonly [number, number] = [25, 60];
/** The stars: a grid of cells STAR_CELL radians square on rings of equal elevation, a share STAR_SHARE of them holding a star of angular radius STAR_RADIUS. */
const STAR_CELL = 0.008, STAR_SHARE = 0.04, STAR_RADIUS = 0.0018;
/** A softbox's soft edge, as a share of its radius on either side. */
const BOX_SOFT = 0.15;
/** The smallest softbox: a light of size 0 is still a bright disc a mirror can show. */
const BOX_MIN_SIZE = 0.1;

const GRAD_N = 256;
const CARD = 15, DISC_N = 15, BOX = 8;

/** The prefiltered maps: roughness, width (height is half), and the Hammersley samples per texel. */
export const PREFILTER: readonly { rough: number; w: number; samples: number }[] = [
  { rough: 0.15, w: 128, samples: 64 },
  { rough: 0.3, w: 64, samples: 96 },
  { rough: 0.45, w: 64, samples: 96 },
  { rough: 0.6, w: 64, samples: 96 },
  { rough: 0.8, w: 64, samples: 96 },
  { rough: 1, w: 64, samples: 96 },
];
/** The grid the SH irradiance is integrated over. */
const SH_W = 96, SH_H = 48;

/**
 * One sky's tables: everything that depends only on the environment, the camera's azimuth (the studio's rig) and the
 * key's direction (the sun, the moon). Plain numbers and typed arrays, so it can be posted to a worker; on a
 * SharedArrayBuffer when built for the pool.
 */
export interface SkyTables {
  env: Environment;
  /** The palette's intensity E for `set ambient 1`. */
  ambient: number;
  /** What the tables were built for, normalised to what this sky depends on (0 and the default key where it does not). */
  cameraAzimuth: number;
  key: Vec3;
  /** Towards the camera, horizontal: the studio's rig. */
  fx: number;
  fz: number;
  walls: number;
  wallsRise: number;
  /** The ground's darkening opposite the key (the model's shadow), its profile, and the key's horizontal way, away from it. */
  shadow: number;
  shadowFrom: number;
  shadowTo: number;
  shadowRise: number;
  sx: number;
  sz: number;
  /** The gradient's multiplier at the zenith (1: none). */
  zenith: number;
  flag: number;
  flagRise: number;
  /** The backdrop above the horizon by dy, GRAD_N + 1 entries of linear RGB. */
  grad: Float64Array;
  /** The backdrop below the horizon (linear RGB). */
  below: Float64Array;
  /** The cards, CARD floats each: direction, u, v, half-widths, soft edge, radiance. */
  cards: Float64Array;
  /** The sun or the moon (DISC_N floats), or empty: direction, cos of its radius, core, glow and its width (in 1 − cos), wide glow and its width. */
  disc: Float64Array;
  stars: number;
  /** Irradiance over π as nine SH coefficients per channel: coefficient k of channel c at [k * 3 + c]. */
  sh: Float64Array;
  /** The GGX-prefiltered maps of FILTERED, one per PREFILTER entry: lat-long, row 0 at the zenith, 3 floats a texel. */
  levels: Float32Array[];
}

/** A sky for one render: its tables, and each light's softbox (BOX floats a light, in the order the lights were given; a point light's is dark). */
export interface EnvironmentState extends SkyTables {
  boxes: Float64Array;
}

// ---------------------------------------------------------------------------------------------------------------
// Small pure helpers.

const smooth = (a: number, b: number, v: number): number => {
  const t = v <= a ? 0 : v >= b ? 1 : (v - a) / (b - a);
  return t * t * (3 - 2 * t);
};

/** A 32-bit mix of two integers to [0, 1): the stars' hash. */
export function hash2(x: number, y: number): number {
  let h = Math.imul(x | 0, 0x27d4eb2d) ^ Math.imul(y | 0, 0x165667b1);
  h = Math.imul(h ^ (h >>> 15), 0x85ebca6b);
  h = Math.imul(h ^ (h >>> 13), 0xc2b2ae35);
  return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
}

/** The van der Corput radical inverse in base 2: the second coordinate of a Hammersley set. */
export function radicalInverse(i: number): number {
  let b = i >>> 0;
  b = ((b << 16) | (b >>> 16)) >>> 0;
  b = (((b & 0x55555555) << 1) | ((b & 0xaaaaaaaa) >>> 1)) >>> 0;
  b = (((b & 0x33333333) << 2) | ((b & 0xcccccccc) >>> 2)) >>> 0;
  b = (((b & 0x0f0f0f0f) << 4) | ((b & 0xf0f0f0f0) >>> 4)) >>> 0;
  b = (((b & 0x00ff00ff) << 8) | ((b & 0xff00ff00) >>> 8)) >>> 0;
  return b / 4294967296;
}

function f64(n: number, shared: boolean): Float64Array {
  return new Float64Array(shared ? new SharedArrayBuffer(n * 8) : new ArrayBuffer(n * 8));
}
function f32(n: number, shared: boolean): Float32Array {
  return new Float32Array(shared ? new SharedArrayBuffer(n * 4) : new ArrayBuffer(n * 4));
}
function copyTo<T extends Float32Array | Float64Array>(a: T, shared: boolean): T {
  const b = (a instanceof Float32Array ? f32(a.length, shared) : f64(a.length, shared)) as T;
  b.set(a);
  return b;
}

/** A card: direction c, then u across it (horizontal) and v up it, on the plane one unit along c. */
function card(out: number[], dir: Vec3, ha: number, hb: number, soft: number, L: readonly number[]): void {
  const c = normalize(dir);
  const ref: Vec3 = Math.abs(c[1]) > 0.95 ? [0, 0, 1] : [0, 1, 0];
  const u = normalize([ref[1] * c[2] - ref[2] * c[1], ref[2] * c[0] - ref[0] * c[2], ref[0] * c[1] - ref[1] * c[0]]);
  const v: Vec3 = [c[1] * u[2] - c[2] * u[1], c[2] * u[0] - c[0] * u[2], c[0] * u[1] - c[1] * u[0]];
  out.push(c[0], c[1], c[2], u[0], u[1], u[2], v[0], v[1], v[2], ha, hb, soft, L[0], L[1], L[2]);
}

// ---------------------------------------------------------------------------------------------------------------
// Building a sky.

/** What a sky depends on, normalised: the overcast on nothing, sunset and night only on the key, the studio on the camera's azimuth and the key (the model's shadow on the floor). */
function skyInputs(env: Environment, cameraAzimuth: number, key: Vec3): { az: number; key: Vec3 } {
  // + 0 turns −0 into 0, so a key's bytes do not depend on the sign of a zero.
  if (env === "studio") return { az: cameraAzimuth + 0, key: [key[0] + 0, key[1] + 0, key[2] + 0] };
  if (env === "overcast") return { az: 0, key: [...DEFAULT_LIGHT_DIRECTION] };
  return { az: 0, key: [key[0] + 0, key[1] + 0, key[2] + 0] };
}

/** The structure and the gradient of a sky, without its SH and prefiltered maps. */
function skyFrame(env: Environment, az: number, key: Vec3, shared: boolean): SkyTables {
  const pal = PALETTES[env];
  const a = (az * Math.PI) / 180;
  const fx = Math.sin(a), fz = Math.cos(a), rx = Math.cos(a), rz = -Math.sin(a);
  const rig = (v: readonly number[]): Vec3 => [v[0] * rx + v[2] * fx, v[1], v[0] * rz + v[2] * fz];
  const cards: number[] = [];
  let walls = 0, zenith = 1, flag = 0, stars = 0, shadow = 0;
  const kh = Math.hypot(key[0], key[2]);
  const sx = kh > 1e-9 ? -key[0] / kh : 0, sz = kh > 1e-9 ? -key[2] / kh : 0;
  const disc: number[] = [];
  const keyAz = Math.atan2(key[0], key[2]);
  if (env === "studio") {
    walls = STUDIO.walls; zenith = STUDIO.zenith; flag = STUDIO.flag; shadow = STUDIO.shadow.strength;
    for (const c of STUDIO.cards) card(cards, rig(c.at), c.half[0], c.half[1], c.soft, c.radiance);
  } else if (env === "overcast") {
    zenith = OVERCAST_ZENITH;
  } else if (env === "sunset") {
    const e = (SUN_ELEVATION * Math.PI) / 180;
    disc.push(Math.sin(keyAz) * Math.cos(e), Math.sin(e), Math.cos(keyAz) * Math.cos(e), Math.cos(SUN_RADIUS), 40, 22, 9, 2.4, 1.1, 0.35, 0.012, 0.7, 0.3, 0.1, 0.25);
  } else {
    const kel = (Math.asin(Math.max(-1, Math.min(1, key[1]))) * 180) / Math.PI;
    const e = (Math.max(MOON_ELEVATION[0], Math.min(MOON_ELEVATION[1], kel)) * Math.PI) / 180;
    disc.push(Math.sin(keyAz) * Math.cos(e), Math.sin(e), Math.cos(keyAz) * Math.cos(e), Math.cos(MOON_RADIUS), 5, 5.6, 6.6, 0.05, 0.06, 0.09, 0.008, 0.012, 0.015, 0.025, 0.2);
    stars = 1;
  }
  // The old backdrop's gradient, by dy: k = 2.5 dy; with a horizon band, the ground to the band over the first 0.3
  // of k and the band to the sky by k = 1; without one, the ground to the sky by k = 1. Interpolated as display
  // colours, then taken to radiance (between two decoded colours the sunset's band went orange past the shoulder).
  const grad = f64((GRAD_N + 1) * 3, shared);
  const G = pal.ground, S = pal.sky, H = pal.horizon;
  const c: Vec3 = [0, 0, 0];
  for (let i = 0; i <= GRAD_N; i++) {
    const k = Math.min(1, (i / GRAD_N) * 2.5);
    for (let ch = 0; ch < 3; ch++) {
      if (!H) c[ch] = G[ch] + (S[ch] - G[ch]) * k;
      else if (k < 0.3) c[ch] = G[ch] + (H[ch] - G[ch]) * (k / 0.3);
      else c[ch] = H[ch] + (S[ch] - H[ch]) * ((k - 0.3) / 0.7);
    }
    decode(c[0], c[1], c[2], grad, i * 3);
  }
  // Below the horizon the old backdrop was the floor's colour most of the way to the ground's.
  const below = f64(3, shared);
  const F = pal.floor;
  decode(F[0] * 0.95 + (G[0] - F[0] * 0.95) * 0.6, F[1] * 0.95 + (G[1] - F[1] * 0.95) * 0.6, F[2] * 0.95 + (G[2] - F[2] * 0.95) * 0.6, below, 0);
  const cardArr = f64(cards.length, shared);
  cardArr.set(cards);
  const discArr = f64(disc.length, shared);
  discArr.set(disc);
  return { env, ambient: pal.ambient, cameraAzimuth: az, key, fx, fz, walls, wallsRise: STUDIO.wallsRise, shadow, shadowFrom: STUDIO.shadow.from, shadowTo: STUDIO.shadow.to, shadowRise: STUDIO.shadow.rise, sx, sz, zenith, flag, flagRise: STUDIO.flagRise, grad, below, cards: cardArr, disc: discArr, stars, sh: f64(27, shared), levels: [] };
}

/** Each light's softbox: direction, the squared chord (2 − 2cos) where its edge starts and ends, and its radiance. */
function softboxes(lights: readonly EnvironmentLight[], shared: boolean): Float64Array {
  const out = f64(lights.length * BOX, shared);
  lights.forEach((l, i) => {
    if (l.position || !(l.power > 0)) return;
    const o = i * BOX;
    const t = lightAngle(Math.max(BOX_MIN_SIZE, l.size));
    const d = normalize(l.dir);
    const x0 = 2 - 2 * Math.cos(t * (1 - BOX_SOFT)), x1 = 2 - 2 * Math.cos(t * (1 + BOX_SOFT));
    // The disc's solid angle with its soft edge: dΩ = π d(2 − 2cos), and the edge's smoothstep integrates to half.
    const omega = Math.PI * (x0 + x1) / 2;
    const k = (Math.PI * KEY * l.power) / omega;
    out[o] = d[0]; out[o + 1] = d[1]; out[o + 2] = d[2];
    out[o + 3] = x0; out[o + 4] = x1;
    out[o + 5] = toLinear(l.color[0]) * k; out[o + 6] = toLinear(l.color[1]) * k; out[o + 7] = toLinear(l.color[2]) * k;
  });
  return out;
}

/**
 * The sky for one render: the tables for this environment, camera azimuth and key (from `cache` when given, keyed by
 * exactly what the sky depends on, so a hit and a miss give the same bytes), and the lights' softboxes. `shared`
 * puts every array on a SharedArrayBuffer, for the pool.
 */
export function buildEnvironment(env: Environment, o: { cameraAzimuth: number; key?: Vec3; lights?: readonly EnvironmentLight[]; cache?: { env: Map<string, unknown> }; shared?: boolean }): EnvironmentState {
  const shared = !!o.shared;
  const { az, key } = skyInputs(env, o.cameraAzimuth, o.key ?? keyDirection(o.lights));
  const cacheKey = `sky|${env}|${az}|${key[0]},${key[1]},${key[2]}`;
  let tables = o.cache?.env.get(cacheKey) as SkyTables | undefined;
  if (tables && shared && !(tables.grad.buffer instanceof SharedArrayBuffer)) {
    tables = shareTables(tables);
    o.cache?.env.set(cacheKey, tables);
  }
  if (!tables) {
    tables = buildSky(env, az, key, shared);
    o.cache?.env.set(cacheKey, tables);
  }
  return { ...tables, boxes: softboxes(o.lights ?? [], shared) };
}

/** A sky's tables built fresh: the structure, the SH irradiance of DIFFUSE and the prefiltered maps of FILTERED. */
export function buildSky(env: Environment, cameraAzimuth: number, key: Vec3, shared = false): SkyTables {
  const { az, key: k } = skyInputs(env, cameraAzimuth, key);
  const s = skyFrame(env, az, k, shared);
  const look = (dx: number, dy: number, dz: number, out: Float64Array, mode: SkyMode) => skyAt(s, dx, dy, dz, out, 0, mode);
  s.sh.set(projectSh(look));
  for (const L of prefilterLevels(look, shared)) s.levels.push(L);
  return s;
}

function shareTables(t: SkyTables): SkyTables {
  return { ...t, grad: copyTo(t.grad, true), below: copyTo(t.below, true), cards: copyTo(t.cards, true), disc: copyTo(t.disc, true), sh: copyTo(t.sh, true), levels: t.levels.map((l) => copyTo(l, true)) };
}

/** A sky as a function: radiance along a unit direction into out[0..2], in a mode. */
export type SkySampler = (dx: number, dy: number, dz: number, out: Float64Array, mode: SkyMode) => void;

/**
 * Irradiance over π as nine SH coefficients per channel, from DIFFUSE on a 96 × 48 grid weighted by solid angle: the
 * radiance a white Lambert surface sends back is `irradiance()` of its normal.
 */
export function projectSh(sky: SkySampler): Float64Array {
  const tmp = new Float64Array(3);
  const sh = new Float64Array(27);
  for (let j = 0; j < SH_H; j++) {
    const th = ((j + 0.5) / SH_H) * Math.PI, st = Math.sin(th), y = Math.cos(th);
    const dw = (Math.PI / SH_H) * ((2 * Math.PI) / SH_W) * st;
    for (let i = 0; i < SH_W; i++) {
      const ph = ((i + 0.5) / SH_W) * 2 * Math.PI - Math.PI;
      const x = Math.sin(ph) * st, z = Math.cos(ph) * st;
      sky(x, y, z, tmp, DIFFUSE);
      const b0 = 0.282095, b1 = 0.488603 * y, b2 = 0.488603 * z, b3 = 0.488603 * x, b4 = 1.092548 * x * y, b5 = 1.092548 * y * z, b6 = 0.315392 * (3 * z * z - 1), b7 = 1.092548 * x * z, b8 = 0.546274 * (x * x - y * y);
      for (let c = 0; c < 3; c++) {
        const v = tmp[c] * dw;
        sh[c] += v * b0; sh[3 + c] += v * b1; sh[6 + c] += v * b2; sh[9 + c] += v * b3; sh[12 + c] += v * b4;
        sh[15 + c] += v * b5; sh[18 + c] += v * b6; sh[21 + c] += v * b7; sh[24 + c] += v * b8;
      }
    }
  }
  // The cosine lobe's band factors (π, 2π/3, π/4), over π.
  const band = [1, 2 / 3, 2 / 3, 2 / 3, 0.25, 0.25, 0.25, 0.25, 0.25];
  for (let k = 0; k < 9; k++) for (let c = 0; c < 3; c++) sh[k * 3 + c] *= band[k];
  return sh;
}

/** The lat-long FILTERED is drawn on before it is prefiltered: SRC_W × SRC_W/2 texels (0.7° high), row 0 at the zenith. */
const SRC_W = 512, SRC_H = SRC_W / 2;
/** Half a mip finer than a sample's share of the lobe asks for (measured against 4,096 plain samples: the best of 0, −0.5 and −1). */
const LOD_BIAS = -0.5;

/** A sky in one mode drawn on a lat-long: texel (i, j) looks along atan2(x, z) = ((i + 0.5)/w)·2π − π, y = cos(((j + 0.5)/h)·π). */
export function skyLatLong(sky: SkySampler, mode: SkyMode, w: number, h: number): Float32Array {
  const out = new Float32Array(w * h * 3);
  const tmp = new Float64Array(3);
  for (let j = 0; j < h; j++) {
    const th = ((j + 0.5) / h) * Math.PI, st = Math.sin(th), y = Math.cos(th);
    for (let i = 0; i < w; i++) {
      const ph = ((i + 0.5) / w) * 2 * Math.PI - Math.PI;
      sky(Math.sin(ph) * st, y, Math.cos(ph) * st, tmp, mode);
      const o = (j * w + i) * 3;
      out[o] = tmp[0]; out[o + 1] = tmp[1]; out[o + 2] = tmp[2];
    }
  }
  return out;
}

/**
 * The source's mip chain, one array: level 0 is the lat-long itself, each next level half as wide, each texel the
 * mean of the four above it weighted by their solid angle, down to 8 × 4. Returns the array and each level's offset.
 */
function mipChain(src: Float32Array): { data: Float32Array; offsets: number[] } {
  const offsets = [0];
  let total = SRC_W * SRC_H * 3;
  for (let w = SRC_W / 2; w >= 8; w /= 2) { offsets.push(total); total += w * (w / 2) * 3; }
  const data = new Float32Array(total);
  data.set(src);
  for (let m = 1; m < offsets.length; m++) {
    const pw = SRC_W >> (m - 1), ph = pw / 2, w = pw / 2, h = w / 2, po = offsets[m - 1], o = offsets[m];
    for (let j = 0; j < h; j++) {
      const s0 = Math.sin(((2 * j + 0.5) / ph) * Math.PI), s1 = Math.sin(((2 * j + 1.5) / ph) * Math.PI), sw = 2 * (s0 + s1);
      for (let i = 0; i < w; i++) {
        const a = po + ((2 * j) * pw + 2 * i) * 3, b = a + pw * 3, q = o + (j * w + i) * 3;
        for (let c = 0; c < 3; c++) data[q + c] = ((data[a + c] + data[a + 3 + c]) * s0 + (data[b + c] + data[b + 3 + c]) * s1) / sw;
      }
    }
  }
  return { data, offsets };
}

/**
 * The GGX-prefiltered maps of FILTERED, one per PREFILTER entry: for each texel's direction n, the GGX lobe about it
 * (n = v = r, Karis's split sum), by importance sampling a Hammersley set, weighted by n·l.
 *
 * The sky is drawn once on a 512-wide lat-long, and each sample reads it bilinearly from the mip whose texels are as
 * large as the sample's share of the lobe (filtered importance sampling, Křivánek and Colbert): 96 samples cannot
 * find the studio's bright cards in a lobe as wide as a hemisphere, so each one reads the sky already averaged over
 * its own patch (measured against 4,096 plain samples: the roughest map was 6 levels off on average and 43 at worst).
 *
 * The lobe's frame turns with the texel's azimuth (one tangent along the horizontal), so every texel of a row has the
 * same samples turned about the vertical: where each sample falls is worked out once per row, and a texel only moves
 * the column.
 */
export function prefilterLevels(sky: SkySampler, shared = false): Float32Array[] {
  const { data: mips, offsets } = mipChain(skyLatLong(sky, FILTERED, SRC_W, SRC_H));
  const top = offsets.length - 1;
  // A level-0 texel's solid angle at the horizon.
  const texel0 = (2 * Math.PI / SRC_W) * (Math.PI / SRC_H);
  const out: Float32Array[] = [];
  const ROW = new Float64Array(Math.max(...PREFILTER.map((P) => P.w)) * 3);
  for (const P of PREFILTER) {
    const w = P.w, h = w / 2, N = P.samples;
    const data = f32(w * h * 3, shared);
    const a = P.rough * P.rough, a2 = a * a;
    // The samples in the lobe's tangent frame (l = 2(n·h)h − n, so its z is n·l), and the mip each reads.
    const LS = new Float64Array(N * 3), lod = new Float64Array(N);
    let n = 0, wsum = 0;
    for (let k = 0; k < N; k++) {
      const u1 = (k + 0.5) / N, phi = 2 * Math.PI * radicalInverse(k);
      const ct = Math.sqrt((1 - u1) / (1 + (a2 - 1) * u1)), st = Math.sqrt(Math.max(0, 1 - ct * ct));
      const lz = 2 * ct * ct - 1;
      if (lz <= 0) continue;
      LS[n * 3] = 2 * ct * st * Math.cos(phi); LS[n * 3 + 1] = 2 * ct * st * Math.sin(phi); LS[n * 3 + 2] = lz;
      // The sample's share of the sphere: 1 / (N pdf), pdf(l) = D(h) / 4 when n = v.
      const dd = ct * ct * (a2 - 1) + 1, D = a2 / (Math.PI * dd * dd);
      const omega = 4 / (N * D);
      lod[n] = 0.5 * Math.log2(omega / texel0) + LOD_BIAS;
      wsum += lz;
      n++;
    }
    // Per sample of a row and each of its two mips: where its two source rows start, its column for texel 0, how far
    // a texel moves it, the column mask, and the vertical weights times n·l times the mip's share.
    const RA = new Int32Array(n * 2), RB = new Int32Array(n * 2), MASK = new Int32Array(n * 2);
    const U0 = new Float64Array(n * 2), STEP = new Float64Array(n * 2), WA = new Float64Array(n * 2), WB = new Float64Array(n * 2);
    for (let j = 0; j < h; j++) {
      rowSamples(j, w, n, LS, lod, top, offsets, RA, RB, MASK, U0, STEP, WA, WB);
      filterRow(mips, data, j * w * 3, w, n * 2, RA, RB, MASK, U0, STEP, WA, WB, 1 / wsum, ROW);
    }
    out.push(data);
  }
  return out;
}

/**
 * Where a row's samples fall, for its texel 0: per sample and each of its two mips (filtered importance sampling,
 * blended by the fractional level), where its two source rows start, its column, how far a texel moves it, the
 * column mask, and the vertical weights times n·l times the mip's share. Its own function, so it is optimised early.
 */
function rowSamples(j: number, w: number, n: number, LS: Float64Array, lod: Float64Array, top: number, offsets: number[], RA: Int32Array, RB: Int32Array, MASK: Int32Array, U0: Float64Array, STEP: Float64Array, WA: Float64Array, WB: Float64Array): void {
  const h = w / 2;
  const ph0 = (0.5 / w) * 2 * Math.PI - Math.PI, sp = Math.sin(ph0), cp = Math.cos(ph0);
  const th = ((j + 0.5) / h) * Math.PI, st = Math.sin(th), ny = Math.cos(th);
  // Texel 0's normal, a tangent along the horizontal and one up the meridian.
  const nx = sp * st, nz = cp * st;
  const t1x = cp, t1z = -sp;
  const t2x = ny * t1z, t2y = nz * t1x - nx * t1z, t2z = -ny * t1x;
  for (let k = 0; k < n; k++) {
    const sx = LS[k * 3], sy = LS[k * 3 + 1], nl = LS[k * 3 + 2];
    const lx = t1x * sx + t2x * sy + nx * nl, ly = t2y * sy + ny * nl, lz = t1z * sx + t2z * sy + nz * nl;
    const fu0 = Math.atan2(lx, lz) / (2 * Math.PI) + 0.5, fv0 = Math.acos(ly < -1 ? -1 : ly > 1 ? 1 : ly) / Math.PI;
    // A lat-long texel's solid angle shrinks with sin θ towards the poles, so a sample there reads a coarser mip.
    const sl = Math.sqrt(Math.max(0, 1 - ly * ly));
    const L = Math.max(0, Math.min(top, lod[k] - 0.5 * Math.log2(Math.max(sl, 1 / SRC_H))));
    const m0 = Math.min(top, Math.floor(L)), m1 = Math.min(top, m0 + 1), t = L - m0;
    for (let q = 0; q < 2; q++) {
      const m = q === 0 ? m0 : m1, share = (q === 0 ? 1 - t : t) * nl;
      const mw = SRC_W >> m, mh = mw / 2, x = k * 2 + q;
      let v = fv0 * mh - 0.5;
      v = v < 0 ? 0 : v > mh - 1 ? mh - 1 : v;
      const r0 = v < mh - 1 ? Math.floor(v) : mh - 2, fv = v - r0;
      RA[x] = offsets[m] + r0 * mw * 3; RB[x] = RA[x] + mw * 3; MASK[x] = mw - 1;
      U0[x] = fu0 * mw - 0.5; STEP[x] = mw / w;
      WA[x] = (1 - fv) * share; WB[x] = fv * share;
    }
  }
}

/**
 * One row of a prefiltered map: each of the row's sample looks is added to every texel, its column moved by i steps
 * for texel i (a whole number of columns on the finer mips, so its bilinear weights stay put), into ROW, then scaled
 * into the map. Its own function, so it is optimised early.
 */
function filterRow(src: Float32Array, data: Float32Array, o: number, w: number, n: number, RA: Int32Array, RB: Int32Array, MASK: Int32Array, U0: Float64Array, STEP: Float64Array, WA: Float64Array, WB: Float64Array, norm: number, ROW: Float64Array): void {
  ROW.fill(0, 0, w * 3);
  for (let k = 0; k < n; k++) {
    const ra = RA[k], rb = RB[k], mask = MASK[k], step = STEP[k], wa = WA[k], wb = WB[k];
    if (wa === 0 && wb === 0) continue;
    if (step >= 1) {
      // A whole number of columns per texel: the weights are the same for every texel.
      const c0 = Math.floor(U0[k]), fu = U0[k] - c0, st = step | 0;
      const w00 = (1 - fu) * wa, w10 = fu * wa, w01 = (1 - fu) * wb, w11 = fu * wb;
      for (let i = 0, c = c0; i < w; i++, c += st) {
        const ca = (c & mask) * 3, cb = ((c + 1) & mask) * 3;
        const p00 = ra + ca, p10 = ra + cb, p01 = rb + ca, p11 = rb + cb, q = i * 3;
        ROW[q] += src[p00] * w00 + src[p10] * w10 + src[p01] * w01 + src[p11] * w11;
        ROW[q + 1] += src[p00 + 1] * w00 + src[p10 + 1] * w10 + src[p01 + 1] * w01 + src[p11 + 1] * w11;
        ROW[q + 2] += src[p00 + 2] * w00 + src[p10 + 2] * w10 + src[p01 + 2] * w01 + src[p11 + 2] * w11;
      }
    } else {
      for (let i = 0; i < w; i++) {
        const u = U0[k] + i * step, c = Math.floor(u), fu = u - c;
        const ca = (c & mask) * 3, cb = ((c + 1) & mask) * 3;
        const w00 = (1 - fu) * wa, w10 = fu * wa, w01 = (1 - fu) * wb, w11 = fu * wb;
        const p00 = ra + ca, p10 = ra + cb, p01 = rb + ca, p11 = rb + cb, q = i * 3;
        ROW[q] += src[p00] * w00 + src[p10] * w10 + src[p01] * w01 + src[p11] * w11;
        ROW[q + 1] += src[p00 + 1] * w00 + src[p10 + 1] * w10 + src[p01 + 1] * w01 + src[p11 + 1] * w11;
        ROW[q + 2] += src[p00 + 2] * w00 + src[p10 + 2] * w10 + src[p01 + 2] * w01 + src[p11 + 2] * w11;
      }
    }
  }
  for (let i = 0; i < w * 3; i++) data[o + i] = ROW[i] * norm;
}

// ---------------------------------------------------------------------------------------------------------------
// Looking at a sky.

/**
 * The sky's radiance along a unit direction, into out[o..o+2], in one of the modes. Allocates nothing. MIRROR's
 * softboxes are the lights' own radiance: a caller scaling the environment by E scales REFLECT and adds the boxes
 * (`softboxAt`) unscaled.
 */
export function skyAt(s: SkyTables | EnvironmentState, dx: number, dy: number, dz: number, out: Float64Array | Float32Array | number[], o: number, mode: SkyMode): void {
  const bits = MODE_BITS[mode];
  const lit = (bits & STRUCT) !== 0;
  const G = s.grad;
  let r: number, g: number, b: number;
  if (dy >= 0) {
    const x = (dy < 1 ? dy : 1) * GRAD_N, i = x < GRAD_N - 1 ? Math.floor(x) : GRAD_N - 1, u = x - i, q = i * 3;
    r = G[q] + (G[q + 3] - G[q]) * u; g = G[q + 1] + (G[q + 4] - G[q + 1]) * u; b = G[q + 2] + (G[q + 5] - G[q + 2]) * u;
    if (lit) {
      let m = 1;
      if (s.zenith !== 1 && dy > 0.4) m += (s.zenith - 1) * ((dy - 0.4) / 0.6);
      if (s.walls > 0) m *= 1 - s.walls * smooth(-0.3, 0.35, dx * s.fx + dz * s.fz) * smooth(0, s.wallsRise, dy);
      r *= m; g *= m; b *= m;
    }
  } else if (!lit) {
    r = s.below[0]; g = s.below[1]; b = s.below[2];
  } else {
    // From the horizon's colour to the ground's, then the flag on the camera's side.
    const u = smooth(0, HORIZON_BLEND, -dy);
    r = G[0] + (s.below[0] - G[0]) * u; g = G[1] + (s.below[1] - G[1]) * u; b = G[2] + (s.below[2] - G[2]) * u;
    if (s.flag > 0) {
      const m = 1 - s.flag * smooth(-0.15, 0.3, dx * s.fx + dz * s.fz) * smooth(0, s.flagRise, -dy);
      r *= m; g *= m; b *= m;
    }
    if (s.shadow > 0) {
      const m = 1 - s.shadow * smooth(s.shadowFrom, s.shadowTo, dx * s.sx + dz * s.sz) * smooth(0, s.shadowRise, -dy);
      r *= m; g *= m; b *= m;
    }
  }
  if (bits & CARDS) {
    const P = s.cards;
    for (let i = 0; i < P.length; i += CARD) {
      const cd = dx * P[i] + dy * P[i + 1] + dz * P[i + 2];
      if (cd < 0.1) continue;
      const a = Math.abs((dx * P[i + 3] + dy * P[i + 4] + dz * P[i + 5]) / cd);
      const c = Math.abs((dx * P[i + 6] + dy * P[i + 7] + dz * P[i + 8]) / cd);
      const ha = P[i + 9], hb = P[i + 10], sf = P[i + 11];
      if (a > ha + sf || c > hb + sf) continue;
      const w = (1 - smooth(ha - sf, ha + sf, a)) * (1 - smooth(hb - sf, hb + sf, c));
      r += w * P[i + 12]; g += w * P[i + 13]; b += w * P[i + 14];
    }
  }
  const D = s.disc;
  if (D.length) {
    const cs = dx * D[0] + dy * D[1] + dz * D[2];
    if (cs > 0) {
      // Each glow less its value 90° away, so it ends there without a step (the wide one reaches that far).
      const off = 1 - cs;
      const k1 = Math.exp(-off / D[10]) - Math.exp(-1 / D[10]), k2 = (Math.exp(-off / D[14]) - Math.exp(-1 / D[14])) * smooth(-0.1, 0.05, dy);
      r += D[7] * k1 + D[11] * k2; g += D[8] * k1 + D[12] * k2; b += D[9] * k1 + D[13] * k2;
      if (bits & DISC && cs > D[3] - 0.0004) {
        const w = smooth(D[3] - 0.0004, D[3] + 0.0001, cs);
        r += D[4] * w; g += D[5] * w; b += D[6] * w;
      }
    }
  }
  if (bits & STARS && s.stars > 0 && dy > 0.03) {
    const k = starAt(dx, dy, dz) * smooth(0.03, 0.2, dy);
    r += k * 0.9; g += k * 0.95; b += k;
  }
  if (bits & BOXES && "boxes" in s) {
    const B = s.boxes;
    for (let i = 0; i < B.length; i += BOX) {
      const x = 2 - 2 * (dx * B[i] + dy * B[i + 1] + dz * B[i + 2]);
      if (x >= B[i + 4]) continue;
      const w = 1 - smooth(B[i + 3], B[i + 4], x);
      r += w * B[i + 5]; g += w * B[i + 6]; b += w * B[i + 7];
    }
  }
  out[o] = r; out[o + 1] = g; out[o + 2] = b;
}

/** Light i's softbox along a unit direction, added into out[o..o+2] (nothing for a point light): what MIRROR adds for it. */
export function softboxAt(s: EnvironmentState, i: number, dx: number, dy: number, dz: number, out: Float64Array | Float32Array | number[], o: number): void {
  const B = s.boxes, q = i * BOX;
  if (q >= B.length) return;
  const x = 2 - 2 * (dx * B[q] + dy * B[q + 1] + dz * B[q + 2]);
  if (x >= B[q + 4]) return;
  const w = 1 - smooth(B[q + 3], B[q + 4], x);
  out[o] += w * B[q + 5]; out[o + 1] += w * B[q + 6]; out[o + 2] += w * B[q + 7];
}

/**
 * A star's brightness along a unit direction above the horizon: the sky is cut into rings STAR_CELL high, each ring
 * into cells STAR_CELL wide at its middle, and a hashed share of the cells holds a star at a hashed place inside it,
 * a round dot of angular radius STAR_RADIUS (round on the sky, not on a lat-long grid, so it never streaks).
 */
function starAt(dx: number, dy: number, dz: number): number {
  const el = Math.asin(dy < 1 ? dy : 1);
  const j = Math.floor(el / STAR_CELL);
  const n = Math.max(1, Math.floor((2 * Math.PI * Math.cos((j + 0.5) * STAR_CELL)) / STAR_CELL));
  const az = Math.atan2(dx, dz) + Math.PI;
  let i = Math.floor((az / (2 * Math.PI)) * n);
  if (i >= n) i = n - 1;
  const h = hash2(i, j);
  if (h >= STAR_SHARE) return 0;
  // The star's centre, kept a radius inside its cell (in azimuth, the cell's width at that elevation).
  const elc = j * STAR_CELL + STAR_RADIUS + (STAR_CELL - 2 * STAR_RADIUS) * hash2(i + 7919, j);
  const cw = Math.max(1e-9, ((2 * Math.PI) / n) * Math.cos(elc));
  const m = Math.min(0.5, STAR_RADIUS / cw);
  const azc = ((i + m + (1 - 2 * m) * hash2(i, j + 104729)) / n) * 2 * Math.PI - Math.PI;
  const ce = Math.cos(elc);
  const cx = Math.sin(azc) * ce, cy = Math.sin(elc), cz = Math.cos(azc) * ce;
  // Squared angle, from the chord: 2 − 2cos θ ≈ θ² this close.
  const t2 = 2 - 2 * (dx * cx + dy * cy + dz * cz);
  const r2 = STAR_RADIUS * STAR_RADIUS;
  if (t2 >= r2) return 0;
  const f = 1 - t2 / r2;
  const v = h / STAR_SHARE;
  return f * f * (0.15 + 0.85 * v * v);
}

/** Irradiance over π along a unit normal into out[o..o+2]: the radiance a white Lambert surface sends back, before E. */
export function irradiance(s: Pick<SkyTables, "sh">, nx: number, ny: number, nz: number, out: Float64Array | Float32Array | number[], o: number): void {
  const sh = s.sh;
  const b1 = 0.488603 * ny, b2 = 0.488603 * nz, b3 = 0.488603 * nx, b4 = 1.092548 * nx * ny, b5 = 1.092548 * ny * nz, b6 = 0.315392 * (3 * nz * nz - 1), b7 = 1.092548 * nx * nz, b8 = 0.546274 * (nx * nx - ny * ny);
  for (let c = 0; c < 3; c++) {
    const v = sh[c] * 0.282095 + sh[3 + c] * b1 + sh[6 + c] * b2 + sh[9 + c] * b3 + sh[12 + c] * b4 + sh[15 + c] * b5 + sh[18 + c] * b6 + sh[21 + c] * b7 + sh[24 + c] * b8;
    out[o + c] = v > 0 ? v : 0;
  }
}

function sampleLevel(data: Float32Array, w: number, dx: number, dy: number, dz: number, k: number, out: Float64Array | Float32Array | number[], o: number): void {
  const h = w / 2;
  const u = (Math.atan2(dx, dz) / (2 * Math.PI) + 0.5) * w - 0.5;
  const v = (Math.acos(dy < -1 ? -1 : dy > 1 ? 1 : dy) / Math.PI) * h - 0.5;
  let i0 = Math.floor(u), j0 = Math.floor(v);
  const fu = u - i0, fv = v - j0;
  let i1 = i0 + 1;
  i0 = ((i0 % w) + w) % w; i1 = ((i1 % w) + w) % w;
  const j1 = j0 + 1 > h - 1 ? h - 1 : j0 + 1;
  j0 = j0 < 0 ? 0 : j0 > h - 1 ? h - 1 : j0;
  for (let c = 0; c < 3; c++) {
    const a = data[(j0 * w + i0) * 3 + c], b = data[(j0 * w + i1) * 3 + c], e = data[(j1 * w + i0) * 3 + c], f = data[(j1 * w + i1) * 3 + c];
    out[o + c] += k * ((a + (b - a) * fu) * (1 - fv) + (e + (f - e) * fu) * fv);
  }
}

/**
 * Add k times the prefiltered sky along a unit direction at a roughness into out[o..o+2]: bilinear within a level,
 * linear between the two levels around the roughness (below the first level, the first).
 */
export function prefiltered(s: Pick<SkyTables, "levels">, dx: number, dy: number, dz: number, rough: number, k: number, out: Float64Array | Float32Array | number[], o: number): void {
  const r = rough < PREFILTER[0].rough ? PREFILTER[0].rough : rough > 1 ? 1 : rough;
  let i = 0;
  while (i < PREFILTER.length - 2 && PREFILTER[i + 1].rough < r) i++;
  const a = PREFILTER[i], b = PREFILTER[i + 1];
  const t = (r - a.rough) / (b.rough - a.rough);
  if (t < 1) sampleLevel(s.levels[i], a.w, dx, dy, dz, k * (1 - t), out, o);
  if (t > 0) sampleLevel(s.levels[i + 1], b.w, dx, dy, dz, k * t, out, o);
}

/**
 * The sky just above the horizon in a direction's azimuth, into out[o..o+2]: the backdrop at dy = +0, what the far
 * floor fades into so that floor and sky meet without a seam.
 */
export function horizonRadiance(s: SkyTables, dx: number, dz: number, out: Float64Array | Float32Array | number[], o: number): void {
  const l = Math.hypot(dx, dz);
  if (l > 0) skyAt(s, dx / l, 0, dz / l, out, o, BACKDROP);
  else skyAt(s, 0, 0, 1, out, o, BACKDROP);
}

/** The width and height of `environmentLatLong`'s map. */
export const LATLONG_W = 128, LATLONG_H = 64;

/**
 * The sky for the viewer page: FILTERED (the gradient, the studio's dark side and its cards; no softboxes, disc or
 * stars, which the page's own lights and backdrop draw) as a 128 × 64 lat-long of linear RGB, each texel the mean of
 * 4 × 4 looks across it. The layout is three.js's equirectangular one, for a DataTexture with flipY false: texel
 * (i, j) at data[(j * 128 + i) * 3], with atan2(z, x) = ((i + 0.5) / 128 − 0.5) · 2π and y = sin(((j + 0.5) / 64 −
 * 0.5) · π), so row 0 is the nadir. Beside it, what the page's procedural backdrop needs: the palette's display
 * colours and the sun or moon.
 */
export function environmentLatLong(s: SkyTables): {
  width: number;
  height: number;
  data: Float32Array;
  /** E for `set ambient 1`: three.js's scene.environmentIntensity is this times the program's ambient. */
  ambient: number;
  backdrop: { sky: Vec3; horizon?: Vec3; ground: Vec3; below: Vec3; disc?: { dir: Vec3; radius: number; core: Vec3; glow: Vec3; glowWidth: number; wide: Vec3; wideWidth: number }; stars: boolean };
} {
  const W = LATLONG_W, H = LATLONG_H, SS = 4;
  const data = new Float32Array(W * H * 3);
  const tmp = new Float64Array(3);
  for (let j = 0; j < H; j++)
    for (let i = 0; i < W; i++) {
      let r = 0, g = 0, b = 0;
      for (let sj = 0; sj < SS; sj++)
        for (let si = 0; si < SS; si++) {
          const phi = ((i + (si + 0.5) / SS) / W - 0.5) * 2 * Math.PI;
          const lat = ((j + (sj + 0.5) / SS) / H - 0.5) * Math.PI;
          const c = Math.cos(lat);
          skyAt(s, Math.cos(phi) * c, Math.sin(lat), Math.sin(phi) * c, tmp, 0, FILTERED);
          r += tmp[0]; g += tmp[1]; b += tmp[2];
        }
      const o = (j * W + i) * 3;
      data[o] = r / (SS * SS); data[o + 1] = g / (SS * SS); data[o + 2] = b / (SS * SS);
    }
  const pal = PALETTES[s.env];
  const F = pal.floor, G = pal.ground;
  const D = s.disc;
  return {
    width: W,
    height: H,
    data,
    ambient: pal.ambient,
    backdrop: {
      sky: [...pal.sky],
      ...(pal.horizon ? { horizon: [...pal.horizon] as Vec3 } : {}),
      ground: [...G],
      below: [F[0] * 0.95 + (G[0] - F[0] * 0.95) * 0.6, F[1] * 0.95 + (G[1] - F[1] * 0.95) * 0.6, F[2] * 0.95 + (G[2] - F[2] * 0.95) * 0.6],
      ...(D.length ? { disc: { dir: [D[0], D[1], D[2]] as Vec3, radius: Math.acos(D[3]), core: [D[4], D[5], D[6]] as Vec3, glow: [D[7], D[8], D[9]] as Vec3, glowWidth: D[10], wide: [D[11], D[12], D[13]] as Vec3, wideWidth: D[14] } } : {}),
      stars: s.stars > 0,
    },
  };
}
