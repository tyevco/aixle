/**
 * Minecraft Bedrock geometry: a model as a list of textured cuboids.
 *
 * A Bedrock entity or block model is not a mesh but a set of axis-aligned
 * boxes, each face a window into one texture, in pixels at sixteen to the
 * block. So the field is sampled on a pixel lattice (`pixelsPerUnit` per
 * model unit, one unit being one block), every filled voxel is a pixel of
 * solid, and runs of voxels are merged greedily into boxes: a run along one
 * axis, the row grown along the second, the slab along the third. Which axis
 * goes first changes the count (a mug's wall wants vertical runs, a table
 * top horizontal ones), so all six orders are tried and the fewest boxes
 * kept. A curved thing comes out stepped, which is what a block model is. Each box's six faces get their own window in a texture painted with
 * the model's materials, read through the same albedo() the renders use,
 * so wood is wood and a decal is where it was.
 *
 * Geometry coordinates are always sixteen to the block; sampling finer than
 * that (`pixelsPerUnit` 32) writes cubes on half pixels, which Bedrock
 * accepts, and a texture with a texel per voxel, so a chair leg thinner
 * than a sixteenth of a block survives. Coarser (8) is a chunkier model.
 *
 * Bedrock draws custom geometry with x mirrored (a cube authored on +x
 * lands on the world's west; measured in tyevco/minecraft-qol,
 * docs/block-geometry-results.md), so cubes are authored at -x and the
 * model appears in the game as it does on the sheet: its +z front is south,
 * the block convention there. An entity faces north, so `entity` turns the
 * model half a turn about y first, which with the mirror is a flip of z.
 *
 * Every joint is a bone: its pivot in geometry pixels, its parent the joint
 * above it (or the object's own bone when the object has cubes of its own),
 * its cubes the joint's part with the joints inside it left out. The
 * animations are the same keys the GLB gets, as Bedrock keyframes. Bedrock's
 * bone rotation is an Euler triple applied z, y, x (x first, as here) with
 * the x and y angles negated in geometry space, and geometry space is the
 * mirror of the world (the convention Blockbench's Bedrock codec and the
 * Minecraft repo's viewer render with), so a right-handed rotation (rx, ry,
 * rz) in world space is written (-rx, ry, -rz); turned for an entity, it is
 * written as it is. A move is in geometry pixels with the same mirror.
 */
import { albedo } from "../sdf/materials.js";
import { Canvas, rgbf } from "../render/canvas.js";
import { boundsSize, isEmpty, REST_POSE, type JointPose, type Shape3 } from "../sdf/types.js";
import { eulerXYZ, rotAxis, type Vec3 } from "../core/vec.js";
import { allJoints, findJoints, move as moveShape } from "../sdf/ops.js";
import { offsetToJoint } from "./hierarchy.js";

export type BedrockFace = "north" | "south" | "east" | "west" | "up" | "down";

export interface BedrockCube {
  /** In geometry pixels, the corner with the smallest x, y, z (x already mirrored for the game). */
  origin: [number, number, number];
  size: [number, number, number];
  uv: Record<BedrockFace, { uv: [number, number]; uv_size: [number, number] }>;
}

export interface BedrockBone {
  name: string;
  parent?: string;
  pivot: [number, number, number];
  cubes: BedrockCube[];
}

export interface BedrockOptions {
  /** Pixels per model unit (a unit is a block): 16 is the game's own. */
  pixelsPerUnit?: number;
  /** The geometry's identifier; default `geometry.<name>`. */
  identifier?: string;
  /** Cap on the voxel lattice along any axis, so a scene does not ask for a billion samples. */
  maxPixels?: number;
  /** An entity model faces north (-z): turn the model half a turn about y so its +z front does. A block faces south. */
  entity?: boolean;
}

export interface BedrockResult {
  /** The file's contents: `<name>.geo.json`. */
  geometry: object;
  /** The texture every face window points into: `<name>.png`. */
  texture: Canvas;
  cubes: number;
  voxels: number;
  bones: string[];
  /** Bones that are joints, so an animation can name them. */
  joints: string[];
  pixelsPerUnit: number;
  warnings: string[];
}

/** One animation as the exporter samples it: a pose per joint at each time, already blended and eased. */
export interface BedrockClip {
  name: string;
  seconds: number;
  loop: boolean;
  times: number[];
  /** Per time, per joint name: the pose there. A joint not named is at rest. */
  samples: Record<string, JointPose>[];
  /** Per joint name, its axis when declared about one: the single angle is then turned into an Euler triple. */
  axes: Record<string, Vec3 | undefined>;
}

/** Model space to geometry space: the block convention mirrors x; an entity is turned half a turn first, which is a flip of z. */
function toGeometry(v: [number, number, number], entity: boolean): [number, number, number] {
  return entity ? [v[0], v[1], -v[2]] : [-v[0], v[1], v[2]];
}

/** A right-handed model-space rotation as Bedrock's numbers (see the header): (-rx, ry, -rz) for a block, unchanged for an entity. */
export function bedrockRotation(angles: Vec3, entity: boolean, axis?: Vec3): [number, number, number] {
  const e = axis ? eulerXYZ(rotAxis(axis, angles[0])) : angles;
  return entity ? [e[0], e[1], e[2]] : [-e[0], e[1], -e[2]];
}

/** A keyframe time as Bedrock writes it: seconds with the decimals it needs, at least one. */
function timeKey(t: number): string {
  const r = Math.round(t * 10000) / 10000;
  return Number.isInteger(r) ? `${r}.0` : `${r}`;
}

const near = (a: number, b: number): boolean => Math.abs(a - b) < 1e-9;

/**
 * The animations file, `<name>.animation.json`: `animation.<name>.<clip>` per clip, each bone's rotation, position
 * and scale keyed by time, only the channels a clip changes. Keys are the sampled ones, so an eased clip has its
 * eight keys per segment and Bedrock's linear interpolation plays the same curve.
 */
export function toBedrockAnimations(clips: BedrockClip[], name: string, joints: string[], opts: BedrockOptions = {}): object {
  const entity = opts.entity ?? false;
  const clean = (n: string): string => n.replace(/[^A-Za-z0-9_]/g, "_");
  const known = new Set(joints.map(clean));
  const animations: Record<string, unknown> = {};
  for (const c of clips) {
    const bones: Record<string, unknown> = {};
    const jointNames = new Set<string>();
    for (const sample of c.samples) for (const j of Object.keys(sample)) jointNames.add(j);
    for (const j of jointNames) {
      const bone = clean(j);
      if (!known.has(bone)) continue;
      const poses = c.samples.map((sm) => sm[j] ?? REST_POSE);
      const turns = poses.some((pz) => pz.angles.some((v) => !near(v, 0)));
      const moves = poses.some((pz) => pz.move.some((v) => !near(v, 0)));
      const scales = poses.some((pz) => pz.scale.some((v) => !near(v, 1)));
      if (!turns && !moves && !scales) continue;
      const b: Record<string, unknown> = {};
      const channel = (f: (pz: JointPose) => [number, number, number]): Record<string, [number, number, number]> => {
        // + 0 turns a -0 (a negated zero angle) into the 0 the file should show.
        const values = poses.map((pz) => f(pz).map((v) => Math.round(v * 10000) / 10000 + 0) as [number, number, number]);
        const out: Record<string, [number, number, number]> = {};
        // A held value is two keys, its ends: the keys inside a run of equal values say nothing Bedrock's linear
        // interpolation does not already do (round 7: eight keys through a half-second crouch).
        const same = (a: [number, number, number], b: [number, number, number]): boolean => a.every((v, k) => v === b[k]);
        values.forEach((v, i) => {
          if (i > 0 && i < values.length - 1 && same(values[i - 1], v) && same(v, values[i + 1])) return;
          out[timeKey(c.times[i])] = v;
        });
        return out;
      };
      if (turns) b.rotation = channel((pz) => bedrockRotation(pz.angles, entity, c.axes[j]));
      if (moves) b.position = channel((pz) => toGeometry([pz.move[0] * 16, pz.move[1] * 16, pz.move[2] * 16], entity));
      if (scales) b.scale = channel((pz) => [pz.scale[0], pz.scale[1], pz.scale[2]]);
      bones[bone] = b;
    }
    animations[`animation.${clean(name)}.${clean(c.name)}`] = {
      ...(c.loop ? { loop: true } : {}),
      animation_length: Math.round(c.seconds * 10000) / 10000,
      bones,
    };
  }
  return { format_version: "1.8.0", animations };
}

/** A merged box in model pixel coordinates (x not yet mirrored). */
interface Box { x: number; y: number; z: number; w: number; h: number; d: number }

/**
 * Sample the shape on a pixel lattice and merge the filled voxels into boxes.
 * The lattice is anchored to the model's origin, so a box's corner is a
 * whole pixel and two objects meet on the same lattice.
 */
export function voxelBoxes(shape: Shape3, px: number, maxPixels: number, warnings: string[], name: string): { boxes: Box[]; voxels: number } {
  if (isEmpty(shape.bounds)) return { boxes: [], voxels: 0 };
  const b = shape.bounds;
  const x0 = Math.floor(b.min[0] * px), y0 = Math.floor(b.min[1] * px), z0 = Math.floor(b.min[2] * px);
  let nx = Math.ceil(b.max[0] * px) - x0, ny = Math.ceil(b.max[1] * px) - y0, nz = Math.ceil(b.max[2] * px) - z0;
  if (Math.max(nx, ny, nz) > maxPixels) {
    warnings.push(`minecraft: '${name}' is ${Math.max(nx, ny, nz)} pixels on its longest side at ${px} per unit, more than ${maxPixels}; clipped to ${maxPixels} pixels from its low corner. Use fewer pixels per unit (set minecraft 8) or a smaller model.`);
    nx = Math.min(nx, maxPixels); ny = Math.min(ny, maxPixels); nz = Math.min(nz, maxPixels);
  }
  const filled = new Uint8Array(nx * ny * nz);
  const at = (i: number, j: number, k: number): number => (k * ny + j) * nx + i;
  let voxels = 0;
  for (let k = 0; k < nz; k++)
    for (let j = 0; j < ny; j++)
      for (let i = 0; i < nx; i++)
        if (shape.dist((x0 + i + 0.5) / px, (y0 + j + 0.5) / px, (z0 + k + 0.5) / px) <= 0) { filled[at(i, j, k)] = 1; voxels++; }
  // Greedy merge in a given axis order: a run along the first axis, widened along the second while every voxel
  // of the next row is filled and unused, then thickened along the third while every voxel of the next slab is.
  const dims = [nx, ny, nz];
  const merge = (order: [number, number, number]): Box[] => {
    const used = new Uint8Array(filled);
    const boxes: Box[] = [];
    const idx = (c: number[]): number => at(c[0], c[1], c[2]);
    const free = (c: number[]): boolean => used[idx(c)] === 1;
    const [a0, a1, a2] = order;
    const c = [0, 0, 0], q = [0, 0, 0];
    for (c[a2] = 0; c[a2] < dims[a2]; c[a2]++)
      for (c[a1] = 0; c[a1] < dims[a1]; c[a1]++)
        for (c[a0] = 0; c[a0] < dims[a0]; c[a0]++) {
          if (!free(c)) continue;
          const len = [1, 1, 1];
          q[0] = c[0]; q[1] = c[1]; q[2] = c[2];
          while (c[a0] + len[a0] < dims[a0]) { q[a0] = c[a0] + len[a0]; if (!free(q)) break; len[a0]++; }
          grow1: while (c[a1] + len[a1] < dims[a1]) {
            q[a1] = c[a1] + len[a1];
            for (let u = 0; u < len[a0]; u++) { q[a0] = c[a0] + u; if (!free(q)) break grow1; }
            len[a1]++;
          }
          q[a1] = c[a1];
          grow2: while (c[a2] + len[a2] < dims[a2]) {
            q[a2] = c[a2] + len[a2];
            for (let v = 0; v < len[a1]; v++) for (let u = 0; u < len[a0]; u++) { q[a0] = c[a0] + u; q[a1] = c[a1] + v; if (!free(q)) break grow2; }
            len[a2]++;
          }
          for (let t = 0; t < len[2]; t++) for (let v = 0; v < len[1]; v++) for (let u = 0; u < len[0]; u++) used[at(c[0] + u, c[1] + v, c[2] + t)] = 2;
          boxes.push({ x: x0 + c[0], y: y0 + c[1], z: z0 + c[2], w: len[0], h: len[1], d: len[2] });
        }
    return boxes;
  };
  let best: Box[] | undefined;
  for (const order of [[0, 2, 1], [0, 1, 2], [1, 0, 2], [1, 2, 0], [2, 0, 1], [2, 1, 0]] as [number, number, number][]) {
    const boxes = merge(order);
    if (!best || boxes.length < best.length) best = boxes;
  }
  return { boxes: best ?? [], voxels };
}

/**
 * The material at the model's true surface behind a face texel. The face is a voxel plane, which can lie a fraction
 * of a pixel inside the surface (a cube grown a third of a pixel so bones fuse) or a fraction outside it, and a decal
 * is only a skin a tenth of its region deep, so a sample a quarter pixel in missed every decal on a box model
 * (measured, round 7: paws, ear tips and eyes reached no texel). From half a pixel outside the face, where a skin
 * thinner than a voxel may still be solid, step in to the first solid sample and bisect onto the surface.
 */
function surfaceHit(shape: Shape3, p: [number, number, number], axis: 0 | 1 | 2, plane: number, dir: 1 | -1, px: number): ReturnType<Shape3["hit"]> {
  const at = (t: number): number => { p[axis] = plane + dir * t; return shape.dist(p[0] / px, p[1] / px, p[2] / px); };
  let outside = 0.6, inside = -0.6;
  let found = false;
  for (let t = 0.6; t >= -0.6; t -= 0.2) {
    if (at(t) <= 0) { inside = t; found = true; break; }
    outside = t;
  }
  if (!found) { p[axis] = plane - dir * 0.25; return shape.hit(p[0] / px, p[1] / px, p[2] / px); }
  for (let i = 0; i < 8; i++) {
    const mid = (outside + inside) / 2;
    if (at(mid) <= 0) inside = mid; else outside = mid;
  }
  // A hair inside the surface, so the hit is the solid's own and a decal's skin still covers it.
  p[axis] = plane + dir * inside - dir * 0.02;
  return shape.hit(p[0] / px, p[1] / px, p[2] / px);
}

/** The six faces of a box in model space: the outward axis, the two in-plane axes for u and v, and the window size. */
const FACES: { face: BedrockFace; axis: 0 | 1 | 2; dir: 1 | -1 }[] = [
  { face: "north", axis: 2, dir: -1 },
  { face: "south", axis: 2, dir: 1 },
  { face: "east", axis: 0, dir: -1 },
  { face: "west", axis: 0, dir: 1 },
  { face: "up", axis: 1, dir: 1 },
  { face: "down", axis: 1, dir: -1 },
];

export function toBedrock(objects: { name: string; shape: Shape3 }[], name: string, opts: BedrockOptions = {}): BedrockResult {
  const px = Math.max(1, Math.round(opts.pixelsPerUnit ?? 16));
  const maxPixels = opts.maxPixels ?? 256;
  const entity = opts.entity ?? false;
  const warnings: string[] = [];
  const bones: BedrockBone[] = [];
  const jointBones: string[] = [];
  let cubes = 0, voxels = 0;
  // Every face window, to pack into one texture, with how to paint it.
  type Window = { w: number; h: number; paint: (canvas: Canvas, u0: number, v0: number) => void; place: (u: number, v: number) => void };
  const windows: Window[] = [];
  const size = boundsSize(objects.reduce((acc, o) => (isEmpty(o.shape.bounds) ? acc : { min: acc.min.map((v, k) => Math.min(v, o.shape.bounds.min[k])) as [number, number, number], max: acc.max.map((v, k) => Math.max(v, o.shape.bounds.max[k])) as [number, number, number] }), { min: [Infinity, Infinity, Infinity] as [number, number, number], max: [-Infinity, -Infinity, -Infinity] as [number, number, number] }));
  const clean = (n: string): string => n.replace(/[^A-Za-z0-9_]/g, "_");
  // Geometry is sixteen to the block whatever the sampling, so a voxel is 16/px geometry units; the texture stays
  // one texel per voxel. The block convention mirrors x; an entity is turned half a turn about y, so z flips instead.
  const g = 16 / px;
  const geo = (bx: Box): { origin: [number, number, number]; size: [number, number, number] } =>
    entity
      ? { origin: [bx.x * g, bx.y * g, -(bx.z + bx.d) * g], size: [bx.w * g, bx.h * g, bx.d * g] }
      : { origin: [-(bx.x + bx.w) * g, bx.y * g, bx.z * g], size: [bx.w * g, bx.h * g, bx.d * g] };
  /** Voxelise a shape into a bone's cubes, each face with a window painted from the shape's materials. */
  const cubesOf = (shape: Shape3, label: string, bone: BedrockBone): void => {
    const { boxes, voxels: n } = voxelBoxes(shape, px, maxPixels, warnings, label);
    voxels += n;
    for (const bx of boxes) {
      const cube: BedrockCube = { ...geo(bx), uv: {} as BedrockCube["uv"] };
      const lo = [bx.x, bx.y, bx.z], hi = [bx.x + bx.w, bx.y + bx.h, bx.z + bx.d];
      for (const f of FACES) {
        // The two in-plane axes: u runs along the first, v along the second (v down the texture is -y on a side).
        const [ua, va]: [0 | 1 | 2, 0 | 1 | 2] = f.axis === 1 ? [0, 2] : f.axis === 0 ? [2, 1] : [0, 1];
        const w = hi[ua] - lo[ua], h = hi[va] - lo[va];
        // Which side of the model this window shows. The table's dir is the side in the world (the mirror is already
        // allowed for: the geometry's east face is the world's west side); for an entity the world is the model turned
        // half a turn, so its x and z sides are the model's opposite ones.
        const dir: 1 | -1 = entity && f.axis !== 1 ? (f.dir === 1 ? -1 : 1) : f.dir;
        const plane = dir > 0 ? hi[f.axis] : lo[f.axis];
        // Which way u runs across the window, in model space, from the game's own face corners (as the Minecraft
        // repo's viewer draws them, in geometry space: north's u runs from +x to -x, south's from -x to +x, east's
        // from +z to -z, west's from -z to +z, up's and down's from -x to +x) mapped through the mirror for a
        // block (geometry x is -model x) or the half turn for an entity (geometry z is -model z). Measured in that
        // viewer, round 7: the first rule had a block's front and top and an entity's front mirrored.
        const flipU = entity
          ? f.face === "north" || f.face === "west"
          : f.face === "south" || f.face === "east" || f.face === "up" || f.face === "down";
        // v runs down the texture: from the top of a side face; on the top face from geometry -z, on the bottom from
        // geometry +z, which for an entity are the model's +z and -z.
        const fromLowV = f.axis === 1 ? (entity ? f.face !== "up" : f.face === "up") : false;
        const win: Window = {
          w, h,
          paint: (canvas, u0, v0) => {
            for (let v = 0; v < h; v++)
              for (let u = 0; u < w; u++) {
                const p: [number, number, number] = [0, 0, 0];
                p[ua] = flipU ? hi[ua] - u - 0.5 : lo[ua] + u + 0.5;
                p[va] = fromLowV ? lo[va] + v + 0.5 : hi[va] - v - 0.5;
                const hit = surfaceHit(shape, p, f.axis, plane, dir, px);
                const c = albedo(hit.mat, hit.lx, hit.ly, hit.lz);
                canvas.set(u0 + u, v0 + v, rgbf(c[0], c[1], c[2]));
              }
          },
          place: (u, v) => { cube.uv[f.face] = { uv: [u, v], uv_size: [w, h] }; },
        };
        windows.push(win);
      }
      bone.cubes.push(cube);
      cubes++;
    }
  };
  /** A joint as a bone under `parent`: its part with the joints inside it left out, and those as bones under it. */
  const jointBone = (j: Shape3, parent: string | undefined, offset: Vec3): void => {
    const st = j.joint!;
    const nested = findJoints(st.child);
    for (const n of nested) n.joint!.hidden = true;
    const part = offset[0] === 0 && offset[1] === 0 && offset[2] === 0 ? st.child : moveShape(st.child, offset[0], offset[1], offset[2]);
    const pivot = toGeometry([(st.pivot[0] + offset[0]) * 16, (st.pivot[1] + offset[1]) * 16, (st.pivot[2] + offset[2]) * 16], entity);
    const bone: BedrockBone = { name: clean(st.name), pivot, cubes: [] };
    if (parent) bone.parent = parent;
    cubesOf(part, st.name, bone);
    for (const n of nested) n.joint!.hidden = false;
    bones.push(bone);
    jointBones.push(bone.name);
    for (const n of nested) jointBone(n, bone.name, offset);
  };
  for (const o of objects) {
    const top = findJoints(o.shape);
    const all = allJoints(o.shape);
    for (const n of all) n.joint!.hidden = true;
    const own: BedrockBone = { name: clean(o.name), pivot: [0, 0, 0], cubes: [] };
    cubesOf(o.shape, o.name, own);
    for (const n of all) n.joint!.hidden = false;
    // An object that is all joints (a rig whose body is itself a joint) needs no bone of its own: its joints are roots.
    const ownBone = own.cubes.length > 0 || top.length === 0;
    if (ownBone) bones.push(own);
    for (const j of top) {
      const { offset, rigid } = offsetToJoint(o.shape, j);
      if (!rigid) warnings.push(`minecraft: joint "${j.joint!.name}" sits under a rotation or a scale, which a bone cannot carry; its cubes are placed as at rest but its pivot may be off`);
      jointBone(j, ownBone ? own.name : undefined, offset);
    }
  }
  // Shelf packing, tallest first, into a power-of-two square that grows until everything fits.
  const area = windows.reduce((a, w) => a + w.w * w.h, 0);
  let W = 16;
  while (W * W < area * 1.25) W *= 2;
  const order = windows.map((w, i) => i).sort((a, b) => windows[b].h - windows[a].h || windows[b].w - windows[a].w);
  let H = 0;
  const pack = (width: number): { height: number; at: [number, number][] } => {
    const at: [number, number][] = new Array(windows.length);
    let x = 0, y = 0, shelf = 0;
    for (const i of order) {
      const w = windows[i];
      if (x + w.w > width) { x = 0; y += shelf; shelf = 0; }
      at[i] = [x, y];
      x += w.w; shelf = Math.max(shelf, w.h);
    }
    return { height: y + shelf, at };
  };
  let packed = pack(W);
  while (packed.height > W) { W *= 2; packed = pack(W); }
  H = 1;
  while (H < packed.height) H *= 2;
  // Unused texels are transparent, as a hand-made Bedrock texture's are, so the file reads as a picture.
  const texture = new Canvas(Math.max(W, 1), Math.max(H, 1));
  for (let i = 3; i < texture.data.length; i += 4) texture.data[i] = 0;
  windows.forEach((w, i) => { w.place(packed.at[i][0], packed.at[i][1]); w.paint(texture, packed.at[i][0], packed.at[i][1]); });
  const width = (size[0] || 1) / 1, height = (size[1] || 1) / 1, depth = (size[2] || 1) / 1;
  const geometry = {
    format_version: "1.16.0",
    "minecraft:geometry": [
      {
        description: {
          identifier: opts.identifier ?? `geometry.${name.replace(/[^A-Za-z0-9_]/g, "_")}`,
          texture_width: texture.width,
          texture_height: texture.height,
          visible_bounds_width: Math.ceil(Math.max(width, depth) + 1),
          visible_bounds_height: Math.ceil(height + 1),
          visible_bounds_offset: [0, Math.round(height * 100) / 200, 0],
        },
        bones,
      },
    ],
  };
  return { geometry, texture, cubes, voxels, bones: bones.map((b) => b.name), joints: jointBones, pixelsPerUnit: px, warnings };
}
