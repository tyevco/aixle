#!/usr/bin/env node
/**
 *   aixle render <file.aix> [--out DIR] [--grid N] [--size N] [--no-steps] [--no-slices] [--no-turntable] [--no-export]
 *   aixle check  <file.aix>
 *   aixle doc    [--write FILE]
 */
import { anchorsOf, hasLooseBounds, placedShape, surfaceBottom, surfaceExtent } from "./sdf/ops.js";
import { readFileSync, writeFileSync } from "node:fs";
import { basename, resolve } from "node:path";
import { referenceMarkdown } from "./doc.js";
import { cellFor, check, diff, cutWarnings, foldThinWarnings, paintState, paintWarnings, QUICK, run, thinWarnings, type PaintState } from "./pipeline.js";
import { watch } from "node:fs";
import { isEmpty, isEmpty2, type Bounds, type Shape3 } from "./sdf/types.js";
import { dimsLabel } from "./render/views.js";
import { isShape2, isShape3, typeName } from "./lang/values.js";
import { parse } from "./lang/parser.js";

// Trailing zeros come off only after a decimal point: -100 once printed as -1 (measured).
const short = (v: number): string => { const t = (Math.abs(v) >= 100 ? v.toFixed(0) : Math.abs(v) >= 10 ? v.toFixed(1) : v.toFixed(2)).replace(/(\.\d*?)0+$/, "$1").replace(/\.$/, "") || "0"; return t === "-0" ? "0" : t; };

/** A library's Markdown: its leading comment, then every top-level def with its signature and the comment above it. */
function libraryMarkdown(file: string): string {
  const source = readFileSync(file, "utf8");
  const lines = source.split(/\r?\n/);
  const program = parse(source);
  const out: string[] = [`# ${basename(file, ".aix")}`, ""];
  // The header: comment lines at the top of the file, up to the first blank line.
  const head: string[] = [];
  for (const l of lines) { if (/^\s*#/.test(l)) head.push(l.replace(/^\s*#\s?/, "")); else break; }
  if (head.length) out.push(head.join("\n"), "");
  // The constants a user sees: the top-level values that are not shapes (materials, numbers, lists), by running it.
  const ev = check(source, file);
  const exports = ev.steps.filter((st) => !isShape3(st.value) && !isShape2(st.value)).map((st) => st.name);
  for (const st of program.body) {
    if (st.type !== "def") continue;
    const doc: string[] = [];
    for (let i = st.line - 2; i >= 0 && /^\s*#/.test(lines[i]); i--) doc.unshift(lines[i].replace(/^\s*#\s?/, ""));
    const params = st.params.map((p) => (p.default ? `${p.name}=${lines[st.line - 1].match(new RegExp(`${p.name}\\s*=\\s*([^,)]+)`))?.[1]?.trim() ?? "?"}` : p.name));
    out.push(`## ${st.name}(${params.join(", ")})`, "");
    if (doc.length) out.push(doc.join("\n"), "");
  }
  if (exports.length) out.push(`Constants: ${exports.join(", ")}`, "");
  return out.join("\n");
}

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
      "  aixle explain <file.aix> [--pose NAME]  the program as a tree from the output down: each step's line, size, material and anchors",
      "  aixle diff   <a.aix> <b.aix> [--out FILE.png]   the two side by side, quickly",
      "  aixle doc    [--write FILE]    the language reference, generated from the builtins",
      "  aixle doc    <lib.aix>          a library's defs and their comments, for a program that would use it",
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
    // `aixle doc lib.aix` documents a library the way the reference documents builtins: each def with its
    // parameters and defaults, and the comment lines above it, so a caller places its parts without reading it.
    const lib = positional[0];
    const md = lib && lib.endsWith(".aix") ? libraryMarkdown(lib) : referenceMarkdown();
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
      const spanBox = (b: Bounds) => `${dimsLabel(b).padEnd(20)} ${span(b)}`;
      for (const m of ev.modules) console.log(`use ${m.prefix.padEnd(14)} ${m.path}: ${m.names.join(", ")}`);
      for (const st of ev.steps) {
        // Numbers too: an agent sizing a member from a computed distance wants to see the distance.
        if (typeof st.value === "number") { console.log(`${st.name.padEnd(18)} = ${short(st.value)}`); continue; }
        if (Array.isArray(st.value) && st.value.every((v) => typeof v === "number")) { console.log(`${st.name.padEnd(18)} = [${st.value.map((v) => short(v as number)).join(", ")}]`); continue; }
        // A 2D profile has a box too, and a part built from one is invisible until it is extruded (round 4 asked).
        if (isShape2(st.value)) {
          const b = st.value.bounds;
          console.log(`${st.name.padEnd(18)} ${isEmpty2(b) ? "profile, empty" : `profile ${short(b.max[0] - b.min[0])} × ${short(b.max[1] - b.min[1])}`.padEnd(20) + ` x ${short(b.min[0])}..${short(b.max[0])}  y ${short(b.min[1])}..${short(b.max[1])}`}`);
          continue;
        }
        if (!isShape3(st.value)) continue;
        const used = ev.used.has(st.name) ? "" : "   (not in output)";
        const b = st.value.bounds;
        console.log(`${st.name.padEnd(18)} ${isEmpty(b) ? "empty" : spanBox(b)}${used}`);
        if (isEmpty(b)) continue;
        // A box after a rotation, a warp or a posed joint is the box of a turned box: measure the surface itself
        // and print that when it is tighter (measured: a boom's box read 5.9 tall for a 5.2 surface).
        let own = b;
        if (hasLooseBounds(st.value)) {
          const e = surfaceExtent(st.value, 48);
          const tighter = [0, 1, 2].some((k) => (e.max[k] - e.min[k]) < (b.max[k] - b.min[k]) * 0.95);
          if (!isEmpty(e) && tighter) { own = e; console.log(`${"  surface".padEnd(18)} ${spanBox(e)}`); }
        }
        // Named anchors, where they are in this step's frame.
        const anchors = Object.entries(anchorsOf(st.value));
        if (anchors.length) console.log(`${"  anchors".padEnd(18)} ${anchors.map(([k, p]) => `${k} (${p.map(short).join(", ")})`).join("  ")}`);
        // In a pose, where the step ends up once the joints above it have turned: the surface itself, measured
        // through the joints' inverses, so a turned wheel's posed line says whether it still touches the floor.
        if (pose && ev.output) {
          const placedS = placedShape(ev.output, st.value);
          const placed = placedS ? surfaceExtent(placedS, 48) : undefined;
          if (placed && !isEmpty(placed) && [0, 1, 2].some((k) => Math.abs(placed.min[k] - own.min[k]) > 1e-6 || Math.abs(placed.max[k] - own.max[k]) > 1e-6))
            console.log(`${"  posed".padEnd(18)} ${spanBox(placed)}`);
        }
      }
      if (ev.output) console.log(`output: ${ev.outputName} ${isEmpty(ev.output.bounds) ? "(empty)" : dimsLabel(ev.output.bounds)}`);
      else console.log("output: none");
      const { grid, cellSize } = cellFor(ev, typeof opts.grid === "string" ? Number(opts.grid) : undefined);
      if (cellSize > 0) console.log(`grid ${grid}: cell ${Number(cellSize.toPrecision(3))} units`);
      if (ev.output && !isEmpty(ev.output.bounds)) {
        // The surface's lowest point, not the bounds': the note a render would make, without the render.
        const bottom = surfaceBottom(ev.output);
        if (bottom < -cellSize) console.log(`note: the lowest point of the surface is at y = ${short(bottom)}; pipe the model through ground() to rest it on y = 0`);
        else if (bottom > cellSize * 2) console.log(`note: the surface floats: its lowest point is at y = ${short(bottom)}; ground() rests it on y = 0`);
      }
      const warnings = [...ev.warnings, ...(cellSize > 0 ? foldThinWarnings(thinWarnings(ev, cellSize, grid)) : []), ...paintWarnings(ev), ...cutWarnings(ev, cellSize)];
      for (const w of warnings) console.log(`warning: ${w}`);
      if (warnings.length === 0) console.log("no warnings");
      return 0;
    } catch (err) {
      console.error(`${file}: ${(err as Error).message}`);
      return 1;
    }
  }
  if (cmd === "explain") {
    // An outline for whoever inherits the program: from the output down through the steps each one reads, with the
    // step's own line of source, so the tree says what each part is made of without a reader tracing names by hand
    // (round 4: every agent taking over a program spent its first renders finding out which step fed which).
    try {
      const rest = check(source, file);
      const poseName = typeof opts.pose === "string" ? opts.pose : typeof rest.settings.pose === "string" ? rest.settings.pose : undefined;
      const pose = poseName ? rest.poses.find((p) => p.name === poseName) : undefined;
      const ev = pose ? check(source, file, undefined, pose.angles) : rest;
      const lines = source.split(/\r?\n/);
      const byName = new Map(ev.steps.map((st) => [st.name, st]));
      const memo = new Map<Shape3, PaintState>();
      const printed = new Set<string>();
      const describe = (name: string): string => {
        const st = byName.get(name);
        if (!st) return `${name}: not a step`;
        const v = st.value;
        let what: string;
        if (typeof v === "number") what = `= ${short(v)}`;
        else if (typeof v === "string") what = `= "${v}"`;
        else if (Array.isArray(v)) what = v.every((x) => typeof x === "number") ? `= [${v.map((x) => short(x as number)).join(", ")}]` : `a list of ${v.length}`;
        else if (isShape3(v)) {
          const b = v.bounds;
          const paintNote = paintState(v, memo);
          const anchors = Object.keys(anchorsOf(v));
          what = `${isEmpty(b) ? "empty" : dimsLabel(b)}${v.joint ? `  joint "${v.joint.name}" at (${v.joint.pivot.map(short).join(", ")})` : ""}${v.instanced ? `  ${v.instanced.placements.length} copies` : ""}  ${paintNote === "all" ? "painted" : paintNote === "mixed" ? "partly painted" : "unpainted"}${anchors.length ? `  anchors: ${anchors.join(", ")}` : ""}`;
        } else if (isShape2(v)) what = "a profile";
        else what = typeName(v);
        const src = (lines[st.line - 1] ?? "").replace(/^\s*[A-Za-z_][A-Za-z0-9_]*\s*=\s*/, "").replace(/\s+#.*$/, "").trim();
        return `${name} (line ${st.line})  ${what}\n    = ${src.length > 110 ? src.slice(0, 107) + "..." : src}`;
      };
      const walk = (name: string, depth: number) => {
        const st = byName.get(name);
        if (!st) return;
        const pad = "  ".repeat(depth);
        if (printed.has(name)) { console.log(`${pad}${name} (see above)`); return; }
        printed.add(name);
        for (const l of describe(name).split("\n")) console.log(pad + l);
        // Children in the order the line reads them; numbers last, since the shapes are the structure.
        const deps = [...st.deps].filter((d) => byName.has(d));
        const shapes = deps.filter((d) => isShape3(byName.get(d)!.value) || isShape2(byName.get(d)!.value));
        const rest = deps.filter((d) => !shapes.includes(d));
        for (const d of [...shapes, ...rest]) walk(d, depth + 1);
      };
      const roots = ev.objects.length > 1 ? ev.objects.map((o) => o.name) : ev.outputName ? [ev.outputName] : [];
      if (!roots.length) { console.log("no output: nothing to explain"); return 0; }
      if (pose) console.log(`pose: ${pose.name} (sizes in this pose)`);
      for (const r of roots) walk(r, 0);
      const unused = ev.steps.filter((st) => !printed.has(st.name) && (isShape3(st.value) || isShape2(st.value))).map((st) => st.name);
      if (unused.length) console.log(`\nnot in the output: ${unused.join(", ")}`);
      if (ev.poses.length) console.log(`\nposes: ${ev.poses.map((p) => p.name).join(", ")}`);
      for (const m of ev.modules) console.log(`\nuse ${m.prefix} (${m.path}): ${m.names.join(", ")}`);
      return 0;
    } catch (e) {
      console.error(e instanceof Error ? e.message : String(e));
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
