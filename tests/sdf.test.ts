import { describe, expect, it } from "vitest";
import * as P from "../src/sdf/primitives.js";
import * as O from "../src/sdf/ops.js";
import * as S from "../src/sdf/shapes2d.js";
import * as W from "../src/sdf/sweeps.js";
import * as C from "../src/sdf/curves.js";
import * as C2 from "../src/sdf/curves2d.js";
import { surfaceNets } from "../src/mesh/surfaceNets.js";
import { isWatertight, meshBounds } from "../src/mesh/mesh.js";
import * as C_ from "../src/sdf/measure.js";
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
  it("is the deeper distance inside two overlapping members, and no surface on the first member's face inside the second", () => {
    // Round 9: a union's box cull skipped every later member once an earlier one was at or below zero, so a
    // counterbore's floor read as a surface inside the through hole it overlapped and void() saw solid there.
    const thru = O.move(P.cylinder(0.06, 0.5), 0.55, 0.075, 0.35);
    const cb = O.move(P.cylinder(0.11, 0.2), 0.55, 0.19, 0.35);
    for (const u of [O.union([thru, cb]), O.union([cb, thru])]) {
      expect(u.dist(0.55, 0.19, 0.35)).toBeCloseTo(-0.1, 9);
      // On the counterbore's floor (y = 0.09) inside the through hole: well inside the union, not on its surface.
      expect(u.dist(0.55, 0.09, 0.35)).toBeCloseTo(-0.06, 9);
    }
    const plate = O.difference(O.move(P.box(1.5, 0.15, 1), 0, 0.075, 0), O.union([thru, cb]));
    expect(C_.isVoid(thru, plate)).toBe(true);
    expect(C_.isVoid(cb, plate)).toBe(true);
    expect(C_.voidWitness(O.move(P.cylinder(0.12, 0.2), 0.55, 0.19, 0.35), plate)).toBeDefined();
    // The same rule in a spatial-indexed union and a tube's segments.
    const many = O.union(Array.from({ length: 16 }, (_, i) => O.move(P.sphere(0.6), i * 0.5, 0, 0)));
    expect(many.dist(0.25, 0, 0)).toBeCloseTo(Math.min(...Array.from({ length: 16 }, (_, i) => Math.hypot(0.25 - i * 0.5) - 0.6)), 9);
    const tube = W.tube([[0, 0, 0], [1, 0, 0], [1, 1, 0]], 0.2);
    expect(tube.dist(1, 0, 0)).toBeCloseTo(-0.2, 6);
  });
  it("offset and round carry the feature they grow", () => {
    const thin = W.tube([[0, 0, 0], [1, 0, 0]], 0.02);
    expect(thin.feature).toBeCloseTo(0.04, 9);
    expect(O.offset(thin, 0.03).feature).toBeCloseTo(0.1, 9);
    expect(O.offset(thin, -0.01).feature).toBeCloseTo(0.02, 9);
  });
  it("marks a field that is a bound rather than a distance", () => {
    expect(O.union([a, b]).bound).toBeUndefined();
    expect(O.union([a, b], 0.3).bound).toBe(true);
    expect(O.difference(a, b).bound).toBeUndefined();
    expect(O.difference(a, b, 0.2).bound).toBe(true);
    expect(O.scale(a, 2, 2, 2).bound).toBeUndefined();
    expect(O.scale(a, 1, 2, 1).bound).toBe(true);
    for (const w of [O.twist(a, 30), O.bend(a, 30), O.wrap(a, 3), O.displace(a, 0.1, 0.5), W.loft(S.circle(1), S.rect(1, 1), 2)]) expect(w.bound).toBe(true);
    expect(O.move(a, 1, 0, 0).bound).toBeUndefined();
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
    // Wood is boards 2.5 scales wide across x with a dark seam between them, darker than the board's middle at any
    // height along the grain (rings before this: a table top read as a bullseye).
    const seam = albedo(w, w.scale * 2.5, 0.7, 0.2), middle = albedo(w, w.scale * 1.25, 0.7, 0.2);
    expect(seam[0] + seam[1] + seam[2]).toBeLessThan(middle[0] + middle[1] + middle[2]);
    // The grain runs along y: the colour a whole scale along the axis is far closer than one across it.
    const at = albedo(w, 0.31, 0.2, 0.1), along = albedo(w, 0.31, 0.2 + w.scale * 0.5, 0.1), across = albedo(w, 0.31 + w.scale * 0.5, 0.2, 0.1);
    const d = (a: number[], b: number[]) => Math.abs(a[0] - b[0]) + Math.abs(a[1] - b[1]) + Math.abs(a[2] - b[2]);
    expect(d(at, along)).toBeLessThan(d(at, across));
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

describe("loft", () => {
  it("measures a slanted wall across it, like the cone it is, and never farther than the truth", () => {
    const l = W.loft(S.circle(1), S.circle(0.5), 2);
    const c = P.cone(1, 0.5, 2);
    // Beside the wall, outside and inside: the cone's distance, not the radial gap (0.45 and -0.25).
    expect(l.dist(1.2, 0, 0)).toBeCloseTo(c.dist(1.2, 0, 0), 6);
    expect(l.dist(0.5, 0, 0)).toBeCloseTo(c.dist(0.5, 0, 0), 6);
    for (const p of [[1.5, 0.5, 0.2], [0.2, 0.9, 0.1], [0.9, -0.9, 0], [0, 1.5, 0]] as const) expect(l.dist(p[0], p[1], p[2])).toBeLessThanOrEqual(c.dist(p[0], p[1], p[2]) + 1e-9);
    expect(l.bound).toBe(true);
  });
});

describe("arc about an axis", () => {
  it("lies on the ground about y, stands in yz about x and in xy about z", () => {
    expect(W.arcPath(1, 0, 90, 1)).toEqual([0, 0, 1, 1, 0, expect.closeTo(0, 9)]);
    expect(W.arcPath(1, 0, 90, 1, "x")).toEqual([0, 0, 1, 0, 1, expect.closeTo(0, 9)]);
    expect(W.arcPath(1, 0, 90, 1, "z")).toEqual([0, 1, 0, 1, expect.closeTo(0, 9), 0]);
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
  it("arc text knows the radii its ink spans, which check prints (round 10: an engraving broke out over a rim)", () => {
    // The hub's label: size 0.1 and weight 0.03 on an arc of 0.27 spans 0.255 to 0.385 from the origin.
    const label = textProfile("HB-7", 0.1, 0.03, 0, 0.27);
    expect(label.arcSpan![0]).toBeCloseTo(0.255, 3);
    expect(label.arcSpan![1]).toBeCloseTo(0.385, 3);
    // Under the bottom the letters stand inward from the baseline's circle.
    const under = textProfile("HB-7", 0.1, 0.03, 0, -0.27).arcSpan!;
    expect(under[0]).toBeCloseTo(0.155, 3);
    expect(under[1]).toBeCloseTo(0.285, 3);
    expect(textProfile("HB-7", 0.1, 0.03).arcSpan).toBeUndefined();
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
  it("a flat box is a plate and a long cylinder a rod, but a cube and a drum carry none", () => {
    // A library's slats and rods are judged against the scene's cell only if the box itself says how thin it is
    // (round 6: a bench's 0.03 slats under a 0.039 cell drew no warning). Only when clearly flat or slender.
    expect(P.box(1, 0.1, 1).feature).toBeCloseTo(0.1);
    expect(P.box(0.05, 2, 0.3).feature).toBeCloseTo(0.05);
    expect(P.box(1, 0.3, 1).feature).toBeUndefined();
    expect(P.cylinder(1, 0.1).feature).toBeCloseTo(0.1);
    expect(P.cylinder(0.05, 3).feature).toBeCloseTo(0.1);
    expect(P.cylinder(1, 2).feature).toBeUndefined();
    expect(P.cone(0.02, 0, 0.5).feature).toBeCloseTo(0.04);
    expect(P.cone(1, 0.8, 0.1).feature).toBeCloseTo(0.1);
    expect(P.cone(0.5, 0.2, 1).feature).toBeUndefined();
    expect(O.union([P.box(0.5, 0.5, 0.5), P.box(1, 0.02, 1)]).feature).toBeCloseTo(0.02);
  });
});

describe("clearance", () => {
  it("is the gap between two surfaces, negative by the overlap, zero at a touch", () => {
    expect(C_.clearance(P.sphere(1), O.move(P.sphere(1), 3, 0, 0))).toBeCloseTo(1, 3);
    expect(C_.clearance(P.sphere(1), O.move(P.sphere(1), 1.5, 0, 0))).toBeCloseTo(-0.5, 3);
    expect(Math.abs(C_.clearance(P.box(1, 1, 1), O.move(P.box(1, 1, 1), 1, 0, 0)))).toBeLessThan(1e-3);
    // A thin plate beside a rod: the lattice over the plate's box has no point near its face, so every point projects.
    expect(C_.clearance(P.box(2, 0.02, 2), O.move(P.cylinder(0.1, 1), 0, 0.6, 0))).toBeCloseTo(0.09, 2);
    expect(C_.clearance(P.empty(), P.sphere(1))).toBe(Infinity);
  });
});

describe("slice levels", () => {
  it("put the planes through a part's solid, not its box's centre, and through its widest section when the centroid misses", () => {
    // A lamp: a thin post at x = 0 and a heavy globe out at x = 1.2 on top. The box's centre (x 0.78) is in the air
    // between them; the centroid is in the globe.
    const lamp = O.union([P.cylinder(0.05, 2), O.move(P.sphere(0.4), 1.2, 1, 0)]);
    const cuts = (level: number) => { for (let y = -1; y <= 1.4; y += 0.02) for (let z = -0.4; z <= 0.4; z += 0.02) if (lamp.dist(level, y, z) < 0) return true; return false; };
    const box = lamp.bounds;
    expect(cuts((box.min[0] + box.max[0]) / 2)).toBe(false);
    const lv = C_.sliceLevels(lamp)!;
    expect(cuts(lv.at[0])).toBe(true);
    expect(lv.at[0]).toBeGreaterThan(0.9);
    // A ring lying flat: the centroid is in its hole on every axis; y keeps it (the tube's middle), x and z move
    // to a section through the tube only if the centre's cut is under half the widest.
    const ring = P.torus(1, 0.1);
    const rl = C_.sliceLevels(ring)!;
    expect(Math.abs(rl.at[1])).toBeLessThan(0.05);
    // Through the centroid (the hole) a vertical plane cuts the tube twice across, far less than half of a cut along
    // it near x = ±1, so x and z go there.
    expect(Math.abs(rl.centroid[0])).toBeLessThan(0.05);
    expect(Math.abs(rl.at[0])).toBeGreaterThan(0.85);
    expect(Math.abs(rl.at[2])).toBeGreaterThan(0.85);
    expect(C_.sliceLevels(P.empty())).toBeUndefined();
  });
});

describe("void, overlap and inside", () => {
  it("find solid in a region, the shared volume of two parts, and how much of one lies in another", () => {
    const cup = O.difference(P.cylinder(1, 2), O.move(P.cylinder(0.85, 2), 0, 0.2, 0));
    const cavity = O.move(P.cylinder(0.85, 2), 0, 0.2, 0);
    // The cup's wall holds nothing in the cavity; a handle reaching to x = 0.5 does.
    expect(C_.isVoid(cavity, cup)).toBe(true);
    const intruder = O.move(P.box(0.6, 0.2, 0.2), 0.8, 0.5, 0);
    expect(C_.isVoid(cavity, O.union([cup, intruder]))).toBe(false);
    // A thin pin through the void, thinner than the lattice, is still caught through the surface.
    const pin = O.move(P.box(2, 0.01, 0.01), 0, 0.5, 0);
    expect(C_.isVoid(cavity, O.union([cup, pin]))).toBe(false);
    expect(C_.isVoid(P.empty(), cup)).toBe(true);
    // Two unit boxes overlapping by half share half a unit of volume; touching, none.
    expect(C_.overlapVolume(P.box(1, 1, 1), O.move(P.box(1, 1, 1), 0.5, 0, 0))).toBeCloseTo(0.5, 2);
    expect(C_.overlapVolume(P.box(1, 1, 1), O.move(P.box(1, 1, 1), 1, 0, 0))).toBe(0);
    expect(C_.overlapVolume(P.box(1, 1, 1), O.move(P.box(1, 1, 1), 3, 0, 0))).toBe(0);
    // The language guide's worked number for a curved part: a ring's band (a torus of radius 0.42, tube 0.065)
    // standing on a flat cushion and sunk 0.03 into it shares about 0.00047; a band half that size shares less.
    const band = (r: number) => O.move(O.rotate(P.torus(r, 0.065), -90, 0, 0), 0, 0.41 - 0.03 + r + 0.065, 0);
    const cushion = O.move(P.box(1.3, 0.34, 0.8), 0, 0.24, 0);
    expect(C_.overlapVolume(band(0.42), cushion)).toBeCloseTo(0.00047, 5);
    expect(C_.overlapVolume(band(0.2), cushion)).toBeLessThan(0.0004);
    // A small box wholly inside a big one is all inside; half out is half.
    expect(C_.insideFraction(P.box(0.5, 0.5, 0.5), P.box(2, 2, 2))).toBe(1);
    expect(C_.insideFraction(P.box(1, 1, 1), O.move(P.box(1, 1, 1), 0.5, 0, 0))).toBeCloseTo(0.5, 2);
    expect(C_.insideFraction(P.box(1, 1, 1), O.move(P.box(1, 1, 1), 5, 0, 0))).toBe(0);
  });
});

describe("curves", () => {
  it("measures the tightest bend and notes a tube thicker than it", () => {
    expect(C.minBendRadius(C.bezierCurve([[0, 0, 0], [1, 0, 0], [3, 0, 0], [4, 0, 0]]))).toBe(Infinity);
    const k = 0.5523 * 2;
    const arc = C.bezierCurve([[2, 0, 0], [2, k, 0], [k, 2, 0], [0, 2, 0]]);
    expect(Math.abs(C.minBendRadius(arc) - 2)).toBeLessThan(0.1);
    expect(C.tubeCurve(arc, 0.5).notes).toBeUndefined();
    expect(C.tubeCurve(arc, 2.5).notes?.[0]).toMatch(/bends to a radius of [\d.]+, tighter than the tube's 2.5/);
  });
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

describe("smooth profiles", () => {
  const k = 0.5523;
  /** A circle of radius r from four Bezier quarters with the standard handle length, closed on its first anchor. */
  const bezierCircle = (r: number) => C2.bezier2([r, 0, r, k * r, k * r, r, 0, r, -k * r, r, -r, k * r, -r, 0, -r, -k * r, -k * r, -r, 0, -r, k * r, -r, r, -k * r, r, 0]);
  const ringOf = (n: number, r = 1) => Array.from({ length: n }, (_, i) => [r * Math.cos((i / n) * 2 * Math.PI), r * Math.sin((i / n) * 2 * Math.PI)]).flat();
  // A vase's wall as one closed outline: the axis and the foot's edge given twice (corners), the rest smooth.
  const vasePts = [0, 0, 0, 0, 1, 0, 1, 0, 1.3, 0.5, 1.45, 1.3, 1.25, 2.3, 0.85, 3, 0.8, 3.5, 1.05, 4, 0.98, 4.06, 0.92, 4, 0.68, 3.5, 0.74, 3, 1.12, 2.3, 1.3, 1.3, 1.12, 0.5, 0.85, 0.2, 0, 0.2, 0, 0.2];

  it("a bezier2 circle with handles 0.5523 r is within 0.03% of the radius, negative inside, positive outside", () => {
    const c = bezierCircle(2);
    for (let i = 0; i < 360; i++) {
      const a = (i / 360) * 2 * Math.PI;
      expect(Math.abs(c.dist(2 * Math.cos(a), 2 * Math.sin(a)))).toBeLessThan(2 * 3e-4);
      expect(Math.abs(c.dist(1.5 * Math.cos(a), 1.5 * Math.sin(a)) + 0.5)).toBeLessThan(2 * 3e-4);
      expect(Math.abs(c.dist(3 * Math.cos(a), 3 * Math.sin(a)) - 1)).toBeLessThan(2 * 3e-4);
    }
    expect(c.dist(0, 0)).toBeCloseTo(-2, 3);
    // Tight bounds: the curve's own extent, not its handles'.
    expect(c.bounds.min[0]).toBeCloseTo(-2, 9);
    expect(c.bounds.max[1]).toBeCloseTo(2, 9);
    expect(c.feature).toBeCloseTo(4, 3);
  });
  it("a curve2 through points of a circle is within its spline error, which is far under the polygon's", () => {
    for (const n of [8, 16]) {
      const pts = ringOf(n);
      const c = C2.curve2(pts);
      let dev = 0;
      for (const [x, y] of C2.chainPoints(C2.chainThrough(pts, true), 200)) dev = Math.max(dev, Math.abs(Math.hypot(x, y) - 1));
      // Measured: 8.5e-3 through 8 points and 5.5e-4 through 16, against 7.6e-2 and 1.9e-2 for the polygons' sagitta.
      expect(dev).toBeLessThan(n === 8 ? 9e-3 : 6e-4);
      for (let i = 0; i < 720; i++) {
        const a = (i / 720) * 2 * Math.PI;
        expect(Math.abs(c.dist(Math.cos(a), Math.sin(a)))).toBeLessThanOrEqual(dev + 1e-9);
      }
      for (let i = 0; i < n; i++) expect(Math.abs(c.dist(pts[i * 2], pts[i * 2 + 1]))).toBeLessThan(1e-9);
    }
  });
  it("is the exact distance to the curve, signed by which side, with a gradient of length 1 near it", () => {
    const chain = C2.chainThrough(vasePts, true);
    const vase = C2.curve2(vasePts);
    const dense = C2.chainPoints(chain, 2000);
    const poly = S.polygon(dense.slice(0, -1).flat());
    let seed = 7;
    const rnd = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
    for (let i = 0; i < 300; i++) {
      const x = -0.5 + rnd() * 2.5, y = -0.5 + rnd() * 5;
      const d = vase.dist(x, y), p = poly.dist(x, y);
      // The dense polygon is within its sagitta (well under 1e-6 here) of the curve.
      expect(Math.abs(d - p)).toBeLessThan(1e-6);
    }
    for (let i = 0; i < 400; i++) {
      const x = -0.2 + rnd() * 1.9, y = -0.2 + rnd() * 4.5;
      const d = vase.dist(x, y);
      if (Math.abs(d) > 0.05 || Math.abs(d) < 1e-3) continue;
      const h = 1e-5;
      const g = Math.hypot(vase.dist(x + h, y) - vase.dist(x - h, y), vase.dist(x, y + h) - vase.dist(x, y - h)) / (2 * h);
      expect(g).toBeCloseTo(1, 3);
    }
    // A long outline searches through a grid and counts crossings by height bands: the same exact field.
    const wavy: number[] = [];
    for (let i = 0; i < 90; i++) { const a = (i / 90) * 2 * Math.PI, r = 1 + 0.1 * Math.sin(9 * a); wavy.push(r * Math.cos(a), r * Math.sin(a)); }
    const long = C2.curve2(wavy), longPoly = S.polygon(C2.chainPoints(C2.chainThrough(wavy, true), 200).slice(0, -1).flat());
    for (let i = 0; i < 300; i++) {
      const x = -1.6 + rnd() * 3.2, y = -1.6 + rnd() * 3.2;
      expect(Math.abs(long.dist(x, y) - longPoly.dist(x, y))).toBeLessThan(1e-6);
    }
    // The underside runs straight between its two corners.
    expect(vase.dist(0.5, 0.02)).toBeCloseTo(-0.02, 9);
    expect(vase.dist(0.5, -0.1)).toBeCloseTo(0.1, 9);
    expect(vase.dist(0.5, 1)).toBeGreaterThan(0);
  });
  it("finds the nearest point in every basin of a piece, not only round its nearest sample", () => {
    // A teardrop drawn as one piece from its point and back: beside the point the scan's nearest sample is the start,
    // and the nearest point is near the end. Searching round the nearest sample alone read 0.28 there, against 0.015.
    const b = [0, 0, 1.5, 1.5, -1.5, 1.5, 0, 0];
    const drop = C2.bezier2(b);
    const dropPoly = S.polygon(C2.chainPoints(C2.chainFromBezier(b, true), 4000).slice(0, -1).flat());
    expect(drop.dist(-0.2, 0.2)).toBeCloseTo(dropPoly.dist(-0.2, 0.2), 6);
    for (let i = 0; i < 30; i++)
      for (let j = 0; j < 30; j++) {
        const x = -0.6 + (1.2 * (i + 0.5)) / 30, y = -0.2 + (1.4 * (j + 0.5)) / 30;
        expect(Math.abs(drop.dist(x, y) - dropPoly.dist(x, y))).toBeLessThan(1e-6);
      }
    // Inside the example vase's mouth, a sample whose nearest point is in a shallow basin away from the lowest sample
    // (5.6e-5 too far before).
    const ex = [0, 0, 0, 0, 1.0, 0, 1.0, 0, 1.18, 0.3, 1.45, 1.2, 1.3, 2.2, 0.9, 2.9, 0.8, 3.4, 1.0, 3.8, 1.06, 4.0, 0.985, 4.06, 0.91, 4.0, 0.85, 3.8, 0.68, 3.4, 0.78, 2.9, 1.15, 2.2, 1.3, 1.2, 1.05, 0.38, 0.8, 0.22, 0, 0.22, 0, 0.22];
    const exPoly = S.polygon(C2.chainPoints(C2.chainThrough(ex, true), 2000).slice(0, -1).flat());
    expect(Math.abs(C2.curve2(ex).dist(0.4823, 3.9417) - exPoly.dist(0.4823, 3.9417))).toBeLessThan(1e-6);
  });
  it("carries bounds that contain the curve and touch it, and a feature for a wall drawn as an outline", () => {
    const chain = C2.chainThrough(vasePts, true);
    const vase = C2.curve2(vasePts);
    const b = vase.bounds;
    const pts = C2.chainPoints(chain, 64);
    for (const [x, y] of pts) {
      expect(x).toBeGreaterThanOrEqual(b.min[0] - 1e-12);
      expect(x).toBeLessThanOrEqual(b.max[0] + 1e-12);
      expect(y).toBeGreaterThanOrEqual(b.min[1] - 1e-12);
      expect(y).toBeLessThanOrEqual(b.max[1] + 1e-12);
    }
    expect(Math.max(...pts.map((p) => p[0]))).toBeCloseTo(b.max[0], 4);
    expect(b.min[0]).toBe(0);
    // A band 0.05 thick drawn out along an arc and back along a smaller one: its wall, not its box.
    const band = [...ringOf(16).slice(0, 18), ...ringOf(16, 0.95).slice(0, 18).reverse().flatMap((_, i, r) => (i % 2 === 0 ? [r[i + 1], r[i]] : []))];
    expect(C2.curve2(band).feature).toBeCloseTo(0.05, 2);
    // Sharp tips are corners, not walls: a leaf 0.4 wide reads near its width.
    expect(C2.curve2([0, 0, 0, 0, 0.5, 0.15, 1, 0.2, 1.5, 0.15, 2, 0, 2, 0, 1.5, -0.15, 1, -0.2, 0.5, -0.15]).feature).toBeGreaterThan(0.3);
    // A wall carries itself; a profile closed along the axis carries nothing from the axis.
    expect(C2.curve2([0, 0, 1, 0, 2, 1], 0.08).feature).toBe(0.08);
    expect(C2.bezier2([0, -1, k, -1, 1, -k, 1, 0, 1, k, k, 1, 0, 1]).feature).toBeUndefined();
    expect(S.revolve(C2.curve2(vasePts)).feature).toBeCloseTo(vase.feature!, 9);
  });
  it("a point given twice is a corner, the run between two corners is straight, and a closing point is only that", () => {
    const sq = C2.curve2([0, 0, 0, 0, 1, 0, 1, 0, 1, 1, 1, 1, 0, 1, 0, 1]);
    expect(sq.dist(0.5, 0.5)).toBeCloseTo(-0.5, 9);
    expect(sq.dist(1.5, 0.5)).toBeCloseTo(0.5, 9);
    expect(sq.dist(1.5, 1.5)).toBeCloseTo(Math.SQRT2 / 2, 9);
    expect(sq.bounds).toEqual({ min: [0, 0], max: [1, 1] });
    const open = C2.curve2([1, 0, 0, 1, -1, 0, 0, -1]), closed = C2.curve2([1, 0, 0, 1, -1, 0, 0, -1, 1, 0]);
    expect(closed.dist(1.1, 0.1)).toBe(open.dist(1.1, 0.1));
    expect(C2.curve2([1, 0, 0, 1, -1, 0, 0, -1, 1, 0, 1, 0]).dist(1.1, 0.1)).not.toBeCloseTo(open.dist(1.1, 0.1), 3);
    expect(C2.curve2([1, 0, 1, 0, 0, 1, -1, 0, 0, -1]).dist(1.1, 0.1)).toBeCloseTo(C2.curve2([1, 0, 0, 1, -1, 0, 0, -1, 1, 0, 1, 0]).dist(1.1, 0.1), 12);
  });
  it("bezier2 closes with a straight edge back to the first anchor, and says what a malformed list is", () => {
    // A half disc drawn from the axis round to the axis: the straight edge closes it along x = 0.
    const d = C2.bezier2([0, -1, k, -1, 1, -k, 1, 0, 1, k, k, 1, 0, 1]);
    expect(d.dist(0.5, 0)).toBeCloseTo(-0.5, 3);
    expect(d.dist(-0.1, 0)).toBeCloseTo(0.1, 9);
    expect(d.bounds.min[0]).toBe(0);
    // Revolved, it is a sphere of radius 1 to the Bezier circle's error.
    const ball = S.revolve(d);
    expect(Math.abs(ball.dist(0, 0, 1))).toBeLessThan(3e-4);
    expect(Math.abs(ball.dist(0.6, 0.8, 0))).toBeLessThan(3e-4);
    expect(() => C2.bezier2([0, 0, 1, 0, 1])).toThrow(/x, y pairs, got 5 numbers/);
    expect(() => C2.bezier2([0, 0, 1, 0, 1, 1, 0, 1, 0, 0])).toThrow(/4, 7, 10, \.\.\. x, y pairs .* got 5 pairs/);
    expect(() => C2.curve2([0, 0, 1, 0, 1, 0, 0, 0])).toThrow(/at least 3 different points/);
    expect(() => C2.bezier2([0, 0, 0, 0, 0, 0, 0, 0])).toThrow(/piece 1 has all four points/);
  });
  it("a self-crossing outline is filled even-odd, as polygon is", () => {
    const eight = C2.curve2([0, 0, 1, 0.8, 2, 0, 1, -0.8, 0, 0, -1, 0.8, -2, 0, -1, -0.8]);
    expect(eight.dist(1, 0)).toBeLessThan(0);
    expect(eight.dist(-1, 0)).toBeLessThan(0);
    expect(eight.dist(0, 0.5)).toBeGreaterThan(0);
    const star: number[] = [];
    for (let i = 0; i < 5; i++) { const a = ((i * 2) / 5) * 2 * Math.PI + Math.PI / 2; star.push(Math.cos(a), Math.sin(a)); }
    expect(C2.curve2(star).dist(0, 0)).toBeGreaterThan(0);
    expect(C2.curve2(star).dist(0, 0.8)).toBeLessThan(0);
  });
  it("a wall makes the open curve a band with round ends", () => {
    const w = C2.curve2([0, 0, 1, 0, 2, 1], 0.2);
    expect(w.dist(-0.1, 0)).toBeCloseTo(0, 9);
    expect(w.dist(-0.3, 0)).toBeCloseTo(0.2, 9);
    expect(w.dist(2, 1)).toBeCloseTo(-0.1, 9);
    const b = C2.bezier2([0, 0, 1, 0, 2, 0, 3, 0], 0.1);
    expect(b.dist(1.5, 0.05)).toBeCloseTo(0, 9);
    expect(b.dist(1.5, 0)).toBeCloseTo(-0.05, 9);
    expect(b.bounds).toEqual({ min: [-0.05, -0.05], max: [3.05, 0.05] });
    // language.md's cup: the heel is a corner of the line, so the band is sharp inside it and round outside it, by
    // half the wall (a point 0.07 out from the corner along the outer bisector is 0.02 outside).
    const cup = C2.curve2([0, 0.05, 0.9, 0.05, 0.9, 0.05, 1.2, 1, 0.8, 2.4], 0.1);
    const ox = 0.953, oy = -1.301, ol = Math.hypot(ox, oy);
    expect(cup.dist(0.9 + (0.07 * ox) / ol, 0.05 + (0.07 * oy) / ol)).toBeCloseTo(0.02, 3);
  });
  it("a polygon's edge on the axis is left out of a full revolve too, so a shelled lathe has no rod up its middle", () => {
    // The teapot's body: shell() of a revolved polygon closed along x = 0 left a hollow rod of the wall's thickness up
    // the axis, in every slice, since the plain distance is zero all along it.
    const body = S.polygon([0, 0, 1.6, 0, 2.1, 0.7, 2.05, 1.5, 1.4, 2.3, 1.15, 2.5, 0, 2.5]);
    expect(body.dist(0, 1)).toBeCloseTo(0, 9);
    const solid = S.revolve(body);
    expect(solid.dist(0, 1, 0)).toBeCloseTo(-1, 6);
    expect(solid.dist(0.01, 1.2, 0)).toBeCloseTo(-1.2, 6);
    const pot = O.shell(solid, 0.08);
    expect(pot.dist(0, 1.25, 0)).toBeGreaterThan(0.5);
    // Outside the solid it is the same distance as before; a partial revolve keeps the axis as its wedge's edge.
    expect(solid.dist(3, 1, 0)).toBeCloseTo(S.revolve(S.move2(body, 0, 0), 0, 360).dist(3, 1, 0), 9);
    expect(solid.dist(3, 1, 0)).toBeCloseTo(body.dist(3, 1), 9);
    expect(S.revolve(body, 0, 180).dist(0, 1, 0.001)).toBeCloseTo(body.dist(0.001, 1), 9);
    // An outline reaching past the axis is not a lathe profile: its edge on x = 0 is kept.
    expect(S.polygon([-1, 0, 0, 0, 0, 1, -1, 1]).revolveDist).toBeUndefined();
    expect(S.polygon([0, 0, 1, 0, 0, 1]).revolveDist).toBeDefined();
    // A wall a few cells thick meshes as two closed surfaces and nothing up the middle.
    expect(isWatertight(surfaceNets(O.shell(solid, 0.3), { resolution: 64 }).mesh)).toBe(true);
  });
  it("works wherever a profile does, and a revolve of one is exact and meshes watertight", () => {
    const vase = C2.curve2(vasePts);
    const solid = S.revolve(vase);
    expect(solid.bound).toBeUndefined();
    expect(solid.dist(0, 0.02, 0.5)).toBeCloseTo(-0.02, 9);
    // The run up the axis is inside the solid once spun: no zero along the axis (a line in the slices, a surface to
    // the glass march), where the plain profile is zero on it. A moved profile has no axis, and keeps its distance.
    expect(vase.dist(0, 0.1)).toBeCloseTo(0, 9);
    expect(solid.dist(0, 0.1, 0)).toBeCloseTo(-0.1, 9);
    expect(solid.dist(0.001, 0.12, 0)).toBeCloseTo(-0.08, 6);
    expect(S.move2(vase, 0.5, 0).revolveDist).toBeUndefined();
    // So does a boolean (language.md: cut a groove after the revolve): its axis run is a zero again.
    expect(S.difference2(vase, S.move2(S.circle(0.1), 1.3, 1)).revolveDist).toBeUndefined();
    expect(S.revolve(S.difference2(vase, S.move2(S.circle(0.1), 1.3, 1))).dist(0, 0.1, 0)).toBeCloseTo(0, 9);
    expect(S.revolve(vase, 0, 180).dist(0, 0.1, 0.001)).toBeCloseTo(vase.dist(0.001, 0.1), 9);
    const r = surfaceNets(solid, { resolution: 64 });
    expect(isWatertight(r.mesh)).toBe(true);
    const mb = meshBounds(r.mesh);
    expect(mb.max[1]).toBeCloseTo(vase.bounds.max[1], 1);
    expect(mb.max[0]).toBeCloseTo(vase.bounds.max[0], 1);
    // Extrude, booleans, offset and loft take it like any profile.
    const c = C2.curve2(ringOf(12));
    expect(S.extrude(c, 0.5, "z").dist(0, 0, 0)).toBeCloseTo(-0.25, 6);
    expect(S.difference2(c, S.circle(0.5)).dist(0, 0)).toBeCloseTo(0.5, 6);
    expect(S.offset2(c, 0.1).dist(1.1, 0)).toBeCloseTo(0, 6);
    expect(W.loft(c, S.circle(0.5), 1).dist(0, 0, 0)).toBeLessThan(0);
    const sw = C.sweepCurve(C2.bezier2([0.1, 0, 0.1, 0.05, 0.05, 0.1, 0, 0.1, -0.05, 0.1, -0.1, 0.05, -0.1, 0, -0.1, -0.05, -0.05, -0.1, 0, -0.1, 0.05, -0.1, 0.1, -0.05, 0.1, 0]), C.bezierCurve([[0, 0, 0], [1, 0, 0], [2, 0, 0], [3, 0, 0]]));
    expect(sw.dist(1.5, 0, 0)).toBeCloseTo(-0.1, 2);
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
    // A joint can also move and scale its part: scale about the pivot, then turn, then move (the glTF order).
    const k = O.joint(boom, "hinge", 0, 1, 0, [0, 0, 90], undefined, [0.5, 0, 0], [1, 2, 1]);
    // The lug at y 2.6 is 1.6 above the pivot, doubled to 3.2, turned to x -3.2, moved by 0.5: (-2.7, 1).
    const w = k.warp!(0, 2.6, 0);
    expect(w[0]).toBeCloseTo(-2.7, 5);
    expect(w[1]).toBeCloseTo(1, 5);
    expect(k.dist(-2.7, 1, 0)).toBeLessThan(0);
    const back = k.unwarp!(-2.7, 1, 0);
    expect(back[0]).toBeCloseTo(0, 5);
    expect(back[1]).toBeCloseTo(2.6, 5);
    const kb = O.placedBounds(k, lug, lug.bounds)!;
    expect(kb.min[0]).toBeLessThanOrEqual(-2.7 - 0.2 + 1e-9);
    expect(kb.max[1]).toBeGreaterThanOrEqual(1 + 0.2 - 1e-9);
    expect(k.joint!.move).toEqual([0.5, 0, 0]);
    expect(k.joint!.scale).toEqual([1, 2, 1]);
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

describe("round-11 findings", () => {
  // A head laid along z, 3 long, with a plate 0.03 thick across it hanging below: the plate's z lies between two of
  // the 48 rays a side, so the rays from below and from the sides slip past it.
  const head = () => O.rotate(P.cylinder(0.5, 3), 90, 0, 0);
  const plate = () => O.move(P.box(3, 2.5, 0.03), 0, -1.25, 0);
  it("the surface's extent keeps a thin plate the rays slip between, measured on the plate's own box", () => {
    const rig = O.joint(O.union([head(), plate()]), "tilt", 0, 0, 0);
    const rays = O.surfaceExtent(rig, 48);
    // What the rays alone see: the head without its plate (round 11: a joint's surface line left out the beater).
    expect(rays.min[1]).toBeGreaterThan(-0.6);
    const deep = O.surfaceExtentDeep(rig);
    expect(deep.min[1]).toBeCloseTo(-2.5, 2);
    expect(deep.min[0]).toBeCloseTo(-1.5, 2);
    expect(deep.max[0]).toBeCloseTo(1.5, 2);
    // Never past the box, and the head's own extent stands.
    expect(deep.max[1]).toBeCloseTo(0.5, 2);
    expect(deep.min[2]).toBeCloseTo(-1.5, 2);
  });
  it("places a hard union folded into a larger one where its parts are, so it has a posed extent", () => {
    // `hinged = head + knuckle` read by `joint(hinged + nose, ...)`: the union of unions is one flat list, so hinged is
    // no node of the joint's tree, only its parts are.
    const knuckle = O.move(P.sphere(0.2), 0, 0, -1.5);
    const hinged = O.union([head(), knuckle]);
    const nose = O.move(P.sphere(0.3), 0, 0, 1.6);
    const turned = O.joint(O.union([hinged, nose]), "tilt", 0, 0, -1.5, [-90, 0, 0]);
    const placed = O.placedShape(turned, hinged)!;
    expect(placed).toBeDefined();
    // Turned -90 degrees about x at the back, the head stands up: its far end is 3 above the pivot.
    expect(O.surfaceExtent(placed, 48).max[1]).toBeCloseTo(3, 1);
  });
});
