import { describe, expect, it } from "vitest";
import * as P from "../src/sdf/primitives.js";
import * as O from "../src/sdf/ops.js";
import { buildHierarchy } from "../src/export/hierarchy.js";
import { toRoblox } from "../src/export/roblox.js";
import { triangleCount } from "../src/mesh/mesh.js";

/** The JSON chunk of a GLB. */
const glbJson = (glb: Buffer): { nodes: { name: string; rotation?: number[]; translation?: number[]; mesh?: number; children?: number[] }[]; scenes: { nodes: number[] }[] } => {
  const len = glb.readUInt32LE(12);
  return JSON.parse(glb.subarray(20, 20 + len).toString("utf8"));
};

describe("Roblox export", () => {
  it("writes a single object as Handle turned to face -Z, with the Attachment anchors as _Att nodes", () => {
    const hat = O.anchor(O.move(P.cylinder(0.8, 1), 0, 0.5, 0), "HatAttachment", 0, 0, 0);
    const h = buildHierarchy([{ name: "hat", shape: hat }], { cellSize: 0.1, texture: 0 });
    const r = toRoblox(h, "hat", { anchors: O.anchorsOf(hat), size: [1.6, 1, 1.6] });
    const j = glbJson(r.glb);
    const root = j.nodes[j.scenes[0].nodes[0]];
    expect(root.name).toBe("Handle");
    expect(root.mesh).toBe(0);
    // Half a turn about y: the quaternion (0, 1, 0, 0), within float noise.
    expect(root.rotation!.map((v) => Math.round(v * 1000) / 1000)).toEqual([0, 1, 0, 0]);
    const att = root.children!.map((i) => j.nodes[i]).find((n) => n.name === "HatAttachment_Att")!;
    expect(att).toBeDefined();
    expect(att.mesh).toBeUndefined();
    expect(r.attachments).toEqual(["HatAttachment_Att"]);
    expect(r.note).toMatch(/one mesh, Handle, \d+ triangles; attachment HatAttachment at \(0, 0, 0\); fits the hat limit 1.87 × 2.5 × 1.87; 1.6 × 1 × 1.6 studs, turned to face -Z/);
    expect(r.warnings).toEqual([]);
  });
  it("warns when an accessory is too big, too many triangles or not one mesh, and names a wrong attachment", () => {
    const big = O.anchor(P.box(3, 3, 3), "HatAttachment", 0, 0, 0);
    const h = buildHierarchy([{ name: "big", shape: big }], { cellSize: 0.02, texture: 0 });
    const r = toRoblox(h, "big", { anchors: O.anchorsOf(big), size: [3, 3, 3] });
    expect(r.warnings.join("\n")).toMatch(/more than a rigid accessory's 4000; lower the grid/);
    expect(r.warnings.join("\n")).toMatch(/a hat may be 1.87 × 2.5 × 1.87 studs at the Normal scale; this is 3 × 3 × 3, over on x, y, z/);
    const odd = O.anchor(P.sphere(0.5), "HandAttachment", 0, 0, 0);
    const h2 = buildHierarchy([{ name: "a", shape: odd }, { name: "b", shape: O.move(P.sphere(0.5), 2, 0, 0) }], { cellSize: 0.1, texture: 0 });
    const r2 = toRoblox(h2, "pair", { anchors: O.anchorsOf(O.union([odd])), size: [3, 1, 1] });
    expect(r2.warnings.join("\n")).toMatch(/an accessory is one mesh, but this is a scene of 2 objects/);
    expect(r2.warnings.join("\n")).toMatch(/'HandAttachment' is not a Roblox attachment name/);
    const j = glbJson(r2.glb);
    expect(j.nodes[j.scenes[0].nodes[0]].name).toBe("pair");
    expect(j.nodes.map((n) => n.name)).toEqual(expect.arrayContaining(["a", "b", "HandAttachment_Att"]));
  });
  it("shares a triangle budget across a jointed model's meshes", () => {
    const leg = O.joint(O.move(P.cylinder(0.2, 1), 0.6, 0.5, 0), "leg", 0.6, 1, 0);
    const pet = O.anchor(O.union([O.move(P.sphere(0.8), 0, 1, 0), leg]), "HatAttachment", 0, 0, 0);
    const plain = buildHierarchy([{ name: "pet", shape: pet }], { cellSize: 0.02, texture: 0 });
    expect(plain.meshes.length).toBe(2);
    expect(plain.triangles).toBeGreaterThan(4000);
    const h = buildHierarchy([{ name: "pet", shape: pet }], { cellSize: 0.02, texture: 0, maxTriangles: 4000 });
    expect(h.triangles).toBeLessThanOrEqual(4000);
    // Each mesh kept its share rather than each taking the whole budget.
    for (const m of h.meshes) expect(triangleCount(m)).toBeLessThan(4000);
    const r = toRoblox(h, "pet", { anchors: O.anchorsOf(pet), size: [1.6, 2, 1.6], before: plain.triangles });
    expect(r.note).toMatch(/Handle with 2 meshes \(one per joint\), \d+ triangles, decimated from \d+/);
    expect(r.warnings).toEqual([]);
  });
});
