/**
 * The perspective view labelled with the program's own names: each visible
 * named step gets a leader line from its label to a point on it, so "the
 * thing at the top left is lantern_ring" is read, not inferred. Each mesh
 * vertex is attributed to the smallest step whose field it lies on, a step
 * is visible where the depth buffer shows its vertices, and the largest
 * visible steps are labelled, pushed apart so the labels do not overlap.
 */
import type { Vec3 } from "../core/vec.js";
import { boundsSize, isEmpty, type Bounds, type Shape3 } from "../sdf/types.js";
import type { Mesh } from "../mesh/mesh.js";
import { project, toView, type Camera } from "./camera.js";
import { Canvas } from "./canvas.js";
import { drawText, textWidth } from "./font.js";
import type { RenderTarget } from "./raster.js";
import { INK, renderView, type ViewInfo } from "./views.js";

export interface CalloutStep {
  name: string;
  shape: Shape3;
}

export interface CalloutResult {
  canvas: Canvas;
  /** The steps labelled, largest first, with how many of their vertices were visible. */
  labelled: { name: string; visible: number }[];
  /** Steps with a surface in view that did not make the label count, or too small to place. */
  unlabelled: string[];
}

/**
 * Which step each vertex lies on: the smallest step whose field is within a cell there and whose inside is the
 * model's inside just behind the surface (a cutter's field is zero on the cut face too, but the model's solid is
 * outside the cutter, so a cavity is not labelled as a part), or -1.
 */
export function attributeVertices(mesh: Mesh, steps: CalloutStep[], cellSize: number, stride = 1, model?: Shape3): Int32Array {
  const n = mesh.positions.length / 3;
  const owner = new Int32Array(n).fill(-1);
  const volume = steps.map((s) => (isEmpty(s.shape.bounds) ? Infinity : boundsSize(s.shape.bounds).reduce((a, b) => a * b, 1)));
  const order = steps.map((_, i) => i).sort((a, b) => volume[a] - volume[b]);
  const tol = cellSize * 0.75;
  for (let v = 0; v < n; v += stride) {
    const x = mesh.positions[v * 3], y = mesh.positions[v * 3 + 1], z = mesh.positions[v * 3 + 2];
    const nx = mesh.normals[v * 3], ny = mesh.normals[v * 3 + 1], nz = mesh.normals[v * 3 + 2];
    // A point just inside the model behind the vertex; at an edge cell the first try can land outside (a rim over a
    // cavity), so step back less, and give up on the vertex rather than hand it to the cutter it lies over.
    let back = cellSize * 1.5, ix = x - nx * back, iy = y - ny * back, iz = z - nz * back;
    if (model && model.dist(ix, iy, iz) >= 0) { back = cellSize * 0.5; ix = x - nx * back; iy = y - ny * back; iz = z - nz * back; if (model.dist(ix, iy, iz) >= 0) continue; }
    for (const i of order) {
      const b = steps[i].shape.bounds;
      if (x < b.min[0] - tol || x > b.max[0] + tol || y < b.min[1] - tol || y > b.max[1] + tol || z < b.min[2] - tol || z > b.max[2] + tol) continue;
      const d = steps[i].shape.dist;
      if (Math.abs(d(x, y, z)) <= tol && d(ix, iy, iz) < 0) { owner[v] = i; break; }
    }
  }
  return owner;
}

/** The perspective view with the largest visible steps named. */
export function renderCallouts(mesh: Mesh, steps: CalloutStep[], info: ViewInfo, size: number, cellSize: number, maxLabels = 20, azimuth?: number, elevation?: number, model?: Shape3): CalloutResult {
  let target: RenderTarget | undefined, cam: Camera | undefined;
  const canvas = renderView(mesh, info, "persp", size, { label: false, azimuth, elevation, capture: (t, c) => { target = t; cam = c; } });
  const bar = 26;
  const out = new Canvas(size, size + bar, INK.page);
  out.fill(0, 0, size, bar, INK.bar);
  out.blit(canvas, 0, bar);
  if (!target || !cam || steps.length === 0) {
    drawText(out, 10, 7, "CALLOUTS   no named steps in view", INK.barText, 2);
    return { canvas: out, labelled: [], unlabelled: [] };
  }
  const n = mesh.positions.length / 3;
  const stride = n > 60000 ? 2 : 1;
  const owner = attributeVertices(mesh, steps, cellSize, stride, model);
  // Visible vertices per step: projected, and no nearer surface in the depth buffer there.
  const acc = steps.map(() => ({ count: 0, sx: 0, sy: 0, pts: [] as [number, number][] }));
  const depthTol = Math.max(cellSize * 3, 1e-6);
  for (let v = 0; v < n; v += stride) {
    const i = owner[v];
    if (i < 0) continue;
    const p: Vec3 = [mesh.positions[v * 3], mesh.positions[v * 3 + 1], mesh.positions[v * 3 + 2]];
    const pr = project(cam, toView(cam, p));
    if (!pr) continue;
    const px = Math.round(pr.x), py = Math.round(pr.y);
    if (px < 0 || py < 0 || px >= size || py >= size) continue;
    const d = target.depth[py * size + px];
    if (!Number.isFinite(d) || pr.depth > d + depthTol) continue;
    const a = acc[i];
    a.count++; a.sx += px; a.sy += py;
    if (a.pts.length < 400) a.pts.push([px, py]);
  }
  const ranked = steps.map((s, i) => ({ i, name: s.name, visible: acc[i].count * stride })).filter((r) => r.visible >= 6 * stride).sort((a, b) => b.visible - a.visible);
  const chosen = ranked.slice(0, maxLabels);
  const unlabelled = ranked.slice(maxLabels).map((r) => r.name);
  // Each label's anchor: the visible vertex nearest the step's visible centroid, so a ring's label points at the ring.
  type Label = { name: string; ax: number; ay: number; x: number; y: number; w: number; h: number };
  const labels: Label[] = [];
  const cx = size / 2, cy = size / 2;
  for (const r of chosen) {
    const a = acc[r.i];
    const mx = a.sx / a.count, my = a.sy / a.count;
    let best = a.pts[0], bd = Infinity;
    for (const q of a.pts) { const dd = (q[0] - mx) ** 2 + (q[1] - my) ** 2; if (dd < bd) { bd = dd; best = q; } }
    const [ax, ay] = best;
    const w = textWidth(r.name, 1) + 8, h = 12;
    // Out from the picture's centre through the anchor, a little way past it.
    let dx = ax - cx, dy = ay - cy;
    const len = Math.hypot(dx, dy) || 1;
    dx /= len; dy /= len;
    const reach = size * 0.11;
    let x = ax + dx * reach - w / 2, y = ay + dy * reach - h / 2;
    x = Math.max(2, Math.min(size - w - 2, x));
    y = Math.max(2, Math.min(size - h - 2, y));
    labels.push({ name: r.name, ax, ay, x, y, w, h });
  }
  // Push overlapping labels apart, downwards in reading order, a few passes.
  for (let pass = 0; pass < 8; pass++) {
    let moved = false;
    const sorted = [...labels].sort((a, b) => a.y - b.y);
    for (let i = 0; i < sorted.length; i++)
      for (let j = i + 1; j < sorted.length; j++) {
        const a = sorted[i], b = sorted[j];
        if (a.x < b.x + b.w + 3 && b.x < a.x + a.w + 3 && a.y < b.y + b.h + 3 && b.y < a.y + a.h + 3) {
          b.y = a.y + a.h + 3;
          if (b.y + b.h > size - 2) { b.y = a.y - b.h - 3; }
          moved = true;
        }
      }
    if (!moved) break;
  }
  // Leader lines under the labels, then the labels: a dot on the part, a line to the label's nearest edge.
  for (const l of labels) {
    const lx = Math.max(l.x, Math.min(l.x + l.w, l.ax)), ly = Math.max(l.y, Math.min(l.y + l.h, l.ay));
    out.line(l.ax, l.ay + bar, lx, ly + bar, INK.barText, 1);
    out.line(l.ax, l.ay + bar, lx, ly + bar, INK.text, 0.85);
    for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) out.set(l.ax + dx, l.ay + dy + bar, INK.text);
  }
  for (const l of labels) {
    out.fill(Math.round(l.x), Math.round(l.y) + bar, Math.round(l.w), l.h, INK.bar);
    drawText(out, Math.round(l.x) + 4, Math.round(l.y) + bar + 3, l.name, INK.barText, 1);
  }
  const named = steps.filter((_, i) => acc[i].count > 0).length;
  drawText(out, 10, 7, "CALLOUTS", INK.barText, 2);
  drawText(out, 10 + textWidth("CALLOUTS", 2) + 12, 10, `${labels.length} of ${named} named step${named === 1 ? "" : "s"} in view${unlabelled.length ? `, the largest; the rest in report.md` : ""}`, INK.barText, 1);
  return { canvas: out, labelled: chosen.map((r) => ({ name: r.name, visible: r.visible })), unlabelled };
}
