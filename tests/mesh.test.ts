import { describe, expect, it } from "vitest";
import * as P from "../src/sdf/primitives.js";
import * as O from "../src/sdf/ops.js";
import { surfaceNets } from "../src/mesh/surfaceNets.js";
import { isWatertight, meshBounds, meshVolume, triangleCount } from "../src/mesh/mesh.js";
import { toObj } from "../src/export/obj.js";
import { toGlb } from "../src/export/glb.js";
import { albedo, preset } from "../src/sdf/materials.js";
import { bakeAtlas } from "../src/export/atlas.js";
import { analyse, hull2, insideMargin } from "../src/mesh/physics.js";
import { countPieces } from "../src/mesh/pieces.js";
import { splitCreases } from "../src/mesh/creases.js";
import { weldIndices } from "../src/mesh/mesh.js";
import { materialFromString } from "../src/sdf/materials.js";

describe("surface nets", () => {
  const sphere = surfaceNets(P.sphere(1), { resolution: 48 });
  it("closes the surface and gets the volume of a sphere within a few percent", () => {
    expect(triangleCount(sphere.mesh)).toBeGreaterThan(1000);
    expect(isWatertight(sphere.mesh)).toBe(true);
    const v = meshVolume(sphere.mesh);
    expect(Math.abs(v - (4 / 3) * Math.PI) / ((4 / 3) * Math.PI)).toBeLessThan(0.03);
  });
  it("winds outward, with normals along the gradient", () => {
    const { positions, normals } = sphere.mesh;
    for (let i = 0; i < positions.length; i += 3 * 97) {
      const dotp = positions[i] * normals[i] + positions[i + 1] * normals[i + 1] + positions[i + 2] * normals[i + 2];
      expect(dotp).toBeGreaterThan(0.9);
    }
    expect(meshVolume(sphere.mesh)).toBeGreaterThan(0);
  });
  it("stays within a cell of the true bounds", () => {
    const b = meshBounds(sphere.mesh);
    for (let k = 0; k < 3; k++) {
      expect(Math.abs(b.min[k] + 1)).toBeLessThan(sphere.cellSize);
      expect(Math.abs(b.max[k] - 1)).toBeLessThan(sphere.cellSize);
    }
  });
  it("handles a shape with a hole and stays watertight", () => {
    const ring = O.difference(P.cylinder(1, 0.5), P.cylinder(0.5, 2));
    const r = surfaceNets(ring, { resolution: 40 });
    expect(isWatertight(r.mesh)).toBe(true);
    expect(meshVolume(r.mesh)).toBeCloseTo(Math.PI * (1 - 0.25) * 0.5, 0);
  });
  it("records the material and local point per vertex", () => {
    const painted = O.union([O.paint(P.sphere(1), preset("red")!), O.paint(O.move(P.sphere(1), 3, 0, 0), preset("blue")!)]);
    const r = surfaceNets(painted, { resolution: 32 });
    expect(r.mesh.materials.map((m) => m.name).sort()).toEqual(["blue", "red"]);
    const { positions, materialIndex, materials } = r.mesh;
    for (let v = 0; v < materialIndex.length; v += 53) {
      const expected = positions[v * 3] < 1.5 ? "red" : "blue";
      expect(materials[materialIndex[v]].name).toBe(expected);
    }
  });
  it("puts vertices on a box's corners with sharp placement, and inside them without", () => {
    const box = P.box(2, 2, 2);
    const sharp = surfaceNets(box, { resolution: 20 });
    const soft = surfaceNets(box, { resolution: 20, sharp: false });
    const bs = meshBounds(sharp.mesh), bo = meshBounds(soft.mesh);
    // The lattice starts a fraction of a cell off the box, so a face is fitted between sample planes rather than
    // sitting on one; the fit lands within a tenth of a cell.
    expect(Math.abs(bs.max[0] - 1)).toBeLessThan(sharp.cellSize * 0.1);
    expect(Math.abs(bs.min[2] + 1)).toBeLessThan(sharp.cellSize * 0.1);
    expect(bo.max[0]).toBeLessThanOrEqual(1);
    expect(isWatertight(sharp.mesh)).toBe(true);
    expect(isWatertight(soft.mesh)).toBe(true);
    expect(Math.abs(meshVolume(sharp.mesh) - 8) / 8).toBeLessThan(0.01);
    // The corner (1, 1, 1) has a vertex on it with sharp placement and none near it without.
    const nearest = (m: { positions: Float32Array }) => {
      let best = Infinity;
      for (let i = 0; i < m.positions.length; i += 3) best = Math.min(best, Math.hypot(m.positions[i] - 1, m.positions[i + 1] - 1, m.positions[i + 2] - 1));
      return best;
    };
    // In general position (the corner a fraction of a cell inside its sample cell, as any real model's corners are)
    // the fit lands within a fifth of a cell of it; the soft placement stays well inside.
    expect(nearest(sharp.mesh)).toBeLessThan(sharp.cellSize * 0.2);
    expect(nearest(soft.mesh)).toBeGreaterThan(sharp.cellSize * 0.3);
  });
  it("returns an empty mesh for an empty shape", () => {
    const r = surfaceNets(O.empty3(), { resolution: 32 });
    expect(triangleCount(r.mesh)).toBe(0);
  });
});

describe("exports", () => {
  const mesh = surfaceNets(O.union([O.paint(P.box(1, 1, 1), preset("red")!), O.paint(O.move(P.sphere(0.5), 2, 0, 0), preset("gold")!)]), { resolution: 24 }).mesh;
  it("writes an OBJ with matching counts and a group per material", () => {
    const { obj, mtl } = toObj(mesh, "test", "test.mtl");
    const count = (re: RegExp) => (obj.match(re) ?? []).length;
    expect(count(/^v /gm)).toBe(mesh.positions.length / 3);
    expect(count(/^vn /gm)).toBe(mesh.normals.length / 3);
    expect(count(/^f /gm)).toBe(mesh.indices.length / 3);
    expect(count(/^usemtl /gm)).toBe(2);
    expect(mtl).toMatch(/newmtl red_0/);
    expect(mtl).toMatch(/newmtl gold_1/);
  });
  it("writes a valid GLB container with one primitive per material", () => {
    const glb = toGlb(mesh, "test");
    expect(glb.toString("ascii", 0, 4)).toBe("glTF");
    expect(glb.readUInt32LE(4)).toBe(2);
    expect(glb.readUInt32LE(8)).toBe(glb.length);
    const jsonLen = glb.readUInt32LE(12);
    expect(glb.toString("ascii", 16, 20)).toBe("JSON");
    const json = JSON.parse(glb.toString("utf8", 20, 20 + jsonLen));
    expect(json.asset.version).toBe("2.0");
    expect(json.meshes[0].primitives).toHaveLength(2);
    expect(json.materials.map((m: { name: string }) => m.name)).toEqual(["red", "gold"]);
    expect(json.materials[1].pbrMetallicRoughness.metallicFactor).toBe(1);
    expect(json.accessors[0].count).toBe(mesh.positions.length / 3);
    expect(json.accessors[0].min).toHaveLength(3);
    expect(glb.length % 4).toBe(0);
  });
});

describe("texture atlas", () => {
  const checker = materialFromString("checker")!;
  const shape = O.union([O.paint(P.box(2, 2, 2), checker), O.paint(O.move(P.sphere(0.6), 2.5, 0, 0), preset("red")!)]);
  const mesh = surfaceNets(shape, { resolution: 24 }).mesh;
  const atlas = bakeAtlas(mesh, { size: 256, padding: 2 });
  it("splits vertices per chart and keeps every triangle", () => {
    expect(atlas.mesh.indices.length).toBe(mesh.indices.length);
    expect(atlas.mesh.positions.length / 3).toBeGreaterThan(mesh.positions.length / 3);
    expect(atlas.uv.length).toBe((atlas.mesh.positions.length / 3) * 2);
    expect(atlas.charts).toBeGreaterThanOrEqual(6);
    for (let i = 0; i < atlas.uv.length; i++) {
      expect(atlas.uv[i]).toBeGreaterThanOrEqual(0);
      expect(atlas.uv[i]).toBeLessThanOrEqual(1);
    }
  });
  it("bakes the pattern: the texel under a triangle's centroid matches albedo at that point", () => {
    const { mesh: m, uv, image } = atlas;
    let checked = 0, agree = 0;
    for (let t = 0; t < m.indices.length; t += 3 * 7) {
      const a = m.indices[t], b = m.indices[t + 1], c = m.indices[t + 2];
      const lx = (m.local[a * 3] + m.local[b * 3] + m.local[c * 3]) / 3;
      const ly = (m.local[a * 3 + 1] + m.local[b * 3 + 1] + m.local[c * 3 + 1]) / 3;
      const lz = (m.local[a * 3 + 2] + m.local[b * 3 + 2] + m.local[c * 3 + 2]) / 3;
      const mat = m.materials[m.materialIndex[a]];
      const want = albedo(mat, lx, ly, lz);
      const u = (uv[a * 2] + uv[b * 2] + uv[c * 2]) / 3, v = (uv[a * 2 + 1] + uv[b * 2 + 1] + uv[c * 2 + 1]) / 3;
      const px = image.get(Math.floor(u * image.width), Math.floor(v * image.height));
      const got = [((px >> 16) & 255) / 255, ((px >> 8) & 255) / 255, (px & 255) / 255];
      checked++;
      if (Math.abs(got[0] - want[0]) < 0.05 && Math.abs(got[1] - want[1]) < 0.05 && Math.abs(got[2] - want[2]) < 0.05) agree++;
    }
    expect(checked).toBeGreaterThan(20);
    // A centroid can sit on a checker boundary (with the lattice off the box's faces, more triangles straddle one
    // than when the faces sat on sample planes); most must agree.
    expect(agree / checked).toBeGreaterThan(0.8);
  });
  it("writes UVs and the texture into the GLB and OBJ", () => {
    const glb = toGlb(atlas.mesh, "t", { uv: atlas.uv, png: atlas.image.toPng() });
    const jsonLen = glb.readUInt32LE(12);
    const json = JSON.parse(glb.toString("utf8", 20, 20 + jsonLen));
    expect(json.meshes[0].primitives[0].attributes.TEXCOORD_0).toBeDefined();
    expect(json.meshes[0].primitives[0].attributes.COLOR_0).toBeUndefined();
    expect(json.images[0].mimeType).toBe("image/png");
    expect(json.materials[0].pbrMetallicRoughness.baseColorTexture.index).toBe(0);
    const { obj, mtl } = toObj(atlas.mesh, "t", "t.mtl", atlas.uv, "t.png");
    expect((obj.match(/^vt /gm) ?? []).length).toBe(atlas.uv.length / 2);
    expect(obj).toMatch(/^f \d+\/\d+\/\d+ /m);
    expect(mtl).toMatch(/map_Kd t.png/);
  });
});

describe("physics", () => {
  it("measures volume and centre of mass, and finds a standing box stable", () => {
    const box = surfaceNets(O.move(P.box(2, 1, 2), 0, 0.5, 0), { resolution: 20 });
    const ph = analyse(box.mesh, box.cellSize);
    expect(Math.abs(ph.volume - 4) / 4).toBeLessThan(0.02);
    expect(ph.centre[1]).toBeCloseTo(0.5, 1);
    expect(ph.stable).toBe(true);
    expect(ph.stabilityMargin).toBeGreaterThan(0.8);
    expect(ph.pieces).toHaveLength(1);
  });
  it("finds a leaning tower unstable and a split model in pieces", () => {
    // A tall thin post on a small base, shifted so its mass hangs past the base.
    const lean = O.union([O.move(P.box(0.4, 0.2, 0.4), 0, 0.1, 0), O.move(P.box(0.3, 3, 0.3), 1.2, 1.7, 0)]);
    const m = surfaceNets(lean, { resolution: 40 });
    const ph = analyse(m.mesh, m.cellSize);
    expect(ph.pieces.length).toBe(2);
    const twoPieces = surfaceNets(O.union([P.sphere(0.5), O.move(P.sphere(0.5), 3, 0, 0)]), { resolution: 24 });
    expect(analyse(twoPieces.mesh, twoPieces.cellSize).pieces).toHaveLength(2);
    const tipped = O.union([O.move(P.box(1, 0.2, 1), 0, 0.1, 0), O.move(P.box(0.3, 3, 0.3), 0.4, 1.7, 0)]);
    const t = surfaceNets(tipped, { resolution: 40 });
    const pt = analyse(t.mesh, t.cellSize);
    expect(pt.pieces).toHaveLength(1);
    expect(pt.stable).toBe(true);
  });
  it("hull and margin", () => {
    const h = hull2([[0, 0], [2, 0], [2, 2], [0, 2], [1, 1]]);
    expect(h).toHaveLength(4);
    expect(insideMargin(h, 1, 1)).toBeCloseTo(1);
    expect(insideMargin(h, 3, 1)).toBeLessThan(0);
  });
});

describe("an imported mesh of overlapping shells", () => {
  it("reads the overlap as solid, so the tool's own GLB of a scene round-trips as one piece", async () => {
    const { buildHierarchy } = await import("../src/export/hierarchy.js");
    const { toGlbScene } = await import("../src/export/glb.js");
    const { parseGlb } = await import("../src/import/glb.js");
    const { meshField } = await import("../src/mesh/meshSdf.js");
    // A post sunk 0.2 into a slab, as two scene objects: two closed shells that overlap.
    const slab = O.move(P.box(2, 0.4, 2), 0, 0.2, 0);
    const post = O.move(P.cylinder(0.3, 1.2), 0, 0.8, 0);
    const h = buildHierarchy([{ name: "slab", shape: slab }, { name: "post", shape: post }], { cellSize: 0.05, texture: 0 });
    const field = meshField(parseGlb(toGlbScene(h, "test")), 64);
    // Inside the overlap (post within the slab), inside each alone, and outside.
    expect(field.dist(0, 0.3, 0)).toBeLessThan(0);
    expect(field.dist(0, 0.1, 0.8)).toBeLessThan(0);
    expect(field.dist(0, 1.0, 0)).toBeLessThan(0);
    expect(field.dist(0, 1.0, 0.8)).toBeGreaterThan(0);
    expect(field.openness).toBeLessThan(0.01);
  });
});

describe("pieces", () => {
  it("counts the pieces a shape meshes into, as the report does", () => {
    expect(countPieces(P.sphere(1), 32)).toBe(1);
    expect(countPieces(O.union([P.sphere(1), O.move(P.sphere(1), 3, 0, 0)]), 32)).toBe(2);
    // Two boxes overlapping by a cell are one piece; an enclosed void is a cavity, not a piece.
    expect(countPieces(O.union([P.box(1, 1, 1), O.move(P.box(1, 1, 1), 0.9, 0, 0)]), 32)).toBe(1);
    expect(countPieces(O.shell(P.sphere(1), 0.2), 32)).toBe(1);
    expect(countPieces(P.empty(), 32)).toBe(0);
  });
});

describe("creases", () => {
  it("splits a box's vertices so every copy has an axis-aligned normal, and the welded mesh is still closed and one piece", () => {
    const r = surfaceNets(P.box(1, 1, 1), { resolution: 16 });
    const n = r.mesh.normals;
    // All but the slanted slivers a corner cell leaves (a handful, of no area) are on an axis; before the split a
    // vertex on an edge carried the diagonal gradient, and every face vertex within half a cell of an edge leaned.
    let worst = 0, off = 0;
    for (let v = 0; v < n.length; v += 3) {
      const d = 1 - Math.max(Math.abs(n[v]), Math.abs(n[v + 1]), Math.abs(n[v + 2]));
      worst = Math.max(worst, d);
      if (d > 0.02) off++;
    }
    expect(worst).toBeLessThan(0.1);
    expect(off / (n.length / 3)).toBeLessThan(0.01);
    // More vertices than the unsplit mesh (each corner and edge vertex has a copy per face), the same triangles.
    const plain = surfaceNets(P.box(1, 1, 1), { resolution: 16, crease: 0 });
    expect(r.mesh.positions.length).toBeGreaterThan(plain.mesh.positions.length);
    expect(r.mesh.indices.length).toBe(plain.mesh.indices.length);
    let diagonal = 0;
    for (let v = 0; v < plain.mesh.normals.length; v += 3) if (Math.max(Math.abs(plain.mesh.normals[v]), Math.abs(plain.mesh.normals[v + 1]), Math.abs(plain.mesh.normals[v + 2])) < 0.9) diagonal++;
    expect(diagonal).toBeGreaterThan(0);
    expect(isWatertight(r.mesh)).toBe(true);
    expect(analyse(r.mesh, r.cellSize).pieces).toHaveLength(1);
    expect(new Set(weldIndices(r.mesh)).size).toBe(plain.mesh.positions.length / 3);
  });
  it("leaves a sphere alone and gives each side of a material seam its own colour", () => {
    const s = surfaceNets(P.sphere(1), { resolution: 24 });
    const plain = surfaceNets(P.sphere(1), { resolution: 24, crease: 0 });
    expect(s.mesh.positions.length).toBe(plain.mesh.positions.length);
    // A blue ball standing in a red slab: every vertex on the slab's top face, the seam ring included, is red.
    const red = materialFromString("#ff0000")!, blue = materialFromString("#0000ff")!;
    const m = surfaceNets(O.union([O.paint(P.box(2, 0.2, 2), red), O.paint(O.move(P.sphere(0.5), 0, 0.5, 0), blue)]), { resolution: 40 });
    let top = 0, wrong = 0;
    for (let v = 0; v < m.mesh.positions.length / 3; v++) {
      if (m.mesh.normals[v * 3 + 1] < 0.99 || Math.abs(m.mesh.positions[v * 3 + 1] - 0.1) > 1e-3) continue;
      top++;
      if (m.mesh.materials[m.mesh.materialIndex[v]] !== red) wrong++;
    }
    expect(top).toBeGreaterThan(100);
    expect(wrong).toBe(0);
  });
  it("groups a vertex's faces by angle and copies the position once per group", () => {
    // Two triangles meeting at a right angle along the edge (0,0,0)-(1,0,0): both vertices on the edge split.
    const positions = new Float32Array([0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 1, 0]);
    const indices = new Uint32Array([0, 2, 1, 0, 1, 3]);
    const s = splitCreases(positions, indices, 35);
    expect(s.positions.length / 3).toBe(6);
    expect([...s.source]).toEqual([0, 1, 2, 3, 0, 1]);
    expect([...s.split]).toEqual([1, 1, 0, 0, 1, 1]);
    // Each triangle still has three vertices at the same places.
    for (let t = 0; t < 2; t++)
      for (let c = 0; c < 3; c++) expect(s.positions[s.indices[t * 3 + c] * 3]).toBe(positions[indices[t * 3 + c] * 3]);
    // At 100 degrees the right angle is not a crease.
    expect(splitCreases(positions, indices, 100).positions.length / 3).toBe(4);
  });
});
