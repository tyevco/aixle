/**
 * Render the dogfooding agents' programs into dogfood/renders/: the sheet
 * and the beauty render for each (the probes, named *_probe.aix or
 * *_probe_<what>.aix, are kept but not rendered). The programs are the agents' own, unchanged, so they
 * double as a regression suite: one that stops rendering is a bug.
 *
 *   npm run dogfood              all of them
 *   npm run dogfood -- frog      a few
 */
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { PROBE, renderSet } from "./render-set.js";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
renderSet(resolve(ROOT, "dogfood"), resolve(ROOT, "dogfood", "renders"), "dogfood", {
  only: process.argv.slice(2),
  skip: PROBE,
  sheetAndBeautyOnly: true,
});
