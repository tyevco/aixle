/**
 * The import cache: a sampled mesh kept on disk, so `check` and `render`
 * (and every later run, and every program that imports the same file at
 * the same resolution) sample a large mesh once between them.
 *
 * An entry is keyed by a hash of the file's bytes, the way it is read (OBJ
 * or GLB), the resolution and the sampler's version, which is everything
 * that decides the samples: a file edited in place, renamed or copied is
 * keyed by what it holds, not where it is. The entry is the grid exactly
 * as the sampler made it (float32 samples, the origin and cell as
 * doubles), so a field read back from the cache is the same field to the
 * bit, and so are the renders made from it.
 *
 * This is the file-system side. The sampler in `src/mesh` stays pure; the
 * pipeline's import resolver takes a cache, or none, as it is given.
 */
import { createHash } from "node:crypto";
import { mkdirSync, readdirSync, readFileSync, renameSync, statSync, unlinkSync, utimesSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { SAMPLER_VERSION, type MeshSamples } from "../mesh/meshSdf.js";

export interface ImportCache {
  /** The samples stored under this key, or undefined. Never throws: a cache that cannot be read is a miss. */
  get(key: string): MeshSamples | undefined;
  /** Store samples under the key: undefined once stored, else why not (no folder can be written, or over the bound). */
  put(key: string, samples: MeshSamples): string | undefined;
  /** The folder entries are kept in, for the log. */
  readonly dir: string;
}

/** The cache is kept under this many bytes in all; the least recently used entries go first. */
export const CACHE_BYTES = 512 * 1024 * 1024;

const MAGIC = "AIXS";
const LAYOUT = 1;
const HEADER = 128;

/** The key for a file's samples: its bytes, how they are read, the resolution and the sampler's version. */
export function importKey(data: Uint8Array, format: "obj" | "glb", resolution: number): string {
  const h = createHash("sha256");
  h.update(`aixle import samples ${SAMPLER_VERSION} ${format} ${resolution}\n`);
  h.update(data);
  return h.digest("hex");
}

/** An entry's bytes: a fixed header, then the samples as float32 in this machine's byte order (which the header records). */
export function encodeSamples(s: MeshSamples): Buffer {
  const n = s.dims[0] * s.dims[1] * s.dims[2];
  const buf = Buffer.alloc(HEADER + n * 4);
  buf.write(MAGIC, 0, "ascii");
  buf.writeUInt32LE(LAYOUT, 4);
  buf.writeUInt32LE(s.dims[0], 8); buf.writeUInt32LE(s.dims[1], 12); buf.writeUInt32LE(s.dims[2], 16);
  buf.writeUInt32LE(s.triangles, 20);
  const f64 = [...s.origin, s.cell, s.openness, ...s.bounds.min, ...s.bounds.max];
  f64.forEach((v, i) => buf.writeDoubleLE(v, 24 + i * 8));
  // 1.0 as the samples store it: a machine of the other byte order reads it as something else and misses.
  Buffer.from(new Float32Array([1]).buffer).copy(buf, 24 + f64.length * 8);
  Buffer.from(s.samples.buffer, s.samples.byteOffset, s.samples.byteLength).copy(buf, HEADER);
  return buf;
}

export function decodeSamples(buf: Buffer): MeshSamples | undefined {
  if (buf.length < HEADER || buf.toString("ascii", 0, 4) !== MAGIC || buf.readUInt32LE(4) !== LAYOUT) return undefined;
  const dims: [number, number, number] = [buf.readUInt32LE(8), buf.readUInt32LE(12), buf.readUInt32LE(16)];
  const n = dims[0] * dims[1] * dims[2];
  if (buf.length !== HEADER + n * 4) return undefined;
  const f64 = Array.from({ length: 11 }, (_, i) => buf.readDoubleLE(24 + i * 8));
  const one = new Float32Array(1);
  Buffer.from(one.buffer).set(buf.subarray(24 + 11 * 8, 24 + 11 * 8 + 4));
  if (one[0] !== 1) return undefined;
  const samples = new Float32Array(n);
  Buffer.from(samples.buffer).set(buf.subarray(HEADER));
  return {
    samples,
    dims,
    origin: [f64[0], f64[1], f64[2]],
    cell: f64[3],
    openness: f64[4],
    bounds: { min: [f64[5], f64[6], f64[7]], max: [f64[8], f64[9], f64[10]] },
    triangles: buf.readUInt32LE(20),
  };
}

/**
 * Where the cache lives: `AIXLE_CACHE_DIR` when set, else the user's cache folder (`$XDG_CACHE_HOME/aixle/imports`,
 * or `~/.cache/aixle/imports`), else the system's temporary folder when the home folder cannot be written.
 */
export function cacheDirs(): string[] {
  const env = process.env.AIXLE_CACHE_DIR;
  if (env) return [env];
  const xdg = process.env.XDG_CACHE_HOME;
  return [join(xdg && xdg.startsWith("/") ? xdg : join(homedir(), ".cache"), "aixle", "imports"), join(tmpdir(), "aixle", "imports")];
}

/** The cache on disk, in the first of `dirs` that can be written, kept under `maxBytes`. */
export function diskCache(dirs: string | string[] = cacheDirs(), maxBytes = CACHE_BYTES): ImportCache {
  const candidates = typeof dirs === "string" ? [dirs] : dirs;
  let at = 0;
  const file = (key: string) => join(candidates[at], `${key}.samples`);
  const evict = (dir: string) => {
    const entries: { path: string; size: number; time: number }[] = [];
    let total = 0;
    for (const name of readdirSync(dir)) {
      const path = join(dir, name);
      let st;
      try { st = statSync(path); } catch { continue; }
      // A write that never finished (a run killed mid-write) is removed once it is clearly abandoned.
      if (name.endsWith(".tmp")) { if (Date.now() - st.mtimeMs > 10 * 60 * 1000) try { unlinkSync(path); } catch { /* gone */ } continue; }
      if (!name.endsWith(".samples")) continue;
      entries.push({ path, size: st.size, time: st.mtimeMs });
      total += st.size;
    }
    entries.sort((a, b) => a.time - b.time);
    for (const e of entries) {
      if (total <= maxBytes) break;
      try { unlinkSync(e.path); total -= e.size; } catch { /* another run took it */ }
    }
  };
  return {
    get dir() { return candidates[at]; },
    get(key) {
      for (let i = at; i < candidates.length; i++) {
        const path = join(candidates[i], `${key}.samples`);
        let buf: Buffer;
        try { buf = readFileSync(path); } catch { continue; }
        const s = decodeSamples(buf);
        if (!s) { try { unlinkSync(path); } catch { /* read-only */ } continue; }
        // Used now: the eviction keeps what is read, not only what was written lately.
        try { const now = new Date(); utimesSync(path, now, now); } catch { /* read-only is fine */ }
        return s;
      }
      return undefined;
    },
    put(key, samples) {
      const bytes = HEADER + samples.samples.length * 4;
      if (bytes > maxBytes) return `${Math.round(bytes / 1024 / 1024)} MB of samples is over the cache's ${Math.round(maxBytes / 1024 / 1024)} MB`;
      const data = encodeSamples(samples);
      for (; at < candidates.length; at++) {
        const dir = candidates[at];
        // Written beside its place and renamed into it, so a reader never sees half an entry.
        const tmp = join(dir, `${key}.${process.pid}.tmp`);
        try {
          mkdirSync(dir, { recursive: true });
          writeFileSync(tmp, data);
          renameSync(tmp, file(key));
        } catch {
          try { unlinkSync(tmp); } catch { /* never written */ }
          continue;
        }
        try { evict(dir); } catch { /* the entry is written; a failed sweep waits for the next */ }
        return undefined;
      }
      at = candidates.length - 1;
      return `${candidates.join(" and ")} cannot be written`;
    },
  };
}
