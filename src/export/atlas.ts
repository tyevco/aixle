/**
 * Bake the procedural materials into a texture atlas with UVs, so the
 * patterns survive in engines that ignore vertex colours.
 *
 * Charts: each triangle is assigned the axis its normal points along most
 * (one of six), and triangles that share an edge and an axis form a chart.
 * A chart is projected flat along its axis, which for a surface facing that
 * way is nearly distortion-free, and charts are shelf-packed into the atlas
 * at a common texels-per-unit scale, with padding. Texels are shaded by the
 * same albedo() the renderer uses, from the interpolated local point, and
 * the border of each chart is dilated a few texels so bilinear filtering
 * never bleeds background into a seam. Vertices are split per chart so each
 * copy has one UV.
 *
 * The one thing a planar chart cannot do is a surface that folds back on
 * itself along its axis inside one connected patch (a very deep undercut);
 * such texels are written twice and the later triangle wins. It is rare in
 * practice and visible only there.
 */
import { albedo } from "../sdf/materials.js";
import type { Mesh } from "../mesh/mesh.js";
import { Canvas, rgbf, rgbDithered } from "../render/canvas.js";

export interface AtlasResult {
  /** The mesh with vertices split per chart. */
  mesh: Mesh;
  /** u, v per vertex of `mesh`, in glTF convention (v down from the top of the image). */
  uv: Float32Array;
  image: Canvas;
  charts: number;
  texelsPerUnit: number;
}

export interface AtlasOptions {
  size?: number;
  padding?: number;
}

interface Chart {
  axis: number;
  tris: number[];
  /** Projected bounds in world units. */
  min: [number, number];
  max: [number, number];
  /** Placement in texels (top-left of the padded rect) and its size. */
  x: number;
  y: number;
  w: number;
  h: number;
}

/** Project a point along a chart's axis to 2D chart coordinates (world units). */
function project(axis: number, x: number, y: number, z: number): [number, number] {
  switch (axis >> 1) {
    case 0: return axis & 1 ? [z, y] : [-z, y]; // ±x: looking along the axis, z across
    case 1: return axis & 1 ? [x, -z] : [x, z]; // ±y
    default: return axis & 1 ? [-x, y] : [x, y]; // ±z
  }
}

export function bakeAtlas(mesh: Mesh, opts: AtlasOptions = {}): AtlasResult {
  const size = opts.size ?? 1024;
  const pad = opts.padding ?? 4;
  const P = mesh.positions, N = mesh.normals, I = mesh.indices;
  const triCount = I.length / 3;
  const empty = (): AtlasResult => ({ mesh, uv: new Float32Array((P.length / 3) * 2), image: new Canvas(4, 4, 0x000000), charts: 0, texelsPerUnit: 0 });
  if (triCount === 0) return empty();

  // Dominant axis per triangle from the summed vertex normals.
  const axisOf = new Uint8Array(triCount);
  for (let t = 0; t < triCount; t++) {
    const a = I[t * 3] * 3, b = I[t * 3 + 1] * 3, c = I[t * 3 + 2] * 3;
    const nx = N[a] + N[b] + N[c], ny = N[a + 1] + N[b + 1] + N[c + 1], nz = N[a + 2] + N[b + 2] + N[c + 2];
    const ax = Math.abs(nx), ay = Math.abs(ny), az = Math.abs(nz);
    if (ax >= ay && ax >= az) axisOf[t] = nx >= 0 ? 0 : 1;
    else if (ay >= az) axisOf[t] = ny >= 0 ? 2 : 3;
    else axisOf[t] = nz >= 0 ? 4 : 5;
  }
  // Union-find over triangles sharing an edge with the same axis.
  const parent = new Int32Array(triCount);
  for (let t = 0; t < triCount; t++) parent[t] = t;
  const find = (t: number): number => {
    while (parent[t] !== t) { parent[t] = parent[parent[t]]; t = parent[t]; }
    return t;
  };
  const unite = (a: number, b: number) => { a = find(a); b = find(b); if (a !== b) parent[a] = b; };
  const edgeOwner = new Map<number, number>();
  const vcount = P.length / 3;
  for (let t = 0; t < triCount; t++) {
    for (let e = 0; e < 3; e++) {
      const a = I[t * 3 + e], b = I[t * 3 + ((e + 1) % 3)];
      const key = a < b ? a * vcount + b : b * vcount + a;
      const other = edgeOwner.get(key);
      if (other === undefined) edgeOwner.set(key, t);
      else if (axisOf[other] === axisOf[t]) unite(other, t);
    }
  }
  const chartOf = new Map<number, Chart>();
  const chartIndex = new Int32Array(triCount);
  const charts: Chart[] = [];
  for (let t = 0; t < triCount; t++) {
    const root = find(t);
    let ch = chartOf.get(root);
    if (!ch) {
      ch = { axis: axisOf[t], tris: [], min: [Infinity, Infinity], max: [-Infinity, -Infinity], x: 0, y: 0, w: 0, h: 0 };
      chartOf.set(root, ch);
      charts.push(ch);
    }
    ch.tris.push(t);
    chartIndex[t] = charts.indexOf(ch);
    for (let k = 0; k < 3; k++) {
      const v = I[t * 3 + k] * 3;
      const [u, w] = project(ch.axis, P[v], P[v + 1], P[v + 2]);
      ch.min[0] = Math.min(ch.min[0], u); ch.min[1] = Math.min(ch.min[1], w);
      ch.max[0] = Math.max(ch.max[0], u); ch.max[1] = Math.max(ch.max[1], w);
    }
  }

  // Scale so the charts fit: start from the area ratio and shrink until the shelf packer succeeds.
  let area = 0;
  for (const ch of charts) area += (ch.max[0] - ch.min[0]) * (ch.max[1] - ch.min[1]);
  const usable = size - 2 * pad;
  let scale = Math.sqrt(((usable * usable) * 0.8) / Math.max(area, 1e-9));
  const order = [...charts].sort((a, b) => (b.max[1] - b.min[1]) - (a.max[1] - a.min[1]));
  const tryPack = (s: number): boolean => {
    let x = 0, y = 0, shelf = 0;
    for (const ch of order) {
      ch.w = Math.ceil((ch.max[0] - ch.min[0]) * s) + 1 + 2 * pad;
      ch.h = Math.ceil((ch.max[1] - ch.min[1]) * s) + 1 + 2 * pad;
      if (ch.w > size || ch.h > size) return false;
      if (x + ch.w > size) { x = 0; y += shelf; shelf = 0; }
      if (y + ch.h > size) return false;
      ch.x = x; ch.y = y;
      x += ch.w;
      shelf = Math.max(shelf, ch.h);
    }
    return true;
  };
  for (let guard = 0; guard < 60 && !tryPack(scale); guard++) scale *= 0.92;
  if (!tryPack(scale)) scale = 0; // degenerate; everything lands at the origin

  // Split vertices per chart and assign UVs.
  const newPos: number[] = [], newNrm: number[] = [], newLoc: number[] = [], newMat: number[] = [], uv: number[] = [];
  const newIdx = new Uint32Array(I.length);
  const remap = new Map<number, number>(); // chart * vcount + vertex -> new index
  charts.forEach((ch, ci) => {
    for (const t of ch.tris) {
      for (let k = 0; k < 3; k++) {
        const v = I[t * 3 + k];
        const key = ci * vcount + v;
        let nv = remap.get(key);
        if (nv === undefined) {
          nv = newPos.length / 3;
          remap.set(key, nv);
          newPos.push(P[v * 3], P[v * 3 + 1], P[v * 3 + 2]);
          newNrm.push(N[v * 3], N[v * 3 + 1], N[v * 3 + 2]);
          newLoc.push(mesh.local[v * 3], mesh.local[v * 3 + 1], mesh.local[v * 3 + 2]);
          newMat.push(mesh.materialIndex[v]);
          const [pu, pv] = project(ch.axis, P[v * 3], P[v * 3 + 1], P[v * 3 + 2]);
          const tx = ch.x + pad + 0.5 + (pu - ch.min[0]) * scale;
          const ty = ch.y + pad + 0.5 + (ch.max[1] - pv) * scale; // v runs down the image
          uv.push(tx / size, ty / size);
        }
        newIdx[t * 3 + k] = nv;
      }
    }
  });

  // Rasterise every triangle into the atlas, shading each texel from its interpolated local point.
  const image = new Canvas(size, size, 0x000000);
  const covered = new Uint8Array(size * size);
  const mats = mesh.materials;
  for (let t = 0; t < triCount; t++) {
    const a = newIdx[t * 3], b = newIdx[t * 3 + 1], c = newIdx[t * 3 + 2];
    const ax = uv[a * 2] * size, ay = uv[a * 2 + 1] * size;
    const bx = uv[b * 2] * size, by = uv[b * 2 + 1] * size;
    const cx = uv[c * 2] * size, cy = uv[c * 2 + 1] * size;
    const areaT = (bx - ax) * (cy - ay) - (by - ay) * (cx - ax);
    if (Math.abs(areaT) < 1e-12) continue;
    const inv = 1 / areaT;
    const minX = Math.max(0, Math.floor(Math.min(ax, bx, cx)) - 1), maxX = Math.min(size - 1, Math.ceil(Math.max(ax, bx, cx)) + 1);
    const minY = Math.max(0, Math.floor(Math.min(ay, by, cy)) - 1), maxY = Math.min(size - 1, Math.ceil(Math.max(ay, by, cy)) + 1);
    for (let py = minY; py <= maxY; py++) {
      const yy = py + 0.5;
      for (let px = minX; px <= maxX; px++) {
        const xx = px + 0.5;
        let w0 = ((bx - xx) * (cy - yy) - (by - yy) * (cx - xx)) * inv;
        let w1 = ((cx - xx) * (ay - yy) - (cy - yy) * (ax - xx)) * inv;
        let w2 = 1 - w0 - w1;
        // A texel's centre may miss a sliver of a triangle at its edge: accept a small overreach and clamp,
        // so thin triangles still get texels and the dilation has something to spread.
        const slack = -0.02;
        if (w0 < slack || w1 < slack || w2 < slack) continue;
        w0 = Math.max(0, w0); w1 = Math.max(0, w1); w2 = Math.max(0, w2);
        const sum = w0 + w1 + w2 || 1;
        w0 /= sum; w1 /= sum; w2 /= sum;
        const lx = newLoc[a * 3] * w0 + newLoc[b * 3] * w1 + newLoc[c * 3] * w2;
        const ly = newLoc[a * 3 + 1] * w0 + newLoc[b * 3 + 1] * w1 + newLoc[c * 3 + 1] * w2;
        const lz = newLoc[a * 3 + 2] * w0 + newLoc[b * 3 + 2] * w1 + newLoc[c * 3 + 2] * w2;
        const nearest = w0 >= w1 && w0 >= w2 ? a : w1 >= w2 ? b : c;
        const col = albedo(mats[newMat[nearest]], lx, ly, lz);
        image.set(px, py, rgbDithered(col[0], col[1], col[2], px, py));
        covered[py * size + px] = 1;
      }
    }
  }
  // Dilate the coverage outward `pad` times so filtering at chart borders samples chart colour.
  for (let round = 0; round < pad; round++) {
    const next = new Uint8Array(covered);
    const src = new Uint8Array(image.data);
    for (let y = 0; y < size; y++)
      for (let x = 0; x < size; x++) {
        const i = y * size + x;
        if (covered[i]) continue;
        let r = 0, g = 0, b = 0, n = 0;
        for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]] as const) {
          const nx = x + dx, ny = y + dy;
          if (nx < 0 || ny < 0 || nx >= size || ny >= size) continue;
          const j = ny * size + nx;
          if (!covered[j]) continue;
          r += src[j * 4]; g += src[j * 4 + 1]; b += src[j * 4 + 2]; n++;
        }
        if (n === 0) continue;
        image.set(x, y, ((Math.round(r / n) & 255) << 16) | ((Math.round(g / n) & 255) << 8) | (Math.round(b / n) & 255));
        next[i] = 1;
      }
    covered.set(next);
  }

  return {
    mesh: {
      positions: new Float32Array(newPos),
      normals: new Float32Array(newNrm),
      local: new Float32Array(newLoc),
      materialIndex: new Uint16Array(newMat),
      materials: mats,
      indices: newIdx,
    },
    uv: new Float32Array(uv),
    image,
    charts: charts.length,
    texelsPerUnit: scale,
  };
}
