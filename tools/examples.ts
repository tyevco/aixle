/**
 * Render every example into examples/renders/: the contact sheet, the
 * cross-sections, the steps and the beauty render for each.
 *
 *   npm run examples            all of them
 *   npm run examples -- mug     a few
 */
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { renderSet } from "./render-set.js";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
renderSet(resolve(ROOT, "examples"), resolve(ROOT, "examples", "renders"), "example", { only: process.argv.slice(2) });
