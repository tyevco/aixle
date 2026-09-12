/** Parse a Wavefront OBJ into triangles: positions and indices only, polygons fanned. */
export interface ImportedMesh {
  positions: Float32Array;
  indices: Uint32Array;
}

export function parseObj(text: string): ImportedMesh {
  const pos: number[] = [];
  const idx: number[] = [];
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (line.startsWith("v ")) {
      const p = line.slice(2).trim().split(/\s+/).map(Number);
      pos.push(p[0], p[1], p[2]);
    } else if (line.startsWith("f ")) {
      const verts = line.slice(2).trim().split(/\s+/).map((tok) => {
        const i = parseInt(tok.split("/")[0], 10);
        return i < 0 ? pos.length / 3 + i : i - 1;
      });
      for (let k = 1; k + 1 < verts.length; k++) idx.push(verts[0], verts[k], verts[k + 1]);
    }
  }
  if (pos.length === 0 || idx.length === 0) throw new Error("no triangles found in the OBJ");
  return { positions: new Float32Array(pos), indices: new Uint32Array(idx) };
}
