import { describe, expect, it } from "vitest";
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseObj } from "../src/import/obj.js";
import { decodeSamples, diskCache, encodeSamples, importKey } from "../src/import/cache.js";
import { fieldFromSamples, sampleMesh } from "../src/mesh/meshSdf.js";
import { check, run } from "../src/pipeline.js";
import { parseGlb } from "../src/import/glb.js";
import { meshField } from "../src/mesh/meshSdf.js";
import { surfaceNets } from "../src/mesh/surfaceNets.js";
import { toGlb } from "../src/export/glb.js";
import { toObj } from "../src/export/obj.js";
import * as P from "../src/sdf/primitives.js";
import { parse } from "../src/lang/parser.js";
import { evaluate } from "../src/lang/interpreter.js";
import { primitive } from "../src/sdf/primitives.js";

const sphereMesh = surfaceNets(P.sphere(1), { resolution: 24 }).mesh;

describe("parsers", () => {
  it("reads an OBJ with polygons and negative indices", () => {
    const m = parseObj("v 0 0 0\nv 1 0 0\nv 1 1 0\nv 0 1 0\nf 1 2 3 4\nf -1 -2 -3\n");
    expect(m.positions.length).toBe(12);
    expect(Array.from(m.indices)).toEqual([0, 1, 2, 0, 2, 3, 3, 2, 1]);
    expect(() => parseObj("# nothing")).toThrow(/no triangles/);
  });
  it("reads back a GLB this tool wrote, and an OBJ too", () => {
    const glb = parseGlb(toGlb(sphereMesh, "s"));
    expect(glb.positions.length).toBe(sphereMesh.positions.length);
    expect(glb.indices.length).toBe(sphereMesh.indices.length);
    const obj = parseObj(toObj(sphereMesh, "s", "s.mtl").obj);
    expect(obj.positions.length).toBe(sphereMesh.positions.length);
    expect(obj.indices.length).toBe(sphereMesh.indices.length);
    expect(() => parseGlb(Buffer.from("nope"))).toThrow(/not a GLB/);
  });
});

describe("mesh field", () => {
  const field = meshField({ positions: sphereMesh.positions, indices: sphereMesh.indices }, 32);
  it("is a signed distance to the mesh: negative inside, about zero on it, positive outside", () => {
    expect(field.dist(0, 0, 0)).toBeLessThan(-0.8);
    expect(Math.abs(field.dist(1, 0, 0))).toBeLessThan(field.cell);
    expect(field.dist(2, 0, 0)).toBeGreaterThan(0.9);
    expect(field.dist(0, 5, 0)).toBeGreaterThan(3.5);
    expect(field.openness).toBeLessThan(0.01);
  });
  it("extracts back to a sphere of the right size", () => {
    const shape = primitive(field.dist, field.bounds, 1);
    const nets = surfaceNets(shape, { resolution: 24 });
    let maxR = 0, minR = Infinity;
    const p = nets.mesh.positions;
    for (let i = 0; i < p.length; i += 3) {
      const r = Math.hypot(p[i], p[i + 1], p[i + 2]);
      maxR = Math.max(maxR, r); minR = Math.min(minR, r);
    }
    expect(maxR).toBeLessThan(1.08);
    expect(minR).toBeGreaterThan(0.9);
  });
  it("reports an open mesh", () => {
    // One triangle: every ray through it crosses once.
    const open = meshField({ positions: new Float32Array([-1, -1, 0, 1, -1, 0, 0, 1, 0]), indices: new Uint32Array([0, 1, 2]) }, 8);
    expect(open.openness).toBeGreaterThan(0.1);
  });
});

describe("import in the language", () => {
  it("resolves through the injected resolver, with size scaling, and errors without one", () => {
    const resolver = (path: string) => {
      if (path !== "ball.obj") throw new Error("unknown file");
      return P.sphere(1);
    };
    const ev = evaluate(parse('a = import("ball.obj", size=4) | paint("red")\nshow a'), { resolveImport: resolver });
    expect(ev.output!.bounds.max[0]).toBeCloseTo(2);
    expect(ev.output!.hit(0, 0, 0).mat.name).toBe("red");
    expect(() => evaluate(parse('a = import("other.obj")'), { resolveImport: resolver })).toThrow(/import\("other.obj"\): unknown file/);
    expect(() => evaluate(parse('a = import("ball.obj")'))).toThrow(/cannot be imported here/);
    expect(() => evaluate(parse('a = import(3)'), { resolveImport: resolver })).toThrow(/file path/);
  });
});

describe("the import cache", () => {
  const samples = sampleMesh({ positions: sphereMesh.positions, indices: sphereMesh.indices }, 20);
  const probe = (f: (x: number, y: number, z: number) => number): number[] => {
    const out: number[] = [];
    for (let i = 0; i < 200; i++) out.push(f(Math.sin(i * 1.7) * 1.6, Math.cos(i * 0.9) * 1.4, Math.sin(i * 0.37 + 1) * 1.8));
    return out;
  };
  it("stores a sampled grid and reads back the same field to the bit", () => {
    const back = decodeSamples(encodeSamples(samples))!;
    expect(back.dims).toEqual(samples.dims);
    expect(Buffer.from(back.samples.buffer).equals(Buffer.from(samples.samples.buffer))).toBe(true);
    const a = fieldFromSamples(samples), b = fieldFromSamples(back);
    expect(probe(b.dist)).toEqual(probe(a.dist));
    expect(b.bounds).toEqual(a.bounds);
    expect([b.cell, b.triangles, b.openness]).toEqual([a.cell, a.triangles, a.openness]);
    // Anything else is a miss, not a wrong field.
    expect(decodeSamples(Buffer.from("AIXS nonsense"))).toBeUndefined();
    expect(decodeSamples(encodeSamples(samples).subarray(0, 500))).toBeUndefined();
  });
  it("keys an entry by the file's bytes, how it is read and the resolution", () => {
    const bytes = Buffer.from("v 0 0 0\n");
    const k = importKey(bytes, "obj", 96);
    expect(importKey(Buffer.from("v 0 0 0\n"), "obj", 96)).toBe(k);
    expect(importKey(bytes, "obj", 97)).not.toBe(k);
    expect(importKey(bytes, "glb", 96)).not.toBe(k);
    expect(importKey(Buffer.from("v 0 0 1\n"), "obj", 96)).not.toBe(k);
  });
  it("keeps entries on disk under its bound, the least recently used out first, and says why it could not store", () => {
    const dir = mkdtempSync(join(tmpdir(), "aixle-cache-"));
    try {
      const entry = encodeSamples(samples).length;
      const cache = diskCache(join(dir, "c"), entry * 2.5);
      expect(cache.get("a")).toBeUndefined();
      expect(cache.put("a", samples)).toBeUndefined();
      expect(cache.put("b", samples)).toBeUndefined();
      // a is older than b, but reading it makes it the recent one.
      const old = new Date(Date.now() - 60000);
      utimesSync(join(dir, "c", "a.samples"), old, old);
      utimesSync(join(dir, "c", "b.samples"), new Date(Date.now() - 30000), new Date(Date.now() - 30000));
      expect(cache.get("a")).toBeDefined();
      expect(cache.put("c", samples)).toBeUndefined();
      expect(readdirSync(join(dir, "c")).sort()).toEqual(["a.samples", "c.samples"]);
      // A damaged entry is a miss and is removed.
      writeFileSync(join(dir, "c", "c.samples"), "AIXS broken");
      expect(cache.get("c")).toBeUndefined();
      expect(existsSync(join(dir, "c", "c.samples"))).toBe(false);
      // Too big for the bound, or nowhere to write: not stored, and the reason says which.
      expect(diskCache(join(dir, "small"), 1000).put("a", samples)).toMatch(/over the cache's/);
      writeFileSync(join(dir, "file"), "not a folder");
      expect(diskCache(join(dir, "file", "sub")).put("a", samples)).toMatch(/cannot be written/);
      // The next folder is used when the first cannot be written.
      const fallback = diskCache([join(dir, "file", "sub"), join(dir, "second")]);
      expect(fallback.put("a", samples)).toBeUndefined();
      expect(fallback.dir).toBe(join(dir, "second"));
      expect(statSync(join(dir, "second", "a.samples")).size).toBe(entry);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
  it("gives check and render the same field and the same files with or without it", () => {
    const dir = mkdtempSync(join(tmpdir(), "aixle-cache-"));
    try {
      writeFileSync(join(dir, "ball.obj"), toObj(sphereMesh, "ball", "ball.mtl").obj);
      const src = 'b = import("ball.obj", size=2, resolution=24) | paint("red")\ncut = b - (box(3, 1, 3) | move(0, 1, 0))\nshow cut';
      writeFileSync(join(dir, "ball.aix"), src);
      const program = join(dir, "ball.aix");
      const cache = diskCache(join(dir, "cache"));
      const lines: string[] = [];
      const none = check(src, program);
      const cold = check(src, program, (l) => lines.push(l), undefined, undefined, false, cache);
      const warm = check(src, program, (l) => lines.push(l), undefined, undefined, false, cache);
      expect(lines.join("\n")).toMatch(/import ball.obj: \d+ triangles sampled at cell [\d.]+ in \d+ ms; cached in /);
      expect(lines.join("\n")).toMatch(/import ball.obj: \d+ triangles at cell [\d.]+, read from the cache in \d+ ms/);
      expect(readdirSync(join(dir, "cache")).length).toBe(1);
      expect(probe(warm.output!.dist)).toEqual(probe(none.output!.dist));
      expect(probe(cold.output!.dist)).toEqual(probe(none.output!.dist));
      const opts = { grid: 24, size: 96, views: [] as never[], steps: false, slices: false, turntable: false, callouts: false, viewer: false, texture: 64 };
      run(src, program, join(dir, "plain"), opts);
      run(src, program, join(dir, "cached"), { ...opts, importCache: cache });
      for (const f of ["sheet.png", "model.glb", "model.obj", "model.stl"]) expect(readFileSync(join(dir, "cached", f)).equals(readFileSync(join(dir, "plain", f))), f).toBe(true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
