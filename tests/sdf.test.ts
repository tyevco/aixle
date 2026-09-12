import { describe, expect, it } from "vitest";
import * as P from "../src/sdf/primitives.js";
import * as O from "../src/sdf/ops.js";
import * as S from "../src/sdf/shapes2d.js";
import * as W from "../src/sdf/sweeps.js";
import * as C from "../src/sdf/curves.js";
import { textProfile, textWidth, FONT_GLYPHS } from "../src/sdf/font.js";
import { boundsCorners, boundsSize, isEmpty } from "../src/sdf/types.js";
import { albedo, customMaterial, materialFromString, preset } from "../src/sdf/materials.js";

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
  it("many-part unions cull without changing the result near the surface, and never overestimate", () => {
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

describe("twist, taper and path builders", () => {
  it("taper shrinks a tube's radius along its length", () => {
    const t = W.tube([[0, 0, 0], [4, 0, 0]], 0.5, 0.5);
    expect(t.dist(0.2, 0.5, 0)).toBeCloseTo(0, 1);
    expect(t.dist(3.8, 0.5, 0)).toBeGreaterThan(0.2);
    expect(t.dist(3.8, 0.25, 0)).toBeCloseTo(0, 1);
    expect(t.dist(2, 0, 0)).toBeLessThan(-0.3);
  });
  it("twist turns a swept profile by the end of the path", () => {
    // A flat bar (wide in x across the path, thin in y) swept along z, twisted 90 degrees.
    const bar = S.rect(1, 0.2);
    const straight = W.sweep(bar, [[0, 0, 0], [0, 0, 4]]);
    const twisted = W.sweep(bar, [[0, 0, 0], [0, 0, 4]], 90);
    expect(straight.dist(0.4, 0, 3.9)).toBeLessThan(0);
    expect(straight.dist(0, 0.4, 3.9)).toBeGreaterThan(0);
    expect(twisted.dist(0.4, 0, 3.9)).toBeGreaterThan(0);
    expect(twisted.dist(0, 0.4, 3.9)).toBeLessThan(0);
    expect(twisted.dist(0.4, 0, 0.05)).toBeLessThan(0);
  });
  it("taper scales a swept profile", () => {
    const horn = W.sweep(S.circle(0.5), [[0, 0, 0], [0, 4, 0]], 0, 0.2);
    expect(horn.dist(0.45, 0.1, 0)).toBeLessThan(0);
    expect(horn.dist(0.45, 3.9, 0)).toBeGreaterThan(0);
    expect(horn.dist(0.05, 3.9, 0)).toBeLessThan(0);
  });
  it("helix and arc paths are closed lists of triples", () => {
    const h = W.helixPath(1, 2, 3, 8);
    expect(h.length % 3).toBe(0);
    expect(h.length / 3).toBe(25);
    expect(h[0]).toBeCloseTo(1);
    expect(h[h.length - 2]).toBeCloseTo(2);
    const a = W.arcPath(2, 0, 90, 4);
    expect(a.length / 3).toBe(5);
    expect(a[2]).toBeCloseTo(2);
    expect(a[12]).toBeCloseTo(2);
    expect(Math.abs(a[14])).toBeLessThan(1e-9);
  });
});

describe("text", () => {
  it("covers letters, digits and punctuation", () => {
    for (const ch of "ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789 .,-+!?:'/&()#*=") expect(FONT_GLYPHS.has(ch), ch).toBe(true);
  });
  it("is a profile on the baseline with a stroke width, laid out left to right", () => {
    const t = textProfile("I", 6, 1);
    expect(t.dist(1.2, 3)).toBeCloseTo(-0.5);
    expect(t.dist(1.2, -2)).toBeGreaterThan(0);
    expect(t.bounds.min[1]).toBeCloseTo(-0.5);
    expect(t.bounds.max[1]).toBeCloseTo(6.5);
    const two = textProfile("II", 6, 1);
    expect(two.bounds.max[0]).toBeGreaterThan(t.bounds.max[0] + 2);
    expect(textWidth("II", 6)).toBeGreaterThan(textWidth("I", 6));
    expect(textProfile("", 1).dist(0, 0)).toBeGreaterThan(1e5);
  });
  it("draws a ? for an unknown character", () => {
    expect(textProfile("~", 6, 1).bounds.max[0]).toBeGreaterThan(3);
  });
});

describe("spatial index", () => {
  it("a large union with the grid gives exactly the plain minimum, inside and outside its bounds", () => {
    const parts: ReturnType<typeof P.sphere>[] = [];
    for (let i = 0; i < 40; i++) parts.push(O.move(P.box(0.4, 0.4, 0.4), Math.sin(i) * 3, (i % 5) * 0.8, Math.cos(i) * 3));
    const u = O.union(parts);
    let seed = 7;
    const rnd = () => { seed = (seed * 16807) % 2147483647; return seed / 2147483647; };
    for (let k = 0; k < 400; k++) {
      const x = rnd() * 12 - 6, y = rnd() * 8 - 2, z = rnd() * 12 - 6;
      const naive = Math.min(...parts.map((p) => p.dist(x, y, z)));
      const got = u.dist(x, y, z);
      expect(got).toBeCloseTo(naive, 9);
    }
  });
  it("a long tube and sweep agree with their unindexed forms near the surface", () => {
    const pts = W.toPoints(W.helixPath(1, 2, 3, 12), "t");
    const t = W.tube(pts, 0.15);
    const short = pts.slice(0, 5); // fewer than the index threshold
    const ref = W.tube(short, 0.15);
    const naive = (x: number, y: number, z: number) => {
      let best = Infinity;
      for (let i = 0; i + 1 < pts.length; i++) best = Math.min(best, W.tube([pts[i], pts[i + 1]], 0.15).dist(x, y, z));
      return best;
    };
    for (let k = 0; k < 60; k++) {
      const x = Math.sin(k * 1.7) * 2, y = -0.5 + k * 0.05, z = Math.cos(k * 2.3) * 2;
      expect(t.dist(x, y, z)).toBeCloseTo(naive(x, y, z), 9);
    }
    expect(t.dist(1.12, 0.1, 0)).toBeLessThanOrEqual(ref.dist(1.12, 0.1, 0) + 1e-9);
    const sw = W.sweep(S.circle(0.15), pts);
    expect(sw.dist(1, 0, 0)).toBeLessThan(0);
    expect(sw.dist(1.3, 0, 0)).toBeGreaterThan(0.1);
  });
});

describe("partial revolve, spline, lowercase, arc text", () => {
  it("a partial revolve keeps the wedge and cuts flat ends", () => {
    const arch = S.revolve(S.move2(S.circle(0.3), 2, 0), 0, 180);
    expect(arch.dist(0, 0, 2)).toBeLessThan(0); // at 0 degrees (+z)
    expect(arch.dist(2, 0, 0)).toBeLessThan(0); // at 90 degrees (+x)
    expect(arch.dist(0, 0, -2)).toBeLessThan(0); // at 180 degrees (-z), the far end
    expect(arch.dist(-2, 0, 0)).toBeGreaterThan(1); // 270 degrees: outside the wedge
    const quarter = S.revolve(S.move2(S.circle(0.3), 2, 0), 0, 90);
    expect(quarter.dist(0, 0, -2)).toBeGreaterThan(1);
    expect(quarter.dist(-0.2, 0, 2)).toBeCloseTo(0.2, 1);
  });
  it("spline densifies where the path turns and keeps straights sparse", () => {
    const pts = W.splinePath([[0, 0, 0], [4, 0, 0], [4, 4, 0], [8, 4, 0]], 3);
    expect(pts.length % 3).toBe(0);
    expect(pts.length / 3).toBeGreaterThan(20);
    expect(pts.slice(0, 3)).toEqual([0, 0, 0]);
    expect(pts.slice(-3)).toEqual([8, 4, 0]);
    expect(W.splinePath([[0, 0, 0], [1, 0, 0]], 3)).toEqual([0, 0, 0, 1, 0, 0]);
  });
  it("lowercase glyphs exist and differ from uppercase", () => {
    for (const ch of "abcdefghijklmnopqrstuvwxyz") expect(FONT_GLYPHS.has(ch), ch).toBe(true);
    const upper = textProfile("A", 6, 0.5), lower = textProfile("a", 6, 0.5);
    expect(upper.bounds.max[1]).toBeGreaterThan(lower.bounds.max[1] + 1);
    expect(textProfile("g", 6, 0.5).bounds.min[1]).toBeLessThan(-1);
  });
  it("arc text bends around a circle, centred at the top", () => {
    const t = textProfile("ABCDEF", 1, 0.2, 0, 4);
    // Every point of the profile lies near radius 4..5 from the origin, above it.
    const b = t.bounds;
    expect(b.max[1]).toBeLessThan(5.3);
    expect(b.max[1]).toBeGreaterThan(4.5);
    expect(Math.abs(b.min[0] + b.max[0])).toBeLessThan(0.5);
    const under = textProfile("ABC", 1, 0.2, 0, -4);
    expect(under.bounds.min[1]).toBeLessThan(-4);
  });
});

describe("height query", () => {
  it("finds the top surface under a point, through blends and bumps", () => {
    const mound = O.union([P.sphere(1), O.move(P.sphere(0.8), 1, 0.5, 0)], 0.3);
    expect(O.heightAt(mound, 0, 0)!).toBeCloseTo(1, 2);
    expect(O.heightAt(mound, 1, 0)!).toBeCloseTo(1.3, 2);
    expect(O.heightAt(mound, 5, 5)).toBeUndefined();
    const rough = O.displace(P.sphere(1), 0.1, 0.5, 2);
    const h = O.heightAt(rough, 0.2, 0.1)!;
    expect(Math.abs(rough.dist(0.2, h, 0.1))).toBeLessThan(1e-3);
  });
});

describe("feature size", () => {
  it("is carried by walls, tubes and strokes, and follows transforms and unions", () => {
    // Bounds cannot see a shell's wall or a tube's radius; the shape carries the thinnest feature it knows.
    expect(O.shell(P.box(2, 2, 2), 0.1).feature).toBeCloseTo(0.1);
    expect(W.tube([[0, 0, 0], [0, 3, 0]], 0.05).feature).toBeCloseTo(0.1);
    expect(W.tube([[0, 0, 0], [0, 3, 0]], 0.05, 0.5, "flat").feature).toBeCloseTo(0.05);
    expect(textProfile("A", 1, 0.12).feature).toBeCloseTo(0.12);
    expect(S.extrude(S.move2(textProfile("A", 1, 0.12), 1, 0), 0.3).feature).toBeCloseTo(0.12);
    expect(S.revolve(S.shell2(S.circle(1), 0.07), 2).feature).toBeCloseTo(0.07);
    expect(W.sweep(S.rect(0.2, 0.5), [[0, 0, 0], [1, 0, 0]]).feature).toBeCloseTo(0.2);
    const wall = O.shell(P.box(2, 2, 2), 0.1);
    expect(O.move(O.rotate(wall, 30, 0, 0), 1, 2, 3).feature).toBeCloseTo(0.1);
    expect(O.scale(wall, 0.5, 2, 2).feature).toBeCloseTo(0.05);
    expect(O.union([P.box(1, 1, 1), wall, O.shell(P.sphere(1), 0.02)]).feature).toBeCloseTo(0.02);
    expect(O.difference(wall, P.sphere(0.5)).feature).toBeCloseTo(0.1);
    expect(O.paint(wall, preset("wood")!).feature).toBeCloseTo(0.1);
    expect(P.box(1, 1, 1).feature).toBeUndefined();
  });
});

describe("curves", () => {
  it("a tube along a straight bezier is a capsule and along an arc is the arc's offset", () => {
    const straight = C.bezierCurve([[0, 0, 0], [1, 0, 0], [3, 0, 0], [4, 0, 0]]);
    const t = C.tubeCurve(straight, 0.5);
    expect(t.dist(2, 0.5, 0)).toBeCloseTo(0, 5);
    expect(t.dist(4.5, 0, 0)).toBeCloseTo(0, 5);
    expect(t.dist(2, 2, 0)).toBeCloseTo(1.5, 5);
    expect(straight.total).toBeCloseTo(4, 4);
    // A quarter circle of radius 2 from the standard handle length: a Bezier is within 6e-4 of the circle.
    const k = 0.5523 * 2;
    const arc = C.bezierCurve([[2, 0, 0], [2, 0, k], [k, 0, 2], [0, 0, 2]]);
    const at = C.tubeCurve(arc, 0.3);
    for (const a of [0.2, 0.7, 1.2]) {
      expect(Math.abs(at.dist(2 * Math.cos(a), 0, 2 * Math.sin(a)) + 0.3)).toBeLessThan(6e-4);
      expect(Math.abs(at.dist(3 * Math.cos(a), 0, 3 * Math.sin(a)) - 0.7)).toBeLessThan(6e-4);
    }
    expect(arc.total).toBeCloseTo(Math.PI, 3);
    expect(at.feature).toBeCloseTo(0.6);
    const flat = C.tubeCurve(straight, 0.5, 1, "flat");
    expect(flat.dist(4.2, 0, 0)).toBeCloseTo(0.2, 5);
    expect(flat.dist(3.8, 0, 0)).toBeLessThan(0);
  });
  it("a sweep along a curve keeps the profile's x across and y up, and cuts the ends flat", () => {
    const straight = C.bezierCurve([[0, 0, 0], [1, 0, 0], [3, 0, 0], [4, 0, 0]]);
    const sw = C.sweepCurve(S.rect(1, 0.4), straight);
    expect(sw.dist(2, 0, 0)).toBeCloseTo(-0.2, 5);
    expect(sw.dist(2, 0.2, 0)).toBeCloseTo(0, 5);
    expect(sw.dist(2, 0, 0.5)).toBeCloseTo(0, 5);
    expect(sw.dist(5, 0, 0)).toBeCloseTo(1, 5);
    expect(sw.feature).toBeCloseTo(0.4);
    // Through points: the curve passes through them, and the bounds contain the tube.
    const c = C.curveThrough([[0, 0, 0], [1, 1, 0], [2, 0, 0]]);
    expect(c.segments).toBe(2);
    const ct = C.tubeCurve(c, 0.1);
    expect(ct.dist(1, 1, 0)).toBeCloseTo(-0.1, 4);
    expect(ct.dist(0, 0, 0)).toBeCloseTo(-0.1, 4);
    const b = ct.bounds;
    for (const p of C.curvePoints(c, 8)) for (let k = 0; k < 3; k++) { expect(p[k]).toBeGreaterThanOrEqual(b.min[k]); expect(p[k]).toBeLessThanOrEqual(b.max[k]); }
    expect(() => C.bezierCurve([[0, 0, 0], [1, 0, 0]])).toThrow(/4, 7, 10/);
  });
});

describe("serif face", () => {
  it("adds slab serifs at free stem ends only, and sets the text wider", () => {
    // H at size 6 (grid units): the left stem's foot is at (0, 0); a serif reaches 0.55 either side.
    const sans = textProfile("H", 6, 0.15), serif = textProfile("H", 6, 0.15, 0, 0, "serif");
    expect(sans.dist(0.45, 0)).toBeGreaterThan(0.3);
    expect(serif.dist(0.45, 0)).toBeLessThan(0);
    // The crossbar meets the stems: no serif at its ends.
    expect(serif.dist(0.5, 3.2 + 0.4)).toBeGreaterThan(0.3);
    // A curved terminal (C) stops between the guides and gets none.
    const c = textProfile("C", 6, 0.15, 0, 0, "serif");
    expect(c.dist(3.6 + 0.4, 1)).toBeGreaterThan(0.3);
    expect(textWidth("HH", 6, 0, "serif")).toBeGreaterThan(textWidth("HH", 6));
    expect(serif.feature).toBeCloseTo(0.15);
  });
});

describe("ground on the surface", () => {
  it("rests the surface on y = 0 when a blend or a cut leaves the bounds loose", () => {
    // A smooth union pads the bounds by its blend; the surface still starts at the sphere's bottom.
    const blended = O.union([P.sphere(1), O.move(P.sphere(0.5), 0, 1.2, 0)], 0.3);
    expect(blended.bounds.min[1]).toBeLessThan(-1.01);
    expect(O.surfaceBottom(blended)).toBeCloseTo(-1, 2);
    const g = O.ground(blended);
    expect(g.dist(0, 0, 0)).toBeCloseTo(0, 2);
    // A difference keeps the left side's box: the surface of a ball cut in half starts at the cut.
    const half = O.difference(P.sphere(1), O.move(P.box(4, 4, 4), 0, -2, 0));
    expect(O.surfaceBottom(half)).toBeCloseTo(0, 2);
    expect(O.ground(P.box(2, 2, 2)).bounds.min[1]).toBeCloseTo(0, 6);
  });
  it("decal paints the surface inside a region and nothing else, adding no geometry", () => {
    const eye = O.paint(P.sphere(1), preset("plastic")!);
    const pupil = O.decal(eye, O.move(P.sphere(0.4), 0, 0, 1), preset("rubber")!);
    expect(pupil.dist(0, 0, 1)).toBeCloseTo(0, 6);
    expect(pupil.hit(0, 0, 1).mat.name).toBe("rubber");
    expect(pupil.hit(0, 1, 0).mat.name).toBe("plastic");
    expect(pupil.bounds).toEqual(eye.bounds);
  });
});

describe("bend and wrap", () => {
  it("bend puts x on a circle of radius 1/k centred at (0, R), with a box to match", () => {
    // A bar 2 long, 0.2 thick, bent 90 degrees per unit: R = 57.3 / 90 = 0.6366; its end at x = 1 lands at angle 90°.
    const bar = P.box(2, 0.2, 0.2);
    const bent = O.bend(bar, 90);
    const R = 180 / Math.PI / 90;
    expect(bent.dist(0, 0, 0)).toBeCloseTo(-0.1, 5); // the middle stays put
    // x = 0.9 is 0.9 / R radians round the centre (0, R); the bar's end at x = 1 is a quarter turn.
    const a = 0.9 / R;
    expect(bent.dist(R * Math.sin(a), R - R * Math.cos(a), 0)).toBeCloseTo(-0.1, 5);
    expect(bent.dist(-R * Math.sin(a), R - R * Math.cos(a), 0)).toBeCloseTo(-0.1, 5);
    expect(bent.dist(R, R, 0)).toBeCloseTo(0, 5);
    expect(bent.dist(0, 2 * R, 0)).toBeGreaterThan(0.2); // the far side of the circle is empty
    // The ends reach angle 90°, where the outer edge sits at x = R + 0.1 and y = R.
    expect(bent.bounds.max[1]).toBeGreaterThanOrEqual(R - 1e-6);
    expect(bent.bounds.max[1]).toBeLessThan(R + 0.05);
    expect(bent.bounds.max[0]).toBeGreaterThanOrEqual(R + 0.1 - 1e-6);
    expect(bent.bounds.max[0]).toBeLessThan(R + 0.2);
    expect(O.bend(bar, -90).dist(R * Math.sin(a), -(R - R * Math.cos(a)), 0)).toBeCloseTo(-0.1, 5);
  });
  it("wrap puts x round a cylinder about y, x = 0 on +z, depth outward", () => {
    // A bar along x, 0.2 deep in z from -0.1 to 0.1, wrapped on radius 2: its middle sits at (0, 0, 2).
    const bar = P.box(3, 0.4, 0.2);
    const w = O.wrap(bar, 2);
    expect(w.dist(0, 0, 2)).toBeCloseTo(-0.1, 5);
    expect(w.dist(0, 0, 2.15)).toBeCloseTo(0.05, 5);
    // x = 1.4 (just short of the bar's end at 1.5) is at angle 0.7 rad towards +x; past the end is empty.
    const a = 1.4 / 2;
    expect(w.dist(2 * Math.sin(a), 0, 2 * Math.cos(a))).toBeLessThan(0);
    expect(w.dist(2 * Math.sin(0.75), 0, 2 * Math.cos(0.75))).toBeCloseTo(0, 5);
    expect(w.dist(2 * Math.sin(a + 0.2), 0, 2 * Math.cos(a + 0.2))).toBeGreaterThan(0);
    expect(w.dist(0, 0, -2)).toBeGreaterThan(1);
    const b = w.bounds;
    expect(b.max[2]).toBeGreaterThanOrEqual(2.1 - 1e-6);
    expect(b.min[2]).toBeLessThan(1.6);
    expect(b.max[0]).toBeLessThan(2.2);
  });
});

describe("material axis and glow", () => {
  it("stacks stripes along the material's axis and carries glow", () => {
    const y = customMaterial({ color: [1, 0, 0], color2: [0, 0, 1], pattern: "stripes", scale: 1 });
    const x = customMaterial({ color: [1, 0, 0], color2: [0, 0, 1], pattern: "stripes", scale: 1, axis: "x" });
    // Default: bands change with y; with axis x they change with x.
    expect(albedo(y, 0.5, 0.5, 0)).toEqual(albedo(y, 5.5, 0.5, 0));
    expect(albedo(y, 0.5, 0.5, 0)).not.toEqual(albedo(y, 0.5, 1.5, 0));
    expect(albedo(x, 0.5, 0.5, 0)).toEqual(albedo(x, 0.5, 5.5, 0));
    expect(albedo(x, 0.5, 0.5, 0)).not.toEqual(albedo(x, 1.5, 0.5, 0));
    expect(customMaterial({ color: [1, 1, 1], glow: 1.5 }).glow).toBe(1.5);
    expect(preset("gold")!.glow).toBe(0);
  });
});

describe("round-4 findings", () => {
  it("an intersection keeps the first shape's material on the faces the second cut", () => {
    const a = O.paint(P.box(2, 2, 2), preset("red")!);
    const b = O.paint(O.move(P.box(2, 2, 2), 1, 0, 0), preset("blue")!);
    // On b's face at x = 2? No: the intersection's face at x = 1 is a's interior cut by b, so it is red.
    expect(O.intersect(a, b).hit(0.01, 0, 0).mat.name).toBe("red");
    expect(O.intersect(a, b).hit(0.99, 0, 0).mat.name).toBe("red");
  });
  it("surfacePoint slides to the surface, and placedBounds carries a box through a turned joint", () => {
    const s = O.surfacePoint(P.sphere(1), 0, 3, 0);
    expect(s[1]).toBeCloseTo(1, 4);
    // From inside a box the nearest face is the closest one: z = 1 from (5, 0.2, 0.3).
    const p = O.surfacePoint(O.move(P.box(2, 2, 2), 5, 0, 0), 5, 0.2, 0.3);
    expect(p[2]).toBeCloseTo(1, 3);
    expect(p[0]).toBeCloseTo(5, 3);
    const lug = P.sphere(0.2);
    const boom = O.union([O.move(P.box(0.3, 2, 0.3), 0, 1, 0), O.move(lug, 0, 2.6, 0)]);
    const j = O.joint(boom, "hinge", 0, 0, 0, [0, 0, 90]);
    const placed = O.placedBounds(j, lug, lug.bounds)!;
    // Turned 90 degrees about z at the origin, the lug at y 2.6 lands at x -2.6.
    expect(placed.min[0]).toBeCloseTo(-2.8, 5);
    expect(placed.max[0]).toBeCloseTo(-2.4, 5);
    expect(placed.min[1]).toBeCloseTo(-0.2, 5);
    expect(O.hasLooseBounds(j)).toBe(true);
    expect(O.hasLooseBounds(boom)).toBe(false);
    // The inverse of every transform and the joint lands where the child was.
    const u = j.unwarp!(-2.6, 0, 0);
    expect(u[0]).toBeCloseTo(0, 5);
    expect(u[1]).toBeCloseTo(2.6, 5);
  });
  it("a sweep's box allows for the mitres at sharp joins", () => {
    const straight = W.sweep(S.circle(0.3), [[0, 0, 0], [2, 0, 0]]);
    const bent = W.sweep(S.circle(0.3), [[0, 0, 0], [2, 0, 0], [2, 2, 0]]);
    // The reach is the profile box's corner, 0.3 * sqrt 2 for a circle of 0.3.
    expect(straight.bounds.max[0]).toBeCloseTo(2 + 0.3 * Math.SQRT2, 5);
    expect(bent.bounds.max[0]).toBeGreaterThan(straight.bounds.max[0]);
    // The mitre's outer corner is inside the box.
    const corner = 2 + 0.3;
    expect(bent.bounds.max[0]).toBeGreaterThanOrEqual(corner);
    expect(bent.bounds.min[1]).toBeLessThanOrEqual(-0.3);
  });
});

describe("letter spacing as a gap", () => {
  it("counts the space between neighbouring letters, so tight serif lettering warns before it meshes open", () => {
    // The trophy's rim text: size 0.15, weight 0.04, spacing 0.025, where two letters' strokes are a third of the
    // render's 0.018 cell apart; with room between the letters the counters are the narrowest gap again.
    const tight = textProfile("AWARD OF EXCELLENCE", 0.15, 0.04, 0.025);
    const loose = textProfile("AWARD", 0.15, 0.04, 0.08, 0, "serif");
    expect(tight.gap!).toBeLessThan(0.018 / 3);
    // With room between the letters the counters are the narrowest gap again: 2.8 grid units less the stroke.
    expect(loose.gap!).toBeCloseTo(2.8 * 0.025 - 0.04, 6);
    // A single letter has no neighbour: its gap is its counters alone; so is a bold title whose letters overlap.
    expect(textProfile("A", 0.15, 0.04, 0.025, 0, "serif").gap!).toBeCloseTo(2.8 * 0.025 - 0.04, 6);
    expect(textProfile("AIXLE", 1.3, 0.22).gap!).toBeCloseTo(2.8 * (1.3 / 6) - 0.22, 6);
  });
});
