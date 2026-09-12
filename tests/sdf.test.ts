import { describe, expect, it } from "vitest";
import * as P from "../src/sdf/primitives.js";
import * as O from "../src/sdf/ops.js";
import * as S from "../src/sdf/shapes2d.js";
import * as W from "../src/sdf/sweeps.js";
import { boundsCorners, boundsSize, isEmpty } from "../src/sdf/types.js";
import { albedo, materialFromString, preset } from "../src/sdf/materials.js";

describe("primitives", () => {
  it("measure distance from their surface, negative inside", () => {
    expect(P.sphere(1).dist(2, 0, 0)).toBeCloseTo(1);
    expect(P.sphere(1).dist(0, 0.5, 0)).toBeCloseTo(-0.5);
    expect(P.box(2, 4, 6).dist(0, 3, 0)).toBeCloseTo(1);
    expect(P.box(2, 4, 6).dist(2, 3, 0)).toBeCloseTo(Math.SQRT2);
    expect(P.cylinder(1, 2).dist(0, 0, 0)).toBeCloseTo(-1);
    expect(P.cylinder(1, 2).dist(3, 0, 0)).toBeCloseTo(2);
    expect(P.cylinder(1, 2).dist(0, 5, 0)).toBeCloseTo(4);
    expect(P.torus(2, 0.5).dist(2, 0, 0)).toBeCloseTo(-0.5);
    expect(P.torus(2, 0.5).dist(0, 0, 0)).toBeCloseTo(1.5);
    expect(P.capsule(0.5, 3).dist(0, 1.5, 0)).toBeCloseTo(0);
    expect(P.capsule(0.5, 3).dist(0, 0, 0)).toBeCloseTo(-0.5);
    expect(P.cone(1, 0, 2).dist(0, 1, 0)).toBeCloseTo(0, 1);
    expect(P.cone(1, 0, 2).dist(0, -1, 0)).toBeCloseTo(0, 5);
    expect(P.cone(1, 0.5, 2).dist(0, 0, 0)).toBeLessThan(0);
    expect(P.ellipsoid(1, 2, 3).dist(0, 2, 0)).toBeCloseTo(0, 3);
    expect(P.octahedron(1).dist(1, 0, 0)).toBeCloseTo(0, 5);
    expect(P.prism(6, 1, 2).dist(0, 0, 0)).toBeLessThan(0);
    expect(P.prism(6, 1, 2).dist(0, 0, Math.cos(Math.PI / 6))).toBeCloseTo(0, 5);
    expect(P.prism(6, 1, 2).dist(0, 0, 1)).toBeCloseTo(1 - Math.cos(Math.PI / 6), 5);
    expect(P.prism(4, 1, 2).dist(0, 0, 3)).toBeCloseTo(3 - Math.SQRT1_2, 5);
  });
  it("carry bounds that contain the surface", () => {
    for (const s of [P.sphere(1), P.box(1, 2, 3, 0.2), P.cylinder(1, 2, 0.1), P.torus(2, 0.5), P.cone(1, 0.3, 2), P.capsule(0.5, 3), P.prism(5, 1, 1)]) {
      for (const c of boundsCorners(s.bounds)) expect(s.dist(c[0], c[1], c[2])).toBeGreaterThanOrEqual(-1e-9);
    }
  });
  it("rounded boxes shrink the core so the outer size stays put", () => {
    const b = P.box(2, 2, 2, 0.5);
    expect(b.dist(1, 0, 0)).toBeCloseTo(0);
    expect(b.dist(1, 1, 1)).toBeGreaterThan(0);
  });
});

describe("booleans", () => {
  const a = P.sphere(1);
  const b = O.move(P.sphere(1), 1, 0, 0);
  it("union is the minimum, and culling by box gives the same answer as no culling", () => {
    const u = O.union([a, b]);
    for (const p of [[0, 0, 0], [1.5, 0, 0], [-3, 2, 1], [0.5, 0.5, 0.5], [5, 5, 5]] as const) {
      expect(u.dist(p[0], p[1], p[2])).toBeCloseTo(Math.min(a.dist(p[0], p[1], p[2]), b.dist(p[0], p[1], p[2])), 9);
    }
  });
  it("many-part unions cull without changing the result", () => {
    const parts = Array.from({ length: 40 }, (_, i) => O.move(P.box(0.5, 0.5, 0.5), i * 0.7, 0, 0));
    const u = O.union(parts);
    for (let x = -1; x < 30; x += 0.37) {
      const naive = Math.min(...parts.map((p) => p.dist(x, 0.1, 0.2)));
      expect(u.dist(x, 0.1, 0.2)).toBeCloseTo(naive, 9);
    }
  });
  it("difference keeps a's material on the cut surface", () => {
    const d = O.difference(O.paint(a, preset("red")!), O.paint(b, preset("blue")!));
    expect(d.dist(0, 0, 0)).toBeCloseTo(0);
    expect(d.hit(0.2, 0, 0).mat.name).toBe("red");
  });
  it("smooth union is never farther than the hard union and bulges at the join", () => {
    const hard = O.union([a, b]);
    const soft = O.union([a, b], 0.5);
    expect(soft.dist(0.5, 1, 0)).toBeLessThan(hard.dist(0.5, 1, 0));
    expect(soft.dist(5, 0, 0)).toBeCloseTo(hard.dist(5, 0, 0), 9);
  });
  it("empty shapes vanish from unions and leave differences alone", () => {
    expect(O.union([O.empty3(), a])).toBe(a);
    expect(O.difference(a, O.empty3())).toBe(a);
    expect(isEmpty(O.union([O.empty3()]).bounds)).toBe(true);
  });
});

describe("transforms and modifiers", () => {
  it("move and rotate pull the point back, and bounds follow", () => {
    const m = O.move(P.box(2, 2, 2), 5, 0, 0);
    expect(m.dist(5, 0, 0)).toBeCloseTo(-1);
    expect(m.bounds.min).toEqual([4, -1, -1]);
    const r = O.rotate(P.box(4, 1, 1), 0, 90, 0);
    expect(r.dist(0, 0, 1.9)).toBeLessThan(0);
    expect(r.dist(1.9, 0, 0)).toBeGreaterThan(0);
    expect(boundsSize(r.bounds)[2]).toBeCloseTo(4);
  });
  it("scale, mirror, flip", () => {
    const s = O.scale(P.sphere(1), 2, 1, 1);
    expect(s.dist(1.9, 0, 0)).toBeLessThan(0);
    expect(s.dist(0, 1.1, 0)).toBeGreaterThan(0);
    const one = O.move(P.sphere(0.5), 2, 0, 0);
    const both = O.mirror(one, "x");
    expect(both.dist(-2, 0, 0)).toBeCloseTo(-0.5);
    expect(both.dist(2, 0, 0)).toBeCloseTo(-0.5);
    const flipped = O.flip(one, "x");
    expect(flipped.dist(2, 0, 0)).toBeGreaterThan(0);
    expect(flipped.dist(-2, 0, 0)).toBeCloseTo(-0.5);
  });
  it("shell keeps the outer surface and hollows to a wall", () => {
    const s = O.shell(P.sphere(1), 0.2);
    expect(s.dist(0, 0, 0)).toBeGreaterThan(0);
    expect(s.dist(0.9, 0, 0)).toBeLessThan(0);
    expect(s.dist(1, 0, 0)).toBeCloseTo(0);
  });
  it("offset grows, ground rests on zero, center centres", () => {
    expect(O.offset(P.sphere(1), 0.5).dist(1.5, 0, 0)).toBeCloseTo(0);
    const g = O.ground(P.sphere(1));
    expect(g.bounds.min[1]).toBeCloseTo(0);
    const c = O.center(O.move(P.box(1, 1, 1), 3, 4, 5));
    expect(c.bounds.min).toEqual([-0.5, -0.5, -0.5]);
  });
  it("array, grid and ring make exact copies", () => {
    const a = O.array(P.sphere(0.2), 3, 1, 0, 0);
    expect(a.dist(2, 0, 0)).toBeCloseTo(-0.2);
    expect(a.dist(3, 0, 0)).toBeCloseTo(0.8);
    const g = O.grid(P.sphere(0.2), 2, 2, 1, 1);
    expect(g.dist(1, 0, 1)).toBeCloseTo(-0.2);
    const r = O.ring(P.sphere(0.2), 4, 2);
    expect(r.dist(0, 0, 2)).toBeCloseTo(-0.2);
    expect(r.dist(-2, 0, 0)).toBeCloseTo(-0.2);
  });
  it("twist, bend and displace keep the sign near the axis and grow bounds sensibly", () => {
    const t = O.twist(P.box(1, 4, 1), 45);
    expect(t.dist(0, 0, 0)).toBeLessThan(0);
    expect(t.bounds.max[0]).toBeGreaterThan(0.5);
    const d = O.displace(P.sphere(1), 0.1, 0.5, 1);
    expect(Math.abs(d.dist(1, 0, 0))).toBeLessThanOrEqual(0.1 + 1e-9);
    expect(d.bounds.max[0]).toBeCloseTo(1.1);
    const b = O.bend(P.box(4, 0.2, 0.2), 20);
    expect(b.dist(0, 0, 0)).toBeLessThan(0);
  });
  it("paint sets the material and anchors the pattern to the painted frame", () => {
    const m = materialFromString("checker")!;
    const p = O.move(O.paint(P.box(2, 2, 2), m), 10, 0, 0);
    const h = p.hit(10, 0, 0);
    expect(h.mat.name).toBe("checker");
    expect(h.lx).toBeCloseTo(0);
  });
});

describe("2D profiles", () => {
  it("polygon distance is signed and exact", () => {
    const sq = S.polygon([-1, -1, 1, -1, 1, 1, -1, 1]);
    expect(sq.dist(0, 0)).toBeCloseTo(-1);
    expect(sq.dist(2, 0)).toBeCloseTo(1);
    expect(sq.dist(2, 2)).toBeCloseTo(Math.SQRT2);
    const cw = S.polygon([-1, 1, 1, 1, 1, -1, -1, -1]);
    expect(cw.dist(0, 0)).toBeCloseTo(-1);
  });
  it("ngon and star put a vertex on +y", () => {
    expect(S.ngon(6, 1).dist(0, 1)).toBeCloseTo(0, 5);
    expect(S.star(5, 1, 0.5).dist(0, 1)).toBeCloseTo(0, 5);
    expect(S.star(5, 1, 0.5).dist(0, -0.99)).toBeGreaterThan(0);
  });
  it("2D booleans and transforms", () => {
    const u = S.union2([S.circle(1), S.move2(S.circle(1), 2, 0)]);
    expect(u.dist(2, 0)).toBeCloseTo(-1);
    const d = S.difference2(S.rect(2, 2), S.circle(0.5));
    expect(d.dist(0, 0)).toBeCloseTo(0.5);
    const r = S.rotate2(S.rect(2, 0.2), 90);
    expect(r.dist(0, 0.9)).toBeLessThan(0);
    expect(r.dist(0.9, 0)).toBeGreaterThan(0);
    expect(S.shell2(S.circle(1), 0.2).dist(0, 0)).toBeGreaterThan(0);
  });
  it("extrude lays the profile flat by default, revolve spins it around y", () => {
    const e = S.extrude(S.rect(2, 1), 0.5);
    expect(e.dist(0, 0, 0)).toBeCloseTo(-0.25);
    expect(e.dist(0, 0, 0.4)).toBeCloseTo(-0.1);
    expect(e.dist(0, 0.2, 0)).toBeCloseTo(-0.05);
    expect(e.dist(0, 0.4, 0)).toBeCloseTo(0.15);
    const ez = S.extrude(S.rect(2, 1), 0.5, "z");
    expect(ez.dist(0, 0.4, 0)).toBeCloseTo(-0.1);
    expect(ez.dist(0, 0, 0.4)).toBeGreaterThan(0);
    const v = S.revolve(S.move2(S.circle(0.5), 2, 0));
    expect(v.dist(0, 0, 2)).toBeCloseTo(-0.5);
    expect(v.dist(0, 0, 0)).toBeCloseTo(1.5);
    expect(v.bounds.max[0]).toBeCloseTo(2.5);
  });
});

describe("materials", () => {
  it("resolve presets, names and hex colours", () => {
    expect(materialFromString("wood")!.pattern).toBe("wood");
    expect(materialFromString("#ff0000")!.color).toEqual([1, 0, 0]);
    expect(materialFromString("#f00")!.color).toEqual([1, 0, 0]);
    expect(materialFromString("Red")!.name).toBe("red");
    expect(materialFromString("nonsense")).toBeUndefined();
  });
  it("patterns are deterministic and two-tone", () => {
    const c = materialFromString("checker")!;
    expect(albedo(c, 0.1, 0.1, 0.1)).toEqual(c.color);
    expect(albedo(c, 0.6, 0.1, 0.1)).toEqual(c.color2);
    const w = materialFromString("wood")!;
    expect(albedo(w, 0.3, 0.2, 0.1)).toEqual(albedo(w, 0.3, 0.2, 0.1));
  });
});

describe("paths", () => {
  it("tube is a capsule chain with exact distance", () => {
    const t = W.tube([[0, 0, 0], [2, 0, 0], [2, 2, 0]], 0.25);
    expect(t.dist(1, 0, 0)).toBeCloseTo(-0.25);
    expect(t.dist(2, 1, 0)).toBeCloseTo(-0.25);
    expect(t.dist(1, 1, 0)).toBeCloseTo(1 - 0.25);
    expect(t.dist(3, 0, 0)).toBeCloseTo(0.75);
    expect(t.bounds.max).toEqual([2.25, 2.25, 0.25]);
  });
  it("sweep carries a profile in a frame with its y up", () => {
    const s = W.sweep(S.rect(1, 0.2), [[0, 0, 0], [4, 0, 0]]);
    expect(s.dist(2, 0, 0)).toBeCloseTo(-0.1);
    expect(s.dist(2, 0, 0.4)).toBeCloseTo(-0.1);
    expect(s.dist(2, 0.4, 0)).toBeCloseTo(0.3);
    expect(s.dist(5, 0, 0)).toBeCloseTo(1);
  });
  it("sweep covers the outside of a bend and cuts the path's ends flat", () => {
    const bent = W.sweep(S.circle(0.3), [[0, 0, 0], [2, 0, 0], [2, 2, 0]]);
    // The outer corner of the bend, just off the join, is inside.
    expect(bent.dist(2.15, 0.15, 0)).toBeLessThan(0);
    expect(bent.dist(2.28, -0.1, 0)).toBeLessThan(0);
    // The start is cut flat: nothing before x = 0.
    expect(bent.dist(-0.05, 0, 0)).toBeGreaterThan(0);
    expect(bent.dist(2, 2.05, 0)).toBeGreaterThan(0);
  });
  it("smoothing a path passes through its points and adds them in between", () => {
    const pts: [number, number, number][] = [[0, 0, 0], [1, 1, 0], [2, 0, 0]];
    const sm = W.smoothPath(pts, 4);
    expect(sm.length).toBe(9);
    expect(sm[4]).toEqual([1, 1, 0]);
    expect(sm[8]).toEqual([2, 0, 0]);
    expect(W.smoothPath(pts, 0)).toBe(pts);
  });
  it("loft is a at the bottom and b at the top", () => {
    const l = W.loft(S.circle(1), S.rect(0.5, 0.5), 2);
    expect(l.dist(0, -0.99, 0.9)).toBeLessThan(0);
    expect(l.dist(0, 0.99, 0.9)).toBeGreaterThan(0);
    expect(l.dist(0, 0.99, 0.2)).toBeLessThan(0);
    expect(l.dist(0, 1.5, 0)).toBeCloseTo(0.5);
    expect(l.bounds.min[1]).toBe(-1);
  });
  it("rejects a malformed point list with a count", () => {
    expect(() => W.toPoints([1, 2, 3, 4], "tube")).toThrow(/triples.*got 4/);
  });
});
