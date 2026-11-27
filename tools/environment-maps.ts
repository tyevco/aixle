/**
 * Pictures of the beauty render's environments (src/render/environment.ts), to read before trusting them:
 *
 *   <env>.png   the sky a mirror sees (MIRROR, with the default key's softbox) as a lat-long, the zenith at the top
 *               and the camera's azimuth in the middle; under it a chrome, a gold and a white porcelain sphere in that
 *               sky from the default camera, through a minimal shader of the kernel's model: no floor, no shadows,
 *               just the environment (E × its maps, the key's softbox) and the key light's own highlight
 *   stars.png   the night backdrop looked at directly: the moon on the key's side, the far side at 20°, and crops at a
 *               384-pixel render's scale up at 50°, 80° and 89.5°, magnified four times, to see dots, not streaks
 *
 *   tsx tools/environment-maps.ts [--out DIR] [--azimuth 35] [--key AZ,EL]
 *
 * The lat-long's columns run from the camera's back (left edge) round through the far side (middle) to its back
 * again; the grey ticks mark the camera's own azimuth (the dark side) and, in yellow, the key's.
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { normalize, type Vec3 } from "../src/core/vec.js";
import { perspective } from "../src/render/camera.js";
import { Canvas, rgb, rgbf } from "../src/render/canvas.js";
import { drawText } from "../src/render/font.js";
import {
  BACKDROP, buildEnvironment, DEFAULT_LIGHT_DIRECTION, ENVIRONMENTS, environmentPalette, irradiance, lightDirection, MIRROR, prefiltered, REFLECT, skyAt, softboxAt,
  type Environment, type EnvironmentState,
} from "../src/render/environment.js";
import { encode, KEY, lightAngle, toLinear } from "../src/render/photometry.js";

const ROOT = resolve(fileURLToPath(new URL("..", import.meta.url)));
const arg = (name: string): string | undefined => {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] : undefined;
};
const OUT = resolve(arg("--out") ?? join(ROOT, "out", "environment-maps"));
const CAM_AZ = Number(arg("--azimuth") ?? 35);
const KEY_DIR: Vec3 = arg("--key") ? lightDirection(...(arg("--key")!.split(",").map(Number) as [number, number])) : DEFAULT_LIGHT_DIRECTION;
const PAGE = rgb(24, 26, 30), INKC = rgb(220, 222, 226), DIM = rgb(150, 154, 160), YELLOW = rgb(240, 200, 60);

/** Measured F0 (linear), as the kernel package sets the presets: chromium and gold. */
const CHROME: Vec3 = [0.549, 0.556, 0.554], GOLD: Vec3 = [1.0, 0.766, 0.336];
const PORCELAIN: Vec3 = [toLinear(0xf6 / 255), toLinear(0xf4 / 255), toLinear(0xee / 255)];

const put = (c: Canvas, x: number, y: number, r: number, g: number, b: number): void => {
  const o = [0, 0, 0];
  encode(Math.max(0, r), Math.max(0, g), Math.max(0, b), o);
  c.set(x, y, rgbf(o[0], o[1], o[2]));
};

/** The MIRROR sky as a lat-long w × w/2, the camera's back at the edges. */
function latLong(s: EnvironmentState, w: number): Canvas {
  const h = w / 2, c = new Canvas(w, h, 0), v = new Float64Array(3);
  const a0 = (CAM_AZ * Math.PI) / 180;
  for (let j = 0; j < h; j++) {
    const el = Math.PI / 2 - ((j + 0.5) / h) * Math.PI;
    for (let i = 0; i < w; i++) {
      const az = a0 + Math.PI + ((i + 0.5) / w - 0.5) * 2 * Math.PI;
      skyAt(s, Math.sin(az) * Math.cos(el), Math.sin(el), Math.cos(az) * Math.cos(el), v, 0, MIRROR);
      put(c, i, j, v[0], v[1], v[2]);
    }
  }
  // Ticks: the camera's azimuth (at the edges and, on the far side, the middle) and the key's.
  const col = (az: number) => Math.round((((((az - a0 - Math.PI) / (2 * Math.PI) + 0.5) % 1) + 1) % 1) * w);
  for (let y = h - 6; y < h; y++) { c.set(col(a0), y, DIM); c.set(Math.min(w - 1, col(a0) + 1), y, DIM); }
  const ka = Math.atan2(KEY_DIR[0], KEY_DIR[2]);
  for (let y = 0; y < 6; y++) { c.set(col(ka), y, YELLOW); c.set(Math.min(w - 1, col(ka) + 1), y, YELLOW); }
  return c;
}

/** A sphere of one material in the sky, from the default camera: the minimal shader. */
function sphere(s: EnvironmentState, size: number, kind: "chrome" | "gold" | "porcelain"): Canvas {
  const cam = perspective({ min: [-1, -1, -1], max: [1, 1, 1] }, size, size, CAM_AZ, 25, 30, 1.25);
  const f = size / 2 / Math.tan(((cam.fov ?? 30) * Math.PI) / 360);
  const c = new Canvas(size, size, 0);
  const E = environmentPalette(s.env).ambient;
  const v = new Float64Array(3), env = [0, 0, 0], box = [0, 0, 0], irr = [0, 0, 0];
  const L = normalize(KEY_DIR), theta = lightAngle(1);
  for (let py = 0; py < size; py++)
    for (let px = 0; px < size; px++) {
      const x = (px + 0.5 - size / 2) / f, y = -(py + 0.5 - size / 2) / f;
      const d = normalize([cam.right[0] * x + cam.up[0] * y + cam.forward[0], cam.right[1] * x + cam.up[1] * y + cam.forward[1], cam.right[2] * x + cam.up[2] * y + cam.forward[2]]);
      const e = cam.eye;
      const b = e[0] * d[0] + e[1] * d[1] + e[2] * d[2], q = e[0] * e[0] + e[1] * e[1] + e[2] * e[2] - 1, disc = b * b - q;
      if (disc < 0) {
        skyAt(s, d[0], d[1], d[2], v, 0, BACKDROP);
        put(c, px, py, v[0], v[1], v[2]);
        continue;
      }
      const t = -b - Math.sqrt(disc);
      const n: Vec3 = [e[0] + d[0] * t, e[1] + d[1] * t, e[2] + d[2] * t];
      const nv = Math.max(1e-3, -(n[0] * d[0] + n[1] * d[1] + n[2] * d[2]));
      const rd = 2 * (d[0] * n[0] + d[1] * n[1] + d[2] * n[2]);
      const r: Vec3 = [d[0] - rd * n[0], d[1] - rd * n[1], d[2] - rd * n[2]];
      const metal = kind !== "porcelain", rough = kind === "chrome" ? 0.1 : kind === "gold" ? 0.3 : 0.2;
      const base = kind === "chrome" ? CHROME : kind === "gold" ? GOLD : PORCELAIN;
      const F0: Vec3 = metal ? base : [0.04, 0.04, 0.04];
      // Karis's analytic split sum.
      const rx = -rough + 1, ry = -0.0275 * rough + 0.0425, rz = -0.572 * rough + 1.04, rw = 0.022 * rough - 0.04;
      const a004 = Math.min(rx * rx, Math.pow(2, -9.28 * nv)) * rx + ry;
      const A = a004 * -1.04 + rz, B = a004 * 1.04 + rw;
      const out = [0, 0, 0];
      if (rough < 0.12) {
        // A mirror: what MIRROR shows along r (the environment times E, the softbox as it is), by Schlick's Fresnel.
        env[0] = env[1] = env[2] = 0; box[0] = box[1] = box[2] = 0;
        skyAt(s, r[0], r[1], r[2], env, 0, REFLECT);
        softboxAt(s, 0, r[0], r[1], r[2], box, 0);
        const fw = Math.pow(1 - nv, 5);
        for (let k = 0; k < 3; k++) out[k] = (F0[k] + (1 - F0[k]) * fw) * (E * env[k] + box[k]);
      } else {
        env[0] = env[1] = env[2] = 0;
        prefiltered(s, r[0], r[1], r[2], rough, E, env, 0);
        for (let k = 0; k < 3; k++) out[k] = (F0[k] * A + B) * env[k];
        // The key light: Lambert and a GGX highlight widened by its size.
        const nl = n[0] * L[0] + n[1] * L[1] + n[2] * L[2];
        if (nl > 0) {
          const hx = L[0] - d[0], hy = L[1] - d[1], hz = L[2] - d[2], hl = Math.hypot(hx, hy, hz);
          const nh = Math.max(0, (n[0] * hx + n[1] * hy + n[2] * hz) / hl), vh = Math.max(0, -(d[0] * hx + d[1] * hy + d[2] * hz) / hl);
          const al = rough * rough, a2 = al * al, aL = Math.min(1, al + 0.5 * Math.tan(theta)), aL2 = aL * aL;
          const dd = nh * nh * (aL2 - 1) + 1, D = aL2 / (Math.PI * dd * dd);
          const vis = 0.5 / (nl * Math.sqrt(nv * nv * (1 - a2) + a2) + nv * Math.sqrt(nl * nl * (1 - a2) + a2));
          const fw = Math.pow(1 - vh, 5);
          for (let k = 0; k < 3; k++) {
            const F = F0[k] + (1 - F0[k]) * fw;
            out[k] += KEY * nl * ((metal ? 0 : base[k] * (1 - F)) + F * D * vis * Math.PI);
          }
        }
        if (!metal) {
          irradiance(s, n[0], n[1], n[2], irr, 0);
          const kd = Math.max(0, 1 - (0.04 * A + B));
          for (let k = 0; k < 3; k++) out[k] += base[k] * irr[k] * E * kd;
        }
      }
      put(c, px, py, out[0], out[1], out[2]);
    }
  return c;
}

function blit(dst: Canvas, src: Canvas, x0: number, y0: number, scale = 1): void {
  for (let y = 0; y < src.height * scale; y++)
    for (let x = 0; x < src.width * scale; x++) {
      const o = (Math.floor(y / scale) * src.width + Math.floor(x / scale)) * 4;
      dst.set(x0 + x, y0 + y, (src.data[o] << 16) | (src.data[o + 1] << 8) | src.data[o + 2]);
    }
}

/** A perspective look at the night sky, `fov` degrees wide, the centre at azimuth `az` and elevation `el`. */
function skyView(s: EnvironmentState, size: number, az: number, el: number, fov: number): Canvas {
  const c = new Canvas(size, size, 0), v = new Float64Array(3);
  const fwd = lightDirection(az, el);
  const right = normalize([fwd[2], 0, -fwd[0]]);
  const up: Vec3 = [right[1] * fwd[2] - right[2] * fwd[1], right[2] * fwd[0] - right[0] * fwd[2], right[0] * fwd[1] - right[1] * fwd[0]];
  const f = size / 2 / Math.tan((fov * Math.PI) / 360);
  for (let py = 0; py < size; py++)
    for (let px = 0; px < size; px++) {
      const x = -(px + 0.5 - size / 2) / f, y = -(py + 0.5 - size / 2) / f;
      const d = normalize([fwd[0] + right[0] * x + up[0] * y, fwd[1] + right[1] * x + up[1] * y, fwd[2] + right[2] * x + up[2] * y]);
      skyAt(s, d[0], d[1], d[2], v, 0, BACKDROP);
      put(c, px, py, v[0], v[1], v[2]);
    }
  return c;
}

mkdirSync(OUT, { recursive: true });
const lights = [{ dir: KEY_DIR, size: 1, color: [1, 1, 1] as Vec3, power: 1 }];
for (const env of ENVIRONMENTS as Environment[]) {
  const s = buildEnvironment(env, { cameraAzimuth: CAM_AZ, key: KEY_DIR, lights });
  const W = 768, S = 256, top = 16;
  const sheet = new Canvas(W, top + W / 2 + 18 + S + 18, PAGE);
  drawText(sheet, 6, 4, `${env.toUpperCase()}  MIRROR LAT-LONG, CAMERA AZIMUTH ${CAM_AZ} (GREY TICK), KEY (YELLOW TICK)`, INKC, 1);
  blit(sheet, latLong(s, W), 0, top);
  const y1 = top + W / 2 + 4;
  drawText(sheet, 6, y1, "CHROME (F0 CHROMIUM, ROUGH 0.1)", DIM, 1);
  drawText(sheet, 6 + S, y1, "GOLD (F0 MEASURED, ROUGH 0.3)", DIM, 1);
  drawText(sheet, 6 + 2 * S, y1, `PORCELAIN (ROUGH 0.2), E ${environmentPalette(env).ambient}`, DIM, 1);
  blit(sheet, sphere(s, S, "chrome"), 0, y1 + 14);
  blit(sheet, sphere(s, S, "gold"), S, y1 + 14);
  blit(sheet, sphere(s, S, "porcelain"), 2 * S, y1 + 14);
  writeFileSync(join(OUT, `${env}.png`), sheet.toPng());
  console.log(join(OUT, `${env}.png`));
}
{
  const s = buildEnvironment("night", { cameraAzimuth: CAM_AZ, key: KEY_DIR, lights });
  const sheet = new Canvas(768, 16 + 384 + 16 + 256, PAGE);
  drawText(sheet, 6, 4, "NIGHT BACKDROP. LEFT: TOWARDS THE KEY, UP 40, FOV 60 (THE MOON). RIGHT: FAR SIDE, UP 20, FOV 30", INKC, 1);
  blit(sheet, skyView(s, 384, (Math.atan2(KEY_DIR[0], KEY_DIR[2]) * 180) / Math.PI, 40, 60), 0, 16);
  blit(sheet, skyView(s, 384, CAM_AZ + 180, 20, 30), 384, 16);
  drawText(sheet, 6, 16 + 384 + 2, "x4: 64 PX AT FOV 5 (A 384 PX, FOV 30 RENDER'S SCALE), FAR SIDE UP 50, 80 AND 89.5", DIM, 1);
  blit(sheet, skyView(s, 64, CAM_AZ + 180, 50, 5), 0, 16 + 384 + 16, 4);
  blit(sheet, skyView(s, 64, CAM_AZ + 180, 80, 5), 256, 16 + 384 + 16, 4);
  blit(sheet, skyView(s, 64, CAM_AZ + 180, 89.5, 5), 512, 16 + 384 + 16, 4);
  writeFileSync(join(OUT, "stars.png"), sheet.toPng());
  console.log(join(OUT, "stars.png"));
}
