#!/usr/bin/env node
/**
 *   aixle render <file.aix> [--out DIR] [--grid N] [--size N] [--no-steps] [--no-slices] [--no-turntable] [--no-export]
 *   aixle check  <file.aix>
 *   aixle doc    [--write FILE]
 */
import { surfaceBottom } from "./sdf/ops.js";
import { readFileSync, writeFileSync } from "node:fs";
import { basename, resolve } from "node:path";
import { referenceMarkdown } from "./doc.js";
import { cellFor, check, diff, foldThinWarnings, paintWarnings, QUICK, run, thinWarnings } from "./pipeline.js";
import { watch } from "node:fs";
import { isEmpty } from "./sdf/types.js";
import { dimsLabel } from "./render/views.js";
import { isShape3 } from "./lang/values.js";

// Trailing zeros come off only after a decimal point: -100 once printed as -1 (measured).
const short = (v: number): string => { const t = (Math.abs(v) >= 100 ? v.toFixed(0) : Math.abs(v) >= 10 ? v.toFixed(1) : v.toFixed(2)).replace(/(\.\d*?)0+$/, "$1").replace(/\.$/, "") || "0"; return t === "-0" ? "0" : t; };

function usage(): never {
  console.error(
    [
      "usage:",
      "  aixle render <file.aix> [--out DIR] [--quick] [--watch] [--grid N] [--size N] [--views persp,front,right,top]",
      "                          [--no-steps] [--no-slices] [--no-turntable] [--no-poses] [--no-export] [--no-viewer]",
      "                          [--beauty [--beauty-size N]] [--soft] [--texture N | --no-texture]",
      "                          [--azimuth DEG] [--elevation DEG] [--zoom N] [--focus NAME] [--pose NAME]",
      "                          [--no-steps] [--no-slices] [--no-turntable] [--no-export] [--no-viewer]",
      "  aixle check  <file.aix> [--pose NAME]   parse and evaluate; print sizes and warnings, render nothing",
      "  aixle diff   <a.aix> <b.aix> [--out FILE.png]   the two side by side, quickly",
      "  aixle doc    [--write FILE]    the language reference, generated from the builtins",
    ].join("\n"),
  );
  process.exit(2);
}

function flags(argv: string[]): { positional: string[]; opts: Record<string, string | boolean> } {
  const positional: string[] = [];
  const opts: Record<string, string | boolean> = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith("--")) {
      const key = a.slice(2);
      const next = argv[i + 1];
      if (key.startsWith("no-")) opts[key] = true;
      else if (next !== undefined && !next.startsWith("--")) { opts[key] = next; i++; }
      else opts[key] = true;
    } else positional.push(a);
  }
  return { positional, opts };
}

function main(argv: string[]): number {
  const [cmd, ...rest] = argv;
  if (!cmd || cmd === "help" || cmd === "--help" || cmd === "-h") usage();
  const { positional, opts } = flags(rest);
  if (cmd === "doc") {
    const md = referenceMarkdown();
    if (typeof opts.write === "string") {
      writeFileSync(opts.write, md);
      console.log(`wrote ${opts.write}`);
    } else process.stdout.write(md);
    return 0;
  }
  const file = positional[0];
  if (!file) usage();
  let source: string;
  try {
    source = readFileSync(file, "utf8");
  } catch {
    console.error(`cannot read ${file}`);
    return 1;
  }
  if (cmd === "check") {
    try {
      const rest = check(source, file, (l) => console.log(l));
      // Sizes are printed for the pose the sheet would show, so a posed rig's numbers match its pictures.
      const poseName = typeof opts.pose === "string" ? opts.pose : typeof rest.settings.pose === "string" ? rest.settings.pose : undefined;
      const pose = poseName ? rest.poses.find((p) => p.name === poseName) : undefined;
      const ev = pose ? check(source, file, undefined, pose.angles) : rest;
      if (poseName && !pose && poseName !== "rest") console.log(`warning: pose ${poseName}: no such pose (poses: ${rest.poses.map((p) => p.name).join(", ") || "none"}); sizes are at rest`);
      if (pose) console.log(`pose: ${pose.name} (sizes below are in this pose; poses: ${rest.poses.map((p) => p.name).join(", ")})`);
      else if (rest.poses.length) console.log(`poses: ${rest.poses.map((p) => p.name).join(", ")} (sizes below are at rest; --pose NAME for one of them)`);
      const span = (b: { min: number[]; max: number[] }) => ["x", "y", "z"].map((a, k) => `${a} ${short(b.min[k])}..${short(b.max[k])}`).join("  ");
      for (const st of ev.steps) {
        // Numbers too: an agent sizing a member from a computed distance wants to see the distance.
        if (typeof st.value === "number") { console.log(`${st.name.padEnd(18)} = ${short(st.value)}`); continue; }
        if (!isShape3(st.value)) continue;
        const used = ev.used.has(st.name) ? "" : "   (not in output)";
        const b = st.value.bounds;
        console.log(`${st.name.padEnd(18)} ${isEmpty(b) ? "empty" : `${dimsLabel(b).padEnd(20)} ${span(b)}`}${used}`);
      }
      if (ev.output) console.log(`output: ${ev.outputName} ${isEmpty(ev.output.bounds) ? "(empty)" : dimsLabel(ev.output.bounds)}`);
      else console.log("output: none");
      const { grid, cellSize } = cellFor(ev, typeof opts.grid === "string" ? Number(opts.grid) : undefined);
      if (cellSize > 0) console.log(`grid ${grid}: cell ${short(cellSize)} units`);
      if (ev.output && !isEmpty(ev.output.bounds)) {
        // The surface's lowest point, not the bounds': the note a render would make, without the render.
        const bottom = surfaceBottom(ev.output);
        if (bottom < -cellSize) console.log(`note: the lowest point of the surface is at y = ${short(bottom)}; pipe the model through ground() to rest it on y = 0`);
        else if (bottom > cellSize * 2) console.log(`note: the surface floats: its lowest point is at y = ${short(bottom)}; ground() rests it on y = 0`);
      }
      const warnings = [...ev.warnings, ...(cellSize > 0 ? foldThinWarnings(thinWarnings(ev, cellSize, grid)) : []), ...paintWarnings(ev)];
      for (const w of warnings) console.log(`warning: ${w}`);
      if (warnings.length === 0) console.log("no warnings");
      return 0;
    } catch (err) {
      console.error(`${file}: ${(err as Error).message}`);
      return 1;
    }
  }
  if (cmd === "diff") {
    const other = positional[1];
    if (!other) usage();
    let b: string;
    try {
      b = readFileSync(other, "utf8");
    } catch {
      console.error(`cannot read ${other}`);
      return 1;
    }
    const outFile = typeof opts.out === "string" ? resolve(opts.out) : resolve("out", `diff_${basename(file).replace(/\.[^.]+$/, "")}_${basename(other).replace(/\.[^.]+$/, "")}.png`);
    try {
      const r = diff({ source, name: file }, { source: b, name: other }, outFile);
      for (const w of r.warnings) console.log(`warning: ${w}`);
      console.log(`wrote ${outFile}: A on the left, B on the right`);
      return 0;
    } catch (err) {
      console.error(`${(err as Error).message}`);
      return 1;
    }
  }
  if (cmd !== "render") usage();
  const outDir = typeof opts.out === "string" ? resolve(opts.out) : resolve("out", basename(file).replace(/\.[^.]+$/, ""));
  const once = (src: string): number => renderOnce(src, file, outDir, opts);
  if (opts.watch) {
    console.log(`watching ${file}; render on every save, ctrl-c to stop`);
    once(source);
    let timer: NodeJS.Timeout | undefined;
    watch(file, () => {
      clearTimeout(timer);
      timer = setTimeout(() => {
        try {
          const fresh = readFileSync(file, "utf8");
          console.log(`\n${new Date().toLocaleTimeString()} ${file} changed`);
          once(fresh);
        } catch (err) {
          console.error((err as Error).message);
        }
      }, 150);
    });
    return new Promise<number>(() => {}) as unknown as number;
  }
  return once(source);
}

function renderOnce(source: string, file: string, outDir: string, opts: Record<string, string | boolean>): number {
  try {
    const quick = opts.quick ? QUICK : {};
    const given: Record<string, unknown> = {
      grid: typeof opts.grid === "string" ? Number(opts.grid) : undefined,
      size: typeof opts.size === "string" ? Number(opts.size) : undefined,
      views: typeof opts.views === "string" ? opts.views.split(",") : undefined,
      steps: opts["no-steps"] ? false : undefined,
      poses: opts["no-poses"] ? false : undefined,
      slices: opts["no-slices"] ? false : undefined,
      turntable: opts["no-turntable"] ? false : undefined,
      obj: opts["no-export"] ? false : undefined,
      glb: opts["no-export"] ? false : undefined,
      viewer: opts["no-viewer"] ? false : undefined,
      beauty: opts.beauty === true ? true : undefined,
      beautySize: typeof opts["beauty-size"] === "string" ? Number(opts["beauty-size"]) : undefined,
      sharp: opts.soft ? false : undefined,
      texture: opts["no-texture"] ? 0 : typeof opts.texture === "string" ? Number(opts.texture) : undefined,
      azimuth: typeof opts.azimuth === "string" ? Number(opts.azimuth) : undefined,
      zoom: typeof opts.zoom === "string" ? Number(opts.zoom) : undefined,
      elevation: typeof opts.elevation === "string" ? Number(opts.elevation) : undefined,
      focus: typeof opts.focus === "string" ? opts.focus : undefined,
      pose: typeof opts.pose === "string" ? opts.pose : undefined,
    };
    for (const k of Object.keys(given)) if (given[k] === undefined) delete given[k];
    const result = run(source, file, outDir, { ...quick, ...given, log: (l) => console.log(l) });
    console.log(`wrote ${result.files.length} files to ${outDir}`);
    for (const w of result.warnings) console.log(`warning: ${w}`);
    console.log(opts.quick ? `look at ${resolve(outDir, "sheet.png")}` : `look at ${resolve(outDir, "sheet.png")} first, then slices.png and steps.png; details in report.md`);
    return result.mesh ? 0 : 1;
  } catch (err) {
    console.error(`${file}: ${(err as Error).message}`);
    return 1;
  }
}

const code = main(process.argv.slice(2));
if (typeof code === "number") process.exitCode = code;
