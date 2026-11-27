/**
 * The beauty render's kernel: the distance field itself, ray traced and shaded physically, as the viewer and the
 * engines shade the GLB.
 *
 * Light is linear radiance (photometry.ts): a material's colour, a light's and a palette's are decoded from sRGB, and
 * the picture is tone-mapped and encoded once, at the end. A surface is glTF's metallic-roughness model, as three.js's
 * MeshStandardMaterial: a diffuse colour base·(1 − metal), a reflectance F0 = mix(0.04, base, metal) at normal
 * incidence, a GGX lobe of α = rough², height-correlated Smith visibility and Schlick's Fresnel, with Karis's split-sum
 * fit and Fdez-Agüera's compensation for the light a rough lobe loses to scattering more than once.
 *
 * What lights a surface:
 * - each light: Lambert and a GGX highlight widened by the light's angular size (one angle, size/18 rad, that also
 *   sizes its shadow and the softbox a mirror sees), shadowed by the share of its disc the point sees (rays.ts: eight
 *   rays a pixel, filtered by denoise.ts on visibility alone);
 * - the environment (environment.ts): its SH irradiance for diffuse; for the reflection, by roughness, one traced ray
 *   (a mirror, under 0.12), four traced GGX rays in a fixed pattern (a glossy metal, under 0.35), one traced ray
 *   blended into the prefiltered sky (other glossy surfaces, under 0.55), or the prefiltered sky alone; the misses
 *   and the sky dimmed by specular occlusion, Lagarde's from the field's ambient occlusion times a cavity term, so
 *   lettering cut into polished metal stays readable;
 * - a glow gives off its own colour and lights nothing else.
 *
 * Glass is pbr-glass.ts. The floor is solved so that the open floor near the model shows the palette's floor colour
 * under the sky and every directional light, lit by each light at full strength with the area light's shadows near
 * the model, darkened under the model by the field's occlusion and a wider contact term, and faded far off into the
 * sky's horizon. It reflects nothing (a sheen on it drew a ghost of the model).
 *
 * Primary visibility is the field's, primed by the mesh's depth, as the classic renderer had it. Secondary rays march
 * the field for three cells and then let the mesh's BVH skip empty space, every hit confirmed on the field (rays.ts).
 *
 * The rows write linear radiance per slot (one; or one for the sky, the glows and the backdrop and one per light,
 * with splitLights), each light's unshadowed term on primary surfaces and the floor and its visibility apart, and the
 * guides the visibility filter and the edge pass read. The edge pass samples a pixel four times where its neighbours
 * differ in material, depth, normal or (in full quality, beside a mirror) brightness, and keeps the mean of the four
 * samples' tone-mapped colours. The finish filters visibility, composes, blooms, blurs for depth of field, tone-maps
 * and dithers. Every pixel is a function of its position and the scene: no random numbers, no clock.
 */
import { normalize, type Vec3 } from "../core/vec.js";
import { albedo, bumpScaleOf, bumpSlope, fieldCurvature, hasFinish, surface, wearProbe } from "../sdf/materials.js";
import { boundsCenter, boundsDistance, boundsSize, type Bounds, type Hit, type Shape3 } from "../sdf/types.js";
import type { Mesh } from "../mesh/mesh.js";
import { toView, type Camera } from "./camera.js";
import { Canvas, rgbDithered } from "./canvas.js";
import { drawText } from "./font.js";
import { INK } from "./views.js";
import { bvhFor, type BvhData } from "./bvh.js";
import { createRays, softnessFor, type RayLight } from "./rays.js";
import { filterVisibility } from "./denoise.js";
import { bloom, decode, FLAG_EDGE, FLAG_GLOW, FLAG_SHINY, GLOW, KEY, KIND_FLOOR, KIND_MODEL, KIND_SKY, lightAngle, pointRadius, tonemap, toLinear, toSrgb, untone } from "./photometry.js";
import { BACKDROP, buildEnvironment, DEFAULT_LIGHT_DIRECTION, environmentPalette, horizonRadiance, irradiance, lightDirection, prefiltered, REFLECT, skyAt, softboxAt, type EnvironmentState } from "./environment.js";
import { createGlass, SEE_BACKDROP, SEE_MIRROR } from "./pbr-glass.js";
import type { BeautyOptions } from "./beauty.js";
import type { BufferSpec, Kernel, KernelContext, KernelRows } from "./kernel.js";

/** True when some material in the shape lets light through: the shadow march then has to ask hit() what it met. */
export function anyGlass(shape: Shape3): boolean {
  const seen = new Set<Shape3>();
  const stack: Shape3[] = [shape];
  while (stack.length) {
    const s = stack.pop()!;
    if (seen.has(s)) continue;
    seen.add(s);
    if ((s.material && s.material.transmit > 0) || (s.decal && s.decal.transmit > 0)) return true;
    if (s.inner) stack.push(...s.inner);
    if (s.parts) stack.push(...s.parts);
    if (s.instanced) stack.push(s.instanced.base);
    if (s.joint) stack.push(s.joint.child);
  }
  return false;
}

/** The shared tables: the sky, the mesh's BVH, and whether any material lets light through. */
export interface PbrTables {
  env: EnvironmentState;
  bvh: BvhData;
  glass: boolean;
}

/** One light as the kernel takes it: towards it (from the model's centre, for a point light), its size, sRGB colour, power, and a point light's place and range. */
interface SceneLight {
  dir: Vec3;
  size: number;
  color: Vec3;
  power: number;
  pos?: Vec3;
  range: number;
}

/** The program's lights, or the one key light the settings describe. A point light with no range reaches half the model's longest side. */
function sceneLights(opts: BeautyOptions, model: Bounds): SceneLight[] {
  const centre = boundsCenter(model);
  const halfModel = Math.max(...boundsSize(model)) / 2 || 1;
  if (opts.lights && opts.lights.length)
    return opts.lights.map((l) => ({
      dir: l.position ? normalize([l.position[0] - centre[0], l.position[1] - centre[1], l.position[2] - centre[2]]) : lightDirection(l.azimuth, l.elevation),
      size: Math.max(0, l.size), color: l.color, power: Math.max(0, l.power), pos: l.position, range: Math.max(1e-6, l.range ?? halfModel),
    }));
  const dir = opts.lightAzimuth === undefined && opts.lightElevation === undefined ? DEFAULT_LIGHT_DIRECTION : lightDirection(opts.lightAzimuth ?? -40, opts.lightElevation ?? 55);
  return [{ dir, size: Math.max(0, opts.lightSize ?? 1), color: [1, 1, 1], power: 1, range: 2 }];
}

const lightCount = (opts: BeautyOptions): number => (opts.lights && opts.lights.length ? opts.lights.length : 1);
const slotCount = (opts: BeautyOptions): number => (opts.splitLights ? lightCount(opts) + 1 : 1);

/** How far the specular occlusion takes the cavity term: K^p, K the first three taps of the field's occlusion. */
export const CAVITY_POWER = 1;
/** Roughness below which a surface is a mirror: one traced ray, and the lights' softboxes in place of their highlights. */
export const MIRROR_ROUGH = 0.12;
/** Roughness below which a glossy metal takes several traced GGX rays, and above which only the prefiltered sky. */
export const GLOSSY_ROUGH = 0.35, TRACED_ROUGH = 0.55;

export const pbr: Kernel<PbrTables> = {
  name: "pbr",
  layout: (opts): BufferSpec[] => {
    const NL = lightCount(opts), S = slotCount(opts);
    return [
      // Radiance per slot, everything but the lights' direct light on primary surfaces and the floor.
      { name: "R", type: "f32", per: 3 * S },
      // Each light's unshadowed direct light (its tint through glass folded in), and its visibility.
      { name: "D", type: "f32", per: 3 * NL },
      { name: "V", type: "f32", per: NL },
      // The guides: what the primary ray met.
      { name: "depth", type: "f32", per: 1 },
      { name: "normal", type: "f32", per: 3 },
      { name: "mat", type: "i32", per: 1 },
      { name: "flags", type: "u8", per: 1 },
      // The primary sample's tone-mapped luma, for the edge pass's brightness test (which no edge pass writes).
      { name: "luma", type: "f32", per: 1 },
      // An edge pixel's mean of its four samples' tone-mapped colours.
      { name: "E", type: "f32", per: 3 },
    ];
  },
  prepare: (ctx) => {
    const model = ctx.opts.reachBounds ?? ctx.bounds;
    const lights = sceneLights(ctx.opts, model);
    const env = buildEnvironment(ctx.opts.environment ?? "studio", {
      cameraAzimuth: ctx.opts.azimuth ?? 35,
      lights: lights.map((l) => ({ dir: l.dir, size: l.size, color: l.color, power: l.power, position: l.pos })),
      cache: ctx.cache,
      shared: ctx.shared,
    });
    const bvh = bvhFor(ctx.mesh, ctx.cache, ctx.shared);
    // A material the walk cannot see is still in the mesh unless it is thinner than a cell: both are asked.
    const glass = anyGlass(ctx.shape) || ctx.mesh.materials.some((m) => m.transmit > 0);
    return { env, bvh, glass };
  },
  rows: (ctx) => pbrRows(ctx),
  finish: (ctx) => pbrFinish(ctx),
};

/** Per light, packed: towards it, its place, point or not, range², tan of its angular radius, its sphere's radius, its linear radiance on a white face, its slot's offset, its soft march's constant. */
const LS = 16;

function pbrRows(ctx: KernelContext<PbrTables>): KernelRows {
  const { shape, bounds, opts, camera: cam, prime, size, cell, buffers, ids } = ctx;
  const SKY = ctx.tables.env;
  const full = (opts.quality ?? "full") === "full";
  const MAX_DEPTH = full ? 2 : 1, GLOSSY = full ? 4 : 1, GLASS_CHAIN = full ? 2 : 1, CONTRAST = full;
  const model = opts.reachBounds ?? bounds;
  const lights = sceneLights(opts, model);
  const NL = lights.length;
  const split = !!opts.splitLights;
  const S = split ? NL + 1 : 1, W = S * 3;
  const E = Math.max(0, opts.ambient ?? 1) * SKY.ambient;
  const centre = boundsCenter(model);
  const floorY = Math.min(0, model.min[1]);
  const modelSize = Math.hypot(...boundsSize(model));
  const reach = modelSize * 1.5;
  const dist = shape.dist;
  const probe = opts.wearProbe ?? wearProbe(Math.max(...boundsSize(model)));
  const rays = createRays(shape, ctx.mesh as Mesh, ctx.tables.bvh, cell, model, reach, { glass: ctx.tables.glass });
  const eps = cell * 0.5;

  const LP = new Float64Array(NL * LS);
  const RL: RayLight[] = [];
  lights.forEach((l, i) => {
    const o = i * LS;
    LP[o] = l.dir[0]; LP[o + 1] = l.dir[1]; LP[o + 2] = l.dir[2];
    const r = l.pos ? pointRadius(l.size, l.range) : 0;
    if (l.pos) { LP[o + 3] = l.pos[0]; LP[o + 4] = l.pos[1]; LP[o + 5] = l.pos[2]; LP[o + 6] = 1; }
    LP[o + 7] = l.range * l.range;
    const ang = Math.min(1.5, lightAngle(l.size));
    LP[o + 8] = Math.tan(ang);
    LP[o + 9] = r;
    LP[o + 10] = toLinear(l.color[0]) * l.power * KEY; LP[o + 11] = toLinear(l.color[1]) * l.power * KEY; LP[o + 12] = toLinear(l.color[2]) * l.power * KEY;
    LP[o + 13] = split ? (i + 1) * 3 : 0;
    LP[o + 14] = softnessFor(ang);
    LP[o + 15] = l.power > 0 ? 1 : 0;
    RL.push(l.pos ? { point: true, x: l.pos[0], y: l.pos[1], z: l.pos[2], radius: r, index: i } : { point: false, x: l.dir[0], y: l.dir[1], z: l.dir[2], radius: lightAngle(l.size), index: i });
  });

  // The floor's albedo: what shows the palette's floor colour in the open near the model, under the sky's light from
  // above and every directional light at full strength.
  const UP = new Float64Array(3);
  irradiance(SKY, 0, 1, 0, UP, 0);
  UP[0] *= E; UP[1] *= E; UP[2] *= E;
  const FT = new Float64Array(3);
  const pal = environmentPalette(SKY.env);
  decode(pal.floor[0], pal.floor[1], pal.floor[2], FT, 0);
  let dirR = 0, dirG = 0, dirB = 0;
  for (let i = 0; i < NL; i++) {
    const q = i * LS;
    if (LP[q + 6]) continue;
    const k = Math.max(0, LP[q + 1]);
    dirR += LP[q + 10] * k; dirG += LP[q + 11] * k; dirB += LP[q + 12] * k;
  }
  const albR = Math.min(0.95, FT[0] / Math.max(1e-4, UP[0] + dirR));
  const albG = Math.min(0.95, FT[1] / Math.max(1e-4, UP[1] + dirG));
  const albB = Math.min(0.95, FT[2] / Math.max(1e-4, UP[2] + dirB));

  const f = size / 2 / Math.tan(((cam.fov ?? 30) * Math.PI) / 360);
  const ex = cam.eye[0], ey = cam.eye[1], ez = cam.eye[2];
  // Where the bottom of the frame meets the floor on the camera's side: the studio's flag starts past it, out of shot,
  // so a metal facing the camera has a dark floor to reflect.
  let flagFrom: number;
  {
    const y = -(size - size / 2) / f;
    const dx = cam.up[0] * y + cam.forward[0], dy = cam.up[1] * y + cam.forward[1], dz = cam.up[2] * y + cam.forward[2];
    const camSide = (ex - centre[0]) * SKY.fx + (ez - centre[2]) * SKY.fz;
    if (dy < -1e-6) {
      const t = (floorY - ey) / dy;
      flagFrom = Math.min(camSide, (ex + dx * t - centre[0]) * SKY.fx + (ez + dz * t - centre[2]) * SKY.fz);
    } else flagFrom = camSide;
    flagFrom += modelSize * 0.03;
  }

  // Scratch: radiance per depth of the recursion (W floats), a surface per depth, the reflection per depth.
  const MAXD = 8;
  const COL = new Float64Array(MAXD * W), RF = new Float64Array(MAXD * W);
  const SURF = new Float64Array(MAXD * 12);
  const N3 = new Float64Array(3), TMP = new Float64Array(3), AOK = new Float64Array(2), TM = new Float64Array(3);
  // The direct light of the last area-lit point (a primary surface or the floor) per light, and its visibility.
  const DL = new Float64Array(NL * 3), VL = new Float64Array(NL);
  // The pixel and subsample being drawn, which place the area light's rays.
  let pixX = 0, pixY = 0, pixS = 0;
  let glassChain = 0;

  const gradientInto = (x: number, y: number, z: number, out: Float64Array): void => {
    const gx = dist(x + eps, y, z) - dist(x - eps, y, z), gy = dist(x, y + eps, z) - dist(x, y - eps, z), gz = dist(x, y, z + eps) - dist(x, y, z - eps);
    const l = Math.sqrt(gx * gx + gy * gy + gz * gz) || 1;
    out[0] = gx / l; out[1] = gy / l; out[2] = gz / l;
  };

  /** The field's occlusion along the normal over five taps (AOK[0]) and its first three, the cavity term (AOK[1]). */
  const occlusion = (px: number, py: number, pz: number, nx: number, ny: number, nz: number): void => {
    let occ = 0, w = 1;
    for (let i = 1; i <= 5; i++) {
      const h = cell * 1.5 * i * i * 0.4 + cell;
      const d = dist(px + nx * h, py + ny * h, pz + nz * h);
      occ += w * Math.max(0, h - d);
      w *= 0.7;
      if (i === 3) AOK[1] = Math.max(0.3, Math.min(1, 1 - (0.8 * occ) / (cell * 4)));
    }
    // Never fully black: a concave join still gets bounce light.
    AOK[0] = Math.max(0.3, Math.min(1, 1 - (0.8 * occ) / (cell * 4)));
  };

  /** The darkening under a part standing on the floor: occlusion over a larger reach than the surface's, up to 19% of the model's diagonal. */
  const contact = (px: number, pz: number): number => {
    let occ = 0, wsum = 0;
    for (let i = 1; i <= 4; i++) {
      const h = modelSize * 0.012 * i * i;
      const d = dist(px, floorY + h, pz);
      occ += Math.max(0, h - d) / h / i;
      wsum += 1 / i;
    }
    return 1 - 0.75 * Math.min(1, occ / wsum);
  };

  /**
   * The surface at a hit into SURF at depth: linear base colour, metal, rough, glow and the normal (tilted by a bump).
   * A material with a finish (wear, bump, rust) asks surface() with the curvature wear reads and the bump's slope, the
   * same function and slope the atlas baker writes into the GLB's maps. The bump's branch allocates.
   */
  const finishAt = (depth: number, px: number, py: number, pz: number, nx: number, ny: number, nz: number, h: Hit): void => {
    const o = depth * 12, m = h.mat;
    let base: Vec3, metal = m.metal, rough = m.rough, glow = m.glow;
    if (!hasFinish(m)) base = albedo(m, h.lx, h.ly, h.lz);
    else {
      const c = (m.wear ?? 0) > 0 ? fieldCurvature(dist, px, py, pz, probe) : 0;
      const sf = surface(m, h.lx, h.ly, h.lz, c);
      base = sf.color; metal = sf.metal; rough = sf.rough; glow = sf.glow;
      if ((m.bump ?? 0) > 0) {
        // Two tangents, and how far the paint frame's point moves along each per world unit (from two nearby hits),
        // so the slope is measured in the frame the bumps were painted in: they move and turn with the part.
        const ref: Vec3 = Math.abs(ny) < 0.9 ? [0, 1, 0] : [1, 0, 0];
        const t1 = normalize([ny * ref[2] - nz * ref[1], nz * ref[0] - nx * ref[2], nx * ref[1] - ny * ref[0]]);
        const t2: Vec3 = [ny * t1[2] - nz * t1[1], nz * t1[0] - nx * t1[2], nx * t1[1] - ny * t1[0]];
        const e = bumpScaleOf(m) * 0.1;
        const along = (t: Vec3): Vec3 => {
          const q = shape.hit(px + t[0] * e, py + t[1] * e, pz + t[2] * e);
          // A neighbour in another material (a decal's edge) is no slope.
          return q.mat === m ? [(q.lx - h.lx) / e, (q.ly - h.ly) / e, (q.lz - h.lz) / e] : [0, 0, 0];
        };
        const [s1, s2] = bumpSlope(m, h.lx, h.ly, h.lz, along(t1), along(t2));
        const bx = nx - s1 * t1[0] - s2 * t2[0], by = ny - s1 * t1[1] - s2 * t2[1], bz = nz - s1 * t1[2] - s2 * t2[2];
        const l = Math.sqrt(bx * bx + by * by + bz * bz) || 1;
        nx = bx / l; ny = by / l; nz = bz / l;
      }
    }
    SURF[o] = toLinear(base[0]); SURF[o + 1] = toLinear(base[1]); SURF[o + 2] = toLinear(base[2]);
    SURF[o + 3] = Math.max(0, Math.min(1, metal)); SURF[o + 4] = Math.max(0.03, Math.min(1, rough)); SURF[o + 5] = glow;
    SURF[o + 6] = nx; SURF[o + 7] = ny; SURF[o + 8] = nz;
  };

  /** The sky along a unit direction into out at o (W floats): a mirror's (REFLECT times E in slot 0, each light's softbox in its slot), or the backdrop. */
  const skyInto = (dx: number, dy: number, dz: number, see: number, out: Float64Array, o: number): void => {
    for (let k = 0; k < W; k++) out[o + k] = 0;
    if (see === SEE_BACKDROP) { skyAt(SKY, dx, dy, dz, out, o, BACKDROP); return; }
    skyAt(SKY, dx, dy, dz, out, o, REFLECT);
    out[o] *= E; out[o + 1] *= E; out[o + 2] *= E;
    for (let i = 0; i < NL; i++) if (!LP[i * LS + 6]) softboxAt(SKY, i, dx, dy, dz, out, o + LP[i * LS + 13]);
  };

  /**
   * One light's direct light on a smooth surface, unshadowed, into TMP; false when the surface faces away. The light
   * as seen from p goes in L3 (its direction, its distance in L3[3], Infinity for a directional light).
   */
  const L3 = new Float64Array(4);
  const lightAt = (i: number, px: number, py: number, pz: number): number => {
    const q = i * LS;
    let lx = LP[q], ly = LP[q + 1], lz = LP[q + 2], att = 1, far = Infinity;
    if (LP[q + 6]) {
      lx = LP[q + 3] - px; ly = LP[q + 4] - py; lz = LP[q + 5] - pz;
      far = Math.sqrt(lx * lx + ly * ly + lz * lz) || 1e-9;
      lx /= far; ly /= far; lz /= far;
      att = LP[q + 7] / (LP[q + 7] + far * far);
    }
    L3[0] = lx; L3[1] = ly; L3[2] = lz; L3[3] = far;
    return att;
  };

  /** The visibility of light i from p (lifted off its surface) by one occlusion ray, per channel into rays.vis. */
  const occlusionTo = (i: number, px: number, py: number, pz: number): void => {
    const q = i * LS, far = L3[3];
    if (LP[q + 6]) {
      const r = LP[q + 9];
      if (far <= r) { rays.vis[0] = 1; rays.vis[1] = 1; rays.vis[2] = 1; return; }
      rays.occlusion(px, py, pz, L3[0], L3[1], L3[2], far - r, softnessFor(Math.asin(Math.min(1, r / far))));
    } else rays.occlusion(px, py, pz, L3[0], L3[1], L3[2], Infinity, LP[q + 14]);
  };

  /** The area light's visibility of light i from p (lifted), with the pixel's rays: its mean into VL[i], its tint into TMP. */
  const areaTo = (i: number, px: number, py: number, pz: number): void => {
    const v = rays.areaVisibility(px, py, pz, RL[i], pixX, pixY, pixS);
    VL[i] = v;
    if (v > 0) { TMP[0] = rays.vis[0] / v; TMP[1] = rays.vis[1] / v; TMP[2] = rays.vis[2] / v; }
    else { TMP[0] = 1; TMP[1] = 1; TMP[2] = 1; }
  };

  /**
   * The light a surface sends back along -d into COL at depth; its surface is SURF at depth. `area`: a primary
   * surface, whose lights' direct light goes to DL and VL (the area light's visibility, filtered later) rather than
   * into COL. `canTrace`: the reflection may be traced (not for glass's own surface).
   */
  const shade = (depth: number, px: number, py: number, pz: number, dx: number, dy: number, dz: number, area: boolean, canTrace: boolean): void => {
    const s = depth * 12, o = depth * W;
    for (let k = 0; k < W; k++) COL[o + k] = 0;
    const br = SURF[s], bg = SURF[s + 1], bb = SURF[s + 2], metal = SURF[s + 3], rough = SURF[s + 4], glow = SURF[s + 5];
    let nx = SURF[s + 6], ny = SURF[s + 7], nz = SURF[s + 8];
    let nv = -(nx * dx + ny * dy + nz * dz);
    if (nv < 1e-3) {
      // A normal turned from the eye (a gradient across a thin part, a bump): bent back to face the ray just enough.
      const k = 1e-3 - nv;
      nx -= dx * k; ny -= dy * k; nz -= dz * k;
      const l = Math.sqrt(nx * nx + ny * ny + nz * nz) || 1;
      nx /= l; ny /= l; nz /= l;
      nv = 1e-3;
    }
    occlusion(px, py, pz, nx, ny, nz);
    const ao = AOK[0], cav = AOK[1];
    const cdr = br * (1 - metal), cdg = bg * (1 - metal), cdb = bb * (1 - metal);
    const f0r = 0.04 + (br - 0.04) * metal, f0g = 0.04 + (bg - 0.04) * metal, f0b = 0.04 + (bb - 0.04) * metal;
    const alpha = rough * rough, a2 = alpha * alpha;
    // The split sum's scale and bias (Karis's analytic fit), and the energy a rough lobe loses to scattering more than once.
    const rx = 1 - rough, ry = -0.0275 * rough + 0.0425, rz = -0.572 * rough + 1.04, rw = 0.022 * rough - 0.04;
    const a004 = Math.min(rx * rx, Math.pow(2, -9.28 * nv)) * rx + ry;
    const A = a004 * -1.04 + rz, B = a004 * 1.04 + rw;
    const ess = Math.max(0.2, A + B);
    const emr = 1 + f0r * (1 / ess - 1), emg = 1 + f0g * (1 / ess - 1), emb = 1 + f0b * (1 / ess - 1);
    const sr = (f0r * A + B) * emr, sg = (f0g * A + B) * emg, sb = (f0b * A + B) * emb;
    // The sky's diffuse light, less what the specular took.
    const kd = Math.max(0, 1 - (0.04 * A + B));
    irradiance(SKY, nx, ny, nz, TMP, 0);
    const kdiff = E * ao * kd;
    COL[o] = cdr * TMP[0] * kdiff; COL[o + 1] = cdg * TMP[1] * kdiff; COL[o + 2] = cdb * TMP[2] * kdiff;
    // The lights. A mirror traces its reflection, which sees each directional light's softbox: its highlight is that.
    const weight0 = Math.max(f0r * A + B, f0g * A + B, f0b * A + B);
    const mirror = canTrace && depth < MAX_DEPTH && depth + 1 < MAXD && rough < MIRROR_ROUGH && weight0 >= 0.015;
    const vx = -dx, vy = -dy, vz = -dz;
    const lpx = px + nx * cell, lpy = py + ny * cell, lpz = pz + nz * cell;
    for (let i = 0; i < NL; i++) {
      const q = i * LS;
      if (area) { DL[i * 3] = 0; DL[i * 3 + 1] = 0; DL[i * 3 + 2] = 0; VL[i] = 1; }
      if (!LP[q + 15]) continue;
      const att = lightAt(i, px, py, pz);
      const lx = L3[0], ly = L3[1], lz = L3[2], far = L3[3];
      const nl = nx * lx + ny * ly + nz * lz;
      if (nl <= 0) { if (area) VL[i] = 0; continue; }
      let hx = lx + vx, hy = ly + vy, hz = lz + vz;
      const hl = Math.sqrt(hx * hx + hy * hy + hz * hz) || 1;
      hx /= hl; hy /= hl; hz /= hl;
      const nh = Math.max(0, nx * hx + ny * hy + nz * hz), vh = Math.max(0, vx * hx + vy * hy + vz * hz);
      // The highlight of a light with a size: the lobe widened by its angular radius, its peak lowered to keep its energy.
      const tanT = LP[q + 6] ? LP[q + 9] / far : LP[q + 8];
      const aL = Math.min(1, alpha + 0.5 * tanT), aL2 = aL * aL;
      const dd = nh * nh * (aL2 - 1) + 1;
      const D = aL2 / (Math.PI * dd * dd);
      const vis = 0.5 / (nl * Math.sqrt(nv * nv * (1 - a2) + a2) + nv * Math.sqrt(nl * nl * (1 - a2) + a2));
      const fw = Math.pow(1 - vh, 5);
      const Fr = f0r + (1 - f0r) * fw, Fg = f0g + (1 - f0g) * fw, Fb = f0b + (1 - f0b) * fw;
      // In the units where a white Lambert surface square to the light returns its radiance on a white face: f·π.
      const spec = mirror && !LP[q + 6] ? 0 : D * vis * Math.PI;
      const k = nl * att;
      const tr = LP[q + 10] * k * (cdr * (1 - Fr) + Fr * spec * emr);
      const tg = LP[q + 11] * k * (cdg * (1 - Fg) + Fg * spec * emg);
      const tb = LP[q + 12] * k * (cdb * (1 - Fb) + Fb * spec * emb);
      if (area) {
        areaTo(i, lpx, lpy, lpz);
        DL[i * 3] = tr * TMP[0]; DL[i * 3 + 1] = tg * TMP[1]; DL[i * 3 + 2] = tb * TMP[2];
      } else {
        occlusionTo(i, lpx, lpy, lpz);
        const so = o + LP[q + 13];
        COL[so] += tr * rays.vis[0]; COL[so + 1] += tg * rays.vis[1]; COL[so + 2] += tb * rays.vis[2];
      }
    }

    // The reflection: what the surface mirrors, traced where it can be, the prefiltered sky where it cannot.
    const rdot = 2 * (dx * nx + dy * ny + dz * nz);
    let mx = dx - rdot * nx, my = dy - rdot * ny, mz = dz - rdot * nz;
    const ml = Math.sqrt(mx * mx + my * my + mz * mz) || 1;
    mx /= ml; my /= ml; mz /= ml;
    const weight = Math.max(sr, sg, sb);
    const ox = px + nx * cell * 2, oy = py + ny * cell * 2, oz = pz + nz * cell * 2;
    const q1 = (depth + 1) * W;
    // Specular occlusion (Lagarde): the occlusion as the reflection sees it, tighter for a smooth surface; times the
    // cavity term, so a groove in polished metal stays dark enough to read.
    const so = Math.max(0, Math.min(1, Math.pow(nv + ao, Math.pow(2, -16 * rough - 1)) - 1 + ao)) * (CAVITY_POWER === 1 ? cav : Math.pow(cav, CAVITY_POWER));
    for (let k = 0; k < W; k++) RF[o + k] = 0;
    const traceable = canTrace && depth < MAX_DEPTH && depth + 1 < MAXD;
    if (!traceable || rough > TRACED_ROUGH || weight < 0.015 || (depth > 0 && rough >= MIRROR_ROUGH)) {
      prefiltered(SKY, mx, my, mz, rough, E * so, RF, o);
    } else if (rough < MIRROR_ROUGH) {
      // A mirror: one ray, and whatever it meets.
      trace(depth + 1, ox, oy, oz, mx, my, mz, false, SEE_MIRROR);
      for (let k = 0; k < W; k++) RF[o + k] = COL[q1 + k];
    } else {
      // Several GGX rays where the lobe is narrow enough that four of them are not grain; past that, one ray blended
      // into the prefiltered sky, which is smooth (four rays in a steel bowl of roughness 0.45 were salt and pepper).
      const n = depth === 0 && rough < GLOSSY_ROUGH && (metal > 0.5 || weight > 0.2) ? GLOSSY : 1;
      if (n <= 1) {
        // One ray along the mirror direction: what it meets, blurred towards the prefiltered sky by roughness.
        const g = (1 - rough) * (1 - rough);
        if (trace(depth + 1, ox, oy, oz, mx, my, mz, true, SEE_MIRROR)) {
          for (let k = 0; k < W; k++) RF[o + k] = COL[q1 + k] * g;
          prefiltered(SKY, mx, my, mz, rough, E * so * (1 - g), RF, o);
        } else prefiltered(SKY, mx, my, mz, rough, E * so, RF, o);
      } else {
        // GGX rays about the normal in one fixed stratified pattern for every pixel (the lobe's quantiles, turned by
        // the golden angle), not a random one: four random rays were grain in a steel bowl's hollow; four fixed ones
        // are a slight blur. The ones that meet the model bring its light; the ones that miss share the prefiltered sky.
        const sgn = nz >= 0 ? 1 : -1, aa = -1 / (sgn + nz), b2 = nx * ny * aa;
        const t1x = 1 + sgn * nx * nx * aa, t1y = sgn * b2, t1z = -sgn * nx;
        const t2x = b2, t2y = sgn + ny * ny * aa, t2z = -ny;
        let misses = 0;
        for (let k = 0; k < n; k++) {
          const u1 = (k + 0.5) / n, u2 = 0.125 + k * 0.6180339887;
          const phi = 2 * Math.PI * (u2 - Math.floor(u2));
          const ct = Math.sqrt((1 - u1) / (1 + (a2 - 1) * u1)), st = Math.sqrt(Math.max(0, 1 - ct * ct));
          const hx = st * Math.cos(phi), hy = st * Math.sin(phi);
          const Hx = t1x * hx + t2x * hy + nx * ct, Hy = t1y * hx + t2y * hy + ny * ct, Hz = t1z * hx + t2z * hy + nz * ct;
          const vh = vx * Hx + vy * Hy + vz * Hz;
          const lx = 2 * vh * Hx - vx, ly = 2 * vh * Hy - vy, lz = 2 * vh * Hz - vz;
          if (lx * nx + ly * ny + lz * nz <= 0) { misses++; continue; }
          if (trace(depth + 1, ox, oy, oz, lx, ly, lz, true, SEE_MIRROR)) for (let c = 0; c < W; c++) RF[o + c] += COL[q1 + c] / n;
          else misses++;
        }
        if (misses > 0) prefiltered(SKY, mx, my, mz, rough, (E * so * misses) / n, RF, o);
      }
    }
    for (let k = 0; k < W; k += 3) { COL[o + k] += RF[o + k] * sr; COL[o + k + 1] += RF[o + k + 1] * sg; COL[o + k + 2] += RF[o + k + 2] * sb; }
    // Glow: light the surface gives off, unshadowed, in the sky's slot.
    if (glow > 0) { COL[o] += br * glow * GLOW; COL[o + 1] += bg * glow * GLOW; COL[o + 2] += bb * glow * GLOW; }
  };

  /** Each light's GGX highlight on a smooth dielectric (glass), times k, with one occlusion ray, into COL at depth; directional lights left to a traced reflection. */
  const highlights = (depth: number, px: number, py: number, pz: number, nx: number, ny: number, nz: number, dx: number, dy: number, dz: number, rough: number, k0: number, traced: boolean): void => {
    const o = depth * W;
    const alpha = Math.max(0.03, rough) ** 2, a2 = alpha * alpha;
    const nv = Math.max(1e-3, -(nx * dx + ny * dy + nz * dz));
    for (let i = 0; i < NL; i++) {
      const q = i * LS;
      if (!LP[q + 15] || (traced && !LP[q + 6])) continue;
      const att = lightAt(i, px, py, pz);
      const lx = L3[0], ly = L3[1], lz = L3[2], far = L3[3];
      const nl = nx * lx + ny * ly + nz * lz;
      if (nl <= 0) continue;
      let hx = lx - dx, hy = ly - dy, hz = lz - dz;
      const hl = Math.sqrt(hx * hx + hy * hy + hz * hz) || 1;
      hx /= hl; hy /= hl; hz /= hl;
      const nh = Math.max(0, nx * hx + ny * hy + nz * hz), vh = Math.max(0, -(dx * hx + dy * hy + dz * hz));
      const tanT = LP[q + 6] ? LP[q + 9] / far : LP[q + 8];
      const aL = Math.min(1, alpha + 0.5 * tanT), aL2 = aL * aL;
      const dd = nh * nh * (aL2 - 1) + 1;
      const D = aL2 / (Math.PI * dd * dd);
      const vis = 0.5 / (nl * Math.sqrt(nv * nv * (1 - a2) + a2) + nv * Math.sqrt(nl * nl * (1 - a2) + a2));
      const F = 0.04 + 0.96 * Math.pow(1 - vh, 5);
      occlusionTo(i, px + nx * cell, py + ny * cell, pz + nz * cell);
      const kk = F * D * vis * Math.PI * nl * att * k0;
      const so = o + LP[q + 13];
      COL[so] += LP[q + 10] * kk * rays.vis[0]; COL[so + 1] += LP[q + 11] * kk * rays.vis[1]; COL[so + 2] += LP[q + 12] * kk * rays.vis[2];
    }
  };

  /** Glass's own surface as an opaque smooth dielectric of its colour, without tracing, into COL at depth. */
  const shadeOpaque = (depth: number, px: number, py: number, pz: number, nx: number, ny: number, nz: number, r: number, g: number, b: number, rough: number, dx: number, dy: number, dz: number): void => {
    const s = depth * 12;
    SURF[s] = r; SURF[s + 1] = g; SURF[s + 2] = b; SURF[s + 3] = 0; SURF[s + 4] = Math.max(0.03, rough); SURF[s + 5] = 0;
    SURF[s + 6] = nx; SURF[s + 7] = ny; SURF[s + 8] = nz;
    shade(depth, px, py, pz, dx, dy, dz, false, false);
  };

  const shadeGlass = createGlass({ W, COL, MAXD, cell, rays, maxDepth: MAX_DEPTH, trace, sky: skyInto, gradient: gradientInto, shadeOpaque, highlights });

  /**
   * The floor at (fx, floorY, fz) into COL at depth: its albedo times the sky over it, occluded, and each light at
   * full strength, shadowed near the model. `area`: the primary floor, whose lights go to DL and VL. `withContact`:
   * the contact term under a part standing on it (the primary floor only).
   */
  const floorAt = (depth: number, fx: number, fz: number, away: number, area: boolean, withContact: boolean): void => {
    const o = depth * W;
    for (let k = 0; k < W; k++) COL[o + k] = 0;
    const near = away >= reach ? 0 : away <= reach * 0.66 ? 1 : (reach - away) / (reach * 0.34);
    let ao = 1;
    if (near > 0) {
      occlusion(fx, floorY, fz, 0, 1, 0);
      ao = 1 + (AOK[0] * (withContact ? contact(fx, fz) : 1) - 1) * near;
    }
    // The flag: the floor on the camera's side, beyond the bottom of the frame, is dark, as the sky's ground there is.
    let fl = 1;
    if (SKY.flag > 0) {
      const sd = (fx - centre[0]) * SKY.fx + (fz - centre[2]) * SKY.fz;
      if (sd > flagFrom) fl = 1 - SKY.flag * smoothstep(flagFrom, flagFrom + modelSize * 0.35, sd);
    }
    const ar = albR * fl, ag = albG * fl, ab = albB * fl;
    COL[o] = ar * UP[0] * ao; COL[o + 1] = ag * UP[1] * ao; COL[o + 2] = ab * UP[2] * ao;
    const lpy = floorY + cell;
    for (let i = 0; i < NL; i++) {
      const q = i * LS;
      if (area) { DL[i * 3] = 0; DL[i * 3 + 1] = 0; DL[i * 3 + 2] = 0; VL[i] = 1; }
      if (!LP[q + 15]) continue;
      // A point light reaches only the floor near the model, fading out with it.
      if (LP[q + 6] && near <= 0) continue;
      let att = lightAt(i, fx, floorY, fz);
      const ly = L3[1];
      if (ly <= 0) { if (area) VL[i] = 0; continue; }
      if (LP[q + 6]) att *= near;
      const k = ly * att;
      const tr = ar * LP[q + 10] * k, tg = ag * LP[q + 11] * k, tb = ab * LP[q + 12] * k;
      if (area) {
        if (near > 0) {
          areaTo(i, fx, lpy, fz);
          VL[i] = 1 + (VL[i] - 1) * near;
          DL[i * 3] = tr * (1 + (TMP[0] - 1) * near); DL[i * 3 + 1] = tg * (1 + (TMP[1] - 1) * near); DL[i * 3 + 2] = tb * (1 + (TMP[2] - 1) * near);
        } else { DL[i * 3] = tr; DL[i * 3 + 1] = tg; DL[i * 3 + 2] = tb; }
      } else {
        const so = o + LP[q + 13];
        if (near > 0) {
          occlusionTo(i, fx, lpy, fz);
          COL[so] += tr * (1 + (rays.vis[0] - 1) * near); COL[so + 1] += tg * (1 + (rays.vis[1] - 1) * near); COL[so + 2] += tb * (1 + (rays.vis[2] - 1) * near);
        } else { COL[so] += tr; COL[so + 1] += tg; COL[so + 2] += tb; }
      }
    }
  };

  /**
   * Follow a ray from o along d and put what it sees in COL at depth: the model (shaded), the floor, or the sky (a
   * mirror's or the backdrop, as `see` says). With `geometryOnly`, a ray that meets no part of the model returns
   * false and writes nothing (the caller has the prefiltered sky, whose lower half is the floor's light).
   */
  function trace(depth: number, ox: number, oy: number, oz: number, dx: number, dy: number, dz: number, geometryOnly: boolean, see: number): boolean {
    const o = depth * W;
    const t = rays.closest(ox, oy, oz, dx, dy, dz, reach * 4);
    if (t >= 0) {
      const px = ox + dx * t, py = oy + dy * t, pz = oz + dz * t;
      gradientInto(px, py, pz, N3);
      const nx = N3[0], ny = N3[1], nz = N3[2];
      const h = shape.hit(px, py, pz);
      if (h.mat.transmit > 0) {
        const base = albedo(h.mat, h.lx, h.ly, h.lz);
        const cr = toLinear(base[0]), cg = toLinear(base[1]), cb = toLinear(base[2]);
        if (glassChain >= GLASS_CHAIN || depth + 1 >= MAXD) {
          // Glass past the chain: the sky through it, tinted, no more bounces.
          skyInto(dx, dy, dz, SEE_BACKDROP, COL, o);
          const tr = h.mat.transmit;
          COL[o] *= cr * tr + (1 - tr); COL[o + 1] *= cg * tr + (1 - tr); COL[o + 2] *= cb * tr + (1 - tr);
        } else {
          glassChain++;
          shadeGlass(depth, px, py, pz, nx, ny, nz, h.mat, dx, dy, dz, cr, cg, cb);
          glassChain--;
        }
        return true;
      }
      finishAt(depth, px, py, pz, nx, ny, nz, h);
      shade(depth, px, py, pz, dx, dy, dz, false, true);
      return true;
    }
    if (dy < -1e-6) {
      const tf = (floorY - oy) / dy;
      if (tf > 0) {
        if (geometryOnly) return false;
        const fx = ox + dx * tf, fz = oz + dz * tf;
        floorAt(depth, fx, fz, boundsDistance(model, fx, floorY, fz), false, false);
        return true;
      }
    }
    if (geometryOnly) return false;
    skyInto(dx, dy, dz, see, COL, o);
    return true;
  }

  const R = buffers.R as Float32Array, Dbuf = buffers.D as Float32Array, Vbuf = buffers.V as Float32Array;
  const depthBuf = buffers.depth as Float32Array, normalBuf = buffers.normal as Float32Array, matBuf = buffers.mat as Int32Array;
  const flagBuf = buffers.flags as Uint8Array, lumaBuf = buffers.luma as Float32Array, Ebuf = buffers.E as Float32Array;
  // The sample's registers besides its radiance (COL at depth 0) and its lights (DL, VL).
  let sDepth = 0, sNx = 0, sNy = 0, sNz = 0, sMat = 0, sFlags = 0;

  /**
   * One camera ray through (px, py), primed at the mesh's depth: its radiance into COL at depth 0 and its lights'
   * direct light into DL and VL. The pixel's centre trusts the mesh where the field's window misses (`trust`); an edge
   * pixel's subsample keeps marching past the window, so a silhouette antialiases against the field itself.
   */
  const sample = (px: number, py: number, primedDepth: number, trust: boolean): void => {
    const x = (px - size / 2) / f, y = -(py - size / 2) / f;
    let dx = cam.right[0] * x + cam.up[0] * y + cam.forward[0], dy = cam.right[1] * x + cam.up[1] * y + cam.forward[1], dz = cam.right[2] * x + cam.up[2] * y + cam.forward[2];
    const dl = Math.sqrt(dx * dx + dy * dy + dz * dz) || 1;
    dx /= dl; dy /= dl; dz /= dl;
    for (let i = 0; i < NL; i++) { DL[i * 3] = 0; DL[i * 3 + 1] = 0; DL[i * 3 + 2] = 0; VL[i] = 1; }
    let hitT = -1;
    if (Number.isFinite(primedDepth)) {
      const along = dx * cam.forward[0] + dy * cam.forward[1] + dz * cam.forward[2];
      const c = primedDepth / along;
      let t = Math.max(0, c - cell * 3);
      const tEnd = c + cell * 3;
      let i = 0;
      for (; i < 40 && t < tEnd; i++) {
        const d = dist(ex + dx * t, ey + dy * t, ez + dz * t);
        if (d < cell * 0.05) { hitT = t; break; }
        t += Math.max(d * 0.9, cell * 0.02);
      }
      if (hitT < 0) {
        if (trust) hitT = c; // the mesh knows where the surface is; trust it
        else {
          // From where the window stopped (the march starts half a cell along), box-clipped, up to 128 steps.
          const back = t - cell * 0.5;
          const tt = rays.fieldClosest(ex + dx * back, ey + dy * back, ez + dz * back, dx, dy, dz, Infinity, 128);
          if (tt >= 0) hitT = back + tt;
        }
      }
    }
    if (hitT >= 0) {
      const p0 = ex + dx * hitT, p1 = ey + dy * hitT, p2 = ez + dz * hitT;
      gradientInto(p0, p1, p2, N3);
      const nx = N3[0], ny = N3[1], nz = N3[2];
      const h = shape.hit(p0, p1, p2);
      if (h.mat.transmit > 0) {
        const base = albedo(h.mat, h.lx, h.ly, h.lz);
        glassChain = 1;
        shadeGlass(0, p0, p1, p2, nx, ny, nz, h.mat, dx, dy, dz, toLinear(base[0]), toLinear(base[1]), toLinear(base[2]));
        glassChain = 0;
        sFlags = KIND_MODEL | FLAG_SHINY | (h.mat.glow > 0 ? FLAG_GLOW : 0);
      } else {
        finishAt(0, p0, p1, p2, nx, ny, nz, h);
        // The contrast pass is for a mirror's sharp reflections, not a pattern's or a bump's contrast.
        sFlags = KIND_MODEL | (SURF[4] < MIRROR_ROUGH ? FLAG_SHINY : 0) | (SURF[5] > 0 ? FLAG_GLOW : 0);
        shade(0, p0, p1, p2, dx, dy, dz, true, true);
      }
      // The guides read the field's normal, not the bumped one: a bump is texture, not a silhouette.
      sDepth = hitT; sNx = nx; sNy = ny; sNz = nz; sMat = ids(h.mat);
      return;
    }
    if (dy < -1e-6) {
      const t = (floorY - ey) / dy;
      const fx = ex + dx * t, fz = ez + dz * t;
      floorAt(0, fx, fz, boundsDistance(model, fx, floorY, fz), true, true);
      // The far floor fades into the sky just above the horizon, so the two meet without a seam.
      const fade = Math.min(1, t / (reach * 4));
      if (fade > 0) {
        horizonRadiance(SKY, dx, dz, TMP, 0);
        for (let k = 0; k < W; k++) COL[k] *= 1 - fade;
        COL[0] += TMP[0] * fade; COL[1] += TMP[1] * fade; COL[2] += TMP[2] * fade;
        for (let k = 0; k < NL * 3; k++) DL[k] *= 1 - fade;
      }
      sDepth = t; sNx = 0; sNy = 1; sNz = 0; sMat = -2; sFlags = KIND_FLOOR;
      return;
    }
    skyInto(dx, dy, dz, SEE_BACKDROP, COL, 0);
    sDepth = Infinity; sNx = 0; sNy = 0; sNz = 0; sMat = -3; sFlags = KIND_SKY;
  };

  /** The display colour of the sample just taken, its lights at their own visibility, tone-mapped (linear, 0..1) into TM. */
  const displayOf = (): void => {
    let r = 0, g = 0, b = 0;
    for (let k = 0; k < W; k += 3) { r += COL[k]; g += COL[k + 1]; b += COL[k + 2]; }
    for (let i = 0; i < NL; i++) { r += DL[i * 3] * VL[i]; g += DL[i * 3 + 1] * VL[i]; b += DL[i * 3 + 2] * VL[i]; }
    tonemap(r, g, b, TM, 0);
  };

  const primary = (py: number): void => {
    for (let px = 0; px < size; px++) {
      const i = py * size + px;
      pixX = px; pixY = py; pixS = 0;
      sample(px + 0.5, py + 0.5, prime[i], true);
      for (let k = 0; k < W; k++) R[i * W + k] = COL[k];
      for (let k = 0; k < NL * 3; k++) Dbuf[i * NL * 3 + k] = DL[k];
      for (let k = 0; k < NL; k++) Vbuf[i * NL + k] = VL[k];
      depthBuf[i] = sDepth; normalBuf[i * 3] = sNx; normalBuf[i * 3 + 1] = sNy; normalBuf[i * 3 + 2] = sNz; matBuf[i] = sMat;
      flagBuf[i] = sFlags;
      displayOf();
      lumaBuf[i] = TM[0] * 0.2126 + TM[1] * 0.7152 + TM[2] * 0.0722;
    }
  };

  // Edge pixels get four samples. The edge test reads depth, normal, material, the luma and the shiny bit, which no
  // edge pass writes (it sets only the edge bit of its own row's flags).
  const isEdge = (i: number, j: number): boolean => {
    const mi = matBuf[i];
    if (mi !== matBuf[j]) return true;
    // Two pixels of the floor, or of the sky, have no silhouette between them: a grazing floor's depth jumps more
    // than four cells a pixel (59% of a low shot of the ring was resampled for it).
    if (mi < 0) return false;
    const a = depthBuf[i], b = depthBuf[j];
    if (Number.isFinite(a) !== Number.isFinite(b)) return true;
    if (Number.isFinite(a) && Math.abs(a - b) > cell * 4) return true;
    if (normalBuf[i * 3] * normalBuf[j * 3] + normalBuf[i * 3 + 1] * normalBuf[j * 3 + 1] + normalBuf[i * 3 + 2] * normalBuf[j * 3 + 2] < 0.6) return true;
    // In full quality, a brightness jump beside a mirror: a sharp reflection's edge.
    return CONTRAST && ((flagBuf[i] | flagBuf[j]) & FLAG_SHINY) !== 0 && Math.abs(lumaBuf[i] - lumaBuf[j]) > 0.14;
  };
  const OFFS = [0.25, 0.25, 0.75, 0.25, 0.25, 0.75, 0.75, 0.75];
  const ACC = new Float64Array(W), DACC = new Float64Array(3);
  const edges = (py: number): void => {
    for (let px = 0; px < size; px++) {
      const i = py * size + px;
      const edge = (px + 1 < size && isEdge(i, i + 1)) || (py + 1 < size && isEdge(i, i + size)) || (px > 0 && isEdge(i, i - 1)) || (py > 0 && isEdge(i, i - size));
      if (!edge) continue;
      // Prime with the nearest finite depth among the pixel and its neighbours; a subsample that misses its window
      // marches on.
      let d = prime[i];
      if (!Number.isFinite(d)) d = Math.min(px + 1 < size ? prime[i + 1] : Infinity, py + 1 < size ? prime[i + size] : Infinity, px > 0 ? prime[i - 1] : Infinity, py > 0 ? prime[i - size] : Infinity);
      for (let k = 0; k < W; k++) ACC[k] = 0;
      DACC[0] = 0; DACC[1] = 0; DACC[2] = 0;
      for (let s = 0; s < 4; s++) {
        pixX = px; pixY = py; pixS = s + 1;
        sample(px + OFFS[s * 2], py + OFFS[s * 2 + 1], d, false);
        // A subsample's lights at its own visibility (V = 1 for the filter, which neither gives nor takes here).
        for (let l = 0; l < NL; l++) {
          const so = LP[l * LS + 13], v = VL[l];
          COL[so] += DL[l * 3] * v; COL[so + 1] += DL[l * 3 + 1] * v; COL[so + 2] += DL[l * 3 + 2] * v;
          DL[l * 3] = 0; DL[l * 3 + 1] = 0; DL[l * 3 + 2] = 0;
        }
        for (let k = 0; k < W; k++) ACC[k] += COL[k];
        displayOf();
        DACC[0] += TM[0]; DACC[1] += TM[1]; DACC[2] += TM[2];
      }
      for (let k = 0; k < W; k++) R[i * W + k] = ACC[k] / 4;
      for (let k = 0; k < NL * 3; k++) Dbuf[i * NL * 3 + k] = 0;
      for (let k = 0; k < NL; k++) Vbuf[i * NL + k] = 1;
      Ebuf[i * 3] = DACC[0] / 4; Ebuf[i * 3 + 1] = DACC[1] / 4; Ebuf[i * 3 + 2] = DACC[2] / 4;
      flagBuf[i] |= FLAG_EDGE;
    }
  };

  return { primary, edges };
}

const smoothstep = (a: number, b: number, v: number): number => {
  const t = v <= a ? 0 : v >= b ? 1 : (v - a) / (b - a);
  return t * t * (3 - 2 * t);
};

/**
 * The finish: each light's visibility filtered, the slots composed, bloom, depth of field, the tone curve and the
 * dither, the caption. Returns the linear radiance per slot, composed, before bloom.
 */
function pbrFinish(ctx: KernelContext<PbrTables>) {
  const { size, opts, buffers, camera, bounds, cell } = ctx;
  const NL = lightCount(opts), S = slotCount(opts), W = S * 3;
  const n = size * size;
  const R = buffers.R as Float32Array, D = buffers.D as Float32Array, V = buffers.V as Float32Array;
  const depth = buffers.depth as Float32Array, normal = buffers.normal as Float32Array, mat = buffers.mat as Int32Array, flags = buffers.flags as Uint8Array;
  const Eb = buffers.E as Float32Array;
  const Vf = filterVisibility(V, NL, { depth, normal, mat, flags }, size, cell);
  const hdr: Float32Array[] = [];
  for (let s = 0; s < S; s++) hdr.push(new Float32Array(n * 3));
  for (let i = 0; i < n; i++) {
    for (let s = 0; s < S; s++) {
      const h = hdr[s];
      h[i * 3] = R[i * W + s * 3]; h[i * 3 + 1] = R[i * W + s * 3 + 1]; h[i * 3 + 2] = R[i * W + s * 3 + 2];
    }
    for (let l = 0; l < NL; l++) {
      const h = hdr[S > 1 ? l + 1 : 0], v = Vf[i * NL + l], o = (i * NL + l) * 3;
      h[i * 3] += D[o] * v; h[i * 3 + 1] += D[o + 1] * v; h[i * 3 + 2] += D[o + 2] * v;
    }
  }
  // The picture in linear light: the slots' sum, and at an edge pixel the radiance its four samples' mean display
  // colour stands for (they are tone-mapped before they are averaged).
  const lin = new Float32Array(n * 3);
  for (let s = 0; s < S; s++) { const h = hdr[s]; for (let k = 0; k < n * 3; k++) lin[k] += h[k]; }
  for (let i = 0; i < n; i++) if (flags[i] & FLAG_EDGE) untone(Eb[i * 3], Eb[i * 3 + 1], Eb[i * 3 + 2], lin, i * 3);
  bloom(lin, flags, size);
  if (opts.dof && opts.dof > 0) depthOfField(lin, depth, size, opts.dof, boundsCenter(bounds), camera);
  const canvas = new Canvas(size, size, INK.page);
  const tm = new Float64Array(3);
  for (let py = 0; py < size; py++)
    for (let px = 0; px < size; px++) {
      const i = py * size + px;
      tonemap(lin[i * 3], lin[i * 3 + 1], lin[i * 3 + 2], tm, 0);
      canvas.set(px, py, rgbDithered(toSrgb(tm[0]), toSrgb(tm[1]), toSrgb(tm[2]), px, py));
    }
  if (opts.glowMask) for (let i = 0; i < n; i++) if (flags[i] & FLAG_GLOW) opts.glowMask[i] = 1;
  if (opts.label) drawText(canvas, 8, size - 12, opts.label, INK.dim, 1);
  return { canvas, hdr };
}

/**
 * Depth of field on the linear picture, in place: each pixel blurred by a circle whose radius grows with its distance
 * from the focus plane through the model's centre. A gather blur keeps it cheap.
 */
function depthOfField(lin: Float32Array, depths: Float32Array, size: number, strength: number, centre: Vec3, cam: Camera): void {
  const focus = -toView(cam, centre)[2];
  const maxRadius = Math.max(1, Math.round(size * 0.012 * strength * 3));
  const radiusAt = (d: number): number => {
    if (!Number.isFinite(d)) return maxRadius;
    return Math.min(maxRadius, (Math.abs(d - focus) / Math.max(focus, 1e-6)) * size * 0.012 * strength * 4);
  };
  const src = new Float32Array(lin);
  for (let y = 0; y < size; y++)
    for (let x = 0; x < size; x++) {
      const r = radiusAt(depths[y * size + x]);
      if (r < 0.75) continue;
      const ir = Math.ceil(r);
      let sr = 0, sg = 0, sb = 0, n = 0;
      const step = ir > 4 ? 2 : 1;
      for (let dy = -ir; dy <= ir; dy += step)
        for (let dx = -ir; dx <= ir; dx += step) {
          if (dx * dx + dy * dy > r * r) continue;
          const sx = x + dx, sy = y + dy;
          if (sx < 0 || sy < 0 || sx >= size || sy >= size) continue;
          // A sharp foreground pixel should not bleed into a blurred one behind it much: weight by its own blur.
          const w = 0.3 + 0.7 * Math.min(1, radiusAt(depths[sy * size + sx]) / Math.max(r, 1e-6));
          const j = (sy * size + sx) * 3;
          sr += src[j] * w; sg += src[j + 1] * w; sb += src[j + 2] * w; n += w;
        }
      if (n > 0) { const i = (y * size + x) * 3; lin[i] = sr / n; lin[i + 1] = sg / n; lin[i + 2] = sb / n; }
    }
}
