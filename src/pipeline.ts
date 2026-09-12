/**
 * From a source file to a folder of things to look at. `run()` is the whole
 * pipeline: parse, evaluate, extract the surface, render the sheets, write
 * the exports and the report. The CLI is a thin wrapper over it, and so is
 * the examples generator.
 */
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { parseObj } from "./import/obj.js";
import { parseGlb } from "./import/glb.js";
import { meshField } from "./mesh/meshSdf.js";
import { box, primitive } from "./sdf/primitives.js";
import { eulerToQuat, toGlbScene, type GlbAnimation } from "./export/glb.js";
import { toObjScene } from "./export/obj.js";
import { toStl } from "./export/stl.js";
import { buildHierarchy, flatten } from "./export/hierarchy.js";
import { allJoints, intersect, move, placedBounds, surfaceExtent } from "./sdf/ops.js";
import { INK, renderAnimation, renderPoses, type PoseView, type ShapeAt } from "./render/views.js";
import { Canvas } from "./render/canvas.js";
import { drawText } from "./render/font.js";
import { viewerHtml } from "./export/viewer.js";
import { renderBeauty } from "./render/beauty.js";
import { evaluate, type Evaluation } from "./lang/interpreter.js";
import { parse } from "./lang/parser.js";
import { isShape3 } from "./lang/values.js";
import { meshBounds, meshVolume, triangleCount, vertexCount, watertightReport, type Mesh } from "./mesh/mesh.js";
import { analyse, type Physics, type Piece } from "./mesh/physics.js";
import { surfaceNets } from "./mesh/surfaceNets.js";
import { meshSteps, renderSheet, renderSlices, renderSteps, renderTurntable, renderView, dimsLabel, type StepView, type ViewName } from "./render/views.js";
import { boundsCenter, boundsSize, isEmpty, type Bounds, type Shape3 } from "./sdf/types.js";

/** The inner-loop preset: a small grid, the sheet only, no exports. A render in a second or two. */
export const QUICK: RunOptions = { quick: true, grid: 64, size: 320, views: [], steps: false, slices: false, turntable: false, obj: false, glb: false, viewer: false, beauty: false };

export interface RunOptions {
  /** A quick pass: the grid is coarse for speed, so thin-part warnings are judged at the grid a full render would use. */
  quick?: boolean;
  /** Write poses.png and the animation strips (default true when the model has joints). */
  poses?: boolean;
  /** Cells along the longest side of the model; overrides a `set grid` in the file. Default 128. */
  grid?: number;
  /** Used only when neither `grid` nor the file's `set grid` is given. */
  defaultGrid?: number;
  /** Pixels per view. Default 512. */
  size?: number;
  views?: ViewName[];
  steps?: boolean;
  slices?: boolean;
  turntable?: boolean;
  obj?: boolean;
  glb?: boolean;
  /** Write viewer.html with the GLB embedded. Default true when the GLB is written. */
  viewer?: boolean;
  /** Bake the materials into a texture atlas of this many pixels square for the exports; 0 disables. Default 1024. */
  texture?: number;
  /** Ray-march the field for beauty.png. Default false: it costs seconds. */
  beauty?: boolean;
  /** Pixels for the beauty render; default `size`. */
  beautySize?: number;
  /** Vertex placement: sharp (dual contouring, default) or the rounded surface-nets mean. */
  sharp?: boolean;
  /** Perspective camera direction in degrees; defaults 35 and 25, or `set azimuth` / `set elevation`. */
  azimuth?: number;
  elevation?: number;
  /** Called with progress lines. */
  log?: (line: string) => void;
  /** Density in mass units per cubic unit for the report's mass line; default 1 (or `set density`). */
  density?: number;
  /** Show this pose on the sheet, views, slices and beauty render instead of `set pose` (rest by default). */
  pose?: string;
  /** Beauty camera zoom, 1 fits the bounding sphere (or `set zoom`). */
  zoom?: number;
  /** Frame every view on this named step or object instead of the whole model (or `set focus name`). */
  focus?: string;
}

export interface RunResult {
  name: string;
  outDir: string;
  evaluation: Evaluation;
  mesh?: Mesh;
  bounds?: Bounds;
  files: string[];
  warnings: string[];
  report: string;
  timings: Record<string, number>;
  /** Mass properties, pieces and overhangs of the mesh, when there is one. */
  physics?: Physics;
}

const fmt = (v: number): string => {
  const s = Number.isInteger(v) ? String(v) : v.toFixed(3).replace(/0+$/, "").replace(/\.$/, "");
  return s === "-0" ? "0" : s;
};

/** Imports resolve relative to the source file's folder: OBJ or GLB, sampled into a field. */
export function importResolver(sourceName: string, log: (line: string) => void = () => {}) {
  const cache = new Map<string, Shape3>();
  return (path: string, opts: { resolution: number }): Shape3 => {
    const file = resolve(dirname(resolve(sourceName)), path);
    const key = `${file}@${opts.resolution}`;
    const hit = cache.get(key);
    if (hit) return hit;
    let data: Buffer;
    try {
      data = readFileSync(file);
    } catch {
      throw new Error(`cannot read ${file}`);
    }
    const lower = file.toLowerCase();
    const mesh = lower.endsWith(".glb") ? parseGlb(data) : lower.endsWith(".obj") ? parseObj(data.toString("utf8")) : undefined;
    if (!mesh) throw new Error(`only .obj and .glb files can be imported`);
    const t0 = performance.now();
    log(`import ${path}: sampling ${mesh.indices.length / 3} triangles at resolution ${opts.resolution}...`);
    const field = meshField(mesh, opts.resolution);
    log(`import ${path}: ${field.triangles} triangles sampled at cell ${fmt(field.cell)} in ${Math.round(performance.now() - t0)} ms${field.openness > 0.01 ? ` (mesh is not closed: ${(field.openness * 100).toFixed(0)}% of rays end inside)` : ""}`);
    const shape = primitive(field.dist, field.bounds, 8);
    cache.set(key, shape);
    return shape;
  };
}

/**
 * A part thinner than about a cell on any axis can drop out of the mesh
 * entirely (measured: rails at 0.9 of a cell vanished, a plate at 1.3
 * survived); say so from its bounds alone, so `check` can say it too.
 */
export function thinWarnings(evaluation: Evaluation, cellSize: number, grid: number): string[] {
  const out: string[] = [];
  const gridFor = (t: number) => Math.min(512, Math.ceil((grid * 2.5 * cellSize) / t));
  const reportedFeatures = new Set<number>();
  const geometry = geometrySteps(evaluation);
  for (const st of evaluation.steps) {
    if (!isShape3(st.value) || !geometry.has(st.name) || isEmpty(st.value.bounds)) continue;
    const ss = boundsSize(st.value.bounds);
    const t = Math.min(ss[0], ss[1], ss[2]);
    if (t > 0 && t < cellSize * 1.2) {
      out.push(`'${st.name}' (line ${st.line}) is only ${fmt(t)} units thin, ${fmt(t / cellSize)} of the ${fmt(cellSize)} cell: it may be missing or broken in the mesh. Thicken it or raise the grid (set grid ${gridFor(t)}).`);
      continue;
    }
    // A gap (a letter's counters, a slot) narrower than a cell closes up; reported once per size like features.
    // Half a cell: dual contouring resolves a counter at most of a cell (measured: rim lettering at 0.8 of a cell read
    // fine), while one that is closed or nearly so becomes blobs.
    // Between half a cell and a cell it survives but the mesh around it may not be watertight (measured: a nameplate's
    // counters at 0.7 of a cell left open edges in the GLB), so that band warns more softly.
    const g = st.value.gap;
    if (g !== undefined && g >= 0 && g < cellSize) {
      const gkey = Math.round(g * 1e6) + 0.5;
      if (!reportedFeatures.has(gkey)) {
        reportedFeatures.add(gkey);
        const what = st.value.gapWhat ?? "a gap (a letter's counters, the space between letters, a slot)";
        const between = /space between/.test(what);
        const fix = between ? "more spacing= or a lighter weight" : "a larger size or a lighter weight (under a quarter of the size for lowercase), or capitals";
        out.push(
          g <= 0
            ? `'${st.name}' (line ${st.line}): ${what} closes up at this weight. Use ${fix}.`
            : g < cellSize * 0.5
              ? `'${st.name}' (line ${st.line}): ${what} is only ${fmt(g)} wide, ${fmt(g / cellSize)} of the ${fmt(cellSize)} cell, and closes up in the mesh. Use ${fix}, or raise the grid (set grid ${gridFor(g)}).`
              : `'${st.name}' (line ${st.line}): ${what} is ${fmt(g)} wide, ${(g / cellSize).toFixed(2)} of the ${fmt(cellSize)} cell, so the mesh there may not be watertight. For a print or a clean GLB use ${fix}, or raise the grid (set grid ${gridFor(g)}).`,
        );
      }
    }
    // A wall, tube or stroke inside a thick step: bounds cannot see it, so the shape carries the size itself.
    // Reported once per size, at the step that introduced it, not again at every step built on top.
    const f = st.value.feature;
    if (f === undefined || !(f > 0) || f >= cellSize * 1.2) continue;
    const key = Math.round(f * 1e6);
    if (reportedFeatures.has(key)) continue;
    reportedFeatures.add(key);
    out.push(`'${st.name}' (line ${st.line}) has a wall, tube (at its thin end, if tapered) or stroke only ${fmt(f)} thick, ${fmt(f / cellSize)} of the ${fmt(cellSize)} cell: it may be missing or broken in the mesh. Thicken it or raise the grid (set grid ${gridFor(f)}).`);
  }
  return out;
}

/**
 * The steps whose shape is part of the output's geometry: reachable from the
 * output through the shape tree. A step used only as a decal's region, or
 * only to measure something, is "used" but adds no surface, so it gets no
 * thin-part warning and is never named as holding a loose piece.
 */
export function geometrySteps(evaluation: Evaluation): Set<string> {
  const out = new Set<string>();
  const roots = evaluation.objects.length ? evaluation.objects.map((o) => o.shape) : evaluation.output ? [evaluation.output] : [];
  const reachable = new Set<Shape3>();
  const walk = (n: Shape3) => {
    if (reachable.has(n)) return;
    reachable.add(n);
    for (const c of n.inner ?? []) walk(c);
    for (const c of n.parts ?? []) walk(c);
    if (n.joint) walk(n.joint.child);
    if (n.instanced) walk(n.instanced.base);
  };
  for (const r of roots) walk(r);
  for (const st of evaluation.steps) if (isShape3(st.value) && reachable.has(st.value)) out.add(st.name);
  return out;
}

/**
 * The steps to name for a point: the innermost named shapes whose surface
 * passes within `tol` of it, found by walking the tree from the output
 * and pulling the point back through each transform's inverse on the way
 * down. A step built at the origin and moved into place is tested where
 * it ends up, in its own frame, so a loose lug is blamed on the lug and
 * not on the arm it was welded to (measured: round 3 named the outermost
 * placed union, round 2 named a part by its box). The tolerance follows
 * the point through scales and warps by measuring how the inverse
 * stretches a step of `tol`. Smallest box first, so the most specific
 * name comes first.
 */
export function stepsNear(evaluation: Evaluation, c: [number, number, number], tol: number, limit = 2): string[] {
  const names = new Map<Shape3, string>();
  for (const st of evaluation.steps) if (isShape3(st.value) && !names.has(st.value)) names.set(st.value, st.name);
  const roots = evaluation.objects.length ? evaluation.objects.map((o) => o.shape) : evaluation.output ? [evaluation.output] : [];
  // Every named shape within reach, with how close its surface passes, its depth in the tree and whether it is
  // innermost: the closest first (by the cell, so a hand's tip a fifth of a cell from a recess wall names both, not
  // a dial a whole cell away: measured on a clock), then innermost, then the nearest ancestors.
  const found = new Map<string, { d: number; depth: number; leaf: boolean }>();
  let budget = 20000;
  // Returns whether a named step at or below `n` was within reach of the point.
  const walk = (n: Shape3, x: number, y: number, z: number, t: number, depth: number): boolean => {
    if (--budget < 0 || isEmpty(n.bounds)) return false;
    const b = n.bounds;
    if (x < b.min[0] - t || x > b.max[0] + t || y < b.min[1] - t || y > b.max[1] + t || z < b.min[2] - t || z > b.max[2] + t) return false;
    const dn = Math.abs(n.dist(x, y, z));
    if (dn > t) return false;
    let cx = x, cy = y, cz = z, ct = t;
    if (n.unwarp) {
      const q = n.unwarp(x, y, z);
      let stretch = 0;
      for (const [ex, ey, ez] of [[t, 0, 0], [0, t, 0], [0, 0, t]]) {
        const r = n.unwarp(x + ex, y + ey, z + ez);
        stretch = Math.max(stretch, Math.hypot(r[0] - q[0], r[1] - q[1], r[2] - q[2]));
      }
      cx = q[0]; cy = q[1]; cz = q[2]; ct = stretch > 0 && Number.isFinite(stretch) ? stretch : t;
    }
    let below = false;
    for (const k of n.parts ?? n.inner ?? []) if (walk(k, cx, cy, cz, ct, depth + 1)) below = true;
    if (n.instanced && !n.parts) below = walk(n.instanced.base, cx, cy, cz, ct, depth + 1) || below;
    const name = names.get(n);
    if (name === undefined) return below;
    const prev = found.get(name);
    found.set(name, { d: Math.min(dn / t, prev?.d ?? Infinity), depth: Math.max(depth, prev?.depth ?? 0), leaf: !below || (prev?.leaf ?? false) });
    return true;
  };
  for (const r of roots) walk(r, c[0], c[1], c[2], tol, 0);
  const bucket = (v: number) => Math.round(v * 3);
  return [...found.entries()]
    .sort((a, b) => bucket(a[1].d) - bucket(b[1].d) || Number(b[1].leaf) - Number(a[1].leaf) || b[1].depth - a[1].depth)
    .slice(0, limit)
    .map(([name]) => `'${name}'`);
}

/**
 * Whether a shape is painted all over, not at all, or only in parts, read
 * from the tree: paint() marks its result, a wrapper takes its child's
 * state, a union combines its parts. Used to catch `a + b | paint(m)`,
 * which paints only b because `|` binds tighter (measured: a beige lid).
 */
export type PaintState = "all" | "none" | "mixed";
export function paintState(s: Shape3, memo = new Map<Shape3, PaintState>()): PaintState {
  const known = memo.get(s);
  if (known) return known;
  let state: PaintState;
  if (s.painted) state = "all";
  else {
    // A cutter's paint never shows, so a difference or intersection takes only its first shape's state.
    const kids = s.cut && s.inner ? [s.inner[0]] : [...(s.parts ?? s.inner ?? []), ...(s.joint ? [s.joint.child] : []), ...(s.instanced ? [s.instanced.base] : [])];
    if (kids.length === 0) state = "none";
    else {
      const states = new Set(kids.map((k) => paintState(k, memo)));
      state = states.size === 1 ? [...states][0] : "mixed";
    }
  }
  memo.set(s, state);
  return state;
}

/** Warnings for steps that join painted and unpainted parts, once, at the smallest such step. */
export function paintWarnings(evaluation: Evaluation): string[] {
  const memo = new Map<Shape3, PaintState>();
  const geometry = geometrySteps(evaluation);
  const out: string[] = [];
  // paint() over a union whose named parts already had materials of their own repaints them all; when that is
  // what happened, say which parts lost their material (round 4: a bucket's chrome pins went yellow with the arm).
  const names = new Map<Shape3, { name: string; line: number }>();
  for (const st of evaluation.steps) if (isShape3(st.value) && !names.has(st.value)) names.set(st.value, { name: st.name, line: st.line });
  for (const st of evaluation.steps) {
    const v = st.value;
    if (!isShape3(v) || !v.painted || !geometry.has(st.name) || !v.inner?.length) continue;
    const lost: string[] = [];
    const seen = new Set<Shape3>();
    const walk = (n: Shape3) => {
      if (seen.has(n)) return;
      seen.add(n);
      const named = names.get(n);
      if (n.painted && named && n !== v) { lost.push(`'${named.name}'`); return; }
      for (const k of n.parts ?? n.inner ?? []) walk(k);
      if (n.joint) walk(n.joint.child);
    };
    walk(v.inner[0]);
    if (lost.length) out.push(`'${st.name}' (line ${st.line}) paints over parts that already had a material: ${lost.slice(0, 4).join(", ")}${lost.length > 4 ? ", ..." : ""} now show this one. Paint the bare parts before the union, or leave the union unpainted.`);
  }
  const mixed = evaluation.steps.filter((st) => isShape3(st.value) && geometry.has(st.name) && paintState(st.value, memo) === "mixed");
  if (!mixed.length) return out;
  // The smallest mixed step whose children are not themselves mixed is where the mix was made.
  const leafMixed = mixed.filter((st) => {
    const v = st.value as Shape3;
    const kids = v.parts ?? v.inner ?? [];
    return !kids.some((k) => paintState(k, memo) === "mixed");
  });
  const first = (leafMixed.length ? leafMixed : mixed)[0];
  const v = first.value as Shape3;
  const kids = v.parts ?? v.inner ?? [];
  const bare = kids.filter((k) => paintState(k, memo) === "none");
  const named = bare.map((k) => evaluation.steps.find((st) => st.value === k)?.name).filter((n): n is string => !!n);
  const what = named.length ? named.map((n) => `'${n}'`).join(", ") : bare.length ? `${bare.length} part${bare.length === 1 ? "" : "s"} (${bare.map((k) => dimsLabel(k.bounds)).slice(0, 3).join(", ")})` : "a part";
  out.push(`'${first.name}' (line ${first.line}) joins painted and unpainted parts: ${what} ${bare.length > 1 ? "have" : "has"} no material and will render as clay. '|' binds tighter than '+', so \`a + b | paint(m)\` paints only b: wrap the union in parentheses.`);
  return out;
}

/** The pieces row: the count without cavities, and for every piece but the largest its volume, centre and step. */
function piecesRow(physics: Physics, evaluation: Evaluation, cellSize: number): string {
  const solid = physics.pieces.filter((pc) => !pc.cavity);
  if (solid.length <= 1) return `${solid.length}`;
  const rest = solid.slice(1, 5).map((pc) => {
    const at = stepsNear(evaluation, pc.centre, Math.max(pc.size * 0.5, Math.cbrt(Math.abs(pc.volume))) + cellSize * 2);
    return `${fmt(Math.abs(pc.volume))} at (${pc.centre.map(fmt).join(", ")})${at.length ? ` in ${at.join(", ")}` : ""}`;
  });
  return `${solid.length} (the largest ${fmt(Math.abs(solid[0].volume))}; then ${rest.join("; ")}${solid.length > 5 ? "; ..." : ""})`;
}

/** The watertight line, with where the bad edges are and which steps hold them, so it can be acted on. */
function watertightNote(w: ReturnType<typeof watertightReport>, evaluation: Evaluation, cellSize: number): string {
  if (w.ok || !w.where || isEmpty(w.where)) return w.note;
  // Each cluster of bad edges with the geometry steps whose surface passes near it: the parts to look at.
  const spots = (w.clusters ?? []).map((cl) => {
    const steps = stepsNear(evaluation, cl.centre, cellSize * 3, 2);
    return `${cl.count} at (${cl.centre.map(fmt).join(", ")})${steps.length ? ` in ${steps.join(", ")}` : ""}`;
  });
  return `${w.note} The edges are mostly ${spots.join("; ")}.`;
}

/**
 * Many thin-part warnings at once (a scene's chalk lines, teeth, rails) are
 * one problem with one answer, so past three they fold into a line that
 * names the steps and the single grid that covers them all.
 */
export function foldThinWarnings(list: string[]): string[] {
  if (list.length <= 3) return list;
  const names = list.map((w) => w.match(/^'([^']+)'/)?.[1] ?? "?");
  const grids = list.map((w) => Number(w.match(/set grid (\d+)/)?.[1] ?? 0));
  const thinnest = list.map((w) => Number(w.match(/only ([\d.]+)/)?.[1] ?? Infinity));
  const worst = thinnest.indexOf(Math.min(...thinnest));
  return [
    `${list.length} steps are thinner than a grid cell (${names.slice(0, 10).join(", ")}${names.length > 10 ? ", ..." : ""}), the thinnest '${names[worst]}' at ${fmt(thinnest[worst])}: they may be missing or broken in the mesh. Thicken them, or set grid ${Math.max(...grids)} covers them all.`,
  ];
}

/**
 * The surface's extent from a coarse extraction, grown by two coarse cells,
 * within the bounds; the bounds themselves when they are already tight (so a
 * well-bounded model extracts exactly as before) or when nothing was found.
 */
export function tightBounds(shape: Shape3, rays = 48): Bounds {
  const b = shape.bounds;
  if (isEmpty(b)) return b;
  // Rays from each face of the box find the surface's extent; grown by two ray spacings so a part between rays is kept.
  const e = surfaceExtent(shape, rays);
  const bs = boundsSize(b);
  const t: Bounds = {
    min: [0, 1, 2].map((k) => Math.max(b.min[k], e.min[k] - (2 * bs[(k + 1) % 3]) / rays - (2 * bs[(k + 2) % 3]) / rays)) as [number, number, number],
    max: [0, 1, 2].map((k) => Math.min(b.max[k], e.max[k] + (2 * bs[(k + 1) % 3]) / rays + (2 * bs[(k + 2) % 3]) / rays)) as [number, number, number],
  };
  const ts = boundsSize(t);
  const loose = [0, 1, 2].some((k) => ts[k] < bs[k] * 0.94);
  return loose ? t : b;
}

/** The grid and cell size a render of this evaluation would use, from its settings and bounds. */
export function cellFor(evaluation: Evaluation, gridOverride?: number): { grid: number; cellSize: number } {
  const grid = Math.max(8, Math.round(gridOverride ?? (evaluation.settings.grid as number | undefined) ?? 128));
  const b = evaluation.output?.bounds;
  if (!b || isEmpty(b)) return { grid, cellSize: 0 };
  const s = boundsSize(b);
  return { grid, cellSize: Math.max(s[0], s[1], s[2]) / grid };
}

/** Parse and evaluate only: what `aixle check` does. `sourceName` lets imports resolve. */
export function check(source: string, sourceName = "model.aix", log?: (line: string) => void, jointAngles?: Record<string, [number, number, number]>): Evaluation {
  return evaluate(parse(source), { resolveImport: importResolver(sourceName, log), jointAngles });
}

export function run(source: string, sourceName: string, outDir: string, opts: RunOptions = {}): RunResult {
  const log = opts.log ?? (() => {});
  const timings: Record<string, number> = {};
  const time = <T>(key: string, f: () => T): T => {
    const t0 = performance.now();
    const r = f();
    timings[key] = Math.round(performance.now() - t0);
    return r;
  };
  const name = basename(sourceName).replace(/\.[^.]+$/, "") || "model";
  const files: string[] = [];
  const write = (file: string, data: Buffer | string) => {
    writeFileSync(join(outDir, file), data);
    files.push(file);
  };
  mkdirSync(outDir, { recursive: true });

  // Evaluate once at rest to learn the poses, then again with the pose to show (if any); imports are cached across both.
  const resolver = importResolver(sourceName, log);
  const program = parse(source);
  const rest = time("evaluate", () => evaluate(program, { resolveImport: resolver }));
  const shownPose = opts.pose ?? (typeof rest.settings.pose === "string" ? rest.settings.pose : undefined);
  const shownAngles = shownPose ? rest.poses.find((p) => p.name === shownPose)?.angles : undefined;
  const evaluation = shownAngles ? evaluate(program, { resolveImport: resolver, jointAngles: shownAngles }) : rest;
  const warnings = [...evaluation.warnings];
  // Set by a quick pass that dropped thin steps: the pieces count is then not worth a warning.
  let quickDropped = 0;
  // A focused render's close-up mesh judged on its own (round 4: a focus sheet could not say whether the lug was sound).
  let closeUpNote: string | undefined;
  if (shownPose && !shownAngles && shownPose !== "rest") warnings.push(`pose ${shownPose}: no such pose (poses: ${rest.poses.map((p) => p.name).join(", ") || "none"}); showing rest`);
  const shapeAt: ShapeAt = (angles) => evaluate(program, { resolveImport: resolver, jointAngles: angles }).output;
  let grid = Math.max(8, Math.round(opts.grid ?? (evaluation.settings.grid as number | undefined) ?? opts.defaultGrid ?? 128));
  const size = Math.max(64, Math.round(opts.size ?? (evaluation.settings.size as number | undefined) ?? 512));
  const output = evaluation.output;
  // A quick pass on a model made of thin parts (a clock with a pane, hands, a rod and mouldings) drops half its
  // steps at the quick grid and shows nothing worth judging (measured: 20 of 41 steps). It steps the grid up, to
  // 128 at most, until fewer than a quarter of the geometry steps are thinner than the cell; still a few seconds.
  if (opts.quick && output && !isEmpty(output.bounds)) {
    const geometry = geometrySteps(evaluation).size || 1;
    const longest = Math.max(...boundsSize(output.bounds));
    for (const g of [grid, 96, 128]) {
      if (g < grid) continue;
      grid = g;
      if (thinWarnings(evaluation, longest / g, g).length <= geometry / 4) break;
    }
  }
  // Joints and poses: the sheet shows `set pose` (rest by default); exports are always at rest.
  const joints = output ? allJoints(output) : [];
  const jointNames = joints.map((j) => j.joint!.name);
  const poseViews: PoseView[] = evaluation.poses.map((p) => ({ name: p.name, angles: p.angles }));
  const azimuth = opts.azimuth ?? (evaluation.settings.azimuth as number | undefined) ?? 35;
  const elevation = opts.elevation ?? (evaluation.settings.elevation as number | undefined) ?? 25;

  let mesh: Mesh | undefined;
  let bounds: Bounds | undefined;
  let trueBounds: Bounds | undefined;
  let cellSize = 0;
  const lines: string[] = [`# ${name}`, "", `Source: \`${sourceName}\`  Output: \`${evaluation.outputName}\``, ""];

  if (!output) {
    warnings.push("The program made no 3D shape. Assign a shape to a name, or `show` one.");
  } else if (isEmpty(output.bounds)) {
    warnings.push(`'${evaluation.outputName}' is empty: nothing to render. A difference may have removed everything, or an intersection may not overlap.`);
  } else {
    bounds = output.bounds;
    // The box sets the cell size, and a rotated joint or a blend leaves it loose (measured: a posed excavator's box
    // was twice its surface, costing a third of the resolution), so find the surface's extent coarsely first.
    const extractBox = time("extent", () => tightBounds(output));
    let nets = time("mesh", () => surfaceNets(output, { resolution: grid, sharp: opts.sharp ?? evaluation.settings.sharp !== 0, bounds: extractBox }));
    // The safety net: if the mesh reaches a face of a tightened box, something was cut off there (a part thinner than
    // the rays' spacing), so extract again over the whole bounds rather than ship a clipped model.
    if (extractBox !== output.bounds && triangleCount(nets.mesh) > 0) {
      const mb = meshBounds(nets.mesh);
      const near = nets.cellSize * 1.5;
      const clipped = [0, 1, 2].some((k) => (extractBox.min[k] > output.bounds.min[k] + near && mb.min[k] < extractBox.min[k] + near) || (extractBox.max[k] < output.bounds.max[k] - near && mb.max[k] > extractBox.max[k] - near));
      if (clipped) {
        log(`extent: the surface reaches the tightened box, so extracting over the full bounds instead`);
        nets = time("mesh", () => surfaceNets(output, { resolution: grid, sharp: opts.sharp ?? evaluation.settings.sharp !== 0 }));
      }
    }
    mesh = nets.mesh;
    cellSize = nets.cellSize;
    log(`mesh: ${triangleCount(mesh)} triangles, cell ${fmt(cellSize)} (${nets.dims.join("×")} cells, ${nets.samples} samples) in ${timings.mesh} ms`);
    if (nets.nanSamples > 0)
      warnings.push(`The distance field is NaN at ${nets.nanSamples} of ${nets.samples} samples, so parts of the model are missing: look for a scale of 0, a zero-size primitive, or a blend radius that is not a number.`);
    if (triangleCount(mesh) === 0)
      warnings.push(`'${evaluation.outputName}' has bounds ${dimsLabel(output.bounds)} but no surface was found inside them at grid ${grid}: it may be thinner than a cell (${fmt(cellSize)}), or empty.`);
    const s = boundsSize(bounds);
    const thin = Math.min(s[0], s[1], s[2]);
    // A quick pass judges thinness at the grid the full render will use, or every quick sheet would cry wolf.
    const fullGrid = opts.quick ? Math.max(8, Math.round((evaluation.settings.grid as number | undefined) ?? opts.defaultGrid ?? 128)) : grid;
    const fullCell = opts.quick ? (cellSize * grid) / fullGrid : cellSize;
    if (thin > 0 && thin < fullCell * 3)
      warnings.push(`The model is only ${fmt(thin)} units thin on one axis, about ${fmt(thin / fullCell)} cells; raise the grid (set grid 256) if it looks broken.`);
    warnings.push(...foldThinWarnings(thinWarnings(evaluation, fullCell, fullGrid)));
    warnings.push(...paintWarnings(evaluation));
    if (opts.quick) {
      // The quick cell drops what the full grid keeps; say so on the sheet rather than let a missing plank look like a bug.
      const dropped = [...new Set(thinWarnings(evaluation, cellSize, grid).map((w) => w.match(/^'([^']+)'/)?.[1] ?? "?"))];
      if (dropped.length) {
        quickDropped = dropped.length;
        warnings.push(`quick pass: ${dropped.length} step${dropped.length === 1 ? " is" : "s are"} thinner than this pass's ${fmt(cellSize)} cell and may be missing or broken on this sheet (${dropped.slice(0, 6).join(", ")}${dropped.length > 6 ? ", ..." : ""}), so the pieces count is not judged here; the full render at grid ${fullGrid} has cell ${fmt(fullCell)}.`);
      }
    }
    // The true extent comes from the mesh: bounds are boxes, and a difference keeps the left side's box
    // however much was cut away, so a note based on bounds once told a scene on the floor to ground() itself.
    const extent = triangleCount(mesh) > 0 ? meshBounds(mesh) : bounds;
    if (extent.min[1] < -cellSize)
      lines.push(`Note: the lowest point of the surface is at y = ${fmt(extent.min[1])}; pipe the model through ground() to rest it on y = 0.`, "");
    else if (extent.min[1] > cellSize * 2)
      lines.push(`Note: the surface floats: its lowest point is at y = ${fmt(extent.min[1])}. ground() rests it on y = 0 (by bounds, which may be looser than the surface).`, "");
    trueBounds = extent;
  }

  if (mesh && bounds && output) {
    const views = opts.views ?? ["persp", "front", "right", "top"];
    // Views frame the surface's true extent, or the focused step's bounds.
    const focusName = opts.focus ?? (typeof evaluation.settings.focus === "string" ? evaluation.settings.focus : undefined);
    let frame = trueBounds ?? bounds;
    let shownName = evaluation.outputName;
    if (focusName) {
      const st = evaluation.steps.find((x) => x.name === focusName && isShape3(x.value));
      const obj = evaluation.objects.find((o) => o.name === focusName);
      const fs = st ? (st.value as Shape3) : obj?.shape;
      if (fs && !isEmpty(fs.bounds)) {
        // The step's surface, not its box: a joint's box is the box of a turned box (measured: focus on a boom framed the whole machine).
        // Carried through the joints and transforms above it, so a bucket inside a turned joint is framed where the
        // pose put it, not where it was built (measured: --focus in a pose framed the rest position).
        const own = tightBounds(fs);
        const fb = (output && st ? placedBounds(output, fs, own) : undefined) ?? own;
        const grow = Math.max(...boundsSize(fb)) * 0.08;
        frame = { min: [fb.min[0] - grow, fb.min[1] - grow, fb.min[2] - grow], max: [fb.max[0] + grow, fb.max[1] + grow, fb.max[2] + grow] };
        shownName = `${evaluation.outputName} → ${focusName}`;
      } else warnings.push(`focus ${focusName}: no such step or object; framing the whole model`);
    }
    // A focused sheet is a close-up: the model clipped to the frame and re-extracted at the frame's own cell, so a
    // lantern in a market is drawn with a lantern's detail rather than the market's (measured: a blob of six cells).
    let viewMesh = mesh, viewCell = cellSize;
    if (focusName && frame !== (trueBounds ?? bounds)) {
      const fc = boundsCenter(frame), fsz = boundsSize(frame);
      const clipBox = move(box(fsz[0], fsz[1], fsz[2]), fc[0], fc[1], fc[2]);
      // The cut faces keep the model's own material rather than the clay of the clipping box (measured: a marble
      // base read as an unpainted part on a focus sheet).
      const clip: Shape3 = {
        kind: "shape3",
        dist: (x, y, z) => Math.max(output.dist(x, y, z), clipBox.dist(x, y, z)),
        hit: (x, y, z) => { const q = output.hit(x, y, z); return { ...q, d: Math.max(q.d, clipBox.dist(x, y, z)) }; },
        bounds: frame,
        cost: output.cost + 1,
      };
      const close = time("focus", () => surfaceNets(clip, { resolution: grid, sharp: opts.sharp ?? evaluation.settings.sharp !== 0, bounds: frame }));
      if (triangleCount(close.mesh) > 0) {
        viewMesh = close.mesh; viewCell = close.cellSize;
        // The close-up is meshed at its own, finer cell, so its edges are a second reading of the same surface: the
        // clip faces are open by construction, so only edges away from the frame's faces count.
        const inside = (p: [number, number, number]) => [0, 1, 2].every((k) => p[k] > frame.min[k] + close.cellSize * 1.5 && p[k] < frame.max[k] - close.cellSize * 1.5);
        const w = watertightReport(close.mesh);
        const clusters = (w.clusters ?? []).filter((cl) => inside(cl.centre));
        closeUpNote = clusters.length
          ? `not watertight at cell ${fmt(close.cellSize)}: ${clusters.map((cl) => `${cl.count} edges at (${cl.centre.map(fmt).join(", ")})${stepsNear(evaluation, cl.centre, close.cellSize * 3, 2).length ? ` in ${stepsNear(evaluation, cl.centre, close.cellSize * 3, 2).join(", ")}` : ""}`).join("; ")} (edges on the frame's own faces are not counted)`
          : `yes at cell ${fmt(close.cellSize)} (the clip faces of the frame are not counted)`;
      }
    }
    const info = { name: shownName, bounds: frame, triangles: triangleCount(viewMesh), cellSize: viewCell, warnings: warnings.length, azimuth, elevation };
    time("sheet", () => write("sheet.png", renderSheet(viewMesh, info, size).toPng()));
    for (const v of views) time(`view:${v}`, () => write(`${v}.png`, renderView(viewMesh, info, v, size, { azimuth, elevation }).toPng()));
    if (opts.slices !== false) {
      const at: Partial<Record<"x" | "y" | "z", number>> = {};
      for (const axis of ["x", "y", "z"] as const) {
        const v = evaluation.settings[`slice_${axis}`];
        if (typeof v === "number") at[axis] = v;
      }
      // A scene's default cut goes through its first object, which is the one to list first; a focus wins over that.
      const first = evaluation.objects.length > 1 && !focusName ? evaluation.objects[0].shape.bounds : undefined;
      const sliceInfo = first && !isEmpty(first) ? { ...info, bounds: first, name: `${info.name} → ${evaluation.objects[0].name}` } : info;
      time("slices", () => write("slices.png", renderSlices(output, sliceInfo, Math.round(size * 0.75), at).toPng()));
    }
    if (opts.turntable !== false) time("turntable", () => write("turntable.png", renderTurntable(mesh!, info, Math.round(size / 2)).toPng()));
    const textureSize = Math.round(opts.texture ?? (evaluation.settings.texture as number | undefined) ?? 1024);
    if (opts.obj !== false || opts.glb !== false) {
      // Exports come from the node tree at rest: an object per scene entry, a node per joint and per placement.
      const hierarchy = time("hierarchy", () => buildHierarchy(rest.objects, { cellSize, sharp: opts.sharp ?? evaluation.settings.sharp !== 0, texture: textureSize > 0 ? Math.max(64, textureSize) : 0 }));
      const nodes = flatten(hierarchy).length;
      log(`exports: ${hierarchy.meshes.length} mesh${hierarchy.meshes.length === 1 ? "" : "es"} in ${nodes} node${nodes === 1 ? "" : "s"}, ${hierarchy.triangles} triangles${hierarchy.atlas ? `, atlas ${textureSize}px with ${hierarchy.atlasCharts} charts` : ""}, in ${timings.hierarchy} ms`);
      if (hierarchy.atlas) write("model.png", hierarchy.atlas.toPng());
      const glbAnimations: GlbAnimation[] = evaluation.animations
        .filter((a) => a.poses.every((pn) => pn === "rest" || poseViews.some((v) => v.name === pn)))
        .map((a) => {
          const keys = a.poses.map((pn) => poseViews.find((v) => v.name === pn) ?? { name: "rest", angles: {} });
          const times = keys.map((_, i) => (keys.length === 1 ? 0 : (i / (keys.length - 1)) * a.seconds));
          const rotations: Record<string, [number, number, number, number][]> = {};
          for (const j of joints) {
            const jn = j.joint!.name;
            rotations[jn] = keys.map((k) => { const an = k.angles[jn] ?? [0, 0, 0]; return eulerToQuat(an[0], an[1], an[2]); });
          }
          return { name: a.name, times, rotations };
        });
      if (opts.obj !== false) {
        const { obj, mtl } = toObjScene(hierarchy, name, "model.mtl", hierarchy.atlas ? "model.png" : undefined);
        write("model.obj", obj);
        write("model.mtl", mtl);
        // The STL is the model as shown, posed if a pose is set: what a printer would print.
        write("model.stl", toStl(mesh!, name));
      }
      if (opts.glb !== false) {
        const glb = toGlbScene(hierarchy, name, glbAnimations);
        write("model.glb", glb);
        if (opts.viewer !== false) write("viewer.html", viewerHtml(glb, evaluation.outputName, bounds, hierarchy.triangles, glbAnimations.map((a) => a.name)));
      }
    }
    if (joints.length > 0 && opts.poses !== false) {
      // Pose thumbnails are meshed at 1.5 cells: measured, 2 cells at a 0.35 sheet was too coarse to tell a
      // bent elbow from a broken one; a full-size check of one pose is `set pose name` or `--pose name`.
      const poseCell = cellSize * 1.5;
      time("poses", () => write("poses.png", renderPoses(shapeAt, jointNames, poseViews, Math.round(size * 0.5), poseCell, azimuth, elevation).toPng()));
      for (const a of evaluation.animations) {
        const keys = a.poses.map((pn) => poseViews.find((v) => v.name === pn) ?? { name: "rest", angles: {} });
        time(`anim:${a.name}`, () => write(`anim_${a.name}.png`, renderAnimation(shapeAt, jointNames, a.name, keys, a.seconds, Math.round(size * 0.35), poseCell, 8, azimuth, elevation).toPng()));
      }
    }
    if (opts.beauty || evaluation.settings.beauty === 1) {
      const bsize = Math.max(64, Math.round(opts.beautySize ?? size));
      const lightSize = typeof evaluation.settings.light_size === "number" ? evaluation.settings.light_size : undefined;
      const dof = typeof evaluation.settings.dof === "number" ? evaluation.settings.dof : undefined;
      const lightAzimuth = typeof evaluation.settings.light_azimuth === "number" ? evaluation.settings.light_azimuth : undefined;
      const lightElevation = typeof evaluation.settings.light_elevation === "number" ? evaluation.settings.light_elevation : undefined;
      const ambient = typeof evaluation.settings.ambient === "number" ? evaluation.settings.ambient : undefined;
      const zoom = opts.zoom ?? (typeof evaluation.settings.zoom === "number" ? evaluation.settings.zoom : undefined);
      // Framed like the views: on the focused step when there is one.
      time("beauty", () => write("beauty.png", renderBeauty(output, mesh!, frame, { size: bsize, cellSize, azimuth, elevation, lightSize, dof, lightAzimuth, lightElevation, ambient, zoom, label: `${shownName}  ${dimsLabel(frame)}` }).toPng()));
      log(`beauty render ${bsize}px in ${timings.beauty} ms`);
    }
  }

  const shapeSteps = evaluation.steps.filter((s) => isShape3(s.value));
  if (opts.steps !== false && shapeSteps.length > 0) {
    const views: StepView[] = time("steps:mesh", () =>
      meshSteps(
        shapeSteps.map((s) => ({ name: s.name, shape: s.value as Shape3, used: evaluation.used.has(s.name), line: s.line })),
        cellSize,
        96,
        output && mesh ? { shape: output, mesh } : undefined,
      ),
    );
    for (const st of views)
      if (st.used && st.mesh && !st.coarse && triangleCount(st.mesh) === 0)
        warnings.push(`'${st.name}' (line ${st.line}) has bounds ${dimsLabel(st.shape.bounds)} but no surface: it is missing from the model. A zero blend radius or scale, or a part thinner than a cell?`);
    time("steps", () => write("steps.png", renderSteps(views, Math.round(size * 0.35)).toPng()));
  }

  // Physical checks: mass, centre of mass, stability, pieces.
  let physics: Physics | undefined;
  if (mesh && bounds && triangleCount(mesh) > 0) {
    physics = time("physics", () => analyse(mesh!, cellSize));
    const main = physics.pieces[0];
    // A cavity (an inward shell, a lidded cup's inside) is not a piece; a speck is tiny in volume and in extent, so a
    // small real part (a star finial 0.6 wide) is a loose piece, not a sliver (measured: the two were swapped).
    const cavities = physics.pieces.filter((pc) => pc.cavity);
    const specks = physics.pieces.filter((pc) => !pc.cavity && Math.abs(pc.volume) < Math.abs(main.volume) * 0.001 && pc.size < cellSize * 4);
    const parts = physics.pieces.length - specks.length - cavities.length;
    if (parts > 1 && !evaluation.objects.some((o) => o.shape.instanced) && evaluation.objects.length === 1) {
      // Name the steps whose surface is near each loose piece's centre, smallest first (by the field, not the box:
      // measured, a blended step's box named the wrong part). A piece's centre can be inside a hollow, so the
      // tolerance is the piece's own size.
      const stepsAt = (pc: Piece) => stepsNear(evaluation, pc.centre, Math.cbrt(Math.abs(pc.volume)) + cellSize * 2);
      const loose = physics.pieces.filter((pc) => !specks.includes(pc) && !pc.cavity && pc !== main).slice(0, 4);
      const where = loose.map((pc) => `volume ${fmt(Math.abs(pc.volume))} at (${pc.centre.map(fmt).join(", ")})${stepsAt(pc).length ? ` in ${stepsAt(pc).join(", ")}` : ""}`).join("; ");
      // A quick pass that dropped thin steps has probably dropped the joins too (round 4: every quick sheet of a
      // railed excavator said "4 pieces"); the note above says so instead.
      if (!quickDropped) warnings.push(`The model is ${parts} separate pieces: the largest is ${fmt(Math.abs(main.volume))}, the loose ${loose.length === 1 ? "piece is" : "pieces are"} ${where}${parts - 1 > loose.length ? ", ..." : ""}. A piece not touching the rest floats free: overlap parts slightly, or use scene for separate objects.`);
    }
    if (specks.length) {
      const s0 = specks[0];
      const at = stepsNear(evaluation, s0.centre, s0.size + cellSize * 2);
      warnings.push(`${specks.length} tiny speck${specks.length === 1 ? "" : "s"} of mesh (under 0.1% of the volume and a few cells across): a sliver left by a cut or a part thinner than a cell. The largest is at (${s0.centre.map(fmt).join(", ")})${at.length ? ` in ${at.join(", ")}` : ""}.`);
    }
    if (!physics.stable && physics.footprint.length >= 3)
      warnings.push(`The centre of mass (${physics.centre.map(fmt).join(", ")}) is ${fmt(-physics.stabilityMargin)} units outside the base's footprint: the model would tip over. Widen the base or move weight over it.`);
    else if (physics.stable && physics.stabilityMargin < cellSize * 3)
      warnings.push(`The centre of mass is only ${fmt(physics.stabilityMargin)} units inside the base's footprint: the model would balance, barely.`);
  }

  // The report.
  if (mesh && bounds) {
    const s = boundsSize(bounds);
    lines.push(
      "## Model",
      "",
      "| | |",
      "| --- | --- |",
      `| Size (w × h × d) | ${fmt(s[0])} × ${fmt(s[1])} × ${fmt(s[2])} units |`,
      `| Bounds | x ${fmt(bounds.min[0])}..${fmt(bounds.max[0])}, y ${fmt(bounds.min[1])}..${fmt(bounds.max[1])}, z ${fmt(bounds.min[2])}..${fmt(bounds.max[2])} (a box; loose after a cut, a rotation or a twist) |`,
      ...(trueBounds ? [`| Surface extent | x ${fmt(trueBounds.min[0])}..${fmt(trueBounds.max[0])}, y ${fmt(trueBounds.min[1])}..${fmt(trueBounds.max[1])}, z ${fmt(trueBounds.min[2])}..${fmt(trueBounds.max[2])} (from the mesh) |`] : []),
      `| Triangles | ${triangleCount(mesh)} (${vertexCount(mesh)} vertices) |`,
      `| Volume | ${fmt(Math.abs(meshVolume(mesh)))} cubic units |`,
      `| Grid | ${grid} cells on the longest side, cell ${fmt(cellSize)} units |`,
      `| Watertight | ${watertightNote(watertightReport(mesh), evaluation, cellSize)} |`,
      ...(closeUpNote ? [`| Close-up watertight | ${closeUpNote} |`] : []),
      `| Materials | ${mesh.materials.map((m) => m.name).join(", ") || "none"} |`,
      "",
    );
    if (physics) {
      const density = opts.density ?? (typeof evaluation.settings.density === "number" ? evaluation.settings.density : 1);
      lines.push(
        "## Physics",
        "",
        "| | |",
        "| --- | --- |",
        `| Mass | ${fmt(Math.abs(physics.volume) * density)} at density ${fmt(density)} |`,
        `| Centre of mass | (${physics.centre.map(fmt).join(", ")}) |`,
        `| Base footprint | ${physics.footprint.length >= 3 ? `${physics.footprint.length}-sided hull of the points within ${fmt(cellSize * 1.5)} of y = ${fmt(physics.floor)}` : "none (fewer than three contact points)"} |`,
        `| Stands | ${physics.footprint.length < 3 ? "unknown" : physics.stable ? `yes, centre of mass ${fmt(physics.stabilityMargin)} inside the footprint` : `no, centre of mass ${fmt(-physics.stabilityMargin)} outside the footprint`} |`,
        `| Overhangs | ${(physics.overhang * 100).toFixed(physics.overhang < 0.095 ? 1 : 0)}% of the surface faces down more than 45° above the floor${physics.overhang > 0.005 ? " (a printer would need support there)" : ""} |`,
        `| Pieces | ${piecesRow(physics, evaluation, cellSize)} |`,
        `| Cavities | ${physics.pieces.filter((pc) => pc.cavity).length ? physics.pieces.filter((pc) => pc.cavity).slice(0, 4).map((pc) => `volume ${fmt(Math.abs(pc.volume))} at (${pc.centre.map(fmt).join(", ")})`).join("; ") + " (enclosed voids, not loose parts)" : "none"} |`,
        "",
      );
    }
  }
  if (evaluation.objects.length > 1 || joints.length > 0 || evaluation.poses.length > 0) {
    lines.push("## Assembly", "");
    if (evaluation.objects.length > 1) lines.push(`Objects: ${evaluation.objects.map((o) => `${o.name}${o.shape.instanced ? ` (${o.shape.instanced.placements.length} copies)` : ""}`).join(", ")}`, "");
    if (joints.length) lines.push(`Joints: ${joints.map((j) => `${j.joint!.name} at (${j.joint!.pivot.map(fmt).join(", ")})`).join("; ")}`, "");
    if (evaluation.poses.length) lines.push(`Poses: ${evaluation.poses.map((p) => p.name).join(", ")}${shownPose ? ` (sheet shows "${shownPose}")` : ""}`, "");
    if (evaluation.animations.length) lines.push(`Animations: ${evaluation.animations.map((a) => `${a.name} (${a.poses.join(" → ")}, ${fmt(a.seconds)}s)`).join("; ")}`, "");
  }
  lines.push("## Steps", "", "Sizes and spans are bounding boxes: exact for primitives and unions, loose after a cut (`a - b` keeps a's box), a rotation or a twist; `a & b` tightens to the overlap.", "", "| # | Name | Line | Size | x | y | z | In output |", "| --- | --- | --- | --- | --- | --- | --- | --- |");
  shapeSteps.forEach((st, i) => {
    const sh = st.value as Shape3;
    const b = sh.bounds;
    const span = (k: number) => (isEmpty(b) ? "" : `${fmt(b.min[k])}..${fmt(b.max[k])}`);
    lines.push(`| ${i + 1} | ${st.name} | ${st.line} | ${isEmpty(b) ? "empty" : dimsLabel(b)} | ${span(0)} | ${span(1)} | ${span(2)} | ${evaluation.used.has(st.name) ? "yes" : "no"} |`);
  });
  lines.push("");
  if (warnings.length) {
    lines.push("## Warnings", "");
    for (const w of warnings) lines.push(`- ${w}`);
    lines.push("");
  }
  lines.push("## Files", "");
  const descriptions: Record<string, string> = {
    "sheet.png": "perspective, front, right and top views with grids",
    "persp.png": "perspective view", "front.png": "front view (from +z)", "right.png": "right view (from +x)", "top.png": "top view (from +y)",
    "back.png": "back view", "left.png": "left view", "bottom.png": "bottom view",
    "slices.png": "cross-sections through the centre on each axis",
    "steps.png": "one thumbnail per named shape, in program order; red frames are not in the output",
    "turntable.png": "eight views around the model",
    "model.obj": "Wavefront mesh (with model.mtl and UVs)", "model.stl": "binary STL for a slicer, the model as shown", "model.mtl": "materials for the OBJ, mapped to model.png", "model.glb": "binary glTF with the texture atlas embedded",
    "model.png": "the texture atlas: the materials baked per chart",
    "poses.png": "every pose, rest first",
    "viewer.html": "orbit the GLB in a browser (self-contained; loads three.js from a CDN)",
    "beauty.png": "the field ray-marched with soft shadows and ambient occlusion",
  };
  for (const f of files) lines.push(`- \`${f}\`: ${descriptions[f] ?? (f.startsWith("anim_") ? "frames through the animation" : "")}`);
  lines.push("", `Timings (ms): ${Object.entries(timings).map(([k, v]) => `${k} ${v}`).join(", ")}`, "");
  const report = lines.join("\n");
  write("report.md", report);
  write(
    "report.json",
    JSON.stringify(
      {
        name,
        output: evaluation.outputName,
        bounds,
        size: bounds ? boundsSize(bounds) : undefined,
        triangles: mesh ? triangleCount(mesh) : 0,
        cellSize,
        grid,
        materials: mesh?.materials.map((m) => m.name) ?? [],
        objects: evaluation.objects.map((o) => ({ name: o.name, copies: o.shape.instanced?.placements.length ?? 1 })),
        physics: physics ? { volume: Math.abs(physics.volume), centre: physics.centre, stable: physics.stable, stabilityMargin: physics.stabilityMargin, pieces: physics.pieces.length, overhang: physics.overhang } : undefined,
        joints: joints.map((j) => ({ name: j.joint!.name, pivot: j.joint!.pivot })),
        poses: evaluation.poses.map((p) => p.name),
        animations: evaluation.animations.map((a) => a.name),
        steps: shapeSteps.map((st) => ({
          name: st.name,
          line: st.line,
          bounds: isEmpty((st.value as Shape3).bounds) ? null : (st.value as Shape3).bounds,
          used: evaluation.used.has(st.name),
        })),
        warnings,
        files,
        timings,
      },
      null,
      2,
    ),
  );
  return { name, outDir, evaluation, mesh, bounds, files, warnings, report, timings, physics };
}

/**
 * Two programs side by side: each rendered quickly, their perspective and
 * front views paired, with the size of each in its own bar. For comparing
 * a change against the version before it.
 */
export function diff(a: { source: string; name: string }, b: { source: string; name: string }, outFile: string, opts: { size?: number; grid?: number } = {}): { warnings: string[] } {
  const size = opts.size ?? 320;
  const warnings: string[] = [];
  const side = (prog: { source: string; name: string }) => {
    const ev = check(prog.source, prog.name);
    if (!ev.output || isEmpty(ev.output.bounds)) return { canvases: [] as import("./render/canvas.js").Canvas[], label: `${prog.name}: nothing to show` };
    const nets = surfaceNets(ev.output, { resolution: opts.grid ?? 64 });
    const info = { name: ev.outputName, bounds: ev.output.bounds };
    warnings.push(...ev.warnings.map((w) => `${prog.name}: ${w}`));
    return { canvases: [renderView(nets.mesh, info, "persp", size), renderView(nets.mesh, info, "front", size)], label: `${prog.name}   ${dimsLabel(ev.output.bounds)}   ${triangleCount(nets.mesh)} tris` };
  };
  const left = side(a), right = side(b);
  const out = new Canvas(size * 2 + 12, size * 2 + 12 + 60, INK.page);
  out.fill(0, 0, out.width, 30, INK.bar);
  drawText(out, 10, 8, `A: ${left.label}`, INK.barText, 2);
  out.fill(0, 30, out.width, 30, INK.bar);
  drawText(out, 10, 38, `B: ${right.label}`, 0xf0d060, 2);
  left.canvases.forEach((c, i) => out.blit(c, 4, 64 + i * (size + 4)));
  right.canvases.forEach((c, i) => out.blit(c, size + 8, 64 + i * (size + 4)));
  writeFileSync(outFile, out.toPng());
  return { warnings };
}
