import { describe, expect, it } from "vitest";
import { parseObj } from "../src/import/obj.js";
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
