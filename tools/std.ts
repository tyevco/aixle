/**
 * Render every shipped library's plate into std/renders/: the sheet and
 * the beauty render of the `show` at the bottom of each std/*.aix, which
 * is the library's own test. CI regenerates and diffs them like the
 * examples, so a library part that stops rendering is a regression.
 *
 *   npm run std              all of them
 *   npm run std -- hardware  one
 */
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { renderSet } from "./render-set.js";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
renderSet(resolve(ROOT, "std"), resolve(ROOT, "std", "renders"), "std", { only: process.argv.slice(2), sheetAndBeautyOnly: true });
