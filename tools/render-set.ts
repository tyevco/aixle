/**
 * Render a folder of .aix programs into a folder of pictures at a size
 * that keeps the repository small: the contact sheet, the cross-sections,
 * the steps and the beauty render for each, plus pose and animation sheets
 * when there are joints. Used by the examples and the dogfood sets; CI
 * regenerates both and fails if the committed files differ, so a change in
 * a render always comes with the change that caused it.
 */
import { copyFileSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { tmpdir } from "node:os";
import { run } from "../src/pipeline.js";
import { defaultThreads } from "../src/render/beauty-pool.js";

/**
 * A probe: a file an agent wrote to measure something, kept beside the
 * models but neither rendered nor listed. Agents name one plainly
 * (chess_nodes_probe.aix) or for what it measures (hub_probe_onebyone.aix),
 * and some are deliberate failures or reproduce a hang.
 */
export const PROBE = /_probe(_[^/]*)?\.aix$/;

export interface RenderSetOptions {
  /** Only these names (file names without .aix); empty for all. */
  only?: string[];
  /** Skip files whose name matches this (probes are kept next to the models but not rendered). */
  skip?: RegExp;
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
  // The beauty renders on the CLI's threads, which give the same bytes as one.
  const threads = defaultThreads();
  const files = programs(srcDir)
    .filter((f) => !opts.skip || !opts.skip.test(f))
    .filter((f) => !opts.only?.length || opts.only.includes(f.replace(/^.*\//, "").replace(/\.aix$/, "")) || opts.only.includes(f.replace(/\.aix$/, "").replace(/\//g, "_")));
  for (const file of files) {
    // A program in a subfolder keeps the folder in its render's name, so round-2/frog and round-3/frog do not collide.
    const name = file.replace(/\.aix$/, "").replace(/\//g, "_");
    // Each run writes into a folder of its own, made fresh and removed afterwards. A fixed name (aixle-<label>-<name>)
    // was the same in every worktree, so two render sets at once (two worktrees, or CI beside a local run) deleted or
    // copied each other's pictures.
    const tmp = mkdtempSync(join(tmpdir(), `aixle-${label}-${name}-`));
    try {
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
        threads,
        // lights.png is never copied into a render set, so it is not drawn.
        lights: false,
        steps: !opts.sheetAndBeautyOnly,
        slices: !opts.sheetAndBeautyOnly,
      });
      copyFileSync(join(tmp, "sheet.png"), join(outDir, `${name}.png`));
      if (!opts.sheetAndBeautyOnly) {
        copyFileSync(join(tmp, "slices.png"), join(outDir, `${name}_slices.png`));
        copyFileSync(join(tmp, "steps.png"), join(outDir, `${name}_steps.png`));
      }
      copyFileSync(join(tmp, "beauty.png"), join(outDir, `${name}_beauty.png`));
      const extras = readdirSync(tmp).filter((f) => f === "poses.png" || f.startsWith("anim_") || f.startsWith("beauty_"));
      for (const extra of extras) copyFileSync(join(tmp, extra), join(outDir, `${name}_${extra}`));
      // A pose sheet, strip or camera shot this program no longer writes goes too (round 11: the shot `set camera` names
      // is written once, as beauty.png, so its old beauty_<name>.png copy would have stayed behind).
      const kept = new Set(extras.map((e) => `${name}_${e}`));
      for (const old of readdirSync(outDir))
        if ((old === `${name}_poses.png` || old.startsWith(`${name}_anim_`) || old.startsWith(`${name}_beauty_`)) && !kept.has(old)) rmSync(join(outDir, old));
      const secs = ((performance.now() - t0) / 1000).toFixed(1);
      console.log(`${name.padEnd(10)} ${secs}s  ${result.warnings.length ? result.warnings.join(" | ") : "ok"}`);
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  }
}
