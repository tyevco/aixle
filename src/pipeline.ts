/**
 * From a source file to a folder of things to look at. `run()` is the whole
 * pipeline: parse, evaluate, extract the surface, render the sheets, write
 * the exports and the report. The CLI is a thin wrapper over it, and so is
 * the examples generator.
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";
import { toGlb } from "./export/glb.js";
import { toObj } from "./export/obj.js";
import { viewerHtml } from "./export/viewer.js";
import { bakeAtlas } from "./export/atlas.js";
import { renderBeauty } from "./render/beauty.js";
import { evaluate, type Evaluation } from "./lang/interpreter.js";
import { parse } from "./lang/parser.js";
import { isShape3 } from "./lang/values.js";
import { isWatertight, meshVolume, triangleCount, vertexCount, type Mesh } from "./mesh/mesh.js";
import { surfaceNets } from "./mesh/surfaceNets.js";
import { meshSteps, renderSheet, renderSlices, renderSteps, renderTurntable, renderView, dimsLabel, type StepView, type ViewName } from "./render/views.js";
import { boundsSize, isEmpty, type Bounds, type Shape3 } from "./sdf/types.js";

export interface RunOptions {
  /** Cells along the longest side of the model. Default 128. */
  grid?: number;
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
  /** Called with progress lines. */
  log?: (line: string) => void;
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
}

const fmt = (v: number): string => (Number.isInteger(v) ? String(v) : v.toFixed(3).replace(/0+$/, "").replace(/\.$/, ""));

/** Parse and evaluate only: what `aixle check` does. */
export function check(source: string): Evaluation {
  return evaluate(parse(source));
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

  const evaluation = time("evaluate", () => check(source));
  const warnings = [...evaluation.warnings];
  const grid = Math.max(8, Math.round(opts.grid ?? (evaluation.settings.grid as number | undefined) ?? 128));
  const size = Math.max(64, Math.round(opts.size ?? (evaluation.settings.size as number | undefined) ?? 512));
  const output = evaluation.output;

  let mesh: Mesh | undefined;
  let bounds: Bounds | undefined;
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
    if (Math.abs(bounds.min[1]) > cellSize && bounds.min[1] < 0)
      lines.push(`Note: the lowest point is at y = ${fmt(bounds.min[1])}; pipe the model through ground() to rest it on y = 0.`, "");
  }

  if (mesh && bounds && output) {
    const views = opts.views ?? ["persp", "front", "right", "top"];
    const info = { name: evaluation.outputName, bounds, triangles: triangleCount(mesh), cellSize, warnings: warnings.length };
    time("sheet", () => write("sheet.png", renderSheet(mesh!, info, size).toPng()));
    for (const v of views) time(`view:${v}`, () => write(`${v}.png`, renderView(mesh!, info, v, size).toPng()));
    if (opts.slices !== false) {
      const at: Partial<Record<"x" | "y" | "z", number>> = {};
      for (const axis of ["x", "y", "z"] as const) {
        const v = evaluation.settings[`slice_${axis}`];
        if (typeof v === "number") at[axis] = v;
      }
      time("slices", () => write("slices.png", renderSlices(output, info, Math.round(size * 0.75), at).toPng()));
    }
    if (opts.turntable !== false) time("turntable", () => write("turntable.png", renderTurntable(mesh!, info, Math.round(size / 2)).toPng()));
    const textureSize = Math.round(opts.texture ?? (evaluation.settings.texture as number | undefined) ?? 1024);
    let exportMesh = mesh;
    let atlas: ReturnType<typeof bakeAtlas> | undefined;
    if (textureSize > 0 && (opts.obj !== false || opts.glb !== false)) {
      atlas = time("atlas", () => bakeAtlas(mesh!, { size: Math.max(64, textureSize) }));
      exportMesh = atlas.mesh;
      write("model.png", atlas.image.toPng());
      log(`atlas: ${atlas.charts} charts at ${fmt(atlas.texelsPerUnit)} texels per unit, ${textureSize}px, in ${timings.atlas} ms`);
    }
    if (opts.obj !== false) {
      const { obj, mtl } = toObj(exportMesh, name, "model.mtl", atlas?.uv, atlas ? "model.png" : undefined);
      write("model.obj", obj);
      write("model.mtl", mtl);
    }
    if (opts.glb !== false) {
      const glb = toGlb(exportMesh, name, atlas ? { uv: atlas.uv, png: atlas.image.toPng() } : undefined);
      write("model.glb", glb);
      if (opts.viewer !== false) write("viewer.html", viewerHtml(glb, evaluation.outputName, bounds, triangleCount(mesh)));
    }
    if (opts.beauty || evaluation.settings.beauty === 1) {
      const bsize = Math.max(64, Math.round(opts.beautySize ?? size));
      time("beauty", () => write("beauty.png", renderBeauty(output, mesh!, bounds!, { size: bsize, cellSize, label: `${evaluation.outputName}  ${dimsLabel(bounds!)}` }).toPng()));
      log(`beauty render ${bsize}px in ${timings.beauty} ms`);
    }
  }

  const shapeSteps = evaluation.steps.filter((s) => isShape3(s.value));
  if (opts.steps !== false && shapeSteps.length > 0) {
    const views: StepView[] = time("steps:mesh", () =>
      meshSteps(
        shapeSteps.map((s) => ({ name: s.name, shape: s.value as Shape3, used: evaluation.used.has(s.name), line: s.line })),
        cellSize,
        64,
        output && mesh ? { shape: output, mesh } : undefined,
      ),
    );
    for (const st of views)
      if (st.used && st.mesh && !st.coarse && triangleCount(st.mesh) === 0)
        warnings.push(`'${st.name}' (line ${st.line}) has bounds ${dimsLabel(st.shape.bounds)} but no surface: it is missing from the model. A zero blend radius or scale, or a part thinner than a cell?`);
    time("steps", () => write("steps.png", renderSteps(views, Math.round(size * 0.35)).toPng()));
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
      `| Bounds | x ${fmt(bounds.min[0])}..${fmt(bounds.max[0])}, y ${fmt(bounds.min[1])}..${fmt(bounds.max[1])}, z ${fmt(bounds.min[2])}..${fmt(bounds.max[2])} |`,
      `| Triangles | ${triangleCount(mesh)} (${vertexCount(mesh)} vertices) |`,
      `| Volume | ${fmt(Math.abs(meshVolume(mesh)))} cubic units |`,
      `| Grid | ${grid} cells on the longest side, cell ${fmt(cellSize)} units |`,
      `| Watertight | ${isWatertight(mesh) ? "yes" : "no"} |`,
      `| Materials | ${mesh.materials.map((m) => m.name).join(", ") || "none"} |`,
      "",
    );
  }
  lines.push("## Steps", "", "| # | Name | Line | Size | In output |", "| --- | --- | --- | --- | --- |");
  shapeSteps.forEach((st, i) => {
    const sh = st.value as Shape3;
    lines.push(`| ${i + 1} | ${st.name} | ${st.line} | ${isEmpty(sh.bounds) ? "empty" : dimsLabel(sh.bounds)} | ${evaluation.used.has(st.name) ? "yes" : "no"} |`);
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
    "viewer.html": "orbit the GLB in a browser (self-contained; loads three.js from a CDN)",
    "beauty.png": "the field ray-marched with soft shadows and ambient occlusion",
  };
  for (const f of files) lines.push(`- \`${f}\`: ${descriptions[f] ?? ""}`);
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
  return { name, outDir, evaluation, mesh, bounds, files, warnings, report, timings };
}
