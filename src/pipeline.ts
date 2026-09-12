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
import { primitive } from "./sdf/primitives.js";
import { eulerToQuat, toGlbScene, type GlbAnimation } from "./export/glb.js";
import { toObjScene } from "./export/obj.js";
import { buildHierarchy, flatten } from "./export/hierarchy.js";
import { allJoints } from "./sdf/ops.js";
import { INK, renderAnimation, renderPoses, type PoseView, type ShapeAt } from "./render/views.js";
import { Canvas } from "./render/canvas.js";
import { drawText } from "./render/font.js";
import { viewerHtml } from "./export/viewer.js";
import { renderBeauty } from "./render/beauty.js";
import { evaluate, type Evaluation } from "./lang/interpreter.js";
import { parse } from "./lang/parser.js";
import { isShape3 } from "./lang/values.js";
import { meshBounds, meshVolume, triangleCount, vertexCount, watertightReport, type Mesh } from "./mesh/mesh.js";
import { analyse, type Physics } from "./mesh/physics.js";
import { surfaceNets } from "./mesh/surfaceNets.js";
import { meshSteps, renderSheet, renderSlices, renderSteps, renderTurntable, renderView, dimsLabel, type StepView, type ViewName } from "./render/views.js";
import { boundsSize, isEmpty, type Bounds, type Shape3 } from "./sdf/types.js";

/** The inner-loop preset: a small grid, the sheet only, no exports. A render in a second or two. */
export const QUICK: RunOptions = { grid: 64, size: 320, views: [], steps: false, slices: false, turntable: false, obj: false, glb: false, viewer: false, beauty: false };

export interface RunOptions {
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

const fmt = (v: number): string => (Number.isInteger(v) ? String(v) : v.toFixed(3).replace(/0+$/, "").replace(/\.$/, ""));

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
  for (const st of evaluation.steps) {
    if (!isShape3(st.value) || !evaluation.used.has(st.name) || isEmpty(st.value.bounds)) continue;
    const ss = boundsSize(st.value.bounds);
    const t = Math.min(ss[0], ss[1], ss[2]);
    if (t > 0 && t < cellSize * 1.2) {
      out.push(`'${st.name}' (line ${st.line}) is only ${fmt(t)} units thin, ${fmt(t / cellSize)} of the ${fmt(cellSize)} cell: it may be missing or broken in the mesh. Thicken it or raise the grid (set grid ${gridFor(t)}).`);
      continue;
    }
    // A wall, tube or stroke inside a thick step: bounds cannot see it, so the shape carries the size itself.
    // Reported once per size, at the step that introduced it, not again at every step built on top.
    const f = st.value.feature;
    if (f === undefined || !(f > 0) || f >= cellSize * 1.2) continue;
    const key = Math.round(f * 1e6);
    if (reportedFeatures.has(key)) continue;
    reportedFeatures.add(key);
    out.push(`'${st.name}' (line ${st.line}) has a wall, tube or stroke only ${fmt(f)} thick, ${fmt(f / cellSize)} of the ${fmt(cellSize)} cell: it may be missing or broken in the mesh. Thicken it or raise the grid (set grid ${gridFor(f)}).`);
  }
  return out;
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
  if (shownPose && !shownAngles && shownPose !== "rest") warnings.push(`pose ${shownPose}: no such pose (poses: ${rest.poses.map((p) => p.name).join(", ") || "none"}); showing rest`);
  const shapeAt: ShapeAt = (angles) => evaluate(program, { resolveImport: resolver, jointAngles: angles }).output;
  const grid = Math.max(8, Math.round(opts.grid ?? (evaluation.settings.grid as number | undefined) ?? opts.defaultGrid ?? 128));
  const size = Math.max(64, Math.round(opts.size ?? (evaluation.settings.size as number | undefined) ?? 512));
  const output = evaluation.output;
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
    const nets = time("mesh", () => surfaceNets(output, { resolution: grid, sharp: opts.sharp ?? evaluation.settings.sharp !== 0 }));
    mesh = nets.mesh;
    cellSize = nets.cellSize;
    log(`mesh: ${triangleCount(mesh)} triangles, cell ${fmt(cellSize)} (${nets.dims.join("×")} cells, ${nets.samples} samples) in ${timings.mesh} ms`);
    if (nets.nanSamples > 0)
      warnings.push(`The distance field is NaN at ${nets.nanSamples} of ${nets.samples} samples, so parts of the model are missing: look for a scale of 0, a zero-size primitive, or a blend radius that is not a number.`);
    if (triangleCount(mesh) === 0)
      warnings.push(`'${evaluation.outputName}' has bounds ${dimsLabel(output.bounds)} but no surface was found inside them at grid ${grid}: it may be thinner than a cell (${fmt(cellSize)}), or empty.`);
    const s = boundsSize(bounds);
    const thin = Math.min(s[0], s[1], s[2]);
    if (thin > 0 && thin < cellSize * 3)
      warnings.push(`The model is only ${fmt(thin)} units thin on one axis, about ${fmt(thin / cellSize)} cells; raise the grid (set grid 256) if it looks broken.`);
    warnings.push(...thinWarnings(evaluation, cellSize, grid));
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
      const fb = st ? (st.value as Shape3).bounds : obj?.shape.bounds;
      if (fb && !isEmpty(fb)) {
        const grow = Math.max(...boundsSize(fb)) * 0.08;
        frame = { min: [fb.min[0] - grow, fb.min[1] - grow, fb.min[2] - grow], max: [fb.max[0] + grow, fb.max[1] + grow, fb.max[2] + grow] };
        shownName = `${evaluation.outputName} → ${focusName}`;
      } else warnings.push(`focus ${focusName}: no such step or object; framing the whole model`);
    }
    const info = { name: shownName, bounds: frame, triangles: triangleCount(mesh), cellSize, warnings: warnings.length, azimuth, elevation };
    time("sheet", () => write("sheet.png", renderSheet(mesh!, info, size).toPng()));
    for (const v of views) time(`view:${v}`, () => write(`${v}.png`, renderView(mesh!, info, v, size, { azimuth, elevation }).toPng()));
    if (opts.slices !== false) {
      const at: Partial<Record<"x" | "y" | "z", number>> = {};
      for (const axis of ["x", "y", "z"] as const) {
        const v = evaluation.settings[`slice_${axis}`];
        if (typeof v === "number") at[axis] = v;
      }
      // A scene's default cut goes through its first object, which is the one to list first.
      const first = evaluation.objects.length > 1 ? evaluation.objects[0].shape.bounds : undefined;
      const sliceInfo = first && !isEmpty(first) ? { ...info, bounds: first } : info;
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
      }
      if (opts.glb !== false) {
        const glb = toGlbScene(hierarchy, name, glbAnimations);
        write("model.glb", glb);
        if (opts.viewer !== false) write("viewer.html", viewerHtml(glb, evaluation.outputName, bounds, hierarchy.triangles, glbAnimations.map((a) => a.name)));
      }
    }
    if (joints.length > 0) {
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
      time("beauty", () => write("beauty.png", renderBeauty(output, mesh!, bounds!, { size: bsize, cellSize, azimuth, elevation, lightSize, dof, label: `${evaluation.outputName}  ${dimsLabel(bounds!)}` }).toPng()));
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
    const specks = physics.pieces.filter((pc) => Math.abs(pc.volume) < Math.abs(main.volume) * 0.001);
    const parts = physics.pieces.length - specks.length;
    if (parts > 1 && !evaluation.objects.some((o) => o.shape.instanced) && evaluation.objects.length === 1)
      warnings.push(`The model is ${parts} separate pieces (by volume: ${physics.pieces.filter((pc) => !specks.includes(pc)).map((pc) => fmt(Math.abs(pc.volume))).join(", ")}); a piece not touching the rest floats free. Overlap parts slightly, or use scene for separate objects.`);
    if (specks.length) warnings.push(`${specks.length} tiny speck${specks.length === 1 ? "" : "s"} of mesh (under 0.1% of the volume): a sliver left by a cut or a part thinner than a cell.`);
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
      `| Watertight | ${watertightReport(mesh).note} |`,
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
        `| Overhangs | ${physics.overhang > 0.005 ? `${(physics.overhang * 100).toFixed(0)}% of the surface faces down more than 45° above the floor (a printer would need support there)` : "none steeper than 45°"} |`,
        `| Pieces | ${physics.pieces.length}${physics.pieces.length > 1 ? ` (volumes ${physics.pieces.slice(0, 6).map((pc) => fmt(Math.abs(pc.volume))).join(", ")}${physics.pieces.length > 6 ? ", ..." : ""})` : ""} |`,
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
    "model.obj": "Wavefront mesh (with model.mtl and UVs)", "model.mtl": "materials for the OBJ, mapped to model.png", "model.glb": "binary glTF with the texture atlas embedded",
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
