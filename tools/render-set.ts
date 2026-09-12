/**
 * Render a folder of .aix programs into a folder of pictures at a size
 * that keeps the repository small: the contact sheet, the cross-sections,
 * the steps and the beauty render for each, plus pose and animation sheets
 * when there are joints. Used by the examples and the dogfood sets; CI
 * regenerates both and fails if the committed files differ, so a change in
 * a render always comes with the change that caused it.
 */
import { copyFileSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { tmpdir } from "node:os";
import { run } from "../src/pipeline.js";

export interface RenderSetOptions {
  /** Only these names (file names without .aix); empty for all. */
  only?: string[];
  /** Skip files whose name ends with this (probes are kept next to the models but not rendered). */
  skipSuffix?: string;
  /** Write the sheet and the beauty render only, not slices and steps. */
  sheetAndBeautyOnly?: boolean;
}

/** Every .aix under `dir`, recursively, as paths relative to it. */
function programs(dir: string, prefix = ""): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir).sort()) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) {
      if (entry !== "renders") out.push(...programs(full, join(prefix, entry)));
    } else if (entry.endsWith(".aix")) out.push(join(prefix, entry));
  }
  return out;
}

export function renderSet(srcDir: string, outDir: string, label: string, opts: RenderSetOptions = {}): void {
  mkdirSync(outDir, { recursive: true });
  const files = programs(srcDir)
    .filter((f) => !opts.skipSuffix || !f.endsWith(opts.skipSuffix))
    .filter((f) => !opts.only?.length || opts.only.includes(f.replace(/^.*\//, "").replace(/\.aix$/, "")) || opts.only.includes(f.replace(/\.aix$/, "").replace(/\//g, "_")));
  for (const file of files) {
    // A program in a subfolder keeps the folder in its render's name, so round-2/frog and round-3/frog do not collide.
    const name = file.replace(/\.aix$/, "").replace(/\//g, "_");
    const tmp = join(tmpdir(), `aixle-${label}-${name}`);
    rmSync(tmp, { recursive: true, force: true });
    const t0 = performance.now();
    const result = run(readFileSync(join(srcDir, file), "utf8"), `${relative(process.cwd(), srcDir)}/${file}`, tmp, {
      defaultGrid: 112,
      size: 384,
      views: [],
      turntable: false,
      obj: false,
      glb: false,
      beauty: true,
      beautySize: 384,
      steps: !opts.sheetAndBeautyOnly,
      slices: !opts.sheetAndBeautyOnly,
    });
    copyFileSync(join(tmp, "sheet.png"), join(outDir, `${name}.png`));
    if (!opts.sheetAndBeautyOnly) {
      copyFileSync(join(tmp, "slices.png"), join(outDir, `${name}_slices.png`));
      copyFileSync(join(tmp, "steps.png"), join(outDir, `${name}_steps.png`));
    }
    copyFileSync(join(tmp, "beauty.png"), join(outDir, `${name}_beauty.png`));
    for (const extra of readdirSync(tmp).filter((f) => f === "poses.png" || f.startsWith("anim_")))
      copyFileSync(join(tmp, extra), join(outDir, `${name}_${extra}`));
    const secs = ((performance.now() - t0) / 1000).toFixed(1);
    console.log(`${name.padEnd(10)} ${secs}s  ${result.warnings.length ? result.warnings.join(" | ") : "ok"}`);
    rmSync(tmp, { recursive: true, force: true });
  }
}
