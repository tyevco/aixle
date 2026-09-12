/**
 * Binary STL: the file a slicer takes. Positions and triangles only, no
 * materials, one solid; the normal per triangle is recomputed from its
 * corners so any viewer agrees with the winding. Little-endian, as every
 * slicer expects: an 80-byte header, a triangle count, then 50 bytes per
 * triangle.
 */
import type { Mesh } from "../mesh/mesh.js";

export function toStl(mesh: Mesh, name = "aixle"): Buffer {
  const p = mesh.positions, ix = mesh.indices;
  const count = ix.length / 3;
  const buf = Buffer.alloc(84 + count * 50);
  buf.write(`Aixle ${name}`.slice(0, 79), 0, "ascii");
  buf.writeUInt32LE(count, 80);
  let o = 84;
  for (let t = 0; t < count; t++) {
    const a = ix[t * 3] * 3, b = ix[t * 3 + 1] * 3, c = ix[t * 3 + 2] * 3;
    const ux = p[b] - p[a], uy = p[b + 1] - p[a + 1], uz = p[b + 2] - p[a + 2];
    const vx = p[c] - p[a], vy = p[c + 1] - p[a + 1], vz = p[c + 2] - p[a + 2];
    let nx = uy * vz - uz * vy, ny = uz * vx - ux * vz, nz = ux * vy - uy * vx;
    const len = Math.hypot(nx, ny, nz) || 1;
    nx /= len; ny /= len; nz /= len;
    buf.writeFloatLE(nx, o); buf.writeFloatLE(ny, o + 4); buf.writeFloatLE(nz, o + 8);
    o += 12;
    for (const v of [a, b, c]) {
      buf.writeFloatLE(p[v], o); buf.writeFloatLE(p[v + 1], o + 4); buf.writeFloatLE(p[v + 2], o + 8);
      o += 12;
    }
    buf.writeUInt16LE(0, o);
    o += 2;
  }
  return buf;
}
