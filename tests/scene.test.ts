import { describe, expect, it } from "vitest";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as P from "../src/sdf/primitives.js";
import * as O from "../src/sdf/ops.js";
import { parse } from "../src/lang/parser.js";
import { evaluate } from "../src/lang/interpreter.js";
import { buildHierarchy, flatten } from "../src/export/hierarchy.js";
import { eulerToQuat, GLB_RANGE_CUTOFF, glbLights, toGlbScene } from "../src/export/glb.js";
import { toObjScene } from "../src/export/obj.js";
import { easeBlend, interpolatePose, keyAt, renderAnimation, renderPoses, type PoseCache, type PoseView } from "../src/render/views.js";
import { REST_POSE, type JointPose } from "../src/sdf/types.js";
import { run } from "../src/pipeline.js";
import * as pipelineFns from "../src/pipeline.js";
import { check } from "../src/pipeline.js";
import { halfBase64, STUDIO, THREE_VERSION, toHalf, viewerHtml, type ViewerScene } from "../src/export/viewer.js";
import { encode, GLOW, KEY, TONEMAP_GLSL, toLinear } from "../src/render/photometry.js";
import { buildSky, DEFAULT_LIGHT_DIRECTION, environmentLatLong, environmentPalette, horizonRadiance, irradiance, lightDirection } from "../src/render/environment.js";
import { decode } from "../src/render/photometry.js";
import { surfaceNets } from "../src/mesh/surfaceNets.js";
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

describe("the export takes the main mesh again", () => {
  const cup = O.difference(O.paint(P.cylinder(1, 2), preset("blue")!), O.move(P.cylinder(0.8, 2), 0, 0.2, 0));
  const res = 40;
  const main = surfaceNets(cup, { resolution: res, bounds: cup.bounds });
  const known = { shape: cup, mesh: main.mesh, resolution: res, bounds: cup.bounds };
  const bytes = (m: { positions: Float32Array; indices: Uint32Array; normals: Float32Array }) => [Buffer.from(m.positions.buffer).toString("base64"), Buffer.from(m.indices.buffer).toString("base64"), Buffer.from(m.normals.buffer).toString("base64")];
  it("for one object with nothing hidden, extracted by the same call: the same mesh, not a second extraction", () => {
    const fresh = buildHierarchy([{ name: "cup", shape: cup }], { cellSize: main.cellSize, texture: 0 });
    const again = buildHierarchy([{ name: "cup", shape: cup }], { cellSize: main.cellSize, texture: 0, known });
    expect(again.meshes[0]).toBe(main.mesh);
    expect(bytes(again.meshes[0])).toEqual(bytes(fresh.meshes[0]));
  });
  it("misses, and extracts, where any argument differs: a tightened box, another resolution, a joint, another shape", () => {
    const tight = { ...known, bounds: { min: [-1, -1, -1] as [number, number, number], max: [1, 0.9, 1] as [number, number, number] } };
    expect(buildHierarchy([{ name: "cup", shape: cup }], { cellSize: main.cellSize, texture: 0, known: tight }).meshes[0]).not.toBe(main.mesh);
    expect(buildHierarchy([{ name: "cup", shape: cup }], { cellSize: main.cellSize * 0.99, texture: 0, known }).meshes[0]).not.toBe(main.mesh);
    expect(buildHierarchy([{ name: "cup", shape: cup }], { cellSize: main.cellSize, texture: 0, known, crease: 20 }).meshes[0]).not.toBe(main.mesh);
    const jointed = O.union([cup, O.joint(O.move(P.box(0.2, 0.2, 0.2), 1.2, 0, 0), "tab", 1, 0, 0)]);
    const jm = surfaceNets(jointed, { resolution: res, bounds: jointed.bounds });
    const h = buildHierarchy([{ name: "cup", shape: jointed }], { cellSize: jm.cellSize, texture: 0, known: { shape: jointed, mesh: jm.mesh, resolution: res, bounds: jointed.bounds } });
    expect(h.meshes[0]).not.toBe(jm.mesh);
    expect(buildHierarchy([{ name: "cup", shape: O.move(cup, 0, 0, 0) }], { cellSize: main.cellSize, texture: 0, known }).meshes[0]).not.toBe(main.mesh);
  });
  it("is copied by the decimation cap and the atlas, never changed in place", () => {
    const before = bytes(main.mesh);
    const capped = buildHierarchy([{ name: "cup", shape: cup }], { cellSize: main.cellSize, texture: 64, maxTriangles: 500, known });
    const fresh = buildHierarchy([{ name: "cup", shape: cup }], { cellSize: main.cellSize, texture: 64, maxTriangles: 500 });
    expect(capped.decimated).toBeDefined();
    expect(bytes(main.mesh)).toEqual(before);
    expect(capped.meshes[0]).not.toBe(main.mesh);
    expect(bytes(capped.meshes[0])).toEqual(bytes(fresh.meshes[0]));
    expect(Buffer.from(capped.uvs![0].buffer).equals(Buffer.from(fresh.uvs![0].buffer))).toBe(true);
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
  it("eases the first and last key by ease_ends alone", () => {
    // A lone ease at one end is a quarter sine: it moves at once and settles, or starts slow and runs out straight.
    expect(easeBlend(0.5, 0, 1)).toBeCloseTo(Math.sin(Math.PI / 4), 12);
    expect(easeBlend(0.5, 1, 0)).toBeCloseTo(1 - Math.cos(Math.PI / 4), 12);
    expect(easeBlend(0, 1, 0)).toBe(0);
    expect(easeBlend(1, 0, 1)).toBeCloseTo(1, 12);
    expect(easeBlend(0.25, 0, 0)).toBe(0.25);
    // Three keys, eased between but not at the ends: the first segment eases out only, the last in only.
    expect(keyAt(3, 0.25, { ease: 1, easeEnds: 0 })).toEqual({ i: 0, u: easeBlend(0.5, 0, 1) });
    expect(keyAt(3, 0.75, { ease: 1, easeEnds: 0 })).toEqual({ i: 1, u: easeBlend(0.5, 1, 0) });
    // With given times the same, and a two-key animation has ends only.
    expect(keyAt(3, 0.1, { times: [0, 0.4, 1], ease: 1, easeEnds: 0 })).toEqual({ i: 0, u: easeBlend(0.25, 0, 1) });
    expect(keyAt(2, 0.25, { ease: 1, easeEnds: 0 })).toEqual({ i: 0, u: 0.25 });
    expect(keyAt(2, 0.25, { ease: 0, easeEnds: 1 })).toEqual({ i: 0, u: easeBlend(0.25, 1, 1) });
    // Left out, the ends ease like the rest.
    expect(keyAt(3, 0.25, { ease: 1 })).toEqual({ i: 0, u: easeBlend(0.5, 1, 1) });
  });
  it("renders a pose sheet with rest first, rebuilding the shape per pose", () => {
    const shapeAt = (joints: Record<string, JointPose>) =>
      O.union([P.box(0.5, 0.5, 0.5), O.joint(O.move(P.box(2, 0.3, 0.3), 1, 0, 0), "elbow", 0, 0, 0, joints.elbow?.angles ?? [0, 0, 0])]);
    const c = renderPoses(shapeAt, ["elbow"], [{ name: "up", joints: { elbow: jp([0, 0, 90]) } }], 60, 0.1);
    expect(c.width).toBe(2 * 66 + 6);
  });
  it("meshes each distinct pose once across the sheet and the strips, names every joint, and says once or loop", () => {
    let calls = 0;
    const shapeAt = (joints: Record<string, JointPose>) => { calls++; return O.union([P.box(0.5, 0.5, 0.5), O.joint(O.move(P.box(2, 0.3, 0.3), 1, 0, 0), "elbow", 0, 0, 0, joints.elbow?.angles ?? [0, 0, 0])]); };
    const cache: PoseCache = new Map();
    const up: PoseView = { name: "up", joints: { elbow: jp([0, 0, 90]) } };
    const shut: PoseView = { name: "shut", joints: {} };
    renderPoses(shapeAt, ["elbow"], [up, shut], 60, 0.1, undefined, undefined, cache);
    // rest and shut are the same pose: two meshes for three thumbnails.
    expect(calls).toBe(2);
    // A held key: five of eight frames are the rest pose, meshed no more.
    renderAnimation(shapeAt, ["elbow"], "pop", [shut, shut, shut, up], 1, 40, 0.1, 8, undefined, undefined, { times: [0, 0.5, 0.6, 1], loop: false }, cache);
    expect(calls).toBeLessThan(2 + 8);
    // Ten joints all go in the bar, wrapped, so the sheet grows rather than cutting the list at six.
    const many = Array.from({ length: 10 }, (_, i) => `joint_number_${i}`);
    const wide = renderPoses(shapeAt, many, [up], 60, 0.1);
    const few = renderPoses(shapeAt, ["elbow"], [up], 60, 0.1);
    expect(wide.height).toBeGreaterThan(few.height);
    expect(wide.width).toBe(few.width);
  });
  it("joint_move and joint_scale read the current pose, and asserts are judged at rest", () => {
    const src = 'body = joint(sphere(1), "body", 0, 0, 0)\nm = joint_move("body")\ns = joint_scale("body")\nshow body';
    const rest = evaluate(parse(src));
    expect(rest.steps.find((x) => x.name === "m")!.value).toEqual([0, 0, 0]);
    expect(rest.steps.find((x) => x.name === "s")!.value).toEqual([1, 1, 1]);
    const posed = evaluate(parse(src), { jointPoses: { body: jp([0, 0, 0], [0, 2, 0], [1, 1.5, 1]) } });
    expect(posed.steps.find((x) => x.name === "m")!.value).toEqual([0, 2, 0]);
    expect(posed.steps.find((x) => x.name === "s")!.value).toEqual([1, 1.5, 1]);
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
    expect(ev.animations[0]).toMatchObject({ seconds: 1, times: [0, 0.3, 1], ease: 1, easeEnds: 1 });
    expect(evaluate(parse('animation("m", ["rest", "rest", "rest"], ease=1, ease_ends=0)')).animations[0]).toMatchObject({ ease: 1, easeEnds: 0 });
    expect(() => evaluate(parse('animation("m", ["rest", "rest"], ease_ends=2)'))).toThrow(/ease_ends is a number from 0 to 1/);
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
      // A promise about the model as built holds in a pose that lifts it (round 7: a rig's height assert failed in its jump).
      const posed = run(`${src}\nassert tall(arm) < 1.4, "at rest"`, "s.aix", dir, { grid: 24, size: 96, views: [], slices: false, turntable: false, steps: false, texture: 128, pose: "up", obj: false, glb: false });
      expect(posed.warnings.filter((w) => /assert/.test(w))).toEqual([]);
      expect(posed.report).toMatch(/\| Asserts \| 1 pass \(judged at rest\)/);
      expect(posed.report).toMatch(/\| Stands \(in pose up\)/);
      // An assert that names a pose is judged in that pose whichever pose is shown, and says so in its line.
      const inPose = run(`${src}\nassert tall(arm) < 1.4, "at rest"\nassert tall(arm) > 1.4, "lifted", pose=up\nassert tall(arm) < 1.4, "still at rest", pose=up`, "s.aix", dir, { grid: 24, size: 96, views: [], slices: false, turntable: false, steps: false, texture: 128, obj: false, glb: false, quick: true });
      expect(inPose.warnings.filter((w) => /assert/.test(w))).toEqual([expect.stringMatching(/^assert \(line 9\) in pose up fails: tall\(arm\) < 1\.4 is [\d.]+ < 1\.4: still at rest$/)]);
      expect(inPose.report).toMatch(/\| Asserts \| 2 pass, 1 fail: \(line 9\) in pose up fails: .* \(at rest, or in the pose each names\) \|/);
      const reportJson = JSON.parse(readFileSync(join(dir, "report.json"), "utf8"));
      expect(reportJson.asserts.map((a: { line: number; passed: boolean; pose?: string }) => [a.line, a.passed, a.pose])).toEqual([[7, true, undefined], [8, true, "up"], [9, false, "up"]]);
      // ease_ends: the loop's seam runs straight, so only the middle segments are densified in the GLB.
      const ends = run(`${src}\nanimation("cycle", ["rest", "up", "rest", "up"], ease=1, ease_ends=0)\nanimation("launch", ["rest", "up"], ease=0, ease_ends=1)`, "s.aix", dir, { grid: 24, size: 96, views: [], slices: false, turntable: false, steps: false, texture: 128, obj: false, quick: true, minecraft: 8 });
      const g2 = readFileSync(join(dir, "model.glb"));
      const j2 = JSON.parse(g2.toString("utf8", 20, 20 + g2.readUInt32LE(12)));
      const cycle = j2.animations.find((a: { name: string }) => a.name === "cycle"), launch = j2.animations.find((a: { name: string }) => a.name === "launch");
      // cycle: three segments, the first and last eased at one key each (8 samples), the middle at both (8): 25 keys.
      expect(j2.accessors[cycle.samplers[0].input].count).toBe(25);
      // launch: one segment whose two keys are both ends, eased by ease_ends: 9 keys.
      expect(j2.accessors[launch.samplers[0].input].count).toBe(9);
      expect(ends.report).toMatch(/cycle \(rest → up → rest → up, 1s, loop, ease 1, ends 0\); launch \(rest → up, 1s, loop, ends 1\)/);
      // A quick pass draws the pose sheet but not the strips.
      const quick = run(src, "s.aix", dir, { grid: 24, size: 96, views: [], slices: false, turntable: false, steps: false, texture: 128, quick: true, obj: false, glb: false });
      expect(quick.files).toContain("poses.png");
      expect(quick.files).not.toContain("anim_lift.png");
      expect(r.report).toMatch(/Joints, each under the joint it turns with:\n\n```\nelbow at \(0, 1.2, 0\)\n```/);
      expect(r.report).toMatch(/lift \(rest → up, 1s, loop\); soft \(rest 0s → up 0.25s → rest 1s, 1s, loop, ease 1\)/);
      // The first run's atlas; the quick run after it, which writes none, removed it from the folder.
      expect(r.files).toContain("model.png");
      expect(existsSync(join(dir, "model.png"))).toBe(false);
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

describe("a triangle cap on the exports", () => {
  it("decimates each mesh in its own frame and measures how far it strays from the field", async () => {
    const { faceDeviation } = await import("../src/mesh/decimate.js");
    const { triangleCount } = await import("../src/mesh/mesh.js");
    // A body with a jointed leg: the leg's mesh is relative to its pivot, so a deviation read in the wrong frame
    // would be the pivot's distance, not a fraction of a cell.
    const leg = O.joint(O.move(P.cylinder(0.2, 1), 0.6, 0.5, 0), "leg", 0.6, 1, 0);
    const pet = O.union([O.move(P.sphere(0.8), 0, 1, 0), leg]);
    const cell = 0.02;
    const full = buildHierarchy([{ name: "pet", shape: pet }], { cellSize: cell, texture: 0 });
    expect(full.decimated).toBeUndefined();
    const h = buildHierarchy([{ name: "pet", shape: pet }], { cellSize: cell, texture: 0, maxTriangles: 6000 });
    expect(h.triangles).toBeLessThanOrEqual(6000);
    expect(h.decimated!.before).toBe(full.triangles);
    expect(h.decimated!.deviation).toBeGreaterThanOrEqual(h.decimated!.fullDeviation);
    expect(h.decimated!.deviation).toBeLessThan(cell);
    expect(h.decimated!.fullDeviation).toBeGreaterThan(0);
    // The same measure by hand on the body: its sphere's field at its own face centres.
    const sphereMesh = (await import("../src/mesh/surfaceNets.js")).surfaceNets(P.sphere(1), { resolution: 24 }).mesh;
    expect(faceDeviation(sphereMesh, (x, y, z) => Math.hypot(x, y, z) - 1)).toBeLessThan(2 / 24);
    expect(faceDeviation(sphereMesh, (x, y, z) => Math.hypot(x - 5, y, z) - 1, [5, 0, 0])).toBeCloseTo(faceDeviation(sphereMesh, (x, y, z) => Math.hypot(x, y, z) - 1), 9);
    expect(triangleCount(h.meshes[0]) + triangleCount(h.meshes[1])).toBe(h.triangles);
  });
  it("shares the cap by error over every mesh: a flat box gives up its triangles and a sphere beside it keeps them", () => {
    // Round 11: each mesh kept the same share of its own count, so a flat wall kept 35196 of a 54996 cap.
    const cell = 0.025;
    const slab = O.move(P.box(2, 1, 0.5), 0, 0.5, 0);
    const ball = O.move(P.sphere(0.4), 2, 0.4, 0);
    const full = buildHierarchy([{ name: "slab", shape: slab }, { name: "ball", shape: ball }], { cellSize: cell, texture: 0 });
    const [slabN, ballN] = full.meshes.map((m) => m.indices.length / 3);
    const cap = Math.round(ballN * 1.2);
    const h = buildHierarchy([{ name: "slab", shape: slab }, { name: "ball", shape: ball }], { cellSize: cell, texture: 0, maxTriangles: cap });
    expect(h.triangles).toBeLessThanOrEqual(cap);
    const [slabD, ballD] = h.meshes.map((m) => m.indices.length / 3);
    // The flat box keeps a few percent; the sphere, all but a few.
    expect(slabD).toBeLessThan(slabN * 0.1);
    expect(ballD).toBeGreaterThan(ballN * 0.95);
    // Nothing curved was given up for the cap, so the export strays no further than the full mesh.
    expect(h.decimated!.deviation).toBeLessThanOrEqual(h.decimated!.fullDeviation * 1.05);
    // How it was shared, by node, for the report, and how far the flat faces alone could go.
    expect(h.decimated!.meshes).toEqual([{ name: "slab", before: slabN, after: slabD }, { name: "ball", before: ballN, after: ballD }]);
    // The flat faces alone come down to the sphere and a few hundred of the box's.
    expect(h.decimated!.flat).toBeLessThan(ballN + slabN * 0.1);
    expect(h.decimated!.flat).toBeGreaterThanOrEqual(ballN);
  });
  it("caps the GLB, OBJ and viewer at set triangles, says so in the report, and leaves the sheet and the STL whole", () => {
    const dir = mkdtempSync(join(tmpdir(), "aixle-"));
    try {
      const src = 'v = (cylinder(1, 2, round=0.2) - (cylinder(0.8, 2) | move(0, 0.3, 0))) | paint("porcelain")\nset triangles 3000\nshow v';
      const opts = { grid: 48, size: 64, views: [] as never[], steps: false, slices: false, turntable: false, callouts: false, texture: 64 };
      const r = run(src, "cup.aix", dir, opts);
      const glb = readFileSync(join(dir, "model.glb"));
      const json = JSON.parse(glb.toString("utf8", 20, 20 + glb.readUInt32LE(12)));
      let tris = 0;
      for (const m of json.meshes) for (const p of m.primitives) tris += json.accessors[p.indices].count / 3;
      expect(tris).toBeLessThanOrEqual(3000);
      const obj = readFileSync(join(dir, "model.obj"), "utf8");
      expect(obj.split("\n").filter((l) => l.startsWith("f ")).length).toBe(tris);
      const report = readFileSync(join(dir, "report.md"), "utf8");
      const full = r.mesh!.indices.length / 3;
      expect(full).toBeGreaterThan(3000);
      expect(report).toMatch(new RegExp(`\\| Exports \\| ${tris} triangles in the GLB, OBJ and viewer, decimated from \\d+ \\(set triangles 3000; 0 for all of them\\): at most [\\d.]+ from the surface at a face centre, [\\d.]+ of a cell \\(the full mesh [\\d.]+\\)`));
      // The STL is the model as shown, whole: 84 bytes of header and count, 50 a triangle.
      expect(readFileSync(join(dir, "model.stl")).length).toBe(84 + 50 * full);
      const data = JSON.parse(readFileSync(join(dir, "report.json"), "utf8"));
      expect(data.exports.triangles).toBe(tris);
      expect(data.exports.cap).toBe(3000);
      expect(data.triangles).toBe(full);
      // How the cap was shared, by mesh, and how far merging flat faces alone would go.
      expect(data.exports.meshes).toEqual([{ name: "v", before: data.exports.before, after: tris }]);
      expect(report).toMatch(new RegExp(`By error, the flattest faces first: v ${data.exports.before} to ${tris}; merging flat faces alone (comes|came) to ${data.exports.flat}`));
      // 0 is the full mesh, and the run's option wins over the program's setting.
      const whole = run(src, "cup.aix", join(dir, "whole"), { ...opts, triangles: 0 });
      expect(whole.report).not.toMatch(/\| Exports \|/);
      const g2 = readFileSync(join(dir, "whole", "model.glb"));
      const j2 = JSON.parse(g2.toString("utf8", 20, 20 + g2.readUInt32LE(12)));
      expect(j2.meshes[0].primitives.reduce((s: number, p: { indices: number }) => s + j2.accessors[p.indices].count / 3, 0)).toBeGreaterThan(3000);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
  it("says merged faces carry the field's normal past the flat faces only when a normal map was baked to carry it", () => {
    // Review of round 11's fixes: with --no-texture there is no normal map, and the row claimed one all the same.
    const dir = mkdtempSync(join(tmpdir(), "aixle-"));
    try {
      const src = 'b = sphere(0.5) | paint("red")\nset triangles 300\nshow b';
      const opts = { grid: 40, size: 64, views: [] as never[], steps: false, slices: false, turntable: false, callouts: false, viewer: false };
      const mapped = run(src, "ball.aix", join(dir, "mapped"), { ...opts, texture: 64 });
      const data = JSON.parse(readFileSync(join(dir, "mapped", "report.json"), "utf8"));
      expect(data.exports.triangles).toBeLessThan(data.exports.flat);
      expect(mapped.files).toContain("model_normal.png");
      expect(mapped.report).toMatch(/past the flat faces, so every material's texels carry the field's normal in the normal map/);
      const plain = run(src, "ball.aix", join(dir, "plain"), { ...opts, texture: 0 });
      expect(plain.files).not.toContain("model_normal.png");
      expect(plain.report).not.toMatch(/carry the field's normal in the normal map/);
      expect(plain.report).toMatch(/past the flat faces, and with no texture atlas there is no normal map to carry the field's normal, so merged curved faces shade flatter/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
  it("warns past a cell with a cap that would raise the count, though each mesh keeps a few triangles under any cap", () => {
    const dir = mkdtempSync(join(tmpdir(), "aixle-"));
    try {
      // Three meshes keep at least four triangles each, so a cap of 1 exports 12: doubling the cap to 2 changes nothing.
      const src = 'a = sphere(0.5) | paint("red")\nb = sphere(0.5) | move(2, 0, 0) | paint("red")\nc = sphere(0.5) | move(4, 0, 0) | paint("red")\nset triangles 1\nscene a, b, c';
      const r = run(src, "balls.aix", dir, { grid: 48, size: 64, views: [] as never[], steps: false, slices: false, turntable: false, callouts: false, viewer: false, texture: 0 });
      const data = JSON.parse(readFileSync(join(dir, "report.json"), "utf8"));
      expect(data.exports.triangles).toBeGreaterThan(1);
      const w = r.warnings.find((x) => /The exports are decimated/.test(x));
      expect(w).toBeDefined();
      const suggested = Number(/raise the cap \(set triangles (\d+)\)/.exec(w!)![1]);
      expect(suggested).toBeGreaterThan(data.exports.triangles);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
  it("gives the Roblox row the full mesh's count, not the web export's, as what its budget was decimated from", () => {
    const dir = mkdtempSync(join(tmpdir(), "aixle-"));
    try {
      // An accessory (4000) under a web cap of 6000: the Roblox meshes are decimated from the full extraction.
      const src = 'v = (cylinder(1, 2, round=0.2) - (cylinder(0.8, 2) | move(0, 0.3, 0))) | paint("porcelain")\nv = anchor(v, "HatAttachment", 0, 1, 0)\nset triangles 6000\nshow v';
      const r = run(src, "cup.aix", dir, { grid: 64, size: 64, views: [] as never[], steps: false, slices: false, turntable: false, callouts: false, viewer: false, texture: 64, roblox: true });
      const data = JSON.parse(readFileSync(join(dir, "report.json"), "utf8"));
      expect(data.exports.before).toBeGreaterThan(6000);
      expect(r.report).toMatch(new RegExp(`\\| Roblox \\| one mesh, Handle, \\d+ triangles, decimated from ${data.exports.before};`));
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("the program's lights and scene in the exports", () => {
  it("writes each light as a KHR_lights_punctual light on its own node, and the viewer a scene mode with the sky and cameras", () => {
    // Round 11: a torch that lit a door in beauty.png lit nothing in an engine, and the viewer had only its studio.
    const dir = mkdtempSync(join(tmpdir(), "aixle-"));
    try {
      const src = [
        'door = box(1, 2, 0.1) | move(0, 1, 0) | paint("oak")',
        "set environment night",
        "set ambient 1.3",
        'light("torch", position=[0.6, 1.8, 0.4], range=1.5, color="#ff8800", power=2)',
        'light("moon", azimuth=-50, elevation=40, power=0.5, color="#9fb4ff")',
        'camera("hero", azimuth=20, elevation=10, zoom=1.2)',
        "set camera hero",
        "show door",
      ].join("\n");
      run(src, "door.aix", dir, { grid: 32, size: 64, views: [] as never[], steps: false, slices: false, turntable: false, callouts: false, texture: 64 });
      const glb = readFileSync(join(dir, "model.glb"));
      const json = JSON.parse(glb.toString("utf8", 20, 20 + glb.readUInt32LE(12)));
      expect(json.extensionsUsed).toContain("KHR_lights_punctual");
      const lights = json.extensions.KHR_lights_punctual.lights;
      expect(lights.map((l: { name: string; type: string }) => [l.name, l.type])).toEqual([["torch", "point"], ["moon", "directional"]]);
      // A point light in candela, π·KEY·power·range², the beauty render's strength at range² over d² far off; glTF's
      // range is the cutoff, three times it.
      expect(lights[0].intensity).toBeCloseTo(Math.PI * 1.05 * 2 * 1.5 * 1.5, 3);
      expect(lights[0].range).toBeCloseTo(4.5, 6);
      // Colours are linear: #ff8800's green is 0.533 in sRGB, 0.246 linear.
      expect(lights[0].color[0]).toBeCloseTo(1, 4);
      expect(lights[0].color[1]).toBeCloseTo(0.2462, 3);
      expect(lights[0].color[2]).toBeCloseTo(0, 6);
      expect(lights[1].intensity).toBeCloseTo(Math.PI * 1.05 * 0.5, 4);
      expect(lights[1].range).toBeUndefined();
      // Each on a root node of the scene; the point light at its position, the directional one turned so its -z runs
      // from the light towards the model.
      const nodeOf = (i: number) => json.nodes.find((n: { extensions?: { KHR_lights_punctual?: { light: number } } }) => n.extensions?.KHR_lights_punctual?.light === i);
      expect(json.scenes[0].nodes).toContain(json.nodes.indexOf(nodeOf(0)));
      expect(nodeOf(0).translation).toEqual([0.6, 1.8, 0.4]);
      const q = nodeOf(1).rotation as number[];
      const rot = (v: number[]) => {
        // v' = v + 2w (q × v) + 2 q × (q × v)
        const [x, y, z, w] = q;
        const c1 = [y * v[2] - z * v[1], z * v[0] - x * v[2], x * v[1] - y * v[0]];
        const c2 = [y * c1[2] - z * c1[1], z * c1[0] - x * c1[2], x * c1[1] - y * c1[0]];
        return v.map((vi, k) => vi + 2 * w * c1[k] + 2 * c2[k]);
      };
      const travels = rot([0, 0, -1]);
      const az = (-50 * Math.PI) / 180, el = (40 * Math.PI) / 180;
      const toward = [Math.sin(az) * Math.cos(el), Math.sin(el), Math.cos(az) * Math.cos(el)];
      for (let k = 0; k < 3; k++) expect(travels[k]).toBeCloseTo(-toward[k], 5);
      // The viewer: a scene mode with the night sky, its light at E as the beauty render takes it (the palette's 0.4
      // times set ambient 1.3), the hero camera, and it opens in the scene from that camera.
      const html = readFileSync(join(dir, "viewer.html"), "utf8");
      const scene = JSON.parse(/const SCENE = (.*);\n/.exec(html)![1]);
      expect(scene.environment).toBe("night");
      expect(scene.ambient).toBeCloseTo(1.3 * 0.4, 5);
      expect(scene.light.width * scene.light.height * 3 * 2).toBe(Buffer.from(scene.light.data, "base64").length);
      // beauty.png's shot is the hero camera's.
      expect(scene.shot).toEqual({ eye: scene.cameras[0].eye, target: scene.cameras[0].target, fov: 30 });
      expect(scene.key).toBeUndefined();
      expect(scene.start).toBe(true);
      expect(scene.camera).toBe("hero");
      expect(scene.cameras.map((c: { name: string }) => c.name)).toEqual(["hero"]);
      expect(html).toContain('<button id="scene">Scene: night</button>');
      expect(html).toContain("◎ hero");
      // Without lights the GLB carries none, and the viewer's scene has the beauty render's default key, opening in the studio.
      const plain = run('show box(1, 1, 1) | paint("red")', "box.aix", join(dir, "plain"), { grid: 16, size: 64, views: [] as never[], steps: false, slices: false, turntable: false, callouts: false, texture: 64 });
      expect(plain.files).toContain("model.glb");
      const g2 = readFileSync(join(dir, "plain", "model.glb"));
      const j2 = JSON.parse(g2.toString("utf8", 20, 20 + g2.readUInt32LE(12)));
      expect(j2.extensions).toBeUndefined();
      const s2 = JSON.parse(/const SCENE = (.*);\n/.exec(readFileSync(join(dir, "plain", "viewer.html"), "utf8"))![1]);
      expect(s2.start).toBe(false);
      expect(s2.key.intensity).toBeCloseTo(Math.PI * 1.05, 4);
      // That key is where the beauty render puts it: `set light_azimuth` and `set light_elevation` move it there too.
      run('set light_azimuth 90\nset light_elevation 0\nshow box(1, 1, 1) | paint("red")', "box.aix", join(dir, "keyed"), { grid: 16, size: 64, views: [] as never[], steps: false, slices: false, turntable: false, callouts: false, texture: 64 });
      const s3 = JSON.parse(/const SCENE = (.*);\n/.exec(readFileSync(join(dir, "keyed", "viewer.html"), "utf8"))![1]);
      expect(s3.key.direction[0]).toBeCloseTo(1, 4);
      expect(s3.key.direction[1]).toBeCloseTo(0, 4);
      expect(s3.key.direction[2]).toBeCloseTo(0, 4);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

/** A minimal scene for viewerHtml: the studio sky's map and the rest. */
function sceneFor(overrides: Partial<ViewerScene> = {}): ViewerScene {
  const sky = buildSky("studio", 35, DEFAULT_LIGHT_DIRECTION);
  const map = environmentLatLong(sky);
  return {
    environment: "studio", sky: [1, 1, 1], ground: [1, 1, 1], ambient: 1,
    light: { width: map.width, height: map.height, data: map.data, sh: Array.from(map.diffuseSH) },
    floorAlbedo: [0.5, 0.5, 0.5], floorFade: { min: [0, 0, 0], max: [1, 1, 1], reach: 2, horizon: [0.8, 0.8, 0.8] },
    cameras: [], start: true, ...overrides,
  };
}
/** The page's module script, parsed but not run (it imports three.js only dynamically, so it parses as an async body). */
function pageScript(html: string): string {
  const body = /<script type="module">([\s\S]*?)<\/script>/.exec(html)![1];
  const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor;
  new AsyncFunction(body);
  return body;
}

/** three.js 0.187's own lines that the page rewrites, as its shader chunks have them. */
const THREE_CHUNKS = {
  tonemapping_pars_fragment: "vec3 NeutralToneMapping( vec3 color ) { return color; }\nvec3 CustomToneMapping( vec3 color ) { return color; }\n",
  envmap_physical_pars_fragment: "#ifdef USE_ENVMAP\n\tvec3 getIBLIrradiance( const in vec3 normal ) {\n\t\treturn PI * textureLod( envMap, normal, 8.0 ).rgb * envMapIntensity;\n\t}\n#endif\n",
  lights_pars_begin: "float getDistanceAttenuation( const in float lightDistance, const in float cutoffDistance, const in float decayExponent ) {\n\treturn 1.0 / max( pow( lightDistance, decayExponent ), 0.01 );\n}\n",
};
type Stub = Record<string, unknown> & ((...a: unknown[]) => unknown);
/**
 * The page's script run in Node against stand-ins: three.js is a stub that takes any call or construction and keeps
 * what is assigned to it (its shader chunks are the lines above), the DOM has the page's elements, and GLTFLoader
 * hands `model` back a moment later, as three.js does. Returns what the page puts on window.aixleViewer, the stub
 * three.js and the page's console warnings.
 */
async function runPage(html: string, model: { traverse(f: (o: unknown) => void): void }) {
  const stub = (seed: Record<PropertyKey, unknown> = {}): Stub => {
    const store: Record<PropertyKey, unknown> = { ...seed };
    return new Proxy(function () {}, {
      get: (_, k) => (k in store ? store[k] : k === Symbol.toPrimitive ? () => 0 : typeof k === "symbol" || k === "then" ? undefined : (store[k] = stub())),
      set: (_, k, v) => { store[k] = v; return true; },
      apply: () => stub(),
      construct: () => stub(),
    }) as unknown as Stub;
  };
  // Vectors are kept for real, so what the page puts in its uniforms can be read back.
  class Vector3 { constructor(public x = 0, public y = 0, public z = 0) {} set(x: number, y: number, z: number) { Object.assign(this, { x, y, z }); return this; } }
  const THREE = stub({ ShaderChunk: { ...THREE_CHUNKS }, Vector3 });
  class GLTFLoader { parse(_b: unknown, _p: string, onLoad: (g: unknown) => void) { setTimeout(() => onLoad({ scene: model, animations: [] }), 0); } }
  const modules: Record<string, unknown> = { three: THREE, "three/addons/loaders/GLTFLoader.js": { GLTFLoader }, "three/addons/controls/OrbitControls.js": { OrbitControls: THREE.OrbitControls }, "three/addons/environments/RoomEnvironment.js": { RoomEnvironment: THREE.RoomEnvironment } };
  const element = () => ({ style: {}, dataset: {} as Record<string, string>, classList: { toggle() {}, remove() {} }, addEventListener() {}, appendChild() {}, textContent: "", value: "1", checked: true });
  const elements = new Map([...html.matchAll(/ id="([^"]+)"/g)].map((m) => [m[1], element()]));
  const body = element();
  const document = { getElementById: (id: string) => elements.get(id) ?? null, querySelectorAll: () => [], createElement: () => ({ getContext: () => ({ fillRect() {} }) }), body };
  const window: Record<string, unknown> = {};
  const warnings: string[] = [];
  const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor;
  const script = pageScript(html).replace(/\bimport\(/g, "importModule(");
  await new AsyncFunction("document", "window", "innerWidth", "innerHeight", "addEventListener", "console", "importModule", script)(
    document, window, 800, 600, () => {}, { warn: (m: string) => warnings.push(m) }, async (name: string) => modules[name]);
  await new Promise((r) => setTimeout(r, 5));
  expect(body.dataset.ready).toBe("1");
  return { viewer: window.aixleViewer as Record<string, any>, THREE, warnings };
}

describe("the viewer's scene", () => {
  it("keeps a camera named with markup inside its script", () => {
    // A camera's name is any string the program gives; "</script>" in it ended the page's script, and the viewer died.
    const name = 'a</script><b>"x';
    const html = viewerHtml(Buffer.from("glb"), "m", { min: [0, 0, 0], max: [1, 1, 1] }, 12, [], sceneFor({ cameras: [{ name, eye: [0, 0, 3], target: [0, 0, 0], fov: 30 }] }));
    const line = /const SCENE = (.*);\n/.exec(html)![1];
    expect(line).not.toMatch(/<\//);
    expect(JSON.parse(line).cameras[0].name).toBe(name);
    // The page's own script is closed once, at its end.
    expect(html.split("</script>").length - 1).toBe(2);
    pageScript(html);
  });

  it("loads one pinned three.js, ends on the beauty render's tone curve and carries the sky's light", () => {
    const sc = sceneFor();
    const html = viewerHtml(Buffer.from("glb"), "m", { min: [0, 0, 0], max: [1, 1, 1] }, 12, [], sc);
    // three.js at an exact version, for the page and its addons alike, and no other.
    expect(THREE_VERSION).toMatch(/^0\.(1[89]\d|2\d\d)\.\d+$/);
    const map = JSON.parse(/<script type="importmap">(.*)<\/script>/.exec(html)![1]).imports;
    expect(map).toEqual({ three: `https://cdn.jsdelivr.net/npm/three@${THREE_VERSION}/build/three.module.js`, "three/addons/": `https://cdn.jsdelivr.net/npm/three@${THREE_VERSION}/examples/jsm/` });
    expect(html.match(/three@[\d.]+/g)!.every((v) => v === `three@${THREE_VERSION}`)).toBe(true);
    // The tone curve is photometry.ts's, injected as three.js's CustomToneMapping.
    const script = pageScript(html);
    expect(script).toContain("renderer.toneMapping = THREE.CustomToneMapping;");
    expect(script).toContain(`const TONEMAP = ${JSON.stringify(TONEMAP_GLSL)};`);
    expect(script).toContain("vec3 CustomToneMapping( vec3 color ) { return color; }");
    // The sky's radiance, as half floats: every texel back within half precision, and 64 KB of base64, under 100 KB.
    const scene = JSON.parse(/const SCENE = (.*);\n/.exec(html)![1]);
    const bytes = Buffer.from(scene.light.data, "base64");
    expect(scene.light.data.length).toBe(65536);
    const fromHalf = (h: number) => {
      const e = (h >> 10) & 31, m = h & 1023, sgn = h & 0x8000 ? -1 : 1;
      return sgn * (e === 0 ? m * 2 ** -24 : (1 + m / 1024) * 2 ** (e - 15));
    };
    let worst = 0;
    for (let i = 0; i < sc.light.data.length; i++) {
      const v = sc.light.data[i], back = fromHalf(bytes.readUInt16LE(i * 2));
      worst = Math.max(worst, Math.abs(back - v) / Math.max(v, 6e-5));
    }
    expect(worst).toBeLessThan(1 / 1024);
    expect(scene.light.sh).toHaveLength(27);
    // The studio's own lights are the page's calibrated ones.
    expect(script).toContain(`const STUDIO = ${JSON.stringify(STUDIO)};`);
    // Glass stays out of the page: transmission is its own change (roadmap 21).
    expect(script).not.toMatch(/transmission|KHR_materials_ior|KHR_materials_volume/);
  });

  it("keeps glass out of the GLB a run writes, as its own change (roadmap 21)", () => {
    const dir = mkdtempSync(join(tmpdir(), "aixle-"));
    try {
      run('show (sphere(0.5) | move(0, 0.5, 0) | paint("glass")) + (box(1.4, 0.1, 1.4) | move(0, -0.05, 0) | paint("oak"))', "glass.aix", dir, { grid: 24, size: 64, views: [] as never[], steps: false, slices: false, turntable: false, callouts: false, texture: 64, beauty: false });
      const glb = readFileSync(join(dir, "model.glb"));
      const json = glb.toString("utf8", 20, 20 + glb.readUInt32LE(12));
      expect(JSON.parse(json).materials.map((m: { name: string }) => m.name)).toContain("glass");
      expect(json).not.toMatch(/transmission|KHR_materials_ior|KHR_materials_volume/);
      expect(pageScript(readFileSync(join(dir, "viewer.html"), "utf8"))).not.toMatch(/transmission|\bior\b|thickness/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("lights the scene as beauty.png and the studio as its own, on the tone curve, when the page runs", async () => {
    // A glow's material shared by three meshes (a placed bulb's copies share it in the GLB, and GLTFLoader shares it).
    const bulb: Record<string, any> = { emissive: { r: 1, g: 0.6, b: 0.2 }, emissiveIntensity: 1, map: {} };
    const plain: Record<string, any> = { emissive: { r: 0, g: 0, b: 0 }, emissiveIntensity: 1, map: {} };
    const meshes = [bulb, bulb, bulb, plain].map((material) => ({ isMesh: true, material }));
    const sc = sceneFor({ ambient: 0.52 });
    const { viewer, THREE, warnings } = await runPage(viewerHtml(Buffer.from("glb"), "m", { min: [0, 0, 0], max: [1, 1, 1] }, 12, [], sc), { traverse: (f) => meshes.forEach(f) });
    // three.js 0.187's lines were found: the tone curve replaced its CustomToneMapping stub, and the renderer takes it.
    expect(warnings).toEqual([]);
    expect(THREE.ShaderChunk).toMatchObject({ tonemapping_pars_fragment: expect.stringContaining(TONEMAP_GLSL) });
    expect((THREE.ShaderChunk as Record<string, string>).tonemapping_pars_fragment).not.toContain("vec3 CustomToneMapping( vec3 color ) { return color; }");
    expect(viewer.renderer.toneMapping).toBe(THREE.CustomToneMapping);
    // A model's material is lit from the sky's SH and with beauty.png's point-light law, in the scene only.
    const shader = { uniforms: {} as Record<string, { value: unknown }>, fragmentShader: "#include <envmap_physical_pars_fragment>\n#include <lights_pars_begin>\nvoid main() {}" };
    bulb.onBeforeCompile(shader);
    expect(shader.fragmentShader).toContain("if ( aixleScene > 0.5 ) return max( aixleShIrradiance(");
    expect(shader.fragmentShader).toContain(`float r = cutoffDistance / ${GLB_RANGE_CUTOFF}.0; return 1.0 / ( lightDistance * lightDistance + r * r );`);
    // It opens in the scene: the sky at E, and a glow at beauty.png's strength, GLOW times the GLB's, once however many
    // meshes share its material.
    expect(viewer.scene.environmentIntensity).toBe(0.52);
    expect(shader.uniforms.aixleScene.value).toBe(1);
    expect(bulb.emissiveIntensity).toBeCloseTo(GLOW, 9);
    expect(plain.emissiveIntensity).toBe(1);
    viewer.setMode("studio");
    expect(viewer.scene.environmentIntensity).toBe(STUDIO.room);
    expect(shader.uniforms.aixleScene.value).toBe(0);
    expect(bulb.emissiveIntensity).toBe(1);
    viewer.setMode("scene");
    expect(bulb.emissiveIntensity).toBeCloseTo(GLOW, 9);
  });

  it("lights a diffuse surface in the scene with the irradiance the beauty render takes, by the page's own SH", async () => {
    // Computed rather than rendered: the page's GLSL for the sky's diffuse light, run on the uniforms it fills from
    // SCENE, against environment.ts's irradiance(), for a sky that is not symmetric (the sunset's sun at azimuth 60).
    const sky = buildSky("sunset", 35, lightDirection(60, 20));
    const map = environmentLatLong(sky);
    const mat: Record<string, any> = { emissive: { r: 0, g: 0, b: 0 }, map: {} };
    const sc = sceneFor({ environment: "sunset", light: { width: map.width, height: map.height, data: map.data, sh: Array.from(map.diffuseSH, (v) => Number(v.toPrecision(6))) } });
    await runPage(viewerHtml(Buffer.from("glb"), "m", { min: [0, 0, 0], max: [1, 1, 1] }, 12, [], sc), { traverse: (f) => f({ isMesh: true, material: mat }) });
    const shader = { uniforms: {} as Record<string, { value: any }>, fragmentShader: "#include <envmap_physical_pars_fragment>\n#include <lights_pars_begin>" };
    mat.onBeforeCompile(shader);
    const glsl = /vec3 aixleShIrradiance\( const in vec3 n \) \{\n([\s\S]*?)\n\}/.exec(shader.fragmentShader)![1];
    // GLSL to JS, one channel at a time: the function is plain arithmetic on vec3s and floats.
    type Vec3Like = { x: number; y: number; z: number };
    const channel = new Function("aixleSh", "n", glsl.replace("vec3 r", "let r")) as (sh: number[], n: Vec3Like) => number;
    const sh = shader.uniforms.aixleSh.value as Vec3Like[];
    let worst = 0;
    for (let i = 0; i < 64; i++) {
      const y = ((i + 0.5) / 64) * 2 - 1, r = Math.sqrt(1 - y * y), a = i * 2.39996;
      const n = { x: r * Math.cos(a), y, z: r * Math.sin(a) };
      const want = [0, 0, 0];
      irradiance(sky, n.x, n.y, n.z, want, 0);
      (["x", "y", "z"] as const).forEach((c, k) => {
        // three.js's Lambert takes irradiance over π: the page's SH gives irradiance, the kernel's irradiance over π.
        const page = Math.max(0, channel(sh.map((v) => v[c]), n)) / Math.PI;
        worst = Math.max(worst, Math.abs(page - want[k]) / Math.max(1e-3, want[k]));
      });
    }
    expect(worst).toBeLessThan(1e-4);
  });

  it("writes half floats rounded to nearest, clamped to the largest half", () => {
    expect(toHalf(1)).toBe(0x3c00);
    expect(toHalf(0.5)).toBe(0x3800);
    expect(toHalf(65504)).toBe(0x7bff);
    expect(toHalf(1e6)).toBe(0x7bff);
    // A number IEEE rounding takes past the largest half, to infinity, is the largest half too.
    expect(toHalf(65530)).toBe(0x7bff);
    expect(toHalf(-65535)).toBe(0xfbff);
    expect(toHalf(0)).toBe(0);
    expect(toHalf(2 ** -24)).toBe(1);
    expect(toHalf(1 + 1 / 2048)).toBe(0x3c00); // a tie, to even
    expect(toHalf(1 + 3 / 2048)).toBe(0x3c02);
    expect(halfBase64([1, 0.5])).toBe(Buffer.from([0x00, 0x3c, 0x00, 0x38]).toString("base64"));
  });

  it("solves the floor, frames beauty.png's shot and takes the sky from the beauty render's tables", () => {
    const dir = mkdtempSync(join(tmpdir(), "aixle-"));
    try {
      run('set environment sunset\nset ambient 0.8\nlight("sun", azimuth=30, elevation=35, power=1.2, color="#ffe0b0")\nshow box(1, 1, 1) | move(0, 0.5, 0) | paint("red")', "box.aix", dir, { grid: 16, size: 64, views: [] as never[], steps: false, slices: false, turntable: false, callouts: false, texture: 64 });
      const scene = JSON.parse(/const SCENE = (.*);\n/.exec(readFileSync(join(dir, "viewer.html"), "utf8"))![1]);
      const pal = environmentPalette("sunset");
      const E = 0.8 * pal.ambient;
      expect(scene.ambient).toBeCloseTo(E, 5);
      // The sky is the beauty render's for this shot: lit from where the program's light comes from.
      const sky = buildSky("sunset", 35, lightDirection(30, 35));
      const map = environmentLatLong(sky);
      expect(Array.from(map.diffuseSH, (v) => Number(v.toPrecision(6)))).toEqual(scene.light.sh);
      expect(halfBase64(map.data)).toBe(scene.light.data);
      // The floor's albedo shows the palette's open floor under the sky from above and the light at full strength.
      const up = [0, 0, 0], open = [0, 0, 0];
      irradiance(sky, 0, 1, 0, up, 0);
      decode(pal.open[0], pal.open[1], pal.open[2], open, 0);
      const sunY = lightDirection(30, 35)[1];
      const col = [1, 0xe0 / 255, 0xb0 / 255];
      for (let c = 0; c < 3; c++) {
        const shown = scene.floorAlbedo[c] * (up[c] * E + toLinear(col[c]) * 1.2 * KEY * sunY);
        expect(shown).toBeCloseTo(open[c], 4);
      }
      // The far floor fades into the sky at the horizon the shot looks towards, from 1.5 model diagonals out.
      const h = [0, 0, 0];
      horizonRadiance(sky, scene.shot.target[0] - scene.shot.eye[0], scene.shot.target[2] - scene.shot.eye[2], h, 0);
      for (let c = 0; c < 3; c++) expect(scene.floorFade.horizon[c]).toBeCloseTo(h[c], 4);
      expect(scene.floorFade.reach).toBeCloseTo(1.5 * Math.hypot(...[0, 1, 2].map((k) => scene.floorFade.max[k] - scene.floorFade.min[k])), 2);
      // beauty.png's own shot: from azimuth 35 and elevation 25, looking at the model's centre.
      const v = [0, 1, 2].map((k) => scene.shot.eye[k] - scene.shot.target[k]);
      const len = Math.hypot(v[0], v[1], v[2]);
      expect((Math.atan2(v[0], v[2]) * 180) / Math.PI).toBeCloseTo(35, 3);
      expect((Math.asin(v[1] / len) * 180) / Math.PI).toBeCloseTo(25, 3);
      expect(scene.shot.target[1]).toBeCloseTo(0.5, 1);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("frames each camera's button as its beauty_<name>.png, filling what it leaves out from the program's shot under --camera", () => {
    // Under --camera close, a camera with no angles of its own takes the program's `set camera` shot (hero), as the
    // beauty render's camera loop does, not close's azimuth and the default zoom.
    const dir = mkdtempSync(join(tmpdir(), "aixle-"));
    try {
      const src = 'camera("hero", azimuth=25, elevation=15, zoom=1.3)\ncamera("close", azimuth=60)\ncamera("bare")\nset camera hero\nshow box(1, 1, 1) | move(0, 0.5, 0) | paint("red")';
      const o = { grid: 16, size: 64, views: [] as never[], steps: false, slices: false, turntable: false, callouts: false, texture: 64 };
      run(src, "cams.aix", join(dir, "a"), { ...o, camera: "close" });
      const scene = JSON.parse(/const SCENE = (.*);\n/.exec(readFileSync(join(dir, "a", "viewer.html"), "utf8"))![1]);
      const by = (n: string) => {
        const { name: _, ...framing } = scene.cameras.find((c: { name: string }) => c.name === n);
        return framing;
      };
      expect(by("bare")).toEqual(by("hero"));
      // close's own button and beauty.png's shot are close's angle at hero's zoom and elevation.
      expect(scene.shot).toEqual(by("close"));
      expect(by("close")).not.toEqual(by("hero"));
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("the GLB's light intensities against the beauty render", () => {
  // An engine (three.js) shows albedo × E / π in linear light (the Lambert BRDF, with the same (1 − F) the beauty render
  // takes), E = lux × cos θ, or candela × cos θ / d²; the beauty render KEY × power × cos θ, times range² / (range² +
  // d²) for a point light. Both then go through the same tone curve.
  const [sun, lamp] = glbLights([
    { name: "sun", azimuth: 0, elevation: 90, color: [1, 1, 1], power: 1 },
    { name: "lamp", azimuth: 0, elevation: 0, color: [1, 1, 1], power: 1, position: [0, 0, 0], range: 2 },
  ], [0, 0, 0], 1);
  const display = (linear: number): number => { const o = [0, 0, 0]; encode(linear, linear, linear, o); return o[0] * 255; };
  const cos = (deg: number) => Math.cos((deg * Math.PI) / 180);

  it("are π·KEY lux for a directional light of power 1 and π·KEY·range² candela for a point light", () => {
    expect(sun.intensity).toBeCloseTo(3.3, 2);
    expect(sun.intensity).toBeCloseTo(Math.PI * KEY, 4);
    expect(lamp.intensity).toBeCloseTo(Math.PI * 1.05 * 4, 4);
    expect(lamp.range).toBe(2 * GLB_RANGE_CUTOFF);
    // A point light with no range takes the beauty render's: half the model's longest side, given by the caller.
    const [bare] = glbLights([{ azimuth: 0, elevation: 0, color: [1, 1, 1], power: 1, position: [0, 1, 0] }], [0, 0, 0], 1, 0.75);
    expect(bare.intensity).toBeCloseTo(Math.PI * KEY * 0.75 * 0.75, 4);
    expect(bare.range).toBeCloseTo(0.75 * GLB_RANGE_CUTOFF, 6);
  });

  it("show a white face square on as beauty.png does, within 2 levels, and at every angle and power alike", () => {
    for (const power of [0.25, 0.5, 1, 2]) {
      const [l] = glbLights([{ azimuth: 0, elevation: 90, color: [1, 1, 1], power }], [0, 0, 0], 1);
      for (const deg of [0, 30, 60, 80]) {
        for (const albedo of [1, 0.5, 0.2]) {
          const engine = (albedo * l.intensity * cos(deg)) / Math.PI;
          const beauty = albedo * KEY * power * cos(deg);
          expect(Math.abs(display(engine) - display(beauty))).toBeLessThan(deg === 0 && albedo === 1 ? 2 : 0.5);
        }
      }
    }
  });

  it("agree far from a point light, and an engine is brighter nearer it, as the doc comment says", () => {
    const R = 2;
    const cutoff = lamp.range!;
    const engine = (d: number) => (lamp.intensity / (d * d)) * Math.max(0, 1 - (d / cutoff) ** 4) ** 2 / Math.PI;
    const beauty = (d: number) => (KEY * R * R) / (R * R + d * d);
    expect(engine(R) / beauty(R)).toBeCloseTo(2 * (1 - 1 / 81) ** 2, 5);
    expect(engine(R / 2) / beauty(R / 2)).toBeGreaterThan(4.9);
    // They cross at about 1.8 ranges; the engine is 0.8 of beauty.png at two, a third at two and a half, dark at three.
    expect(engine(1.75 * R) / beauty(1.75 * R)).toBeGreaterThan(1);
    expect(engine(1.85 * R) / beauty(1.85 * R)).toBeLessThan(1);
    expect(engine(2 * R) / beauty(2 * R)).toBeCloseTo(0.8, 1);
    expect(engine(2.5 * R) / beauty(2.5 * R)).toBeCloseTo(0.33, 1);
    expect(engine(3 * R)).toBe(0);
    // Without the cutoff the two laws converge: the ratio is (range² + d²) / d².
    expect((lamp.intensity / (10 * R) ** 2 / Math.PI) / beauty(10 * R)).toBeCloseTo(1.01, 3);
  });

  it("give a point light with no range the beauty render's, half the model's longest side, in the GLB a run writes", () => {
    const dir = mkdtempSync(join(tmpdir(), "aixle-"));
    try {
      run('light("lamp", position=[0, 1.5, 1], power=2)\nshow box(3, 1, 1) | move(0, 0.5, 0) | paint("red")', "lamp.aix", dir, { grid: 24, size: 64, views: [] as never[], steps: false, slices: false, turntable: false, callouts: false, texture: 64, beauty: false });
      const glb = readFileSync(join(dir, "model.glb"));
      const [lamp] = JSON.parse(glb.toString("utf8", 20, 20 + glb.readUInt32LE(12))).extensions.KHR_lights_punctual.lights;
      // The box is 3 long, so the beauty render's range is 1.5 (not glbLights' own default of 2).
      expect(lamp.range).toBeCloseTo(1.5 * GLB_RANGE_CUTOFF, 1);
      expect(lamp.intensity).toBeCloseTo(Math.PI * KEY * 2 * (lamp.range / GLB_RANGE_CUTOFF) ** 2, 3);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("the report's material rows", () => {
  it("lists a name shared by several materials once, with their count, and keeps every material in the GLB", () => {
    // Round 11: a bookcase's page paper, a decal per book, was listed 35 times in a row of 70.
    const dir = mkdtempSync(join(tmpdir(), "aixle-"));
    try {
      const src = [
        "books = empty()",
        "for i in range(4) {",
        '  books = books + decal(box(0.3, 1, 0.8) | move(i * 0.5, 0.5, 0) | paint("red"), box(0.4, 0.8, 0.1) | move(i * 0.5, 0.5, 0.4), "#efe6cf")',
        "}",
        "show books",
      ].join("\n");
      const r = run(src, "books.aix", dir, { grid: 48, size: 64, views: [] as never[], steps: false, slices: false, turntable: false, callouts: false, viewer: false, texture: 64 });
      const row = /\| Materials \| (.*) \|/.exec(r.report)![1];
      expect(row).toMatch(/#efe6cf ×4/);
      expect(row.split(", ").filter((n) => n.startsWith("#efe6cf"))).toHaveLength(1);
      const data = JSON.parse(readFileSync(join(dir, "report.json"), "utf8"));
      expect(data.materials.filter((n: string) => n === "#efe6cf")).toHaveLength(4);
      const glb = readFileSync(join(dir, "model.glb"));
      const json = JSON.parse(glb.toString("utf8", 20, 20 + glb.readUInt32LE(12)));
      expect(json.materials.filter((m: { name: string }) => m.name === "#efe6cf")).toHaveLength(4);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("a loose piece in the report", () => {
  it("is named by the steps on its own surface, with its joint, and its volume to two figures", () => {
    // Round 11: a knocker's ring, hanging clear of its eye in its own joint, was put down to the wall and the door
    // leaf it hung in front of, and its volume of about 0.0003 printed as 0.
    const dir = mkdtempSync(join(tmpdir(), "aixle-"));
    try {
      const src = [
        "post = box(0.2, 1, 0.2) | move(0, 0.5, 0)",
        "pin = cylinder(0.03, 0.4) | rotate(x=90) | move(0, 0.9, 0.2)",
        "ring = torus(0.2, 0.03) | rotate(x=90) | move(0, 0.81, 0.3)",
        'knocker = joint(ring, "knocker", 0, 0.93, 0.3, axis=[0, 0, 1])',
        "small = sphere(0.05) | move(0.6, 0.5, 0)",
        "show post + pin + knocker + small",
      ].join("\n");
      const r = run(src, "knocker.aix", dir, { grid: 80, size: 64, views: [] as never[], steps: false, slices: false, turntable: false, callouts: false, glb: false, obj: false });
      const row = /\| Pieces \| (.*) \|/.exec(r.report)![1];
      expect(row).toMatch(/^3 \(/);
      expect(row).toMatch(/in 'ring', the part of joint 'knocker', clear of what it turns on/);
      expect(row).not.toMatch(/in 'pin'/);
      // The small sphere's volume, 0.00052, is printed to two figures, where three decimals printed 0.001.
      expect(row).toMatch(/; 0\.0005\d at \(0\.6, 0\.5, 0\) in 'small'/);
      // The warning names them the same way.
      expect(r.warnings.find((w) => /separate pieces/.test(w))).toMatch(/'ring', the part of joint 'knocker'/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("open edges in a scene's report", () => {
  const opts = { grid: 40, size: 64, views: [] as never[], steps: false, slices: false, turntable: false, callouts: false, glb: false, obj: false } as const;
  it("places each object's own open edges in its Assembly row, under the table, and in report.json under the object", () => {
    // Round 11: "bowl | no: 17 edges" with no place, though the tool had found them all on one plane in the bowl.
    const dir = mkdtempSync(join(tmpdir(), "aixle-"));
    try {
      // A plate 0.06 thick, about a cell, tilted into a block: the pair meshes with open edges, the ball without.
      const src = "left = box(1, 1, 1)\nright = box(1, 0.06, 1) | rotate(z=30) | move(0.9, 0.3, 0)\npair = left + right\nball = sphere(0.5) | move(0, 0, 2)\nscene pair, ball";
      const r = run(src, "pair.aix", dir, opts);
      expect(r.report).toMatch(/\| pair \| no: \d+ edges?; \d+ at \([-\d.]+, [-\d.]+, [-\d.]+\) in '(left|right)', '(left|right)', below \|/);
      expect(r.report).toMatch(/\| ball \| yes \|/);
      expect(r.report).toMatch(/^- pair's own mesh: \d+ open edges?, mostly \d+ at \([-\d., ]+\) in '(left|right)', '(left|right)', '(left|right)' only [\d.]+ into '(left|right)' there/m);
      const data = JSON.parse(readFileSync(join(dir, "report.json"), "utf8"));
      const pair = data.objects.find((o: { name: string }) => o.name === "pair");
      expect(pair.watertight.ok).toBe(false);
      expect(pair.watertight.clusters.length).toBeGreaterThan(0);
      expect(pair.watertight.clusters[0].steps.sort()).toEqual(["left", "right"]);
      expect(data.objects.find((o: { name: string }) => o.name === "ball").watertight).toEqual({ ok: true });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
  it("says when every object is watertight alone and the fused scene's edges are only where they meet", () => {
    // Round 11: a mixer's fused scene kept one edge though its body and bowl were each watertight.
    const dir = mkdtempSync(join(tmpdir(), "aixle-"));
    try {
      // Two blocks a hundredth apart, turned off the lattice: each meshes whole, the fused scene not where they meet.
      const r = run("left = box(1, 1, 1) | rotate(z=17)\nright = box(1, 1, 1) | move(1.01, 0, 0) | rotate(z=17)\nscene left, right", "two.aix", dir, opts);
      expect(r.report).toMatch(/\| Watertight \| no: .*Each object is watertight on its own \(the Assembly table\), so these edges are only in the fused scene/);
      expect(r.report).toMatch(/\| left \| yes \|/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
  it("names the blend when an edge lies in its fillet, not the gap between the parts it joins", () => {
    // Round 11: "in 'head_round', 'head_knuckle', 'head_round' only 0.000825 into 'head_knuckle'" under a k=0.03 blend.
    const { watertightNote } = pipelineFns;
    const cluster = (at: [number, number, number]) => ({ centre: at, at, box: { min: [at[0] - 0.01, at[1] - 0.01, at[2] - 0.01] as [number, number, number], max: [at[0] + 0.01, at[1] + 0.01, at[2] + 0.01] as [number, number, number] }, count: 1 });
    const w = (at: [number, number, number]) => ({ ok: false, holes: 0, nonManifold: 1, note: "no: 1 edge.", where: cluster(at).box, clusters: [cluster(at)] });
    // A post blended onto a plate: the fillet is round the post's foot, at y = 0.1 a little out from its side.
    const src = (k: number) => `plate = box(2, 0.2, 2)\npost = cylinder(0.2, 1) | move(0, 0.6, 0)\njoined = union(plate, post, k=${k})\nshow joined`;
    const at: [number, number, number] = [0.21, 0.11, 0];
    const blended = watertightNote(w(at), check(src(0.1)), 0.02);
    expect(blended).toMatch(/in '(plate|post)', '(plate|post)', in the fillet where 'joined' blends them \(k 0\.1, 5\.0 cells\)/);
    expect(blended).not.toMatch(/only [\d.]+ into/);
    expect(blended).toMatch(/An edge in a blend's fillet is the mesher's/);
    const hard = watertightNote(w(at), check(src(0)), 0.02);
    expect(hard).not.toMatch(/fillet/);
  });
});
