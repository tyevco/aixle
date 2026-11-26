/**
 * Bake the procedural materials into texture atlases with UVs, so the
 * patterns, and the finish the beauty render shows, survive in engines that
 * ignore vertex colours and know nothing of distance fields.
 *
 * Charts: each triangle is assigned the axis its normal points along most
 * (one of six), and triangles that share an edge and an axis form a chart.
 * A chart is projected flat along its axis, which for a surface facing that
 * way is nearly distortion-free, and charts are shelf-packed into the atlas
 * at a common texels-per-unit scale, with padding. Texels are shaded by the
 * same surface() the beauty render uses, from the interpolated local point,
 * and the border of each chart is dilated a few texels so bilinear filtering
 * never bleeds background into a seam. Vertices are split per chart so each
 * copy has one UV.
 *
 * Given the fields the mesh was extracted from, the same loop writes up to
 * three more maps, each only where it carries something: a tangent-space
 * normal map from the field's own gradient at the surface point under each
 * texel against the mesh's interpolated normal (a displace finer than the
 * mesh, a bump), a metallic-roughness map where a material varies them (wear,
 * rust), and an emissive map where a glowing material's colour varies. The
 * tangent frame comes from the chart: its two projection axes are the
 * directions of increasing u and of decreasing v, laid onto each vertex's
 * tangent plane along the chart's axis, so the ±y charts, whose projection is
 * mirrored, carry a handedness of -1.
 *
 * The one thing a planar chart cannot do is a surface that folds back on
 * itself along its axis inside one connected patch (a very deep undercut);
 * such texels are written twice and the later triangle wins. It is rare in
 * practice and visible only there.
 */
import { albedo, bumpSlope, fieldCurvature, surface } from "../sdf/materials.js";
import type { DistFn3, Material } from "../sdf/types.js";
import type { Vec3 } from "../core/vec.js";
import type { Mesh } from "../mesh/mesh.js";
import { Canvas, rgb, rgbDithered } from "../render/canvas.js";

/** Which of the extra maps a material reads, and what stands in for a map it does not need. */
export interface MaterialMaps {
  normal: boolean;
  metalRough: boolean;
  emissive: boolean;
  /** A glowing material whose colour is the same everywhere: that colour (0..1, as the atlas stores it), for a factor instead of a map. */
  emissiveColor?: Vec3;
  /**
   * A material without a metallic-roughness map whose texels all took one roughness or metalness other than its
   * own (a part smaller than a rust patch and wholly inside one, a thin part worn all over): that value, for its
   * factor, or an engine shades the atlas's oxide as the material's polished metal.
   */
  rough?: number;
  metal?: number;
}

/** What the normal map's test found, for the report and for choosing its thresholds. */
export interface NormalStats {
  /** Texels looked at (every one, or a sparse lattice when only deciding), and how many the field bends past BENT_DEGREES. */
  texels: number;
  bent: number;
  maxDeg: number;
  meanDeg: number;
  /** Whether the full map was baked, and why or why not. */
  written: boolean;
  reason: string;
}

export interface AtlasResult {
  /** The mesh with vertices split per chart. */
  mesh: Mesh;
  /** u, v per vertex of `mesh`, in glTF convention (v down from the top of the image). */
  uv: Float32Array;
  image: Canvas;
  charts: number;
  texelsPerUnit: number;
  /** Tangent-space normal map (glTF convention: +x toward increasing u, +y toward decreasing v), present only where it carries detail. */
  normal?: Canvas;
  /** x, y, z, w per vertex of `mesh`, the tangent the normal map was baked against; with `normal`. */
  tangents?: Float32Array;
  /** glTF metallic-roughness: G roughness, B metalness (R left white); present only where a material varies them. */
  metalRough?: Canvas;
  /** Emitted colour, black where nothing glows; present only where a glowing material's colour varies. */
  emissive?: Canvas;
  /** Per entry of `mesh.materials`. */
  maps: MaterialMaps[];
  normalStats?: NormalStats;
}

/** One field the mesh was extracted from, for a range of its triangles. */
export interface BakeField {
  /** First triangle and one past the last that came from this field. */
  range: [number, number];
  dist: DistFn3;
  /** Added to a mesh point to give the point in the field's frame (a joint's mesh is stored relative to its pivot). */
  offset: Vec3;
  /** Called around the range's texels: the hierarchy hides a joint's children here, as it did to mesh it. */
  enter?: () => void;
  leave?: () => void;
  /** The materials whose surface in this field carries relief finer than the mesh (a displace: see reliefMaterials). */
  relief?: ReadonlySet<Material>;
}

export interface AtlasOptions {
  size?: number;
  padding?: number;
  /** The fields the triangles came from: with them, the normal map and wear (which reads curvature) are baked. */
  fields?: BakeField[];
  /** The extraction's cell, for the normal map's probes. */
  cellSize?: number;
  /** The distance wear reads curvature over: `wearProbe` of the model's size, as the beauty render uses. */
  wearProbe?: number;
  /** false bakes the colour atlas alone, from albedo(), as before there were maps (the Roblox export). */
  maps?: boolean;
  /** Run the normal map's sampled test even without relief, for measuring it (the result still bakes no map). */
  testNormals?: boolean;
}

/** A texel is bent when the field's normal leans this far from the mesh's: well past the 8-bit encoding's half a degree. */
export const BENT_DEGREES = 3;
/**
 * The normal map is baked for a field with relief when at least this share of the sampled texels is bent. The
 * relief comes first because the share alone cannot tell it from the mesh's own error at creases and junctions:
 * measured, the plain examples lean 1 to 23% of their texels past 3 degrees there (a box's end four cells thick,
 * a cylinder meeting a plate), and baking that for every model would add a map to every GLB.
 */
export const BENT_SHARE = 0.02;
/** Past this, the field's normal is the other face of an edge the mesh rounds or misses by a fraction of a cell, not detail. */
const MISREGISTERED_DEGREES = 50;

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

/**
 * The world directions in which a chart's two projected coordinates grow, and the axis it looks along: the first
 * is the direction of increasing u, the second of decreasing v (v runs down the image), so they are a normal map's
 * +x and +y. Read off `project` above.
 */
const CHART_FRAMES: { u: Vec3; v: Vec3; a: Vec3 }[] = [
  { u: [0, 0, -1], v: [0, 1, 0], a: [1, 0, 0] },
  { u: [0, 0, 1], v: [0, 1, 0], a: [-1, 0, 0] },
  { u: [1, 0, 0], v: [0, 0, 1], a: [0, 1, 0] },
  { u: [1, 0, 0], v: [0, 0, -1], a: [0, -1, 0] },
  { u: [1, 0, 0], v: [0, 1, 0], a: [0, 0, 1] },
  { u: [-1, 0, 0], v: [0, 1, 0], a: [0, 0, -1] },
];

/**
 * A vertex's tangent in a chart: the chart's u direction laid onto the plane across the vertex normal along the
 * chart's axis (which keeps it the direction the UVs grow in on that plane), and the handedness that makes
 * cross(normal, tangent) * w the chart's v direction laid the same way. Falls back to plain Gram-Schmidt for a
 * normal nearly across the axis.
 */
export function chartTangent(axis: number, nx: number, ny: number, nz: number): [number, number, number, number] {
  const f = CHART_FRAMES[axis];
  const an = f.a[0] * nx + f.a[1] * ny + f.a[2] * nz;
  const lay = (d: Vec3): Vec3 => {
    const dn = d[0] * nx + d[1] * ny + d[2] * nz;
    if (an > 0.2) return [d[0] - (f.a[0] * dn) / an, d[1] - (f.a[1] * dn) / an, d[2] - (f.a[2] * dn) / an];
    return [d[0] - nx * dn, d[1] - ny * dn, d[2] - nz * dn];
  };
  const t = lay(f.u), b = lay(f.v);
  const tl = Math.hypot(t[0], t[1], t[2]) || 1;
  const tx = t[0] / tl, ty = t[1] / tl, tz = t[2] / tl;
  // cross(n, t) against the laid v direction gives the handedness.
  const cx = ny * tz - nz * ty, cy = nz * tx - nx * tz, cz = nx * ty - ny * tx;
  const w = cx * b[0] + cy * b[1] + cz * b[2] < 0 ? -1 : 1;
  return [tx, ty, tz, w];
}

/**
 * A normal in 0..1 RGB as glTF stores it: (n + 1) / 2, so (0, 0, 1) is (128, 128, 255). A zero lands on the tie
 * at 127.5, where rounding noise of 1e-9 either way split a flat face between 127 and 128; a hundredth of a level
 * breaks the tie upward.
 */
export const encodeNormal = (x: number, y: number, z: number): number => rgb((x + 1) * 127.5 + 0.01, (y + 1) * 127.5 + 0.01, (z + 1) * 127.5 + 0.01);

export function bakeAtlas(mesh: Mesh, opts: AtlasOptions = {}): AtlasResult {
  const size = opts.size ?? 1024;
  const pad = opts.padding ?? 4;
  const P = mesh.positions, N = mesh.normals, I = mesh.indices;
  const triCount = I.length / 3;
  const noMaps = (): MaterialMaps[] => mesh.materials.map(() => ({ normal: false, metalRough: false, emissive: false }));
  const empty = (): AtlasResult => ({ mesh, uv: new Float32Array((P.length / 3) * 2), image: new Canvas(4, 4, 0x000000), charts: 0, texelsPerUnit: 0, maps: noMaps() });
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

  // Split vertices per chart and assign UVs, and each copy its chart's tangent.
  const newPos: number[] = [], newNrm: number[] = [], newLoc: number[] = [], newMat: number[] = [], uv: number[] = [], tan: number[] = [];
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
          tan.push(...chartTangent(ch.axis, N[v * 3], N[v * 3 + 1], N[v * 3 + 2]));
        }
        newIdx[t * 3 + k] = nv;
      }
    }
  });

  const mats = mesh.materials;
  const withMaps = opts.maps !== false;
  const fields = withMaps ? opts.fields ?? [] : [];
  const cell = Math.max(opts.cellSize ?? 0, 1e-6);
  const probe = opts.wearProbe ?? cell * 1.5;
  // Each vertex's bitangent as a shader builds it from the tangent, cross(normal, tangent) * w, so the bake
  // inverts exactly the frame an engine will use (three.js interpolates it from the vertex, like this).
  const nv = newPos.length / 3;
  const bit = new Float32Array(nv * 3);
  for (let v = 0; v < nv; v++) {
    const nx = newNrm[v * 3], ny = newNrm[v * 3 + 1], nz = newNrm[v * 3 + 2];
    const tx = tan[v * 4], ty = tan[v * 4 + 1], tz = tan[v * 4 + 2], w = tan[v * 4 + 3];
    let bx = ny * tz - nz * ty, by = nz * tx - nx * tz, bz = nx * ty - ny * tx;
    const bl = Math.hypot(bx, by, bz) || 1;
    bx /= bl; by /= bl; bz /= bl;
    bit[v * 3] = bx * w; bit[v * 3 + 1] = by * w; bit[v * 3 + 2] = bz * w;
  }

  /**
   * Visit every texel a triangle covers, with its barycentric weights, in triangle order so a field's range is
   * entered once; `stride` > 1 visits a sparse lattice of them, for deciding whether a map is worth baking.
   */
  const texels = (visit: (t: number, px: number, py: number, w0: number, w1: number, w2: number) => void, stride = 1): void => {
    let fi = -1;
    const fieldAt = (t: number): void => {
      while (fi + 1 < fields.length && fields[fi + 1].range[0] <= t) {
        if (fi >= 0) fields[fi].leave?.();
        fi++;
        fields[fi].enter?.();
      }
    };
    for (let t = 0; t < triCount; t++) {
      if (fields.length) fieldAt(t);
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
        if (stride > 1 && py % stride) continue;
        const yy = py + 0.5;
        for (let px = minX; px <= maxX; px++) {
          if (stride > 1 && px % stride) continue;
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
          visit(t, px, py, w0 / sum, w1 / sum, w2 / sum);
        }
      }
    }
    if (fi >= 0) fields[fi].leave?.();
  };
  /** The field a triangle came from. */
  const fieldOf = (t: number): BakeField | undefined => {
    for (const f of fields) if (t >= f.range[0] && t < f.range[1]) return f;
    return undefined;
  };
  // The field's normal under a texel, found by sliding from the mesh point to the field's surface along the mesh
  // normal. The gradient there is one-sided per axis, a twentieth of a cell out, on whichever side agrees with the
  // mesh: on a face near an edge the other side's sample is the next face's, and a central difference there leaned
  // a plain box's texels 45 degrees in a band along every edge (measured: 14% of an arm of boxes bent). Detail
  // smooth at that scale reads the same from either side. Undefined when the surface is not within two cells, or
  // the normal there is another face's (an edge the mesh rounds or misses by a fraction of a cell).
  const ge = cell * 0.05;
  const fieldNormal = (f: BakeField, qx: number, qy: number, qz: number, nx: number, ny: number, nz: number, out: Float64Array): boolean => {
    const d = f.dist;
    let t = 0;
    for (let i = 0; i < 4; i++) {
      const v = d(qx + nx * t, qy + ny * t, qz + nz * t);
      t -= v;
      if (Math.abs(v) < cell * 1e-3) break;
    }
    if (!(Math.abs(t) < cell * 2)) return false;
    const sx = qx + nx * t, sy = qy + ny * t, sz = qz + nz * t;
    const d0 = d(sx, sy, sz);
    const side = (plus: number, minus: number, n: number): number => {
      const fwd = plus - d0, back = d0 - minus;
      return Math.abs(fwd / ge - n) <= Math.abs(back / ge - n) ? fwd : back;
    };
    const gx = side(d(sx + ge, sy, sz), d(sx - ge, sy, sz), nx);
    const gy = side(d(sx, sy + ge, sz), d(sx, sy - ge, sz), ny);
    const gz = side(d(sx, sy, sz + ge), d(sx, sy, sz - ge), nz);
    const gl = Math.hypot(gx, gy, gz);
    if (!(gl > 1e-12)) return false;
    out[0] = gx / gl; out[1] = gy / gl; out[2] = gz / gl;
    out[3] = sx; out[4] = sy; out[5] = sz;
    return out[0] * nx + out[1] * ny + out[2] * nz > Math.cos((MISREGISTERED_DEGREES * Math.PI) / 180);
  };
  const interpNormal = (a: number, b: number, c: number, w0: number, w1: number, w2: number, out: Float64Array): void => {
    let x = newNrm[a * 3] * w0 + newNrm[b * 3] * w1 + newNrm[c * 3] * w2;
    let y = newNrm[a * 3 + 1] * w0 + newNrm[b * 3 + 1] * w1 + newNrm[c * 3 + 1] * w2;
    let z = newNrm[a * 3 + 2] * w0 + newNrm[b * 3 + 2] * w1 + newNrm[c * 3 + 2] * w2;
    const l = Math.hypot(x, y, z) || 1;
    x /= l; y /= l; z /= l;
    out[0] = x; out[1] = y; out[2] = z;
  };
  const cosBent = Math.cos((BENT_DEGREES * Math.PI) / 180);
  const fn = new Float64Array(6), mn = new Float64Array(3);
  const anyBump = mats.some((m) => (m.bump ?? 0) > 0);

  // Whether the normal map is worth baking: always for a bump; for a displaced surface a sparse lattice of its
  // texels (one in sixteen) is tested, and the map is baked when enough of them lean past BENT_DEGREES; never for a
  // model with neither, whose mesh is its shape. Only those materials' texels carry the field's normal: the rest
  // stay flat, so the mesh's own error at a plain part's creases is neither baked nor paid for.
  let normalStats: NormalStats | undefined;
  let bakeNormals = false;
  const relief = fields.some((f) => f.relief && f.relief.size > 0);
  const detailed = (f: BakeField | undefined, m: Material): boolean => (m.bump ?? 0) > 0 || (!!f && (opts.testNormals || !!f.relief?.has(m)));
  if (fields.length) {
    let count = 0, bent = 0, maxDeg = 0, sumDeg = 0;
    if (!anyBump && (relief || opts.testNormals))
      texels((t, _px, _py, w0, w1, w2) => {
        const f = fieldOf(t);
        if (!f) return;
        const a = newIdx[t * 3], b = newIdx[t * 3 + 1], c = newIdx[t * 3 + 2];
        if (!detailed(f, mats[newMat[w0 >= w1 && w0 >= w2 ? a : w1 >= w2 ? b : c]])) return;
        interpNormal(a, b, c, w0, w1, w2, mn);
        const qx = newPos[a * 3] * w0 + newPos[b * 3] * w1 + newPos[c * 3] * w2 + f.offset[0];
        const qy = newPos[a * 3 + 1] * w0 + newPos[b * 3 + 1] * w1 + newPos[c * 3 + 1] * w2 + f.offset[1];
        const qz = newPos[a * 3 + 2] * w0 + newPos[b * 3 + 2] * w1 + newPos[c * 3 + 2] * w2 + f.offset[2];
        count++;
        if (!fieldNormal(f, qx, qy, qz, mn[0], mn[1], mn[2], fn)) return;
        const dot = Math.min(1, fn[0] * mn[0] + fn[1] * mn[1] + fn[2] * mn[2]);
        const deg = (Math.acos(dot) * 180) / Math.PI;
        sumDeg += deg; maxDeg = Math.max(maxDeg, deg);
        if (dot < cosBent) bent++;
      }, 4);
    bakeNormals = anyBump || (relief && count > 0 && bent / count >= BENT_SHARE);
    const share = count ? `${((bent / count) * 100).toFixed(1)}% of sampled texels lean past ${BENT_DEGREES} degrees` : "no texels";
    normalStats = {
      texels: count, bent, maxDeg, meanDeg: count ? sumDeg / count : 0, written: bakeNormals,
      reason: anyBump ? "a material has a bump" : !relief ? "no displace and no bump: the mesh is the shape" : bakeNormals ? `the displace: ${share}` : `the displace is shallow: only ${share}`,
    };
  }

  // Rasterise every triangle into the atlases, shading each texel from its interpolated local point.
  const image = new Canvas(size, size, 0x000000);
  const normalImg = bakeNormals ? new Canvas(size, size, encodeNormal(0, 0, 1)) : undefined;
  const mrImg = withMaps ? new Canvas(size, size, rgb(255, 255, 0)) : undefined;
  const emImg = withMaps && mats.some((m) => m.glow > 0) ? new Canvas(size, size, 0x000000) : undefined;
  const covered = new Uint8Array(size * size);
  // Per material: the range of roughness, metalness and emitted colour its texels took, and how many the normal map bent.
  const range = mats.map(() => ({ rMin: Infinity, rMax: -Infinity, mMin: Infinity, mMax: -Infinity, cMin: [Infinity, Infinity, Infinity], cMax: [-Infinity, -Infinity, -Infinity], cSum: [0, 0, 0], n: 0, bent: 0 }));
  let fullBent = 0, fullCount = 0, fullMax = 0, fullSum = 0;
  // A triangle's local Jacobian for a bump: how far the paint frame's point moves per world unit along two
  // directions in the triangle's plane, computed once per triangle.
  let jt = -1;
  const e1 = [0, 0, 0], e2 = [0, 0, 0];
  const u1: Vec3 = [0, 0, 0], u2: Vec3 = [0, 0, 0];
  const triFrame = (a: number, b: number, c: number): void => {
    const E1 = [newPos[b * 3] - newPos[a * 3], newPos[b * 3 + 1] - newPos[a * 3 + 1], newPos[b * 3 + 2] - newPos[a * 3 + 2]];
    const E2 = [newPos[c * 3] - newPos[a * 3], newPos[c * 3 + 1] - newPos[a * 3 + 1], newPos[c * 3 + 2] - newPos[a * 3 + 2]];
    const L1 = [newLoc[b * 3] - newLoc[a * 3], newLoc[b * 3 + 1] - newLoc[a * 3 + 1], newLoc[b * 3 + 2] - newLoc[a * 3 + 2]];
    const L2 = [newLoc[c * 3] - newLoc[a * 3], newLoc[c * 3 + 1] - newLoc[a * 3 + 1], newLoc[c * 3 + 2] - newLoc[a * 3 + 2]];
    const l1 = Math.hypot(E1[0], E1[1], E1[2]) || 1e-12;
    for (let k = 0; k < 3; k++) { e1[k] = E1[k] / l1; u1[k] = L1[k] / l1; }
    const along = E2[0] * e1[0] + E2[1] * e1[1] + E2[2] * e1[2];
    const p2 = [E2[0] - e1[0] * along, E2[1] - e1[1] * along, E2[2] - e1[2] * along];
    const l2 = Math.hypot(p2[0], p2[1], p2[2]) || 1e-12;
    for (let k = 0; k < 3; k++) { e2[k] = p2[k] / l2; u2[k] = (L2[k] - u1[k] * along) / l2; }
  };
  texels((t, px, py, w0, w1, w2) => {
    const a = newIdx[t * 3], b = newIdx[t * 3 + 1], c = newIdx[t * 3 + 2];
    const lx = newLoc[a * 3] * w0 + newLoc[b * 3] * w1 + newLoc[c * 3] * w2;
    const ly = newLoc[a * 3 + 1] * w0 + newLoc[b * 3 + 1] * w1 + newLoc[c * 3 + 1] * w2;
    const lz = newLoc[a * 3 + 2] * w0 + newLoc[b * 3 + 2] * w1 + newLoc[c * 3 + 2] * w2;
    const nearest = w0 >= w1 && w0 >= w2 ? a : w1 >= w2 ? b : c;
    const mi = newMat[nearest];
    const m = mats[mi];
    covered[py * size + px] = 1;
    if (!withMaps) {
      const col = albedo(m, lx, ly, lz);
      image.set(px, py, rgbDithered(col[0], col[1], col[2], px, py));
      return;
    }
    const f = fields.length ? fieldOf(t) : undefined;
    let qx = 0, qy = 0, qz = 0;
    if (f) {
      qx = newPos[a * 3] * w0 + newPos[b * 3] * w1 + newPos[c * 3] * w2 + f.offset[0];
      qy = newPos[a * 3 + 1] * w0 + newPos[b * 3 + 1] * w1 + newPos[c * 3 + 1] * w2 + f.offset[1];
      qz = newPos[a * 3 + 2] * w0 + newPos[b * 3 + 2] * w1 + newPos[c * 3 + 2] * w2 + f.offset[2];
    }
    let onField = false;
    const wantsNormal = !!normalImg && detailed(f, m);
    if (f && (wantsNormal || (m.wear ?? 0) > 0)) {
      interpNormal(a, b, c, w0, w1, w2, mn);
      onField = fieldNormal(f, qx, qy, qz, mn[0], mn[1], mn[2], fn);
    }
    // Wear reads the curvature at the surface point under the texel (or the mesh point, if the slide failed).
    const curv = f && (m.wear ?? 0) > 0 ? fieldCurvature(f.dist, onField ? fn[3] : qx, onField ? fn[4] : qy, onField ? fn[5] : qz, probe) : 0;
    const s = surface(m, lx, ly, lz, curv);
    image.set(px, py, rgbDithered(s.color[0], s.color[1], s.color[2], px, py));
    const r = range[mi];
    r.rMin = Math.min(r.rMin, s.rough); r.rMax = Math.max(r.rMax, s.rough);
    r.mMin = Math.min(r.mMin, s.metal); r.mMax = Math.max(r.mMax, s.metal);
    r.n++;
    mrImg!.set(px, py, rgb(255, s.rough * 255, s.metal * 255));
    if (emImg && s.glow > 0) {
      for (let k = 0; k < 3; k++) { r.cMin[k] = Math.min(r.cMin[k], s.color[k]); r.cMax[k] = Math.max(r.cMax[k], s.color[k]); r.cSum[k] += s.color[k]; }
      emImg.set(px, py, rgbDithered(s.color[0], s.color[1], s.color[2], px, py));
    }
    if (wantsNormal) {
      // The target: the field's normal under the texel, tilted by the bump's slope; the mesh's own normal where the
      // field gave none.
      let nx = onField ? fn[0] : mn[0], ny = onField ? fn[1] : mn[1], nz = onField ? fn[2] : mn[2];
      if ((m.bump ?? 0) > 0) {
        if (jt !== t) { triFrame(a, b, c); jt = t; }
        const [s1, s2] = bumpSlope(m, lx, ly, lz, u1, u2);
        nx -= s1 * e1[0] + s2 * e2[0]; ny -= s1 * e1[1] + s2 * e2[1]; nz -= s1 * e1[2] + s2 * e2[2];
        const l = Math.hypot(nx, ny, nz) || 1;
        nx /= l; ny /= l; nz /= l;
      }
      const dot = Math.min(1, nx * mn[0] + ny * mn[1] + nz * mn[2]);
      const deg = (Math.acos(dot) * 180) / Math.PI;
      fullCount++; fullSum += deg; fullMax = Math.max(fullMax, deg);
      if (dot < cosBent) { fullBent++; r.bent++; }
      normalImg.set(px, py, tangentSpace(a, b, c, w0, w1, w2, nx, ny, nz));
    }
  });
  /** The target normal in the frame the shader will build at this texel from the interpolated vertex tangents. */
  function tangentSpace(a: number, b: number, c: number, w0: number, w1: number, w2: number, nx: number, ny: number, nz: number): number {
    let tx = tan[a * 4] * w0 + tan[b * 4] * w1 + tan[c * 4] * w2;
    let ty = tan[a * 4 + 1] * w0 + tan[b * 4 + 1] * w1 + tan[c * 4 + 1] * w2;
    let tz = tan[a * 4 + 2] * w0 + tan[b * 4 + 2] * w1 + tan[c * 4 + 2] * w2;
    let bx = bit[a * 3] * w0 + bit[b * 3] * w1 + bit[c * 3] * w2;
    let by = bit[a * 3 + 1] * w0 + bit[b * 3 + 1] * w1 + bit[c * 3 + 1] * w2;
    let bz = bit[a * 3 + 2] * w0 + bit[b * 3 + 2] * w1 + bit[c * 3 + 2] * w2;
    let mx = newNrm[a * 3] * w0 + newNrm[b * 3] * w1 + newNrm[c * 3] * w2;
    let my = newNrm[a * 3 + 1] * w0 + newNrm[b * 3 + 1] * w1 + newNrm[c * 3 + 1] * w2;
    let mz = newNrm[a * 3 + 2] * w0 + newNrm[b * 3 + 2] * w1 + newNrm[c * 3 + 2] * w2;
    let l = Math.hypot(tx, ty, tz) || 1; tx /= l; ty /= l; tz /= l;
    l = Math.hypot(bx, by, bz) || 1; bx /= l; by /= l; bz /= l;
    l = Math.hypot(mx, my, mz) || 1; mx /= l; my /= l; mz /= l;
    // Solve [T B N] x = n: the rows of the inverse are B x N, N x T and T x B over the determinant.
    const r0x = by * mz - bz * my, r0y = bz * mx - bx * mz, r0z = bx * my - by * mx;
    const r1x = my * tz - mz * ty, r1y = mz * tx - mx * tz, r1z = mx * ty - my * tx;
    const r2x = ty * bz - tz * by, r2y = tz * bx - tx * bz, r2z = tx * by - ty * bx;
    const det = tx * r0x + ty * r0y + tz * r0z;
    if (Math.abs(det) < 1e-9) return encodeNormal(0, 0, 1);
    let x = (r0x * nx + r0y * ny + r0z * nz) / det;
    let y = (r1x * nx + r1y * ny + r1z * nz) / det;
    let z = (r2x * nx + r2y * ny + r2z * nz) / det;
    // A normal map's normal faces out of its surface.
    if (z < 0.05) z = 0.05;
    l = Math.hypot(x, y, z) || 1;
    x /= l; y /= l; z /= l;
    return encodeNormal(x, y, z);
  }

  // Dilate the coverage outward `pad` times so filtering at chart borders samples chart colour, in every map.
  const maps = [image, normalImg, mrImg, emImg].filter((c): c is Canvas => !!c);
  const sum = new Float64Array(maps.length * 3);
  const NEIGHBOURS = [[1, 0], [-1, 0], [0, 1], [0, -1]] as const;
  for (let round = 0; round < pad; round++) {
    const next = new Uint8Array(covered);
    const srcs = maps.map((c) => new Uint8Array(c.data));
    for (let y = 0; y < size; y++)
      for (let x = 0; x < size; x++) {
        const i = y * size + x;
        if (covered[i]) continue;
        let n = 0;
        sum.fill(0);
        for (const [dx, dy] of NEIGHBOURS) {
          const nx = x + dx, ny = y + dy;
          if (nx < 0 || ny < 0 || nx >= size || ny >= size) continue;
          const j = ny * size + nx;
          if (!covered[j]) continue;
          for (let k = 0; k < srcs.length; k++) { sum[k * 3] += srcs[k][j * 4]; sum[k * 3 + 1] += srcs[k][j * 4 + 1]; sum[k * 3 + 2] += srcs[k][j * 4 + 2]; }
          n++;
        }
        if (n === 0) continue;
        for (let k = 0; k < maps.length; k++) maps[k].set(x, y, ((Math.round(sum[k * 3] / n) & 255) << 16) | ((Math.round(sum[k * 3 + 1] / n) & 255) << 8) | (Math.round(sum[k * 3 + 2] / n) & 255));
        next[i] = 1;
      }
    covered.set(next);
  }

  // Which maps each material reads: a map only where it carries something a factor cannot.
  const step = 1.5 / 255;
  const matMaps: MaterialMaps[] = mats.map((m, i) => {
    const r = range[i];
    const metalRough = withMaps && r.n > 0 && (r.rMax - r.rMin > step || r.mMax - r.mMin > step);
    const glows = m.glow > 0 && r.n > 0;
    const constant = glows && [0, 1, 2].every((k) => r.cMax[k] - r.cMin[k] <= step);
    // Without a map, one value the texels all took stands as the factor when it is not the material's own.
    const factor = (lo: number, hi: number, own: number): number | undefined => (!metalRough && r.n > 0 && Math.abs((lo + hi) / 2 - own) > step ? Number(((lo + hi) / 2).toFixed(4)) : undefined);
    return {
      // Only a bumped or displaced material's texels were baked, so any bent texel is relief.
      normal: !!normalImg && ((m.bump ?? 0) > 0 || r.bent > 0),
      metalRough,
      emissive: glows && !constant,
      emissiveColor: glows && constant ? [r.cSum[0] / r.n, r.cSum[1] / r.n, r.cSum[2] / r.n] : m.glow > 0 && r.n === 0 ? m.color : undefined,
      rough: factor(r.rMin, r.rMax, m.rough),
      metal: factor(r.mMin, r.mMax, m.metal),
    };
  });
  if (normalStats && normalImg) normalStats = { ...normalStats, texels: fullCount, bent: fullBent, maxDeg: fullMax, meanDeg: fullCount ? fullSum / fullCount : 0 };
  const anyNormal = matMaps.some((m) => m.normal);
  const anyMR = matMaps.some((m) => m.metalRough);
  const anyEm = matMaps.some((m) => m.emissive);

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
    normal: anyNormal ? normalImg : undefined,
    tangents: anyNormal ? new Float32Array(tan) : undefined,
    metalRough: anyMR ? mrImg : undefined,
    emissive: anyEm ? emImg : undefined,
    maps: matMaps,
    normalStats,
  };
}
