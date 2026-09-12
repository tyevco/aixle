/**
 * Render every example into examples/renders/ at a size that keeps the
 * repository small: the contact sheet, the cross-sections and the steps for
 * each. CI regenerates them and fails if the committed files differ, so a
 * change in a render always comes with the change that caused it.
 *
 *   npm run examples
 */
import { copyFileSync, mkdirSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { run } from "../src/pipeline.js";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const EXAMPLES = resolve(ROOT, "examples");
const OUT = resolve(EXAMPLES, "renders");
mkdirSync(OUT, { recursive: true });

const only = process.argv.slice(2);
const files = readdirSync(EXAMPLES)
  .filter((f) => f.endsWith(".aix"))
  .filter((f) => only.length === 0 || only.includes(f.replace(/\.aix$/, "")))
  .sort();

for (const file of files) {
  const name = file.replace(/\.aix$/, "");
  const tmp = join(tmpdir(), `aixle-example-${name}`);
  rmSync(tmp, { recursive: true, force: true });
  const t0 = performance.now();
  const result = run(readFileSync(join(EXAMPLES, file), "utf8"), `examples/${file}`, tmp, {
    grid: 112,
    size: 384,
    views: [],
    turntable: false,
    obj: false,
    glb: false,
  });
  copyFileSync(join(tmp, "sheet.png"), join(OUT, `${name}.png`));
  copyFileSync(join(tmp, "slices.png"), join(OUT, `${name}_slices.png`));
  copyFileSync(join(tmp, "steps.png"), join(OUT, `${name}_steps.png`));
  const secs = ((performance.now() - t0) / 1000).toFixed(1);
  console.log(`${name.padEnd(10)} ${secs}s  ${result.warnings.length ? result.warnings.join(" | ") : "ok"}`);
  rmSync(tmp, { recursive: true, force: true });
}
