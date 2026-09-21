/**
 * The pictures an agent looks at. Each is a Canvas with its labels baked in,
 * so a PNG on its own says what it is, which view it is and what scale it is.
 *
 *   sheet     the 2x2 contact sheet: perspective, front, right, top
 *   slices    three cross-sections straight from the distance field
 *   steps     one thumbnail per named step, in program order
 *   turntable eight perspective frames around the model
 */
import type { Vec3 } from "../core/vec.js";
import { albedo } from "../sdf/materials.js";
import { boundsCenter, boundsSize, isEmpty, REST_POSE, type Bounds, type JointPose, type Shape3 } from "../sdf/types.js";
import { surfaceNets } from "../mesh/surfaceNets.js";
import { meshBounds, triangleCount, type Mesh } from "../mesh/mesh.js";
import { orthographic, perspective, project, toView, type Camera, type OrthoView } from "./camera.js";
import { Canvas, mixColor, rgbf, type Color } from "./canvas.js";
import { drawText, textWidth } from "./font.js";
import { createTarget, renderGhost, renderLine, renderMesh, type RenderTarget } from "./raster.js";

export const INK = {
  page: 0xf4f2ee,
  // The views' grounds sit well below white, so a white or ivory part lit face-on is not the background's value
  // (measured: a sail in cream cloth read as absent on a sheet, and cost its author nine renders).
  view: 0xe0ddd6,
  viewPersp: 0xd6d9df,
  grid: 0xcdc9bf,
  gridMajor: 0xb3afa4,
  axisX: 0xc8342a,
  axisY: 0x3f9a45,
  axisZ: 0x2f66c4,
  text: 0x2a2a2e,
  dim: 0x7a7a80,
  bar: 0x2a2a2e,
  barText: 0xf4f2ee,
  warn: 0xb0402a,
};

export type ViewName = "persp" | OrthoView;

export interface ViewInfo {
  name: string;
  bounds: Bounds;
  /** Perspective camera direction, degrees; defaults 35 and 25. */
  azimuth?: number;
  elevation?: number;
}

const fmt = (v: number): string => { const t = (Math.abs(v) >= 100 ? v.toFixed(0) : Math.abs(v) >= 10 ? v.toFixed(1) : Math.abs(v) < 0.1 && Math.abs(v) >= 0.005 ? String(Number(v.toPrecision(2))) : v.toFixed(2)).replace(/(\.\d*?)0+$/, "$1").replace(/\.$/, "") || "0"; return t === "-0" ? "0" : t; };

/** A cell size to three significant figures, so 0.007 and 0.014 do not both read 0.01. */
export function fmtCell(v: number): string {
  if (!(v > 0)) return "0";
  const digits = Math.max(0, 2 - Math.floor(Math.log10(v)));
  return v.toFixed(Math.min(6, digits)).replace(/\.?0+$/, "");
}

export function dimsLabel(b: Bounds): string {
  const s = boundsSize(b);
  return `${fmt(s[0])} × ${fmt(s[1])} × ${fmt(s[2])}`;
}

/** Pick a grid spacing that gives a readable number of lines across `span` units. */
export function gridStep(span: number): number {
  const candidates = [0.01, 0.02, 0.05, 0.1, 0.2, 0.25, 0.5, 1, 2, 5, 10, 20, 50, 100, 200, 500, 1000];
  for (const c of candidates) if (span / c <= 24) return c;
  return 1000;
}

function axisOf(v: Vec3): { index: number; sign: number } {
  let index = 0;
  for (let i = 1; i < 3; i++) if (Math.abs(v[i]) > Math.abs(v[index])) index = i;
  return { index, sign: Math.sign(v[index]) || 1 };
}

const AXIS_NAMES = ["x", "y", "z"];

/** Draw a unit grid behind an orthographic view, with the axes through the origin emphasised. */
function orthoGrid(cam: Camera, canvas: Canvas): { step: number } {
  const upp = cam.unitsPerPixel ?? 1;
  const h = axisOf(cam.right), v = axisOf(cam.up);
  const spanX = canvas.width * upp, spanY = canvas.height * upp;
  const step = gridStep(Math.max(spanX, spanY));
  const eyeH = cam.eye[h.index], eyeV = cam.eye[v.index];
  const cx = canvas.width / 2, cy = canvas.height / 2;
  const toScreenX = (world: number) => cx + ((world - eyeH) * h.sign) / upp;
  const toScreenY = (world: number) => cy - ((world - eyeV) * v.sign) / upp;
  const minH = eyeH - (spanX / 2) - step, maxH = eyeH + spanX / 2 + step;
  const minV = eyeV - (spanY / 2) - step, maxV = eyeV + spanY / 2 + step;
  for (let w = Math.floor(minH / step) * step; w <= maxH; w += step) {
    const x = Math.round(toScreenX(w));
    const major = Math.abs(w) < step * 1e-6;
    canvas.fill(x, 0, 1, canvas.height, major ? INK.gridMajor : INK.grid);
  }
  for (let w = Math.floor(minV / step) * step; w <= maxV; w += step) {
    const y = Math.round(toScreenY(w));
    const major = Math.abs(w) < step * 1e-6;
    canvas.fill(0, y, canvas.width, 1, major ? INK.gridMajor : INK.grid);
  }
  return { step };
}

function caption(canvas: Canvas, text: string, sub?: string, note?: string): void {
  const w = textWidth(text, 2) + 12;
  canvas.fill(6, 6, w, 20, INK.bar);
  drawText(canvas, 12, 9, text, INK.barText, 2);
  if (sub) drawText(canvas, 12, 30, sub, INK.dim, 1);
  if (note) drawText(canvas, 12, 42, note, INK.dim, 1);
}

/** Render one view of a mesh at `size` pixels square. */
export interface ViewOptions {
  flatColor?: Vec3;
  outline?: boolean;
  label?: boolean;
  azimuth?: number;
  elevation?: number;
  /** A second mesh drawn faint and see-through over the first: a focus sheet's neighbours, clipped to the frame. */
  ghost?: Mesh;
  /** How far in front of the solid mesh a ghost surface must be to be drawn, in world units (about a cell). */
  ghostMargin?: number;
  /** The points the perspective camera fits, instead of this mesh's own: every frame of a strip, so the camera holds still. */
  fitPoints?: Float32Array;
  /** Receives the render target (depth per pixel) and the camera, for a caller that draws over the view. */
  capture?: (target: RenderTarget, cam: Camera) => void;
}

/** The ghost's note under a view's caption, so a faint slab is read as a clipped neighbour and not a part. */
export const GHOST_NOTE = "faint: the rest of the model, clipped to this frame";

/** Render one view of a mesh at `size` pixels square. */
export function renderView(mesh: Mesh, info: ViewInfo, view: ViewName, size: number, opts: ViewOptions = {}): Canvas {
  const bounds = isEmpty(info.bounds) ? { min: [-1, -1, -1] as Vec3, max: [1, 1, 1] as Vec3 } : info.bounds;
  const label = opts.label ?? true;
  const ghost = opts.ghost && triangleCount(opts.ghost) > 0 ? opts.ghost : undefined;
  if (view === "persp") {
    const az = opts.azimuth ?? info.azimuth ?? 35, el = opts.elevation ?? info.elevation ?? 25;
    const cam = perspective(bounds, size, size, az, el, 30, 1, opts.fitPoints ?? mesh.positions);
    const target = createTarget(size, size, INK.viewPersp);
    renderMesh(mesh, cam, target, { background: INK.viewPersp, outline: opts.outline, flatColor: opts.flatColor });
    floorGrid(cam, target, bounds, label);
    if (ghost) renderGhost(ghost, cam, target, { margin: opts.ghostMargin });
    if (label) caption(target.canvas, "PERSPECTIVE", `azimuth ${fmt(az)}° elevation ${fmt(el)}°  ${dimsLabel(info.bounds)}`, ghost ? GHOST_NOTE : undefined);
    opts.capture?.(target, cam);
    return target.canvas;
  }
  const cam = orthographic(bounds, size, size, view);
  const target = createTarget(size, size, INK.view);
  const { step } = orthoGrid(cam, target.canvas);
  renderMesh(mesh, cam, target, { background: INK.view, outline: opts.outline, flatColor: opts.flatColor });
  if (ghost) renderGhost(ghost, cam, target, { margin: opts.ghostMargin });
  if (label) {
    const h = axisOf(cam.right), v = axisOf(cam.up);
    const hs = `${h.sign < 0 ? "-" : ""}${AXIS_NAMES[h.index]}→`;
    const vs = `${v.sign < 0 ? "-" : ""}${AXIS_NAMES[v.index]}↑`;
    caption(target.canvas, view.toUpperCase(), `${hs} ${vs}  grid ${fmt(step)}`, ghost ? GHOST_NOTE : undefined);
  }
  return target.canvas;
}

/** A grid on the ground plane and short axis arrows at the origin, under a perspective camera. */
function floorGrid(cam: Camera, target: RenderTarget, bounds: Bounds, label = true): void {
  const size = boundsSize(bounds);
  const span = Math.max(size[0], size[2], 1e-3);
  const step = gridStep(span * 2);
  const y = Math.min(0, bounds.min[1]);
  const c = boundsCenter(bounds);
  const half = Math.ceil((span * 0.9) / step) * step;
  const x0 = Math.floor((c[0] - half) / step) * step, x1 = Math.ceil((c[0] + half) / step) * step;
  const z0 = Math.floor((c[2] - half) / step) * step, z1 = Math.ceil((c[2] + half) / step) * step;
  for (let x = x0; x <= x1 + 1e-9; x += step) renderLine(cam, target, [x, y, z0], [x, y, z1], Math.abs(x) < 1e-9 ? INK.gridMajor : INK.grid, 0.9);
  for (let z = z0; z <= z1 + 1e-9; z += step) renderLine(cam, target, [x0, y, z], [x1, y, z], Math.abs(z) < 1e-9 ? INK.gridMajor : INK.grid, 0.9);
  const len = Math.max(size[0], size[1], size[2]) * 0.3;
  renderLine(cam, target, [0, y, 0], [len, y, 0], INK.axisX, 0.9);
  renderLine(cam, target, [0, y, 0], [0, y + len, 0], INK.axisY, 0.9);
  renderLine(cam, target, [0, y, 0], [0, y, len], INK.axisZ, 0.9);
  const tip = (p: Vec3, text: string, color: Color) => {
    const pr = project(cam, toView(cam, p));
    if (pr) drawText(target.canvas, Math.round(pr.x) + 3, Math.round(pr.y) - 3, text, color, 1);
  };
  tip([len, y, 0], "x", INK.axisX);
  tip([0, y + len, 0], "y", INK.axisY);
  tip([0, y, len], "z", INK.axisZ);
  if (label) drawText(target.canvas, 8, target.canvas.height - 12, `floor grid ${fmt(step)} at y=${fmt(y)}`, INK.dim, 1);
}

export interface SheetInfo extends ViewInfo {
  triangles: number;
  cellSize: number;
  warnings: number;
}

/** The 2x2 contact sheet with a title bar. */
export function renderSheet(mesh: Mesh, info: SheetInfo, size: number, ghost?: Mesh, ghostMargin?: number): Canvas {
  const gutter = 4, bar = 30;
  const sheet = new Canvas(size * 2 + gutter * 3, size * 2 + gutter * 3 + bar, INK.page);
  sheet.fill(0, 0, sheet.width, bar, INK.bar);
  const title = `${info.name.toUpperCase()}   ${dimsLabel(info.bounds)} units   ${info.triangles} tris   cell ${fmtCell(info.cellSize)}`;
  const w = info.warnings > 0 ? `${info.warnings} warning${info.warnings === 1 ? "" : "s"} in report.md` : "";
  // The title at 2x, the warning right-aligned; when they would collide (a small sheet), both at 1x.
  const scale = textWidth(title, 2) + textWidth(w, 2) + 30 <= sheet.width ? 2 : 1;
  drawText(sheet, 10, scale === 2 ? 8 : 11, title, INK.barText, scale);
  if (w) drawText(sheet, sheet.width - textWidth(w, scale) - 10, scale === 2 ? 8 : 11, w, 0xf0a060, scale);
  const views: ViewName[] = ["persp", "front", "right", "top"];
  views.forEach((v, i) => {
    const c = renderView(mesh, info, v, size, { ghost, ghostMargin });
    sheet.blit(c, gutter + (i % 2) * (size + gutter), bar + gutter + Math.floor(i / 2) * (size + gutter));
  });
  return sheet;
}

/**
 * Where to slice by default: through the origin on x and z when the model
 * straddles it (models are usually built around their own axis, and the
 * bounds centre drifts with a handle or a spout), otherwise through the
 * bounds centre; always the centre on y, since a grounded model's y = 0 is
 * its underside.
 */
export function defaultLevel(b: Bounds, axis: "x" | "y" | "z"): number {
  const i = "xyz".indexOf(axis);
  const c = boundsCenter(b);
  if (axis === "y") return c[1];
  const s = boundsSize(b)[i];
  return b.min[i] < -s * 0.05 && b.max[i] > s * 0.05 ? 0 : c[i];
}

/**
 * Three cross-sections, coloured from the field itself; `at` overrides the plane per axis. With a `ghost` (a focus
 * sheet's whole model), the cut through it is drawn faint around the cut through `shape`, the focused part.
 */
export function renderSlices(shape: Shape3, info: ViewInfo, size: number, at?: Partial<Record<"x" | "y" | "z", number>>, ghost?: Shape3): Canvas {
  const gutter = 4, bar = 30;
  const out = new Canvas(size * 3 + gutter * 4, size + gutter * 2 + bar, INK.page);
  out.fill(0, 0, out.width, bar, INK.bar);
  drawText(out, 10, 8, `${info.name.toUpperCase()}   CROSS-SECTIONS   inside is filled, the outline is the surface${ghost ? ", the rest of the model faint" : ""}`, INK.barText, 2);
  const b = isEmpty(info.bounds) ? { min: [-1, -1, -1] as Vec3, max: [1, 1, 1] as Vec3 } : info.bounds;
  const c = boundsCenter(b);
  const s = boundsSize(b);
  const planes: { axis: "x" | "y" | "z"; h: number; v: number; vSign: number; label: string }[] = [
    { axis: "x", h: 2, v: 1, vSign: 1, label: "-z→ y↑" }, // seen from +x: screen right is -z
    { axis: "y", h: 0, v: 2, vSign: -1, label: "x→ -z↑" }, // seen from above: up is -z
    { axis: "z", h: 0, v: 1, vSign: 1, label: "x→ y↑" }, // seen from +z
  ];
  planes.forEach((pl, i) => {
    const canvas = new Canvas(size, size, INK.view);
    const level = at?.[pl.axis] ?? defaultLevel(b, pl.axis);
    // Each cut is framed on its own two axes (round 8: a long flat tool's end cut was a sliver at the long side's span).
    const span = Math.max(s[pl.h], s[pl.v], 1e-6) * 1.15;
    const upp = span / size;
    const step = gridStep(span);
    const hSign = pl.axis === "x" ? -1 : 1;
    // Grid.
    for (let w = Math.floor((c[pl.h] - span) / step) * step; w <= c[pl.h] + span; w += step) {
      const x = Math.round(size / 2 + ((w - c[pl.h]) * hSign) / upp);
      canvas.fill(x, 0, 1, size, Math.abs(w) < 1e-9 ? INK.gridMajor : INK.grid);
    }
    for (let w = Math.floor((c[pl.v] - span) / step) * step; w <= c[pl.v] + span; w += step) {
      const y = Math.round(size / 2 - ((w - c[pl.v]) * pl.vSign) / upp);
      canvas.fill(0, y, size, 1, Math.abs(w) < 1e-9 ? INK.gridMajor : INK.grid);
    }
    const p: Vec3 = [0, 0, 0];
    for (let py = 0; py < size; py++)
      for (let px = 0; px < size; px++) {
        p[pl.h] = c[pl.h] + (px + 0.5 - size / 2) * upp * hSign;
        p[pl.v] = c[pl.v] - (py + 0.5 - size / 2) * upp * pl.vSign;
        p["xyz".indexOf(pl.axis)] = level;
        const d = shape.dist(p[0], p[1], p[2]);
        if (d < -upp * 0.75) {
          const h = shape.hit(p[0], p[1], p[2]);
          const col = albedo(h.mat, h.lx, h.ly, h.lz);
          canvas.set(px, py, rgbf(col[0] * 0.8 + 0.05, col[1] * 0.8 + 0.05, col[2] * 0.8 + 0.05));
        } else if (d < upp * 0.75) {
          canvas.set(px, py, INK.text);
        } else if (ghost) {
          const g = ghost.dist(p[0], p[1], p[2]);
          if (g < -upp * 0.75) {
            const h = ghost.hit(p[0], p[1], p[2]);
            const col = albedo(h.mat, h.lx, h.ly, h.lz);
            canvas.set(px, py, mixColor(canvas.get(px, py), rgbf(col[0] * 0.8 + 0.05, col[1] * 0.8 + 0.05, col[2] * 0.8 + 0.05), 0.3));
          } else if (g < upp * 0.75) canvas.set(px, py, mixColor(canvas.get(px, py), INK.text, 0.4));
        }
      }
    caption(canvas, `${pl.axis.toUpperCase()} = ${fmt(level)}`, `${pl.label}  grid ${fmt(step)}`, ghost ? GHOST_NOTE : undefined);
    out.blit(canvas, gutter + i * (size + gutter), bar + gutter);
  });
  return out;
}

export interface StepView {
  name: string;
  shape: Shape3;
  used: boolean;
  /** part, cut or region; undefined for a step the output never reads. */
  role?: "part" | "cut" | "mask" | "region";
  line: number;
  /** The step's mesh, if already extracted; otherwise it is extracted here. */
  mesh?: Mesh;
  /** True when the step was meshed at a coarser cell than the output, so a missing surface proves nothing. */
  coarse?: boolean;
}

/**
 * Extract a mesh for each step at the output's cell size, so a step that
 * has no surface here has none in the output either; capped at
 * `maxResolution` cells to keep a big step cheap, and marked `coarse` when
 * the cap made the cell larger than the output's.
 */
export function meshSteps(steps: StepView[], cellSize = 0, maxResolution = 96, output?: { shape: Shape3; mesh: Mesh }): StepView[] {
  return steps.map((st) => {
    if (st.mesh || isEmpty(st.shape.bounds)) return st;
    if (output && st.shape === output.shape) return { ...st, mesh: output.mesh, coarse: false };
    const s = boundsSize(st.shape.bounds);
    const longest = Math.max(s[0], s[1], s[2]);
    const thinnest = Math.min(s[0], s[1], s[2]);
    // Enough cells for the output's cell size, and at least three across the thinnest dimension, so a
    // small part in a wide array (bolts along a bench) still draws; capped so a huge step stays cheap.
    const wanted = Math.max(cellSize > 0 ? Math.ceil(longest / cellSize) : 48, thinnest > 0 ? Math.ceil((longest / thinnest) * 3) : 0);
    const resolution = Math.max(16, Math.min(maxResolution, wanted));
    return { ...st, mesh: surfaceNets(st.shape, { resolution }).mesh, coarse: wanted > maxResolution };
  });
}

/** One perspective thumbnail per step, five per row, labelled with the name and size. */
export function renderSteps(steps: StepView[], thumb: number, resolution = 48): Canvas {
  const cols = Math.min(5, Math.max(1, steps.length));
  const rows = Math.max(1, Math.ceil(steps.length / cols));
  const labelH = 24, gutter = 6, bar = 30;
  const out = new Canvas(cols * (thumb + gutter) + gutter, bar + rows * (thumb + labelH + gutter) + gutter, INK.page);
  out.fill(0, 0, out.width, bar, INK.bar);
  drawText(out, 10, 8, `BUILD STEPS   ${steps.length} named shape${steps.length === 1 ? "" : "s"} in program order`, INK.barText, 2);
  steps.forEach((st, i) => {
    const x = gutter + (i % cols) * (thumb + gutter);
    const y = bar + gutter + Math.floor(i / cols) * (thumb + labelH + gutter);
    let canvas: Canvas;
    if (isEmpty(st.shape.bounds)) {
      canvas = new Canvas(thumb, thumb, INK.viewPersp);
      drawText(canvas, 8, thumb / 2 - 4, "EMPTY", INK.warn, 1);
    } else {
      const mesh = st.mesh ?? surfaceNets(st.shape, { resolution }).mesh;
      canvas = renderView(mesh, { name: st.name, bounds: st.shape.bounds }, "persp", thumb, { label: false });
      if (triangleCount(mesh) === 0) {
        // Coarse means the thumbnail's grid, not the model, lost it: say so in grey, not in the warning colour.
        if (st.coarse) drawText(canvas, 8, thumb / 2 - 4, "TOO FINE FOR THIS THUMBNAIL", INK.dim, 1);
        else drawText(canvas, 8, thumb / 2 - 4, "NO SURFACE", INK.warn, 1);
      }
    }
    // A red frame is a step the output never reads; a region (an assert's, a decal's, a camera's) is framed grey
    // and said so; a cutter is tagged, since the sheet draws it as the solid it subtracts (round 9 asked for both).
    const region = st.role === "region";
    if (!st.used && !region) canvas.rect(0, 0, thumb, thumb, INK.warn);
    if (region) canvas.rect(0, 0, thumb, thumb, INK.dim);
    out.blit(canvas, x, y);
    const name = `${i + 1}. ${st.name}`;
    drawText(out, x, y + thumb + 3, name.length > thumb / 6 ? name.slice(0, Math.floor(thumb / 6) - 1) + "…" : name, st.used || region ? INK.text : INK.warn, 1);
    const tag = st.role === "cut" ? "  cut" : st.role === "mask" ? "  mask" : region ? "  region" : st.used ? "" : "  unused";
    drawText(out, x, y + thumb + 13, isEmpty(st.shape.bounds) ? "empty" : dimsLabel(st.shape.bounds) + tag, INK.dim, 1);
  });
  return out;
}

/** Eight frames around the model at a fixed distance, so it never jumps between frames. */
export function renderTurntable(mesh: Mesh, info: ViewInfo, frame: number, frames = 8): Canvas {
  const gutter = 4, bar = 24;
  const out = new Canvas(frames * (frame + gutter) + gutter, frame + gutter * 2 + bar, INK.page);
  out.fill(0, 0, out.width, bar, INK.bar);
  drawText(out, 10, 6, `${info.name.toUpperCase()}   TURNTABLE   ${360 / frames}° steps, from the front-right`, INK.barText, 2);
  for (let i = 0; i < frames; i++) {
    const az = (info.azimuth ?? 35) + (360 / frames) * i;
    const c = renderView(mesh, info, "persp", frame, { azimuth: az, label: false });
    drawText(c, 6, 6, `${Math.round(az % 360)}°`, INK.dim, 1);
    out.blit(c, gutter + i * (frame + gutter), bar + gutter);
  }
  return out;
}

export { mixColor };

// --- poses and animations ------------------------------------------------------

export interface PoseView {
  name: string;
  /** Per joint: angles, move and scale; a joint not named is at rest. */
  joints: Record<string, JointPose>;
}

/** How an animation runs between its keyframe poses: absolute times per pose, and how much to ease at each. */
export interface Timing {
  /** One time in seconds per key, ascending from 0; evenly spaced when absent. */
  times?: number[];
  /** 0 is linear; 1 slows to a stop at every key (a cosine blend). */
  ease?: number;
  /** The ease at the first and last key alone; `ease` when absent. */
  easeEnds?: number;
  /** Whether the animation loops, for the strip's bar; a one-shot says ONCE. */
  loop?: boolean;
}

export type ShapeAt = (joints: Record<string, JointPose>) => Shape3 | undefined;

/**
 * Meshes already made for a pose in this render, keyed by the pose's values and the cell. A pose sheet and every
 * strip share one, so the rest pose (REST, then SHUT, then CRANK_FULL) and a held key (five identical frames of a
 * pop) are meshed once (measured, round 7: 60 of 82 seconds of a full render went to re-meshing the same poses).
 */
export type PoseCache = Map<string, Mesh | undefined>;

function poseKey(joints: Record<string, JointPose>, cellSize: number): string {
  const names = Object.keys(joints).sort();
  const parts: string[] = [];
  for (const n of names) {
    const j = joints[n];
    // A joint at rest is the same as one not named.
    if (j.angles.every((v) => v === 0) && j.move.every((v) => v === 0) && j.scale.every((v) => v === 1)) continue;
    parts.push(`${n}:${j.angles.map((v) => v.toFixed(6)).join(",")}|${j.move.map((v) => v.toFixed(6)).join(",")}|${j.scale.map((v) => v.toFixed(6)).join(",")}`);
  }
  return `${cellSize}#${parts.join(";")}`;
}

/** The mesh of the model in one pose, at about `cellSize`; undefined when the pose has no shape. */
function poseMesh(shapeAt: ShapeAt, joints: Record<string, JointPose>, cellSize: number, cache?: PoseCache, kind = ""): Mesh | undefined {
  const key = cache ? kind + poseKey(joints, cellSize) : "";
  if (cache && cache.has(key)) return cache.get(key);
  const m = poseMeshUncached(shapeAt, joints, cellSize);
  if (cache) cache.set(key, m);
  return m;
}

function poseMeshUncached(shapeAt: ShapeAt, joints: Record<string, JointPose>, cellSize: number): Mesh | undefined {
  const shape = shapeAt(joints);
  if (!shape || isEmpty(shape.bounds)) return undefined;
  const s = boundsSize(shape.bounds);
  const resolution = Math.max(12, Math.min(112, Math.ceil(Math.max(s[0], s[1], s[2]) / cellSize)));
  return surfaceNets(shape, { resolution }).mesh;
}

function poseThumb(mesh: Mesh | undefined, framing: Bounds, thumb: number, label: string, azimuth?: number, elevation?: number, ghost?: Mesh, ghostMargin?: number, fitPoints?: Float32Array, sub?: string): Canvas {
  if (!mesh || triangleCount(mesh) === 0) {
    const c = new Canvas(thumb, thumb, INK.viewPersp);
    drawText(c, 6, 6, label, INK.text, 1);
    return c;
  }
  const c = renderView(mesh, { name: label, bounds: framing }, "persp", thumb, { label: false, azimuth, elevation, ghost, ghostMargin, fitPoints });
  drawText(c, 6, 6, label, INK.text, 1);
  if (sub) drawText(c, 6, 16, sub, INK.dim, 1);
  return c;
}

/** What a pose does, in a line under its thumbnail: `wheel 90  gondola_1 -90  +6 more`, so alike thumbnails still say which pose they are (round 8: a symmetric wheel's four poses read the same). */
function poseSummary(joints: Record<string, JointPose>, width: number): string {
  const one = (v: number) => String(Number(v.toPrecision(3)));
  const entries = Object.entries(joints).filter(([, j]) => j.angles.some((v) => v !== 0) || j.move.some((v) => v !== 0) || j.scale.some((v) => v !== 1)).map(([name, j]) => {
    const parts: string[] = [];
    if (j.angles.some((v) => v !== 0)) parts.push(j.angles[1] === 0 && j.angles[2] === 0 ? one(j.angles[0]) : `[${j.angles.map(one).join(",")}]`);
    if (j.move.some((v) => v !== 0)) parts.push(`move [${j.move.map(one).join(",")}]`);
    if (j.scale.some((v) => v !== 1)) parts.push(`scale [${j.scale.map(one).join(",")}]`);
    return `${name} ${parts.join(" ")}`;
  });
  let out = "";
  for (let i = 0; i < entries.length; i++) {
    const next = out ? `${out}  ${entries[i]}` : entries[i];
    const more = entries.length - i - 1;
    if (textWidth(next + (more ? `  +${more} more` : ""), 1) > width - 12) return out ? `${out}  +${entries.length - i} more` : `${entries[i].slice(0, 20)}…`;
    out = next;
  }
  return out;
}

/**
 * One framing for every thumbnail, from the meshes themselves: the bounds of
 * a turned joint are a box around the turned box, so a framing from bounds
 * left a lamp using a fifth of its thumbnail (measured on a three-joint rig).
 */
/**
 * Every vertex of every mesh in one array, for a camera that fits a whole strip at once: the camera then holds
 * still from frame to frame, so a swing reads as motion and a slide moves (round 8: each frame was fitted on its
 * own, so a tool shrank as its blades came out and a sliding finger sat still while its ghost palm moved).
 */
function allPoints(meshes: (Mesh | undefined)[]): Float32Array {
  const present = meshes.filter((m): m is Mesh => !!m && triangleCount(m) > 0);
  const out = new Float32Array(present.reduce((n, m) => n + m.positions.length, 0));
  let at = 0;
  for (const m of present) { out.set(m.positions, at); at += m.positions.length; }
  return out;
}

function framingFor(meshes: (Mesh | undefined)[]): Bounds {
  let b: Bounds = { min: [Infinity, Infinity, Infinity], max: [-Infinity, -Infinity, -Infinity] };
  for (const m of meshes) {
    if (!m || triangleCount(m) === 0) continue;
    const mb = meshBounds(m);
    b = { min: [Math.min(b.min[0], mb.min[0]), Math.min(b.min[1], mb.min[1]), Math.min(b.min[2], mb.min[2])], max: [Math.max(b.max[0], mb.max[0]), Math.max(b.max[1], mb.max[1]), Math.max(b.max[2], mb.max[2])] };
  }
  return isEmpty(b) ? { min: [-1, -1, -1], max: [1, 1, 1] } : b;
}

/** A bar's text broken into lines that fit `width` at text size 2, so a long list wraps rather than being cut off. */
function barLines(text: string, width: number): string[] {
  const words = text.split(" ");
  const lines: string[] = [];
  let line = "";
  for (const w of words) {
    const next = line ? `${line} ${w}` : w;
    if (line && textWidth(next, 2) > width - 20) { lines.push(line); line = w; } else line = next;
  }
  if (line) lines.push(line);
  return lines;
}

const BAR_LINE = 18;

/** A ghost is meshed at twice the cell: it is faint, and it is most of the model (a focus sheet's neighbours). */
const GHOST_CELL = 2;

/**
 * One thumbnail per pose, the rest pose first, all framed alike. `shapeAt` rebuilds the model for a set of angles;
 * `ghostAt`, when given, the part of it drawn faint behind and around that (a focus sheet's clipped neighbours).
 */
export function renderPoses(shapeAt: ShapeAt, jointNames: string[], poses: PoseView[], thumb: number, cellSize: number, azimuth?: number, elevation?: number, cache?: PoseCache, frameEach = false, ghostAt?: ShapeAt): Canvas {
  const all: PoseView[] = [{ name: "rest", joints: {} }, ...poses.filter((p) => p.name !== "rest")];
  const cols = Math.min(5, all.length);
  const rows = Math.ceil(all.length / cols);
  const gutter = 6;
  const width = cols * (thumb + gutter) + gutter;
  // Every joint is named, wrapped onto more bar lines when there are many (round 7: a ten-joint rig's legs were "...").
  const lines = barLines(`POSES   ${jointNames.length} joint${jointNames.length === 1 ? "" : "s"}: ${jointNames.join(", ")}${ghostAt ? "   (the rest of the model faint)" : ""}`, width);
  const bar = 12 + lines.length * BAR_LINE;
  const out = new Canvas(width, bar + rows * (thumb + gutter) + gutter, INK.page);
  out.fill(0, 0, out.width, bar, INK.bar);
  lines.forEach((l, i) => drawText(out, 10, 8 + i * BAR_LINE, l, INK.barText, 2));
  const meshes = all.map((p) => poseMesh(shapeAt, p.joints, cellSize, cache));
  const ghosts = ghostAt ? all.map((p) => poseMesh(ghostAt, p.joints, cellSize * GHOST_CELL, cache, "ghost")) : [];
  // One framing for every pose, so sizes compare; a focused sheet frames each close-up on its own, since the
  // focused step is wherever each pose put it (a gimbal under a drone at take-off is far from one at rest).
  const framing = framingFor(meshes);
  const fit = frameEach ? undefined : allPoints(meshes);
  all.forEach((p, i) => {
    const c = poseThumb(meshes[i], frameEach ? framingFor([meshes[i]]) : framing, thumb, p.name, azimuth, elevation, ghosts[i], cellSize * GHOST_CELL, fit, i === 0 ? undefined : poseSummary(p.joints, thumb));
    out.blit(c, gutter + (i % cols) * (thumb + gutter), bar + gutter + Math.floor(i / cols) * (thumb + gutter));
  });
  return out;
}

/**
 * The blend fraction for a linear fraction u in [0, 1]: `easeIn` of the way from linear to a stop at the start,
 * `easeOut` at the end. Equal eases are the cosine blend; a lone ease at one end is a quarter sine, so a launch
 * can start at once and settle, or a loop's seam run straight through.
 */
export function easeBlend(u: number, easeIn = 0, easeOut = easeIn): number {
  const a = Math.max(0, Math.min(1, easeIn)), b = Math.max(0, Math.min(1, easeOut));
  if (a <= 0 && b <= 0) return u;
  const both = (1 - Math.cos(Math.PI * u)) / 2;
  const m = Math.min(a, b);
  let v = u + m * (both - u);
  if (a > m) v += (a - m) * (1 - Math.cos((Math.PI * u) / 2) - u);
  if (b > m) v += (b - m) * (Math.sin((Math.PI * u) / 2) - u);
  return v;
}

/** The eases at a segment's two keys: the first and last key of the animation take `easeEnds` when it is given. */
function segmentEase(i: number, count: number, timing: Timing): [number, number] {
  const ease = timing.ease ?? 0, ends = timing.easeEnds ?? ease;
  return [i === 0 ? ends : ease, i === count - 2 ? ends : ease];
}

/** Which keyframe segment holds the time fraction t in [0, 1], and how far along it is, for evenly spaced or given times. */
export function keyAt(count: number, t: number, timing: Timing = {}): { i: number; u: number } {
  if (count < 2) return { i: 0, u: 0 };
  const tt = Math.max(0, Math.min(1, t));
  if (!timing.times || timing.times.length !== count) {
    const f = tt * (count - 1);
    const i = Math.min(count - 2, Math.floor(f));
    return { i, u: easeBlend(f - i, ...segmentEase(i, count, timing)) };
  }
  const times = timing.times;
  const T = tt * times[times.length - 1];
  let i = 0;
  while (i < count - 2 && T >= times[i + 1]) i++;
  const span = times[i + 1] - times[i] || 1;
  return { i, u: easeBlend(Math.max(0, Math.min(1, (T - times[i]) / span)), ...segmentEase(i, count, timing)) };
}

/** The pose at time t in [0, 1] along keyframe poses, every component (angles, move, scale) blended per joint. */
export function interpolatePose(keys: PoseView[], jointNames: string[], t: number, timing: Timing = {}): Record<string, JointPose> {
  if (keys.length === 0) return {};
  if (keys.length === 1) return keys[0].joints;
  const { i, u } = keyAt(keys.length, t, timing);
  const out: Record<string, JointPose> = {};
  const mix = (a: [number, number, number], b: [number, number, number]): [number, number, number] => [a[0] + (b[0] - a[0]) * u, a[1] + (b[1] - a[1]) * u, a[2] + (b[2] - a[2]) * u];
  for (const j of jointNames) {
    const a = keys[i].joints[j] ?? REST_POSE, b = keys[i + 1].joints[j] ?? REST_POSE;
    out[j] = { angles: mix(a.angles, b.angles), move: mix(a.move, b.move), scale: mix(a.scale, b.scale) };
  }
  return out;
}

/** A strip of frames through an animation's keyframes, with the time under each. */
export function renderAnimation(shapeAt: ShapeAt, jointNames: string[], name: string, keys: PoseView[], seconds: number, frame: number, cellSize: number, frames = 8, azimuth?: number, elevation?: number, timing: Timing = {}, cache?: PoseCache, ghostAt?: ShapeAt): Canvas {
  const gutter = 4, labelH = 12;
  const width = frames * (frame + gutter) + gutter;
  const keyList = keys.map((k, i) => (timing.times ? `${k.name} ${fmt(timing.times[i])}s` : k.name)).join(" → ");
  // The bar says whether it loops (round 7: a one-shot's bar read like a loop's) and wraps a long key list.
  const lines = barLines(`${name.toUpperCase()}   ${fmt(seconds)}s   ${timing.loop === false ? "once" : "loop"}${timing.ease ? `   ease ${fmt(timing.ease)}` : ""}${timing.easeEnds !== undefined && timing.easeEnds !== (timing.ease ?? 0) ? `   ends ${fmt(timing.easeEnds)}` : ""}   keyframes: ${keyList}${ghostAt ? "   (the rest of the model faint)" : ""}`, width);
  const bar = 6 + lines.length * BAR_LINE;
  const out = new Canvas(width, frame + gutter * 2 + bar + labelH, INK.page);
  out.fill(0, 0, out.width, bar, INK.bar);
  lines.forEach((l, i) => drawText(out, 10, 6 + i * BAR_LINE, l, INK.barText, 2));
  const meshes: (Mesh | undefined)[] = [], ghosts: (Mesh | undefined)[] = [];
  for (let i = 0; i < frames; i++) {
    const at = interpolatePose(keys, jointNames, frames === 1 ? 0 : i / (frames - 1), timing);
    meshes.push(poseMesh(shapeAt, at, cellSize, cache));
    if (ghostAt) ghosts.push(poseMesh(ghostAt, at, cellSize * GHOST_CELL, cache, "ghost"));
  }
  const framing = framingFor(meshes);
  const fit = allPoints(meshes);
  for (let i = 0; i < frames; i++) {
    const t = frames === 1 ? 0 : i / (frames - 1);
    const c = poseThumb(meshes[i], framing, frame, "", azimuth, elevation, ghosts[i], cellSize * GHOST_CELL, fit);
    out.blit(c, gutter + i * (frame + gutter), bar + gutter);
    drawText(out, gutter + i * (frame + gutter), bar + gutter + frame + 2, `${fmt(t * seconds)}s`, INK.dim, 1);
  }
  return out;
}
