#!/usr/bin/env node
// Runs the compiled CLI when `npm run build` has produced dist/, and falls
// back to the TypeScript source through tsx in a checkout.
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const built = resolve(here, "../dist/cli.js");
if (existsSync(built)) {
  await import(built);
} else {
  const { register } = await import("tsx/esm/api");
  register();
  await import(resolve(here, "../src/cli.ts"));
}
