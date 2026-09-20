/**
 * A z-buffered triangle rasteriser with per-pixel shading.
 *
 * Attributes (normal, local point, material) are interpolated
 * perspective-correctly and shaded per pixel: the procedural material is
 * sampled at the interpolated local point, so a checker or a wood grain is
 * crisp regardless of mesh density. Lighting is fixed in camera space (key
 * from the upper left front, a fill from the right, a hemisphere ambient) so
 * every view reads the same way. After the triangles, an outline pass darkens
 * pixels where depth or normal jumps, which makes edges legible in a
 * downscaled thumbnail.
 */
import type { Vec3 } from "../core/vec.js";
import { albedo } from "../sdf/materials.js";
import type { Mesh } from "../mesh/mesh.js";
import { Canvas, rgbf, type Color, rgbDithered } from "./canvas.js";
import { project, toView, toViewDir, type Camera } from "./camera.js";

export interface RenderOptions {
  background: Color;
  /** Draw dark lines at depth and normal discontinuities. Default true. */
  outline?: boolean;
  /** Ignore per-vertex materials and show everything in this colour (for the steps sheet). */
  flatColor?: Vec3;
  /** Draw glass solid rather than as a screen door: for a depth pass that primes rays, which must not see holes. */
  solidGlass?: boolean;
}

export interface RenderTarget {
  canvas: Canvas;
  depth: Float32Array;
  /** View-space normal per pixel, for the outline pass. */
  normal: Float32Array;
}

export function createTarget(width: number, height: number, background: Color): RenderTarget {
  return {
    canvas: new Canvas(width, height, background),
    depth: new Float32Array(width * height).fill(Infinity),
    normal: new Float32Array(width * height * 3),
  };
}

const KEY: Vec3 = normalize3([-0.45, 0.75, 0.6]);
const FILL: Vec3 = normalize3([0.7, 0.2, 0.5]);
const RIM: Vec3 = normalize3([0.2, -0.3, -0.9]);

function normalize3(v: Vec3): Vec3 {
  const l = Math.hypot(v[0], v[1], v[2]) || 1;
  return [v[0] / l, v[1] / l, v[2] / l];
}

/** Shade a surface point: `n` is the unit view-space normal, `base` the albedo. */
export function shade(n: Vec3, base: Vec3, metal: number, rough: number, glow = 0): Vec3 {
  const nl = Math.max(0, n[0] * KEY[0] + n[1] * KEY[1] + n[2] * KEY[2]);
  const fl = Math.max(0, n[0] * FILL[0] + n[1] * FILL[1] + n[2] * FILL[2]);
  const rl = Math.max(0, n[0] * RIM[0] + n[1] * RIM[1] + n[2] * RIM[2]);
  const hemi = 0.5 + 0.5 * n[1];
  const ambient = 0.22 + 0.16 * hemi;
  // A metal reflects its surroundings rather than scattering light; in a sheet with no environment, stand in a
  // hemisphere term for it so silver reads as silver, not charcoal (measured on a trophy's plate).
  const diffuse = (ambient + 0.72 * nl + 0.18 * fl) * (1 - metal * 0.35) + metal * (0.25 + 0.3 * hemi) * (1 - rough * 0.5);
  // Blinn highlight from the key light; the eye is +z in view space.
  const hx = KEY[0], hy = KEY[1], hz = KEY[2] + 1;
  const hl = Math.hypot(hx, hy, hz);
  const nh = Math.max(0, (n[0] * hx + n[1] * hy + n[2] * hz) / hl);
  const gloss = 1 - rough;
  const specPower = 4 + gloss * gloss * 120;
  // A matte surface gets little highlight, so cloth and plaster lit face-on stay their own colour rather than
  // saturating to white (the same sail).
  const spec = Math.pow(nh, specPower) * (0.08 + gloss * 0.6) * (0.5 + nl) * (0.35 + 0.65 * gloss);
  const rim = rl * rl * 0.12 * (1 - rough * 0.5);
  const sr = metal > 0 ? base[0] * (0.4 + 0.6 * metal) + (1 - metal) : 1;
  const sg = metal > 0 ? base[1] * (0.4 + 0.6 * metal) + (1 - metal) : 1;
  const sb = metal > 0 ? base[2] * (0.4 + 0.6 * metal) + (1 - metal) : 1;
  return [
    Math.min(1, base[0] * (diffuse + glow) + spec * sr + rim),
    Math.min(1, base[1] * (diffuse + glow) + spec * sg + rim),
    Math.min(1, base[2] * (diffuse + glow) + spec * sb + rim),
  ];
}

/** Rasterise `mesh` through `cam` into `target`. */
export function renderMesh(mesh: Mesh, cam: Camera, target: RenderTarget, opts: RenderOptions): void {
  const { canvas, depth, normal } = target;
  const W = canvas.width, H = canvas.height;
  const n = mesh.positions.length / 3;
  // Transform every vertex once.
  const sx = new Float32Array(n), sy = new Float32Array(n), sw = new Float32Array(n), sd = new Float32Array(n);
  const visible = new Uint8Array(n);
  const vn = new Float32Array(n * 3);
  for (let v = 0; v < n; v++) {
    const p = toView(cam, [mesh.positions[v * 3], mesh.positions[v * 3 + 1], mesh.positions[v * 3 + 2]]);
    const pr = project(cam, p);
    if (!pr) continue;
    visible[v] = 1;
    sx[v] = pr.x; sy[v] = pr.y; sw[v] = pr.invW; sd[v] = pr.depth;
    const nv = toViewDir(cam, [mesh.normals[v * 3], mesh.normals[v * 3 + 1], mesh.normals[v * 3 + 2]]);
    vn[v * 3] = nv[0]; vn[v * 3 + 1] = nv[1]; vn[v * 3 + 2] = nv[2];
  }
  const ix = mesh.indices;
  const local = mesh.local;
  const flat = opts.flatColor;
  const persp = cam.fov !== undefined;
  // Glass on the sheets: a material that transmits is drawn on every other pixel (a screen door), so what is behind
  // it shows through the checker and a pendulum behind a glazed door is on the pose sheet and the animation strip
  // (measured: both showed a grey pane and a clock in which nothing moved). No sorting or blending needed.
  const seeThrough = mesh.materials.map((m) => m.transmit > 0.3);
  const anyGlass = seeThrough.some(Boolean) && !flat && !opts.solidGlass;
  for (let t = 0; t < ix.length; t += 3) {
    const a = ix[t], b = ix[t + 1], c = ix[t + 2];
    if (!visible[a] || !visible[b] || !visible[c]) continue;
    const glass = anyGlass && seeThrough[mesh.materialIndex[a]];
    const ax = sx[a], ay = sy[a], bx = sx[b], by = sy[b], cx = sx[c], cy = sy[c];
    const area = (bx - ax) * (cy - ay) - (by - ay) * (cx - ax);
    if (area === 0) continue;
    // Screen y points down, so a counter-clockwise (outward) triangle has negative area here.
    if (area > 0) continue;
    const minX = Math.max(0, Math.floor(Math.min(ax, bx, cx))), maxX = Math.min(W - 1, Math.ceil(Math.max(ax, bx, cx)));
    const minY = Math.max(0, Math.floor(Math.min(ay, by, cy))), maxY = Math.min(H - 1, Math.ceil(Math.max(ay, by, cy)));
    if (minX > maxX || minY > maxY) continue;
    const invArea = 1 / area;
    const wa = sw[a], wb = sw[b], wc = sw[c];
    for (let py = minY; py <= maxY; py++) {
      const yy = py + 0.5;
      for (let px = minX; px <= maxX; px++) {
        const xx = px + 0.5;
        let w0 = ((bx - xx) * (cy - yy) - (by - yy) * (cx - xx)) * invArea;
        let w1 = ((cx - xx) * (ay - yy) - (cy - yy) * (ax - xx)) * invArea;
        let w2 = 1 - w0 - w1;
        if (w0 < 0 || w1 < 0 || w2 < 0) continue;
        if (glass && ((px + py) & 1)) continue;
        // Perspective-correct weights; an orthographic camera has invW = 1 and linear depth.
        const pw0 = w0 * wa, pw1 = w1 * wb, pw2 = w2 * wc;
        const psum = pw0 + pw1 + pw2;
        const z = persp ? 1 / psum : sd[a] * w0 + sd[b] * w1 + sd[c] * w2;
        const di = py * W + px;
        if (z >= depth[di]) continue;
        depth[di] = z;
        w0 = pw0 / psum; w1 = pw1 / psum; w2 = pw2 / psum;
        let nx = vn[a * 3] * w0 + vn[b * 3] * w1 + vn[c * 3] * w2;
        let ny = vn[a * 3 + 1] * w0 + vn[b * 3 + 1] * w1 + vn[c * 3 + 1] * w2;
        let nz = vn[a * 3 + 2] * w0 + vn[b * 3 + 2] * w1 + vn[c * 3 + 2] * w2;
        const nl = Math.hypot(nx, ny, nz) || 1;
        nx /= nl; ny /= nl; nz /= nl;
        normal[di * 3] = nx; normal[di * 3 + 1] = ny; normal[di * 3 + 2] = nz;
        const nearest = w0 >= w1 && w0 >= w2 ? a : w1 >= w2 ? b : c;
        const mat = mesh.materials[mesh.materialIndex[nearest]];
        let base: Vec3;
        if (flat) base = flat;
        else {
          const lx = local[a * 3] * w0 + local[b * 3] * w1 + local[c * 3] * w2;
          const ly = local[a * 3 + 1] * w0 + local[b * 3 + 1] * w1 + local[c * 3 + 1] * w2;
          const lz = local[a * 3 + 2] * w0 + local[b * 3 + 2] * w1 + local[c * 3 + 2] * w2;
          base = albedo(mat, lx, ly, lz);
        }
        const col = shade([nx, ny, nz], base, flat ? 0 : mat.metal, flat ? 0.6 : mat.rough, flat ? 0 : mat.glow);
        canvas.set(px, py, rgbDithered(col[0], col[1], col[2], px, py));
      }
    }
  }
  if (opts.outline !== false) outline(target);
}

/** Darken pixels whose depth or normal differs sharply from a neighbour. */
function outline(target: RenderTarget): void {
  const { canvas, depth, normal } = target;
  const W = canvas.width, H = canvas.height;
  let near = Infinity, far = 0;
  for (let i = 0; i < depth.length; i++) if (Number.isFinite(depth[i])) { near = Math.min(near, depth[i]); far = Math.max(far, depth[i]); }
  if (!Number.isFinite(near)) return;
  const range = Math.max(far - near, 1e-6);
  const marks = new Uint8Array(W * H);
  for (let y = 0; y < H; y++)
    for (let x = 0; x < W; x++) {
      const i = y * W + x;
      const d = depth[i];
      const nb = [x + 1 < W ? i + 1 : -1, y + 1 < H ? i + W : -1, x > 0 ? i - 1 : -1, y > 0 ? i - W : -1];
      let mark = 0;
      // A feature one or two pixels wide (a blade edge-on in a strip) has background on both sides: a full outline
      // would paint it black, so it keeps the light one (round 8: a chrome blade read as black at 35 degrees).
      const thin = Number.isFinite(d) && ((x + 1 < W && x > 0 && !Number.isFinite(depth[i + 1]) && !Number.isFinite(depth[i - 1])) || (y + 1 < H && y > 0 && !Number.isFinite(depth[i + W]) && !Number.isFinite(depth[i - W])));
      for (const j of nb) {
        if (j < 0) continue;
        const dj = depth[j];
        const a = Number.isFinite(d), b = Number.isFinite(dj);
        if (a !== b) { mark = thin ? 1 : 2; break; }
        if (!a) continue;
        if (Math.abs(d - dj) > range * 0.04) { mark = 2; break; }
        const dotp = normal[i * 3] * normal[j * 3] + normal[i * 3 + 1] * normal[j * 3 + 1] + normal[i * 3 + 2] * normal[j * 3 + 2];
        if (dotp < 0.55) mark = 1;
      }
      marks[i] = mark;
    }
  for (let y = 0; y < H; y++)
    for (let x = 0; x < W; x++) {
      const m = marks[y * W + x];
      if (m === 2) canvas.blend(x, y, 0x1a1a20, 0.75);
      else if (m === 1) canvas.blend(x, y, 0x1a1a20, 0.35);
    }
}

/**
 * Draw a mesh as a ghost: its front-most surface blended faintly over what is already drawn, wherever it is in front
 * of it by more than `margin` (world units), with a faint line at its own silhouette. It writes no depth, so what was
 * drawn before shows through it. A focus sheet draws the rest of the model this way, so a neighbour the frame clips
 * reads as context rather than as an unknown slab (round 7: a drone's body over its gimbal was read as a plate).
 */
export function renderGhost(mesh: Mesh, cam: Camera, target: RenderTarget, opts: { alpha?: number; margin?: number } = {}): void {
  const { canvas, depth } = target;
  const alpha = opts.alpha ?? 0.28, margin = opts.margin ?? 0;
  const W = canvas.width, H = canvas.height;
  const n = mesh.positions.length / 3;
  const sx = new Float32Array(n), sy = new Float32Array(n), sw = new Float32Array(n), sd = new Float32Array(n);
  const visible = new Uint8Array(n);
  const vn = new Float32Array(n * 3);
  for (let v = 0; v < n; v++) {
    const p = toView(cam, [mesh.positions[v * 3], mesh.positions[v * 3 + 1], mesh.positions[v * 3 + 2]]);
    const pr = project(cam, p);
    if (!pr) continue;
    visible[v] = 1;
    sx[v] = pr.x; sy[v] = pr.y; sw[v] = pr.invW; sd[v] = pr.depth;
    const nv = toViewDir(cam, [mesh.normals[v * 3], mesh.normals[v * 3 + 1], mesh.normals[v * 3 + 2]]);
    vn[v * 3] = nv[0]; vn[v * 3 + 1] = nv[1]; vn[v * 3 + 2] = nv[2];
  }
  // The ghost's own nearest surface per pixel, and its shade there.
  const gd = new Float32Array(W * H).fill(Infinity);
  const gc = new Uint32Array(W * H);
  const ix = mesh.indices;
  const persp = cam.fov !== undefined;
  for (let t = 0; t < ix.length; t += 3) {
    const a = ix[t], b = ix[t + 1], c = ix[t + 2];
    if (!visible[a] || !visible[b] || !visible[c]) continue;
    const ax = sx[a], ay = sy[a], bx = sx[b], by = sy[b], cx = sx[c], cy = sy[c];
    const area = (bx - ax) * (cy - ay) - (by - ay) * (cx - ax);
    if (area >= 0) continue;
    const minX = Math.max(0, Math.floor(Math.min(ax, bx, cx))), maxX = Math.min(W - 1, Math.ceil(Math.max(ax, bx, cx)));
    const minY = Math.max(0, Math.floor(Math.min(ay, by, cy))), maxY = Math.min(H - 1, Math.ceil(Math.max(ay, by, cy)));
    if (minX > maxX || minY > maxY) continue;
    const invArea = 1 / area;
    const wa = sw[a], wb = sw[b], wc = sw[c];
    for (let py = minY; py <= maxY; py++) {
      const yy = py + 0.5;
      for (let px = minX; px <= maxX; px++) {
        const xx = px + 0.5;
        let w0 = ((bx - xx) * (cy - yy) - (by - yy) * (cx - xx)) * invArea;
        let w1 = ((cx - xx) * (ay - yy) - (cy - yy) * (ax - xx)) * invArea;
        let w2 = 1 - w0 - w1;
        if (w0 < 0 || w1 < 0 || w2 < 0) continue;
        const pw0 = w0 * wa, pw1 = w1 * wb, pw2 = w2 * wc;
        const psum = pw0 + pw1 + pw2;
        const z = persp ? 1 / psum : sd[a] * w0 + sd[b] * w1 + sd[c] * w2;
        const di = py * W + px;
        if (z >= gd[di]) continue;
        gd[di] = z;
        w0 = pw0 / psum; w1 = pw1 / psum; w2 = pw2 / psum;
        let nx = vn[a * 3] * w0 + vn[b * 3] * w1 + vn[c * 3] * w2;
        let ny = vn[a * 3 + 1] * w0 + vn[b * 3 + 1] * w1 + vn[c * 3 + 1] * w2;
        let nz = vn[a * 3 + 2] * w0 + vn[b * 3 + 2] * w1 + vn[c * 3 + 2] * w2;
        const nl = Math.hypot(nx, ny, nz) || 1;
        nx /= nl; ny /= nl; nz /= nl;
        // A ghost keeps its material's colour, washed towards grey, so a painted neighbour is still recognisable.
        const nearest = w0 >= w1 && w0 >= w2 ? a : w1 >= w2 ? b : c;
        const mat = mesh.materials[mesh.materialIndex[nearest]];
        const lx = mesh.local[a * 3] * w0 + mesh.local[b * 3] * w1 + mesh.local[c * 3] * w2;
        const ly = mesh.local[a * 3 + 1] * w0 + mesh.local[b * 3 + 1] * w1 + mesh.local[c * 3 + 1] * w2;
        const lz = mesh.local[a * 3 + 2] * w0 + mesh.local[b * 3 + 2] * w1 + mesh.local[c * 3 + 2] * w2;
        const base = albedo(mat, lx, ly, lz);
        const col = shade([nx, ny, nz], [base[0] * 0.5 + 0.35, base[1] * 0.5 + 0.35, base[2] * 0.5 + 0.35], 0, 0.7, 0);
        gc[di] = rgbf(col[0], col[1], col[2]);
      }
    }
  }
  // In front of what is drawn by more than the margin: coincident surfaces belong to the solid part, not the ghost.
  const drawn = new Uint8Array(W * H);
  for (let i = 0; i < W * H; i++) {
    if (!Number.isFinite(gd[i])) continue;
    if (Number.isFinite(depth[i]) && gd[i] >= depth[i] - margin) continue;
    drawn[i] = 1;
  }
  for (let y = 0; y < H; y++)
    for (let x = 0; x < W; x++) {
      const i = y * W + x;
      if (!drawn[i]) continue;
      canvas.blend(x, y, gc[i], alpha);
    }
  // The silhouette: a drawn pixel next to one the ghost does not cover, so the ghost has an edge to read.
  for (let y = 0; y < H; y++)
    for (let x = 0; x < W; x++) {
      const i = y * W + x;
      if (!drawn[i]) continue;
      const edge = (x + 1 < W && !drawn[i + 1]) || (x > 0 && !drawn[i - 1]) || (y + 1 < H && !drawn[i + W]) || (y > 0 && !drawn[i - W]);
      if (edge) canvas.blend(x, y, 0x1a1a20, alpha * 0.9);
    }
}

/** A world-space line segment, depth-tested against what is already drawn. */
export function renderLine(cam: Camera, target: RenderTarget, a: Vec3, b: Vec3, color: Color, alpha = 1, bias = 0.002): void {
  const steps = 64;
  const { canvas, depth } = target;
  let prev: { x: number; y: number; d: number } | undefined;
  for (let i = 0; i <= steps; i++) {
    const t = i / steps;
    const p: Vec3 = [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t];
    const pr = project(cam, toView(cam, p));
    if (!pr) { prev = undefined; continue; }
    const cur = { x: pr.x, y: pr.y, d: pr.depth };
    if (prev) {
      // Plot the short segment pixel by pixel with a depth test.
      const dx = cur.x - prev.x, dy = cur.y - prev.y;
      const len = Math.max(1, Math.ceil(Math.max(Math.abs(dx), Math.abs(dy))));
      for (let k = 0; k <= len; k++) {
        const u = k / len;
        const px = Math.round(prev.x + dx * u), py = Math.round(prev.y + dy * u);
        if (px < 0 || py < 0 || px >= canvas.width || py >= canvas.height) continue;
        const d = prev.d + (cur.d - prev.d) * u;
        if (d - bias * d > depth[py * canvas.width + px]) continue;
        canvas.blend(px, py, color, alpha);
      }
    }
    prev = cur;
  }
}
