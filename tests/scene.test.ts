import { describe, expect, it } from "vitest";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as P from "../src/sdf/primitives.js";
import * as O from "../src/sdf/ops.js";
import { parse } from "../src/lang/parser.js";
import { evaluate } from "../src/lang/interpreter.js";
import { buildHierarchy, flatten } from "../src/export/hierarchy.js";
import { eulerToQuat, toGlbScene } from "../src/export/glb.js";
import { toObjScene } from "../src/export/obj.js";
import { easeBlend, interpolatePose, keyAt, renderPoses, type PoseView } from "../src/render/views.js";
import { REST_POSE, type JointPose } from "../src/sdf/types.js";
import { run } from "../src/pipeline.js";
import { preset } from "../src/sdf/materials.js";

describe("joints", () => {
  const arm = O.move(P.box(2, 0.4, 0.4), 1, 0, 0);
  const j = O.joint(arm, "elbow", 0, 0, 0);
  it("turns its child about the pivot by its angles, with exact bounds, and reads empty while hidden", () => {
    expect(j.dist(1.5, 0, 0)).toBeLessThan(0);
    expect(j.bounds.max[0]).toBeCloseTo(2);
    const up = O.joint(arm, "elbow", 0, 0, 0, [0, 0, 90]);
    expect(up.dist(1.5, 0, 0)).toBeGreaterThan(0);
    expect(up.dist(0, 1.5, 0)).toBeLessThan(0);
    expect(up.bounds.max[1]).toBeCloseTo(2);
    expect(up.bounds.max[0]).toBeCloseTo(0.2);
    j.joint!.hidden = true;
    expect(j.dist(1.5, 0, 0)).toBeGreaterThan(1e5);
    j.joint!.hidden = false;
  });
  it("is found through wrappers, and nested joints are found from their parent", () => {
    const inner = O.joint(O.move(P.sphere(0.3), 3, 0, 0), "wrist", 2, 0, 0);
    const outer = O.joint(O.union([arm, inner]), "shoulder", 0, 0, 0);
    const painted = O.paint(O.union([outer, P.box(1, 1, 1)]), preset("red")!);
    expect(O.findJoints(painted).map((s) => s.joint!.name)).toEqual(["shoulder"]);
    expect(O.allJoints(painted).map((s) => s.joint!.name).sort()).toEqual(["shoulder", "wrist"]);
    expect(O.findJoints(outer.joint!.child).map((s) => s.joint!.name)).toEqual(["wrist"]);
  });
  it("place makes copies and remembers the placements", () => {
    const p = O.place(P.sphere(0.5), [{ x: 0, y: 0, z: 0, yaw: 0, scale: 1 }, { x: 3, y: 0, z: 0, yaw: 45, scale: 2 }]);
    expect(p.dist(3, 0, 0)).toBeCloseTo(-1);
    expect(p.instanced!.placements).toHaveLength(2);
  });
});

describe("scene language", () => {
  const src = `
a = box(1) | move(-2, 0.5, 0)
arm = joint(box(2, 0.3, 0.3) | move(1, 0, 0), "elbow", 0, 0, 0)
b = arm | paint("red")
pose("rest")
pose("up", elbow=[0, 0, 90])
animation("lift", ["rest", "up"], seconds=0.5)
c = place(sphere(0.3), [0,2,0,0, 1,2,0,0])
scene a, b, c
`;
  const ev = evaluate(parse(src));
  it("applies a pose by re-evaluating with joint angles", () => {
    const rest = evaluate(parse(src)).output!;
    const up = evaluate(parse(src), { jointPoses: { elbow: { ...REST_POSE, angles: [0, 0, 90] } } }).output!;
    expect(rest.dist(1.5, 0, 0)).toBeLessThan(0);
    expect(up.dist(1.5, 0, 0)).toBeGreaterThan(0);
    expect(up.dist(0, 1.5, 0)).toBeLessThan(0);
    expect(() => evaluate(parse('a = joint(3, "k", 0, 0, 0)'))).toThrow(/first argument is the part/);
    expect(() => evaluate(parse('a = joint(box(1), "k", 0, 0)'))).toThrow(/missing 'z'/);
  });
  it("collects objects, poses and animations", () => {
    expect(ev.objects.map((o) => o.name)).toEqual(["a", "b", "c"]);
    expect(ev.outputName).toBe("scene");
    expect(ev.poses.map((p) => p.name)).toEqual(["rest", "up"]);
    expect(ev.poses[1].joints.elbow).toEqual({ angles: [0, 0, 90], move: [0, 0, 0], scale: [1, 1, 1] });
    expect(ev.animations[0]).toMatchObject({ name: "lift", poses: ["rest", "up"], seconds: 0.5, loop: true });
    expect(ev.warnings).toEqual([]);
  });
  it("warns about poses naming unknown joints and animations naming unknown poses", () => {
    const w = evaluate(parse('a = joint(box(1), "k", 0, 0, 0)\npose("p", nope=[1,2,3])\nanimation("m", ["zzz"])')).warnings.join("\n");
    expect(w).toMatch(/pose "p" \(line 2\) sets joint "nope".*joints: k/);
    expect(w).toMatch(/animation "m" \(line 3\) uses pose "zzz"/);
    expect(() => evaluate(parse('pose(1)'))).toThrow(/pose's name/);
    expect(() => evaluate(parse('pose("p", k=[1, 2])'))).toThrow(/must be \[x, y, z\]/);
    expect(() => evaluate(parse('a = place(sphere(1), [1, 2, 3])'))).toThrow(/groups of 4/);
  });
});

describe("hierarchy and writers", () => {
  const body = O.paint(P.box(1, 1, 1), preset("blue")!);
  const forearm = O.joint(O.move(P.box(1.5, 0.3, 0.3), 2.25, 1, 0), "elbow", 1.5, 1, 0);
  const upper = O.joint(O.union([O.move(P.box(1.5, 0.3, 0.3), 0.75, 1, 0), forearm]), "shoulder", 0, 1, 0);
  const arm = O.union([body, upper]);
  const copies = O.place(P.sphere(0.4), [{ x: 0, y: 3, z: 0, yaw: 0, scale: 1 }, { x: 2, y: 3, z: 0, yaw: 90, scale: 0.5 }]);
  const h = buildHierarchy([{ name: "arm", shape: arm }, { name: "balls", shape: copies }], { cellSize: 0.08, texture: 256 });
  it("makes a node per object, joint and placement, with meshes relative to pivots", () => {
    const names = flatten(h).map((f) => f.node.name);
    expect(names).toEqual(["arm", "shoulder", "elbow", "balls", "balls_1", "balls_2"]);
    const shoulder = h.roots[0].children[0];
    expect(shoulder.translation).toEqual([0, 1, 0]);
    expect(shoulder.children[0].translation).toEqual([1.5, 0, 0]);
    // The elbow mesh sits from x = 0 to about 1.5 in its own frame.
    const em = h.meshes[shoulder.children[0].mesh];
    let maxX = -Infinity, minX = Infinity;
    for (let i = 0; i < em.positions.length; i += 3) { maxX = Math.max(maxX, em.positions[i]); minX = Math.min(minX, em.positions[i]); }
    expect(minX).toBeGreaterThan(-0.1);
    expect(maxX).toBeLessThan(1.6);
    expect(maxX).toBeGreaterThan(1.3);
    // Both placements share one mesh.
    expect(h.roots[1].children[0].mesh).toBe(h.roots[1].children[1].mesh);
    expect(h.roots[1].children[1].yaw).toBe(90);
    expect(h.atlas).toBeDefined();
    expect(h.uvs!.length).toBe(h.meshes.length);
  });
  it("writes a GLB with a node tree, a texture, and an animation on the joints", () => {
    const glb = toGlbScene(h, "t", [{ name: "lift", times: [0, 1], rotations: { shoulder: [eulerToQuat(0, 0, 0), eulerToQuat(0, 0, 45)], elbow: [eulerToQuat(0, 0, 0), eulerToQuat(0, 0, -30)] }, moves: { shoulder: [[0, 0, 0], [0, 0.5, 0]] }, scales: { elbow: [[1, 1, 1], [1, 2, 1]] } }]);
    const json = JSON.parse(glb.toString("utf8", 20, 20 + glb.readUInt32LE(12)));
    expect(json.scenes[0].nodes).toHaveLength(2);
    expect(json.nodes.map((n: { name: string }) => n.name)).toEqual(["arm", "shoulder", "elbow", "balls", "balls_1", "balls_2"]);
    expect(json.nodes[1].children).toEqual([2]);
    expect(json.nodes[5].scale).toEqual([0.5, 0.5, 0.5]);
    expect(json.animations[0].channels).toHaveLength(4);
    expect(json.animations[0].channels.map((c: { target: { path: string } }) => c.target.path)).toEqual(["rotation", "rotation", "translation", "scale"]);
    // The move channel is on top of the node's rest translation, so the joint does not jump to the origin when it plays.
    const shoulderNode = json.nodes[1];
    const moveSampler = json.animations[0].samplers[2];
    const acc = json.accessors[moveSampler.output];
    const view = json.bufferViews[acc.bufferView];
    const binStart = 20 + glb.readUInt32LE(12) + 8;
    const first = [0, 1, 2].map((k) => glb.readFloatLE(binStart + view.byteOffset + k * 4));
    const second = [0, 1, 2].map((k) => glb.readFloatLE(binStart + view.byteOffset + 12 + k * 4));
    expect(first).toEqual(shoulderNode.translation ?? [0, 0, 0]);
    expect(second[1]).toBeCloseTo((shoulderNode.translation?.[1] ?? 0) + 0.5, 5);
    expect(json.animations[0].channels[2].target.node).toBe(1);
    expect(json.animations[0].channels[3].target.node).toBe(2);
    expect(json.images).toHaveLength(1);
    expect(json.meshes[0].primitives[0].attributes.TEXCOORD_0).toBeDefined();
    expect(glb.readUInt32LE(8)).toBe(glb.length);
  });
  it("flattens to an OBJ with a group per node and world-space vertices", () => {
    const { obj } = toObjScene(h, "t", "t.mtl", "t.png");
    expect((obj.match(/^o /gm) ?? []).length).toBe(5);
    expect(obj).toMatch(/^o balls_2/m);
    expect(obj).toMatch(/^vt /m);
  });
  it("quaternions match the joint's rotation order", () => {
    const q = eulerToQuat(0, 0, 90);
    expect(q[2]).toBeCloseTo(Math.SQRT1_2);
    expect(q[3]).toBeCloseTo(Math.SQRT1_2);
  });
});

describe("poses", () => {
  const jp = (angles: [number, number, number] = [0, 0, 0], move: [number, number, number] = [0, 0, 0], scale: [number, number, number] = [1, 1, 1]): JointPose => ({ angles, move, scale });
  it("interpolates evenly spaced keyframes", () => {
    const keys: PoseView[] = [{ name: "a", joints: {} }, { name: "b", joints: { elbow: jp([0, 0, 90], [0, 1, 0], [1, 1, 3]) } }];
    expect(interpolatePose(keys, ["elbow"], 0.5).elbow).toEqual({ angles: [0, 0, 45], move: [0, 0.5, 0], scale: [1, 1, 2] });
    expect(interpolatePose(keys, ["elbow"], 1).elbow).toEqual({ angles: [0, 0, 90], move: [0, 1, 0], scale: [1, 1, 3] });
  });
  it("follows given times and eases at the keys", () => {
    const keys: PoseView[] = [{ name: "a", joints: {} }, { name: "b", joints: { k: jp([90, 0, 0]) } }, { name: "c", joints: {} }];
    // Keys at 0, 0.2 and 1 second: the middle key comes early, so at a fifth of the way the joint is fully turned.
    expect(interpolatePose(keys, ["k"], 0.2, { times: [0, 0.2, 1] }).k.angles[0]).toBeCloseTo(90, 6);
    expect(interpolatePose(keys, ["k"], 0.1, { times: [0, 0.2, 1] }).k.angles[0]).toBeCloseTo(45, 6);
    expect(interpolatePose(keys, ["k"], 0.6, { times: [0, 0.2, 1] }).k.angles[0]).toBeCloseTo(45, 6);
    expect(keyAt(3, 1, { times: [0, 0.2, 1] })).toEqual({ i: 1, u: 1 });
    // A full ease is a cosine blend: still 0 and 1 at the ends, half way at the middle, and slower near the keys.
    expect(easeBlend(0, 1)).toBe(0);
    expect(easeBlend(1, 1)).toBeCloseTo(1, 12);
    expect(easeBlend(0.5, 1)).toBeCloseTo(0.5, 12);
    expect(easeBlend(0.25, 1)).toBeLessThan(0.25);
    expect(easeBlend(0.25, 0.5)).toBeCloseTo((0.25 + easeBlend(0.25, 1)) / 2, 12);
    expect(interpolatePose(keys, ["k"], 0.125, { ease: 1 }).k.angles[0]).toBeCloseTo(90 * easeBlend(0.25, 1), 6);
  });
  it("renders a pose sheet with rest first, rebuilding the shape per pose", () => {
    const shapeAt = (joints: Record<string, JointPose>) =>
      O.union([P.box(0.5, 0.5, 0.5), O.joint(O.move(P.box(2, 0.3, 0.3), 1, 0, 0), "elbow", 0, 0, 0, joints.elbow?.angles ?? [0, 0, 0])]);
    const c = renderPoses(shapeAt, ["elbow"], [{ name: "up", joints: { elbow: jp([0, 0, 90]) } }], 60, 0.1);
    expect(c.width).toBe(2 * 66 + 6);
  });
  it("a pose takes a transform value, and animations take times and ease", () => {
    const src = [
      'body = joint(sphere(1), "body", 0, 0, 0)',
      'pose("hop", body=xform(move=[0, 2, 0], scale=[1, 1.5, 1]))',
      'pose("turn", body=xform(rotate=[0, 90, 0]))',
      'animation("bounce", ["rest", "hop", "rest"], times=[0, 0.3, 1], ease=1)',
      'show body',
    ].join("\n");
    const ev = evaluate(parse(src));
    expect(ev.warnings).toEqual([]);
    expect(ev.poses[0].joints.body).toEqual({ angles: [0, 0, 0], move: [0, 2, 0], scale: [1, 1.5, 1] });
    expect(ev.poses[1].joints.body).toEqual({ angles: [0, 90, 0], move: [0, 0, 0], scale: [1, 1, 1] });
    expect(ev.animations[0]).toMatchObject({ seconds: 1, times: [0, 0.3, 1], ease: 1 });
    // In the hop pose the sphere sits 2 up and is stretched to 1.5 tall about its pivot.
    const hop = evaluate(parse(src), { jointPoses: ev.poses[0].joints }).output!;
    expect(hop.dist(0, 2, 0)).toBeLessThan(0);
    expect(hop.dist(0, 0, 0)).toBeGreaterThan(0);
    expect(hop.dist(0, 3.4, 0)).toBeLessThan(0);
    expect(hop.dist(1.2, 2, 0)).toBeGreaterThan(0);
    expect(hop.bounds.max[1]).toBeGreaterThanOrEqual(3.5);
    // A single angle in an xform is the axis form, checked like a bare number.
    const w = evaluate(parse('a = joint(box(1), "k", 0, 0, 0)\npose("p", k=xform(rotate=30))\nshow a')).warnings.join("\n");
    expect(w).toMatch(/k is one number, but joint "k" has no axis=/);
    expect(() => evaluate(parse('xform(rotate=[1, 2])'))).toThrow(/rotate must be \[x, y, z\]/);
    expect(() => evaluate(parse('pose("p", k="no")'))).toThrow(/xform\(rotate=, move=, scale=\)/);
    expect(() => evaluate(parse('animation("m", ["rest", "rest"], times=[0])'))).toThrow(/1 entries for 2 poses/);
    expect(() => evaluate(parse('animation("m", ["rest", "rest"], times=[0.5, 1])'))).toThrow(/must start at 0/);
    expect(() => evaluate(parse('animation("m", ["rest", "rest", "rest"], times=[0, 1, 1])'))).toThrow(/must increase/);
    expect(() => evaluate(parse('animation("m", ["rest", "rest"], seconds=2, times=[0, 1])'))).toThrow(/seconds=2 but times ends at 1/);
    expect(() => evaluate(parse('animation("m", ["rest", "rest"], ease=2)'))).toThrow(/ease is a number from 0/);
    expect(() => evaluate(parse('animation("m", ["rest", "rest"], speed=2)'))).toThrow(/no parameter named 'speed'/);
  });
});

describe("pipeline with a scene", () => {
  it("writes poses, an animation strip, and a multi-node GLB", () => {
    const dir = mkdtempSync(join(tmpdir(), "aixle-"));
    try {
      const src = 'a = box(1) | move(0, 0.5, 0)\narm = joint(box(1.5, 0.3, 0.3) | move(0.75, 1.2, 0), "elbow", 0, 1.2, 0)\npose("up", elbow=xform(rotate=[0, 0, 60], move=[0, 0.2, 0], scale=[1, 1, 1.5]))\nanimation("lift", ["rest", "up"], seconds=1)\nanimation("soft", ["rest", "up", "rest"], times=[0, 0.25, 1], ease=1)\nscene a, arm';
      const r = run(src, "s.aix", dir, { grid: 24, size: 96, views: [], slices: false, turntable: false, steps: false, texture: 128, minecraft: 8 });
      expect(r.files).toContain("poses.png");
      // The Bedrock geometry has the joint as a bone under the object, and the animations as keyframes on it.
      expect(r.files).toContain("model.animation.json");
      const geo = JSON.parse(readFileSync(join(dir, "model.geo.json"), "utf8"));
      expect(geo["minecraft:geometry"][0].bones.map((b: { name: string; parent?: string }) => [b.name, b.parent])).toEqual([["a", undefined], ["elbow", undefined]]);
      const anim = JSON.parse(readFileSync(join(dir, "model.animation.json"), "utf8"));
      expect(Object.keys(anim.animations)).toEqual(["animation.s.lift", "animation.s.soft"]);
      expect(Object.keys(anim.animations["animation.s.lift"].bones.elbow)).toEqual(["rotation", "position", "scale"]);
      expect(Object.keys(anim.animations["animation.s.soft"].bones.elbow.rotation)).toHaveLength(17);
      expect(anim.animations["animation.s.lift"].bones.elbow.rotation["1.0"]).toEqual([0, 0, -60]);
      expect(r.report).toMatch(/Minecraft.*\(1 joint\).*animation\.s\.lift, animation\.s\.soft in model\.animation\.json/);
      expect(r.files).toContain("anim_lift.png");
      expect(r.files).toContain("model.glb");
      const glb = readFileSync(join(dir, "model.glb"));
      const json = JSON.parse(glb.toString("utf8", 20, 20 + glb.readUInt32LE(12)));
      expect(json.nodes.map((n: { name: string }) => n.name)).toEqual(["a", "arm", "elbow"]);
      expect(json.animations[0].name).toBe("lift");
      expect(json.animations[0].channels.map((c: { target: { path: string } }) => c.target.path)).toEqual(["rotation", "translation", "scale"]);
      // An eased animation is sampled eight times per segment for glTF's linear samplers: 2 segments make 17 keys.
      expect(json.accessors[json.animations[1].samplers[0].input].count).toBe(17);
      expect(json.accessors[json.animations[0].samplers[0].input].count).toBe(2);
      expect(r.files).toContain("anim_soft.png");
      expect(r.report).toMatch(/Joints: elbow/);
      expect(existsSync(join(dir, "model.png"))).toBe(true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("a move above a joint", () => {
  it("carries the joint's node and mesh with it in the export", async () => {
    const { buildHierarchy } = await import("../src/export/hierarchy.js");
    const { evaluate } = await import("../src/lang/interpreter.js");
    const { parse } = await import("../src/lang/parser.js");
    const src = 'blade = box(0.2, 1, 0.2) | move(0, -0.5, 0)\nhelm = joint(blade, "helm", 0, 0, 2)\nhull = box(2, 0.5, 4)\nboat = (hull + helm) | move(0, 1, 0)\nshow boat';
    const ev = evaluate(parse(src));
    const h = buildHierarchy(ev.objects, { cellSize: 0.05, texture: 0 });
    const node = h.roots[0].children[0];
    expect(node.joint).toBe("helm");
    expect(node.translation[1]).toBeCloseTo(1, 6);
    expect(h.notes).toEqual([]);
    // The blade's mesh is relative to the moved pivot: it hangs below it, not a unit lower still.
    const m = h.meshes[node.mesh];
    let minY = Infinity, maxY = -Infinity;
    for (let i = 1; i < m.positions.length; i += 3) { minY = Math.min(minY, m.positions[i]); maxY = Math.max(maxY, m.positions[i]); }
    expect(minY).toBeCloseTo(-1, 1);
    expect(maxY).toBeCloseTo(0, 1);
    const turned = evaluate(parse(src.replace("| move(0, 1, 0)", "| rotate(y=90)")));
    expect(buildHierarchy(turned.objects, { cellSize: 0.05, texture: 0 }).notes.join()).toMatch(/joint "helm" sits under a rotation/);
  });
});

describe("placed sets inside an object", () => {
  it("keep their per-copy nodes when joined to other parts with +, and focus can frame one copy", async () => {
    const { buildHierarchy } = await import("../src/export/hierarchy.js");
    const { evaluate } = await import("../src/lang/interpreter.js");
    const { parse } = await import("../src/lang/parser.js");
    const src = "pawn = cylinder(0.2, 0.5) | move(0, 0.25, 0)\npawns = place(pawn, [-1,0,0,0, 0,0,0,0, 1,0,0,0])\nboard = box(4, 0.2, 4) | move(0, -0.1, 0)\narmy = board + pawns\nshow army";
    const ev = evaluate(parse(src));
    const { isShape3 } = await import("../src/lang/values.js");
    const names = new Map<import("../src/sdf/types.js").Shape3, string>();
    for (const st of ev.steps) if (isShape3(st.value) && !names.has(st.value)) names.set(st.value, st.name);
    const h = buildHierarchy(ev.objects, { cellSize: 0.05, texture: 0, names });
    const root = h.roots[0];
    const set = root.children.find((c) => c.name === "pawns")!;
    expect(set).toBeDefined();
    expect(set.children.map((c) => c.name)).toEqual(["pawns_1", "pawns_2", "pawns_3"]);
    expect(set.children[2].translation[0]).toBe(1);
    // The board's own mesh is the board alone: nothing near a pawn's top.
    const own = h.meshes[root.mesh];
    let maxY = -Infinity;
    for (let i = 1; i < own.positions.length; i += 3) maxY = Math.max(maxY, own.positions[i]);
    expect(maxY).toBeLessThan(0.1);
    // One mesh for the three copies.
    expect(new Set(set.children.map((c) => c.mesh)).size).toBe(1);
  });
});
