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
import { renderSet } from "./render-set.js";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
renderSet(resolve(ROOT, "dogfood"), resolve(ROOT, "dogfood", "renders"), "dogfood", {
  only: process.argv.slice(2),
  // An agent names a probe for what it measures (hub_probe_onebyone.aix) as
  // often as plainly (chess_nodes_probe.aix); both are probes, and some are
  // deliberate failures or a reproduction of a hang, so none are rendered.
  skip: /_probe(_[^/]*)?\.aix$/,
  sheetAndBeautyOnly: true,
});
