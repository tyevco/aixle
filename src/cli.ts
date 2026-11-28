#!/usr/bin/env node
/**
 *   aixle render <file.aix> [--out DIR] [--grid N] [--size N] [--no-steps] [--no-slices] [--no-turntable] [--no-export]
 *   aixle check  <file.aix>
 *   aixle fmt    <file.aix>... [--write | --check]
 *   aixle doc    [NAME... | lib.aix] [--write FILE]
 */
import { anchorsOf, hasLooseBounds, jointTreeLines, placedPoint, placedShape, surfaceBottom, surfaceExtent, surfaceExtentDeep } from "./sdf/ops.js";
import { readFileSync, writeFileSync } from "node:fs";
import { basename, resolve } from "node:path";
import { defaultThreads } from "./render/beauty-pool.js";
import { nearestNames, referenceEntry, referenceMarkdown } from "./doc.js";
import { AssertClock, assertLabel, assertsRow, BEAUTY_ONLY, QUALITIES, restAssertWarningsFor, cameraSight, cellFor, check, collectAsserts, contactLines, diff, cutWarnings, fitText, fmtMm, foldThinWarnings, glassWarnings, minecraftThinWarnings, nearlyThin, paintState, paintWarnings, presentationLines, printBed, printUnits, QUICK, run, thinWarnings, tightBounds, unitsText, type PaintState } from "./pipeline.js";
import { bedFit, boxCorners } from "./mesh/print.js";
import { surfaceNets } from "./mesh/surfaceNets.js";
import { ENVIRONMENTS } from "./render/beauty.js";
import { diskCache, type ImportCache } from "./import/cache.js";
import { assertLine, assertPassLine, assertReport, isPrivate, type AssertInfo } from "./lang/interpreter.js";
import { Worker } from "node:worker_threads";
import { exprText, type Stmt } from "./lang/ast.js";
import { watch } from "node:fs";
import { boundsSize, isEmpty, isEmpty2, type Bounds, type Shape3 } from "./sdf/types.js";
import type { Vec3 } from "./core/vec.js";
import { dimsLabel } from "./render/views.js";
import { isMaterial, isRecord, isShape2, isShape3, isUserFn, typeName, type Value } from "./lang/values.js";
import { parse } from "./lang/parser.js";
import { format, formatDiff } from "./lang/format.js";

// Trailing zeros come off only after a decimal point: -100 once printed as -1 (measured).
// Two decimals, one above ten, none above a hundred; below 0.1, two significant figures, so a small model's parts
// (a 0.006 lens on a 0.4-unit drone, round 7) still print as themselves.
const short = (v: number): string => { const t = (Math.abs(v) >= 100 ? v.toFixed(0) : Math.abs(v) >= 10 ? v.toFixed(1) : Math.abs(v) < 0.1 && Math.abs(v) >= 0.005 ? String(Number(v.toPrecision(2))) : v.toFixed(2)).replace(/(\.\d*?)0+$/, "$1").replace(/\.$/, "") || "0"; return t === "-0" ? "0" : t; };

/**
 * A number as a value: four significant figures, as an assert's sides are printed, so a bump of 0.002 in a record
 * reads 0.002 and not 0 (round 11); `short` is for sizes and places, where two decimals are the scale of a model.
 */
const valueNum = (v: number): string => { const t = String(Number(v.toPrecision(4))); return t === "-0" ? "0" : t; };

/**
 * A value on one line, as `check` and `explain` print it: numbers to four significant figures, strings quoted, a
 * shape by its size, a record as {name: value, ...}, so a record of parameters reads as it was written.
 */
function valueText(v: Value, depth = 0): string {
  if (typeof v === "number") return valueNum(v);
  if (typeof v === "string") return JSON.stringify(v);
  if (Array.isArray(v)) return depth > 3 ? `a list of ${v.length}` : `[${v.map((x) => valueText(x, depth + 1)).join(", ")}]`;
  if (isRecord(v)) return depth > 3 ? "a record" : `{${[...v.fields].map(([k, x]) => `${k}: ${valueText(x, depth + 1)}`).join(", ")}}`;
  if (isShape3(v)) return isEmpty(v.bounds) ? "an empty shape" : `a shape ${dimsLabel(v.bounds)}`;
  if (isShape2(v)) return isEmpty2(v.bounds) ? "an empty profile" : `a profile ${short(v.bounds.max[0] - v.bounds.min[0])} × ${short(v.bounds.max[1] - v.bounds.min[1])}`;
  if (isUserFn(v)) return `def ${v.name}`;
  if (isMaterial(v)) return `material ${v.name}`;
  return `a ${typeName(v)}`;
}
/** valueText cut to a line's worth. */
const clip = (t: string, n = 100): string => (t.length > n ? `${t.slice(0, n - 3)}...` : t);

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
  // The constants a user sees: the top-level values that are not shapes (materials, numbers, lists), by running it;
  // a name that starts with _ is the library's own, and is left out with its defs.
  const ev = check(source, file);
  const exports = ev.steps.filter((st) => !isShape3(st.value) && !isShape2(st.value) && !isPrivate(st.name));
  /** The comment lines straight above a line, as one paragraph. */
  const above = (line: number): string[] => { const doc: string[] = []; for (let i = line - 2; i >= 0 && /^\s*#/.test(lines[i]); i--) doc.unshift(lines[i].replace(/^\s*#\s?/, "")); return doc; };
  for (const st of program.body) {
    if (st.type !== "def" || isPrivate(st.name)) continue;
    const doc: string[] = [];
    doc.push(...above(st.line));
    // The default as written on the def's line when it is a plain value, found by the parameter's own name (h, not
    // the h of wh=2); a record or a call is printed from its tree, since the text up to the next comma would cut it.
    const written = (name: string): string | undefined => lines[st.line - 1].match(new RegExp(`(?<![\\w.])${name}\\s*=\\s*([^,)]+)`))?.[1]?.trim();
    const balanced = (t: string) => [..."([{"].every((o, k) => t.split(o).length === t.split(")]}"[k]).length);
    const params = st.params.map((p) => { if (!p.default) return p.name; const w = written(p.name); return `${p.name}=${w !== undefined && balanced(w) ? w : exprText(p.default)}`; });
    out.push(`## ${st.name}(${params.join(", ")})`, "");
    if (doc.length) out.push(doc.join("\n"), "");
  }
  // Each constant with its value, since a record's fields are what a caller passes (round 11: a case record's
  // fields were the documentation, and doc listed only the name); a material as it was written, a long value cut.
  if (exports.length) {
    out.push("## Constants", "");
    for (const st of exports) {
      const written = program.body.find((b): b is Extract<Stmt, { type: "assign" }> => b.type === "assign" && b.name === st.name && b.line === st.line);
      const value = isMaterial(st.value) && written ? exprText(written.value) : valueText(st.value);
      const doc = above(st.line);
      out.push(`- \`${st.name} = ${clip(value, 100)}\`${doc.length ? `  \n  ${doc.join(" ")}` : ""}`);
    }
    out.push("");
  }
  return out.join("\n");
}

function usage(): never {
  console.error(
    [
      "usage:",
      "  aixle render <file.aix> [--out DIR] [--quick] [--watch] [--grid N] [--size N] [--views persp,front,right,top]",
      "                          [--no-steps] [--no-slices] [--no-turntable] [--no-poses] [--no-export] [--no-viewer]",
      "                          [--no-anims | --anim NAME[,NAME]]  skip the animation strips, or draw only these (poses.png stays)",
      "                          [--no-callouts]                    skip callouts.png, the perspective view with its visible steps named",
      "                          [--no-asserts]                     skip the program's asserts while placing parts (a quick pass that spent most of its time on them says so)",
      "                          [--beauty [--beauty-size N]] [--soft] [--crease DEG] [--texture N | --no-texture]",
      "                          [--threads N]                      threads for the beauty renders, the same picture on any number (default: the cores, at most 4)",
      "                          [--quality draft|full]             how much beauty.png and the shots sample: full, or draft with --quick (lights.png and environments.png are always draft)",
      "                          [--triangles N]                    the most triangles the GLB, OBJ and viewer carry, decimated past it (default 200000; 0 for all)",
      "                          [--beauty-only]                    the sheet and one beauty render, the set camera's shot or --camera's, written once: a lighting loop",
      "                          [--lights | --no-lights]           lights.png, each light alone (with two or more lights): on with --beauty, off with --beauty-only",
      "                          [--show NAME[,NAME]]               draw these steps with the output (a probe in place), as show output, NAME would",
      "                          [--no-caption]                     no caption on beauty.png and the camera shots: a presentation copy",
      "                          [--minecraft [PIXELS_PER_BLOCK]]   also write Bedrock geometry (model.geo.json, model.geo.png) and, with joints, model.animation.json",
      "                          [--minecraft-entity]               the geometry is an entity's, facing north (a block faces south)",
      "                          [--roblox]                          also write model.roblox.glb for Studio's 3D Importer (facing -Z, _Att nodes)",
      "                          [--3mf]                             also write model.3mf and judge the model as a print (both anyway when the program sets units or a bed)",
      "                          [--azimuth DEG] [--elevation DEG] [--zoom N] [--focus NAME] [--pose NAME]",
      "                          [--slice NAME]                     slices.png through one step, framed on it, the rest of the model faint",
      "                          [--camera NAME] [--environment NAME|A,B|all]  one declared shot only (the sheet takes its view); a sky over the program's, or several into environments.png",
      "                          [--no-steps] [--no-slices] [--no-turntable] [--no-export] [--no-viewer]",
      "  aixle check  <file.aix> [--pose NAME] [--no-asserts] [--brief]   parse and evaluate; print sizes and warnings, render nothing (--brief: no sizes, a library by its count)",
      "  --no-cache   (check, render, explain, diff) sample every import afresh and store nothing; imports are otherwise cached by content",
      "               in ~/.cache/aixle/imports (or $AIXLE_CACHE_DIR), at most 512 MB, least recently used first out",
      "  aixle explain <file.aix> [--pose NAME]  the program as a tree from the output down: each step's line, size, material and anchors",
      "  aixle diff   <a.aix> <b.aix> [--out FILE.png]   the two side by side, quickly",
      "  aixle fmt    <file.aix>         the program in the one layout, to stdout (comments kept, meaning unchanged)",
      "  aixle fmt    <file.aix>... --write | --check   rewrite them in place, or check them: each line fmt would change, as it is and as fmt writes it, and fail",
      "  aixle doc    [--write FILE]    the language reference, generated from the builtins",
      "  aixle doc    NAME [NAME...]    one entry of it: a builtin's description, signatures and parameters (or a preset's row); the nearest names for one it lacks",
      "  aixle doc    <lib.aix>          a library's defs and their comments, for a program that would use it",
    ].join("\n"),
  );
  process.exit(2);
}

/**
 * `aixle fmt`: the program in the one layout. Alone it prints the result; `--write` rewrites each file that is not
 * in it; `--check` changes nothing, says of each file whether it is formatted, and fails on one that is not, with
 * the lines that differ, for CI or a hook. A program that does not parse is an error, never rewritten.
 */
function fmt(args: string[]): number {
  const files = args.filter((a) => !a.startsWith("--"));
  const write = args.includes("--write"), checkOnly = args.includes("--check");
  const unknown = args.filter((a) => a.startsWith("--") && a !== "--write" && a !== "--check");
  if (unknown.length || !files.length) usage();
  if (write && checkOnly) { console.error("aixle fmt: --write or --check, not both"); return 2; }
  if (!write && !checkOnly && files.length > 1) { console.error("aixle fmt prints one file; give --write or --check for several"); return 2; }
  let status = 0;
  for (const file of files) {
    let source: string;
    try { source = readFileSync(file, "utf8"); } catch { console.error(`cannot read ${file}`); status = 1; continue; }
    let formatted: string;
    try { formatted = format(source); } catch (err) { console.error(`${file}: ${(err as Error).message}`); status = 1; continue; }
    if (checkOnly) {
      // The lines that differ, as they are and as fmt writes them, and a word for a file that passes, so a pass is
      // not taken for a file never looked at (round 11).
      if (formatted !== source) {
        const d = formatDiff(source, formatted);
        console.log(`${file}: not formatted, ${d.count} line${d.count === 1 ? " differs" : "s differ"}; aixle fmt --write ${file}`);
        for (const l of d.lines) console.log(`  ${l}`);
        status = 1;
      } else console.log(`${file}: formatted`);
    } else if (write) {
      if (formatted !== source) { writeFileSync(file, formatted); console.log(`formatted ${file}`); }
      else console.log(`${file}: already formatted`);
    } else process.stdout.write(formatted);
  }
  return status;
}

/**
 * A thread that names an assert still running two seconds after it started, and again at 10, 30 and 60 seconds and
 * each minute after, so a query that never returns shows where it is (round 11: a check printed nothing for twelve
 * minutes). The evaluation holds the main thread while it runs, so the watchdog is a worker reading a shared buffer
 * and writing straight to the terminal's error stream. Undefined where a worker cannot start; nothing is lost then
 * but the naming of a hang.
 */
function assertWatchdog(): ((a: AssertInfo | undefined) => void) | undefined {
  try {
    const TEXT = 1024;
    const shared = new SharedArrayBuffer(16 + TEXT);
    const head = new Int32Array(shared, 0, 4);
    const text = new Uint8Array(shared, 16, TEXT);
    const base = Date.now();
    const worker = new Worker(
      `const { workerData } = require("node:worker_threads");
       const { writeSync } = require("node:fs");
       const head = new Int32Array(workerData.shared, 0, 4), text = new Uint8Array(workerData.shared, 16, ${TEXT});
       const marks = [2, 10, 30, 60];
       let seq = 0, next = 0;
       setInterval(() => {
         const s = Atomics.load(head, 0);
         if (s !== seq) { seq = s; next = 0; }
         if (Atomics.load(head, 1) === 0) return;
         const ran = (Date.now() - workerData.base - Atomics.load(head, 2)) / 1000;
         const due = next < marks.length ? marks[next] : 60 * (next - marks.length + 2);
         if (ran < due) return;
         next++;
         const label = new TextDecoder().decode(text.slice(0, Atomics.load(head, 3)));
         try { writeSync(2, "still judging " + label + " after " + Math.floor(ran) + " s\\n"); } catch {}
       }, 250);`,
      { eval: true, workerData: { shared, base } },
    );
    worker.unref();
    // A watchdog that fails to start or stops is no reason to fail the run.
    worker.on("error", () => {});
    const encoder = new TextEncoder();
    return (a) => {
      if (!a) { Atomics.store(head, 1, 0); return; }
      const bytes = encoder.encode(assertLabel(a)).slice(0, TEXT);
      text.set(bytes);
      Atomics.store(head, 3, bytes.length);
      Atomics.store(head, 2, Date.now() - base);
      Atomics.store(head, 1, a.line);
      Atomics.add(head, 0, 1);
    };
  } catch {
    return undefined;
  }
}

let watchdog: { watch?: (a: AssertInfo | undefined) => void } | undefined;
/** The CLI's assert clock: slow asserts named on the error stream, a hang named by the watchdog (one per process). */
function cliAssertClock(): AssertClock {
  watchdog ??= { watch: assertWatchdog() };
  return new AssertClock(() => performance.now(), (l) => process.stderr.write(`${l}\n`), { watch: watchdog.watch });
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
  // fmt's flags take no value, so `fmt --write model.aix` is not --write=model.aix.
  if (cmd === "fmt") return fmt(rest);
  const { positional, opts } = flags(rest);
  if (cmd === "doc") {
    // `aixle doc lib.aix` documents a library the way the reference documents builtins: each def with its
    // parameters and defaults, and the comment lines above it, so a caller places its parts without reading it.
    // `aixle doc sweep` prints that one entry, where the whole reference is some 900 lines (an argument not ending in
    // .aix used to be ignored, and all of it printed); a name the reference lacks gets its nearest names and a failure.
    const lib = positional[0];
    let md: string;
    let missing = 0;
    if (!lib) md = referenceMarkdown();
    else if (lib.endsWith(".aix")) md = libraryMarkdown(lib);
    else {
      const found: string[] = [];
      for (const name of positional) {
        const entry = referenceEntry(name);
        if (entry) { found.push(entry); continue; }
        missing++;
        const near = nearestNames(name);
        console.error(`aixle doc: no entry named '${name}' in the reference${near.length ? `; the nearest: ${near.join(", ")}` : ""} (aixle doc alone prints the whole reference)`);
      }
      md = found.join("\n");
    }
    if (typeof opts.write === "string") {
      writeFileSync(opts.write, md);
      console.log(`wrote ${opts.write}`);
    } else process.stdout.write(md);
    return missing ? 1 : 0;
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
  // An import's samples are kept on disk by the file's content, so a check and the render after it sample a large mesh
  // once between them; --no-cache samples afresh and stores nothing.
  const importCache: ImportCache | undefined = opts["no-cache"] ? undefined : diskCache();
  if (cmd === "check") {
    try {
      const clock = cliAssertClock();
      const rest = check(source, file, (l) => console.log(l), undefined, undefined, !!opts["no-asserts"], importCache, clock.hook);
      // Sizes are printed for the pose the sheet would show, so a posed rig's numbers match its pictures.
      const poseName = typeof opts.pose === "string" ? opts.pose : typeof rest.settings.pose === "string" ? rest.settings.pose : undefined;
      const pose = poseName ? rest.poses.find((p) => p.name === poseName) : undefined;
      const ev = pose ? check(source, file, undefined, pose.joints, pose.name, !!opts["no-asserts"], importCache, clock.hook) : rest;
      if (poseName && !pose && poseName !== "rest") console.log(`warning: pose ${poseName}: no such pose (poses: ${rest.poses.map((p) => p.name).join(", ") || "none"}); sizes are at rest`);
      if (pose) console.log(`pose: ${pose.name} (sizes below are in this pose; poses: ${rest.poses.map((p) => p.name).join(", ")})`);
      else if (rest.poses.length) console.log(`poses: ${rest.poses.map((p) => p.name).join(", ")} (sizes below are at rest; --pose NAME for one of them)`);
      // The rig as a tree, joints made inside a def included, so it can be checked without a render (round 7).
      if (rest.output) { const tree = jointTreeLines(rest.output, short); if (tree.length) console.log(`joints:\n${tree.map((l) => `  ${l}`).join("\n")}`); }
      // A model under 0.1 units (a 4 mm part drawn in metres) printed every span as 0..0 at two decimals: its spans
      // keep three figures of the model's own size instead; any larger model prints as it always has.
      const modelSize = ev.output && !isEmpty(ev.output.bounds) ? Math.max(...boundsSize(ev.output.bounds)) : 1;
      const q = modelSize > 0 && modelSize < 0.1 ? 10 ** (Math.floor(Math.log10(modelSize)) - 2) : 0;
      const at = (v: number): string => (q ? String(Number((Math.round(v / q) * q).toPrecision(12))) : short(v));
      const span = (b: { min: number[]; max: number[] }) => ["x", "y", "z"].map((a, k) => `${a} ${at(b.min[k])}..${at(b.max[k])}`).join("  ");
      const spanBox = (b: Bounds) => `${dimsLabel(b).padEnd(20)} ${span(b)}`;
      // --brief names each library and how much it exports; the full check lists the names (round 11: a library's 24
      // names opened every brief check).
      for (const m of ev.modules) console.log(`use ${m.prefix.padEnd(14)} ${m.path}: ${opts.brief ? `${m.names.length} name${m.names.length === 1 ? "" : "s"} (check without --brief lists them)` : m.names.join(", ")}`);
      // --brief: the verdicts alone (output, warnings, notes, asserts), for a promise loop on a big program.
      for (const st of opts.brief ? [] : ev.steps) {
        // Numbers too: an agent sizing a member from a computed distance wants to see the distance.
        // A number set inside a loop is the last iteration's, not a size: not listed (round 9: "a = 327" as a step).
        if (st.inLoop && !isShape3(st.value) && !isShape2(st.value)) continue;
        if (typeof st.value === "number") { console.log(`${st.name.padEnd(18)} = ${valueNum(st.value)}`); continue; }
        if (Array.isArray(st.value) && st.value.every((v) => typeof v === "number")) { console.log(`${st.name.padEnd(18)} = [${st.value.map((v) => valueNum(v as number)).join(", ")}]`); continue; }
        // A record on one line when it fits; else a line per field (or per record of a list), a shape field with its
        // box, as a step would have, so a record of parts reads like the parts.
        const recordList = Array.isArray(st.value) && st.value.length > 0 && st.value.every(isRecord);
        if (isRecord(st.value) || recordList) {
          const inline = valueText(st.value);
          const entries: [string, Value][] = isRecord(st.value) ? [...st.value.fields].map(([k, x]) => [`${st.name}.${k}`, x]) : (st.value as Value[]).map((x, i) => [`${st.name}[${i}]`, x]);
          if (inline.length <= 100 && !entries.some(([, x]) => isShape3(x))) { console.log(`${st.name.padEnd(18)} = ${inline}`); continue; }
          console.log(`${st.name.padEnd(18)} ${isRecord(st.value) ? `a record of ${entries.length}: ${clip([...st.value.fields.keys()].join(", "), 80)}` : `a list of ${entries.length} records`}`);
          for (const [k, x] of entries.slice(0, 24)) {
            if (isShape3(x)) console.log(`${`  ${k}`.padEnd(18)} ${isEmpty(x.bounds) ? "empty" : spanBox(x.bounds)}`);
            else console.log(`${`  ${k}`.padEnd(18)} = ${clip(valueText(x))}`);
          }
          if (entries.length > 24) console.log(`  ... ${entries.length - 24} more`);
          continue;
        }
        // A 2D profile has a box too, and a part built from one is invisible until it is extruded (round 4 asked).
        if (isShape2(st.value)) {
          const b = st.value.bounds;
          console.log(`${st.name.padEnd(18)} ${isEmpty2(b) ? "profile, empty" : `profile ${at(b.max[0] - b.min[0])} × ${at(b.max[1] - b.min[1])}`.padEnd(20) + ` x ${at(b.min[0])}..${at(b.max[0])}  y ${at(b.min[1])}..${at(b.max[1])}`}`);
          // Lettering on an arc: the radii it spans from the origin, which is what meets a rim (round 10).
          const span = st.value.arcSpan;
          if (span) console.log(`${"  on the arc".padEnd(18)} r ${Number(span[0].toPrecision(3))}..${Number(span[1].toPrecision(3))} from the origin`);
          continue;
        }
        if (!isShape3(st.value)) continue;
        // A cutter is drawn as the solid it removes and a region is read by an assert, a decal or a camera: neither is
        // a part, and the tag says which (round 9: agents took a region's warning for a mistake).
        const role = ev.roles.get(st.name);
        const used = role === "part" ? "" : role === "cut" ? "   (cut)" : role === "mask" ? "   (mask)" : role === "region" ? "   (region)" : "   (not in output)";
        const b = st.value.bounds;
        console.log(`${st.name.padEnd(18)} ${isEmpty(b) ? "empty" : spanBox(b)}${used}`);
        if (isEmpty(b)) continue;
        // A box after a rotation, a warp or a posed joint is the box of a turned box: measure the surface itself
        // and print that when it is tighter (measured: a boom's box read 5.9 tall for a 5.2 surface).
        let own = b;
        if (hasLooseBounds(st.value)) {
          const e = surfaceExtentDeep(st.value);
          const tighter = [0, 1, 2].some((k) => (e.max[k] - e.min[k]) < (b.max[k] - b.min[k]) * 0.95);
          if (!isEmpty(e) && tighter) { own = e; console.log(`${"  surface".padEnd(18)} ${spanBox(e)}`); }
        }
        // Named anchors, where they are in this step's frame.
        const anchors = Object.entries(anchorsOf(st.value));
        if (anchors.length) console.log(`${"  anchors".padEnd(18)} ${anchors.map(([k, p]) => `${k} (${p.map(short).join(", ")})`).join("  ")}`);
        // In a pose, the anchors where the joints above put them too (round 8: a gondola's floor read in its own frame).
        if (anchors.length && pose && ev.output) {
          const shape = st.value as Shape3;
          const placed: [string, Vec3][] = [];
          for (const [k, p] of anchors) { const q = placedPoint(ev.output, shape, p); if (q) placed.push([k, q]); }
          if (placed.some(([k, q]) => { const p = anchorsOf(shape)[k]; return q.some((v, i) => Math.abs(v - p[i]) > 1e-6); }))
            console.log(`${"  anchors posed".padEnd(18)} ${placed.map(([k, q]) => `${k} (${q.map(short).join(", ")})`).join("  ")}`);
        }
        // In a pose, where the step ends up once the joints above it have turned: the surface itself, measured
        // through the joints' inverses, so a turned wheel's posed line says whether it still touches the floor.
        if (pose && ev.output) {
          const placedS = placedShape(ev.output, st.value);
          const placed = placedS ? surfaceExtentDeep(st.value, ev.output) : undefined;
          if (placed && !isEmpty(placed) && [0, 1, 2].some((k) => Math.abs(placed.min[k] - own.min[k]) > 1e-6 || Math.abs(placed.max[k] - own.max[k]) > 1e-6))
            console.log(`${`  posed ${st.name}`.padEnd(18)} ${spanBox(placed)}`);
        }
      }
      // What each rest() and lean() did: how far it moved or turned its part, a line per call (a loop's calls on one).
      if (!opts.brief) for (const l of contactLines(ev.contacts)) console.log(l);
      // In a pose the output's box is the box of turned boxes; its surface is the size the sheet shows (round 8: a
      // sitting dog's output line said 1.84 tall for a 1.18 surface).
      // The program's own defs, with their parameters, so a program's vocabulary is on the terminal with its steps.
      if (ev.defs.length && !opts.brief) console.log(`defs: ${ev.defs.map((d) => `${d.name}(${d.params.map((p) => (p.default ? `${p.name}=${exprText(p.default)}` : p.name)).join(", ")})`).join("  ")}`);
      if (ev.output && pose && !isEmpty(ev.output.bounds)) { const e = surfaceExtent(ev.output, 48); console.log(`output: ${ev.outputName} ${isEmpty(e) ? dimsLabel(ev.output.bounds) : `${dimsLabel(e)} (the surface in pose ${pose.name}; its box is ${dimsLabel(ev.output.bounds)})`}`); }
      else if (ev.output) console.log(`output: ${ev.outputName} ${isEmpty(ev.output.bounds) ? "(empty)" : dimsLabel(ev.output.bounds)}`);
      else console.log("output: none");
      // A pose is meshed at the rest pose's cell, so its thin parts are judged there too.
      const { grid, cellSize } = cellFor(pose ? rest : ev, typeof opts.grid === "string" ? Number(opts.grid) : undefined);
      let bedWarning: string | undefined;
      // Past the 500 cells the extractor takes along the posed model, a render cannot keep it.
      const posedCells = pose && ev.output && cellSize > 0 && !isEmpty(ev.output.bounds) ? Math.max(...boundsSize(tightBounds(ev.output))) / cellSize : 0;
      if (cellSize > 0) console.log(`grid ${grid}: cell ${Number(cellSize.toPrecision(3))} units${pose ? posedCells > 500 ? `, the rest pose's; pose ${pose.name} is about ${Math.round(posedCells)} of those along its longest side, past the 500 a render takes, so a render of it is meshed coarser` : `, the rest pose's, which a render of pose ${pose.name} keeps` : ""}`);
      // A program that says it is a print (set units, set bed) gets its size in millimetres and the bed's verdict,
      // from the surface's extent (rays, no mesh); the thinnest wall and the supports are the render's report.
      if ((ev.settings.units !== undefined || ev.settings.bed !== undefined) && ev.output && !isEmpty(ev.output.bounds)) {
        const u = printUnits(ev.settings);
        const bed = printBed(ev.settings);
        const e = surfaceExtent(ev.output, 48);
        let fit = bedFit(boxCorners(e.min, e.max), u.mm, bed ?? [Infinity, Infinity, Infinity]);
        // The box holds the outline but is wider than it turned: a bar across the diagonal fits turned where its box
        // fits only lying down. When the box does not fit square, the outline is judged turned and lying as the render
        // judges its own, from a coarse mesh, so check and the report give one verdict and warn alike.
        if (bed && !fit.fits) {
          const coarse = surfaceNets(ev.output, { resolution: Math.min(64, Math.max(16, grid)) }).mesh.positions;
          if (coarse.length) fit = bedFit(coarse, u.mm, bed);
        }
        console.log(`print: units ${unitsText(u, fit.size[2])}; ${fit.size.map(fmtMm).join(" × ")} mm (x and z on the plate, y up)${bed ? `; ${fitText(fit, bed)}` : ""}; the report has the thinnest wall and the supports`);
        if (bed && !fit.fits && fit.turned === undefined) bedWarning = `The model is ${fit.size.map(fmtMm).join(" × ")} mm and ${fitText(fit, bed)}.`;
      }
      if (ev.output && !isEmpty(ev.output.bounds)) {
        // The surface's lowest point, not the bounds': the note a render would make, without the render.
        const bottom = surfaceBottom(ev.output);
        // A hair below the floor prints as a hair, not as 0 (round 8: "at y = 0; pipe it through ground()").
        const shortY = (v: number): string => (v !== 0 && Math.abs(v) < 0.01 ? String(Number(v.toPrecision(2))) : short(v));
        // In a pose the floor is the pose's doing: ground() would move the rest model and the exports too.
        if (pose && bottom < -cellSize) console.log(`note: in pose ${pose.name} the lowest point of the surface is at y = ${shortY(bottom)}, below the floor: raise the root joint with xform(move=) in the pose, or bend it less`);
        else if (pose && bottom > cellSize * 2) console.log(`note: in pose ${pose.name} the model is off the floor: its lowest point is at y = ${shortY(bottom)} (standing is not judged in this pose)`);
        else if (bottom < -cellSize && -bottom > 0.1 * (ev.output.bounds.max[1] - bottom)) console.log(`note: the lowest point of the surface is at y = ${shortY(bottom)}; pipe the model through ground() to rest it on y = 0`);
        else if (bottom > cellSize * 2) console.log(`note: the surface floats: its lowest point is at y = ${shortY(bottom)}; ground() rests it on y = 0`);
      }
      // A Bedrock export's own thinness test runs here too, so check says what render would (round 7: a nose skin).
      const minecraftPx = typeof rest.settings.minecraft === "number" ? rest.settings.minecraft : 0;
      const warnings = [...ev.warnings, ...restAssertWarningsFor(ev, rest), ...(cellSize > 0 ? foldThinWarnings(thinWarnings(ev, cellSize, grid)) : []), ...paintWarnings(ev), ...cutWarnings(ev, cellSize), ...glassWarnings(ev), ...(minecraftPx > 0 ? minecraftThinWarnings(rest, minecraftPx, grid) : []), ...(bedWarning ? [bedWarning] : [])];
      for (const w of warnings) console.log(`warning: ${w}`);
      // The report's own note on parts between 1.2 and 2 cells, so check and the report judge thinness alike; with no
      // warnings it shares their line, so "no warnings" is never read as the whole verdict (round 11: a 1.6-cell wall's
      // note under it went unread).
      const nearly = cellSize > 0 ? nearlyThin(ev, cellSize).trim() : "";
      // What each focused camera sees of its focus, from rays: the render's hidden-focus test, before a beauty run
      // (round 11). Its warning is printed under the cameras' line, so it is counted here.
      const sight = cameraSight(ev, cellSize);
      if (warnings.length === 0 && sight.warnings.length === 0) console.log(nearly ? `no warnings; note: ${nearly}` : "no warnings");
      else if (nearly) console.log(`note: ${nearly}`);
      // The lights, the shots and the sky, as the report will list them: a typo in a name is a warning above.
      for (const l of presentationLines(ev, typeof ev.settings.camera === "string" ? ev.settings.camera : undefined, ENVIRONMENTS.includes(ev.settings.environment as never) ? String(ev.settings.environment) : undefined)) {
        console.log(l);
        if (l.startsWith("Cameras: ")) { for (const c of sight.lines) console.log(c); for (const w of sight.warnings) console.log(`warning: ${w}`); }
      }
      // The program's own promises, each failure with the numbers it saw; a failure fails the check like an error.
      // They are judged at rest: a promise about the model as built, whatever pose is being measured.
      const all = collectAsserts(rest, (pn) => { const p = rest.poses.find((x) => x.name === pn); return p ? (pn === pose?.name ? ev : check(source, file, undefined, p.joints, pn, !!opts["no-asserts"], importCache, clock.hook)) : undefined; });
      const failed = all.filter((a) => !a.passed);
      // A passing promise prints its numbers too, so how close it came is on the terminal and not only in
      // report.json (round 8: the gap between closed fingers), in line order; one judged many times in a loop is one
      // line with the judgement nearest to failing, and the failures come last, in full (round 11).
      for (const l of assertReport(all)) console.log(l);
      if (all.length) console.log(`asserts: ${failed.length ? `${all.length - failed.length} pass, ${failed.length} fail` : `${all.length} pass`}${all.some((a) => a.pose) ? " (at rest, or in the pose each names)" : pose ? " (judged at rest)" : ""}`);
      // Where the time went, when the promises took more than a couple of seconds; on the error stream, as the clock's lines are.
      const slow = clock.summary();
      if (slow) process.stderr.write(`${slow}\n`);
      return failed.length ? 1 : 0;
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
      const rest = check(source, file, undefined, undefined, undefined, false, importCache);
      const poseName = typeof opts.pose === "string" ? opts.pose : typeof rest.settings.pose === "string" ? rest.settings.pose : undefined;
      const pose = poseName ? rest.poses.find((p) => p.name === poseName) : undefined;
      const ev = pose ? check(source, file, undefined, pose.joints, undefined, false, importCache) : rest;
      const lines = source.split(/\r?\n/);
      const byName = new Map(ev.steps.map((st) => [st.name, st]));
      const memo = new Map<Shape3, PaintState>();
      const printed = new Set<string>();
      const describe = (name: string): string => {
        const st = byName.get(name);
        if (!st) return `${name}: not a step`;
        const v = st.value;
        let what: string;
        if (typeof v === "number") what = `= ${valueNum(v)}`;
        else if (typeof v === "string") what = `= "${v}"`;
        else if (Array.isArray(v)) what = v.every((x) => typeof x === "number") ? `= [${v.map((x) => valueNum(x as number)).join(", ")}]` : v.length && v.every(isRecord) ? clip(`= ${valueText(v)}`) : `a list of ${v.length}`;
        else if (isRecord(v)) what = clip(`= ${valueText(v)}`);
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
      for (const r of roots) {
        if (byName.has(r)) { walk(r, 0); continue; }
        // An output that is no one step (a record's field that holds no step of its own, show box(1), show a, b):
        // its size, then the steps it reads, rather than an empty tree.
        const obj = ev.objects.find((o) => o.name === r);
        console.log(`${r}  ${obj && !isEmpty(obj.shape.bounds) ? dimsLabel(obj.shape.bounds) : "empty"}  (shown, not a step)`);
        if (ev.objects.length > 1) continue;
        const read = new Set(ev.steps.filter((st) => ev.roles.get(st.name) === "part").flatMap((st) => [...st.deps]));
        for (const st of ev.steps) if (ev.roles.get(st.name) === "part" && !read.has(st.name)) walk(st.name, 1);
      }
      const left = ev.steps.filter((st) => !printed.has(st.name) && (isShape3(st.value) || isShape2(st.value)));
      const regions = left.filter((st) => ev.roles.get(st.name) === "region").map((st) => st.name);
      const unused = left.filter((st) => !ev.roles.has(st.name)).map((st) => st.name);
      if (regions.length) console.log(`\nregions (read by an assert, a decal or a camera, not geometry): ${regions.join(", ")}`);
      if (unused.length) console.log(`\nnot in the output: ${unused.join(", ")}`);
      if (ev.poses.length) console.log(`\nposes: ${ev.poses.map((p) => p.name).join(", ")}`);
      for (const m of ev.modules) console.log(`\nuse ${m.prefix} (${m.path}): ${m.names.join(", ")}`);
      // The promises as check judges them: at rest, and each pose's in its pose (a posed evaluation judges only its own).
      const judged = collectAsserts(rest, (pn) => { const p = rest.poses.find((x) => x.name === pn); return p ? check(source, file, undefined, p.joints, pn, false, importCache) : undefined; });
      if (judged.length) console.log(`\nasserts: ${assertsRow(judged)}`);
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
      const r = diff({ source, name: file }, { source: b, name: other }, outFile, { importCache });
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
  const once = (src: string): number => renderOnce(src, file, outDir, opts, importCache);
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

function renderOnce(source: string, file: string, outDir: string, opts: Record<string, string | boolean>, importCache?: ImportCache): number {
  const threads = typeof opts.threads === "string" ? Number(opts.threads) : defaultThreads();
  if (!Number.isInteger(threads) || threads < 1) {
    console.error(`--threads ${opts.threads}: the number of threads is a whole number, 1 or more`);
    return 2;
  }
  if (opts.quality !== undefined && !QUALITIES.includes(opts.quality as never)) {
    console.error(`--quality${typeof opts.quality === "string" ? ` ${opts.quality}` : ""}: the quality is ${QUALITIES.join(" or ")}`);
    return 2;
  }
  try {
    const quick = opts.quick ? QUICK : {};
    const given: Record<string, unknown> = {
      grid: typeof opts.grid === "string" ? Number(opts.grid) : undefined,
      size: typeof opts.size === "string" ? Number(opts.size) : undefined,
      views: typeof opts.views === "string" ? opts.views.split(",") : undefined,
      steps: opts["no-steps"] ? false : undefined,
      callouts: opts["no-callouts"] ? false : undefined,
      poses: opts["no-poses"] ? false : undefined,
      animations: opts["no-anims"] ? false : typeof opts.anim === "string" ? opts.anim.split(",") : undefined,
      asserts: opts["no-asserts"] ? false : undefined,
      slices: opts["no-slices"] ? false : undefined,
      turntable: opts["no-turntable"] ? false : undefined,
      obj: opts["no-export"] ? false : undefined,
      glb: opts["no-export"] ? false : undefined,
      viewer: opts["no-viewer"] ? false : undefined,
      beauty: opts.beauty === true || opts["beauty-only"] === true ? true : undefined,
      ...(opts["beauty-only"] ? BEAUTY_ONLY : {}),
      lights: opts.lights ? true : opts["no-lights"] ? false : opts["beauty-only"] ? false : undefined,
      show: typeof opts.show === "string" ? opts.show.split(",").map((x) => x.trim()).filter(Boolean) : undefined,
      beautySize: typeof opts["beauty-size"] === "string" ? Number(opts["beauty-size"]) : undefined,
      threads,
      quality: typeof opts.quality === "string" ? opts.quality : undefined,
      sharp: opts.soft ? false : undefined,
      crease: typeof opts.crease === "string" ? Number(opts.crease) : undefined,
      roblox: opts.roblox ? true : undefined,
      threemf: opts["3mf"] ? true : undefined,
      minecraft: opts.minecraft === true ? 16 : typeof opts.minecraft === "string" ? Number(opts.minecraft) : undefined,
      minecraftEntity: opts["minecraft-entity"] ? true : undefined,
      texture: opts["no-texture"] ? 0 : typeof opts.texture === "string" ? Number(opts.texture) : undefined,
      triangles: typeof opts.triangles === "string" ? Number(opts.triangles) : undefined,
      azimuth: typeof opts.azimuth === "string" ? Number(opts.azimuth) : undefined,
      zoom: typeof opts.zoom === "string" ? Number(opts.zoom) : undefined,
      elevation: typeof opts.elevation === "string" ? Number(opts.elevation) : undefined,
      focus: typeof opts.focus === "string" ? opts.focus : undefined,
      slice: typeof opts.slice === "string" ? opts.slice : undefined,
      caption: opts["no-caption"] ? false : undefined,
      pose: typeof opts.pose === "string" ? opts.pose : undefined,
      camera: typeof opts.camera === "string" ? opts.camera : undefined,
      environment: typeof opts.environment === "string" ? opts.environment : undefined,
    };
    for (const k of Object.keys(given)) if (given[k] === undefined) delete given[k];
    const result = run(source, file, outDir, { ...quick, ...given, importCache, log: (l) => console.log(l), onAssert: cliAssertClock().hook });
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
