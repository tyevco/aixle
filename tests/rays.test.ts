import { describe, expect, it } from "vitest";
import v8 from "node:v8";
import vm from "node:vm";
import { normalize, type Vec3 } from "../src/core/vec.js";
import { parse } from "../src/lang/parser.js";
import { evaluate } from "../src/lang/interpreter.js";
import type { Mesh } from "../src/mesh/mesh.js";
import { surfaceNets } from "../src/mesh/surfaceNets.js";
import { box, cylinder, sphere, torus } from "../src/sdf/primitives.js";
import { move, paint, rotate, union } from "../src/sdf/ops.js";
import { materialFromString } from "../src/sdf/materials.js";
import { boundsSize, type Bounds, type Material, type Shape3 } from "../src/sdf/types.js";
import { perspective } from "../src/render/camera.js";
import { lightDirection } from "../src/render/beauty.js";
import { ALL, buildBvh, bvhFor, BvhTracer, GLASS, OPAQUE, triangleIsGlass, type BvhData } from "../src/render/bvh.js";
import { createRays, hash01, pixelKey, type RayLight, type Rays } from "../src/render/rays.js";
import { filterRadius, filterVisibility, filterVisibilityRows, FLAG_EDGE, KIND_FLOOR, KIND_MODEL, KIND_SKY, type FilterGuides } from "../src/render/denoise.js";

// ---- fixtures ----

/** A program's shown shape, meshed at `res` cells along its longest side. */
function program(source: string, res = 64): { shape: Shape3; mesh: Mesh; cell: number; box: Bounds; reach: number } {
  const shape = evaluate(parse(source)).output!;
  const nets = surfaceNets(shape, { resolution: res });
  const b = shape.bounds;
  return { shape, mesh: nets.mesh, cell: nets.cellSize, box: b, reach: Math.hypot(...boundsSize(b)) * 1.5 };
}

const PROGRAMS: Record<string, string> = {
  // Thin bars between two plates, the lantern's hard case: parts under two cells thick.
  cage: `plate = cylinder(1, 0.12) | paint("iron")
bars = cylinder(0.05, 1.6) | move(0.85, 0.86, 0) | ring(10) | paint("iron")
top = plate | move(0, 1.7, 0)
post = cylinder(0.25, 0.9) | move(0, 0.5, 0) | paint("clay")
show (plate + bars + top + post) | ground()`,
  // A turned piece: a revolved profile, a collar and a ball, all curves.
  pawn: `body = revolve(polygon(0,0, 0.7,0, 0.7,0.15, 0.35,0.35, 0.22,1.1, 0,1.1)) | paint("wood")
collar = torus(0.3, 0.07) | move(0, 1.05, 0) | paint("wood")
head = sphere(0.32) | move(0, 1.4, 0) | paint("wood")
show (body + collar + head) | ground()`,
  // Relief lettering on a disc, the medal's: small raised detail on a flat face.
  relief: `disc = revolve(polygon(0,0, 1.5,0, 1.5,0.14, 1.32,0.2, 0,0.2)) | rotate(x=90) | paint("gold")
word = extrude(text("RAYS", size=0.5, weight=0.12), 0.1, "z") | move(0, 0, 0.25) | paint("brass")
star_ = extrude(star(5, 0.35, 0.15), 0.1, "z") | move(0, -0.75, 0.25) | paint("brass")
show (disc + word + star_) | ground()`,
};

/** What each pixel of a small camera sees: the field marched from the eye, else the floor (y = min(0, model)), else the sky. */
function pixels(f: ReturnType<typeof program>, rays: Rays, size = 96) {
  const cam = perspective(f.box, size, size, 35, 25, 30, 1, f.mesh.positions);
  const fl = size / 2 / Math.tan(((cam.fov ?? 30) * Math.PI) / 360);
  const floorY = Math.min(0, f.box.min[1]);
  const n = size * size;
  const P = new Float64Array(n * 3), N = new Float64Array(n * 3), D = new Float64Array(n * 3), kind = new Uint8Array(n);
  const eps = f.cell * 0.5, dist = f.shape.dist;
  for (let py = 0; py < size; py++)
    for (let px = 0; px < size; px++) {
      const i = py * size + px;
      const x = (px + 0.5 - size / 2) / fl, y = -(py + 0.5 - size / 2) / fl;
      const d = normalize([cam.right[0] * x + cam.up[0] * y + cam.forward[0], cam.right[1] * x + cam.up[1] * y + cam.forward[1], cam.right[2] * x + cam.up[2] * y + cam.forward[2]]);
      D.set(d, i * 3);
      const t = rays.fieldClosest(cam.eye[0], cam.eye[1], cam.eye[2], d[0], d[1], d[2], Infinity);
      if (t >= 0) {
        const p: Vec3 = [cam.eye[0] + d[0] * t, cam.eye[1] + d[1] * t, cam.eye[2] + d[2] * t];
        P.set(p, i * 3);
        N.set(normalize([dist(p[0] + eps, p[1], p[2]) - dist(p[0] - eps, p[1], p[2]), dist(p[0], p[1] + eps, p[2]) - dist(p[0], p[1] - eps, p[2]), dist(p[0], p[1], p[2] + eps) - dist(p[0], p[1], p[2] - eps)]), i * 3);
        kind[i] = KIND_MODEL;
      } else if (d[1] < -1e-6) {
        const tf = (floorY - cam.eye[1]) / d[1];
        P.set([cam.eye[0] + d[0] * tf, floorY, cam.eye[2] + d[2] * tf], i * 3);
        N[i * 3 + 1] = 1;
        kind[i] = KIND_FLOOR;
      }
    }
  return { size, P, N, D, kind };
}

/** A deterministic uniform in [0, 1) for test rays. */
const u = (i: number, k: number) => hash01(i, k + 7919);

// ---- the BVH ----

/**
 * Brute force over every triangle, with the BVH's own arithmetic on the same float32 vertex-and-edges data: the
 * nearest hit in (tmin, tmax) among all triangles, the opaque ones and the glass ones (the lowest index on a tie).
 */
function brute(mesh: Mesh, glass: Uint8Array, o: Vec3, d: Vec3, tmin: number, tmax: number): { id: number; t: number }[] {
  const P = mesh.positions, I = mesh.indices;
  const out = [{ id: -1, t: tmax }, { id: -1, t: tmax }, { id: -1, t: tmax }];
  for (let t = 0; t < I.length / 3; t++) {
    const a = I[t * 3] * 3, b = I[t * 3 + 1] * 3, c = I[t * 3 + 2] * 3;
    const e1x = Math.fround(P[b] - P[a]), e1y = Math.fround(P[b + 1] - P[a + 1]), e1z = Math.fround(P[b + 2] - P[a + 2]);
    const e2x = Math.fround(P[c] - P[a]), e2y = Math.fround(P[c + 1] - P[a + 1]), e2z = Math.fround(P[c + 2] - P[a + 2]);
    const px = d[1] * e2z - d[2] * e2y, py = d[2] * e2x - d[0] * e2z, pz = d[0] * e2y - d[1] * e2x;
    const det = e1x * px + e1y * py + e1z * pz;
    if (det > -1e-12 && det < 1e-12) continue;
    const inv = 1 / det;
    const sx = o[0] - P[a], sy = o[1] - P[a + 1], sz = o[2] - P[a + 2];
    const uu = (sx * px + sy * py + sz * pz) * inv;
    if (uu < 0 || uu > 1) continue;
    const qx = sy * e1z - sz * e1y, qy = sz * e1x - sx * e1z, qz = sx * e1y - sy * e1x;
    const v = (d[0] * qx + d[1] * qy + d[2] * qz) * inv;
    if (v < 0 || uu + v > 1) continue;
    const tt = (e2x * qx + e2y * qy + e2z * qz) * inv;
    if (!(tt > tmin)) continue;
    for (const k of [0, glass[t] ? 2 : 1]) if (tt < out[k].t) { out[k].t = tt; out[k].id = t; }
  }
  return out;
}

/** The same triangle's hit distance in double precision from the mesh's own vertices (no shared arithmetic). */
function exactT(mesh: Mesh, tri: number, o: Vec3, d: Vec3): number {
  const P = mesh.positions, I = mesh.indices;
  const a = I[tri * 3] * 3, b = I[tri * 3 + 1] * 3, c = I[tri * 3 + 2] * 3;
  const n = normalize([
    (P[b + 1] - P[a + 1]) * (P[c + 2] - P[a + 2]) - (P[b + 2] - P[a + 2]) * (P[c + 1] - P[a + 1]),
    (P[b + 2] - P[a + 2]) * (P[c] - P[a]) - (P[b] - P[a]) * (P[c + 2] - P[a + 2]),
    (P[b] - P[a]) * (P[c + 1] - P[a + 1]) - (P[b + 1] - P[a + 1]) * (P[c] - P[a]),
  ]);
  return (n[0] * (P[a] - o[0]) + n[1] * (P[a + 1] - o[1]) + n[2] * (P[a + 2] - o[2])) / (n[0] * d[0] + n[1] * d[1] + n[2] * d[2]);
}

function bvhMeshes(): { name: string; mesh: Mesh }[] {
  const glass = materialFromString("glass")!, iron = materialFromString("iron")!, amber = materialFromString("amber")!;
  return [
    { name: "sphere", mesh: surfaceNets(sphere(1), { resolution: 20 }).mesh },
    // Glass and opaque parts, so the flags and the filtered queries have both to tell apart.
    { name: "glass and iron", mesh: surfaceNets(union([paint(box(1.2, 0.4, 1.2), iron), paint(move(torus(0.7, 0.18), 0, 0.5, 0), glass), paint(move(sphere(0.3), 0, 0.9, 0), amber)]), { resolution: 24 }).mesh },
    // Thin parts and many small triangles.
    { name: "bars", mesh: surfaceNets(union([0, 1, 2, 3, 4, 5].map((k) => rotate(move(cylinder(0.06, 2), 0.5, 0, 0), 0, k * 30, k * 7))), { resolution: 30 }).mesh },
  ];
}

describe("bvh", () => {
  const meshes = bvhMeshes();
  it("finds the same triangle as brute force, closest and any-hit, on 10,000 rays a mesh", () => {
    for (const { name, mesh } of meshes) {
      const bvh = buildBvh(mesh);
      const tr = new BvhTracer(bvh);
      const P = mesh.positions, I = mesh.indices, nt = I.length / 3;
      const b = mesh.positions.reduce((acc, v, k) => { const a = k % 3; acc.min[a] = Math.min(acc.min[a], v); acc.max[a] = Math.max(acc.max[a], v); return acc; }, { min: [Infinity, Infinity, Infinity], max: [-Infinity, -Infinity, -Infinity] } as { min: number[]; max: number[] });
      const glass = new Uint8Array(nt);
      for (let t = 0; t < nt; t++) glass[t] = triangleIsGlass(mesh, t) ? 1 : 0;
      let hits = 0, worstRel = 0;
      for (let r = 0; r < 10000; r++) {
        const ext = b.max.map((m, a) => m - b.min[a]);
        const o: Vec3 = [b.min[0] - ext[0] * 0.5 + u(r, 1) * ext[0] * 2, b.min[1] - ext[1] * 0.5 + u(r, 2) * ext[1] * 2, b.min[2] - ext[2] * 0.5 + u(r, 3) * ext[2] * 2];
        let d: Vec3;
        if (r % 3 === 0) {
          // At a triangle's centroid, so most rays hit.
          const t = Math.floor(u(r, 4) * nt), a = I[t * 3] * 3, bb = I[t * 3 + 1] * 3, c = I[t * 3 + 2] * 3;
          d = normalize([(P[a] + P[bb] + P[c]) / 3 - o[0], (P[a + 1] + P[bb + 1] + P[c + 1]) / 3 - o[1], (P[a + 2] + P[bb + 2] + P[c + 2]) / 3 - o[2]]);
        } else if (r % 7 === 1) {
          // Along an axis from a vertex's own coordinates: slabs met edge-on (0 times infinity in the box test).
          const v = Math.floor(u(r, 5) * (P.length / 3)) * 3, axis = r % 3;
          o[(axis + 1) % 3] = P[v + ((axis + 1) % 3)]; o[(axis + 2) % 3] = P[v + ((axis + 2) % 3)];
          d = [0, 0, 0]; d[axis] = u(r, 6) < 0.5 ? 1 : -1;
        } else {
          const z = 2 * u(r, 7) - 1, ph = 2 * Math.PI * u(r, 8), s = Math.sqrt(1 - z * z);
          d = [s * Math.cos(ph), s * Math.sin(ph), z];
        }
        const tmin = r % 5 === 0 ? u(r, 9) * 0.5 : 0, tmax = r % 4 === 0 ? 0.5 + u(r, 10) * 2 : Infinity;
        const refs = brute(mesh, glass, o, d, tmin, tmax);
        for (const [which, ref] of [[ALL, refs[0]], [OPAQUE, refs[1]], [GLASS, refs[2]]] as const) {
          const id = (tr.ray.set([o[0], o[1], o[2], d[0], d[1], d[2], tmin, tmax]), tr.closestRay(which));
          expect(id, `${name} ray ${r} which ${which}`).toBe(ref.id);
          if (id >= 0) {
            expect(tr.hit[0]).toBe(ref.t);
            const exact = exactT(mesh, id, o, d);
            worstRel = Math.max(worstRel, Math.abs(tr.hit[0] - exact) / Math.max(Math.abs(exact), 1e-9));
            if (which === ALL) hits++;
          }
          tr.ray.set([o[0], o[1], o[2], d[0], d[1], d[2], tmin, tmax]);
          expect(tr.occludedRay(which), `${name} ray ${r} any-hit ${which}`).toBe(ref.id >= 0);
        }
      }
      expect(hits).toBeGreaterThan(3000);
      expect(worstRel).toBeLessThan(1e-6);
      expect(nt).toBeGreaterThan(1500);
    }
  });

  it("marks glass triangles and the subtrees that hold them", () => {
    const { mesh } = meshes[1];
    const bvh = buildBvh(mesh);
    expect(bvh.anyGlass).toBe(true);
    let glass = 0;
    for (let k = 0; k < bvh.triId.length; k++) {
      expect(bvh.glass[k] === 1).toBe(triangleIsGlass(mesh, bvh.triId[k]));
      glass += bvh.glass[k];
    }
    expect(glass).toBeGreaterThan(0);
    expect(glass).toBeLessThan(bvh.triId.length);
    expect(buildBvh(meshes[0].mesh).anyGlass).toBe(false);
  });

  it("is built once per mesh in a run's cache, in shared memory when asked", () => {
    const { mesh } = meshes[0];
    const cache = { bvh: new WeakMap<Mesh, unknown>() };
    const a = bvhFor(mesh, cache);
    expect(bvhFor(mesh, cache)).toBe(a);
    const s = bvhFor(mesh, cache, true);
    expect(s).not.toBe(a);
    expect(s.tri.buffer).toBeInstanceOf(SharedArrayBuffer);
    expect(bvhFor(mesh, cache, true)).toBe(s);
    expect(Array.from(s.triId)).toEqual(Array.from(a.triId));
  });

  it("allocates nothing over 100,000 traversals", () => {
    v8.setFlagsFromString("--expose-gc");
    const gc = vm.runInNewContext("gc") as () => void;
    const { mesh } = meshes[2];
    const tr = new BvhTracer(buildBvh(mesh));
    const R = new Float64Array(4096 * 6);
    for (let i = 0; i < 4096; i++) {
      const z = 2 * u(i, 1) - 1, ph = 2 * Math.PI * u(i, 2), s = Math.sqrt(1 - z * z);
      R.set([u(i, 3) - 0.5, u(i, 4) - 0.5, u(i, 5) - 0.5, s * Math.cos(ph), s * Math.sin(ph), z], i * 6);
    }
    const run = (n: number): number => {
      const ray = tr.ray;
      let hits = 0;
      for (let k = 0; k < n; k++) {
        const o = (k & 4095) * 6;
        ray[0] = R[o]; ray[1] = R[o + 1]; ray[2] = R[o + 2]; ray[3] = R[o + 3]; ray[4] = R[o + 4]; ray[5] = R[o + 5]; ray[6] = 0; ray[7] = 10;
        if (k & 1 ? tr.occludedRay(OPAQUE) : tr.closestRay(ALL) >= 0) hits++;
      }
      return hits;
    };
    // V8 recompiles the loop after the full collection each measurement starts with, and the first runs after one
    // allocate while it does (measured: 0.4 to 0.6 MB in the first two, 256 bytes after). Traversals that allocated
    // would show in every run; code being recompiled shows in some.
    for (let k = 0; k < 6; k++) run(100000);
    const deltas: number[] = [];
    let hits = 0;
    for (let k = 0; k < 6; k++) {
      gc();
      const before = process.memoryUsage().heapUsed;
      hits = run(100000);
      deltas.push(process.memoryUsage().heapUsed - before);
    }
    expect(hits).toBeGreaterThan(1000);
    expect(Math.min(...deltas)).toBeLessThan(64 * 1024);
    expect(deltas.filter((d) => d < 64 * 1024).length).toBeGreaterThanOrEqual(3);
  });
});

// ---- faithfulness ----

describe("rays against the field", () => {
  for (const [name, source] of Object.entries(PROGRAMS)) {
    it(`${name}: closest() and occlusion() agree with marching the field alone`, () => {
      const f = program(source);
      const rays = createRays(f.shape, f.mesh, buildBvh(f.mesh), f.cell, f.box, f.reach);
      const px = pixels(f, rays);
      const n = px.size * px.size;
      // Mirror rays from every model pixel, leaving two cells along the normal.
      let mirror = 0, hitMiss = 0, both = 0, close = 0, far = 0;
      for (let i = 0; i < n; i++) {
        if (px.kind[i] !== KIND_MODEL) continue;
        const N = px.N.subarray(i * 3, i * 3 + 3), V = px.D.subarray(i * 3, i * 3 + 3);
        const k = 2 * (V[0] * N[0] + V[1] * N[1] + V[2] * N[2]);
        const r: Vec3 = [V[0] - k * N[0], V[1] - k * N[1], V[2] - k * N[2]];
        const o: Vec3 = [px.P[i * 3] + N[0] * f.cell * 2, px.P[i * 3 + 1] + N[1] * f.cell * 2, px.P[i * 3 + 2] + N[2] * f.cell * 2];
        const tf = rays.fieldClosest(o[0], o[1], o[2], r[0], r[1], r[2], f.reach * 2);
        const tr = rays.closest(o[0], o[1], o[2], r[0], r[1], r[2], f.reach * 2);
        mirror++;
        if ((tf >= 0) !== (tr >= 0)) { hitMiss++; continue; }
        if (tf < 0) continue;
        both++;
        const e = Math.abs(tf - tr) / f.cell;
        if (e <= 0.05) close++;
        if (e > 2) far++;
      }
      expect(both).toBeGreaterThan(50);
      expect(hitMiss / mirror).toBeLessThanOrEqual(0.006);
      expect(close / both).toBeGreaterThanOrEqual(0.99);
      expect(far / both).toBeLessThanOrEqual(0.01);
      // The key light's hard shadow from every model and floor pixel facing it.
      const L = lightDirection(-40, 55);
      const fieldMap = new Uint8Array(n), raysMap = new Uint8Array(n);
      let lit = 0;
      for (let i = 0; i < n; i++) {
        if (!px.kind[i]) continue;
        const N = px.N.subarray(i * 3, i * 3 + 3);
        if (N[0] * L[0] + N[1] * L[1] + N[2] * L[2] <= 0) continue;
        const o: Vec3 = [px.P[i * 3] + N[0] * f.cell, px.P[i * 3 + 1] + N[1] * f.cell, px.P[i * 3 + 2] + N[2] * f.cell];
        lit++;
        fieldMap[i] = rays.fieldOcclusion(o[0], o[1], o[2], L[0], L[1], L[2], Infinity, 0) < 0.5 ? 2 : 1;
        raysMap[i] = rays.occlusion(o[0], o[1], o[2], L[0], L[1], L[2], Infinity, 0) < 0.5 ? 2 : 1;
      }
      let differ = 0, offEdge = 0;
      for (let i = 0; i < n; i++) {
        if (!fieldMap[i] || fieldMap[i] === raysMap[i]) continue;
        differ++;
        const x = i % px.size, y = Math.floor(i / px.size);
        let edge = false;
        for (let dy = -2; dy <= 2; dy++)
          for (let dx = -2; dx <= 2; dx++) {
            const j = (y + dy) * px.size + x + dx;
            if (x + dx >= 0 && x + dx < px.size && y + dy >= 0 && y + dy < px.size && fieldMap[j] && fieldMap[j] !== fieldMap[i]) edge = true;
          }
        if (!edge) offEdge++;
      }
      expect(lit).toBeGreaterThan(1000);
      expect(differ / lit).toBeLessThanOrEqual(0.0075);
      expect(offEdge).toBe(0);
    });
  }
});

// ---- area lights ----

/** The floor behind a unit cube lit from +z at 45 degrees: visibility down the middle of the shadow's far edge. */
function cubeProfile(size: number, earlyOut = true) {
  const cube = move(box(1, 1, 1), 0, 0.5, 0);
  const nets = surfaceNets(cube, { resolution: 64 });
  const cell = nets.cellSize;
  const model: Bounds = { min: [-0.5, 0, -0.5], max: [0.5, 1, 0.5] };
  const rays = createRays(cube, nets.mesh, buildBvh(nets.mesh), cell, model, Math.hypot(1, 1, 1) * 1.5);
  const L = lightDirection(0, 45);
  const theta = size / 18;
  const light: RayLight = { point: false, x: L[0], y: L[1], z: L[2], radius: theta, index: 0 };
  // The exact fraction of the disc a floor point sees past the cube (the same disc, densely sampled).
  const sg = L[2] >= 0 ? 1 : -1, ia = -1 / (sg + L[2]), ib = L[0] * L[1] * ia;
  const t1: Vec3 = [1 + sg * L[0] * L[0] * ia, sg * ib, -sg * L[0]], t2: Vec3 = [ib, sg + L[1] * L[1] * ia, -L[1]];
  const exact = (o: Vec3): number => {
    let seen = 0, all = 0;
    for (let a = 0; a < 96; a++)
      for (let b = 0; b < 96; b++) {
        const uu = ((a + 0.5) / 96) * 2 - 1, v = ((b + 0.5) / 96) * 2 - 1;
        if (uu * uu + v * v > 1) continue;
        all++;
        const d = normalize([L[0] + Math.tan(theta) * (uu * t1[0] + v * t2[0]), L[1] + Math.tan(theta) * (uu * t1[1] + v * t2[1]), L[2] + Math.tan(theta) * (uu * t1[2] + v * t2[2])]);
        let lo = 0, hi = Infinity;
        for (let k = 0; k < 3; k++) {
          let ta = (model.min[k] - o[k]) / d[k], tb = (model.max[k] - o[k]) / d[k];
          if (ta > tb) [ta, tb] = [tb, ta];
          lo = Math.max(lo, ta); hi = Math.min(hi, tb);
        }
        if (!(hi >= lo)) seen++;
      }
    return seen / all;
  };
  // Rows down z, each the mean of 48 pixels across x in the shadow's straight middle.
  const zs: number[] = [], mean: number[] = [], ref: number[] = [];
  for (let row = 0; row < 120; row++) {
    const z = -0.6 - (row / 119) * 1.8;
    let s = 0;
    for (let col = 0; col < 48; col++) s += rays.areaVisibility(-0.24 + (col / 47) * 0.48, cell, z, light, pixelKey(row * 48 + col), 8, earlyOut);
    zs.push(z); mean.push(s / 48); ref.push(exact([0, cell, z]));
  }
  const cross = (v: number[], level: number) => {
    for (let k = 1; k < v.length; k++) if ((v[k - 1] - level) * (v[k] - level) <= 0 && v[k] !== v[k - 1]) return zs[k - 1] + ((level - v[k - 1]) / (v[k] - v[k - 1])) * (zs[k] - zs[k - 1]);
    return NaN;
  };
  return { half: cross(mean, 0.5), width: Math.abs(cross(mean, 0.9) - cross(mean, 0.1)), exactWidth: Math.abs(cross(ref, 0.9) - cross(ref, 0.1)), rays };
}

describe("areaVisibility", () => {
  for (const size of [1, 3]) {
    it(`puts a size-${size} light's penumbra behind a unit cube where the disc does`, () => {
      const p = cubeProfile(size);
      // The cube's top back edge (y 1, z -0.5) seen along the light: the floor at z -1.5.
      expect(Math.abs(p.half - -1.5)).toBeLessThan(0.05);
      expect(Math.abs(p.width / p.exactWidth - 1)).toBeLessThan(0.1);
    });
  }

  it("answers the same with its early out as with all eight rays", () => {
    // The early out is the cone test: no triangle can meet any ray of the disc, so all eight would be clear.
    const f = program(PROGRAMS.cage);
    const rays = createRays(f.shape, f.mesh, buildBvh(f.mesh), f.cell, f.box, f.reach);
    const px = pixels(f, rays, 64);
    const L = lightDirection(-40, 55);
    const lights: RayLight[] = [
      { point: false, x: L[0], y: L[1], z: L[2], radius: 1.5 / 18, index: 0 },
      { point: true, x: 0.1, y: 1.0, z: 0.4, radius: 0.02 * 1.4 * 1, index: 1 },
    ];
    let early = 0, partial = 0;
    for (let i = 0; i < 64 * 64; i++) {
      if (!px.kind[i]) continue;
      const o = [0, 1, 2].map((k) => px.P[i * 3 + k] + px.N[i * 3 + k] * f.cell);
      for (const l of lights) {
        const e0 = rays.stats.earlyOut;
        const a = rays.areaVisibility(o[0], o[1], o[2], l, pixelKey(i), 8, true);
        const av = Array.from(rays.vis);
        if (rays.stats.earlyOut > e0) early++;
        const b = rays.areaVisibility(o[0], o[1], o[2], l, pixelKey(i), 8, false);
        expect(a).toBe(b);
        expect(av).toEqual(Array.from(rays.vis));
        if (b > 0 && b < 1) partial++;
      }
    }
    expect(early).toBeGreaterThan(1000);
    expect(partial).toBeGreaterThan(20);
  });

  it("takes the same hashed rays whenever it is asked, and other rays at another pixel, light or subsample", () => {
    const p1 = cubeProfile(1);
    const rays = p1.rays;
    const L = lightDirection(0, 45);
    const light: RayLight = { point: false, x: L[0], y: L[1], z: L[2], radius: 3 / 18, index: 0 };
    const at = (key: number, l = light) => rays.areaVisibility(0.1, 0.02, -1.4, l, key, 8, false);
    const first = [0, 1, 2, 3, 4, 5].map((k) => at(pixelKey(1000, k)));
    // Other calls in between, and a fresh instance, change nothing.
    for (let k = 0; k < 50; k++) at(pixelKey(k * 31));
    expect([0, 1, 2, 3, 4, 5].map((k) => at(pixelKey(1000, k)))).toEqual(first);
    const again = cubeProfile(1).rays;
    expect([0, 1, 2, 3, 4, 5].map((k) => again.areaVisibility(0.1, 0.02, -1.4, light, pixelKey(1000, k), 8, false))).toEqual(first);
    // In the penumbra, subsamples and lights differ.
    expect(new Set(first).size).toBeGreaterThan(1);
    const other = { ...light, index: 1 };
    expect([0, 1, 2, 3, 4, 5].map((k) => at(pixelKey(1000, k), other))).not.toEqual(first);
  });

  it("stops rays to a point light its radius short of it, so the light's own flame does not shadow it", () => {
    // A flame smaller than the light's sphere, round the light's centre: every ray ends before reaching it. A flame
    // larger than the sphere shadows it, as any part would.
    const flame = (r: number) => union([paint(move(sphere(r), 0, 1, 0), materialFromString("iron")!), paint(box(0.2, 0.2, 0.2), materialFromString("iron")!)]);
    for (const [r, seen] of [[0.03, 1], [0.08, 0]] as const) {
      const shape = flame(r);
      const nets = surfaceNets(shape, { resolution: 96 });
      const rays = createRays(shape, nets.mesh, buildBvh(nets.mesh), nets.cellSize, shape.bounds, 3);
      const light: RayLight = { point: true, x: 0, y: 1, z: 0, radius: 0.05, index: 0 };
      for (const p of [[1, 0.8, 0.2], [0.04, 0.3, 0.5], [-0.7, 1.4, 0]]) expect(rays.areaVisibility(p[0], p[1], p[2], light, 1)).toBe(seen);
    }
  });
});

// ---- glass ----

describe("insideMarch", () => {
  it("crosses a revolved drink's axis and goes on to the far wall", () => {
    const f = program(`glass = revolve(polygon(0,0, 1.35,0, 1.55,3.6, 1.35,3.6, 1.2,0.25, 0,0.25)) | paint("glass")
drink = revolve(polygon(0,0, 1.2,0, 1.32,2.4, 0,2.4)) | move(0, 0.26, 0) | paint("amber")
show (glass + drink) | ground()`, 96);
    const rays = createRays(f.shape, f.mesh, buildBvh(f.mesh), f.cell, f.box, f.reach);
    const amber = materialFromString("amber")!;
    // A level ray through the drink from inside its near wall: its far wall is 2 * 1.26 away; the axis is half way.
    const y = 1.2, r = 1.2 + (1.32 - 1.2) * ((y - 0.26) / 2.4);
    for (const z of [0, 0.003, -0.002]) {
      const x0 = -Math.sqrt(r * r - z * z) + f.cell * 0.01;
      const t = rays.insideMarch(x0, y, z, 1, 0, 0, amber);
      // Inside the union of glass and drink the ray only leaves at the glass's outer face.
      const outer = 1.35 + (1.55 - 1.35) * (y / 3.6);
      expect(t).toBeGreaterThan(Math.abs(x0) + Math.sqrt(outer * outer - z * z) - f.cell);
    }
  });

  it("takes no exit where the field touches zero without crossing it (two coincident faces)", () => {
    const glass = materialFromString("glass")!;
    const pair = union([paint(box(1, 1, 1), glass), paint(move(box(1, 1, 1), 1, 0, 0), glass)]);
    // The shared face at x 0.5 is a zero of the union inside it on both sides.
    expect(pair.dist(0.5, 0, 0)).toBeCloseTo(0, 9);
    expect(pair.dist(0.45, 0, 0)).toBeLessThan(0);
    expect(pair.dist(0.55, 0, 0)).toBeLessThan(0);
    const nets = surfaceNets(pair, { resolution: 64 });
    const rays = createRays(pair, nets.mesh, buildBvh(nets.mesh), nets.cellSize, pair.bounds, 4);
    for (const z of [0, 0.2, -0.31]) {
      const t = rays.insideMarch(-0.5, 0.1, z, 1, 0, 0, glass);
      expect(Math.abs(t - 2) / 2).toBeLessThan(0.02);
    }
  });

  it("measures a 0.2 wall within 2%, square on and at 40 degrees", () => {
    const wall = paint(box(0.2, 2, 2), materialFromString("glass")!);
    const nets = surfaceNets(wall, { resolution: 96 });
    const rays = createRays(wall, nets.mesh, buildBvh(nets.mesh), nets.cellSize, wall.bounds, 3);
    for (const deg of [0, 40]) {
      const a = (deg * Math.PI) / 180;
      // From the face, as a march from outside stops (up to 0.05 cell short of it).
      const t = rays.insideMarch(-0.1 + nets.cellSize * 0.01, 0, 0, Math.cos(a), Math.sin(a), 0, materialFromString("glass")!);
      expect(Math.abs(t * Math.cos(a) - 0.2) / 0.2).toBeLessThan(0.02);
    }
  });

  it("lets transmit times 0.92 through clear glass, and Beer's law through coloured glass", () => {
    const clear: Material = { ...materialFromString("glass")!, color: [1, 1, 1], transmit: 0.9 };
    const amber: Material = { ...materialFromString("glass")!, color: [1, 0.6, 0.2], transmit: 0.9 };
    for (const [m, near] of [[clear, false], [clear, true], [amber, false], [amber, true]] as const) {
      const slab = paint(move(box(2, 0.3, 2), 0, 1, 0), m);
      const nets = surfaceNets(slab, { resolution: 64 });
      const reach = 4;
      const rays = createRays(slab, nets.mesh, buildBvh(nets.mesh), nets.cellSize, slab.bounds, reach);
      // From under the slab straight up: a cell under it (the near march crosses it) or far under (the BVH does).
      const y0 = near ? 0.85 - nets.cellSize : 0.2;
      rays.occlusion(0, y0, 0, 0, 1, 0, Infinity, 0);
      for (let c = 0; c < 3; c++) {
        const want = 0.9 * 0.92 * Math.exp((-10 * (1 - m.color[c]) * 0.3) / reach);
        expect(Math.abs(rays.vis[c] - want) / want, `${m.color} near ${near} channel ${c}`).toBeLessThan(0.02);
      }
    }
  });
});

// ---- the filter ----

function flatGuides(size: number): FilterGuides {
  const n = size * size;
  const g: FilterGuides = { depth: new Float32Array(n).fill(4), normal: new Float32Array(n * 3), mat: new Int32Array(n).fill(3), flags: new Uint8Array(n).fill(KIND_MODEL) };
  for (let i = 0; i < n; i++) g.normal[i * 3 + 2] = 1;
  return g;
}

describe("filterVisibility", () => {
  const size = 48, cell = 0.01;
  it("does not carry visibility across a step in depth, normal, material, kind or an edge", () => {
    const steps: ((g: FilterGuides, i: number) => void)[] = [
      (g, i) => { g.depth[i] = 4 + cell * 30; },
      (g, i) => { g.normal[i * 3] = 1; g.normal[i * 3 + 2] = 0; },
      (g, i) => { g.mat[i] = 4; },
      (g, i) => { g.flags[i] = KIND_FLOOR; },
    ];
    for (const step of steps) {
      const g = flatGuides(size);
      const V = new Float32Array(size * size * 2);
      for (let i = 0; i < size * size; i++) {
        const right = i % size >= size / 2;
        if (right) step(g, i);
        V[i * 2] = right ? 0.9 : 0.2; V[i * 2 + 1] = right ? 0.1 : 0.7;
      }
      const F = filterVisibility(V, 2, g, size, cell);
      for (let i = 0; i < size * size; i++) {
        expect(Math.abs(F[i * 2] - V[i * 2])).toBeLessThan(1e-6);
        expect(Math.abs(F[i * 2 + 1] - V[i * 2 + 1])).toBeLessThan(1e-6);
      }
    }
    // Edge pixels keep their own value and give none.
    const g = flatGuides(size);
    const V = new Float32Array(size * size).fill(0.5);
    for (let i = 0; i < size * size; i += 7) { g.flags[i] |= FLAG_EDGE; V[i] = 1; }
    g.flags[5] = KIND_SKY; V[5] = 0.123;
    const F = filterVisibility(V, 1, g, size, cell);
    for (let i = 0; i < size * size; i++) expect(Math.abs(F[i] - V[i])).toBeLessThan(1e-6);
  });

  it("cuts a noisy flat region's variance at least fourfold, at the radius its size gets", () => {
    for (const s of [96, 384]) {
      const g = flatGuides(s);
      const V = new Float32Array(s * s);
      for (let i = 0; i < s * s; i++) V[i] = hash01(i, 77);
      const F = filterVisibility(V, 1, g, s, cell);
      const variance = (a: Float32Array) => { let m = 0; for (const v of a) m += v; m /= a.length; let q = 0; for (const v of a) q += (v - m) ** 2; return q / a.length; };
      expect(variance(V) / variance(F)).toBeGreaterThan(4);
    }
    expect([384, 512, 768, 96].map(filterRadius)).toEqual([3, 4, 6, 2]);
  });

  it("filters rows independently: any split of the rows gives the same values", () => {
    const g = flatGuides(size);
    const V = new Float32Array(size * size);
    for (let i = 0; i < size * size; i++) { V[i] = hash01(i, 5); g.depth[i] = 4 + (i % 7) * cell * 0.3; }
    const whole = filterVisibility(V, 1, g, size, cell);
    const split = new Float32Array(size * size);
    filterVisibilityRows(V, 1, g, size, cell, split, 17, size);
    filterVisibilityRows(V, 1, g, size, cell, split, 0, 17);
    expect(Array.from(split)).toEqual(Array.from(whole));
  });
});
