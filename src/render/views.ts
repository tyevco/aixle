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
import { boundsCenter, boundsSize, isEmpty, type Bounds, type Shape3 } from "../sdf/types.js";
import { surfaceNets } from "../mesh/surfaceNets.js";
import { triangleCount, type Mesh } from "../mesh/mesh.js";
import { orthographic, perspective, project, toView, type Camera, type OrthoView } from "./camera.js";
import { Canvas, mixColor, rgbf, type Color } from "./canvas.js";
import { drawText, textWidth } from "./font.js";
import { createTarget, renderLine, renderMesh, type RenderTarget } from "./raster.js";

export const INK = {
  page: 0xf4f2ee,
  view: 0xeceae4,
  viewPersp: 0xe4e6ea,
  grid: 0xd8d5cc,
  gridMajor: 0xbfbbb0,
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
}

const fmt = (v: number): string => (Math.abs(v) >= 100 ? v.toFixed(0) : Math.abs(v) >= 10 ? v.toFixed(1) : v.toFixed(2)).replace(/\.?0+$/, "") || "0";

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

function caption(canvas: Canvas, text: string, sub?: string): void {
  const w = textWidth(text, 2) + 12;
  canvas.fill(6, 6, w, 20, INK.bar);
  drawText(canvas, 12, 9, text, INK.barText, 2);
  if (sub) drawText(canvas, 12, 30, sub, INK.dim, 1);
}

/** Render one view of a mesh at `size` pixels square. */
export function renderView(mesh: Mesh, info: ViewInfo, view: ViewName, size: number, opts: { flatColor?: Vec3; outline?: boolean; label?: boolean; azimuth?: number } = {}): Canvas {
  const bounds = isEmpty(info.bounds) ? { min: [-1, -1, -1] as Vec3, max: [1, 1, 1] as Vec3 } : info.bounds;
  const label = opts.label ?? true;
  if (view === "persp") {
    const cam = perspective(bounds, size, size, opts.azimuth ?? 35, 25);
    const target = createTarget(size, size, INK.viewPersp);
    renderMesh(mesh, cam, target, { background: INK.viewPersp, outline: opts.outline, flatColor: opts.flatColor });
    floorGrid(cam, target, bounds, label);
    if (label) caption(target.canvas, "PERSPECTIVE", `from front-right, above  ${dimsLabel(info.bounds)}`);
    return target.canvas;
  }
  const cam = orthographic(bounds, size, size, view);
  const target = createTarget(size, size, INK.view);
  const { step } = orthoGrid(cam, target.canvas);
  renderMesh(mesh, cam, target, { background: INK.view, outline: opts.outline, flatColor: opts.flatColor });
  if (label) {
    const h = axisOf(cam.right), v = axisOf(cam.up);
    const hs = `${h.sign < 0 ? "-" : ""}${AXIS_NAMES[h.index]}→`;
    const vs = `${v.sign < 0 ? "-" : ""}${AXIS_NAMES[v.index]}↑`;
    caption(target.canvas, view.toUpperCase(), `${hs} ${vs}  grid ${fmt(step)}`);
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
export function renderSheet(mesh: Mesh, info: SheetInfo, size: number): Canvas {
  const gutter = 4, bar = 30;
  const sheet = new Canvas(size * 2 + gutter * 3, size * 2 + gutter * 3 + bar, INK.page);
  sheet.fill(0, 0, sheet.width, bar, INK.bar);
  const title = `${info.name.toUpperCase()}   ${dimsLabel(info.bounds)} units   ${info.triangles} tris   cell ${fmt(info.cellSize)}`;
  drawText(sheet, 10, 8, title, INK.barText, 2);
  if (info.warnings > 0) {
    const w = `${info.warnings} warning${info.warnings === 1 ? "" : "s"} in report.md`;
    drawText(sheet, sheet.width - textWidth(w, 2) - 10, 8, w, 0xf0a060, 2);
  }
  const views: ViewName[] = ["persp", "front", "right", "top"];
  views.forEach((v, i) => {
    const c = renderView(mesh, info, v, size);
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

/** Three cross-sections, coloured from the field itself; `at` overrides the plane per axis. */
export function renderSlices(shape: Shape3, info: ViewInfo, size: number, at?: Partial<Record<"x" | "y" | "z", number>>): Canvas {
  const gutter = 4, bar = 30;
  const out = new Canvas(size * 3 + gutter * 4, size + gutter * 2 + bar, INK.page);
  out.fill(0, 0, out.width, bar, INK.bar);
  drawText(out, 10, 8, `${info.name.toUpperCase()}   CROSS-SECTIONS   inside is filled, the outline is the surface`, INK.barText, 2);
  const b = isEmpty(info.bounds) ? { min: [-1, -1, -1] as Vec3, max: [1, 1, 1] as Vec3 } : info.bounds;
  const c = boundsCenter(b);
  const s = boundsSize(b);
  const span = Math.max(s[0], s[1], s[2]) * 1.15;
  const upp = span / size;
  const planes: { axis: "x" | "y" | "z"; h: number; v: number; vSign: number; label: string }[] = [
    { axis: "x", h: 2, v: 1, vSign: 1, label: "-z→ y↑" }, // seen from +x: screen right is -z
    { axis: "y", h: 0, v: 2, vSign: -1, label: "x→ -z↑" }, // seen from above: up is -z
    { axis: "z", h: 0, v: 1, vSign: 1, label: "x→ y↑" }, // seen from +z
  ];
  planes.forEach((pl, i) => {
    const canvas = new Canvas(size, size, INK.view);
    const level = at?.[pl.axis] ?? defaultLevel(b, pl.axis);
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
        }
      }
    caption(canvas, `${pl.axis.toUpperCase()} = ${fmt(level)}`, `${pl.label}  grid ${fmt(step)}`);
    out.blit(canvas, gutter + i * (size + gutter), bar + gutter);
  });
  return out;
}

export interface StepView {
  name: string;
  shape: Shape3;
  used: boolean;
  line: number;
  /** The step's mesh, if already extracted; otherwise it is extracted here. */
  mesh?: Mesh;
}

/** Extract a small mesh for each step; the pipeline uses these for warnings before drawing them. */
export function meshSteps(steps: StepView[], resolution = 48): StepView[] {
  return steps.map((st) => (st.mesh || isEmpty(st.shape.bounds) ? st : { ...st, mesh: surfaceNets(st.shape, { resolution }).mesh }));
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
      if (triangleCount(mesh) === 0) drawText(canvas, 8, thumb / 2 - 4, "NO SURFACE", INK.warn, 1);
    }
    if (!st.used) canvas.rect(0, 0, thumb, thumb, INK.warn);
    out.blit(canvas, x, y);
    const name = `${i + 1}. ${st.name}`;
    drawText(out, x, y + thumb + 3, name.length > thumb / 6 ? name.slice(0, Math.floor(thumb / 6) - 1) + "…" : name, st.used ? INK.text : INK.warn, 1);
    drawText(out, x, y + thumb + 13, isEmpty(st.shape.bounds) ? "empty" : dimsLabel(st.shape.bounds) + (st.used ? "" : "  unused"), INK.dim, 1);
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
    const az = 35 + (360 / frames) * i;
    const c = renderView(mesh, info, "persp", frame, { azimuth: az, label: false });
    drawText(c, 6, 6, `${Math.round(az % 360)}°`, INK.dim, 1);
    out.blit(c, gutter + i * (frame + gutter), bar + gutter);
  }
  return out;
}

export { mixColor };
