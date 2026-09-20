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
  /** A shape subtracted from a part: it owns the cut faces, labelled "name (cut)". */
  cut?: boolean;
  /** A step computed with a cut in it, so a face of its surface may be a cutter's. */
  derived?: boolean;
}

export interface CalloutResult {
  canvas: Canvas;
  /** The steps labelled, largest first, with how many of their vertices were visible. */
  labelled: { name: string; cut?: boolean; visible: number }[];
  /** Steps with a surface in view that did not make the label count, or too small to place. */
  unlabelled: { name: string; cut?: boolean }[];
}

/**
 * Which step each vertex lies on, or -1: among the parts, the smallest whose field is within a cell there and whose
 * inside is the model's inside just behind the surface; of two the same size the later step, so a shell or a painted
 * cut is named, not the primitive it came from. When that part was computed with a cut and a cutter's surface passes
 * here with the model's solid outside it, the face is the cutter's: a slot is "slot (cut)", not the plate it is in.
 */
export function attributeVertices(mesh: Mesh, steps: CalloutStep[], cellSize: number, stride = 1, model?: Shape3): Int32Array {
  const n = mesh.positions.length / 3;
  const owner = new Int32Array(n).fill(-1);
  const volume = steps.map((s) => (isEmpty(s.shape.bounds) ? Infinity : boundsSize(s.shape.bounds).reduce((a, b) => a * b, 1)));
  const byVolume = (a: number, b: number) => (volume[a] === volume[b] ? b - a : volume[a] - volume[b]);
  const parts = steps.map((_, i) => i).filter((i) => !steps[i].cut).sort(byVolume);
  const cutters = steps.map((_, i) => i).filter((i) => steps[i].cut).sort(byVolume);
  const tol = cellSize * 0.75;
  const inBox = (i: number, x: number, y: number, z: number) => {
    const b = steps[i].shape.bounds;
    return !(x < b.min[0] - tol || x > b.max[0] + tol || y < b.min[1] - tol || y > b.max[1] + tol || z < b.min[2] - tol || z > b.max[2] + tol);
  };
  for (let v = 0; v < n; v += stride) {
    const x = mesh.positions[v * 3], y = mesh.positions[v * 3 + 1], z = mesh.positions[v * 3 + 2];
    const nx = mesh.normals[v * 3], ny = mesh.normals[v * 3 + 1], nz = mesh.normals[v * 3 + 2];
    // A point just inside the model behind the vertex; at an edge cell the first try can land outside (a rim over a
    // cavity), so step back less, and give up on the vertex rather than hand it to the cutter it lies over.
    let back = cellSize * 1.5, ix = x - nx * back, iy = y - ny * back, iz = z - nz * back;
    if (model && model.dist(ix, iy, iz) >= 0) { back = cellSize * 0.5; ix = x - nx * back; iy = y - ny * back; iz = z - nz * back; if (model.dist(ix, iy, iz) >= 0) continue; }
    let part = -1;
    for (const i of parts) {
      if (!inBox(i, x, y, z)) continue;
      const d = steps[i].shape.dist;
      if (Math.abs(d(x, y, z)) <= tol && d(ix, iy, iz) < 0) { part = i; break; }
    }
    if (part < 0) continue;
    owner[v] = part;
    if (!steps[part].derived) continue;
    for (const i of cutters) {
      if (!inBox(i, x, y, z)) continue;
      const d = steps[i].shape.dist;
      if (Math.abs(d(x, y, z)) <= tol && d(ix, iy, iz) > 0) { owner[v] = i; break; }
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
  const ranked = steps.map((s, i) => ({ i, name: s.name, cut: s.cut, visible: acc[i].count * stride })).filter((r) => r.visible >= 6 * stride).sort((a, b) => b.visible - a.visible);
  const chosen = ranked.slice(0, maxLabels);
  const unlabelled = ranked.slice(maxLabels).map((r) => ({ name: r.name, cut: r.cut }));
  // Each label's anchor: the visible vertex nearest the step's visible centroid, so a ring's label points at the ring.
  type Label = { name: string; ax: number; ay: number; x: number; y: number; w: number; h: number; dx: number; dy: number };
  const labels: Label[] = [];
  const cx = size / 2, cy = size / 2;
  for (const r of chosen) {
    const a = acc[r.i];
    const mx = a.sx / a.count, my = a.sy / a.count;
    let best = a.pts[0], bd = Infinity;
    for (const q of a.pts) { const dd = (q[0] - mx) ** 2 + (q[1] - my) ** 2; if (dd < bd) { bd = dd; best = q; } }
    const [ax, ay] = best;
    const text = r.cut ? `${r.name} (cut)` : r.name;
    const w = textWidth(text, 1) + 8, h = 12;
    // Out from the picture's centre through the anchor, a little way past it.
    let dx = ax - cx, dy = ay - cy;
    const len = Math.hypot(dx, dy) || 1;
    dx /= len; dy /= len;
    const reach = size * 0.11;
    let x = ax + dx * reach - w / 2, y = ay + dy * reach - h / 2;
    x = Math.max(2, Math.min(size - w - 2, x));
    y = Math.max(2, Math.min(size - h - 2, y));
    labels.push({ name: text, ax, ay, x, y, w, h, dx, dy });
  }
  // Push overlapping labels apart: the later label moves on outwards along its own leader, so leaders stay radial
  // and do not cross (a column of labels pushed straight down crossed six leaders in round 9); one that would leave
  // the picture slides sideways instead.
  const clash = (a: Label, b: Label) => a.x < b.x + b.w + 3 && b.x < a.x + a.w + 3 && a.y < b.y + b.h + 3 && b.y < a.y + a.h + 3;
  for (let pass = 0; pass < 40; pass++) {
    let moved = false;
    for (let i = 0; i < labels.length; i++)
      for (let j = i + 1; j < labels.length; j++) {
        const a = labels[i], b = labels[j];
        if (!clash(a, b)) continue;
        const step = 6;
        let nx = b.x + b.dx * step, ny = b.y + b.dy * step;
        if (nx < 2 || nx + b.w > size - 2 || ny < 2 || ny + b.h > size - 2) { nx = b.x + (Math.abs(b.dx) > Math.abs(b.dy) ? 0 : (b.dx >= 0 ? step : -step)); ny = b.y + (Math.abs(b.dx) > Math.abs(b.dy) ? (b.dy >= 0 ? step : -step) : 0); }
        nx = Math.max(2, Math.min(size - b.w - 2, nx));
        ny = Math.max(2, Math.min(size - b.h - 2, ny));
        if (nx === b.x && ny === b.y) { ny = b.y + b.h + 3 <= size - 2 ? b.y + b.h + 3 : b.y - b.h - 3; }
        b.x = nx; b.y = ny;
        moved = true;
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
  drawText(out, 10 + textWidth("CALLOUTS", 2) + 12, 10, `${labels.length} of ${named} named step${named === 1 ? "" : "s"} in view${unlabelled.length ? `, the largest. report.md names the rest` : ""}`, INK.barText, 1);
  return { canvas: out, labelled: chosen.map((r) => ({ name: r.name, cut: r.cut, visible: r.visible })), unlabelled };
}

/**
 * How much of a set of points (a focused step's vertices) is hidden by the rest of the mesh from a view: the
 * fraction whose projection lies behind the depth buffer of the whole mesh drawn from that azimuth and elevation.
 * A focus shot from behind a pole framed the pole (round 9); this says so before the render is read.
 */
export function hiddenFraction(mesh: Mesh, within: Bounds, info: ViewInfo, cellSize: number, azimuth?: number, elevation?: number, size = 160, on?: Shape3): number {
  let target: RenderTarget | undefined, cam: Camera | undefined;
  renderView(mesh, info, "persp", size, { label: false, azimuth, elevation, capture: (t, c) => { target = t; cam = c; } });
  if (!target || !cam) return 0;
  const depthTol = Math.max(cellSize * 3, 1e-6);
  const n = mesh.positions.length / 3;
  const stride = Math.max(1, Math.floor(n / 4000));
  const eye = cam.eye;
  let seen = 0, hidden = 0;
  for (let v = 0; v < n; v += stride) {
    const x = mesh.positions[v * 3], y = mesh.positions[v * 3 + 1], z = mesh.positions[v * 3 + 2];
    if (x < within.min[0] || x > within.max[0] || y < within.min[1] || y > within.max[1] || z < within.min[2] || z > within.max[2]) continue;
    // Only the step's own surface counts, not whatever else its box holds (a lantern's pole runs through its box).
    if (on && Math.abs(on.dist(x, y, z)) > cellSize) continue;
    // Only vertices that face the camera count: a part's own far side is hidden by the part, not by the model.
    if (mesh.normals[v * 3] * (x - eye[0]) + mesh.normals[v * 3 + 1] * (y - eye[1]) + mesh.normals[v * 3 + 2] * (z - eye[2]) >= 0) continue;
    const pr = project(cam, toView(cam, [x, y, z]));
    if (!pr) continue;
    const px = Math.round(pr.x), py = Math.round(pr.y);
    if (px < 0 || py < 0 || px >= size || py >= size) continue;
    seen++;
    const d = target.depth[py * size + px];
    if (Number.isFinite(d) && pr.depth > d + depthTol) hidden++;
  }
  return seen ? hidden / seen : 0;
}
