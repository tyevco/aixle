/**
 * From a source file to a folder of things to look at. `run()` is the whole
 * pipeline: parse, evaluate, extract the surface, render the sheets, write
 * the exports and the report. The CLI is a thin wrapper over it, and so is
 * the examples generator.
 */
import { mkdirSync, readFileSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";
import type { MeshSamples } from "./mesh/meshSdf.js";
import type { ImportCache } from "./import/cache.js";
import { imageResolver, importResolver, moduleResolver, STD_DIR, type ModuleSource } from "./resolvers.js";
import { box } from "./sdf/primitives.js";
import { axisAngleToQuat, eulerToQuat, glbLights, toGlbScene, type GlbAnimation } from "./export/glb.js";
import { toObjScene } from "./export/obj.js";
import { toStl } from "./export/stl.js";
import { to3mf } from "./export/threemf.js";
import { toBedrock, toBedrockAnimations, type BedrockClip } from "./export/bedrock.js";
import { ACCESSORY_TRIANGLES, MESHPART_TRIANGLES, toRoblox } from "./export/roblox.js";
import { buildHierarchy, flatten, type KnownMesh } from "./export/hierarchy.js";
import { wearProbe } from "./sdf/materials.js";
import type { Vec3 } from "./core/vec.js";
import { anchorsOf, allJoints, intersect, jointTreeLines, move, placedBounds, placedPoint, placedShape, placedUnder, rotate as rotateShape, scale as scaleShape, surfaceExtent, surfacePoint } from "./sdf/ops.js";
import { INK, interpolatePose, renderAnimation, renderPoses, type PoseCache, type PoseView, type ShapeAt } from "./render/views.js";
import { Canvas } from "./render/canvas.js";
import { drawText, textWidth } from "./render/font.js";
import { viewerHtml, type ViewerScene } from "./export/viewer.js";
import { BENT_DEGREES } from "./export/atlas.js";
import { beautyCache, DEFAULT_LIGHT_DIRECTION, ENVIRONMENTS, environmentPalette, lightContribution, lightDirection, renderBeauty, type BeautyLight, type Environment } from "./render/beauty.js";
import { openBeautyPool, type BeautyPool } from "./render/beauty-pool.js";
import { perspective } from "./render/camera.js";
import { buildEnvironment, environmentLatLong, horizonRadiance, irradiance } from "./render/environment.js";
import { decode, KEY, toLinear } from "./render/photometry.js";
import { hiddenFraction, hiddenFractionRays, renderCallouts } from "./render/callouts.js";
import { assertLine, type AssertInfo, type AssertResult, type ContactRecord, evaluate, type Evaluation, type Settings, type ShapeOrigin, type StepRole } from "./lang/interpreter.js";
import { vecText } from "./lang/builtins.js";
import { parse } from "./lang/parser.js";
import { isShape3 } from "./lang/values.js";
import { meshBounds, meshVolume, triangleCount, vertexCount, watertightReport, weldIndices, type Mesh } from "./mesh/mesh.js";
import { analyse, isSpeck, type Physics, type Piece } from "./mesh/physics.js";
import { surfaceNets } from "./mesh/surfaceNets.js";
import { bedFit, BRIDGE_MM, contactArea, supportVolume, threemfUnit, UNITS, wallThickness, type BedFit, type SupportResult } from "./mesh/print.js";
import { meshSteps, renderSheet, renderSlices, renderSteps, renderTurntable, renderView, turntableFrames, dimsLabel, type StepView, type ViewName } from "./render/views.js";
import { encodeApng, type DecodedPng } from "./render/png.js";
import { boundsCenter, boundsSize, isEmpty, type Bounds, type JointPose, type Shape3 } from "./sdf/types.js";
import { restingContact, sliceLevels } from "./sdf/measure.js";

/**
 * The most triangles the GLB, the OBJ and the viewer page carry unless `set triangles` or `--triangles` says
 * otherwise: past it the export is decimated, seams and creases kept. Measured on the examples at the command
 * line's defaults: a GLB is about 30 bytes a triangle, so 200 thousand is about 6 MB and its viewer page 8. Four
 * of twenty-three examples are over it, at their own grids: the chest (459 thousand; its GLB 13.7 MB to 6.4, its
 * viewer 18.3 to 8.5), the plate of patterns (282), the tin (260) and the rope (205). Each came down with its
 * largest distance from the surface at a face centre the full mesh's own, for 0.5 to 1.3 s more in the exports.
 */
export const WEB_TRIANGLES = 200000;

/** The inner-loop preset: a small grid, the sheet only, no exports. A render in a second or two. */
export const QUICK: RunOptions = { quick: true, grid: 64, size: 320, views: [], steps: false, slices: false, turntable: false, obj: false, glb: false, viewer: false, beauty: false };

/**
 * The lighting and material loop (`--beauty-only`): the sheet and one beauty render, the shot `set camera` or
 * `--camera` names, written once; no light study, no other camera's shot, nothing else (round 11: the "one shot"
 * also wrote the shot again and lights.png, 28 s against the shot's 8).
 */
export const BEAUTY_ONLY: RunOptions = { beauty: true, views: [], steps: false, slices: false, turntable: false, callouts: false, poses: false, animations: false, obj: false, glb: false, viewer: false, shots: false, lights: false };

export interface RunOptions {
  /** A quick pass: the grid is coarse for speed, so thin-part warnings are judged at the grid a full render would use. */
  quick?: boolean;
  /** Write poses.png and the animation strips (default true when the model has joints). */
  poses?: boolean;
  /** false skips the animation strips (the pose sheet stays); a list draws only those animations. */
  animations?: boolean | string[];
  /** false skips the program's asserts. */
  asserts?: boolean;
  /** Cells along the longest side of the model; overrides a `set grid` in the file. Default 128. */
  grid?: number;
  /** Used only when neither `grid` nor the file's `set grid` is given. */
  defaultGrid?: number;
  /** Pixels per view. Default 512. */
  size?: number;
  views?: ViewName[];
  steps?: boolean;
  /** false skips callouts.png, the perspective view with its visible steps named. */
  callouts?: boolean;
  /** A sky for the beauty render, over the program's `set environment`. */
  environment?: string;
  /** Render this declared camera only (beauty.png and the sheet take its view), over the program's `set camera`. */
  camera?: string;
  /** false renders beauty.png alone, not each declared camera's own shot as beauty_<name>.png. */
  shots?: boolean;
  /** false skips lights.png, the light study a program with two or more lights gets with the beauty render. */
  lights?: boolean;
  /** Draw these named steps with the output, as `show output, name` would (each its own object in a scene): a probe or a region seen in place for a picture, the program unchanged. */
  show?: string[];
  slices?: boolean;
  turntable?: boolean;
  obj?: boolean;
  glb?: boolean;
  /** Write viewer.html with the GLB embedded. Default true when the GLB is written. */
  viewer?: boolean;
  /** Bake the materials into a texture atlas of this many pixels square for the exports; 0 disables. Default 1024. */
  texture?: number;
  /** The most triangles the GLB, OBJ and viewer carry, decimated past it (or `set triangles`); 0 for the full mesh. Default WEB_TRIANGLES. */
  triangles?: number;
  /** Ray-march the field for beauty.png. Default false: it costs seconds. */
  beauty?: boolean;
  /** Pixels for the beauty render; default `size`. */
  beautySize?: number;
  /** Threads for the beauty renders: the main one and threads - 1 workers that evaluate the program again; the bytes are the same for any number. Default 1. */
  threads?: number;
  /** Vertex placement: sharp (dual contouring, default) or the rounded surface-nets mean. */
  sharp?: boolean;
  /** Split vertices where faces meet at more than this many degrees, so edges shade and export as edges (or `set crease`); 0 for one smooth normal per vertex. Default 35. */
  crease?: number;
  /** Also write model.3mf beside model.stl and judge the model as a print (both happen anyway when the program sets units or a bed). */
  threemf?: boolean;
  /** Also write model.roblox.glb: the GLB turned to face -Z with a Handle node and `_Att` attachment nodes from the anchors, sized against Roblox's accessory limits (or `set roblox 1`). */
  roblox?: boolean;
  /** Also write Minecraft Bedrock geometry (model.geo.json and its texture) at this many pixels per unit, a unit being a block; 16 is the game's own (or `set minecraft 16`). */
  minecraft?: number;
  /** The Bedrock geometry is an entity's, which faces north: turn the model half a turn about y (or `set minecraft_entity 1`). */
  minecraftEntity?: boolean;
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
  /** Put slices.png's three planes through this named step, framed on it (or `set slice name`). */
  slice?: string;
  /** false leaves the caption (the shot's name and size) off beauty.png and the camera shots (or `set caption 0`). */
  caption?: boolean;
  /** Where an import's samples are kept between runs (the CLI's is on disk, `--no-cache` for none); none by default. */
  importCache?: ImportCache;
  /** Called as each assert starts and ends, in every evaluation of the run (the CLI's AssertClock says what is slow). */
  onAssert?: (phase: "start" | "end", a: AssertInfo) => void;
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
  /** The files an earlier run of the tool wrote into the folder that this run did not write, removed. */
  removed?: string[];
}

/**
 * The names the tool writes into an --out folder: a run removes only these, and only when the folder's last report.json
 * lists them as written by that run, so nothing a person or another tool put there is ever touched.
 */
const OWN_FILE = /^(?:(?:sheet|persp|front|right|top|back|left|bottom|slices|steps|callouts|turntable|poses|lights|environments|beauty|model|model_normal|model_mr|model_emissive|report)\.(?:png|md)|turntable\.apng|viewer\.html|model\.(?:obj|mtl|stl|3mf|glb|roblox\.glb|geo\.json|geo\.png|animation\.json)|(?:beauty|anim)_[^/\\]+\.png)$/;

/** What the run before wrote into `outDir`, from its report.json: the tool's own file names only, none outside the folder. */
function previousFiles(outDir: string): string[] {
  try {
    const json = JSON.parse(readFileSync(join(outDir, "report.json"), "utf8")) as { files?: unknown };
    return Array.isArray(json.files) ? json.files.filter((f): f is string => typeof f === "string" && OWN_FILE.test(f) && !f.includes("..")) : [];
  } catch {
    return [];
  }
}

// Three decimals, or three significant figures below 0.1, so a 0.4-unit drone's 0.006 lens is not "0.01" (round 7).
const fmt = (v: number): string => {
  const s = Number.isInteger(v) ? String(v) : Math.abs(v) < 0.1 && Math.abs(v) >= 0.0005 ? String(Number(v.toPrecision(3))) : v.toFixed(3).replace(/0+$/, "").replace(/\.$/, "");
  return s === "-0" ? "0" : s;
};

// The resolvers live in resolvers.ts, so a beauty worker can evaluate a program without loading the pipeline.
export { imageResolver, importResolver, moduleResolver, STD_DIR };

/**
 * Where a shape's thinnest feature comes from: the path down the tree from
 * the shape, through every child that carries the same size (a union's
 * thinnest part, a move or a paint of it, a joint's child) and through a
 * transform that scales it, to the node that introduced it (a box's thin
 * side, a shell, a curve2 band, an extruded outline). The last node is the
 * feature's source; two steps with the same source, or with sources one call made (sourceKey), are one thin part.
 */
export function featureSource(s: Shape3): Shape3[] {
  const path = [s];
  let n = s;
  for (let guard = 0; guard < 512 && n.feature !== undefined; guard++) {
    const kids = [...(n.parts ?? n.inner ?? []), ...(n.joint ? [n.joint.child] : []), ...(n.instanced ? [n.instanced.base] : [])];
    let next = kids.find((c) => c.feature === n.feature);
    if (!next && n.transform && kids.length === 1 && kids[0].feature !== undefined) next = kids[0];
    if (!next) break;
    path.push(next);
    n = next;
  }
  return path;
}

/**
 * What makes two thin features one part: the call that made the source (its builtin, line, def and library) and
 * the feature's size. The slats a loop builds, or the legs a def called four times builds, are each a new node from
 * one call, and would otherwise each be named, under the step that brought the first one in and again under the
 * output; a source no call recorded is known by itself.
 */
function sourceKey(evaluation: Evaluation, s: Shape3): Shape3 | string {
  const path = featureSource(s);
  const node = path[path.length - 1];
  let origin: ShapeOrigin | undefined;
  for (let i = path.length - 1; i >= 0 && !origin; i--) origin = evaluation.origins?.get(path[i]);
  if (!origin || node.feature === undefined) return node;
  return `${origin.callee}|${origin.line}|${origin.def ?? ""}|${origin.file ?? ""}|${Number(node.feature.toPrecision(6))}`;
}

/** A library's path as its `use` gave it, as a file name. */
const libraryFile = (f: string): string => (f.endsWith(".aix") ? f : `${f}.aix`);

/**
 * The thin member a step carries, as well as it can be named: the call that
 * made it (and the def and library file it was in), where it is in the
 * model (the point a profile knows, or its box), and for an extruded or
 * revolved outline the point in the profile's own plane. Round 11: a 0.1
 * back panel built inside a library's case() was named only as 'plate', the
 * step that called case(); a sliver on a 46-point outline had no place.
 */
export function thinMember(evaluation: Evaluation, step: { name: string; line: number; value: Shape3 }): { made?: string; short?: string; where?: string } {
  const path = featureSource(step.value);
  const node = path[path.length - 1];
  let origin: ShapeOrigin | undefined;
  for (let i = path.length - 1; i >= 0 && !origin; i--) origin = evaluation.origins?.get(path[i]);
  // The step's own call says nothing the step's name and line do not.
  const own = !origin || (!origin.def && !origin.file && origin.line === step.line);
  const madeAt = origin && !own ? `${origin.callee}()${origin.def ? ` in def ${origin.def}` : ""} at ${origin.file ? `${libraryFile(origin.file)} ` : ""}line ${origin.line}` : undefined;
  // Where the output puts it, through every transform and joint above it; the step's own frame when it is not there.
  const roots = [...(evaluation.objects.length ? evaluation.objects.map((o) => o.shape) : evaluation.output ? [evaluation.output] : []), step.value];
  let where: string | undefined;
  for (const root of roots) {
    if (node.featureAt) {
      const p = placedPoint(root, node, node.featureAt);
      if (p) { where = `at (${p.map(fmt).join(", ")})`; break; }
    } else if (!isEmpty(node.bounds)) {
      // The member's box, when it says more than the step's own: a part of a def, or a part much smaller than its step.
      const b = placedBounds(root, node, node.bounds);
      const sb = placedBounds(root, step.value, step.value.bounds) ?? step.value.bounds;
      if (!b) continue;
      const smaller = [0, 1, 2].some((k) => b.max[k] - b.min[k] < 0.9 * (sb.max[k] - sb.min[k]));
      if (origin?.def || origin?.file || smaller) where = `within x ${fmt(b.min[0])}..${fmt(b.max[0])} y ${fmt(b.min[1])}..${fmt(b.max[1])} z ${fmt(b.min[2])}..${fmt(b.max[2])}`;
      break;
    }
  }
  const fp = node.featureProfile;
  const profileStep = fp ? evaluation.steps.find((st) => st.value === fp.profile) : undefined;
  const inProfile = fp ? `(${fp.at.map(fmt).join(", ")}) in ${profileStep ? `the profile '${profileStep.name}' (line ${profileStep.line})` : "its profile"}` : undefined;
  const whereText = [where ? `${where} in the model` : "", inProfile ?? ""].filter(Boolean).join(", ");
  return {
    made: madeAt,
    where: whereText || undefined,
    short: madeAt ?? (inProfile ? `${where ?? ""}${where ? ", " : ""}${inProfile}` : undefined),
  };
}

/**
 * A part thinner than about a cell on any axis can drop out of the mesh
 * entirely (measured: rails at 0.9 of a cell vanished, a plate at 1.3
 * survived); say so from its bounds alone, so `check` can say it too.
 */
export function thinWarnings(evaluation: Evaluation, cellSize: number, grid: number, thin = 1.2): string[] {
  return thinParts(evaluation, cellSize, grid, thin).map((p) => p.text);
}

/** The thin-part warnings with the step each names and the member as short as it can be said, for the quick pass's list. */
export function thinParts(evaluation: Evaluation, cellSize: number, grid: number, thin = 1.2): { step: string; member?: string; text: string }[] {
  const out: { step: string; member?: string; text: string }[] = [];
  const gridFor = (t: number) => Math.min(512, Math.ceil((grid * 2.5 * cellSize) / t));
  const reportedFeatures = new Set<number>();
  // A feature is reported once, at the step that brought it in, and known by where it came from, not by its size:
  // a bowl's 0.05 band went unnamed beside a 0.05 hook that had been named first (round 11).
  const reportedSources = new Set<Shape3 | string>();
  const notedShapes = new Set<Shape3>();
  const geometry = geometrySteps(evaluation);
  for (const st of evaluation.steps) {
    if (!isShape3(st.value) || !geometry.has(st.name) || isEmpty(st.value.bounds)) continue;
    const step = { name: st.name, line: st.line, value: st.value };
    const ss = boundsSize(st.value.bounds);
    const t = Math.min(ss[0], ss[1], ss[2]);
    if (t > 0 && t < cellSize * thin) {
      // Thin only because a part already named is (two copies of a rod side by side): one thin part, named once.
      const f0 = st.value.feature;
      if (f0 !== undefined && Math.abs(f0 - t) <= 1e-9 * Math.max(1, t) && reportedSources.has(sourceKey(evaluation, st.value))) continue;
      const m = thinMember(evaluation, step);
      out.push({ step: st.name, member: m.made, text: `'${st.name}' (line ${st.line}) is only ${fmt(t)} units thin, ${fmt(t / cellSize)} of the ${fmt(cellSize)} cell${m.made ? ` (${m.made})` : ""}: it may be missing or broken in the mesh. Thicken it to ${fmt(cellSize * 2)} (two cells) or raise the grid (set grid ${gridFor(t)}).` });
      // Its own feature is settled too, or the union above it would repeat the warning under its own name
      // (measured: 'house', forty parts, listed as thin for its mullion).
      if (st.value.feature !== undefined) reportedSources.add(sourceKey(evaluation, st.value));
      continue;
    }
    // An import is one step: nothing in its mesh thinner than its sampling cell survived, whatever the render grid.
    if (st.value.sampledAt !== undefined && st.value.sampledAt > cellSize * 1.05) {
      out.push({ step: st.name, text: `'${st.name}' (line ${st.line}) is an import sampled at cell ${fmt(st.value.sampledAt)}, coarser than this render's ${fmt(cellSize)}: anything in its mesh thinner than about ${fmt(st.value.sampledAt * 1.2)} (rails, hooks, rungs) is gone or broken, whatever the grid. Give import() resolution=${Math.ceil(Math.max(...boundsSize(st.value.bounds)) / cellSize)} to match.` });
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
        out.push({
          step: st.name,
          text:
            g <= 0
              ? `'${st.name}' (line ${st.line}): ${what} closes up at this weight. Use ${fix}.`
              : g < cellSize * 0.5
                ? `'${st.name}' (line ${st.line}): ${what} is only ${fmt(g)} wide, ${fmt(g / cellSize)} of the ${fmt(cellSize)} cell, and closes up in the mesh. Use ${fix}, or raise the grid (set grid ${gridFor(g)}).`
                : `'${st.name}' (line ${st.line}): ${what} is ${fmt(g)} wide, ${(g / cellSize).toFixed(2)} of the ${fmt(cellSize)} cell, so the mesh there may not be watertight. For a print or a clean GLB use ${fix}, or raise the grid (set grid ${gridFor(g)}).`,
        });
      }
    }
    // What the constructor itself noticed, once, at the step that made it (a curve bent tighter than its tube).
    if (st.value.notes && !notedShapes.has(st.value)) {
      notedShapes.add(st.value);
      for (const note of st.value.notes) out.push({ step: st.name, text: `'${st.name}' (line ${st.line}): ${note}` });
    }
    // A wall, tube or stroke inside a thick step: bounds cannot see it, so the shape carries the size itself.
    // Reported once per source, at the step that introduced it, not again at every step built on top; named by the
    // call that made it and placed in the model.
    const f = st.value.feature;
    if (f === undefined || !(f > 0) || f >= cellSize * thin) continue;
    const key = sourceKey(evaluation, st.value);
    if (reportedSources.has(key)) continue;
    reportedSources.add(key);
    const m = thinMember(evaluation, step);
    const said = [m.made ? `made by ${m.made}` : "", m.where ?? ""].filter(Boolean).join(", ");
    out.push({ step: st.name, member: m.short, text: `'${st.name}' (line ${st.line}) has a part (a wall, slat, rod, tube at its thin end, or stroke) only ${fmt(f)} thick, ${fmt(f / cellSize)} of the ${fmt(cellSize)} cell${said ? `, ${said}` : ""}: it may be missing or broken in the mesh. Thicken it to ${fmt(cellSize * 2)} (two cells) or raise the grid (set grid ${gridFor(f)}).` });
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
  // A hard union read by a larger one is folded into its list, so the step is no node of the tree, only its parts
  // are: it is geometry when they all are (round 11: slats gathered in a loop, `m = slats + top`, lost their thin
  // warning to the whole model once the loop's own `slat` was no step).
  const folded = (v: Shape3) => !!v.parts?.length && v.parts.every((p) => reachable.has(p));
  for (const st of evaluation.steps) if (isShape3(st.value) && (reachable.has(st.value) || folded(st.value))) out.add(st.name);
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
function stepsNearDetailed(evaluation: Evaluation, c: [number, number, number], tol: number): { name: string; leaf: boolean; d: number; parents: string[] }[] {
  const names = new Map<Shape3, string>();
  for (const st of evaluation.steps) if (isShape3(st.value) && !names.has(st.value)) names.set(st.value, st.name);
  const roots = evaluation.objects.length ? evaluation.objects.map((o) => o.shape) : evaluation.output ? [evaluation.output] : [];
  // Every named shape within reach, with how close its surface passes, its depth in the tree and whether it is
  // innermost: the closest first (by the cell, so a hand's tip a fifth of a cell from a recess wall names both, not
  // a dial a whole cell away: measured on a clock), then innermost, then the nearest ancestors.
  const found = new Map<string, { d: number; depth: number; leaf: boolean; parents: Set<string>; exposed: boolean }>();
  // The whole model's field, for telling an exposed surface from a buried one.
  const modelDist = roots.length ? (x: number, y: number, z: number) => Math.min(...roots.map((r) => r.dist(x, y, z))) : undefined;
  // The forward maps of the nodes walked through so far, to carry a point in a child's frame back to the world.
  const warps: ((x: number, y: number, z: number) => Vec3)[] = [];
  const toWorld = (p: Vec3): Vec3 => { let q = p; for (let i = warps.length - 1; i >= 0; i--) q = warps[i](q[0], q[1], q[2]); return q; };
  let budget = 20000;
  // Returns whether a named step at or below `n` was within reach of the point.
  const walk = (n: Shape3, x: number, y: number, z: number, t: number, depth: number, parent: string): boolean => {
    if (--budget < 0 || isEmpty(n.bounds)) return false;
    const b = n.bounds;
    if (x < b.min[0] - t || x > b.max[0] + t || y < b.min[1] - t || y > b.max[1] + t || z < b.min[2] - t || z > b.max[2] + t) return false;
    const dn = Math.abs(n.dist(x, y, z));
    if (dn > t) return false;
    let cx = x, cy = y, cz = z, ct = t;
    const pushed = !!(n.unwarp && n.warp);
    if (pushed) warps.push(n.warp!);
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
    const name = names.get(n);
    const here = name ?? parent;
    for (const k of n.parts ?? n.inner ?? []) if (walk(k, cx, cy, cz, ct, depth + 1, here)) below = true;
    if (n.instanced && !n.parts) below = walk(n.instanced.base, cx, cy, cz, ct, depth + 1, here) || below;
    if (pushed) warps.pop();
    if (name === undefined) return below;
    const prev = found.get(name);
    const parents = prev?.parents ?? new Set<string>();
    if (parent) parents.add(parent);
    // Exposed or buried: the step's nearest surface point, read back in the model, sits on the outside (the part
    // the edge is on) or inside another part (a cap ending inside a housing, which is not the part to name).
    let exposed = prev?.exposed ?? false;
    if (!exposed && modelDist) {
      const q = surfacePoint(n, x, y, z);
      // Back to the world through the transforms above (the walk pulled the point into this node's frame).
      const w = toWorld(q);
      exposed = modelDist(w[0], w[1], w[2]) > -tol * 0.5;
    }
    found.set(name, { d: Math.min(dn / t, prev?.d ?? Infinity), depth: Math.max(depth, prev?.depth ?? 0), leaf: !below || (prev?.leaf ?? false), parents, exposed });
    return true;
  };
  for (const r of roots) walk(r, c[0], c[1], c[2], tol, 0, "");
  const bucket = (v: number) => Math.round(v * 3);
  return [...found.entries()]
    .sort((a, b) => Number(b[1].exposed) - Number(a[1].exposed) || bucket(a[1].d) - bucket(b[1].d) || Number(b[1].leaf) - Number(a[1].leaf) || b[1].depth - a[1].depth)
    .map(([name, f]) => ({ name, leaf: f.leaf, d: f.d, parents: [...f.parents] }));
}

/** The names near a point, quoted, at most `limit`: what the warnings print. */
export function stepsNear(evaluation: Evaluation, c: [number, number, number], tol: number, limit = 2): string[] {
  return stepsNearDetailed(evaluation, c, tol).slice(0, limit).map((n) => `'${n.name}'`);
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

/**
 * A cut that removes almost nothing: `a - b` where b's box overlaps a's
 * but the material both cover is under a few cells, or none (measured: a
 * bishop's slot cut 0.014 thick, tangent to the mitre, left no mark and
 * no message). The overlap of the two boxes is sampled on a fixed
 * lattice, so the estimate is the same every run.
 */
export function cutWarnings(evaluation: Evaluation, cellSize: number): string[] {
  const out: string[] = [];
  if (!(cellSize > 0)) return out;
  const geometry = geometrySteps(evaluation);
  for (const st of evaluation.steps) {
    const v = st.value;
    if (!isShape3(v) || !v.cut || !v.inner || v.inner.length < 2 || !geometry.has(st.name)) continue;
    const a = v.inner[0], b = v.inner[1];
    if (isEmpty(a.bounds) || isEmpty(b.bounds)) continue;
    // An intersection keeps what both cover; a difference removes it. Either way the shared material is the measure.
    const lo = [0, 1, 2].map((k) => Math.max(a.bounds.min[k], b.bounds.min[k]));
    const hi = [0, 1, 2].map((k) => Math.min(a.bounds.max[k], b.bounds.max[k]));
    if (lo.some((v0, k) => v0 >= hi[k])) {
      if (!intersectionLike(v)) out.push(`'${st.name}' (line ${st.line}): the cut removes nothing; the cutter's box (${dimsLabel(b.bounds)} at ${b.bounds.min.map(fmt).join(", ")}) does not reach the shape's (${dimsLabel(a.bounds)} at ${a.bounds.min.map(fmt).join(", ")}).`);
      continue;
    }
    const n = 14;
    let inside = 0, cutter = 0;
    for (let i = 0; i < n; i++)
      for (let j = 0; j < n; j++)
        for (let k = 0; k < n; k++) {
          const x = lo[0] + ((i + 0.5) / n) * (hi[0] - lo[0]);
          const y = lo[1] + ((j + 0.5) / n) * (hi[1] - lo[1]);
          const z = lo[2] + ((k + 0.5) / n) * (hi[2] - lo[2]);
          if (b.dist(x, y, z) >= 0) continue;
          cutter++;
          if (a.dist(x, y, z) < 0) inside++;
        }
    if (intersectionLike(v) || cutter === 0) continue;
    const boxVol = (hi[0] - lo[0]) * (hi[1] - lo[1]) * (hi[2] - lo[2]);
    const removed = (inside / (n * n * n)) * boxVol;
    // Two readings of "almost nothing": the shared material is under a few cells, whatever the cutter; or a cutter
    // that sits mostly inside the shape's box (a slot, a hole, not a trim under the floor) barely touches the shape.
    const bs = boundsSize(b.bounds);
    const slotLike = boxVol > bs[0] * bs[1] * bs[2] * 0.5;
    if (removed < cellSize ** 3 * 8 || (slotLike && inside < cutter * 0.04))
      out.push(`'${st.name}' (line ${st.line}): the cut removes ${inside === 0 ? "nothing the samples could find" : `only about ${fmt(removed)} cubic units, ${((inside / cutter) * 100).toFixed(0)}% of the cutter where the boxes overlap`}: the cutter barely reaches into the shape. Push it in further or make it thicker, or it leaves no mark.`);
  }
  return out;
}

/** Whether a cut node is an intersection (keeps the overlap) rather than a difference; both carry `cut`, only a difference keeps a's box. */
function intersectionLike(v: Shape3): boolean {
  const a = v.inner![0];
  return [0, 1, 2].some((k) => v.bounds.min[k] > a.bounds.min[k] + 1e-9 || v.bounds.max[k] < a.bounds.max[k] - 1e-9);
}

/** Warnings for steps that join painted and unpainted parts, once, at the smallest such step. */
/**
 * Glass on a field that is a bound rather than a distance: a loft, a smooth boolean, a warp or a non-uniform scale.
 * The beauty render marches through glass, and a bound makes it stop short in bands (round 9: a liquid seen through a
 * lofted flacon drew contour lines; the same bottle as a rounded box rendered clean).
 */
export function glassWarnings(evaluation: Evaluation): string[] {
  const geometry = geometrySteps(evaluation);
  const out: string[] = [];
  const names = new Map<Shape3, string>();
  for (const st of evaluation.steps) if (isShape3(st.value) && !names.has(st.value)) names.set(st.value, st.name);
  for (const st of evaluation.steps) {
    const v = st.value;
    if (!isShape3(v) || !v.painted || !geometry.has(st.name) || isEmpty(v.bounds)) continue;
    const c = boundsCenter(v.bounds);
    if (!(v.hit(c[0], c[1], c[2]).mat.transmit > 0)) continue;
    // The first bound field under the paint, by name when it has one.
    let found: Shape3 | undefined;
    const seen = new Set<Shape3>();
    const walk = (n: Shape3) => {
      if (found || seen.has(n)) return;
      seen.add(n);
      if (n.bound) { found = n; return; }
      for (const k of n.parts ?? n.inner ?? []) walk(k);
    };
    walk(v);
    if (!found) continue;
    const what = names.get(found);
    out.push(`'${st.name}' (line ${st.line}) is glass on a field that is a bound, not a distance${what ? ` ('${what}': a loft, a smooth union, a warp or a non-uniform scale)` : " (a loft, a smooth union, a warp or a non-uniform scale)"}: the beauty render bands behind it. Build glass from exact shapes (a rounded box, a cylinder, a revolve) or drop transmit.`);
  }
  return out;
}

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

/** A speck: tiny in volume and in extent, a sliver left by a cut or a blend neck (round 5: counted as a piece and as a cavity). */

/** The asserts row: how many passed, and each failure as check prints it. */
export function assertsRow(asserts: AssertResult[]): string {
  const failed = asserts.filter((a) => !a.passed);
  const passed = asserts.length - failed.length;
  if (!failed.length) return `${passed} pass`;
  return `${passed} pass, ${failed.length} fail: ${failed.map((a) => assertLine(a).replace(/^assert /, "")).join("; ")}`;
}

/**
 * Names listed once each, in the order first met, with how many share the name: `custom ×6`. The Materials and Maps
 * rows list a material per entry of the mesh's list, and a decal painted per book is a material per book (round 11: a
 * row of 70 with the page paper 35 times). The GLB keeps one material per entry; only the row folds them.
 */
export function countedNames(names: string[]): string {
  const counts = new Map<string, number>();
  for (const n of names) counts.set(n, (counts.get(n) ?? 0) + 1);
  return [...counts].map(([n, c]) => (c > 1 ? `${n} ×${c}` : n)).join(", ");
}

/**
 * How the export's triangle cap was shared out, for the Exports row (round 11: "nothing says how the cap is shared
 * out between objects"): one queue over every mesh takes the flattest collapse wherever it is, so each mesh's count
 * before and after, the largest first, and how far merging only flat faces would go.
 */
export function capShare(note: { meshes: { name: string; before: number; after: number }[]; flat: number; triangles: number }): string {
  const each = [...note.meshes].sort((a, b) => b.before - a.before);
  const list = each.slice(0, 6).map((m) => (m.after === m.before ? `${m.name} ${m.before} (whole)` : `${m.name} ${m.before} to ${m.after}`)).join(", ") + (each.length > 6 ? `, and ${each.length - 6} more (report.json under exports)` : "");
  const shared = note.meshes.length > 1 ? `The cap is shared by error, one queue over every mesh taking the flattest faces first: ${list}` : `By error, the flattest faces first: ${list}`;
  const flat = note.flat < note.triangles ? `; merging flat faces alone comes to ${note.flat}, so a cap of that or more strays no further than the full mesh` : `; merging flat faces alone came to ${note.flat}, and the rest of the cut came from curved ones`;
  return shared + flat;
}

/** A volume to two significant figures: a loose ring's 0.00031, which three decimals print as 0 (round 11). */
const fmtVolume = (v: number): string => (v === 0 ? "0" : String(Number(Math.abs(v).toPrecision(2))));

/**
 * The steps a loose piece is made of, named where its own surface is (a few of its vertices), not at its centre,
 * which for a ring is in the air beside whatever passes there (round 11: a knocker's ring, clear of its eye in its
 * own joint, was put down to the wall and the door leaf). The innermost steps whose surfaces pass within two cells
 * of most of those points; and the joint they all turn with, when they do, since a joint's part clear of its parent
 * is a loose piece by design (a ring hanging in an eye, a wheel on an axle).
 */
export function pieceSteps(evaluation: Evaluation, pc: Piece, cellSize: number): { names: string[]; joint?: string } {
  const tally = new Map<string, number>();
  for (const q of pc.points) for (const n of namesAt(evaluation, q, cellSize)) tally.set(n.name, (tally.get(n.name) ?? 0) + 1);
  const ranked = [...tally].sort((a, b) => b[1] - a[1]);
  const names = ranked.filter(([, c], i) => i === 0 || c * 2 >= pc.points.length).slice(0, 2).map(([n]) => n);
  if (!names.length) return { names };
  const joints = jointsOfSteps(evaluation);
  const js = new Set(names.map((n) => joints.get(n)));
  const joint = js.size === 1 ? [...js][0] : undefined;
  return { names, ...(joint ? { joint } : {}) };
}

/** Per step name, the innermost joint it turns with (none for a step outside every joint), read from the tree. */
function jointsOfSteps(evaluation: Evaluation): Map<string, string | undefined> {
  const names = new Map<Shape3, string>();
  for (const st of evaluation.steps) if (isShape3(st.value) && !names.has(st.value)) names.set(st.value, st.name);
  const out = new Map<string, string | undefined>();
  const seen = new Set<Shape3>();
  const roots = evaluation.objects.length ? evaluation.objects.map((o) => o.shape) : evaluation.output ? [evaluation.output] : [];
  const walk = (n: Shape3, joint: string | undefined) => {
    if (seen.has(n)) return;
    seen.add(n);
    // A joint's own name is a step of the joint above it; what it turns is its own.
    const nm = names.get(n);
    if (nm !== undefined && !out.has(nm)) out.set(nm, joint);
    const inner = n.joint ? n.joint.name : joint;
    for (const k of n.parts ?? n.inner ?? []) walk(k, inner);
    if (n.instanced) walk(n.instanced.base, inner);
  };
  for (const r of roots) walk(r, undefined);
  return out;
}

/** A loose piece as the report says it: its volume, where, the steps it is made of, and its joint when it has one. */
function looseText(evaluation: Evaluation, pc: Piece, cellSize: number): string {
  const { names, joint } = pieceSteps(evaluation, pc, cellSize);
  const own = names.length ? ` in ${names.map((n) => `'${n}'`).join(", ")}` : "";
  const turns = joint ? `, the part of joint '${joint}', clear of what it turns on` : "";
  return `${fmtVolume(pc.volume)} at (${pc.centre.map(fmt).join(", ")})${own}${turns}`;
}

/** The pieces row: the count without cavities, and for every piece but the largest its volume, centre and steps. */
function piecesRow(physics: Physics, evaluation: Evaluation, cellSize: number): string {
  const solid = physics.pieces.filter((pc) => !pc.cavity && !isSpeck(pc, physics, cellSize));
  if (solid.length <= 1) return `${solid.length}`;
  const rest = solid.slice(1, 5).map((pc) => looseText(evaluation, pc, cellSize));
  const jointed = solid.slice(1, 5).filter((pc) => pieceSteps(evaluation, pc, cellSize).joint).length;
  const note = jointed && jointed === Math.min(4, solid.length - 1) ? `; a joint's part that turns clear of its parent is a piece of its own by design` : "";
  return `${solid.length} (the largest ${fmt(Math.abs(solid[0].volume))}; then ${rest.join("; ")}${solid.length > 5 ? "; ..." : ""}${note})`;
}

/**
 * Steps whose feature is between 1.2 and 2 cells: they mesh (the thin warning's threshold is 1.2) but a tube or a
 * wall that thin often meshes with open edges, so when the mesh is not watertight they are the first suspects
 * (measured: a bicycle's spokes and stays at 1.3 to 1.8 cells carried the edges; at 2 cells they were clean).
 */
export function nearlyThin(evaluation: Evaluation, cellSize: number): string {
  const geometry = geometrySteps(evaluation);
  const seen = new Set<Shape3 | string>();
  const names: string[] = [];
  for (const st of evaluation.steps) {
    if (!isShape3(st.value) || !geometry.has(st.name)) continue;
    const f = st.value.feature;
    if (f === undefined || !(f >= cellSize * 1.2) || f >= cellSize * 2) continue;
    const key = sourceKey(evaluation, st.value);
    if (seen.has(key)) continue;
    seen.add(key);
    // The member as well as the step: a library's back panel called inline is 'plate' alone otherwise (round 11).
    // Where it is only with what made it, to keep the note short: the step's name finds a part of its own.
    const m = names.length < 6 ? thinMember(evaluation, { name: st.name, line: st.line, value: st.value }) : {};
    const said = m.made ? [m.made, m.where].filter(Boolean).join(", ") : "";
    names.push(`'${st.name}' (${(f / cellSize).toFixed(1)} cells${said ? `: ${said}` : ""})`);
  }
  if (!names.length) return "";
  return ` Parts between 1.2 and 2 cells thick mesh but often not watertight: ${names.slice(0, 6).join(", ")}${names.length > 6 ? ", ..." : ""}; thicken them to two cells or raise the grid.`;
}

/** The cavities row: enclosed voids, without the sub-cell ones a grazing contact leaves (those are the watertight row's). */
function cavitiesRow(physics: Physics, cellSize: number): string {
  const cavities = physics.pieces.filter((pc) => pc.cavity && !isSpeck(pc, physics, cellSize));
  if (!cavities.length) return "none";
  return cavities.slice(0, 4).map((pc) => `volume ${fmt(Math.abs(pc.volume))} at (${pc.centre.map(fmt).join(", ")})`).join("; ") + " (enclosed voids, not loose parts)";
}

/**
 * The steps to name for a point on the model, as the watertight row names
 * an open edge: the innermost steps whose surfaces pass within two cells,
 * exposed ones first, at most two; the nearest named one when none is
 * innermost.
 */
function namesAt(evaluation: Evaluation, at: Vec3, cellSize: number): { name: string; leaf: boolean; d: number; parents: string[] }[] {
  const near = stepsNearDetailed(evaluation, at, cellSize * 2);
  const leaves = near.filter((n) => n.leaf).slice(0, 2);
  return leaves.length ? leaves : near.slice(0, 1);
}

/**
 * How far apart two steps' surfaces are around a point where both pass
 * (round 4: "the barrel's side is 0.03 from the bracket's top"): points
 * of each surface within a cell and a half of the point, read in the other
 * step's field, the nearest reading kept. Positive is a gap, negative is
 * how deep one reaches into the other; undefined when the steps cannot be
 * placed in the output or neither surface comes near the point. A cutter's
 * inside is air, so its field is read the other way round: pebbles 0.01
 * inside a recess's wall are 0.01 clear of the dish (round 10).
 */
export function surfaceGap(evaluation: Evaluation, a: string, b: string, at: Vec3, cellSize: number): { gap: number; into?: [string, string]; cut?: boolean } | undefined {
  const roots = evaluation.objects.length ? evaluation.objects.map((o) => o.shape) : evaluation.output ? [evaluation.output] : [];
  const value = (n: string) => evaluation.steps.find((st) => st.name === n && isShape3(st.value))?.value as Shape3 | undefined;
  const va = value(a), vb = value(b);
  if (!va || !vb || !roots.length) return undefined;
  const sa = placedUnder(roots, va), sb = placedUnder(roots, vb);
  const sign = (n: string) => (evaluation.roles.get(n) === "cut" ? -1 : 1);
  let best = Infinity, from: 0 | 1 = 0;
  const r = cellSize * 1.5;
  for (const [i, s, o, k] of [[0, sa, sb, sign(b)], [1, sb, sa, sign(a)]] as const)
    for (let dx = -1; dx <= 1; dx++)
      for (let dy = -1; dy <= 1; dy++)
        for (let dz = -1; dz <= 1; dz++) {
          const q = surfacePoint(s, at[0] + dx * r, at[1] + dy * r, at[2] + dz * r);
          // Only the surface at the edge: a projection that ran off to another face of the step (a recess's floor two
          // cells below the wall the edges are on) says nothing about this seam.
          if (Math.hypot(q[0] - at[0], q[1] - at[1], q[2] - at[2]) > cellSize * 1.5) continue;
          const v = k * o.dist(q[0], q[1], q[2]);
          if (v < best) { best = v; from = i; }
        }
  if (!Number.isFinite(best) || Math.abs(best) > cellSize * 3) return undefined;
  if (best >= 0) return { gap: best };
  // Past a cut face either way round is the part reaching into the solid the cut left: the part is the one named first.
  if (sign(a) < 0 !== sign(b) < 0) return { gap: best, into: sign(a) < 0 ? [b, a] : [a, b], cut: true };
  return { gap: best, into: from === 0 ? [a, b] : [b, a] };
}

/**
 * The smooth boolean whose fillet a point lies in: a `union(..., k=)` (or a smooth difference or intersection) with
 * two of its operands' surfaces within k and two cells of the point, the innermost such, by its name or its nearest
 * named parent's (round 11: an edge in a head blended to its hinge knuckle with k=0.03 was put down to the two parts
 * under the blend, "only 0.000825 into 'head_knuckle'", as if no blend were there).
 */
export function blendAt(evaluation: Evaluation, at: Vec3, cellSize: number): { name: string; k: number } | undefined {
  const names = new Map<Shape3, string>();
  for (const st of evaluation.steps) if (isShape3(st.value) && !names.has(st.value)) names.set(st.value, st.name);
  const roots = evaluation.objects.length ? evaluation.objects.map((o) => o.shape) : evaluation.output ? [evaluation.output] : [];
  let found: { name: string; k: number; depth: number } | undefined;
  let budget = 20000;
  const walk = (n: Shape3, x: number, y: number, z: number, t: number, depth: number, named: string | undefined): void => {
    if (--budget < 0 || isEmpty(n.bounds)) return;
    const b = n.bounds, r = t + (n.blend ?? 0);
    if (x < b.min[0] - r || x > b.max[0] + r || y < b.min[1] - r || y > b.max[1] + r || z < b.min[2] - r || z > b.max[2] + r) return;
    if (Math.abs(n.dist(x, y, z)) > r) return;
    const here = names.get(n) ?? named;
    if (n.blend && n.inner && n.inner.length >= 2 && here && (!found || depth >= found.depth)) {
      let near = 0;
      for (const c of n.inner) if (Math.abs(c.dist(x, y, z)) < n.blend + t) near++;
      if (near >= 2) found = { name: here, k: n.blend, depth };
    }
    let cx = x, cy = y, cz = z, ct = t;
    if (n.unwarp) {
      const q = n.unwarp(x, y, z);
      let stretch = 0;
      for (const [ex, ey, ez] of [[t, 0, 0], [0, t, 0], [0, 0, t]]) {
        const w = n.unwarp(x + ex, y + ey, z + ez);
        stretch = Math.max(stretch, Math.hypot(w[0] - q[0], w[1] - q[1], w[2] - q[2]));
      }
      cx = q[0]; cy = q[1]; cz = q[2]; ct = stretch > 0 && Number.isFinite(stretch) ? stretch : t;
    }
    for (const k of n.parts ?? n.inner ?? []) walk(k, cx, cy, cz, ct, depth + 1, here);
    if (n.instanced && !n.parts) walk(n.instanced.base, cx, cy, cz, ct, depth + 1, here);
  };
  for (const r of roots) walk(r, at[0], at[1], at[2], cellSize * 2, 0, undefined);
  return found ? { name: found.name, k: found.k } : undefined;
}

/**
 * The watertight line, with where the bad edges are and which steps hold
 * them, so it can be acted on. Each cluster names the steps whose surface
 * passes there; when only one step does, two of its own surfaces cross
 * (a tube's segments at a join, a fold in a displaced skin), and it says
 * so rather than naming the step's parent as if it were the other party
 * (round 5: "'swing_branch', 'wood'" read as a branch meeting the tree).
 * A tally per step follows, so one construct carrying every edge shows
 * in one read.
 */
export function watertightNote(w: ReturnType<typeof watertightReport>, evaluation: Evaluation, cellSize: number, edgeList: { at: Vec3; count: number; steps: string[]; gap?: number }[] = [], posed = false): string {
  if (w.ok || !w.where || isEmpty(w.where)) return w.note;
  const tally = new Map<string, number>();
  let planar = 0, gaps = 0, blends = 0;
  let planeAxis: number | undefined;
  const all = w.clusters ?? [];
  let joints: Map<string, string | undefined> | undefined;
  const jointOf = () => (joints ??= jointsOfSteps(evaluation));
  const spots = all.map((cl, index) => {
    // Named at an edge that is on the model, not at the cluster's mean, which for a ring of edges is inside the part.
    const names = namesAt(evaluation, cl.at, cellSize);
    for (const n of names) tally.set(n.name, (tally.get(n.name) ?? 0) + cl.count);
    // One step reached through two named parents is two placements of the same part crossing (two boards of one
    // panel), which is worth more than "with itself".
    const twice = names.length === 1 && names[0].parents.length >= 2 ? names[0].parents.slice(0, 2) : undefined;
    // One name alone: the step's own surface folds or creases there, or a sample-plane coincidence; a straight
    // tube has no second surface to cross, so it is not called "with itself" (round 6: that read as nonsense).
    // Two steps meeting: how far apart their surfaces are there, which says which way to move one (round 4).
    // Inside a blend's fillet the two parts' own surfaces are not the surface, so their gap says nothing: the blend is
    // named instead.
    const blend = names.length === 2 && index < 3 ? blendAt(evaluation, cl.at, cellSize) : undefined;
    if (blend) blends++;
    const g = names.length === 2 && index < 3 && !blend ? surfaceGap(evaluation, names[0].name, names[1].name, cl.at, cellSize) : undefined;
    if (g) gaps++;
    const gapText = !g ? "" : g.into ? `, '${g.into[0]}' only ${fmt(-g.gap)} ${g.cut ? `past the face '${g.into[1]}' cut` : `into '${g.into[1]}'`} there (${(-g.gap / cellSize).toFixed(1)} of a cell)` : `, their surfaces ${fmt(g.gap)} apart there (${(g.gap / cellSize).toFixed(1)} of a cell)`;
    // A cutter named there is the face it cut in its part, which is tagged, or a reader looks for the cutter itself
    // (round 10: a recess named at a pebble band's edges sent the reader to the base's own shape).
    const q = (nm: string) => `'${nm}'${evaluation.roles.get(nm) === "cut" ? " (cut: the face it cut)" : ""}`;
    const blendText = blend ? `, in the fillet where '${blend.name}' blends them (k ${fmt(blend.k)}, ${(blend.k / cellSize).toFixed(1)} cells)` : "";
    // A joint's part against what it turns on is two meshes in the GLB, so a seam between them is the fused mesh's only.
    const ja = names.length === 2 ? jointOf().get(names[0].name) : undefined, jb = names.length === 2 ? jointOf().get(names[1].name) : undefined;
    const jointText = names.length === 2 && ja !== jb ? `, the joint '${(ja ?? jb)!}''s part against what it turns on, which the GLB carries as separate meshes` : "";
    const label = names.length === 0 ? "" : names.length === 1 ? (twice ? ` in ${q(names[0].name)} twice, as '${twice[0]}' and '${twice[1]}'` : ` in ${q(names[0].name)} alone (no other part within a cell: two copies of the same step touching, a crease of its own surface, or the mesher's noise at a few edges)`) : ` in ${names.map((n) => q(n.name)).join(", ")}${blendText}${gapText}${jointText}`;
    edgeList.push({ at: cl.at, count: cl.count, steps: names.map((n) => n.name), ...(g ? { gap: g.gap } : {}) });
    if (index >= 3) return "";
    // Edges that all share one coordinate lie on a plane: a flat face or a widest line sitting exactly on a sample
    // plane, which the extractor cannot resolve (measured: a down tube's side and a tyre's equator on grid planes).
    const flat = cl.count >= 3 ? [0, 1, 2].find((k) => cl.box.max[k] - cl.box.min[k] < cellSize * 0.05) : undefined;
    if (flat !== undefined) { planar++; planeAxis ??= flat; }
    const plane = flat !== undefined ? `, all on the plane ${"xyz"[flat]} = ${fmt(cl.at[flat])}` : "";
    return `${cl.count} at (${cl.at.map(fmt).join(", ")})${label}${plane}`;
  });
  const byStep = [...tally.entries()].sort((a, b) => b[1] - a[1]).slice(0, 6).map(([n, c]) => `'${n}' ${c}`).join(", ");
  // In a pose the sample planes fall where the pose puts the part, so a nudge that clears them at rest need not hold
  // and one that clears them here need not hold at rest (round 8: a lug blamed on a plane in two poses).
  const planeNote = planar ? (posed ? " Edges all on one plane are a surface lying exactly on a sample plane in this pose, not a thin part; the planes move with the pose, so judge watertightness at rest and leave these." : ` Edges all on one plane are a surface lying exactly on a sample plane, not a thin part: move the part by half a cell (${fmt(cellSize / 2)}) along ${"xyz"[planeAxis ?? 1]}, which puts the face midway between two sample planes, or change the radius a little.`) : "";
  const more = all.length > 3 ? ` and ${all.length - 3} more places (every one is in report.json under watertight)` : "";
  // Measured over ten placements on the lattice: two curved faces (a round leaf in a round opening, a ball in a pocket)
  // left open edges up to 1.4 cells apart and none from 1.5; a door's arch kept 5 at 1.35 cells (round 11).
  const gapNote = gaps ? " Two parts closer than a cell and a half, or sunk into each other by less than a cell, leave a seam: overlap them by a cell or more, or part them by a cell and a half (curved faces still seam at 1.4)." : "";
  const blendNote = blends ? " An edge in a blend's fillet is the mesher's, where the blended surface turns within a cell or two, not a gap between the parts the blend joins." : "";
  return `${w.note} The edges are mostly ${spots.filter(Boolean).join("; ")}${more}.${byStep ? ` By step, over all of them: ${byStep}.` : ""}${gapNote}${blendNote}${planeNote}`;
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

/** A strip's title in its bar: at 2x, or at 1x when a strip of two frames is too narrow for it. */
function barTitle(strip: Canvas, text: string): void {
  const big = textWidth(text, 2) + 20 <= strip.width;
  drawText(strip, 10, big ? 7 : 10, text, INK.barText, big ? 2 : 1);
}

/** `a` held within `b`, axis by axis: a mesh's extent within bounds that are never smaller than the surface. */
export function clampBounds(a: Bounds, b: Bounds): Bounds {
  const min = [0, 1, 2].map((k) => Math.min(Math.max(a.min[k], b.min[k]), b.max[k])) as [number, number, number];
  const max = [0, 1, 2].map((k) => Math.max(Math.min(a.max[k], b.max[k]), min[k])) as [number, number, number];
  return { min, max };
}

/** The grid and cell size a render of this evaluation would use, from its settings and bounds. */
export function cellFor(evaluation: Evaluation, gridOverride?: number): { grid: number; cellSize: number } {
  const grid = Math.max(8, Math.round(gridOverride ?? (evaluation.settings.grid as number | undefined) ?? 128));
  const b = evaluation.output?.bounds;
  if (!b || isEmpty(b)) return { grid, cellSize: 0 };
  const s = boundsSize(b);
  return { grid, cellSize: Math.max(s[0], s[1], s[2]) / grid };
}

/** The thin-part warnings a Bedrock export at `px` pixels per block gets: a part under a voxel is lost in the geometry. */
export function minecraftThinWarnings(ev: Evaluation, px: number, grid: number): string[] {
  const voxel = 1 / px;
  return foldThinWarnings(thinWarnings(ev, voxel, grid, 1)).map((w) => `minecraft: ${w.replace(/ or raise the grid \(set grid \d+\)/, "").replace(/, or set grid \d+ covers them all/, "").replace(/in the mesh/g, "in the geometry")} (a voxel is ${fmt(voxel)} at ${px} pixels per block; set minecraft ${px * 2} halves it)`);
}

/** The mesh's vertices inside a box, for a camera that fits one part; undefined when too few to fit (the box's corners then do). */
function pointsWithin(mesh: Mesh, b: Bounds): Float32Array | undefined {
  const pos = mesh.positions;
  const out: number[] = [];
  for (let i = 0; i < pos.length; i += 3) {
    const x = pos[i], y = pos[i + 1], z = pos[i + 2];
    if (x >= b.min[0] && x <= b.max[0] && y >= b.min[1] && y <= b.max[1] && z >= b.min[2] && z <= b.max[2]) out.push(x, y, z);
  }
  return out.length >= 24 ? new Float32Array(out) : undefined;
}

/** A ghost is meshed at this many times the close-up's cell. */
const GHOST_CELL = 2;

/** The shape clipped to a box: the cut faces keep the shape's own material (measured: a marble base read as clay). */
function clipTo(shape: Shape3, frame: Bounds): Shape3 {
  const fc = boundsCenter(frame), fsz = boundsSize(frame);
  const clipBox = move(box(fsz[0], fsz[1], fsz[2]), fc[0], fc[1], fc[2]);
  return {
    kind: "shape3",
    dist: (x, y, z) => Math.max(shape.dist(x, y, z), clipBox.dist(x, y, z)),
    hit: (x, y, z) => { const q = shape.hit(x, y, z); return { ...q, d: Math.max(q.d, clipBox.dist(x, y, z)) }; },
    bounds: frame,
    cost: shape.cost + 1,
  };
}

/**
 * A focus close-up in two: the focused part (already placed where the output puts it) clipped to the frame, and the
 * ghost, everything else the frame holds with the part carved out of it, grown by `margin` so the two surfaces never
 * coincide and the ghost reads as the neighbour it is.
 */
function focusSplit(output: Shape3, part: Shape3, frame: Bounds, margin: number): { focus: Shape3; ghost: Shape3 } {
  const focus = clipTo(part, frame);
  const rest = clipTo(output, frame);
  const ghost: Shape3 = {
    kind: "shape3",
    dist: (x, y, z) => Math.max(rest.dist(x, y, z), margin - part.dist(x, y, z)),
    hit: (x, y, z) => { const q = rest.hit(x, y, z); return { ...q, d: Math.max(q.d, margin - part.dist(x, y, z)) }; },
    bounds: frame,
    cost: rest.cost + part.cost,
  };
  return { focus, ghost };
}

/**
 * check's lines for the rest() and lean() calls, one per call in the source: `rest (line 14)  bowl onto plate:
 * moved 0.15 along [0, -1, 0]; gap 0`, or for a call a loop or a def made several times, the count and the
 * range moved. A gap is how far from touching the contact was left, either way (a millionth of the part or less).
 */
export function contactLines(contacts: ContactRecord[]): string[] {
  const groups = new Map<string, ContactRecord[]>();
  for (const c of contacts) {
    const key = `${c.file ?? ""}:${c.line}:${c.callee}`;
    const g = groups.get(key);
    if (g) g.push(c); else groups.set(key, [c]);
  }
  const out: string[] = [];
  const num = (v: number) => { const t = String(Number(v.toPrecision(4))); return t === "-0" ? "0" : t; };
  const gapText = (v: number) => (Math.abs(v) < 1e-12 ? "0" : String(Number(v.toPrecision(2))));
  for (const g of groups.values()) {
    const c = g[0];
    const where = `${c.callee} (line ${c.line}${c.file ? ` of ${c.file}` : ""})`;
    const lo = Math.min(...g.map((x) => x.note.amount)), hi = Math.max(...g.map((x) => x.note.amount));
    const same = g.every((x) => vecText(x.note.along) === vecText(c.note.along));
    const amount = g.length === 1 || lo === hi ? num(c.note.amount) : `${num(lo)} to ${num(hi)}`;
    const verb = c.callee === "rest" ? "moved" : "turned";
    const unit = c.callee === "rest" ? "" : " degrees";
    const along = same ? `${c.callee === "rest" ? " along" : " about"} ${vecText(c.note.along)}` : c.callee === "rest" ? " along its dir" : " about its axis";
    const at = c.callee === "lean" && g.length === 1 && c.note.pivot ? ` through (${c.note.pivot.map(num).join(", ")})` : "";
    const backed = g.filter((x) => x.note.backed).length;
    const sinks = [...new Set(g.map((x) => x.note.sink))];
    const parts = g.length === 1 || g.every((x) => x.part === c.part && x.on === c.on) ? `${c.part} onto ${c.on}` : `${g.length} parts`;
    const count = g.length > 1 ? `${g.length} calls, ` : "";
    const gap = Math.max(...g.map((x) => Math.abs(x.note.gap)));
    let text = `${count}${parts}: ${verb} ${amount}${unit}${along}${at}`;
    if (backed) text += g.length === 1 ? ` (it started inside ${c.on} and was backed out)` : ` (${backed} started inside and were backed out)`;
    const lifted = Math.max(...g.map((x) => x.note.lifted));
    if (lifted > 0) text += `, lifted ${gapText(lifted)} out of ${g.length === 1 ? c.on : "what they stood in"} first`;
    if (sinks.length === 1 && sinks[0] !== 0) text += `, then sunk ${num(sinks[0])}`;
    else if (sinks.length > 1) text += `, then sunk ${num(Math.min(...sinks))} to ${num(Math.max(...sinks))}`;
    text += `; ${g.length > 1 ? "gaps up to" : "gap"} ${gapText(gap)}`;
    // A turn of more than a quarter is usually the axis's sign: say which way the other is.
    if (c.callee === "lean" && Math.max(Math.abs(lo), Math.abs(hi)) > 90 && same) text += `; more than a quarter turn: axis=${vecText(c.note.along.map((v) => -v))} turns the other way`;
    out.push(`${where.padEnd(18)} ${text}`);
  }
  return out;
}

/** Parse and evaluate only: what `aixle check` does. `sourceName` lets imports resolve. */
/** Parse and evaluate a program, nothing rendered; `cache` keeps an import's samples between runs (see importResolver). */
export function check(source: string, sourceName = "model.aix", log?: (line: string) => void, jointPoses?: Record<string, JointPose>, poseName?: string, skipAsserts = false, cache?: ImportCache, onAssert?: (phase: "start" | "end", a: AssertInfo) => void): Evaluation {
  return evaluate(parse(source), { resolveImport: importResolver(sourceName, log, cache), resolveModule: moduleResolver(sourceName), resolveImage: imageResolver(sourceName), moduleFrom: sourceName, jointPoses, poseName, skipAsserts, onAssert });
}

/**
 * The warnings the promises at rest raised as they were judged, for an evaluation in a pose that did not judge them
 * again (a void() whose region is nowhere near its shape is said in every pose, as it was before a pose's evaluation
 * stopped judging the promises at rest); none for the rest evaluation itself, whose warnings hold them.
 */
export function restAssertWarningsFor(shown: Evaluation, rest: Evaluation): string[] {
  return shown === rest ? [] : [...new Set(rest.restAssertWarnings)].filter((w) => !shown.warnings.includes(w));
}

/** An assert as a line names it: `assert (line 12) in pose open: clearance(lid, box) > 0.02`, its library first. */
export function assertLabel(a: AssertInfo): string {
  return `${a.file ? `${a.file}: ` : ""}assert (line ${a.line})${a.pose ? ` in pose ${a.pose}` : ""}: ${a.text}`;
}

const seconds = (ms: number): string => `${Number((ms / 1000).toPrecision(ms < 10000 ? 2 : 3))} s`;

/**
 * Times the asserts as they are judged and says which are slow, so a check that seems hung, or a quick render that
 * takes twenty seconds, says where the time goes (round 11: a shelf's check sat silent for twelve minutes on one
 * overlap() and took forty runs to bisect; a mixer's quick pass spent 18 of its 20 s on one wall()). A fast run says
 * nothing. Once the asserts have taken `after` ms between them, each is named as it starts, at most one a second,
 * so a loop of quick promises does not flood the terminal; one that takes over `slow` ms is named with its time when
 * it ends. `watch` is told which assert is running (the CLI's watchdog names one that has not returned). `now` is
 * the clock in milliseconds: performance.now in the CLI, a counter in a test.
 */
export class AssertClock {
  /** Milliseconds spent judging asserts so far. */
  total = 0;
  /** Each assert's time by its place, over all its judgements (a loop's, every pose's), for the slowest few. */
  readonly byPlace = new Map<string, { info: AssertInfo; ms: number; count: number }>();
  private started = 0;
  private lastNamed = -Infinity;
  private named = false;
  constructor(
    private readonly now: () => number,
    private readonly write: (line: string) => void,
    private readonly opts: { after?: number; slow?: number; watch?: (a: AssertInfo | undefined) => void } = {},
  ) {}
  readonly hook = (phase: "start" | "end", a: AssertInfo): void => {
    const after = this.opts.after ?? 2000, slow = this.opts.slow ?? 1000;
    const t = this.now();
    if (phase === "start") {
      this.started = t;
      this.opts.watch?.(a);
      if (this.total > after && t - this.lastNamed >= 1000) {
        if (!this.named) this.write(`asserts: ${seconds(this.total)} so far; naming one as it starts each second`);
        this.named = true;
        this.lastNamed = t;
        this.write(`judging ${assertLabel(a)}`);
      }
      return;
    }
    this.opts.watch?.(undefined);
    const ms = t - this.started;
    this.total += ms;
    const key = [a.file ?? "", a.line, a.pose ?? "", a.text].join("\u0000");
    const e = this.byPlace.get(key);
    if (e) { e.ms += ms; e.count++; } else this.byPlace.set(key, { info: a, ms, count: 1 });
    if (ms > slow) this.write(`${assertLabel(a)} took ${seconds(ms)}`);
  };
  /** The slowest places, most time first: "line 149, wall(bowl) > 0.04, 15.9 s over 3 judgements". */
  slowest(n = 3): string[] {
    return [...this.byPlace.values()].sort((x, y) => y.ms - x.ms).slice(0, n).filter((e) => e.ms >= 100)
      .map((e) => `${e.info.file ? `${e.info.file} ` : ""}line ${e.info.line}${e.info.pose ? ` in pose ${e.info.pose}` : ""}, ${e.info.text}, ${seconds(e.ms)}${e.count > 1 ? ` over ${e.count} judgements` : ""}`);
  }
  /** The closing line once the asserts took more than `after`: how long, and where; undefined for a fast run. */
  summary(): string | undefined {
    if (this.total <= (this.opts.after ?? 2000)) return undefined;
    return `asserts took ${seconds(this.total)}; the slowest: ${this.slowest().join("; ")}`;
  }
}

/**
 * Every assert with its verdict: the rest evaluation's own, and for each pose an assert names (`pose=name`) the
 * verdict from the program evaluated in that pose, which `evalIn` supplies (undefined for a pose that does not
 * exist; the rest evaluation already warned about it).
 */
export function collectAsserts(rest: Evaluation, evalIn: (poseName: string) => Evaluation | undefined): AssertResult[] {
  const out: AssertResult[] = rest.asserts.filter((a) => !a.pose || a.pose === "rest");
  const poseNames = [...new Set(rest.asserts.filter((a) => a.pose && a.pose !== "rest").map((a) => a.pose!))];
  for (const pn of poseNames) {
    const ev = evalIn(pn);
    if (!ev) continue;
    out.push(...ev.asserts.filter((a) => a.pose === pn && !a.pending));
  }
  return out.sort((a, b) => a.line - b.line);
}

/** What a model unit is for printing, from `set units`: its name, millimetres per unit, and whether it was assumed. */
export function printUnits(settings: Settings): { units: string; mm: number; assumed: boolean } {
  const u = typeof settings.units === "string" && Object.hasOwn(UNITS, settings.units) ? settings.units : undefined;
  return u ? { units: u, mm: UNITS[u], assumed: false } : { units: "mm", mm: 1, assumed: true };
}

/** The printer's bed from `set bed W D H`, in millimetres; undefined when unset or malformed (the evaluation warns). */
export function printBed(settings: Settings): number[] | undefined {
  const b = settings.bed;
  return Array.isArray(b) && b.length === 3 && b.every((v) => v > 0) ? b : undefined;
}

const UNIT_WORDS: Record<string, string> = { mm: "a millimetre", cm: "a centimetre", dm: "a decimetre", m: "a metre", in: "an inch", ft: "a foot" };
const UNIT_PLURALS: Record<string, string> = { mm: "millimetres", cm: "centimetres", dm: "decimetres", m: "metres", in: "inches", ft: "feet" };

/** The Units row, and the first words of check's print line. */
export function unitsText(u: { units: string; mm: number; assumed: boolean }, heightMm?: number): string {
  if (u.assumed) return `not set: a slicer reads a unit as a millimetre${heightMm !== undefined ? `, so this prints ${fmtMm(heightMm)} mm tall` : ""}; \`set units cm\` (or mm, dm, m, in, ft) says what a unit is`;
  return `${u.units}: one unit is ${UNIT_WORDS[u.units]}${u.mm !== 1 ? ` (${fmt(u.mm)} mm)` : ""}`;
}

// Millimetres to a tenth, or three significant figures under ten.
export const fmtMm = (v: number): string => (Math.abs(v) >= 10 ? v.toFixed(1).replace(/\.0$/, "") : String(Number(v.toPrecision(3))));

/** Whether it fits the bed, in a sentence: as it stands, turned on the plate, lying down, or not at all. */
export function fitText(fit: BedFit, bed: number[]): string {
  const bedLabel = `the ${bed.map(fmtMm).join(" × ")} mm bed`;
  if (fit.fits) return `fits ${bedLabel}`;
  const over = [fit.size[0] > bed[0] ? `${fmtMm(fit.size[0])} wide for ${fmtMm(bed[0])}` : "", fit.size[1] > bed[1] ? `${fmtMm(fit.size[1])} deep for ${fmtMm(bed[1])}` : "", fit.size[2] > bed[2] ? `${fmtMm(fit.size[2])} tall for ${fmtMm(bed[2])}` : ""].filter(Boolean).join(", ");
  if (fit.turned !== undefined) return `does not fit ${bedLabel} square (${over}); turned ${fit.turned}° about the vertical on the plate (as rotate(y=${fit.turned}) turns it, counter-clockwise seen from above), it fits`;
  if (fit.lying) return `does not fit ${bedLabel} standing (${over}); laid on its side with ${fit.lying.up} up${fit.lying.turned ? ` and turned ${fit.lying.turned}°` : ""}, it fits (the overhangs and supports then change)`;
  return `does not fit ${bedLabel} whichever way it lies (${over}): scale it down, or cut it into parts that each fit`;
}

/**
 * The Supports row: the support the overhangs need (on the plate and on the model, the tallest column, and a note
 * when that column stands on a sliver at a crease), what is bridged instead, and the islands. `names` gives the steps
 * at a point, for an island's place.
 */
export function supportsText(sup: SupportResult, mm: number, cellSize: number, names: (p: Vec3) => string[]): string {
  const mm3 = mm * mm * mm;
  const vol = (v: number) => (v * mm3 >= 1000 ? `${fmtMm((v * mm3) / 1000)} cm³` : `${fmtMm(v * mm3)} mm³`);
  const pt = (p: Vec3) => `(${p.map(fmt).join(", ")})`;
  const parts: string[] = [];
  if (sup.volume > 0) {
    // A column on a few faces covering under a cell at a crease is most often a cutter's face laid exactly on the
    // part's own, which the mesher leaves as a sliver facing down (round 11: a 33 mm column under 0.23 mm²).
    const sliver = sup.sliver ? `; it stands on ${sup.sliver.faces} face${sup.sliver.faces === 1 ? "" : "s"} covering ${fmtMm(sup.sliver.area * mm * mm)} mm², under a cell: where the shape itself does not face down there, a cutter's face lies exactly on the part's own, and moving the cutter by half a cell (${fmt(cellSize / 2)}) clears it` : "";
    parts.push(`about ${vol(sup.volume)} under the overhangs that need it (${vol(sup.fromFloor)} standing on the plate, ${vol(sup.onModel)} on the model itself), over ${fmtMm(sup.area * mm * mm)} mm² in plan; the tallest column is ${fmtMm(sup.tallest * mm)} mm under ${pt(sup.at!)}${sliver}`);
  } else parts.push(sup.bridged > 0 ? "none needed under the overhangs" : "none: nothing faces down more than 45° above the plate");
  if (sup.bridged > 0)
    parts.push(`${vol(sup.bridged)} ${sup.volume > 0 ? "more " : ""}under bridges over ${fmtMm(sup.bridgedArea * mm * mm)} mm², level ceilings spanning at most ${fmtMm(sup.span * mm)} mm to solid that stands on both sides (the longest ${fmtMm(sup.longestBridge * mm)} mm, at ${pt(sup.bridgeAt!)}): they print without support with supports off, past ${fmtMm(sup.span * mm)} mm PrusaSlicer's own check adds a support point, and with supports on a slicer fills them too unless told not to`);
  if (sup.islands.length) {
    const first = sup.islands.slice(0, 3).map((i) => {
      const at = names(i.at);
      return `${pt(i.at)}${at.length ? ` in ${at.map((n) => `'${n}'`).join(", ")}` : ""}, a column ${fmtMm(i.height * mm)} mm down to ${i.onModel ? "the model" : "the plate"}`;
    });
    const more = sup.islands.length > 3 ? `, and ${sup.islands.length - 3} more` : "";
    parts.push(`${sup.islands.length} island${sup.islands.length === 1 ? "" : "s"}, a point lower than all the surface around it, which prints in the air whatever its faces' angles and needs a column: at ${first.join("; at ")}${more}`);
  }
  const skipped = sup.skipped > 0 ? `; ${fmtMm(sup.skipped * mm * mm)} mm² of mesh faces tilted past 45° where the shape itself faces down less (bent beside a sharp edge, or faceted along a curve's 45° line) are left out` : "";
  return `${parts.join("; ")}${sup.volume > 0 ? ". An upper estimate: a slicer fills support sparsely" : ""}${skipped}`;
}

/**
 * The Print section of the report: the unit, the size in millimetres, the
 * bed, the thinnest wall and where, the support under the overhangs, what
 * rests on the plate and how much material it takes, and a summary line.
 * The wall and the supports are ray passes over the mesh through the
 * field; a quick pass leaves them out.
 */
function printSection(evaluation: Evaluation, output: Shape3, mesh: Mesh, cellSize: number, physics: Physics, pieces: number, watertight: boolean, quick: boolean, time: <T>(key: string, f: () => T) => T, files: { stl: boolean; threemf: boolean }): { lines: string[]; json: Record<string, unknown> } {
  const u = printUnits(evaluation.settings);
  const bed = printBed(evaluation.settings);
  const mm = u.mm;
  const fit = bedFit(mesh.positions, mm, bed ?? [Infinity, Infinity, Infinity]);
  const sizeMm = fit.size;
  const rows: string[] = [];
  const json: Record<string, unknown> = { units: u.units, unitsAssumed: u.assumed, mmPerUnit: mm, sizeMm };
  rows.push(`| Units | ${unitsText(u, sizeMm[2])} |`);
  rows.push(`| Size | ${sizeMm.map(fmtMm).join(" × ")} mm (x and z on the plate, y up; the surface, from the mesh) |`);
  if (bed) {
    rows.push(`| Bed | ${fitText(fit, bed)} |`);
    Object.assign(json, { bed, fits: fit.fits, turned: fit.turned, lying: fit.lying });
  } else rows.push(`| Bed | not set: \`set bed 220 220 250\` (width, depth, height in millimetres) checks the fit |`);
  let summary: string[] = [];
  if (!quick) {
    // One welding for both passes: the wall's rays are cast once per position, and the islands are read on it.
    const welded = weldIndices(mesh);
    const w = time("walls", () => wallThickness(output, mesh, cellSize, undefined, welded));
    if (w.thinnest) {
      const t = w.thinnest;
      const names = namesAt(evaluation, t.at, cellSize);
      const far = namesAt(evaluation, t.to, cellSize);
      const under = w.thicknesses.reduce((n, v) => n + (v * mm < 0.8 ? 1 : 0), 0);
      const share = w.exits ? under / w.exits : 0;
      const where = `at (${t.at.map(fmt).join(", ")})${names.length ? ` in ${names.map((n) => `'${n.name}'`).join(", ")}` : ""}, through to (${t.to.map(fmt).join(", ")})${far.length ? ` in ${far.map((n) => `'${n.name}'`).join(", ")}` : ""}`;
      const cells = t.thickness / cellSize;
      const meshNote = cells < 1.2 ? "; under the 1.2 cells the mesh needs to hold a wall: the mesh may be broken there" : cells < 2 ? "; under two cells: the mesh there may not be watertight" : "";
      const shareNote = under ? `; ${share < 0.001 ? "under 0.1%" : `${(share * 100).toFixed(share < 0.095 ? 1 : 0)}%`} of the surface stands on walls under 0.8 mm (two lines of a 0.4 mm nozzle), which a slicer may thin or leave out` : "";
      rows.push(`| Thinnest wall | ${fmtMm(t.thickness * mm)} mm (${fmt(t.thickness)} units, ${cells.toFixed(1)} cells) ${where}${meshNote}${shareNote} |`);
      json.wall = { thickness: t.thickness, mm: t.thickness * mm, at: t.at, to: t.to, steps: names.map((n) => n.name), farSteps: far.map((n) => n.name), rays: w.rays, measured: w.exits, under08mm: share };
      if (t.thickness * mm < 0.8) summary.push(`a wall ${fmtMm(t.thickness * mm)} mm thin`);
    } else rows.push(`| Thinnest wall | no ray found a far side (${w.rays} rays) |`);
    const sup = time("supports", () => supportVolume(output, mesh, cellSize, physics.floor, { span: BRIDGE_MM / mm, welded }));
    rows.push(`| Supports | ${supportsText(sup, mm, cellSize, (p) => namesAt(evaluation, p, cellSize).map((n) => n.name))} |`);
    const mm3 = mm * mm * mm;
    json.support = {
      volume: sup.volume, mm3: sup.volume * mm3, fromFloorMm3: sup.fromFloor * mm3, onModelMm3: sup.onModel * mm3, areaMm2: sup.area * mm * mm, tallestMm: sup.tallest * mm, at: sup.at, skippedMm2: sup.skipped * mm * mm,
      sliver: sup.sliver ? { areaMm2: sup.sliver.area * mm * mm, faces: sup.sliver.faces } : undefined,
      bridged: { mm3: sup.bridged * mm3, areaMm2: sup.bridgedArea * mm * mm, spanMm: BRIDGE_MM, longestMm: sup.longestBridge * mm, at: sup.bridgeAt },
      islands: sup.islands.slice(0, 50).map((i) => ({ at: i.at, columnMm: i.height * mm, onModel: i.onModel, hangsMm: i.depth * mm, steps: namesAt(evaluation, i.at, cellSize).map((n) => n.name) })),
      islandCount: sup.islands.length,
    };
    if (sup.volume > 0) summary.push(`${fmtMm(sup.volume * mm3 >= 1000 ? (sup.volume * mm3) / 1000 : sup.volume * mm3)} ${sup.volume * mm3 >= 1000 ? "cm³" : "mm³"} of support`);
    if (sup.islands.length) summary.push(`${sup.islands.length} island${sup.islands.length === 1 ? "" : "s"} needing a column`);
  } else rows.push(`| Thinnest wall, supports | not measured on a quick pass |`);
  const contact = contactArea(mesh, cellSize, physics.floor) * mm * mm;
  rows.push(`| On the plate | ${fmtMm(contact)} mm² of the base rests flat on the bed${contact < 0.02 * sizeMm[0] * sizeMm[1] ? " (a small foothold for its size: a brim, or a flat cut under it, holds it down)" : ""} |`);
  const volMm3 = Math.abs(physics.volume) * mm * mm * mm;
  rows.push(`| Material | ${fmtMm(volMm3 / 1000)} cm³ solid, about ${fmtMm((volMm3 / 1000) * 1.24)} g of PLA (1.24 g/cm³) at full infill; a slicer's infill uses less |`);
  const t3 = threemfUnit(u.units);
  const in3mf = t3.scale === 1 ? UNIT_PLURALS[u.units] : `millimetres (3MF has no ${UNIT_PLURALS[u.units].replace(/s$/, "")}: the coordinates are scaled by ${fmt(t3.scale)})`;
  rows.push(`| Files | ${[files.stl ? "model.stl in millimetres" : "", files.threemf ? `model.3mf in ${in3mf} with the materials' colours` : ""].filter(Boolean).join(", ") || "none (exports off)"}${files.stl || files.threemf ? ", z up as a slicer's plate is" : ""} |`);
  Object.assign(json, { contactMm2: contact, volumeMm3: volMm3 });
  // Turned on the plate is no problem (a slicer turns it); lying down changes the supports, and not fitting is a warning.
  const problems = [pieces > 1 ? `${pieces} pieces` : "", !watertight ? "not watertight" : "", bed && !fit.fits && fit.turned === undefined ? (fit.lying ? "fits the bed only lying down" : "does not fit the bed") : ""].filter(Boolean);
  const good = [pieces === 1 ? "one piece" : "", watertight ? "watertight" : "", bed && fit.fits ? "fits the bed" : bed && fit.turned !== undefined ? `fits the bed turned ${fit.turned}°` : ""].filter(Boolean);
  const head = `| Summary | ${problems.length ? `check first: ${problems.join(", ")}` : good.join(", ")}${summary.length ? `; ${summary.join(", ")}` : ""}${u.assumed ? "; units assumed to be millimetres" : ""} |`;
  return { lines: ["## Print", "", "| | |", "| --- | --- |", head, ...rows, ""], json };
}

/**
 * A step or object to frame, as `--focus` and a camera's focus= do: its surface where the output puts it, grown
 * a little; `name_3` is one copy of a placed set, rebuilt from its base and placement (round 6: focusing on a
 * placed group framed the whole span between its copies).
 */
export function resolveFocusOf(evaluation: Evaluation, output: Shape3 | undefined, name: string): { frame: Bounds; shape: Shape3 } | undefined {
  let st = evaluation.steps.find((x) => x.name === name && isShape3(x.value));
  let obj = evaluation.objects.find((o) => o.name === name);
  let fs = st ? (st.value as Shape3) : obj?.shape;
  const copy = /^(.+)_(\d+)$/.exec(name);
  if (!fs && copy) {
    const setStep = evaluation.steps.find((x) => x.name === copy[1] && isShape3(x.value) && (x.value as Shape3).instanced);
    const setObj = evaluation.objects.find((o) => o.name === copy[1] && o.shape.instanced);
    const set = setStep ? (setStep.value as Shape3) : setObj?.shape;
    const pl = set?.instanced?.placements[Number(copy[2]) - 1];
    if (set && pl) {
      let sh = set.instanced!.base;
      if (pl.scale !== 1) sh = scaleShape(sh, pl.scale, pl.scale, pl.scale);
      if (pl.yaw !== 0) sh = rotateShape(sh, 0, pl.yaw, 0);
      fs = move(sh, pl.x, pl.y, pl.z);
      st = setStep;
      obj = setObj;
    }
  }
  if (!fs || isEmpty(fs.bounds)) return undefined;
  // A region (a probe an assert reads) or a cutter is not geometry to draw: the focus is the model inside its
  // frame (round 10: --focus on a counterbore's region drew the region as a solid cylinder).
  const role = st ? evaluation.roles.get(st.name) : undefined;
  if (output && st && (role === "region" || role === "cut")) {
    const fb0 = (placedBounds(output, fs, tightBounds(fs)) ?? tightBounds(fs));
    const grow0 = Math.max(...boundsSize(fb0)) * 0.08;
    const frame0: Bounds = { min: [fb0.min[0] - grow0, fb0.min[1] - grow0, fb0.min[2] - grow0], max: [fb0.max[0] + grow0, fb0.max[1] + grow0, fb0.max[2] + grow0] };
    return { frame: frame0, shape: clipTo(output, frame0) };
  }
  // The step's surface, not its box: a joint's box is the box of a turned box (measured: focus on a boom framed the
  // whole machine); carried through the joints and transforms above it, so a bucket inside a turned joint is
  // framed where the pose put it (measured: --focus in a pose framed the rest position).
  const own = tightBounds(fs);
  const fb = (output && st ? placedBounds(output, fs, own) : undefined) ?? own;
  const grow = Math.max(...boundsSize(fb)) * 0.08;
  return { frame: { min: [fb.min[0] - grow, fb.min[1] - grow, fb.min[2] - grow], max: [fb.max[0] + grow, fb.max[1] + grow, fb.max[2] + grow] }, shape: (output && st ? placedShape(output, fs) : undefined) ?? fs };
}

export function run(source: string, sourceName: string, outDir: string, opts: RunOptions = {}): RunResult {
  // The beauty render's pool for this run, opened once the program is evaluated, closed however the run ends.
  const session: { pool?: BeautyPool } = {};
  try {
    return runWith(source, sourceName, outDir, opts, session);
  } finally {
    session.pool?.close();
  }
}

function runWith(source: string, sourceName: string, outDir: string, opts: RunOptions, session: { pool?: BeautyPool }): RunResult {
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
  // What the last run wrote here: whatever of it this run does not write is removed at the end, so the folder holds one
  // run's files (round 11: beauty_iron.png, beauty_torch.png and lights.png from earlier runs sat beside a quick sheet,
  // told apart only by their times).
  const earlier = previousFiles(outDir);

  // Evaluate once at rest to learn the poses, then again with the pose to show (if any); imports are cached across both.
  // Every import's samples, library and picture, as this run read or made them, for the beauty workers to build the
  // same shape from without reading a file again.
  const importSamples = new Map<string, MeshSamples>();
  const moduleSources = new Map<string, ModuleSource>();
  const pictures = new Map<string, DecodedPng>();
  const resolver = importResolver(sourceName, log, opts.importCache, importSamples);
  const resolveImage = imageResolver(sourceName, pictures);
  const program = parse(source);
  const modules = moduleResolver(sourceName, moduleSources);
  const skipAsserts = opts.asserts === false;
  // The asserts' own time, over every evaluation of the run, so a quick pass that spent it on them can say so.
  const runStart = performance.now();
  const assertClock = new AssertClock(() => performance.now(), () => {});
  const onAssert = (phase: "start" | "end", a: AssertInfo) => { opts.onAssert?.(phase, a); assertClock.hook(phase, a); };
  const rest = time("evaluate", () => evaluate(program, { resolveImport: resolver, resolveModule: modules, resolveImage, moduleFrom: sourceName, skipAsserts, slice: opts.slice, show: opts.show, onAssert }));
  const shownPose = opts.pose ?? (typeof rest.settings.pose === "string" ? rest.settings.pose : undefined);
  const shownJoints = shownPose ? rest.poses.find((p) => p.name === shownPose)?.joints : undefined;
  const evaluation = shownJoints ? evaluate(program, { resolveImport: resolver, resolveModule: modules, resolveImage, moduleFrom: sourceName, jointPoses: shownJoints, poseName: shownPose, skipAsserts, slice: opts.slice, show: opts.show, onAssert }) : rest;
  // The beauty render on several threads: workers that build the shown shape again from the program, sent it now so
  // they evaluate while this thread meshes. The run's beauty renders share the pool and a cache of built tables.
  const threads = Math.max(1, Math.floor(opts.threads ?? 1));
  if (threads > 1 && (opts.beauty || evaluation.settings.beauty === 1) && evaluation.output && !isEmpty(evaluation.output.bounds)) {
    session.pool = openBeautyPool(threads, log);
    session.pool?.warm({ source, sourceName, jointPoses: shownJoints, poseName: shownJoints ? shownPose : undefined, slice: opts.slice, show: opts.show, importSamples, modules: moduleSources, images: pictures });
  }
  const beautyTables = beautyCache();
  // The program evaluated in a pose, once per distinct pose: the pose sheet, the strips, a focused frame and the
  // asserts for a pose share it.
  // The rest pose is the rest evaluation, so the pose sheet's rest thumbnail does not judge every promise again.
  const evalCache = new Map<string, Evaluation>([["[]", rest]]);
  const evalAt = (joints: Record<string, JointPose>, poseName?: string): Evaluation => {
    const key = JSON.stringify(Object.entries(joints).sort(([a], [b]) => (a < b ? -1 : 1)));
    let ev = evalCache.get(key);
    if (!ev) { ev = evaluate(program, { resolveImport: resolver, resolveModule: modules, resolveImage, moduleFrom: sourceName, jointPoses: joints, poseName: poseName ?? rest.poses.find((p) => p.joints === joints)?.name, skipAsserts, slice: opts.slice, show: opts.show, onAssert }); evalCache.set(key, ev); }
    return ev;
  };
  // Asserts are the program's promises about the model as built, so they are judged at rest (round 7: a "2.5 tall"
  // on a rig failed in its jump pose) unless one names its pose, which is tested in that pose's evaluation.
  const asserts = collectAsserts(rest, (pn) => { const p = rest.poses.find((x) => x.name === pn); return p ? evalAt(p.joints, pn) : undefined; });
  const warnings = [...evaluation.warnings, ...restAssertWarningsFor(evaluation, rest), ...asserts.filter((a) => !a.passed).map(assertLine)];
  // A model is judged as a print only when the program says it is one (a unit or a bed) or the run asks for a print's
  // file (--3mf): a door for a game engine was told it prints 2.6 mm tall and its summary opened on a 0.0144 mm wall
  // (round 11). The STL is written for every model, so it does not count.
  const asPrint = !!opts.threemf || evaluation.settings.units !== undefined || evaluation.settings.bed !== undefined;
  // Set by a quick pass that dropped thin steps: the pieces count is then not worth a warning.
  let quickDropped = 0;
  // Set when the shown pose has lifted the whole model off the floor: standing is then not judged.
  let offFloor = false;
  // A focused render's close-up mesh judged on its own (round 4: a focus sheet could not say whether the lug was sound).
  let closeUpNote: string | undefined;
  // The focused step's name when the sheet drew the rest of the model as a ghost, for the report's file notes.
  let ghosted: string | undefined;
  // Which steps callouts.png labelled, for the report.
  let calloutNote: string | undefined;
  // The step slices.png cut through, when it was asked for one.
  let sliceNote: string | undefined;
  // Where each declared camera's shot was written, when the beauty render ran: beauty.png for the shot it shows.
  let shotFiles: Map<string, string> | undefined;
  let calloutData: { labelled: { name: string; cut?: boolean; visible: number }[]; unlabelled: string[]; unseen: string[] } | undefined;
  // The rest pose's cell, when a pose is shown and meshed at it rather than with the grid across the posed box.
  let poseCell: number | undefined;
  let poseCoarser = false;
  // Every cluster of open edges, for report.json: where, how many, which steps (round 6: most edges were unattributed).
  const edgeList: { at: Vec3; count: number; steps: string[]; gap?: number }[] = [];
  if (shownPose && !shownJoints && shownPose !== "rest") warnings.push(`pose ${shownPose}: no such pose (poses: ${rest.poses.map((p) => p.name).join(", ") || "none"}); showing rest`);
  const shapeAt: ShapeAt = (joints) => evalAt(joints).output;
  let grid = Math.max(8, Math.round(opts.grid ?? (evaluation.settings.grid as number | undefined) ?? opts.defaultGrid ?? 128));
  const size = Math.max(64, Math.round(opts.size ?? (evaluation.settings.size as number | undefined) ?? 512));
  const output = evaluation.output;
  // A quick pass on a model made of thin parts (a clock with a pane, hands, a rod and mouldings) drops half its
  // steps at the quick grid and shows nothing worth judging (measured: 20 of 41 steps). It steps the grid up, to
  // 128 at most, until fewer than a quarter of the geometry steps are thinner than the cell; still a few seconds.
  // A pose is judged at rest here too, since it is meshed at the rest pose's cell (below).
  const stepEv = shownJoints && rest.output && !isEmpty(rest.output.bounds) ? rest : evaluation;
  if (opts.quick && stepEv.output && !isEmpty(stepEv.output.bounds)) {
    const geometry = geometrySteps(stepEv).size || 1;
    const longest = Math.max(...boundsSize(stepEv.output.bounds));
    for (const g of [grid, 96, 128]) {
      if (g < grid) continue;
      grid = g;
      if (thinWarnings(stepEv, longest / g, g).length <= geometry / 4) break;
    }
  }
  // Joints and poses: the sheet shows `set pose` (rest by default); exports are always at rest.
  const joints = output ? allJoints(output) : [];
  const jointNames = joints.map((j) => j.joint!.name);
  const poseViews: PoseView[] = evaluation.poses.map((p) => ({ name: p.name, joints: p.joints }));
  // Every animation sampled once, for the GLB and the Bedrock file alike: glTF samplers and Bedrock keyframes are
  // both linear, so an eased animation is sampled a few times per segment and a linear one at its keys.
  const clips: BedrockClip[] = evaluation.animations
    .filter((a) => a.poses.every((pn) => pn === "rest" || poseViews.some((v) => v.name === pn)))
    .map((a) => {
      const keys = a.poses.map((pn) => poseViews.find((v) => v.name === pn) ?? { name: "rest", joints: {} });
      const timing = { times: a.times, ease: a.ease, easeEnds: a.easeEnds };
      const keyTimes = a.times ?? keys.map((_, i) => (keys.length === 1 ? 0 : (i / (keys.length - 1)) * a.seconds));
      const times: number[] = [];
      for (let i = 0; i < keyTimes.length - 1; i++) {
        // A segment eased at either key is sampled eight times; a linear one keeps its two keys.
        const eased = (i === 0 ? a.easeEnds : a.ease) > 0 || (i === keyTimes.length - 2 ? a.easeEnds : a.ease) > 0;
        const sub = eased ? 8 : 1;
        for (let k = 0; k < sub; k++) times.push(keyTimes[i] + ((keyTimes[i + 1] - keyTimes[i]) * k) / sub);
      }
      times.push(keyTimes[keyTimes.length - 1]);
      const samples = times.map((t) => interpolatePose(keys, jointNames, a.seconds > 0 ? t / a.seconds : 0, timing));
      const axes: Record<string, Vec3 | undefined> = {};
      for (const j of joints) axes[j.joint!.name] = j.joint!.axis;
      return { name: a.name, seconds: a.seconds, loop: a.loop, times, samples, axes };
    });
  // `set camera hero` makes a declared shot the sheet's and the beauty render's view; the CLI still overrides.
  const shotName = opts.camera ?? (typeof evaluation.settings.camera === "string" ? evaluation.settings.camera : undefined);
  const shot = shotName ? evaluation.cameras.find((c) => c.name === shotName) : undefined;
  if (opts.camera && !shot) warnings.push(`--camera ${opts.camera}: no such camera${evaluation.cameras.length ? `; cameras: ${evaluation.cameras.map((c) => c.name).join(", ")}` : " (declare one with camera(name, ...))"}; ${opts.shots === false || !evaluation.cameras.length ? "beauty.png takes the render's own view" : "every shot is rendered"}`);
  const azimuth = opts.azimuth ?? shot?.azimuth ?? (evaluation.settings.azimuth as number | undefined) ?? 35;
  const elevation = opts.elevation ?? shot?.elevation ?? (evaluation.settings.elevation as number | undefined) ?? 25;
  // The command line's angles over the camera's own make beauty.png another picture than beauty_<name>.png, so its
  // caption and the report say which (round 11: a door rendered with --azimuth 22 over set camera hero had beauty.png
  // and lights.png at 22 and beauty_hero.png at -18, both captioned as the camera's, and read as the light study
  // ignoring the camera).
  const shotOverrides = shot ? ([["azimuth", opts.azimuth, shot.azimuth], ["elevation", opts.elevation, shot.elevation], ["zoom", opts.zoom, shot.zoom]] as const).filter(([, o, c]) => o !== undefined && c !== undefined && o !== c).map(([k, o]) => `--${k} ${fmt(o!)}`).join(" ") : "";
  const shotLabel = shot ? `camera ${shot.name}${shotOverrides ? ` with ${shotOverrides}` : ""}` : "";
  // `--environment all`, or a list `--environment studio,overcast`, renders the shot under each of those skies into
  // environments.png in the one run (round 10: a glass dome compared under two skies took two full renders); a list
  // gives beauty.png its first sky, as a single name does, and `all` leaves beauty.png the program's own.
  const skyArg = opts.environment;
  const skyList = skyArg === "all" ? [...ENVIRONMENTS] : skyArg && skyArg.includes(",") ? skyArg.split(",").map((x) => x.trim()).filter(Boolean) : undefined;
  const badSkies = (skyList ?? (skyArg && skyArg !== "all" ? [skyArg] : [])).filter((x) => !ENVIRONMENTS.includes(x as Environment));
  const skies = skyList?.filter((x): x is Environment => ENVIRONMENTS.includes(x as Environment));
  const environmentName = skyArg === "all" ? evaluation.settings.environment : skyList ? skies?.[0] ?? evaluation.settings.environment : skyArg ?? evaluation.settings.environment;
  const environment: Environment | undefined = ENVIRONMENTS.includes(environmentName as Environment) ? (environmentName as Environment) : undefined;
  if (badSkies.length) warnings.push(`--environment ${badSkies.join(",")}: no such environment; the skies are ${ENVIRONMENTS.join(", ")}, a list of them (studio,overcast), or all for a strip of every sky`);

  const crease = opts.crease ?? (typeof evaluation.settings.crease === "number" ? evaluation.settings.crease : undefined);
  let minecraftNote: string | undefined;
  const minecraftEntity = opts.minecraftEntity ?? evaluation.settings.minecraft_entity === 1;
  let robloxNote: string | undefined;
  let mapsNote: string | undefined;
  // Set when the GLB, OBJ and viewer were decimated to the web cap, for the report.
  let exportsNote: { triangles: number; cap: number; cell: number; before: number; deviation: number; fullDeviation: number; where?: string; meshes: { name: string; before: number; after: number }[]; flat: number; seams?: { texels: number; differ: number }; fieldNormals: boolean; atlas: boolean } | undefined;
  // A Roblox accessory hangs on an attachment and never stands, so its balance is not worth a warning.
  const robloxAccessory = (opts.roblox ?? evaluation.settings.roblox === 1) && !!rest.output && Object.keys(anchorsOf(rest.output)).some((n) => /Attachment$/.test(n));
  let mesh: Mesh | undefined;
  let bounds: Bounds | undefined;
  let trueBounds: Bounds | undefined;
  let cellSize = 0;
  // The main mesh and the call that made it, which the export takes again for an object it would mesh the same way.
  let mainMesh: KnownMesh | undefined;
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
    // A pose is meshed at the rest pose's cell, not with the grid laid across the posed box: a joint turned up leaves
    // the box of a turned box, and the mixer's tilted head meshed the whole model a third coarser at the same grid,
    // the bowl's wall, which the pose does not move, from 2.6 cells to 1.8 and 31 open edges (round 11). The rest
    // cell is the rest render's: the grid across the rest surface's extent.
    let resolutionFor = (_b: Bounds) => grid;
    if (shownJoints && rest.output && !isEmpty(rest.output.bounds)) {
      const restLongest = Math.max(...boundsSize(time("extent:rest", () => tightBounds(rest.output!))));
      if (restLongest > 0) {
        poseCell = restLongest / grid;
        // The grid scaled by the posed side over the rest one (exactly the grid when they match), never past the
        // extractor's 512 cells a side, or the lattice would stop short of the box.
        resolutionFor = (b) => Math.min(500, grid * (Math.max(...boundsSize(b)) / restLongest));
      }
    }
    // What the main mesh was cut with, so the export can take it again when it would make the same call.
    let meshedWith = { resolution: resolutionFor(extractBox), bounds: extractBox };
    let nets = time("mesh", () => surfaceNets(output, { resolution: meshedWith.resolution, sharp: opts.sharp ?? evaluation.settings.sharp !== 0, crease, bounds: extractBox }));
    // The safety net: if the mesh reaches a face of a tightened box, something was cut off there (a part thinner than
    // the rays' spacing), so extract again over the whole bounds rather than ship a clipped model.
    if (extractBox !== output.bounds && triangleCount(nets.mesh) > 0) {
      const mb = meshBounds(nets.mesh);
      const near = nets.cellSize * 1.5;
      const clipped = [0, 1, 2].some((k) => (extractBox.min[k] > output.bounds.min[k] + near && mb.min[k] < extractBox.min[k] + near) || (extractBox.max[k] < output.bounds.max[k] - near && mb.max[k] > extractBox.max[k] - near));
      if (clipped) {
        log(`extent: the surface reaches the tightened box, so extracting over the full bounds instead`);
        meshedWith = { resolution: resolutionFor(output.bounds), bounds: output.bounds };
        nets = time("mesh", () => surfaceNets(output, { resolution: meshedWith.resolution, sharp: opts.sharp ?? evaluation.settings.sharp !== 0, crease }));
      }
    }
    mesh = nets.mesh;
    cellSize = nets.cellSize;
    mainMesh = { shape: output, mesh, resolution: meshedWith.resolution, bounds: meshedWith.bounds, sharp: opts.sharp ?? evaluation.settings.sharp !== 0, crease };
    // Past 500 cells along the posed box the rest cell cannot be kept (a folded arm unfolded at set grid 400), and the
    // title and the report say the cell is coarser than at rest rather than "as at rest".
    if (poseCell !== undefined && cellSize > poseCell * 1.001) poseCoarser = true;
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
    warnings.push(...cutWarnings(evaluation, fullCell));
    warnings.push(...glassWarnings(evaluation));
    // A program that names its printer's bed is told when the model does not fit it standing, turned or not.
    const bedSet = printBed(evaluation.settings);
    if (bedSet && triangleCount(mesh) > 0) {
      const fit = bedFit(mesh.positions, printUnits(evaluation.settings).mm, bedSet);
      if (!fit.fits && fit.turned === undefined) warnings.push(`The model is ${fit.size.map(fmtMm).join(" × ")} mm and ${fitText(fit, bedSet)}.`);
    }
    if (opts.quick) {
      // The quick cell drops what the full grid keeps; say so on the sheet rather than let a missing plank look like a bug.
      // Each step once, with the member it carries when that is a def's part or a profile's point (round 11: 'model'
      // named for a back panel built inside a library's case()).
      const dropped: string[] = [];
      for (const p of thinParts(evaluation, cellSize, grid)) if (!dropped.some((d) => d === p.step || d.startsWith(`${p.step} (`))) dropped.push(p.member ? `${p.step} (${p.member})` : p.step);
      // An import sampled finer than this pass's cell loses its thin parts here too (round 6: a quick sheet called an
      // imported playground twenty pieces).
      for (const st of evaluation.steps) if (isShape3(st.value) && st.value.sampledAt !== undefined && st.value.sampledAt < cellSize && !dropped.some((d) => d === st.name || d.startsWith(`${st.name} (`))) dropped.push(st.name);
      // Under two cells a part meshes but often with holes and seams: a bowl's 0.05 wall at 1.3 quick cells was drawn
      // as a sieve and named nowhere (round 11). Those are said too, without giving up the pieces count.
      const named = (n: string) => dropped.some((d) => d === n || d.startsWith(`${n} (`));
      const soft: string[] = [];
      for (const p of thinParts(evaluation, cellSize, grid, 2)) if (!named(p.step) && !soft.some((d) => d === p.step || d.startsWith(`${p.step} (`))) soft.push(p.member ? `${p.step} (${p.member})` : p.step);
      const list = (l: string[]) => { const sep = l.some((d) => d.includes(" (")) ? "; " : ", "; return `${l.slice(0, 6).join(sep)}${l.length > 6 ? `${sep}...` : ""}`; };
      const softNote = soft.length ? `${dropped.length ? "; and " : ""}${soft.length} step${soft.length === 1 ? " is" : "s are"} under two of its cells and may show holes or seams here: ${list(soft)}` : "";
      if (dropped.length) {
        quickDropped = dropped.length;
        warnings.push(`quick pass: ${dropped.length} step${dropped.length === 1 ? " is" : "s are"} thinner than this pass's ${fmt(cellSize)} cell and may be missing or broken on this sheet: ${list(dropped)}${softNote}. So the pieces count and the footprint are not judged here; the full render at grid ${fullGrid} has cell ${fmt(fullCell)}.`);
      } else if (soft.length) warnings.push(`quick pass: at this pass's ${fmt(cellSize)} cell, ${softNote}; the full render at grid ${fullGrid} has cell ${fmt(fullCell)}.`);
    }
    // The true extent comes from the mesh: bounds are boxes, and a difference keeps the left side's box
    // however much was cut away, so a note based on bounds once told a scene on the floor to ground() itself.
    const extent = triangleCount(mesh) > 0 ? meshBounds(mesh) : bounds;
    // A slab under a scene with its top at y = 0 is meant to be below the floor: no note for a thin one (round 10).
    if (extent.min[1] < -cellSize && -extent.min[1] > 0.1 * (extent.max[1] - extent.min[1]))
      lines.push(`Note: the lowest point of the surface is at y = ${fmt(extent.min[1])}; pipe the model through ground() to rest it on y = 0.`, "");
    else if (extent.min[1] > cellSize * 2)
      lines.push(`Note: the surface floats: its lowest point is at y = ${fmt(extent.min[1])}. ground() rests it on y = 0 (by bounds, which may be looser than the surface).`, "");
    trueBounds = extent;
  }

  if (mesh && bounds && output) {
    const views = opts.views ?? ["persp", "front", "right", "top"];
    // Views frame the surface's true extent, or the focused step's bounds.
    const focusName = opts.focus ?? (typeof evaluation.settings.focus === "string" ? evaluation.settings.focus : undefined);
    let focusStep = false;
    let frame = trueBounds ?? bounds;
    // The sheet's title names the pose it shows (round 8: two focus renders of a wheel read alike).
    let shownName = shownJoints ? `${evaluation.outputName} in pose ${shownPose}` : evaluation.outputName;
    // The focused step as it sits in the output (through the joints and moves above it), for the close-up's split
    // into the part itself and the ghost of everything else the frame holds.
    let focusShape: Shape3 | undefined;
    const resolveFocus = (name: string) => resolveFocusOf(evaluation, output, name);
    if (focusName) {
      const r = resolveFocus(focusName);
      if (r) { focusStep = true; frame = r.frame; focusShape = r.shape; shownName = `${shownName} → ${focusName}`; }
      else warnings.push(`focus ${focusName}: no such step or object; framing the whole model`);
    }
    // A focused sheet is a close-up: the model clipped to the frame and re-extracted at the frame's own cell, so a
    // lantern in a market is drawn with a lantern's detail rather than the market's (measured: a blob of six cells).
    let viewMesh = mesh, viewCell = cellSize;
    // On a focus sheet, the rest of the model inside the frame, drawn faint (round 7: the drone's body, clipped to
    // the gimbal's frame, was read as an unknown plate); its cell, for the ghost's depth margin.
    let viewGhost: Mesh | undefined, ghostCell = 0;
    if (focusName && frame !== (trueBounds ?? bounds)) {
      const sharp = opts.sharp ?? evaluation.settings.sharp !== 0;
      const clip = clipTo(output, frame);
      const close = time("focus", () => surfaceNets(clip, { resolution: grid, sharp, crease, bounds: frame }));
      if (triangleCount(close.mesh) > 0) {
        viewMesh = close.mesh; viewCell = close.cellSize;
        if (focusShape) {
          // The part on its own at the frame's cell, and everything else at twice it: a ghost is faint and is most
          // of the model, so it need not be sharp.
          const split = focusSplit(output, focusShape, frame, close.cellSize * GHOST_CELL);
          const part = time("focus:part", () => surfaceNets(split.focus, { resolution: grid, sharp, crease, bounds: frame }));
          if (triangleCount(part.mesh) > 0) {
            viewMesh = part.mesh;
            const ghost = time("focus:ghost", () => surfaceNets(split.ghost, { resolution: Math.max(8, Math.round(grid / GHOST_CELL)), sharp, crease, bounds: frame }));
            if (triangleCount(ghost.mesh) > 0) { viewGhost = ghost.mesh; ghostCell = ghost.cellSize; ghosted = focusName; }
          }
        }
        // The close-up is meshed at its own, finer cell, so its edges are a second reading of the same surface: the
        // clip faces are open by construction, so only edges away from the frame's faces count.
        const inside = (p: [number, number, number]) => [0, 1, 2].every((k) => p[k] > frame.min[k] + close.cellSize * 1.5 && p[k] < frame.max[k] - close.cellSize * 1.5);
        const w = watertightReport(close.mesh);
        const clusters = (w.clusters ?? []).filter((cl) => inside(cl.at));
        closeUpNote = clusters.length
          ? `not watertight at cell ${fmt(close.cellSize)}: ${clusters.map((cl) => `${cl.count} edges at (${cl.at.map(fmt).join(", ")})${stepsNear(evaluation, cl.at, close.cellSize * 2, 2).length ? ` in ${stepsNear(evaluation, cl.at, close.cellSize * 2, 2).join(", ")}` : ""}`).join("; ")} (edges on the frame's own faces are not counted)`
          : `yes at cell ${fmt(close.cellSize)} (the clip faces of the frame are not counted)`;
      }
    }
    const shownUnits = printUnits(evaluation.settings);
    // The size in the title is the mesh's extent held within the model's bounds, which are never smaller than the
    // surface: a coarse cell's vertices stray past a face (round 10: a quick sheet titled a 0.5-tall flange 0.52,
    // its engraving's vertices standing proud of the boss), and the frame keeps the mesh's own extent.
    const shownSize = !focusStep && trueBounds ? clampBounds(trueBounds, bounds) : undefined;
    const info = { name: shownName, bounds: frame, size: shownSize, triangles: triangleCount(viewMesh), cellSize: viewCell, cellNote: poseCell !== undefined && viewCell === cellSize ? (poseCoarser ? "coarser than at rest" : "as at rest") : undefined, warnings: warnings.length, azimuth, elevation, units: shownUnits.assumed ? undefined : shownUnits.units };
    time("sheet", () => write("sheet.png", renderSheet(viewMesh, info, size, viewGhost, ghostCell).toPng()));
    // The perspective view with the largest visible steps named, a leader line each: what maps a picture back to
    // the program (roadmap 9: "the thing at the top left is lantern_ring" as a fact). Not on a quick pass.
    if (!opts.quick && opts.callouts !== false) {
      // Every part and cutter but the output (a union a later union flattened is still a name the program reads);
      // a region only an assert or a decal reads is not geometry and gets no label (round 9: eye regions labelled).
      // Each step where the output puts it (round 10: a lantern built at the origin and carried up a lamp post by
      // its parents was labelled on the pavement, and a stripe revolved flat was labelled on the floor).
      // A step is derived (its surface may hold a cut face) when it or anything it is built from was cut: a band
      // turned upright after its engraving still carries the engraving's faces.
      const derivedMemo = new Map<string, boolean>();
      const derived = (name: string, depth = 0): boolean => {
        const known = derivedMemo.get(name);
        if (known !== undefined) return known;
        const st = evaluation.steps.find((x) => x.name === name);
        const d = !!st && depth < 64 && (st.cuts === true || [...st.deps].some((k) => evaluation.roles.get(k) !== "cut" && derived(k, depth + 1)));
        derivedMemo.set(name, d);
        return d;
      };
      const named = evaluation.steps.filter((s) => isShape3(s.value) && evaluation.used.has(s.name) && s.value !== output && !isEmpty((s.value as Shape3).bounds)).map((s) => ({ name: s.name, shape: placedUnder([output], s.value as Shape3), cut: evaluation.roles.get(s.name) === "cut", derived: derived(s.name) }));
      if (named.length) {
        const co = time("callouts", () => renderCallouts(viewMesh, named, info, size, viewCell, 20, azimuth, elevation, output));
        write("callouts.png", co.canvas.toPng());
        const label = (l: { name: string; cut?: boolean }) => (l.cut ? `${l.name} (cut)` : l.name);
        // The candidates no visible face was credited to, named too, so "unlabelled" and "not seen" read apart (round
        // 10: a hub's through-holes were never labelled and nothing said whether they were seen).
        const seen = new Set([...co.labelled, ...co.unlabelled].map((l) => l.name));
        const unseen = named.filter((n) => !seen.has(n.name) && evaluation.roles.get(n.name) !== "mask").map(label);
        calloutNote = co.labelled.length ? `${co.labelled.map(label).join(", ")}${co.unlabelled.length ? ` (in view but smaller, not labelled: ${co.unlabelled.map(label).join(", ")})` : ""}${unseen.length ? `; not seen from this view, hidden or every visible face of theirs a smaller step's: ${unseen.join(", ")}` : ""}` : "no named step has a visible surface from this view";
        calloutData = { labelled: co.labelled.map((l) => ({ name: l.name, cut: l.cut || undefined, visible: l.visible })), unlabelled: co.unlabelled.map(label), unseen };
      }
    }
    for (const v of views) time(`view:${v}`, () => write(`${v}.png`, renderView(viewMesh, info, v, size, { azimuth, elevation, ghost: viewGhost, ghostMargin: ghostCell }).toPng()));
    if (opts.slices !== false) {
      const at: Partial<Record<"x" | "y" | "z", number>> = {};
      for (const axis of ["x", "y", "z"] as const) {
        const v = evaluation.settings[`slice_${axis}`];
        if (typeof v === "number") at[axis] = v;
      }
      // A scene's default cut goes through its first object, which is the one to list first; a focus wins over that.
      const first = evaluation.objects.length > 1 && !focusName ? evaluation.objects[0].shape.bounds : undefined;
      let sliceInfo: typeof info = first && !isEmpty(first) ? { ...info, bounds: first, name: `${info.name} → ${evaluation.objects[0].name}` } : info;
      // A focus sheet's slices cut the part, with the cut through the rest of the model faint around it.
      let sliced: Shape3 = viewGhost && focusShape ? focusShape : output;
      let slicedGhost: Shape3 | undefined = viewGhost && focusShape ? output : undefined;
      // The default planes, which a plane lying on a face moves off.
      const levels: Partial<Record<"x" | "y" | "z", number>> = {};
      // `set slice tree` (or --slice tree): the three planes through one step where the output puts it, framed on it
      // with room round it for what it stands on, its own cut in full and the rest of the model's faint (round 10:
      // a terrarium's planes through the model's centre showed a plant as a floating blob, its stem off them). The
      // planes go through the step's solid centroid, or its widest section where the centroid's plane would cut
      // little of it (measured on 74 parts in five programs: a plane through the box's centre missed the part on 4
      // of 148 vertical cuts and cut under a quarter of its widest section on 8; the centroid rule on none).
      const sliceName = opts.slice ?? (typeof evaluation.settings.slice === "string" ? evaluation.settings.slice : undefined);
      let slicedThrough: string | undefined;
      if (sliceName) {
        const r = resolveFocus(sliceName);
        const st = evaluation.steps.find((x) => x.name === sliceName && isShape3(x.value));
        const role = st ? evaluation.roles.get(st.name) : undefined;
        // The step itself where the output puts it: a region or a cutter is not geometry, so its own solid places the
        // planes and the model is drawn in full.
        const own = st ? ((output && placedShape(output, st.value as Shape3)) ?? (st.value as Shape3)) : r?.shape;
        const lv = own ? sliceLevels(own, tightBounds(own), 40) : undefined;
        if (r && own && lv) {
          const ob = tightBounds(own);
          const grow = Math.max(...boundsSize(ob)) * 0.25;
          const frameS: Bounds = { min: [ob.min[0] - grow, ob.min[1] - grow, ob.min[2] - grow], max: [ob.max[0] + grow, ob.max[1] + grow, ob.max[2] + grow] };
          sliceInfo = { ...info, bounds: frameS, name: `${shownJoints ? `${evaluation.outputName} in pose ${shownPose}` : evaluation.outputName} → slice ${sliceName}` };
          const asPart = role !== "region" && role !== "cut";
          sliced = asPart ? own : output;
          slicedGhost = asPart ? output : undefined;
          (["x", "y", "z"] as const).forEach((axis, k) => { levels[axis] = lv.at[k]; });
          // A step that rests on the rest of the model, touching it or within two cells of it, is cut where it rests:
          // the two planes across the contact go through it, and the one lying along it (a horizontal plane under a
          // book on a shelf) keeps the step's own level (round 11: a leaning book's centroid put its vertical plane in
          // the air between two shelves). A cutter touches nothing; it is where the model is not.
          const contact = role !== "cut" ? time("slices:contact", () => restingContact(own, output, viewCell * 2, ob)) : undefined;
          let rests = "";
          if (contact) {
            const n = contact.normal;
            const along = n[0] === 0 && n[1] === 0 && n[2] === 0 ? 1 : [0, 1, 2].reduce((a, k) => (Math.abs(n[k]) > Math.abs(n[a]) ? k : a), 0);
            (["x", "y", "z"] as const).forEach((axis, k) => { if (k !== along) levels[axis] = contact.at[k]; });
            const moved = (["X", "Y", "Z"] as const).filter((_, k) => k !== along);
            rests = `, where it meets the rest of the model (${moved.join(" and ")}; ${"XYZ"[along]} at its own level)`;
          }
          slicedThrough = asPart ? `${sliceName}${rests || " at its centroid (or its widest section)"}, framed on it, the rest of the model faint` : `${sliceName} (a ${role}: its volume places the planes${rests}, and the model is drawn in full), framed on it`;
        } else warnings.push(`slice ${sliceName}: no such step or object with a surface; the slices cut through the model's centre`);
      }
      // A default plane that lies on a face (a 0.25-thick disc cut at y = 0.25) draws that face as outline, not as a
      // section: when a share of the mesh sits on the plane, it moves in by a cell and a half (round 10).
      if (!isEmpty(sliceInfo.bounds)) {
        const n = viewMesh.positions.length / 3;
        for (const [k, axis] of (["x", "y", "z"] as const).entries()) {
          if (at[axis] !== undefined) continue;
          if (n === 0) { if (levels[axis] !== undefined) at[axis] = levels[axis]; continue; }
          const level = levels[axis] ?? (slicedThrough ? undefined : boundsCenter(sliceInfo.bounds)[k]);
          if (level === undefined) continue;
          let on = 0;
          for (let v = 0; v < n; v++) if (Math.abs(viewMesh.positions[v * 3 + k] - level) < viewCell * 0.5) on++;
          if (on > n * 0.05) at[axis] = level - viewCell * 1.5;
          else if (levels[axis] !== undefined) at[axis] = levels[axis];
        }
      }
      time("slices", () => write("slices.png", renderSlices(sliced, sliceInfo, Math.round(size * 0.75), at, slicedGhost).toPng()));
      if (slicedThrough) sliceNote = slicedThrough;
    }
    if (opts.turntable !== false) time("turntable", () => write("turntable.png", renderTurntable(mesh!, info, Math.round(size / 2)).toPng()));
    // The same turn as a picture that moves: 24 frames in an animated PNG, which a browser plays and a plain
    // viewer shows as its first frame. Not on a quick pass.
    if (opts.turntable !== false && !opts.quick) time("turntable:apng", () => { const fr = turntableFrames(mesh!, info, Math.round(size / 2)); write("turntable.apng", encodeApng(fr[0].width, fr[0].height, fr.map((c) => c.data), 80)); });
    const textureSize = Math.round(opts.texture ?? (evaluation.settings.texture as number | undefined) ?? 1024);
    // The program's scene for the viewer's Scene mode: its sky and ambient as the beauty render takes them, its default
    // key when it declares no light, and its named cameras framed as their beauty shots are.
    // With no light declared, the beauty render's one key, placed by `set light_azimuth` and `set light_elevation` when
    // the program sets either, as renderBeauty places it.
    const keyDirection = (): Vec3 => {
      const az = typeof evaluation.settings.light_azimuth === "number" ? evaluation.settings.light_azimuth : undefined;
      const el = typeof evaluation.settings.light_elevation === "number" ? evaluation.settings.light_elevation : undefined;
      return az === undefined && el === undefined ? DEFAULT_LIGHT_DIRECTION : lightDirection(az ?? -40, el ?? 55);
    };
    const viewerScene = (lit: Bounds): ViewerScene => {
      const env = environment ?? "studio";
      const pal = environmentPalette(env);
      const setAmbient = typeof evaluation.settings.ambient === "number" ? Math.max(0, evaluation.settings.ambient) : 1;
      // E, as the beauty render takes it: the palette's intensity times `set ambient`. three.js's environmentIntensity.
      const E = setAmbient * pal.ambient;
      const zoom = opts.zoom ?? shot?.zoom ?? (typeof evaluation.settings.zoom === "number" ? evaluation.settings.zoom : undefined);
      const framed = (b: Bounds, focused: boolean, az: number, el: number, zm: number) => {
        const cam = perspective(b, 512, 512, az, el, 30, zm, focused ? pointsWithin(mesh!, b) ?? mesh!.positions : mesh!.positions);
        return { eye: cam.eye.map((v) => Number(v.toFixed(5))) as Vec3, target: boundsCenter(b).map((v) => Number(v.toFixed(5))) as Vec3, fov: 30 };
      };
      const cameras = evaluation.cameras.map((c) => {
        const r = c.focus ? resolveFocus(c.focus) : undefined;
        return { name: c.name, ...framed(r ? r.frame : focusName ? frame : lit, !!(r || focusName), c.azimuth ?? azimuth, c.elevation ?? elevation, c.zoom ?? zoom ?? 1) };
      });
      // beauty.png's own camera: the shot `set camera` names, or the default, framed as the beauty render frames it.
      const shotFocus = shot?.focus ? resolveFocus(shot.focus) : undefined;
      const beautyShot = framed(shotFocus ? shotFocus.frame : focusName ? frame : lit, !!(shotFocus || focusName), azimuth, elevation, zoom ?? 1);
      // The lights as the beauty render takes them: the program's, or its one default key, for the sky (the sun and
      // the moon stand where the first directional light comes from) and the floor.
      const directional = evaluation.lights.length
        ? evaluation.lights.filter((l) => !l.position).map((l) => ({ dir: lightDirection(l.azimuth, l.elevation), color: l.color, power: Math.max(0, l.power) }))
        : [{ dir: keyDirection(), color: [1, 1, 1] as Vec3, power: 1 }];
      const key = directional.length ? directional[0].dir : DEFAULT_LIGHT_DIRECTION;
      // The sky the beauty render lights this shot with, from the run's cache, so the beauty render finds it built.
      const sky = buildEnvironment(env, { cameraAzimuth: azimuth, key, cache: beautyTables });
      const map = environmentLatLong(sky);
      // The floor's albedo, solved as the beauty render solves it: what shows the palette's open floor near the model
      // under the sky's light from above and every directional light at full strength.
      const up = [0, 0, 0], open = [0, 0, 0], lit3 = [0, 0, 0];
      irradiance(sky, 0, 1, 0, up, 0);
      decode(pal.open[0], pal.open[1], pal.open[2], open, 0);
      for (const l of directional) for (let c = 0; c < 3; c++) lit3[c] += toLinear(l.color[c]) * l.power * KEY * Math.max(0, l.dir[1]);
      const floorAlbedo = [0, 1, 2].map((c) => Number(Math.min(0.95, open[c] / Math.max(1e-4, up[c] * E + lit3[c])).toFixed(5))) as Vec3;
      // The sky at the horizon the shot looks towards, which the far floor fades into.
      const horizonAt = (s: typeof sky, c: { eye: Vec3; target: Vec3 }): Vec3 => {
        const h = [0, 0, 0];
        horizonRadiance(s, c.target[0] - c.eye[0], c.target[2] - c.eye[2], h, 0);
        return h.map((v) => Number(v.toPrecision(6))) as Vec3;
      };
      return {
        environment: env,
        sky: pal.sky, ...(pal.horizon ? { horizon: pal.horizon } : {}), ground: pal.ground,
        ambient: Number(E.toFixed(5)),
        light: { width: map.width, height: map.height, data: map.data, sh: Array.from(map.diffuseSH, (v) => Number(v.toPrecision(6))) },
        floorAlbedo,
        floorFade: { min: lit.min.map((v) => Number(v.toFixed(5))) as Vec3, max: lit.max.map((v) => Number(v.toFixed(5))) as Vec3, reach: Number((1.5 * Math.hypot(...boundsSize(lit))).toPrecision(6)), horizon: horizonAt(sky, beautyShot) },
        ...(evaluation.lights.length ? {} : { key: { direction: keyDirection().map((v) => Number(v.toFixed(5))) as Vec3, intensity: Number((Math.PI * KEY).toPrecision(6)) } }),
        cameras,
        shot: beautyShot,
        start: evaluation.lights.length > 0 || evaluation.settings.environment !== undefined,
        ...(shot ? { camera: shot.name } : {}),
      };
    };
    // Wear reads curvature over a distance set by the model's size, the same in the bake and the beauty render, so
    // the GLB's worn edges are the picture's and a quick pass shows the band the full render will.
    const wearScale = triangleCount(mesh!) > 0 ? wearProbe(Math.max(...boundsSize(meshBounds(mesh!)))) : undefined;
    if (opts.obj !== false || opts.glb !== false) {
      // Exports come from the node tree at rest: an object per scene entry, a node per joint and per placement.
      const stepNames = new Map<Shape3, string>();
      for (const st of rest.steps) if (isShape3(st.value) && !stepNames.has(st.value)) stepNames.set(st.value, st.name);
      // A web export has a budget like a Roblox one: past it the meshes are decimated before the atlas is baked, and
      // the report says by how much and how far the result strays from the model.
      const cap = Math.max(0, Math.round(opts.triangles ?? (typeof evaluation.settings.triangles === "number" ? evaluation.settings.triangles : WEB_TRIANGLES)));
      const hierarchy = time("hierarchy", () => buildHierarchy(rest.objects, { cellSize, sharp: opts.sharp ?? evaluation.settings.sharp !== 0, crease, texture: textureSize > 0 ? Math.max(64, textureSize) : 0, names: stepNames, wearProbe: wearScale, maxTriangles: cap > 0 ? cap : undefined, known: mainMesh }));
      warnings.push(...hierarchy.notes);
      const nodes = flatten(hierarchy).length;
      const extraMaps = [hierarchy.normalMap ? "normal" : "", hierarchy.metalRoughMap ? "metallic-roughness" : "", hierarchy.emissiveMap ? "emissive" : ""].filter(Boolean);
      log(`exports: ${hierarchy.meshes.length} mesh${hierarchy.meshes.length === 1 ? "" : "es"} in ${nodes} node${nodes === 1 ? "" : "s"}, ${hierarchy.triangles} triangles${hierarchy.decimated ? ` (decimated from ${hierarchy.decimated.before})` : ""}${hierarchy.atlas ? `, atlas ${textureSize}px with ${hierarchy.atlasCharts} charts${extraMaps.length ? ` and ${extraMaps.join(", ")} map${extraMaps.length === 1 ? "" : "s"}` : ""}` : ""}, in ${timings.hierarchy} ms`);
      if (hierarchy.decimated) {
        const dz = hierarchy.decimated;
        exportsNote = { triangles: hierarchy.triangles, cap, cell: cellSize, ...dz, ...(hierarchy.seams ? { seams: hierarchy.seams } : {}), fieldNormals: !!hierarchy.fieldNormals, atlas: !!hierarchy.atlas };
        // Past a cell, and further than the full mesh already was, the decimation is visible: say so and how to stop it.
        if (dz.deviation > cellSize && dz.deviation > dz.fullDeviation * 1.05)
          warnings.push(`The exports are decimated from ${dz.before} to ${hierarchy.triangles} triangles and stray up to ${fmt(dz.deviation)} from the surface at a face centre, ${fmt(dz.deviation / cellSize)} of the ${fmt(cellSize)} cell (the full mesh: ${fmt(dz.fullDeviation)}): raise the cap (set triangles ${Math.min(dz.before, Math.max(cap, hierarchy.triangles) * 2)}), or set triangles 0 for the full mesh.`);
      }
      if (hierarchy.normalStats) log(`normal map: ${hierarchy.normalStats.written ? "baked" : "not baked"}, ${hierarchy.normalStats.reason}`);
      if (hierarchy.seams?.texels) log(`material seams: ${hierarchy.seams.texels} texels on faces across a seam painted from the surface (${hierarchy.seams.differ} differ from the nearest corner)`);
      // Which materials the GLB's maps carry, so the finish can be checked without opening the PNGs.
      if (hierarchy.materialMaps) {
        const who = (k: "normal" | "metalRough" | "emissive") => [...hierarchy.materialMaps!].filter(([, mm]) => mm[k]).map(([m]) => m.name);
        const glows = [...hierarchy.materialMaps].filter(([m, mm]) => m.glow > 0 && !mm.emissive).map(([m]) => m.name);
        const parts = [
          ...(who("normal").length ? [`normal map (model_normal.png) for ${countedNames(who("normal"))}`] : []),
          ...(who("metalRough").length ? [`metallic-roughness map (model_mr.png) for ${countedNames(who("metalRough"))}`] : []),
          ...(who("emissive").length ? [`emissive map (model_emissive.png) for ${countedNames(who("emissive"))}`] : []),
          ...(glows.length ? [`an emissive colour for ${countedNames(glows)}`] : []),
        ];
        if (parts.length) mapsNote = `${parts.join("; ")}; every material has the colour atlas (model.png)`;
      }
      if (hierarchy.atlas) write("model.png", hierarchy.atlas.toPng());
      // The maps beside the atlas, on its UVs, each only when the bake found something for it: for reading.
      if (hierarchy.normalMap) write("model_normal.png", hierarchy.normalMap.toPng());
      if (hierarchy.metalRoughMap) write("model_mr.png", hierarchy.metalRoughMap.toPng());
      if (hierarchy.emissiveMap) write("model_emissive.png", hierarchy.emissiveMap.toPng());
      const glbAnimations: GlbAnimation[] = clips.map((c) => {
        const rotations: Record<string, [number, number, number, number][]> = {};
        const moves: Record<string, Vec3[]> = {};
        const scales: Record<string, Vec3[]> = {};
        for (const j of joints) {
          const jn = j.joint!.name;
          const axis = j.joint!.axis;
          // Only the joints a clip turns, moves or scales get channels (round 7: a lid's identity keys in the crank's clip).
          if (c.samples.some((s) => s[jn]?.angles.some((v) => v !== 0))) rotations[jn] = c.samples.map((s) => { const an = s[jn]?.angles ?? [0, 0, 0]; return axis ? axisAngleToQuat(axis, an[0]) : eulerToQuat(an[0], an[1], an[2]); });
          // Translation and scale channels only where a key moves or scales the joint: most joints only turn.
          if (c.samples.some((s) => s[jn]?.move.some((v) => v !== 0))) moves[jn] = c.samples.map((s) => [...(s[jn]?.move ?? [0, 0, 0])] as Vec3);
          if (c.samples.some((s) => s[jn]?.scale.some((v) => v !== 1))) scales[jn] = c.samples.map((s) => [...(s[jn]?.scale ?? [1, 1, 1])] as Vec3);
        }
        return { name: c.name, times: c.times, rotations, moves, scales };
      });
      if (opts.obj !== false) {
        const { obj, mtl } = toObjScene(hierarchy, name, "model.mtl", hierarchy.atlas ? "model.png" : undefined);
        write("model.obj", obj);
        write("model.mtl", mtl);
        // The STL is the model as shown, posed if a pose is set: what a printer would print. STL has no unit and a
        // slicer reads millimetres, so it is written in millimetres from `set units` (a unit is a millimetre without).
        write("model.stl", toStl(mesh!, name, printUnits(evaluation.settings).mm));
        // The 3MF carries the unit and the colours, for a program that says it is a print (units or a bed) or --3mf.
        if (asPrint) {
          // 3MF has no decimetre: such a model is written in millimetres, its coordinates scaled.
          const t3 = threemfUnit(printUnits(evaluation.settings).units);
          write("model.3mf", time("3mf", () => to3mf(mesh!, { name, unit: t3.unit, scale: t3.scale })));
        }
      }
      if (opts.glb !== false) {
        // The program's lights go into the GLB, so an engine lights the model as the beauty render does (round 11).
        const lit = triangleCount(mesh!) > 0 ? meshBounds(mesh!) : bounds;
        const litSize = boundsSize(lit);
        // A point light with no range reaches half the model's longest side, as in the beauty render.
        const punctual = glbLights(evaluation.lights, boundsCenter(lit), Math.max(0.5 * Math.hypot(litSize[0], litSize[1], litSize[2]), 1e-3), Math.max(...litSize) / 2 || 1);
        const glb = toGlbScene(hierarchy, name, glbAnimations, punctual);
        write("model.glb", glb);
        if (opts.viewer !== false) write("viewer.html", viewerHtml(glb, evaluation.outputName, bounds, hierarchy.triangles, glbAnimations.map((a) => a.name), viewerScene(lit)));
      }
      // Roblox: the meshes decimated to the budget (an accessory's 4000 when an Attachment anchor is present, a
      // MeshPart's 10000 otherwise), their own atlas, under a root turned to face -Z with the attachments as nodes.
      if (opts.roblox ?? evaluation.settings.roblox === 1) {
        const anchors = rest.output ? anchorsOf(rest.output) : {};
        const accessory = Object.keys(anchors).some((n) => /Attachment$/.test(n));
        const budget = accessory ? ACCESSORY_TRIANGLES : MESHPART_TRIANGLES;
        // The colour atlas alone, as before the PBR maps: what Studio's importer makes of a normal or packed
        // metallic-roughness map on a decimated mesh is untested.
        const rbHierarchy = time("roblox", () => buildHierarchy(rest.objects, { cellSize, sharp: opts.sharp ?? evaluation.settings.sharp !== 0, crease, texture: textureSize > 0 ? Math.max(64, textureSize) : 0, names: stepNames, maxTriangles: budget, maps: false, known: mainMesh }));
        // The Roblox meshes are decimated from the full extraction, not from the web export's capped count.
        const rb = toRoblox(rbHierarchy, name, { anchors, size: bounds ? boundsSize(bounds) : [0, 0, 0], animations: glbAnimations, before: hierarchy.decimated?.before ?? hierarchy.triangles });
        write("model.roblox.glb", rb.glb);
        warnings.push(...rb.warnings);
        robloxNote = rb.note + (rbHierarchy.decimated ? `; at most ${fmt(rbHierarchy.decimated.deviation)} from the surface at a face centre, ${fmt(rbHierarchy.decimated.deviation / cellSize)} of a cell` : "");
        log(`roblox: ${rb.note}, in ${timings.roblox} ms`);
      }
    }
    // Minecraft Bedrock geometry: the field voxelised at so many pixels per block and merged into cuboids, with a
    // texture of the materials. Written at rest, an object per bone, joints left to the game's own animation.
    const minecraftPx = opts.minecraft ?? (typeof evaluation.settings.minecraft === "number" ? evaluation.settings.minecraft : 0);
    if (minecraftPx > 0) {
      const entity = minecraftEntity;
      const bedrock = time("minecraft", () => toBedrock(rest.objects, name, { pixelsPerUnit: minecraftPx, entity }));
      write("model.geo.json", JSON.stringify(bedrock.geometry, null, 2) + "\n");
      write("model.geo.png", bedrock.texture.toPng());
      warnings.push(...bedrock.warnings);
      // A material the mesh shows but no face texel took is a decal smaller than a texel or off the lattice (round 8:
      // two 0.035 eyes painted the sheet and reached no texel, found only by reading the PNG texel by texel).
      if (mesh) for (const m of mesh.materials) if (!(bedrock.painted[m.name] > 0)) warnings.push(`minecraft: material "${m.name}" paints no texel of model.geo.png; a decal region must cover a texel centre (about a pixel across, on the ${bedrock.pixelsPerUnit}-pixel lattice), or the part it is on is thinner than a voxel`);
      // The animations as Bedrock keyframes on the joint bones, when the model has both.
      if (clips.length && bedrock.joints.length) write("model.animation.json", JSON.stringify(toBedrockAnimations(clips, name, bedrock.joints, { entity }), null, 2) + "\n");
      // A voxel is the geometry's cell: a part thinner than one is lost there whatever the render's grid. A whole
      // voxel always holds a sample centre, so the threshold is one voxel, not the mesher's 1.2 cells: a one-pixel
      // plate is the ordinary member of a block model.
      warnings.push(...minecraftThinWarnings(rest, minecraftPx, grid));
      const animNote = clips.length && bedrock.joints.length ? `; animation${clips.length === 1 ? "" : "s"} ${clips.map((c) => `animation.${name.replace(/[^A-Za-z0-9_]/g, "_")}.${c.name.replace(/[^A-Za-z0-9_]/g, "_")}`).join(", ")} in model.animation.json` : "";
      minecraftNote = `${bedrock.cubes} cube${bedrock.cubes === 1 ? "" : "s"} from ${bedrock.voxels} voxels at ${bedrock.pixelsPerUnit} pixels per block, texture ${bedrock.texture.width} × ${bedrock.texture.height}, bone${bedrock.bones.length === 1 ? "" : "s"} ${bedrock.bones.join(", ") || "none"}${bedrock.joints.length ? ` (${bedrock.joints.length} joint${bedrock.joints.length === 1 ? "" : "s"})` : ""}; identifier geometry.${name.replace(/[^A-Za-z0-9_]/g, "_")}${entity ? ", an entity facing north" : ", a block facing south"}${animNote}`;
      log(`minecraft: ${minecraftNote}, in ${timings.minecraft} ms`);
    }
    if (joints.length > 0 && opts.poses !== false) {
      // Pose thumbnails are meshed at 1.5 cells: measured, 2 cells at a 0.35 sheet was too coarse to tell a
      // bent elbow from a broken one; a full-size check of one pose is `set pose name` or `--pose name`.
      let poseCell = cellSize * 1.5;
      let poseShapeAt = shapeAt;
      // With a focus, the sheet and the strips are close-ups of that step where each pose puts it, at the frame's
      // own cell, so a gimbal's pan or a crank's turn is readable (round 7: a 10 px gimbal on a whole-drone strip);
      // the rest of the model in the frame is a ghost behind it.
      let poseGhostAt: ShapeAt | undefined;
      if (focusName && focusStep) {
        const focusAt = (ev: Evaluation): { fs: Shape3; frame: Bounds } | undefined => {
          const st = ev.steps.find((x) => x.name === focusName && isShape3(x.value));
          const fs = st ? (st.value as Shape3) : ev.objects.find((o) => o.name === focusName)?.shape;
          if (!fs || isEmpty(fs.bounds) || !ev.output) return undefined;
          const own = tightBounds(fs);
          const fb = placedBounds(ev.output, fs, own) ?? own;
          const grow = Math.max(...boundsSize(fb)) * 0.08;
          return { fs, frame: { min: [fb.min[0] - grow, fb.min[1] - grow, fb.min[2] - grow], max: [fb.max[0] + grow, fb.max[1] + grow, fb.max[2] + grow] } };
        };
        const restFocus = focusAt(evaluation);
        if (restFocus) poseCell = (Math.max(...boundsSize(restFocus.frame)) / grid) * 1.5;
        const splitAt = new Map<Evaluation, { focus: Shape3; ghost: Shape3 } | undefined>();
        const split = (ev: Evaluation) => {
          if (!splitAt.has(ev)) {
            const f = focusAt(ev);
            splitAt.set(ev, f && ev.output ? focusSplit(ev.output, placedShape(ev.output, f.fs) ?? f.fs, f.frame, poseCell * GHOST_CELL) : undefined);
          }
          return splitAt.get(ev);
        };
        poseShapeAt = (j) => { const ev = evalAt(j); return split(ev)?.focus ?? ev.output; };
        poseGhostAt = (j) => split(evalAt(j))?.ghost;
      }
      const cache: PoseCache = new Map();
      time("poses", () => write("poses.png", renderPoses(poseShapeAt, jointNames, poseViews, Math.round(size * 0.5), poseCell, azimuth, elevation, cache, !!(focusName && focusStep), poseGhostAt).toPng()));
      // A quick pass is for the geometry: the strips wait for the full render (round 7: 12 of a quick pass's 15 s).
      if (opts.quick) log(`quick pass: ${evaluation.animations.length} animation strip${evaluation.animations.length === 1 ? "" : "s"} skipped; the full render draws them`);
      else if (opts.animations === false) log(`${evaluation.animations.length} animation strip${evaluation.animations.length === 1 ? "" : "s"} skipped (--no-anims)`);
      else for (const a of evaluation.animations.filter((a) => !Array.isArray(opts.animations) || opts.animations.includes(a.name))) {
        const keys = a.poses.map((pn) => poseViews.find((v) => v.name === pn) ?? { name: "rest", joints: {} });
        time(`anim:${a.name}`, () => write(`anim_${a.name}.png`, renderAnimation(poseShapeAt, jointNames, a.name, keys, a.seconds, Math.round(size * 0.35), poseCell, 8, azimuth, elevation, { times: a.times, ease: a.ease, easeEnds: a.easeEnds, loop: a.loop }, cache, poseGhostAt).toPng()));
      }
    }
    if (opts.beauty || evaluation.settings.beauty === 1) {
      const bsize = Math.max(64, Math.round(opts.beautySize ?? size));
      const lightSize = typeof evaluation.settings.light_size === "number" ? evaluation.settings.light_size : undefined;
      const dof = typeof evaluation.settings.dof === "number" ? evaluation.settings.dof : undefined;
      const lightAzimuth = typeof evaluation.settings.light_azimuth === "number" ? evaluation.settings.light_azimuth : undefined;
      const lightElevation = typeof evaluation.settings.light_elevation === "number" ? evaluation.settings.light_elevation : undefined;
      const ambient = typeof evaluation.settings.ambient === "number" ? evaluation.settings.ambient : undefined;
      const zoom = opts.zoom ?? shot?.zoom ?? (typeof evaluation.settings.zoom === "number" ? evaluation.settings.zoom : undefined);
      // The program's lights, when it declares any; else the one key light the settings describe.
      const lights: BeautyLight[] | undefined = evaluation.lights.length ? evaluation.lights.map((l) => ({ name: l.name, azimuth: l.azimuth, elevation: l.elevation, size: l.size, color: l.color, power: l.power, position: l.position, range: l.range })) : undefined;
      // Framed like the views: on the focused step when there is one.
      // Framed on the surface the mesh found, not the box a blend or a displace padded (measured: a tree's box was
      // 10% wider than its surface on every side, and the zoom could not reach past it).
      // A `set camera` (or --camera) with a focus= frames beauty.png on it too, as its own beauty_<name>.png is
      // (round 10: an agent read beauty.png for the framed shot and judged the zoom erratic).
      // A focus shot frames its part but marches the whole model, so a hole under a counterbore still reads as
      // through and the floor's shadow is the model's (round 9: a focused counterbore looked blind).
      const modelBounds = triangleCount(mesh!) > 0 ? meshBounds(mesh!) : frame;
      // The caption names the shot and its size for whoever checks it; a presentation copy leaves it off (round 10: at
      // a low camera it overprinted a terrarium's base and label), with `set caption 0` or --no-caption.
      const captioned = opts.caption ?? evaluation.settings.caption !== 0;
      const shotFocus = shot?.focus ? resolveFocus(shot.focus) : undefined;
      const beautyFrame = shotFocus ? shotFocus.frame : focusName ? frame : triangleCount(mesh!) > 0 ? meshBounds(mesh!) : frame;
      // The camera fits the mesh's points inside the frame, so a focus, or a camera's focus=, frames that part
      // (measured: a focused beauty render fitted every point and framed the whole mug).
      const shoot = (file: string, b: Bounds, focused: boolean, az: number, el: number, zm: number | undefined, df: number | undefined, label: string) =>
        write(file, renderBeauty(output, mesh!, b, { size: bsize, cellSize, azimuth: az, elevation: el, lightSize, dof: df, lightAzimuth, lightElevation, ambient, zoom: zm, lights, environment, fitPoints: focused ? pointsWithin(mesh!, b) : undefined, reachBounds: focused ? modelBounds : undefined, label: captioned ? label : undefined, wearProbe: wearScale, pool: session.pool, cache: beautyTables }).toPng());
      // beauty.png is the shot: the camera `set camera` or --camera names, with what the command line overrides, framed
      // on its focus=, its caption naming the camera as that camera's own shot would. The light study and the skies
      // are the same shot, so each can be set beside it.
      const shotDof = shot?.dof ?? dof;
      const shotFocused = !!(shotFocus || focusName);
      time("beauty", () => shoot("beauty.png", beautyFrame, shotFocused, azimuth, elevation, zoom, shotDof, `${shownName}${shot ? `, ${shotLabel}` : ""}${shotFocus ? ` → ${shot!.focus}` : ""}  ${dimsLabel(!shotFocus && shownSize ? shownSize : beautyFrame)}`));
      // The strips' frames: half the beauty render's size, so a strip of four is as wide as two renders.
      const stripFrame = Math.max(96, Math.round(bsize * 0.5));
      const stripShot = (o: Partial<Parameters<typeof renderBeauty>[3]>) =>
        renderBeauty(output, mesh!, beautyFrame, { size: stripFrame, cellSize, azimuth, elevation, lightSize, lightAzimuth, lightElevation, ambient, zoom, lights, environment, fitPoints: shotFocused ? pointsWithin(mesh!, beautyFrame) : undefined, reachBounds: shotFocused ? modelBounds : undefined, wearProbe: wearScale, pool: session.pool, cache: beautyTables, ...o });
      // Every sky at once, or the ones listed, for choosing one: environments.png beside beauty.png.
      if (skies && skies.length) {
        const gutter = 6, bar = 26;
        const strip = new Canvas((stripFrame + gutter) * skies.length + gutter, bar + stripFrame + gutter * 2, INK.page);
        strip.fill(0, 0, strip.width, bar, INK.bar);
        barTitle(strip, `ENVIRONMENTS   the same shot under ${skyArg === "all" ? "each sky" : skies.join(", ")}`);
        time("environments", () => {
          skies.forEach((env, i) => strip.blit(stripShot({ environment: env, label: env }), gutter + i * (stripFrame + gutter), bar + gutter));
        });
        write("environments.png", strip.toPng());
      }
      const drewOn = session.pool?.live ? session.pool.threads : 1;
      log(`beauty render ${bsize}px in ${timings.beauty} ms on ${drewOn} thread${drewOn === 1 ? "" : "s"}${shot ? `, ${shotLabel}` : ""}`);
      // Each declared light alone, in a strip, so what a rim light adds can be seen rather than guessed from two
      // near-identical pictures (round 9: two agents could not tell whether a light did anything); under it, what each
      // light adds on its own, brightened, so a small point light's reach and colour can be judged (round 10: a
      // ring's spark was a few pixels in the strip), and last the picture under no light at all.
      // A light study is four or more marches more, so --beauty-only leaves it to --lights (round 11: 28 s of a material
      // loop's 36 went on lights.png and a second copy of the shot).
      if (lights && lights.length >= 2 && opts.lights !== false) {
        const gutter = 6, bar = 26, rowBar = 16;
        const cols = lights.length + 1;
        const strip = new Canvas((stripFrame + gutter) * cols + gutter, bar + (stripFrame + gutter) * 2 + rowBar + gutter, INK.page);
        strip.fill(0, 0, strip.width, bar, INK.bar);
        barTitle(strip, `LIGHTS   each alone, then all ${lights.length}`);
        const rowY = bar + gutter + stripFrame + gutter;
        // The row's key, as much of it as the strip is wide for (a quick pass's strip cut the long one short).
        const key = ["what each adds on its own, brightened by the gain shown, a glowing part flat grey. last: no light at all, the sky's ambient and the glows", "what each adds, brightened by the gain shown, glows grey. last: no light at all", "what each adds, glows grey. last: no light"].find((t) => textWidth(t, 1) + 20 <= strip.width) ?? "what each adds";
        drawText(strip, 10, rowY + 3, key, INK.dim, 1);
        const label = (c: Canvas, text: string, color = INK.dim) => drawText(c, 8, c.height - 12, text, color, 1);
        time("lights", () => {
          // No light: the same shot with one light of no power, so the lights' floor shares and the sky stay as they are.
          // Where a glowing part is: the frames of what a light adds draw it flat grey (round 11: a flame read green).
          const glow = new Uint8Array(stripFrame * stripFrame);
          const none = stripShot({ lights: [{ ...lights[0], power: 0 }], glowMask: glow });
          lights.forEach((l, i) => {
            const desc = l.position ? `at ${l.position.map(fmt).join(", ")}` : `az ${fmt(l.azimuth)} el ${fmt(l.elevation)}`;
            const alone = stripShot({ lights: [l] });
            const adds = lightContribution(alone, none, glow);
            label(alone, `${l.name}  ${desc}${l.power !== 1 ? `  power ${fmt(l.power)}` : ""}`);
            label(adds.canvas, `${l.name} adds${adds.gain > 1.05 ? `, ×${fmt(Number(adds.gain.toPrecision(2)))}` : ""}`, 0xb0b0b0);
            strip.blit(alone, gutter + i * (stripFrame + gutter), bar + gutter);
            strip.blit(adds.canvas, gutter + i * (stripFrame + gutter), rowY + rowBar);
          });
          strip.blit(stripShot({ label: "all" }), gutter + lights.length * (stripFrame + gutter), bar + gutter);
          label(none, "no light");
          strip.blit(none, gutter + lights.length * (stripFrame + gutter), rowY + rowBar);
        });
        write("lights.png", strip.toPng());
      }
      // Every declared camera is a shot of its own, framed on its focus= when it has one; --camera NAME and
      // --beauty-only render the one shot beauty.png is. The shot beauty.png already shows is not rendered again as
      // beauty_<name>.png (round 11: the same camera marched twice, 9 s of a minute's render); with the command line's
      // angles over it, beauty.png is another picture, and the camera's own is rendered.
      shotFiles = new Map();
      for (const c of evaluation.cameras) {
        const isShot = !!shot && c.name === shot.name;
        // --camera naming no camera leaves every shot to be rendered, as its warning says.
        if (!isShot && ((opts.camera && shot) || opts.shots === false)) continue;
        const r = c.focus ? resolveFocus(c.focus) : undefined;
        const b = r ? r.frame : beautyFrame;
        const az = c.azimuth ?? azimuth, el = c.elevation ?? elevation, zm = c.zoom ?? zoom, df = c.dof ?? dof;
        // A focus mostly hidden from its camera by the rest of the model is said, not discovered in the picture,
        // when another azimuth would see much more of it (a gem in its setting is hidden from every side alike).
        if (r) {
          const info = { name: shownName, bounds: modelBounds };
          const hidden = hiddenFraction(mesh!, b, info, cellSize, az, el, 160, r.shape);
          if (hidden > 0.15) {
            let bestAz = az, best = hidden;
            for (let k = 1; k < 8; k++) { const h = hiddenFraction(mesh!, b, info, cellSize, az + k * 45, el, 120, r.shape); if (h < best) { best = h; bestAz = az + k * 45; } }
            if (best < hidden - 0.2) warnings.push(`camera "${c.name}" (line ${c.line}): ${Math.round(hidden * 100)}% of ${c.focus} is hidden behind the rest of the model from azimuth ${fmt(az)}, elevation ${fmt(el)}; from azimuth ${fmt(((bestAz % 360) + 360) % 360)} it is ${Math.round(best * 100)}%`);
          }
        }
        if (isShot) {
          const same = az === azimuth && el === elevation && zm === zoom && df === shotDof && [0, 1, 2].every((k) => b.min[k] === beautyFrame.min[k] && b.max[k] === beautyFrame.max[k]);
          if (same) { shotFiles.set(c.name, "beauty.png"); log(`beauty_${c.name}.png not written: beauty.png is camera ${c.name}'s shot`); continue; }
          if (opts.shots === false) continue;
        }
        // An unfocused shot gives the model's size as beauty.png does, the mesh's extent held within the bounds.
        time(`beauty:${c.name}`, () => shoot(`beauty_${c.name}.png`, b, !!(r || focusName), az, el, zm, df, `${shownName}, camera ${c.name}${r ? ` → ${c.focus}` : ""}  ${dimsLabel(!r && shownSize ? shownSize : b)}`));
        shotFiles.set(c.name, `beauty_${c.name}.png`);
      }
    }
  }

  const shapeSteps = evaluation.steps.filter((s) => isShape3(s.value));
  if (opts.steps !== false && shapeSteps.length > 0) {
    const views: StepView[] = time("steps:mesh", () =>
      meshSteps(
        shapeSteps.map((s) => ({ name: s.name, shape: s.value as Shape3, used: evaluation.used.has(s.name), role: evaluation.roles.get(s.name), line: s.line })),
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
    const ph = time("physics", () => analyse(mesh!, cellSize));
    physics = ph;
    const main = ph.pieces[0];
    // A cavity (an inward shell, a lidded cup's inside) is not a piece; a speck is tiny in volume and in extent, so a
    // small real part (a star finial 0.6 wide) is a loose piece, not a sliver (measured: the two were swapped).
    const cavities = ph.pieces.filter((pc) => pc.cavity && !isSpeck(pc, ph, cellSize));
    const specks = ph.pieces.filter((pc) => !pc.cavity && isSpeck(pc, ph, cellSize));
    // Sub-cell cavities are grazing contacts, the watertight row's business, not voids; they count for nothing here.
    const parts = ph.pieces.length - specks.length - cavities.length - ph.pieces.filter((pc) => pc.cavity && isSpeck(pc, ph, cellSize)).length;
    if (parts > 1 && !evaluation.objects.some((o) => o.shape.instanced) && evaluation.objects.length === 1) {
      // Name the steps whose surface is near each loose piece's centre, smallest first (by the field, not the box:
      // measured, a blended step's box named the wrong part). A piece's centre can be inside a hollow, so the
      // tolerance is the piece's own size.
      const loose = physics.pieces.filter((pc) => !specks.includes(pc) && !pc.cavity && pc !== main).slice(0, 4);
      const where = loose.map((pc) => `volume ${looseText(evaluation, pc, cellSize)}`).join("; ");
      // A quick pass that dropped thin steps has probably dropped the joins too (round 4: every quick sheet of a
      // railed excavator said "4 pieces"); the note above says so instead.
      if (!quickDropped) warnings.push(`The model is ${parts} separate pieces: the largest is ${fmt(Math.abs(main.volume))}, the loose ${loose.length === 1 ? "piece is" : "pieces are"} ${where}${parts - 1 > loose.length ? ", ..." : ""}. A piece not touching the rest floats free: overlap parts slightly, or use scene for separate objects.`);
    }
    if (specks.length && !quickDropped) {
      const s0 = specks[0];
      const at = stepsNear(evaluation, s0.centre, s0.size + cellSize * 2);
      warnings.push(`${specks.length} tiny speck${specks.length === 1 ? "" : "s"} of mesh (under 0.1% of the volume and a few cells across): a sliver left by a cut or a part thinner than a cell. The largest is at (${s0.centre.map(fmt).join(", ")})${at.length ? ` in ${at.join(", ")}` : ""}.`);
    }
    // A quick pass that dropped thin steps may have dropped the feet (measured: a bicycle's stand), so it does not
    // judge standing either.
    offFloor = !!shownPose && physics.floor > cellSize * 2;
    if (quickDropped) { /* the quick note says the footprint is not judged */ }
    else if (offFloor) { /* the pose lifts the model off the floor: nothing to stand on (round 7: a drone at take-off) */ }
    else if (!physics.stable && physics.footprint.length >= 3 && !robloxAccessory)
      warnings.push(`The centre of mass (${physics.centre.map(fmt).join(", ")}) is ${fmt(-physics.stabilityMargin)} units outside the base's footprint: the model would tip over. Widen the base or move weight over it.`);
    else if (physics.stable && physics.stabilityMargin < cellSize * 3 && !robloxAccessory)
      warnings.push(`The centre of mass is only ${fmt(physics.stabilityMargin)} units inside the base's footprint: the model would balance, barely.`);
  }

  // Each object of a scene meshed on its own, for the Assembly table and for the Watertight row, which says when
  // every object is watertight alone and the fused scene's edges are only where they meet.
  type ObjectRow = { name: string; row: string; ok: boolean; edges?: string; json: Record<string, unknown> };
  let objectRows: ObjectRow[] | undefined;
  if (evaluation.objects.length > 1 && mesh && !opts.quick && cellSize > 0) {
    objectRows = [];
    for (const o of evaluation.objects) {
      const shape = o.shape.instanced ? o.shape.instanced.base : o.shape;
      if (isEmpty(shape.bounds)) { objectRows.push({ name: o.name, row: `| ${o.name} | empty | | | |`, ok: true, json: { empty: true } }); continue; }
      const own = time(`object:${o.name}`, () => surfaceNets(shape, { resolution: Math.max(8, Math.round(Math.max(...boundsSize(shape.bounds)) / cellSize)), sharp: opts.sharp ?? evaluation.settings.sharp !== 0, crease }));
      if (triangleCount(own.mesh) === 0) { objectRows.push({ name: o.name, row: `| ${o.name} | no surface | | | |`, ok: true, json: { empty: true } }); continue; }
      const w = watertightReport(own.mesh);
      const ph = analyse(own.mesh, own.cellSize);
      const solid = ph.pieces.filter((pc) => !pc.cavity && !isSpeck(pc, ph, own.cellSize)).length;
      const label = o.shape.instanced ? `${o.name} (each of ${o.shape.instanced.placements.length} copies)` : o.name;
      // The object's edges named among its own steps only, as the Watertight row names the scene's.
      const list: { at: Vec3; count: number; steps: string[]; gap?: number }[] = [];
      const alone: Evaluation = { ...evaluation, objects: [{ name: o.name, shape }] };
      const edges = w.ok ? undefined : watertightNote(w, alone, own.cellSize, list).slice(w.note.length).trim().replace(/^The edges are mostly /, `${w.nonManifold + w.holes} open edge${w.nonManifold + w.holes === 1 ? "" : "s"}, mostly `).replace("(every one is in report.json under watertight)", "(every one is in report.json under the object's watertight)");
      const first = list[0];
      const where = first ? `; ${first.count} at (${first.at.map(fmt).join(", ")})${first.steps.length ? ` in ${first.steps.map((n) => `'${n}'`).join(", ")}` : ""}, below` : "";
      objectRows.push({
        name: o.name, ok: w.ok, edges,
        row: `| ${label} | ${w.ok ? "yes" : `no: ${w.nonManifold + w.holes} edges${where}`} | ${solid} | ${ph.footprint.length < 3 ? "unknown" : ph.stable ? `yes, ${fmt(ph.stabilityMargin)} inside` : `no, ${fmt(-ph.stabilityMargin)} outside`} | ${(ph.overhang * 100).toFixed(ph.overhang < 0.095 ? 1 : 0)}% |`,
        json: { watertight: w.ok ? { ok: true } : { ok: false, edges: w.nonManifold + w.holes, clusters: list }, pieces: solid },
      });
    }
  }
  // The scene's fused mesh has edges no object has alone: where objects meet, or where its lattice falls otherwise.
  const fusedOnly = !!objectRows && objectRows.every((r) => r.ok)
    ? " Each object is watertight on its own (the Assembly table), so these edges are only in the fused scene, where objects meet or where its sample lattice falls otherwise; they are not in the objects' own meshes, which are what the GLB carries, and matter only for printing the scene as one piece."
    : "";

  // The report.
  let printJson: Record<string, unknown> | undefined;
  if (mesh && bounds) {
    const s = boundsSize(bounds);
    const wt = watertightReport(mesh);
    lines.push(
      "## Model",
      "",
      "| | |",
      "| --- | --- |",
      `| Size (w × h × d) | ${fmt(s[0])} × ${fmt(s[1])} × ${fmt(s[2])} units |`,
      `| Bounds | x ${fmt(bounds.min[0])}..${fmt(bounds.max[0])}, y ${fmt(bounds.min[1])}..${fmt(bounds.max[1])}, z ${fmt(bounds.min[2])}..${fmt(bounds.max[2])} (a box; loose after a cut, a rotation or a twist) |`,
      ...(trueBounds ? (() => { const e = clampBounds(trueBounds!, bounds!); return [`| Surface extent | x ${fmt(e.min[0])}..${fmt(e.max[0])}, y ${fmt(e.min[1])}..${fmt(e.max[1])}, z ${fmt(e.min[2])}..${fmt(e.max[2])} (from the mesh, within the bounds) |`]; })() : []),
      `| Triangles | ${triangleCount(mesh)} (${vertexCount(mesh)} vertices) |`,
      ...(exportsNote ? [`| Exports | ${exportsNote.triangles} triangles in the GLB, OBJ and viewer, decimated from ${exportsNote.before} (set triangles ${exportsNote.cap}; 0 for all of them): at most ${fmt(exportsNote.deviation)} from the surface at a face centre${exportsNote.where && exportsNote.meshes.length > 1 ? ` (in ${exportsNote.where})` : ""}, ${fmt(exportsNote.deviation / exportsNote.cell)} of a cell (the full mesh ${fmt(exportsNote.fullDeviation)})${exportsNote.triangles < exportsNote.flat ? (exportsNote.fieldNormals ? `; past the flat faces, so every material's texels carry the field's normal in the normal map and merged curved faces shade as the surface does, though their outlines are the coarser mesh's: read viewer.html` : exportsNote.atlas ? `; past the flat faces, though no merged face leans past ${BENT_DEGREES} degrees from the field's normal under it, so no normal map was written: read viewer.html` : `; past the flat faces, and with no texture atlas there is no normal map to carry the field's normal, so merged curved faces shade flatter than on the sheet though the surface is in place: read viewer.html`) : ""}. ${capShare(exportsNote)}${exportsNote.seams?.texels ? `. ${exportsNote.seams.texels} texels lie on faces that span two materials, each painted with the material of the surface under it (${exportsNote.seams.differ} of them took another material than the face's nearest corner)` : ""}; the sheet and the STL are the full mesh |`] : []),
      `| Volume | ${fmt(Math.abs(meshVolume(mesh)))} cubic units |`,
      `| Grid | ${grid} cells on the longest side, cell ${fmt(cellSize)} units${poseCell !== undefined ? poseCoarser ? ` (pose ${shownPose}: the rest pose's cell, ${fmt(poseCell)}, would be more than the 500 cells the extractor takes along the posed model, so this one is coarser than at rest)` : ` (the rest pose's cell, kept for pose ${shownPose}: ${Math.round(Math.max(...boundsSize(trueBounds ?? bounds)) / cellSize)} cells along its longest side)` : ""} |`,
      `| Watertight${shownPose ? ` (in pose ${shownPose}; the exports are at rest)` : ""} | ${watertightNote(wt, evaluation, cellSize, edgeList, !!shownJoints) + (wt.ok ? "" : fusedOnly || nearlyThin(evaluation, cellSize))} |`,
      ...(closeUpNote ? [`| Close-up watertight | ${closeUpNote} |`] : []),
      `| Materials | ${countedNames(mesh.materials.map((m) => m.name)) || "none"} |`,
      ...(asserts.length ? [`| Asserts | ${assertsRow(asserts)}${asserts.some((a) => a.pose) ? " (at rest, or in the pose each names)" : shownPose ? " (judged at rest)" : ""} |`] : []),
      ...(mapsNote ? [`| Maps | ${mapsNote} |`] : []),
      ...(robloxNote ? [`| Roblox | ${robloxNote} (model.roblox.glb: import with Studio's 3D Importer, then the Accessory Fitting Tool for an accessory) |`] : []),
      ...(minecraftNote ? [`| Minecraft | ${minecraftNote} (model.geo.json with model.geo.png; ${minecraftEntity ? "z is flipped: the entity's half turn and Bedrock's x mirror together" : "x is authored mirrored, as Bedrock draws it"}) |`] : []),
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
        `| Base footprint${shownPose ? ` (in pose ${shownPose})` : ""} | ${offFloor ? `none: the pose lifts the model off the floor (lowest point y = ${fmt(physics.floor)})` : physics.footprint.length >= 3 ? `${physics.footprint.length}-sided hull of the points within ${fmt(cellSize * 1.5)} of y = ${fmt(physics.floor)}` : "none (fewer than three contact points)"} |`,
        `| Stands${shownPose ? ` (in pose ${shownPose})` : ""} | ${offFloor ? "not judged: off the floor in this pose" : physics.footprint.length < 3 ? "unknown" : physics.stable ? `yes, centre of mass ${fmt(physics.stabilityMargin)} inside the footprint` : `no, centre of mass ${fmt(-physics.stabilityMargin)} outside the footprint`} |`,
        `| Overhangs | ${(physics.overhang * 100).toFixed(physics.overhang < 0.095 ? 1 : 0)}% of the surface faces down more than 45° above the floor${physics.overhang > 0.005 && asPrint ? " (a printer would need support there)" : ""} |`,
        `| Pieces | ${quickDropped ? `not judged on this quick pass (${quickDropped} thin step${quickDropped === 1 ? "" : "s"} dropped; the full render counts them)` : piecesRow(physics, evaluation, cellSize)} |`,
        `| Cavities | ${cavitiesRow(physics, cellSize)} |`,
        "",
      );
      // What a slicer's user wants first: the unit, the size in millimetres, the bed, the thinnest wall, the supports.
      // A model that is not a print gets one line saying how to make it one, and no wall or support passes.
      if (asPrint) {
        const solid = physics.pieces.filter((pc) => !pc.cavity && !isSpeck(pc, physics!, cellSize)).length;
        const pr = printSection(evaluation, output!, mesh, cellSize, physics, quickDropped ? 0 : solid, wt.ok, !!opts.quick, time, { stl: files.includes("model.stl"), threemf: files.includes("model.3mf") });
        lines.push(...pr.lines);
        printJson = { judged: true, ...pr.json };
      } else {
        lines.push(`Not judged as a print: \`set units mm\` (or cm, dm, m, in, ft) or \`set bed 220 220 250\` judges it as one, as \`--3mf\` does${files.includes("model.stl") ? "; model.stl is written all the same, a unit read as a millimetre" : ""}.`, "");
        printJson = { judged: false };
      }
    }
  }
  if (evaluation.objects.length > 1 || joints.length > 0 || evaluation.poses.length > 0) {
    lines.push("## Assembly", "");
    if (evaluation.objects.length > 1) lines.push(`Objects: ${evaluation.objects.map((o) => `${o.name}${o.shape.instanced ? ` (${o.shape.instanced.placements.length} copies)` : ""}`).join(", ")}`, "");
    // A print-ready set is judged one object at a time: the scene's rows above are for the fused union, in which
    // thirty-two chess pieces resting on their board count as one piece (measured). Each object is meshed on its
    // own at the scene's cell (a placed set once, its base) and gets the same rows; a quick pass skips this. Where an
    // object's own mesh has open edges, they are placed and named under the table as the Watertight row's are, since
    // its own mesh is what the GLB carries, its joints' parts aside (round 11: "bowl | no: 17 edges" with no place
    // cost a render on a guess).
    if (objectRows) {
      lines.push("Each object on its own, at the scene's cell:", "", "| Object | Watertight | Pieces | Stands | Overhangs |", "| --- | --- | --- | --- | --- |");
      for (const r of objectRows) lines.push(r.row);
      lines.push("");
      for (const r of objectRows) if (r.edges) lines.push(`- ${r.name}'s own mesh: ${r.edges}`);
      if (objectRows.some((r) => r.edges)) lines.push("");
    }
    if (joints.length && output) lines.push("Joints, each under the joint it turns with:", "", "```", ...jointTreeLines(output, fmt), "```", "");
    if (evaluation.poses.length) lines.push(`Poses: ${evaluation.poses.map((p) => p.name).join(", ")}${shownPose ? ` (sheet shows "${shownPose}")` : ""}`, "");
    if (evaluation.animations.length) lines.push(`Animations: ${evaluation.animations.map((a) => `${a.name} (${a.poses.map((pn, i) => (a.times ? `${pn} ${fmt(a.times[i])}s` : pn)).join(" → ")}, ${fmt(a.seconds)}s, ${a.loop ? "loop" : "once"}${a.ease ? `, ease ${fmt(a.ease)}` : ""}${a.easeEnds !== a.ease ? `, ends ${fmt(a.easeEnds)}` : ""})`).join("; ")}`, "");
  }
  if (calloutNote) lines.push(`Callouts (callouts.png, the largest visible steps named): ${calloutNote}`, "");
  if (evaluation.images.length) lines.push(`Images: ${evaluation.images.map((i) => `${i.name} ${i.width} × ${i.height} (${i.projection === "box" ? i.size : `${i.projection}, ${i.size}`}; line ${i.line})`).join("; ")}`, "");
  for (const l of presentationLines(evaluation, shot?.name, environment, opts.azimuth !== undefined || opts.elevation !== undefined || opts.zoom !== undefined, shotFiles)) lines.push(l, "");
  lines.push("## Steps", "", "Sizes and spans are bounding boxes: exact for primitives and unions, loose after a cut (`a - b` keeps a's box), a rotation or a twist; `a & b` tightens to the overlap. In output: yes for a part, cut for a shape subtracted from one, region for a shape only an assert, a decal or a camera reads.", "", "| # | Name | Line | Size | x | y | z | In output |", "| --- | --- | --- | --- | --- | --- | --- | --- |");
  shapeSteps.forEach((st, i) => {
    const sh = st.value as Shape3;
    const b = sh.bounds;
    const span = (k: number) => (isEmpty(b) ? "" : `${fmt(b.min[k])}..${fmt(b.max[k])}`);
    lines.push(`| ${i + 1} | ${st.name} | ${st.line} | ${isEmpty(b) ? "empty" : dimsLabel(b)} | ${span(0)} | ${span(1)} | ${span(2)} | ${roleLabel(evaluation.roles.get(st.name))} |`);
  });
  lines.push("");
  if (warnings.length) {
    lines.push("## Warnings", "");
    for (const w of warnings) lines.push(`- ${w}`);
    lines.push("");
  }
  lines.push("## Files", "");
  const focusNote = ghosted ? `, a close-up on ${ghosted}: the rest of the model in the frame is drawn faint` : "";
  const cameraFiles: Record<string, string> = {};
  for (const c of evaluation.cameras) cameraFiles[`beauty_${c.name}.png`] = `the beauty render from camera ${c.name}${c.focus ? `, framed on ${c.focus}` : ""}`;
  const descriptions: Record<string, string> = {
    "sheet.png": `perspective, front, right and top views with grids${focusNote}`,
    "persp.png": "perspective view", "front.png": "front view (from +z)", "right.png": "right view (from +x)", "top.png": "top view (from +y)",
    "back.png": "back view", "left.png": "left view", "bottom.png": "bottom view",
    "slices.png": sliceNote ? `cross-sections through ${sliceNote}` : "cross-sections through the centre on each axis",
    "steps.png": "one thumbnail per named shape, in program order; red frames are not in the output",
    "callouts.png": "the perspective view with the largest visible steps named, a leader line from each label to its part",
    "turntable.png": "eight views around the model",
    "turntable.apng": "the model turning, an animated PNG of 24 frames (a browser plays it)",
    "model.obj": "Wavefront mesh (with model.mtl and UVs)", "model.stl": "binary STL for a slicer, the model as shown, in millimetres with z up",
    "model.3mf": "3MF for a slicer: the model in the program's unit with z up, a colour per triangle from the materials", "model.mtl": "materials for the OBJ, mapped to model.png", "model.glb": `binary glTF with the texture atlas embedded${evaluation.lights.length ? ", and the program's lights as KHR_lights_punctual lights on nodes of their own" : ""}`,
    "model.png": "the texture atlas: the materials baked per chart",
    "model_normal.png": "the GLB's tangent-space normal map on the atlas's UVs: the field's detail finer than the mesh and the bumps (lavender is flat)",
    "model_mr.png": "the GLB's metallic-roughness map on the atlas's UVs (green roughness, blue metalness), where wear or rust varies them",
    "model_emissive.png": "the GLB's emissive map on the atlas's UVs, where a glowing material's colour varies",
    "model.roblox.glb": "the GLB for Roblox Studio's 3D Importer: a Handle node facing -Z with _Att attachment nodes from the anchors",
    "model.geo.json": "Minecraft Bedrock geometry: the model voxelised and merged into cuboids, a bone per object and per joint",
    "model.geo.png": "the Bedrock geometry's texture: one window per cube face, painted with the materials",
    "model.animation.json": "the animations as Bedrock keyframes on the joint bones",
    "poses.png": `every pose, rest first${focusNote}`,
    "viewer.html": `orbit the GLB in a browser (self-contained; loads three.js from a CDN), under its own studio or the program's scene (the GLB's lights, the ${environment ?? "studio"} sky and ambient${evaluation.cameras.length ? ", the cameras as viewpoints" : ""}), opening in the ${evaluation.lights.length || evaluation.settings.environment !== undefined ? "scene" : "studio"}`,
    "beauty.png": `the field ray-marched with soft shadows and ambient occlusion${shot ? `, from ${shotLabel}${opts.camera ? " (--camera)" : " (set camera)"}` : ""}`,
    "lights.png": "the beauty render under each declared light alone, then all of them; under each, what that light adds on its own, brightened, and the picture under no light at all",
    "environments.png": `the beauty render under ${skyArg === "all" ? "each sky, from --environment all" : `${skies?.join(", ")}, from --environment ${skyArg}`}`,
    ...cameraFiles,
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
        exports: exportsNote ? { triangles: exportsNote.triangles, before: exportsNote.before, cap: exportsNote.cap, deviation: exportsNote.deviation, fullDeviation: exportsNote.fullDeviation, where: exportsNote.where, meshes: exportsNote.meshes, flat: exportsNote.flat, seams: exportsNote.seams } : undefined,
        cellSize,
        grid,
        materials: mesh?.materials.map((m) => m.name) ?? [],
        objects: evaluation.objects.map((o, i) => ({ name: o.name, copies: o.shape.instanced?.placements.length ?? 1, ...(objectRows?.[i]?.json ?? {}) })),
        physics: physics ? { volume: Math.abs(physics.volume), centre: physics.centre, stable: physics.stable, stabilityMargin: physics.stabilityMargin, pieces: physics.pieces.length, overhang: physics.overhang } : undefined,
        print: printJson,
        watertight: edgeList.length ? { clusters: edgeList } : undefined,
        asserts: asserts.length ? asserts : undefined,
        joints: joints.map((j) => ({ name: j.joint!.name, pivot: j.joint!.pivot })),
        poses: evaluation.poses.map((p) => p.name),
        animations: evaluation.animations.map((a) => a.name),
        steps: shapeSteps.map((st) => ({
          name: st.name,
          line: st.line,
          bounds: isEmpty((st.value as Shape3).bounds) ? null : (st.value as Shape3).bounds,
          used: evaluation.used.has(st.name),
          role: evaluation.roles.get(st.name) ?? "unused",
        })),
        callouts: calloutData,
        warnings,
        files,
        timings,
      },
      null,
      2,
    ),
  );
  const removed: string[] = [];
  for (const f of earlier) {
    if (files.includes(f) || f === "report.json") continue;
    const path = join(outDir, f);
    try {
      if (!statSync(path).isFile()) continue;
      unlinkSync(path);
      removed.push(f);
    } catch {
      // Already gone, or not ours to remove.
    }
  }
  if (removed.length) log(`removed ${removed.length} file${removed.length === 1 ? "" : "s"} an earlier run wrote here and this one did not: ${removed.join(", ")}`);
  // A quick pass is the placing loop; when the promises took most of it, say so and how to leave them out (round 11:
  // a mixer's quick pass took 20 s, 18 of them one wall(), with no word that the asserts were the cost).
  const elapsed = performance.now() - runStart;
  if (opts.quick && assertClock.total > 1500 && assertClock.total > elapsed / 2)
    log(`note: the asserts took ${seconds(assertClock.total)} of this ${seconds(elapsed)} quick pass (${assertClock.slowest(2).join("; ")}); --no-asserts while placing parts, and check judges them`);
  return { name, outDir, evaluation, mesh, bounds, files, warnings, report, timings, physics, removed };
}

/**
 * Two programs side by side: each rendered quickly, their perspective and
 * front views paired, with the size of each in its own bar. For comparing
 * a change against the version before it.
 */
export function diff(a: { source: string; name: string }, b: { source: string; name: string }, outFile: string, opts: { size?: number; grid?: number; importCache?: ImportCache } = {}): { warnings: string[] } {
  const size = opts.size ?? 320;
  const warnings: string[] = [];
  const side = (prog: { source: string; name: string }) => {
    const ev = check(prog.source, prog.name, undefined, undefined, undefined, false, opts.importCache);
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

/** The report's In output column for a step's role. */
export function roleLabel(role: StepRole | undefined): string {
  return role === "part" ? "yes" : role === "cut" ? "cut" : role === "mask" ? "mask" : role === "region" ? "region" : "no";
}

/**
 * What each camera with a focus sees of it, for `check`: the share of the focus hidden behind the rest of the model
 * from the camera's angle, by rays through the field from the focus's own surface (meshed alone, coarsely, rather
 * than the whole model at the program's grid), and when that is over 15%, the least of seven other
 * azimuths 45 degrees apart, with the render's warning when another azimuth would show much more, as the render
 * gives it after a beauty run (round 11: aiming one camera into a bowl cost two beauty runs of minutes each).
 */
export function cameraSight(evaluation: Evaluation, cellSize: number): { lines: string[]; warnings: string[] } {
  const lines: string[] = [], warnings: string[] = [];
  const output = evaluation.output;
  if (!output || isEmpty(output.bounds) || !(cellSize > 0)) return { lines, warnings };
  const shot = typeof evaluation.settings.camera === "string" ? evaluation.cameras.find((c) => c.name === evaluation.settings.camera) : undefined;
  const baseAz = shot?.azimuth ?? (evaluation.settings.azimuth as number | undefined) ?? 35;
  const baseEl = shot?.elevation ?? (evaluation.settings.elevation as number | undefined) ?? 25;
  // The camera framed on the model's box, not its surface's extent, which would cost half a second on a big
  // model: the eye moves a little, and the shares measured on the mixer did not.
  const modelBounds = output.bounds;
  for (const c of evaluation.cameras) {
    if (!c.focus) continue;
    const r = resolveFocusOf(evaluation, output, c.focus);
    if (!r) continue;
    const az = c.azimuth ?? baseAz, el = c.elevation ?? baseEl;
    // The focus's own surface, coarsely: the points whose view of the camera is tested.
    const points = surfaceNets(r.shape, { resolution: 48, bounds: r.frame }).mesh;
    const hidden = hiddenFractionRays(output, modelBounds, points, cellSize, az, el);
    let bestAz = az, best = hidden;
    if (hidden > 0.15) for (let k = 1; k < 8; k++) { const h = hiddenFractionRays(output, modelBounds, points, cellSize, az + k * 45, el, 600); if (h < best) { best = h; bestAz = az + k * 45; } }
    const other = ((bestAz % 360) + 360) % 360;
    lines.push(`  ${c.name}: ${Math.round(hidden * 100)}% of ${c.focus} hidden behind the rest of the model from azimuth ${fmt(az)}, elevation ${fmt(el)}${Math.round(best * 100) < Math.round(hidden * 100) ? `; ${Math.round(best * 100)}% from azimuth ${fmt(other)}` : ""}`);
    if (hidden > 0.15 && best < hidden - 0.2) warnings.push(`camera "${c.name}" (line ${c.line}): ${Math.round(hidden * 100)}% of ${c.focus} is hidden behind the rest of the model from azimuth ${fmt(az)}, elevation ${fmt(el)}; from azimuth ${fmt(other)} it is ${Math.round(best * 100)}%`);
  }
  return { lines, warnings };
}

/**
 * The Lights, Cameras and Environment lines of the report, printed by `check` too. The shot beauty.png shows is
 * written once, as beauty.png, unless the command line's angles made beauty.png another picture; `written`, from a
 * render, is the file each camera's shot went to, and a camera missing from it was not rendered (--camera or
 * --beauty-only render one shot).
 */
export function presentationLines(evaluation: Evaluation, shotName: string | undefined, environment: string | undefined, overridden = false, written?: Map<string, string>): string[] {
  const lines: string[] = [];
  if (evaluation.lights.length) lines.push(`Lights: ${evaluation.lights.map((l) => `${l.name} (${l.position ? `at (${l.position.map(fmt).join(", ")}), range ${l.range !== undefined ? fmt(l.range) : "half the model's longest side"}` : `azimuth ${fmt(l.azimuth)}, elevation ${fmt(l.elevation)}`}, size ${fmt(l.size)}, ${l.colorName}${l.power !== 1 ? `, power ${fmt(l.power)}` : ""})`).join("; ")}${evaluation.lights.length >= 2 ? " (lights.png shows each alone, and what each adds)" : ""}`);
  if (evaluation.cameras.length) lines.push(`Cameras: ${evaluation.cameras.map((c) => `${c.name} (${[c.azimuth !== undefined ? `azimuth ${fmt(c.azimuth)}` : "", c.elevation !== undefined ? `elevation ${fmt(c.elevation)}` : "", c.zoom !== undefined ? `zoom ${fmt(c.zoom)}` : "", c.focus ? `on ${c.focus}` : "", c.dof !== undefined ? `dof ${fmt(c.dof)}` : ""].filter(Boolean).join(", ") || "the render's view"}) → ${written ? written.get(c.name) ?? "not rendered (one shot)" : c.name === shotName && !overridden ? "beauty.png" : `beauty_${c.name}.png`}`).join("; ")}${shotName ? ` (the sheet and beauty.png use "${shotName}"${overridden ? ", its angles overridden from the command line" : ""})` : ""}`);
  if (environment) lines.push(`Environment: ${environment}`);
  return lines;
}
