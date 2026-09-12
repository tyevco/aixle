import { describe, expect, it } from "vitest";
import * as P from "../src/sdf/primitives.js";
import * as O from "../src/sdf/ops.js";
import { surfaceNets } from "../src/mesh/surfaceNets.js";
import { isWatertight, meshBounds, meshVolume, triangleCount } from "../src/mesh/mesh.js";
import { toObj } from "../src/export/obj.js";
import { toGlb } from "../src/export/glb.js";
import { preset } from "../src/sdf/materials.js";

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
