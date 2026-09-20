import { describe, expect, it } from "vitest";
import * as P from "../src/sdf/primitives.js";
import * as O from "../src/sdf/ops.js";
import { materialFromString } from "../src/sdf/materials.js";
import { toBedrock, voxelBoxes } from "../src/export/bedrock.js";

describe("Minecraft Bedrock geometry", () => {
  it("turns a box into one cube at sixteen pixels to the block, authored on the mirrored x", () => {
    const r = toBedrock([{ name: "slab", shape: O.move(P.box(1, 0.5, 1), 0.25, 0.25, 0) }], "slab");
    expect(r.cubes).toBe(1);
    expect(r.voxels).toBe(16 * 8 * 16);
    const geo = r.geometry as { "minecraft:geometry": { description: { identifier: string; texture_width: number }; bones: { name: string; cubes: { origin: number[]; size: number[]; uv: Record<string, { uv: number[]; uv_size: number[] }> }[] }[] }[] };
    const g = geo["minecraft:geometry"][0];
    expect(g.description.identifier).toBe("geometry.slab");
    expect(g.bones[0].name).toBe("slab");
    const cube = g.bones[0].cubes[0];
    // The model spans x -0.25..0.75, y 0..0.5, z -0.5..0.5: in pixels, mirrored on x, the origin is the low corner.
    expect(cube.size).toEqual([16, 8, 16]);
    expect(cube.origin).toEqual([-12, 0, -8]);
    expect(cube.uv.north.uv_size).toEqual([16, 8]);
    expect(cube.uv.east.uv_size).toEqual([16, 8]);
    expect(cube.uv.up.uv_size).toEqual([16, 16]);
    // Every window lies inside the texture.
    for (const f of Object.values(cube.uv)) {
      expect(f.uv[0] + f.uv_size[0]).toBeLessThanOrEqual(r.texture.width);
      expect(f.uv[1] + f.uv_size[1]).toBeLessThanOrEqual(r.texture.height);
    }
  });
  it("paints each window with the model's material, and a sphere becomes stepped cubes within its bounds", () => {
    const red = materialFromString("#ff0000")!;
    const r = toBedrock([{ name: "ball", shape: O.paint(P.sphere(1), red) }], "ball", { pixelsPerUnit: 8 });
    expect(r.cubes).toBeGreaterThan(10);
    // About the sphere's volume in voxels (4/3 pi r^3 at 8 per unit is 2145), within a few percent.
    expect(Math.abs(r.voxels - 2145) / 2145).toBeLessThan(0.05);
    const cubes = (r.geometry as { "minecraft:geometry": { bones: { cubes: { origin: number[]; size: number[] }[] }[] }[] })["minecraft:geometry"][0].bones[0].cubes;
    // Geometry is sixteen to the block whatever the sampling: a unit sphere spans -16..16, in half-pixel steps at 8.
    for (const c of cubes) for (let k = 0; k < 3; k++) { expect(c.origin[k]).toBeGreaterThanOrEqual(-16); expect(c.origin[k] + c.size[k]).toBeLessThanOrEqual(16); expect(c.size[k] % 2).toBe(0); }
    // Every painted texel is red (the packing leaves the rest black).
    let red_ = 0, other = 0;
    for (let i = 0; i < r.texture.data.length; i += 4) {
      const [cr, cg, cb] = [r.texture.data[i], r.texture.data[i + 1], r.texture.data[i + 2]];
      if (cr === 0 && cg === 0 && cb === 0) continue;
      if (cr > 200 && cg < 40 && cb < 40) red_++; else other++;
    }
    expect(red_).toBeGreaterThan(100);
    expect(other).toBe(0);
  });
  it("merges runs greedily: an L of two boxes is two cubes, and a scene is a bone per object", () => {
    const l = O.union([P.box(1, 0.25, 0.25), O.move(P.box(0.25, 1, 0.25), -0.375, 0.5, 0)]);
    const warnings: string[] = [];
    expect(voxelBoxes(l, 8, 256, warnings, "l").boxes.length).toBe(2);
    const r = toBedrock([{ name: "a", shape: P.box(0.5, 0.5, 0.5) }, { name: "b", shape: O.move(P.box(0.5, 0.5, 0.5), 2, 0, 0) }], "pair");
    expect(r.bones).toEqual(["a", "b"]);
    expect(r.cubes).toBe(2);
    // A model too big for the lattice is clipped with a warning rather than sampled a billion times.
    const big = toBedrock([{ name: "big", shape: P.box(40, 1, 1) }], "big", { pixelsPerUnit: 16, maxPixels: 64 });
    expect(big.warnings[0]).toMatch(/'big' is 640 pixels on its longest side/);
  });
});

import { bedrockRotation, toBedrockAnimations, type BedrockClip } from "../src/export/bedrock.js";
import { eulerXYZ, rotAxis, rotX, rotY, rotZ, matMul, apply, type Mat3, type Vec3 } from "../src/core/vec.js";
import { REST_POSE, type JointPose } from "../src/sdf/types.js";

describe("Bedrock bones and animations", () => {
  const jp = (angles: Vec3 = [0, 0, 0], move: Vec3 = [0, 0, 0], scale: Vec3 = [1, 1, 1]): JointPose => ({ angles, move, scale });
  // A body with an arm hinged on its right flank and a hand hinged at the arm's end, all boxes so each is one cube.
  const rig = (pose: Record<string, JointPose> = {}) => {
    const hand = O.joint(O.move(P.box(0.5, 0.25, 0.25), 2.25, 0, 0), "hand", 2, 0, 0, pose.hand?.angles, undefined, pose.hand?.move, pose.hand?.scale);
    const arm = O.joint(O.union([O.move(P.box(1.5, 0.25, 0.25), 1.25, 0, 0), hand]), "arm", 0.5, 0, 0, pose.arm?.angles, undefined, pose.arm?.move, pose.arm?.scale);
    return O.union([P.box(1, 1, 1), arm]);
  };
  it("writes a bone per joint under the object's bone, with pivots in geometry pixels", () => {
    const r = toBedrock([{ name: "rig", shape: rig() }], "rig", { pixelsPerUnit: 4 });
    expect(r.bones).toEqual(["rig", "arm", "hand"]);
    expect(r.joints).toEqual(["arm", "hand"]);
    const bones = (r.geometry as { "minecraft:geometry": { bones: { name: string; parent?: string; pivot: number[]; cubes: unknown[] }[] }[] })["minecraft:geometry"][0].bones;
    expect(bones.map((b) => b.parent)).toEqual([undefined, "rig", "arm"]);
    // The block convention mirrors x: the arm's pivot at model x 0.5 is geometry -8, the hand's at 2 is -32.
    expect(bones[1].pivot).toEqual([-8, 0, 0]);
    expect(bones[2].pivot).toEqual([-32, 0, 0]);
    expect(bones.map((b) => b.cubes.length)).toEqual([1, 1, 1]);
    // An entity is turned half a turn: z flips instead, and a model that is all joint has no bone of its own.
    const body = O.joint(O.move(P.box(1, 1, 1), 0, 0, 0.25), "body", 0, 0, 0.25);
    const e = toBedrock([{ name: "pet", shape: body }], "pet", { pixelsPerUnit: 4, entity: true });
    expect(e.bones).toEqual(["body"]);
    const eb = (e.geometry as { "minecraft:geometry": { bones: { parent?: string; pivot: number[]; cubes: { origin: number[]; size: number[] }[] }[] }[] })["minecraft:geometry"][0].bones[0];
    expect(eb.parent).toBeUndefined();
    expect(eb.pivot).toEqual([0, 0, -4]);
    // The box spans z -0.25..0.75 in the model: flipped, -12..4 in geometry pixels.
    expect(eb.cubes[0].origin).toEqual([-8, -8, -12]);
    expect(eb.cubes[0].size).toEqual([16, 16, 16]);
  });
  it("writes rotations as Bedrock's numbers and an axis joint as an Euler triple", () => {
    expect(bedrockRotation([10, 20, 30], false)).toEqual([-10, 20, -30]);
    expect(bedrockRotation([10, 20, 30], true)).toEqual([10, 20, 30]);
    const e = bedrockRotation([40, 0, 0], true, [0, 1, 0]);
    expect(e[0]).toBeCloseTo(0, 9); expect(e[1]).toBeCloseTo(40, 9); expect(e[2]).toBeCloseTo(0, 9);
    // The decomposition is the inverse of rotXYZ for any angles short of the lock.
    const m = matMul(rotZ(30), matMul(rotY(-50), rotX(70)));
    const back = eulerXYZ(m);
    expect(back[0]).toBeCloseTo(70, 9); expect(back[1]).toBeCloseTo(-50, 9); expect(back[2]).toBeCloseTo(30, 9);
    // A raked axis comes out as the triple that makes the same matrix.
    const raked = rotAxis([Math.cos(1.2), Math.sin(1.2), 0], 25);
    const t = eulerXYZ(raked);
    const again = matMul(rotZ(t[2]), matMul(rotY(t[1]), rotX(t[0])));
    for (let k = 0; k < 9; k++) expect(again[k]).toBeCloseTo(raked[k], 9);
  });
  it("writes only the channels a clip changes, keyed by time, with the move mirrored like the geometry", () => {
    const clip: BedrockClip = {
      name: "wave", seconds: 1, loop: true, times: [0, 0.15, 1],
      samples: [{}, { arm: jp([0, 0, 45], [0.5, 0, 0]), hand: jp([0, 0, 0], [0, 0, 0], [1, 2, 1]) }, {}],
      axes: {},
    };
    const a = toBedrockAnimations([clip], "rig", ["arm", "hand"]) as { format_version: string; animations: Record<string, { loop?: boolean; animation_length: number; bones: Record<string, Record<string, Record<string, number[]>>> }> };
    expect(a.format_version).toBe("1.8.0");
    const w = a.animations["animation.rig.wave"];
    expect(w.loop).toBe(true);
    expect(w.animation_length).toBe(1);
    expect(Object.keys(w.bones.arm)).toEqual(["rotation", "position"]);
    expect(Object.keys(w.bones.hand)).toEqual(["scale"]);
    expect(Object.keys(w.bones.arm.rotation)).toEqual(["0.0", "0.15", "1.0"]);
    expect(w.bones.arm.rotation["0.15"]).toEqual([0, 0, -45]);
    expect(w.bones.arm.position["0.15"]).toEqual([-8, 0, 0]);
    expect(w.bones.hand.scale["0.15"]).toEqual([1, 2, 1]);
    // A joint the geometry does not have is left out, and a one-shot has no loop.
    const b = toBedrockAnimations([{ ...clip, name: "once", loop: false, samples: [{}, { nope: jp([1, 0, 0]) }, {}] }], "rig", ["arm"]) as { animations: Record<string, { loop?: boolean; bones: object }> };
    expect(b.animations["animation.rig.once"].loop).toBeUndefined();
    expect(b.animations["animation.rig.once"].bones).toEqual({});
  });
  it("plays back, under the game's conventions, where the posed model is", () => {
    // The Minecraft repo's viewer (tools/viewer/viewer.js, copying Blockbench's Bedrock codec) draws a bone with
    // Euler(-x, -y, z) in ZYX order about its pivot, positions in the parent's frame, and the whole scene with x
    // negated at 1/16. Push a cube's centre through that for the exported numbers and it must land inside the
    // shape Aixle builds for the same pose, for a block and for an entity.
    type Bone = { name: string; parent?: string; pivot: number[]; cubes: { origin: number[]; size: number[] }[] };
    const pose: Record<string, JointPose> = { arm: jp([40, 25, 10], [0.1, 0.2, 0.3], [1, 1.5, 1]), hand: jp([0, 0, -60]) };
    const posed = rig(pose);
    for (const entity of [false, true]) {
      const r = toBedrock([{ name: "rig", shape: rig() }], "rig", { pixelsPerUnit: 4, entity });
      const bones = (r.geometry as { "minecraft:geometry": { bones: Bone[] }[] })["minecraft:geometry"][0].bones;
      const anim = toBedrockAnimations([{ name: "p", seconds: 1, loop: false, times: [0], samples: [pose], axes: {} }], "rig", r.joints, { entity }) as { animations: Record<string, { bones: Record<string, Record<string, Record<string, number[]>>> }> };
      const ch = anim.animations["animation.rig.p"].bones;
      const byName = new Map(bones.map((b) => [b.name, b]));
      const euler = (v: number[]): Mat3 => matMul(rotZ(v[2]), matMul(rotY(-v[1]), rotX(-v[0])));
      // A point in a bone's frame (relative to its pivot) carried up to the root and out to the world.
      const toWorld = (bone: Bone, q: Vec3): Vec3 => {
        const c = ch[bone.name] ?? {};
        const rot = c.rotation ? c.rotation["0.0"] : [0, 0, 0];
        const pos = c.position ? c.position["0.0"] : [0, 0, 0];
        const scl = c.scale ? c.scale["0.0"] : [1, 1, 1];
        const turned = apply(euler(rot), [q[0] * scl[0], q[1] * scl[1], q[2] * scl[2]]);
        const parent = bone.parent ? byName.get(bone.parent)! : undefined;
        const origin = parent ? [bone.pivot[0] - parent.pivot[0], bone.pivot[1] - parent.pivot[1], bone.pivot[2] - parent.pivot[2]] : bone.pivot;
        const inParent: Vec3 = [origin[0] + pos[0] + turned[0], origin[1] + pos[1] + turned[1], origin[2] + pos[2] + turned[2]];
        if (!parent) return [-inParent[0] / 16, inParent[1] / 16, inParent[2] / 16];
        return toWorld(parent, inParent);
      };
      for (const bone of bones) {
        for (const cube of bone.cubes) {
          const centre: Vec3 = [cube.origin[0] + cube.size[0] / 2 - bone.pivot[0], cube.origin[1] + cube.size[1] / 2 - bone.pivot[1], cube.origin[2] + cube.size[2] / 2 - bone.pivot[2]];
          const w = toWorld(bone, centre);
          // An entity is the model turned half a turn about y.
          const m: Vec3 = entity ? [-w[0], w[1], -w[2]] : w;
          const d = posed.dist(m[0], m[1], m[2]);
          expect(d, `${entity ? "entity" : "block"} ${bone.name} centre lands at (${m.map((v) => v.toFixed(3)).join(", ")}), ${d.toFixed(3)} from the posed surface`).toBeLessThan(-0.05);
        }
      }
    }
  });
});
