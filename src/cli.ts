#!/usr/bin/env node
/**
 *   aixle render <file.aix> [--out DIR] [--grid N] [--size N] [--no-steps] [--no-slices] [--no-turntable] [--no-export]
 *   aixle check  <file.aix>
 *   aixle doc    [--write FILE]
 */
import { readFileSync, writeFileSync } from "node:fs";
import { basename, resolve } from "node:path";
import { referenceMarkdown } from "./doc.js";
import { check, run } from "./pipeline.js";
import { isEmpty } from "./sdf/types.js";
import { dimsLabel } from "./render/views.js";
import { isShape3 } from "./lang/values.js";

function usage(): never {
  console.error(
    [
      "usage:",
      "  aixle render <file.aix> [--out DIR] [--grid N] [--size N] [--views persp,front,right,top]",
      "                          [--beauty [--beauty-size N]] [--soft] [--texture N | --no-texture]",
      "                          [--azimuth DEG] [--elevation DEG]",
      "                          [--no-steps] [--no-slices] [--no-turntable] [--no-export] [--no-viewer]",
      "  aixle check  <file.aix>        parse and evaluate; print sizes and warnings, render nothing",
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
      const ev = check(source, file, (l) => console.log(l));
      for (const st of ev.steps) {
        if (!isShape3(st.value)) continue;
        const used = ev.used.has(st.name) ? "" : "   (not in output)";
        console.log(`${st.name.padEnd(20)} ${isEmpty(st.value.bounds) ? "empty" : dimsLabel(st.value.bounds)}${used}`);
      }
      if (ev.output) console.log(`output: ${ev.outputName} ${isEmpty(ev.output.bounds) ? "(empty)" : dimsLabel(ev.output.bounds)}`);
      else console.log("output: none");
      for (const w of ev.warnings) console.log(`warning: ${w}`);
      return 0;
    } catch (err) {
      console.error(`${file}: ${(err as Error).message}`);
      return 1;
    }
  }
  if (cmd !== "render") usage();
  const outDir = typeof opts.out === "string" ? resolve(opts.out) : resolve("out", basename(file).replace(/\.[^.]+$/, ""));
  try {
    const result = run(source, file, outDir, {
      grid: typeof opts.grid === "string" ? Number(opts.grid) : undefined,
      size: typeof opts.size === "string" ? Number(opts.size) : undefined,
      views: typeof opts.views === "string" ? (opts.views.split(",") as never) : undefined,
      steps: !opts["no-steps"],
      slices: !opts["no-slices"],
      turntable: !opts["no-turntable"],
      obj: !opts["no-export"],
      glb: !opts["no-export"],
      viewer: !opts["no-viewer"],
      beauty: opts.beauty === true,
      beautySize: typeof opts["beauty-size"] === "string" ? Number(opts["beauty-size"]) : undefined,
      sharp: opts.soft ? false : undefined,
      texture: opts["no-texture"] ? 0 : typeof opts.texture === "string" ? Number(opts.texture) : undefined,
      azimuth: typeof opts.azimuth === "string" ? Number(opts.azimuth) : undefined,
      elevation: typeof opts.elevation === "string" ? Number(opts.elevation) : undefined,
      log: (l) => console.log(l),
    });
    console.log(`wrote ${result.files.length} files to ${outDir}`);
    for (const w of result.warnings) console.log(`warning: ${w}`);
    console.log(`look at ${resolve(outDir, "sheet.png")} first, then slices.png and steps.png; details in report.md`);
    return result.mesh ? 0 : 1;
  } catch (err) {
    console.error(`${file}: ${(err as Error).message}`);
    return 1;
  }
}

process.exitCode = main(process.argv.slice(2));
