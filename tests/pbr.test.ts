import { describe, expect, it } from "vitest";
import * as P from "../src/sdf/primitives.js";
import * as O from "../src/sdf/ops.js";
import * as S from "../src/sdf/shapes2d.js";
import * as W from "../src/sdf/sweeps.js";
import { surfaceNets } from "../src/mesh/surfaceNets.js";
import { albedo, bumpSlope, customMaterial, fieldCurvature, preset, surface } from "../src/sdf/materials.js";
import { bakeAtlas, chartTangent, type AtlasResult } from "../src/export/atlas.js";
import { buildHierarchy } from "../src/export/hierarchy.js";
import { toGlbScene } from "../src/export/glb.js";
import { renderBeauty } from "../src/render/beauty.js";
import { evaluate } from "../src/lang/interpreter.js";
import { parse } from "../src/lang/parser.js";
import type { Shape3 } from "../src/sdf/types.js";

const deg = (c: number) => (Math.acos(Math.max(-1, Math.min(1, c))) * 180) / Math.PI;
const glbJson = (glb: Buffer) => JSON.parse(glb.toString("utf8", 20, 20 + glb.readUInt32LE(12)));

/** Bake a shape's mesh with its own field, the way the hierarchy does. */
function bake(shape: Shape3, cell: number, size = 512): AtlasResult {
  const b = shape.bounds;
  const longest = Math.max(b.max[0] - b.min[0], b.max[1] - b.min[1], b.max[2] - b.min[2]);
  const mesh = surfaceNets(shape, { resolution: Math.ceil(longest / cell) }).mesh;
  return bakeAtlas(mesh, { size, fields: [{ range: [0, mesh.indices.length / 3], dist: shape.dist, offset: [0, 0, 0], relief: O.reliefMaterials(shape) }], cellSize: cell });
}

/**
 * Every texel centre that falls inside a triangle (the one under each triangle's centroid), with its world point
 * and the normal the normal map gives there, decoded through the tangent frame an engine builds from the
 * vertices: tangent and bitangent (cross(N, T) * w per vertex) interpolated, as three.js does.
 */
function decodedTexels(at: AtlasResult): { p: number[]; n: number[]; mesh: number[]; mat: number; t: number }[] {
  const M = at.mesh, T = at.tangents!, uv = at.uv, img = at.normal!, size = img.width;
  const out: { p: number[]; n: number[]; mesh: number[]; mat: number; t: number }[] = [];
  const bit = (v: number) => {
    const n = [M.normals[v * 3], M.normals[v * 3 + 1], M.normals[v * 3 + 2]], t = [T[v * 4], T[v * 4 + 1], T[v * 4 + 2]];
    const b = [n[1] * t[2] - n[2] * t[1], n[2] * t[0] - n[0] * t[2], n[0] * t[1] - n[1] * t[0]];
    const l = Math.hypot(b[0], b[1], b[2]) || 1;
    return b.map((x) => (x / l) * T[v * 4 + 3]);
  };
  const unit = (v: number[]) => { const l = Math.hypot(v[0], v[1], v[2]) || 1; return v.map((x) => x / l); };
  for (let t = 0; t < M.indices.length / 3; t++) {
    const [a, b, c] = [M.indices[t * 3], M.indices[t * 3 + 1], M.indices[t * 3 + 2]];
    const ax = uv[a * 2] * size, ay = uv[a * 2 + 1] * size, bx = uv[b * 2] * size, by = uv[b * 2 + 1] * size, cx = uv[c * 2] * size, cy = uv[c * 2 + 1] * size;
    const px = Math.floor((ax + bx + cx) / 3), py = Math.floor((ay + by + cy) / 3);
    const xx = px + 0.5, yy = py + 0.5;
    const area = (bx - ax) * (cy - ay) - (by - ay) * (cx - ax);
    if (Math.abs(area) < 1e-9) continue;
    const w0 = ((bx - xx) * (cy - yy) - (by - yy) * (cx - xx)) / area, w1 = ((cx - xx) * (ay - yy) - (cy - yy) * (ax - xx)) / area, w2 = 1 - w0 - w1;
    if (w0 < 0.05 || w1 < 0.05 || w2 < 0.05) continue;
    const lerp = (arr: ArrayLike<number>, stride: number) => [0, 1, 2].map((k) => arr[a * stride + k] * w0 + arr[b * stride + k] * w1 + arr[c * stride + k] * w2);
    const Tn = unit(lerp(T, 4)), Nn = unit(lerp(M.normals, 3));
    const ba = bit(a), bb = bit(b), bc = bit(c);
    const Bn = unit([0, 1, 2].map((k) => ba[k] * w0 + bb[k] * w1 + bc[k] * w2));
    const px4 = (py * size + px) * 4;
    const m = [img.data[px4], img.data[px4 + 1], img.data[px4 + 2]].map((x) => (x / 255) * 2 - 1);
    const n = unit([0, 1, 2].map((k) => Tn[k] * m[0] + Bn[k] * m[1] + Nn[k] * m[2]));
    out.push({ p: lerp(M.positions, 3), n, mesh: Nn, mat: M.materialIndex[a], t });
  }
  return out;
}

describe("surface and curvature", () => {
  it("is exactly albedo and the material's own fields for a plain material", () => {
    for (const name of ["oak", "marble", "gold", "brick"]) {
      const m = preset(name)!;
      const s = surface(m, 0.31, 0.72, -0.4, 0.8);
      expect(s.color).toEqual(albedo(m, 0.31, 0.72, -0.4));
      expect([s.rough, s.metal, s.glow, s.height]).toEqual([m.rough, m.metal, m.glow, 0]);
    }
  });
  it("reads h/R on a sphere, 0 on a flat face, about +1 on a convex edge and -1 in a crease", () => {
    expect(fieldCurvature(P.sphere(1).dist, 1, 0, 0, 0.05)).toBeCloseTo(0.05, 3);
    const box = P.box(2, 2, 2);
    expect(fieldCurvature(box.dist, 0.2, 1, 0.3, 0.05)).toBeCloseTo(0, 6);
    expect(fieldCurvature(box.dist, 1, 1, 0.3, 0.05)).toBeGreaterThan(0.9);
    // An L: a crease where the top of the low box meets the side of the tall one.
    const ell = O.union([P.box(2, 1, 2), O.move(P.box(1, 2, 2), -0.5, 0.5, 0)]);
    expect(fieldCurvature(ell.dist, 0, 0.5, 0.3, 0.05)).toBeLessThan(-0.9);
  });
  it("reads a smooth blend's fillet as concave and a loft's flat side as flat, from fields that are bounds", () => {
    // Two spheres blended: the fillet in the waist between them is a saddle, concave across the blend.
    const blend = O.union([O.move(P.sphere(1), -0.9, 0, 0), O.move(P.sphere(1), 0.9, 0, 0)], 0.5);
    const waist = O.surfacePoint(blend, 0, 2, 0);
    expect(fieldCurvature(blend.dist, waist[0], waist[1], waist[2], 0.05)).toBeLessThan(-0.02);
    // A loft from a square to a smaller square: its sides are flat, though the field is a blend of two distances.
    const loft = W.loft(S.rect(2, 2), S.rect(1, 1), 2);
    const side = O.surfacePoint(loft, 2, 0, 0.1);
    expect(Math.abs(fieldCurvature(loft.dist, side[0], side[1], side[2], 0.05))).toBeLessThan(0.02);
  });
  it("wears a convex edge lighter and smoother, and darkens a crease", () => {
    const iron = customMaterial({ color: [0.36, 0.37, 0.38], metal: 1, rough: 0.6, wear: 0.5 });
    const face = surface(iron, 0, 0, 0, 0), edge = surface(iron, 0, 0, 0, 1), crease = surface(iron, 0, 0, 0, -1);
    expect(edge.color[0]).toBeGreaterThan(face.color[0] + 0.1);
    expect(edge.rough).toBeLessThan(face.rough);
    expect(crease.color[0]).toBeLessThan(face.color[0] - 0.05);
    expect(crease.rough).toBeGreaterThan(face.rough);
    expect(face.color).toEqual(albedo(iron, 0, 0, 0));
  });
  it("rubs a metal's edge to satin, short of bare polished iron, and leaves a non-metal's edge as it was", () => {
    const iron = { ...preset("iron")!, wear: 0.5 };
    const lin = (c: number) => Math.pow((c + 0.055) / 1.055, 2.4);
    const edge = surface(iron, 0, 0, 0, 1);
    // Brighter and smoother than the dark iron, but well short of bare iron's 0.56 and out of the glossy band.
    expect(edge.color[0]).toBeGreaterThan(iron.color[0] + 0.1);
    expect(lin(edge.color[0])).toBeLessThan(0.4);
    expect(edge.rough).toBeLessThan(iron.rough);
    expect(edge.rough).toBeGreaterThan(0.42);
    expect(edge.metal).toBe(1);
    // A non-metal's worn edge goes 35% of the way to white and loses 55% of its roughness times the edge, as before;
    // the probe and the thinness are a metal's and change nothing on it.
    const oak = { ...preset("oak")!, wear: 0.5 }, a = albedo(oak, 0.1, 0.2, 0.3), e = 0.85;
    const worn = surface(oak, 0.1, 0.2, 0.3, 1, 0.05, 1);
    expect(worn).toEqual(surface(oak, 0.1, 0.2, 0.3, 1));
    for (let k = 0; k < 3; k++) expect(worn.color[k]).toBeCloseTo(a[k] + (a[k] + (1 - a[k]) * 0.35 - a[k]) * e, 12);
    expect(worn.rough).toBeCloseTo(oak.rough * (1 - 0.55 * e), 12);
  });
  it("tells a part thinner than two probes from a thick part's sharp edge, at one more call", () => {
    const h = 0.04, thin = new Float64Array(1);
    let calls = 0;
    const counted = (d: (x: number, y: number, z: number) => number) => (x: number, y: number, z: number) => { calls++; return d(x, y, z); };
    // A bar 1.5 probes thick (the lantern's) reads as convex as an edge all round: only its thinness tells it apart.
    const bar = P.cylinder(0.03, 2);
    const c = fieldCurvature(counted(bar.dist), 0.03, 0.2, 0, h, thin);
    expect(calls).toBe(10);
    expect(c).toBeGreaterThan(0.6);
    expect(thin[0]).toBe(1);
    calls = 0;
    expect(fieldCurvature(counted(bar.dist), 0.03, 0.2, 0, h)).toBe(c);
    expect(calls).toBe(9);
    // A box's edge, a hair in from it, and a post 2.5 probes thick at its corner: thick, however sharp.
    expect(fieldCurvature(P.box(1, 1, 1).dist, 0.5, 0.49, 0.1, h, thin)).toBeGreaterThan(0.9);
    expect(thin[0]).toBe(0);
    expect(fieldCurvature(P.box(0.1, 2, 0.1).dist, 0.05, 0.3, 0.045, h, thin)).toBeGreaterThan(0.9);
    expect(thin[0]).toBe(0);
    // The door's ring knocker: a tube 0.016 round at its probe of 0.0294.
    expect(fieldCurvature(P.torus(0.09, 0.016).dist, 0.106, 0, 0, 0.0294, thin)).toBeGreaterThan(0.6);
    expect(thin[0]).toBe(1);
  });
  it("keeps most of a thin worn bar at the metal's own colour and roughness, where it was rubbed bright all round", () => {
    // The lantern's bars: radius 0.03 at a probe of 0.04 (1.2% of 3.38), worn 0.45.
    const iron = { ...preset("iron")!, wear: 0.45 }, plain = { ...iron, wear: 0 };
    const bar = P.cylinder(0.03, 2), h = 0.04, thin = new Float64Array(1);
    let own = 0, rubbed = 0, n = 0;
    for (let i = 0; i < 40; i++) for (let k = 0; k < 12; k++) {
      const a = (k / 12) * 2 * Math.PI, x = 0.03 * Math.cos(a), y = -0.8 + i * 0.04, z = 0.03 * Math.sin(a);
      const c = fieldCurvature(bar.dist, x, y, z, h, thin);
      const s = surface(iron, x, y, z, c, h, thin[0]);
      n++;
      if (Math.abs(s.color[0] - iron.color[0]) < 0.02 && Math.abs(s.rough - iron.rough) < 0.02) own++;
      if (s.color[0] > iron.color[0] + 0.08) rubbed++;
      // Unworn, the same bar is the metal's own surface everywhere.
      const p = surface(plain, x, y, z, c, h, thin[0]);
      expect([p.color, p.rough, p.metal]).toEqual([iron.color, iron.rough, iron.metal]);
    }
    expect(own / n).toBeGreaterThan(0.55);
    // Still worn: rubbed patches along it, not none.
    expect(rubbed / n).toBeGreaterThan(0.1);
  });
  it("breaks a thick part's worn edge into scuffs: most of it rubbed lighter, not all, and the faces untouched", () => {
    const iron = { ...preset("iron")!, wear: 0.45 };
    const box = P.box(1, 1, 1), h = 0.04, thin = new Float64Array(1);
    let lighter = 0, n = 0;
    for (let i = 0; i < 200; i++) {
      // Along the box's top front edge, a hair in on the top face.
      const x = -0.45 + i * 0.0045, y = 0.5, z = 0.49;
      const c = fieldCurvature(box.dist, x, y, z, h, thin);
      expect(thin[0]).toBe(0);
      const s = surface(iron, x, y, z, c, h, thin[0]);
      n++;
      if (s.color[0] > iron.color[0] + 0.05) lighter++;
      // The middle of the face is not worn at all.
      const f = surface(iron, x, 0.5, 0, fieldCurvature(box.dist, x, 0.5, 0, h, thin), h, thin[0]);
      expect(f.color).toEqual(iron.color);
    }
    expect(lighter / n).toBeGreaterThan(0.4);
    expect(lighter / n).toBeLessThan(0.9);
  });
  it("eats rust into a metal: rough and not metal in the patches, and wear rubs them off an edge", () => {
    const rust = preset("rust")!;
    let minMetal = 1, maxMetal = 0, rubbed = 0, n = 0;
    for (let i = 0; i < 400; i++) {
      const x = (i % 20) * 0.071, y = Math.floor(i / 20) * 0.067;
      const s = surface(rust, x, y, 0.2);
      minMetal = Math.min(minMetal, s.metal); maxMetal = Math.max(maxMetal, s.metal);
      if (s.metal < 0.5) { n++; if (surface({ ...rust, wear: 1 }, x, y, 0.2, 1).metal > 0.9) rubbed++; }
    }
    expect(minMetal).toBeLessThan(0.1);
    expect(maxMetal).toBe(1);
    expect(n).toBeGreaterThan(20);
    expect(rubbed).toBe(n);
  });
  it("keeps a bump's slope when the part is scaled after painting: its height and its size scale together", () => {
    // A world unit moves the paint frame's point 1/s for a part scaled by s; the bumps are the same bumps, scaled.
    const m = customMaterial({ color: [0.8, 0.8, 0.8], bump: 0.01, bumpScale: 0.1 });
    const at = (k: number) => bumpSlope(m, 0.6, -0.2, 0.1, [k, 0, 0], [0, 0, k]);
    const one = at(1);
    expect(Math.hypot(one[0], one[1])).toBeGreaterThan(0.01);
    for (const s of [0.1, 0.5, 4]) {
      const scaled = at(1 / s);
      expect(scaled[0]).toBeCloseTo(one[0], 6);
      expect(scaled[1]).toBeCloseTo(one[1], 6);
    }
    // Turned as well as scaled: the slope along each world direction is the slope along the frame's.
    const turned = bumpSlope(m, 0.6, -0.2, 0.1, [0, 0, 2], [-2, 0, 0]);
    const plain = bumpSlope(m, 0.6, -0.2, 0.1, [0, 0, 1], [-1, 0, 0]);
    expect(turned[0]).toBeCloseTo(plain[0], 6);
    expect(turned[1]).toBeCloseTo(plain[1], 6);
  });
  it("takes bump, bump_scale and wear in material(), and says what is wrong", () => {
    const ev = evaluate(parse('m = material("iron", wear=0.4, bump=0.01)\nn = material("#808080", "rust", bump=0.02, bump_scale=0.3)\nshow box(1) | paint(m)'));
    const m = ev.steps.find((s) => s.name === "m")!.value as ReturnType<typeof preset>;
    expect(m!.wear).toBe(0.4);
    expect(m!.bump).toBe(0.01);
    expect(m!.metal).toBe(1);
    const n = ev.steps.find((s) => s.name === "n")!.value as ReturnType<typeof preset>;
    expect(n!.pattern).toBe("rust");
    expect(n!.bumpScale).toBe(0.3);
    expect(n!.color2).not.toEqual(n!.color);
    expect(() => evaluate(parse('m = material("iron", wear=2)'))).toThrow(/wear is 0/);
    expect(() => evaluate(parse('m = material("iron", bump=-1)'))).toThrow(/bump is a height/);
  });
});

describe("normal map", () => {
  it("gives the ±y charts, whose projection is mirrored, a handedness of -1 and the others +1", () => {
    const axes: [number, number, number][] = [[1, 0, 0], [-1, 0, 0], [0, 1, 0], [0, -1, 0], [0, 0, 1], [0, 0, -1]];
    expect(axes.map((n, i) => chartTangent(i, n[0], n[1], n[2])[3])).toEqual([1, 1, -1, -1, 1, 1]);
    // The tangent lies across the normal even for a vertex leaning off its chart's axis.
    const t = chartTangent(4, 0.3, 0.2, Math.sqrt(1 - 0.13));
    expect(Math.abs(t[0] * 0.3 + t[1] * 0.2 + t[2] * Math.sqrt(1 - 0.13))).toBeLessThan(1e-9);
  });
  // The box is a displace of no height, so its texels go through the field like any relief's, and come out flat.
  const plainAndBumped = O.union([O.paint(O.displace(P.box(1.2, 1.2, 1.2), 0, 1), preset("plastic")!), O.paint(O.move(P.sphere(0.4), 1.4, 0, 0), customMaterial({ color: [0.8, 0.8, 0.8], bump: 0.02, bumpScale: 0.15 }))]);
  const at = bake(plainAndBumped, 0.04);
  it("bakes a flat face to (128, 128, 255)", () => {
    expect(at.normal).toBeDefined();
    const plain = at.mesh.materials.findIndex((m) => m.name === "plastic");
    let flat = 0, n = 0;
    for (const tx of decodedTexels(at)) {
      // Where the mesh is the face: near a corner the dual-contoured mesh leans by up to a degree or two, and the map
      // encodes the correction (a lean of 0.06 degrees already crosses from 128 to 127).
      if (tx.mat !== plain || tx.mesh.filter((v) => Math.abs(v) > 1e-4).length !== 1) continue;
      n++;
      const img = at.normal!, size = img.width;
      const uv = at.uv, M = at.mesh;
      const [a, b, c] = [M.indices[tx.t * 3], M.indices[tx.t * 3 + 1], M.indices[tx.t * 3 + 2]];
      const px = Math.floor(((uv[a * 2] + uv[b * 2] + uv[c * 2]) / 3) * size), py = Math.floor(((uv[a * 2 + 1] + uv[b * 2 + 1] + uv[c * 2 + 1]) / 3) * size);
      if (img.get(px, py) === 0x8080ff) flat++;
    }
    expect(n).toBeGreaterThan(100);
    expect(flat).toBe(n);
  });
  it("decodes a bump through the tangents to the field's normal tilted by the bump's slope, on every chart", () => {
    const bumpy = customMaterial({ color: [0.8, 0.8, 0.8], bump: 0.015, bumpScale: 0.12 });
    const cube = O.paint(P.box(1.2, 1.2, 1.2), bumpy);
    const cubeAt = bake(cube, 0.04);
    const errors: number[] = [];
    const byAxis = new Map<string, number>();
    for (const tx of decodedTexels(cubeAt)) {
      const [x, y, z] = tx.p;
      // Away from the edges, the face's normal is an axis; tilt it by the slope along two tangents, the beauty render's way.
      const k = [0, 1, 2].reduce((best, i) => (Math.abs(tx.p[i]) > Math.abs(tx.p[best]) ? i : best), 0);
      if ([0, 1, 2].some((i) => i !== k && Math.abs(tx.p[i]) > 0.5)) continue;
      const n = [0, 0, 0]; n[k] = Math.sign(tx.p[k]);
      const t1 = [0, 0, 0], t2 = [0, 0, 0]; t1[(k + 1) % 3] = 1; t2[(k + 2) % 3] = 1;
      const [s1, s2] = bumpSlope(bumpy, x, y, z, t1 as [number, number, number], t2 as [number, number, number]);
      const want = [0, 1, 2].map((i) => n[i] - s1 * t1[i] - s2 * t2[i]);
      const l = Math.hypot(want[0], want[1], want[2]);
      errors.push(deg((want[0] * tx.n[0] + want[1] * tx.n[1] + want[2] * tx.n[2]) / l));
      const axis = `${k}${n[k] > 0 ? "+" : "-"}`;
      byAxis.set(axis, (byAxis.get(axis) ?? 0) + 1);
    }
    expect(byAxis.size).toBe(6);
    errors.sort((a, b) => a - b);
    expect(errors[Math.floor(errors.length * 0.95)]).toBeLessThan(2);
    expect(errors[errors.length - 1]).toBeLessThan(5);
  });
  it("bakes a bumped part scaled after painting like the same part built at that size", () => {
    // Built at twice the size and halved, against built at size: the same bumps, so the same tilt off the mesh.
    const tilt = (shape: Shape3): number => {
      const tx = decodedTexels(bake(shape, 0.03, 256));
      return tx.reduce((s, t) => s + deg(t.n[0] * t.mesh[0] + t.n[1] * t.mesh[1] + t.n[2] * t.mesh[2]), 0) / tx.length;
    };
    const atSize = tilt(O.paint(P.sphere(0.5), customMaterial({ color: [0.8, 0.8, 0.8], bump: 0.01, bumpScale: 0.1 })));
    const halved = tilt(O.scale(O.paint(P.sphere(1), customMaterial({ color: [0.8, 0.8, 0.8], bump: 0.02, bumpScale: 0.2 })), 0.5, 0.5, 0.5));
    expect(atSize).toBeGreaterThan(2);
    expect(Math.abs(halved / atSize - 1)).toBeLessThan(0.1);
  });
  it("decodes a displace finer than the mesh to the field's gradient", () => {
    const rough = O.displace(P.box(1.2, 1.2, 1.2, 0.1), 0.012, 0.1);
    const roughAt = bake(rough, 0.03);
    expect(roughAt.normalStats!.written).toBe(true);
    const errors: number[] = [], meshErrors: number[] = [];
    const d = rough.dist, e = 0.0005;
    for (const tx of decodedTexels(roughAt)) {
      // The field's surface under the texel, along the mesh's normal, and its gradient there.
      let t = 0;
      for (let i = 0; i < 6; i++) t -= d(tx.p[0] + tx.mesh[0] * t, tx.p[1] + tx.mesh[1] * t, tx.p[2] + tx.mesh[2] * t);
      const [x, y, z] = [0, 1, 2].map((k) => tx.p[k] + tx.mesh[k] * t);
      const g = [d(x + e, y, z) - d(x - e, y, z), d(x, y + e, z) - d(x, y - e, z), d(x, y, z + e) - d(x, y, z - e)];
      const gl = Math.hypot(g[0], g[1], g[2]);
      errors.push(deg((g[0] * tx.n[0] + g[1] * tx.n[1] + g[2] * tx.n[2]) / gl));
      meshErrors.push(deg((g[0] * tx.mesh[0] + g[1] * tx.mesh[1] + g[2] * tx.mesh[2]) / gl));
    }
    errors.sort((a, b) => a - b); meshErrors.sort((a, b) => a - b);
    const median = (v: number[]) => v[Math.floor(v.length / 2)];
    // The mesh alone is several degrees off; the decoded map is within its quantisation and the one-sided probe.
    expect(median(meshErrors)).toBeGreaterThan(4);
    expect(median(errors)).toBeLessThan(1.5);
    expect(errors[Math.floor(errors.length * 0.9)]).toBeLessThan(4);
  });
  it("bakes only the displaced material's texels: a plain part beside it stays flat and reads no map", () => {
    const leaf = customMaterial({ name: "leaf", color: [0.3, 0.6, 0.2] });
    const both = O.union([O.paint(O.displace(P.sphere(0.6), 0.03, 0.12), leaf), O.paint(O.move(P.box(1, 1, 1), 1.5, 0, 0), preset("oak")!)]);
    expect([...O.reliefMaterials(both)].map((m) => m.name)).toEqual(["leaf"]);
    const mixed = bake(both, 0.03);
    const oak = mixed.mesh.materials.findIndex((m) => m.name === "oak");
    expect(mixed.maps[oak].normal).toBe(false);
    expect(mixed.maps[mixed.mesh.materials.findIndex((m) => m.name === "leaf")].normal).toBe(true);
    for (const tx of decodedTexels(mixed)) if (tx.mat === oak) expect(Math.abs(tx.n[0] * tx.mesh[0] + tx.n[1] * tx.mesh[1] + tx.n[2] * tx.mesh[2] - 1)).toBeLessThan(1e-3);
    // A displace under a paint takes that paint's material; one with no paint above takes the paints inside it.
    expect([...O.reliefMaterials(O.paint(O.displace(O.paint(P.sphere(1), leaf), 0.1, 0.3), preset("oak")!))].map((m) => m.name)).toEqual(["oak"]);
    expect([...O.reliefMaterials(O.displace(O.union([O.paint(P.sphere(1), leaf), P.box(1, 1, 1)]), 0.1, 0.3))].map((m) => m.name).sort()).toEqual(["clay", "leaf"]);
  });
  it("carries the field's normal for every material once the export is decimated past its flat faces", () => {
    // Round 11: merged curved faces shade in streaks between their corners; the field's normal under each texel, in
    // the merged face's frame, makes them shade as the surface does. A plain sphere has no map whole.
    const ball = O.paint(P.sphere(0.5), preset("red")!);
    const whole = buildHierarchy([{ name: "b", shape: ball }], { cellSize: 0.025, texture: 256 });
    expect(whole.normalMap).toBeUndefined();
    const cut = buildHierarchy([{ name: "b", shape: ball }], { cellSize: 0.025, texture: 256, maxTriangles: 120 });
    expect(cut.triangles).toBeLessThan(cut.decimated!.flat);
    expect(cut.normalMap).toBeDefined();
    expect(cut.normalStats!.reason).toMatch(/decimated past its flat faces/);
    expect([...cut.materialMaps!.values()][0].normal).toBe(true);
    // Decoded as an engine decodes it, the map's normal is the sphere's at the texel, where the merged faces' own
    // normals lean several degrees off it.
    const at: AtlasResult = { mesh: { ...cut.meshes[0] }, uv: cut.uvs![0], image: cut.atlas!, charts: 0, texelsPerUnit: 0, normal: cut.normalMap, tangents: cut.tangents![0], maps: [], seams: { texels: 0, differ: 0 } };
    let mapOff = 0, meshOff = 0, n = 0;
    for (const tx of decodedTexels(at)) {
      const r = Math.hypot(tx.p[0], tx.p[1], tx.p[2]);
      const true_ = tx.p.map((v) => v / r);
      mapOff += Math.acos(Math.min(1, tx.n[0] * true_[0] + tx.n[1] * true_[1] + tx.n[2] * true_[2]));
      meshOff += Math.acos(Math.min(1, tx.mesh[0] * true_[0] + tx.mesh[1] * true_[1] + tx.mesh[2] * true_[2]));
      n++;
    }
    expect(n).toBeGreaterThan(60);
    // Measured: 4.6 degrees for the mesh's normals at 120 triangles, 0.36 for the map's.
    expect((meshOff / n) * (180 / Math.PI)).toBeGreaterThan(3);
    expect((mapOff / n) * (180 / Math.PI)).toBeLessThan(1);
  });
  it("is not baked for a model with no displace and no bump", () => {
    const plain = bake(O.union([P.box(1, 1, 1), O.move(P.sphere(0.5), 1, 0, 0)]), 0.04);
    expect(plain.normal).toBeUndefined();
    expect(plain.tangents).toBeUndefined();
    expect(plain.metalRough).toBeUndefined();
    expect(plain.emissive).toBeUndefined();
  });
});

describe("PBR in the GLB", () => {
  const scene = (shape: Shape3) => buildHierarchy([{ name: "m", shape }], { cellSize: 0.05, texture: 256 });
  it("writes the maps, a TANGENT per vertex, emissive and its strength where they carry something", () => {
    const iron = customMaterial({ name: "iron", color: [0.36, 0.37, 0.38], metal: 1, rough: 0.6, wear: 0.5, bump: 0.01 });
    const flame = customMaterial({ name: "flame", color: [1, 0.7, 0.3], glow: 1.6 });
    const lamp = customMaterial({ name: "lamp", color: [1, 0.9, 0.6], color2: [1, 0.5, 0.2], pattern: "stripes", scale: 0.1, glow: 0.8 });
    const shape = O.union([O.paint(P.box(1, 1, 1), iron), O.paint(O.move(P.sphere(0.3), 0, 0.8, 0), flame), O.paint(O.move(P.cylinder(0.2, 0.5), 1, 0, 0), lamp)]);
    const h = scene(shape);
    const json = glbJson(toGlbScene(h, "m"));
    expect(json.images.map((i: { name: string }) => i.name)).toEqual(["m atlas", "m normal", "m metallic-roughness", "m emissive"]);
    expect(json.textures).toHaveLength(4);
    const prim = json.meshes[0].primitives[0];
    // A textured mesh carries no vertex colours (a viewer would multiply them into the atlas).
    expect(prim.attributes.COLOR_0).toBeUndefined();
    expect(json.accessors).toHaveLength(json.meshes[0].primitives.length + 4);
    const tan = json.accessors[prim.attributes.TANGENT];
    expect(tan.type).toBe("VEC4");
    expect(tan.count).toBe(json.accessors[prim.attributes.POSITION].count);
    const byName = Object.fromEntries(json.materials.map((m: { name: string }) => [m.name, m]));
    expect(byName.iron.normalTexture.index).toBe(1);
    expect(byName.iron.pbrMetallicRoughness.metallicRoughnessTexture.index).toBe(2);
    expect(byName.iron.pbrMetallicRoughness.metallicFactor).toBe(1);
    expect(byName.iron.emissiveFactor).toBeUndefined();
    // One colour: a factor; a glow above 1 is the extension's strength.
    expect(byName.flame.emissiveTexture).toBeUndefined();
    expect(byName.flame.emissiveFactor[0]).toBeCloseTo(1, 3);
    expect(byName.flame.extensions.KHR_materials_emissive_strength.emissiveStrength).toBe(1.6);
    expect(json.extensionsUsed).toEqual(["KHR_materials_emissive_strength"]);
    // Striped: the emissive map, at its factor.
    expect(byName.lamp.emissiveTexture.index).toBe(3);
    expect(byName.lamp.emissiveFactor).toEqual([0.8, 0.8, 0.8]);
    expect(byName.lamp.pbrMetallicRoughness.metallicRoughnessTexture).toBeUndefined();
  });
  it("gives a material whose texels all took one roughness and metalness other than its own those as factors", () => {
    // A bolt smaller than the rust's patches, sitting wholly inside one: every texel is rough oxide, not metal.
    const rust = preset("rust")!;
    let spot: [number, number, number] | undefined;
    for (let i = 0; i < 400 && !spot; i++) {
      const x = (i % 20) * 0.13, z = Math.floor(i / 20) * 0.11;
      let all = true;
      for (let k = 0; k < 60 && all; k++) {
        const a = k * 2.4, b = Math.acos(1 - 2 * ((k + 0.5) / 60));
        if (surface(rust, x + 0.06 * Math.sin(b) * Math.cos(a), 0.06 * Math.cos(b), z + 0.06 * Math.sin(b) * Math.sin(a)).metal > 0.01) all = false;
      }
      if (all) spot = [x, 0, z];
    }
    expect(spot).toBeDefined();
    const h = buildHierarchy([{ name: "bolt", shape: O.paint(O.move(P.sphere(0.06), spot![0], spot![1], spot![2]), rust) }], { cellSize: 0.004, texture: 128 });
    expect(h.metalRoughMap).toBeUndefined();
    const pbr = glbJson(toGlbScene(h, "bolt")).materials[0].pbrMetallicRoughness;
    // The atlas shows oxide; an engine must not shade it as the iron's polished metal.
    expect(pbr.metallicFactor).toBeLessThan(0.05);
    expect(pbr.roughnessFactor).toBeGreaterThan(0.85);
  });
  it("bakes a thin worn bar's scuffs into the metallic-roughness map as the beauty render shades them: most of it the iron's own", () => {
    // The lantern's bars again: radius 0.03 at a probe of 0.04, worn 0.45; the baker reads curvature and thinness.
    const iron = { ...preset("iron")!, wear: 0.45 };
    const shape = O.paint(P.cylinder(0.03, 1), iron);
    const mesh = surfaceNets(shape, { resolution: 100 }).mesh;
    const at = bakeAtlas(mesh, { size: 256, fields: [{ range: [0, mesh.indices.length / 3], dist: shape.dist, offset: [0, 0, 0] }], cellSize: 0.01, wearProbe: 0.04 });
    // A bar rubbed alike all over takes one roughness at every texel, which the baker writes as a factor, not a map.
    expect(at.metalRough, "the bar's roughness varies over it").toBeDefined();
    const mr = at.metalRough!.data;
    let own = 0, n = 0;
    for (let i = 0; i < mr.length; i += 4) {
      if (mr[i + 2] < 128) continue;   // an iron texel is metal; the unpainted background is rough 1, metal 0
      n++;
      if (Math.abs(mr[i + 1] / 255 - iron.rough) < 0.02) own++;
    }
    expect(n).toBeGreaterThan(1000);
    expect(own / n).toBeGreaterThan(0.5);
  });
  it("gives a plain model the colour atlas and nothing more", () => {
    const h = scene(O.union([O.paint(P.box(1, 1, 1), preset("oak")!), O.paint(O.move(P.sphere(0.4), 0, 0.8, 0), preset("gold")!)]));
    expect(h.normalMap ?? h.metalRoughMap ?? h.emissiveMap ?? h.tangents).toBeUndefined();
    const json = glbJson(toGlbScene(h, "m"));
    expect(json.images).toHaveLength(1);
    expect(json.extensionsUsed).toBeUndefined();
    for (const p of json.meshes[0].primitives) { expect(p.attributes.TANGENT).toBeUndefined(); expect(p.attributes.COLOR_0).toBeUndefined(); }
    // Positions, normals, UVs and an index list per primitive: nothing else.
    expect(json.accessors).toHaveLength(3 + json.meshes[0].primitives.length);
    for (const m of json.materials) {
      expect(m.normalTexture).toBeUndefined();
      expect(m.emissiveFactor).toBeUndefined();
      expect(m.pbrMetallicRoughness.metallicRoughnessTexture).toBeUndefined();
    }
  });
  it("keeps the Roblox hierarchy to the colour atlas", () => {
    const iron = customMaterial({ name: "iron", color: [0.36, 0.37, 0.38], metal: 1, wear: 0.5, bump: 0.01, glow: 0.5 });
    const h = buildHierarchy([{ name: "m", shape: O.paint(P.box(1, 1, 1), iron) }], { cellSize: 0.05, texture: 256, maps: false });
    const json = glbJson(toGlbScene(h, "m"));
    expect(json.images).toHaveLength(1);
    expect(json.materials[0].emissiveFactor).toBeUndefined();
    expect(json.materials[0].normalTexture).toBeUndefined();
  });
});

describe("the finish in the beauty render", () => {
  const lum = (p: number) => ((p >> 16) & 255) + ((p >> 8) & 255) + (p & 255);
  /** How many pixels of `b` are brighter than `a`'s by more than `by`, and how many differ by more than it either way. */
  const compare = (a: { get(x: number, y: number): number }, b: { get(x: number, y: number): number }, by: number) => {
    let brighter = 0, differ = 0;
    for (let y = 0; y < 64; y++) for (let x = 0; x < 64; x++) {
      const d = lum(b.get(x, y)) - lum(a.get(x, y));
      if (d > by) brighter++;
      if (Math.abs(d) > by) differ++;
    }
    return { brighter, differ };
  };
  const shoot = (shape: Shape3, wearProbe?: number) => {
    const nets = surfaceNets(shape, { resolution: 24 });
    return renderBeauty(shape, nets.mesh, shape.bounds, { size: 64, cellSize: nets.cellSize, wearProbe });
  };
  it("rubs a worn box's edges bright and mottles a bumped ball, where the same parts new and smooth are plain", () => {
    const grey = { color: [0.45, 0.45, 0.45] as [number, number, number], rough: 0.7 };
    const box = (m: ReturnType<typeof customMaterial>) => O.paint(P.box(1, 1, 1), m);
    const worn = compare(shoot(box(customMaterial(grey)), 0.1), shoot(box(customMaterial({ ...grey, wear: 1 })), 0.1), 30);
    expect(worn.brighter).toBeGreaterThan(300);
    const ball = (m: ReturnType<typeof customMaterial>) => O.paint(P.sphere(0.5), m);
    const bumped = compare(shoot(ball(customMaterial(grey))), shoot(ball(customMaterial({ ...grey, bump: 0.01, bumpScale: 0.08 }))), 12);
    expect(bumped.differ).toBeGreaterThan(500);
  });
  it("shades a thin worn iron bar as the iron with scuffs, not rubbed bright all over", () => {
    // A bar 1.5 probes thick, as the lantern's: before, wear lit the whole of it as bare polished iron.
    const bar = (m: ReturnType<typeof customMaterial>) => O.paint(P.cylinder(0.03, 0.5), m);
    const iron = preset("iron")!;
    const plain = shoot(bar(iron), 0.04), worn = shoot(bar({ ...iron, wear: 0.45 }), 0.04);
    // The bar's own pixels: where white plastic in its place differs a lot.
    const white = shoot(bar(preset("plastic")!), 0.04);
    let pixels = 0, rubbed = 0;
    for (let y = 0; y < 64; y++) for (let x = 0; x < 64; x++) {
      if (Math.abs(lum(white.get(x, y)) - lum(plain.get(x, y))) < 60) continue;
      pixels++;
      if (lum(worn.get(x, y)) - lum(plain.get(x, y)) > 30) rubbed++;
    }
    expect(pixels).toBeGreaterThan(100);
    expect(rubbed / pixels).toBeGreaterThan(0.03);
    expect(rubbed / pixels).toBeLessThan(0.4);
  });
});
