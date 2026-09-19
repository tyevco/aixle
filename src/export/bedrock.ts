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
 * the block convention there; an entity, which faces north, wants the
 * model turned 180 degrees about y first.
 */
import { albedo } from "../sdf/materials.js";
import { Canvas, rgbf } from "../render/canvas.js";
import { boundsSize, isEmpty, type Shape3 } from "../sdf/types.js";

export type BedrockFace = "north" | "south" | "east" | "west" | "up" | "down";

export interface BedrockCube {
  /** In geometry pixels, the corner with the smallest x, y, z (x already mirrored for the game). */
  origin: [number, number, number];
  size: [number, number, number];
  uv: Record<BedrockFace, { uv: [number, number]; uv_size: [number, number] }>;
}

export interface BedrockBone {
  name: string;
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
}

export interface BedrockResult {
  /** The file's contents: `<name>.geo.json`. */
  geometry: object;
  /** The texture every face window points into: `<name>.png`. */
  texture: Canvas;
  cubes: number;
  voxels: number;
  bones: string[];
  pixelsPerUnit: number;
  warnings: string[];
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
  const warnings: string[] = [];
  const bones: BedrockBone[] = [];
  let cubes = 0, voxels = 0;
  // Every face window, to pack into one texture, with how to paint it.
  type Window = { w: number; h: number; paint: (canvas: Canvas, u0: number, v0: number) => void; place: (u: number, v: number) => void };
  const windows: Window[] = [];
  const size = boundsSize(objects.reduce((acc, o) => (isEmpty(o.shape.bounds) ? acc : { min: acc.min.map((v, k) => Math.min(v, o.shape.bounds.min[k])) as [number, number, number], max: acc.max.map((v, k) => Math.max(v, o.shape.bounds.max[k])) as [number, number, number] }), { min: [Infinity, Infinity, Infinity] as [number, number, number], max: [-Infinity, -Infinity, -Infinity] as [number, number, number] }));
  for (const o of objects) {
    const { boxes, voxels: n } = voxelBoxes(o.shape, px, maxPixels, warnings, o.name);
    voxels += n;
    const bone: BedrockBone = { name: o.name.replace(/[^A-Za-z0-9_]/g, "_"), pivot: [0, 0, 0], cubes: [] };
    for (const bx of boxes) {
      // The game mirrors x: authored at -x, the box lands where the model has it. Geometry is sixteen to the block
      // whatever the sampling, so a voxel is 16/px geometry units; the texture stays one texel per voxel.
      const g = 16 / px;
      const cube: BedrockCube = { origin: [-(bx.x + bx.w) * g, bx.y * g, bx.z * g], size: [bx.w * g, bx.h * g, bx.d * g], uv: {} as BedrockCube["uv"] };
      const lo = [bx.x, bx.y, bx.z], hi = [bx.x + bx.w, bx.y + bx.h, bx.z + bx.d];
      for (const f of FACES) {
        // The two in-plane axes: u runs along the first, v along the second (v down the texture is -y on a side).
        const [ua, va]: [0 | 1 | 2, 0 | 1 | 2] = f.axis === 1 ? [0, 2] : f.axis === 0 ? [2, 1] : [0, 1];
        const w = hi[ua] - lo[ua], h = hi[va] - lo[va];
        // The model face this window shows: the game's mirror swaps east and west, so the geometry's east face
        // is painted with the model's -x side (f.dir already says which side of the model to read).
        const plane = f.dir > 0 ? hi[f.axis] : lo[f.axis];
        const win: Window = {
          w, h,
          paint: (canvas, u0, v0) => {
            for (let v = 0; v < h; v++)
              for (let u = 0; u < w; u++) {
                const p: [number, number, number] = [0, 0, 0];
                // u increases with the axis on top and up faces; on the north face (seen from -z) the model's +x is on
                // the viewer's left, so u runs against x there, as it does on the east face against z.
                const flipU = (f.face === "north") || (f.face === "east") || (f.face === "down");
                p[ua] = flipU ? hi[ua] - u - 0.5 : lo[ua] + u + 0.5;
                // v runs down the texture: from the top of a side face, or from the far (-z) edge of the top face.
                p[va] = f.axis === 1 ? (f.face === "up" ? lo[va] + v + 0.5 : hi[va] - v - 0.5) : hi[va] - v - 0.5;
                p[f.axis] = plane - f.dir * 0.25;
                const hit = o.shape.hit(p[0] / px, p[1] / px, p[2] / px);
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
    if (bone.cubes.length) bones.push(bone);
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
  const texture = new Canvas(Math.max(W, 1), Math.max(H, 1), 0x000000);
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
  return { geometry, texture, cubes, voxels, bones: bones.map((b) => b.name), pixelsPerUnit: px, warnings };
}
