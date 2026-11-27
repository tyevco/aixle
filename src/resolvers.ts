/**
 * What a program reads from outside itself: the libraries it `use`s, the pictures its materials name and the meshes
 * it imports. The pipeline evaluates with these, and so does each beauty-render worker, which builds the shape again
 * from the source; they live here rather than in pipeline.ts so a worker can load them without the whole pipeline.
 *
 * An import is sampled once, on the main thread. Its samples are recorded as they are made (or read from the cache),
 * and a worker evaluates from that record: it never samples a mesh again, never reads the import file and never
 * touches the disk cache, so its field is the main thread's to the bit.
 */
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseObj } from "./import/obj.js";
import { parseGlb } from "./import/glb.js";
import { fieldFromSamples, sampleMesh, type MeshSamples } from "./mesh/meshSdf.js";
import { importKey, type ImportCache } from "./import/cache.js";
import { primitive } from "./sdf/primitives.js";
import type { Shape3 } from "./sdf/types.js";
import { decodePng, type DecodedPng } from "./render/png.js";

// The report's number format (pipeline.ts has the same): three decimals, or three significant figures below 0.1.
const fmt = (v: number): string => {
  const s = Number.isInteger(v) ? String(v) : Math.abs(v) < 0.1 && Math.abs(v) >= 0.0005 ? String(Number(v.toPrecision(3))) : v.toFixed(3).replace(/0+$/, "").replace(/\.$/, "");
  return s === "-0" ? "0" : s;
};

/** The folder the shipped libraries live in: `std/` beside `src/` (and beside `dist/` once built). */
export const STD_DIR = resolve(dirname(fileURLToPath(import.meta.url)), "..", "std");

/** Load a PNG beside the program for material(image=) and decal(image=), once per file. */
export function imageResolver(sourceName: string) {
  const cache = new Map<string, DecodedPng>();
  return (path: string): DecodedPng => {
    const file = resolve(dirname(resolve(sourceName)), path);
    const hit = cache.get(file);
    if (hit) return hit;
    let data: Buffer;
    try {
      data = readFileSync(file);
    } catch {
      throw new Error(`cannot read ${file}`);
    }
    if (!/\.png$/i.test(file)) throw new Error(`${path} is not a PNG; pictures are PNG files`);
    const png = decodePng(data);
    cache.set(file, png);
    return png;
  };
}

/**
 * `use "path"` resolves relative to the program that uses it (or, for a
 * library's own uses, relative to that library), except `std/<name>`,
 * which is the library shipped with the tool; `.aix` may be left off.
 * Each file is read once per run.
 */
export function moduleResolver(sourceName: string) {
  const cache = new Map<string, { source: string; file: string }>();
  return (path: string, from?: string): { source: string; file: string } => {
    const withExt = path.endsWith(".aix") ? path : `${path}.aix`;
    const file = /^std\//.test(withExt) ? resolve(STD_DIR, withExt.slice(4)) : resolve(dirname(resolve(from ?? sourceName)), withExt);
    const hit = cache.get(file);
    if (hit) return hit;
    let source: string;
    try {
      source = readFileSync(file, "utf8");
    } catch {
      const std = existsSync(STD_DIR) ? readdirSync(STD_DIR).filter((f) => f.endsWith(".aix")).map((f) => `std/${f.replace(/\.aix$/, "")}`) : [];
      throw new Error(`cannot read ${file}${std.length ? `; the shipped libraries are ${std.join(", ")}` : ""}`);
    }
    const out = { source, file };
    cache.set(file, out);
    return out;
  };
}

/** Where an import's samples are recorded: the file, resolved beside the program, and the resolution it was sampled at. */
export function importSampleKey(sourceName: string, path: string, resolution: number): string {
  return `${resolve(dirname(resolve(sourceName)), path)}@${resolution}`;
}

/** An import's field from its samples: the same shape whether they were just made, read from the cache or replayed. */
function importShape(samples: MeshSamples): Shape3 {
  const field = fieldFromSamples(samples);
  const shape = primitive(field.dist, field.bounds, 8);
  shape.sampledAt = field.cell;
  // Trilinear samples of a distance: each axis's slope is at most 1, so the field's is at most sqrt(3).
  shape.lipschitz = Math.sqrt(3);
  return shape;
}

/**
 * Imports resolve relative to the source file's folder: OBJ or GLB, sampled into a field, once per file and
 * resolution in a run. With a cache, the samples are looked up by the file's content first and stored after
 * sampling, so a `check` and the `render` after it sample a large mesh once between them. With `record`, every
 * import's samples are kept there too, by importSampleKey, for the beauty render's workers (replayedImports).
 */
export function importResolver(sourceName: string, log: (line: string) => void = () => {}, cache?: ImportCache, record?: Map<string, MeshSamples>) {
  const memo = new Map<string, Shape3>();
  return (path: string, opts: { resolution: number }): Shape3 => {
    const file = resolve(dirname(resolve(sourceName)), path);
    const key = `${file}@${opts.resolution}`;
    const hit = memo.get(key);
    if (hit) return hit;
    let data: Buffer;
    try {
      data = readFileSync(file);
    } catch {
      throw new Error(`cannot read ${file}`);
    }
    const lower = file.toLowerCase();
    const format = lower.endsWith(".glb") ? "glb" : lower.endsWith(".obj") ? "obj" : undefined;
    if (!format) throw new Error(`only .obj and .glb files can be imported`);
    const t0 = performance.now();
    const cacheKey = cache ? importKey(data, format, opts.resolution) : undefined;
    let samples = cacheKey ? cache!.get(cacheKey) : undefined;
    const open = (s: MeshSamples) => (s.openness > 0.01 ? ` (mesh is not closed: ${(s.openness * 100).toFixed(0)}% of rays end inside)` : "");
    if (samples) log(`import ${path}: ${samples.triangles} triangles at cell ${fmt(samples.cell)}, read from the cache in ${Math.round(performance.now() - t0)} ms${open(samples)}`);
    else {
      const mesh = format === "glb" ? parseGlb(data) : parseObj(data.toString("utf8"));
      log(`import ${path}: sampling ${mesh.indices.length / 3} triangles at resolution ${opts.resolution}...`);
      samples = sampleMesh(mesh, opts.resolution);
      const notStored = cacheKey ? cache!.put(cacheKey, samples) : undefined;
      log(`import ${path}: ${samples.triangles} triangles sampled at cell ${fmt(samples.cell)} in ${Math.round(performance.now() - t0)} ms${open(samples)}${!cacheKey ? "" : notStored ? `; not cached: ${notStored}` : `; cached in ${cache!.dir}`}`);
    }
    record?.set(key, samples);
    const shape = importShape(samples);
    memo.set(key, shape);
    return shape;
  };
}

/**
 * The import resolver a worker evaluates with: each import is the samples the main thread recorded under its
 * importSampleKey, read-only. An import missing from the record (the program changed under the run) is an error,
 * never a fresh sampling, so a worker cannot build another field than the main thread's.
 */
export function replayedImports(sourceName: string, recorded: Map<string, MeshSamples>) {
  const memo = new Map<string, Shape3>();
  return (path: string, opts: { resolution: number }): Shape3 => {
    const key = importSampleKey(sourceName, path, opts.resolution);
    const hit = memo.get(key);
    if (hit) return hit;
    const samples = recorded.get(key);
    if (!samples) throw new Error(`import ${path} at resolution ${opts.resolution} was not sampled by the main evaluation`);
    const shape = importShape(samples);
    memo.set(key, shape);
    return shape;
  };
}
