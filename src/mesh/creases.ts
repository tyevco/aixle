/**
 * Splitting a mesh's vertices at creases, so an edge shades and exports as
 * an edge.
 *
 * Surface nets give one vertex per cell, and the field's gradient at a
 * vertex that dual contouring has put on a box's edge points diagonally,
 * between the two faces. Every renderer interpolates that normal across
 * both faces, so a box reads as bevelled and a block standing on a
 * cylinder as melted into it, in the sheets, the viewer and any GLB
 * consumer. Here a vertex whose triangles' normals disagree by more than
 * `angle` degrees is copied once per group of agreeing triangles; the
 * mesher then gives each copy the normal and material of its own side.
 * A curved surface, whose neighbouring faces differ by a few degrees at
 * any sensible grid, is untouched, except that a vertex whose faces all
 * agree within fifteen degrees is marked flat and given their area-weighted
 * mean normal, instead of a gradient sampled half a cell each way, which
 * near an edge leans towards the next face (measured: 21 degrees off on a
 * box at sixteen cells, and the slanted sliver a corner cell leaves has
 * too little area to pull the mean). A surface bent more than that per
 * cell (a displaced skin) keeps the gradient, which is smoother there.
 *
 * Positions are duplicated, so the result is no longer closed by index;
 * `weldIndices` in mesh.ts joins the copies back for the watertight and
 * pieces checks.
 */

export interface CreaseSplit {
  positions: Float32Array;
  indices: Uint32Array;
  /** Per output vertex, the input vertex it copies. */
  source: Uint32Array;
  /** Per output vertex of a split input vertex, the unit normal of its group of faces; zero for an unsplit vertex. */
  side: Float32Array;
  /** Per output vertex of a split input vertex, the mean of its group's face centroids: a point on its own side, clear of the crease. */
  centroid: Float32Array;
  /** 1 for every copy of a split vertex (the first copy included), 0 for a vertex left alone. */
  split: Uint8Array;
  /** 1 for an unsplit vertex whose faces all agree within fifteen degrees; `side` then holds their mean normal. */
  flat: Uint8Array;
}

export function splitCreases(positions: ArrayLike<number>, indices: Uint32Array, angleDeg: number): CreaseSplit {
  const nv = positions.length / 3, nt = indices.length / 3;
  const cosLimit = Math.cos((angleDeg * Math.PI) / 180);
  const cosFlat = Math.cos((15 * Math.PI) / 180);
  // Face normals, unnormalised (their length is twice the area, which weights a group's mean).
  const fn = new Float64Array(nt * 3);
  for (let t = 0; t < nt; t++) {
    const a = indices[t * 3] * 3, b = indices[t * 3 + 1] * 3, c = indices[t * 3 + 2] * 3;
    const ux = positions[b] - positions[a], uy = positions[b + 1] - positions[a + 1], uz = positions[b + 2] - positions[a + 2];
    const vx = positions[c] - positions[a], vy = positions[c + 1] - positions[a + 1], vz = positions[c + 2] - positions[a + 2];
    fn[t * 3] = uy * vz - uz * vy; fn[t * 3 + 1] = uz * vx - ux * vz; fn[t * 3 + 2] = ux * vy - uy * vx;
  }
  // Vertex to its triangle corners, as offsets into `indices`.
  const count = new Uint32Array(nv + 1);
  for (let i = 0; i < indices.length; i++) count[indices[i] + 1]++;
  for (let v = 0; v < nv; v++) count[v + 1] += count[v];
  const corners = new Uint32Array(indices.length);
  const fill = count.slice(0, nv);
  for (let i = 0; i < indices.length; i++) corners[fill[indices[i]]++] = i;

  const outPositions: number[] = Array.from(positions as ArrayLike<number>);
  const outIndices = new Uint32Array(indices);
  const source: number[] = [];
  for (let v = 0; v < nv; v++) source.push(v);
  const side: number[] = new Array(nv * 3).fill(0);
  const centroid: number[] = new Array(nv * 3).fill(0);
  const split: number[] = new Array(nv).fill(0);
  const flat: number[] = new Array(nv).fill(0);

  const groupSum: number[] = [];
  const groupCentroid: number[] = [];
  const groupFaces: number[] = [];
  const groupOf: number[] = [];
  for (let v = 0; v < nv; v++) {
    const from = count[v], to = count[v + 1];
    if (to - from < 1) continue;
    groupSum.length = 0;
    groupCentroid.length = 0;
    groupFaces.length = 0;
    groupOf.length = 0;
    let groups = 0;
    // Faces without area have no normal to group by; they join whichever group comes first.
    for (let c = from; c < to; c++) {
      const t = (corners[c] / 3) | 0;
      const x = fn[t * 3], y = fn[t * 3 + 1], z = fn[t * 3 + 2];
      const l = Math.sqrt(x * x + y * y + z * z);
      if (l < 1e-20) { groupOf.push(-1); continue; }
      let g = -1;
      for (let k = 0; k < groups; k++) {
        const sx = groupSum[k * 3], sy = groupSum[k * 3 + 1], sz = groupSum[k * 3 + 2];
        const sl = Math.sqrt(sx * sx + sy * sy + sz * sz) || 1;
        if ((sx * x + sy * y + sz * z) / (sl * l) >= cosLimit) { g = k; break; }
      }
      if (g < 0) { g = groups++; groupSum.push(0, 0, 0); groupCentroid.push(0, 0, 0); groupFaces.push(0); }
      groupSum[g * 3] += x; groupSum[g * 3 + 1] += y; groupSum[g * 3 + 2] += z;
      const a = indices[t * 3] * 3, b = indices[t * 3 + 1] * 3, cc = indices[t * 3 + 2] * 3;
      groupCentroid[g * 3] += (positions[a] + positions[b] + positions[cc]) / 3;
      groupCentroid[g * 3 + 1] += (positions[a + 1] + positions[b + 1] + positions[cc + 1]) / 3;
      groupCentroid[g * 3 + 2] += (positions[a + 2] + positions[b + 2] + positions[cc + 2]) / 3;
      groupFaces[g]++;
      groupOf.push(g);
    }
    if (groups < 2) {
      if (groups !== 1) continue;
      const sx = groupSum[0], sy = groupSum[1], sz = groupSum[2];
      const sl = Math.sqrt(sx * sx + sy * sy + sz * sz) || 1;
      let planar = true;
      for (let c = from; c < to && planar; c++) {
        if (groupOf[c - from] < 0) continue;
        const t = (corners[c] / 3) | 0;
        const x = fn[t * 3], y = fn[t * 3 + 1], z = fn[t * 3 + 2];
        const l = Math.sqrt(x * x + y * y + z * z);
        if ((sx * x + sy * y + sz * z) / (sl * l) < cosFlat) planar = false;
      }
      if (planar) { side[v * 3] = sx / sl; side[v * 3 + 1] = sy / sl; side[v * 3 + 2] = sz / sl; flat[v] = 1; }
      continue;
    }
    // The first group keeps the vertex; each further group gets a copy at the same place.
    const ids: number[] = [v];
    for (let k = 1; k < groups; k++) {
      ids.push(outPositions.length / 3);
      outPositions.push(positions[v * 3], positions[v * 3 + 1], positions[v * 3 + 2]);
      source.push(v);
      side.push(0, 0, 0);
      centroid.push(0, 0, 0);
      split.push(1);
      flat.push(0);
    }
    split[v] = 1;
    for (let k = 0; k < groups; k++) {
      const sx = groupSum[k * 3], sy = groupSum[k * 3 + 1], sz = groupSum[k * 3 + 2];
      const sl = Math.sqrt(sx * sx + sy * sy + sz * sz) || 1;
      const o = ids[k] * 3;
      side[o] = sx / sl; side[o + 1] = sy / sl; side[o + 2] = sz / sl;
      const f = groupFaces[k] || 1;
      centroid[o] = groupCentroid[k * 3] / f; centroid[o + 1] = groupCentroid[k * 3 + 1] / f; centroid[o + 2] = groupCentroid[k * 3 + 2] / f;
    }
    for (let c = from; c < to; c++) {
      const g = groupOf[c - from];
      outIndices[corners[c]] = ids[g < 0 ? 0 : g];
    }
  }
  return {
    positions: new Float32Array(outPositions),
    indices: outIndices,
    source: new Uint32Array(source),
    side: new Float32Array(side),
    centroid: new Float32Array(centroid),
    split: new Uint8Array(split),
    flat: new Uint8Array(flat),
  };
}
