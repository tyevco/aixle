/**
 * 3MF, the format slicers read when they want more than an STL gives them:
 * the unit the coordinates are in, and a colour per triangle. The file is a
 * zip of three parts: `[Content_Types].xml`, `_rels/.rels` pointing at the
 * model, and `3D/3dmodel.model`, an XML mesh (vertices once each, triangles
 * by index, counter-clockwise from outside) with a `basematerials` group
 * holding each material's display colour, every triangle naming its own
 * with `pid` and `p1`. A slicer's build plate is the xy plane with z up, so
 * Aixle's y-up model is turned a quarter turn about x on the way out: its
 * front (+z) faces the front of the plate (-y).
 */
import type { Mesh } from "../mesh/mesh.js";
import { weldIndices } from "../mesh/mesh.js";
import { zip } from "./zip.js";

const CORE = "http://schemas.microsoft.com/3dmanufacturing/core/2015/02";

const esc = (s: string): string => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

// Six decimals, trailing zeros off: a float32 coordinate holds about seven significant figures.
const num = (v: number): string => {
  const s = (Math.round(v * 1e6) / 1e6).toString();
  return s === "-0" ? "0" : s;
};

const hex2 = (v: number): string => Math.round(Math.max(0, Math.min(1, v)) * 255).toString(16).padStart(2, "0").toUpperCase();

/** The model part on its own, for a test to read without the zip. */
export function model3mf(mesh: Mesh, opts: { name: string; unit: string; scale?: number }): string {
  const p = mesh.positions;
  const k = opts.scale ?? 1;
  // The crease copies share a position; a slicer wants one vertex there, or it sees the mesh as open.
  const welded = weldIndices(mesh);
  const remap = new Int32Array(p.length / 3).fill(-1);
  const verts: string[] = [];
  for (const v of welded) {
    if (remap[v] >= 0) continue;
    remap[v] = verts.length;
    // Turned to z up: (x, y, z) becomes (x, -z, y), a rotation, so the winding is kept.
    verts.push(`<vertex x="${num(p[v * 3] * k)}" y="${num(-p[v * 3 + 2] * k)}" z="${num(p[v * 3 + 1] * k)}"/>`);
  }
  const mats = mesh.materials;
  const withMats = mats.length > 0;
  const tris: string[] = [];
  const mi = mesh.materialIndex;
  for (let t = 0; t < welded.length; t += 3) {
    const a = remap[welded[t]], b = remap[welded[t + 1]], c = remap[welded[t + 2]];
    // A triangle whose corners welded together has no area, and 3MF forbids a repeated corner.
    if (a === b || b === c || a === c) continue;
    let attr = "";
    if (withMats) {
      // The triangle's material is its corners' (the mesher reads each copy just inside its own side), by majority.
      const m0 = mi[mesh.indices[t]], m1 = mi[mesh.indices[t + 1]], m2 = mi[mesh.indices[t + 2]];
      const m = m1 === m2 ? m1 : m0;
      attr = ` pid="1" p1="${Math.min(m, mats.length - 1)}"`;
    }
    tris.push(`<triangle v1="${a}" v2="${b}" v3="${c}"${attr}/>`);
  }
  const lines = [
    `<?xml version="1.0" encoding="UTF-8"?>`,
    `<model unit="${opts.unit}" xml:lang="en-US" xmlns="${CORE}">`,
    `<metadata name="Title">${esc(opts.name)}</metadata>`,
    `<metadata name="Application">Aixle</metadata>`,
    `<resources>`,
    ...(withMats ? [`<basematerials id="1">`, ...mats.map((m) => `<base name="${esc(m.name)}" displaycolor="#${hex2(m.color[0])}${hex2(m.color[1])}${hex2(m.color[2])}FF"/>`), `</basematerials>`] : []),
    `<object id="2" type="model"${withMats ? ` pid="1" pindex="0"` : ""}>`,
    `<mesh>`,
    `<vertices>`,
    ...verts,
    `</vertices>`,
    `<triangles>`,
    ...tris,
    `</triangles>`,
    `</mesh>`,
    `</object>`,
    `</resources>`,
    `<build>`,
    `<item objectid="2"/>`,
    `</build>`,
    `</model>`,
  ];
  return lines.join("\n");
}

/**
 * A 3MF package of the mesh in `unit` (micron, millimeter, centimeter, inch, foot, meter), its coordinates
 * multiplied by `scale` (1 when the model's unit is one 3MF has; a decimetre model is written in millimetres, 100).
 */
export function to3mf(mesh: Mesh, opts: { name: string; unit: string; scale?: number }): Buffer {
  const types = [
    `<?xml version="1.0" encoding="UTF-8"?>`,
    `<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">`,
    `<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>`,
    `<Default Extension="model" ContentType="application/vnd.ms-package.3dmanufacturing-3dmodel+xml"/>`,
    `</Types>`,
  ].join("\n");
  const rels = [
    `<?xml version="1.0" encoding="UTF-8"?>`,
    `<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">`,
    `<Relationship Target="/3D/3dmodel.model" Id="rel0" Type="http://schemas.microsoft.com/3dmanufacturing/2013/01/3dmodel"/>`,
    `</Relationships>`,
  ].join("\n");
  return zip([
    { name: "[Content_Types].xml", data: Buffer.from(types, "utf8") },
    { name: "_rels/.rels", data: Buffer.from(rels, "utf8") },
    { name: "3D/3dmodel.model", data: Buffer.from(model3mf(mesh, opts), "utf8"), deflate: true },
  ]);
}
