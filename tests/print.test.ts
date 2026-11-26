import { describe, expect, it } from "vitest";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { inflateRawSync } from "node:zlib";
import * as P from "../src/sdf/primitives.js";
import * as O from "../src/sdf/ops.js";
import { surfaceNets } from "../src/mesh/surfaceNets.js";
import { bedFit, boxCorners, supportVolume, thinnestWall, wallThickness } from "../src/mesh/print.js";
import { to3mf } from "../src/export/threemf.js";
import { unzip, zip } from "../src/export/zip.js";
import { toStl } from "../src/export/stl.js";
import { check, run, surfaceGap, watertightNote, type RunOptions } from "../src/pipeline.js";
import { parse } from "../src/lang/parser.js";
import { preset } from "../src/sdf/materials.js";

const BARE: RunOptions = { views: [], steps: false, slices: false, turntable: false, callouts: false, glb: false, viewer: false, beauty: false };

describe("wall thickness", () => {
  it("reads a shell's wall, a solid's full depth, and a cup's wall through the field", () => {
    const shelled = O.shell(P.box(2, 2, 2), 0.1);
    const nets = surfaceNets(shelled, { resolution: 48 });
    const w = wallThickness(shelled, nets.mesh, nets.cellSize);
    expect(w.thinnest!.thickness).toBeCloseTo(0.1, 2);
    // A wall under a cell (0.042 here) is still measured: the march is in the field, not the mesh.
    const thin = O.shell(P.box(2, 2, 2), 0.03);
    const tn = surfaceNets(thin, { resolution: 48 });
    expect(wallThickness(thin, tn.mesh, tn.cellSize).thinnest!.thickness).toBeCloseTo(0.03, 2);
    expect(thinnestWall(P.sphere(0.5), 32).thickness).toBeCloseTo(1, 1);
    const cup = O.difference(O.move(P.cylinder(1.2, 2.4), 0, 1.2, 0), O.move(P.cylinder(1.06, 2.4), 0, 1.4, 0));
    expect(thinnestWall(cup, 96).thickness).toBeCloseTo(0.14, 2);
  });
  it("leaves the tip of a corner sharper than a right angle out, and keeps a sliver between two cuts", () => {
    // A cone's apex and a chamfered rim are corners, not walls: the far side leaves at a slant.
    const cone = O.move(P.cone(0.5, 0, 1), 0, 0.5, 0);
    expect(thinnestWall(cone, 64).thickness).toBeGreaterThan(0.3);
    // Two slots cut 0.02 apart leave a web 0.02 thick, which is a wall and is read as one.
    const plate = O.difference(P.box(1, 0.2, 1), O.union([O.move(P.box(0.2, 0.4, 2), -0.11, 0, 0), O.move(P.box(0.2, 0.4, 2), 0.11, 0, 0)]));
    const r = thinnestWall(plate, 64);
    expect(r.thickness).toBeCloseTo(0.02, 2);
    expect(Math.abs(r.at![0])).toBeLessThan(0.02);
  });
});

describe("supports", () => {
  it("is the volume under the overhanging faces, down to the plate or the model below", () => {
    // A table: a 2 × 2 slab on a 0.4 post, the slab's underside 1 above the floor: 3.84 of support from the plate.
    const table = O.union([O.move(P.box(0.4, 1, 0.4), 0, 0.5, 0), O.move(P.box(2, 0.2, 2), 0, 1.1, 0)]);
    const nets = surfaceNets(table, { resolution: 64 });
    const s = supportVolume(table, nets.mesh, nets.cellSize, 0);
    expect(s.volume).toBeGreaterThan(3.84 * 0.93);
    expect(s.volume).toBeLessThan(3.84 * 1.07);
    expect(s.onModel).toBe(0);
    // A shelf over a block: the columns stand on the block, not the plate.
    const shelf = O.union([O.move(P.box(1, 1, 1), 0, 0.5, 0), O.move(P.box(0.2, 2, 1), -0.6, 1, 0), O.move(P.box(1.2, 0.1, 1), 0, 1.95, 0)]);
    const sn = surfaceNets(shelf, { resolution: 64 });
    const ss = supportVolume(shelf, sn.mesh, sn.cellSize, 0);
    expect(ss.onModel).toBeGreaterThan(0.8 * 0.9);
    expect(ss.fromFloor).toBeLessThan(ss.onModel * 0.2);
  });
});

describe("the bed", () => {
  it("fits square, turned on the plate, lying down, or not at all", () => {
    const plank = boxCorners([-125, 0, -10], [125, 10, 10]);
    expect(bedFit(plank, 1, [260, 260, 250]).fits).toBe(true);
    const turned = bedFit(plank, 1, [220, 220, 250]);
    expect(turned.fits).toBe(false);
    expect(turned.turned).toBeGreaterThan(20);
    expect(turned.turned).toBeLessThan(70);
    // A rod 300 tall lies down on its side and fits turned across the plate.
    const rod = boxCorners([-5, 0, -5], [5, 300, 5]);
    const lying = bedFit(rod, 1, [220, 220, 250]);
    expect(lying.turned).toBeUndefined();
    expect(lying.lying?.up).toBe("x");
    expect(bedFit(boxCorners([0, 0, 0], [300, 300, 300]), 1, [220, 220, 250]).lying).toBeUndefined();
    // Units scale the points: 25 cm is 250 mm.
    expect(bedFit(boxCorners([0, 0, 0], [25, 1, 1]), 10, [200, 200, 200]).turned).toBeDefined();
  });
  it("gives the smallest turn, in the direction rotate(y=) turns, so turning the model by it makes it fit", () => {
    // A bar 250 long at rotate(y=30) fits a 200 bed across the diagonal: turned on by 8 to 22 degrees, or back by
    // 68 to 82. The answer was 69, meant the other way: rotate(y=69) as the report said made it 248 deep.
    const bar = (deg: number) => O.rotate(P.box(250, 10, 10), 0, deg, 0);
    const fitOf = (deg: number) => bedFit(surfaceNets(bar(deg), { resolution: 96 }).mesh.positions, 1, [200, 200, 200]);
    const t = fitOf(30).turned!;
    expect(t).toBeGreaterThan(7);
    expect(t).toBeLessThan(23);
    expect(fitOf(30 + t).fits).toBe(true);
    // The mirror image turns the other way (by as much, to a degree: the mesh is not quite symmetric).
    const m = fitOf(-30).turned!;
    expect(Math.abs(m + t)).toBeLessThanOrEqual(1);
    expect(fitOf(-30 + m).fits).toBe(true);
  });
});

describe("3MF and STL", () => {
  it("zips stored and deflated entries that unzip to the same bytes", () => {
    const a = Buffer.from("hello");
    const b = Buffer.from("x".repeat(5000));
    const z = zip([{ name: "a.txt", data: a }, { name: "dir/b.txt", data: b, deflate: true }]);
    const back = unzip(z, inflateRawSync);
    expect(back.get("a.txt")!.equals(a)).toBe(true);
    expect(back.get("dir/b.txt")!.equals(b)).toBe(true);
    expect(z.length).toBeLessThan(5000);
    // Reproducible: the same entries make the same bytes.
    expect(zip([{ name: "a.txt", data: a }]).equals(zip([{ name: "a.txt", data: a }]))).toBe(true);
  });
  it("writes the 3MF core parts: the unit, vertices once each, z up, a colour per triangle", () => {
    const red = preset("red")!;
    const blue = preset("blue")!;
    const shape = O.union([O.paint(O.move(P.box(1, 1, 1), 0, 0.5, 0), red), O.paint(O.move(P.sphere(0.4), 0, 1.2, 0), blue)]);
    const nets = surfaceNets(shape, { resolution: 32 });
    const files = unzip(to3mf(nets.mesh, { name: "a & b", unit: "centimeter" }), inflateRawSync);
    expect([...files.keys()]).toEqual(["[Content_Types].xml", "_rels/.rels", "3D/3dmodel.model"]);
    expect(files.get("[Content_Types].xml")!.toString()).toMatch(/Extension="model" ContentType="application\/vnd.ms-package.3dmanufacturing-3dmodel\+xml"/);
    expect(files.get("_rels/.rels")!.toString()).toMatch(/Target="\/3D\/3dmodel.model"[^>]*Type="http:\/\/schemas.microsoft.com\/3dmanufacturing\/2013\/01\/3dmodel"/);
    const model = files.get("3D/3dmodel.model")!.toString();
    expect(model).toMatch(/<model unit="centimeter" xml:lang="en-US" xmlns="http:\/\/schemas.microsoft.com\/3dmanufacturing\/core\/2015\/02">/);
    expect(model).toMatch(/<metadata name="Title">a &amp; b<\/metadata>/);
    expect(model).toMatch(/<basematerials id="1">\n<base name="red" displaycolor="#[0-9A-F]{6}FF"\/>\n<base name="blue" displaycolor="#[0-9A-F]{6}FF"\/>/);
    const verts = [...model.matchAll(/<vertex x="([-\d.e]+)" y="([-\d.e]+)" z="([-\d.e]+)"\/>/g)].map((m) => [Number(m[1]), Number(m[2]), Number(m[3])]);
    const tris = [...model.matchAll(/<triangle v1="(\d+)" v2="(\d+)" v3="(\d+)" pid="1" p1="(\d)"\/>/g)].map((m) => [Number(m[1]), Number(m[2]), Number(m[3]), Number(m[4])]);
    expect(tris.length).toBe(model.split("<triangle ").length - 1);
    expect(tris.length).toBeGreaterThan(500);
    // z is up: the model stands on z = 0 and reaches the sphere's top at 1.6.
    expect(Math.min(...verts.map((v) => v[2]))).toBeCloseTo(0, 1);
    expect(Math.max(...verts.map((v) => v[2]))).toBeCloseTo(1.6, 1);
    // Both materials are used, by the triangles where each part is.
    const byMat = [0, 1].map((m) => tris.filter((t) => t[3] === m));
    expect(byMat[0].length).toBeGreaterThan(50);
    expect(byMat[1].length).toBeGreaterThan(50);
    const meanZ = (ts: number[][]) => ts.reduce((s, t) => s + verts[t[0]][2], 0) / ts.length;
    expect(meanZ(byMat[1])).toBeGreaterThan(meanZ(byMat[0]));
    // Welded and closed: every edge is used once each way, and no triangle repeats a corner.
    const edges = new Map<string, number>();
    for (const [a, b, c] of tris) {
      expect(a !== b && b !== c && a !== c).toBe(true);
      for (const [p, q] of [[a, b], [b, c], [c, a]]) edges.set(`${p},${q}`, (edges.get(`${p},${q}`) ?? 0) + 1);
    }
    for (const [k, n] of edges) {
      expect(n).toBe(1);
      const [p, q] = k.split(",");
      expect(edges.get(`${q},${p}`)).toBe(1);
    }
  });
  it("writes the STL in millimetres with z up", () => {
    const nets = surfaceNets(O.move(P.box(1, 2, 0.5), 0, 1, 0), { resolution: 24 });
    const stl = toStl(nets.mesh, "t", 10);
    const n = stl.readUInt32LE(80);
    const lo = [Infinity, Infinity, Infinity], hi = [-Infinity, -Infinity, -Infinity];
    for (let t = 0; t < n; t++)
      for (let v = 0; v < 3; v++)
        for (let k = 0; k < 3; k++) {
          const x = stl.readFloatLE(84 + t * 50 + 12 + v * 12 + k * 4);
          lo[k] = Math.min(lo[k], x); hi[k] = Math.max(hi[k], x);
        }
    // 1 × 2 × 0.5 units, a unit 10 mm, y up turned to z up: 10 wide, 5 deep, 20 tall from the plate.
    expect(hi[0] - lo[0]).toBeCloseTo(10, 0);
    expect(hi[1] - lo[1]).toBeCloseTo(5, 0);
    expect(lo[2]).toBeCloseTo(0, 1);
    expect(hi[2]).toBeCloseTo(20, 0);
  });
});

describe("set units and set bed", () => {
  it("parses a unit as a bare word, keyword or not, and a bed as three numbers or a list", () => {
    expect(check("set units in\nm = box(1)").settings.units).toBe("in");
    expect(check("set units cm\nm = box(1)").settings.units).toBe("cm");
    expect(check("set bed 220 220 250\nm = box(1)").settings.bed).toEqual([220, 220, 250]);
    expect(check("set bed 220, 220, 250\nm = box(1)").settings.bed).toEqual([220, 220, 250]);
    expect(check("w = 180\nset bed [w, w, 200]\nm = box(1)").settings.bed).toEqual([180, 180, 200]);
    expect(parse("set grid 200").body[0]).toMatchObject({ type: "set", key: "grid", value: { type: "num", value: 200 } });
    expect(check("set units ft\nm = box(1)").warnings.join()).toMatch(/set units ft: no such unit; a unit can be mm, cm, m, in/);
    expect(check("set bed 200 200\nm = box(1)").warnings.join()).toMatch(/set bed 200 200: the bed is the printer's build volume as three numbers/);
  });
  it("takes several values for the bed only, and ends a set at the brace of a one-line loop", () => {
    // A set inside a one-line loop parsed before several values did, and still does.
    expect(check("for i in [1] { set grid 64 }\nm = box(1)").settings.grid).toBe(64);
    expect(check("for i in [1] { set bed 220 220 250 }\nm = box(1)").settings.bed).toEqual([220, 220, 250]);
    // Every other setting is one value: a list there was stored and read as NaN (a grid of NaN meshed nothing).
    expect(() => check("set grid 64 128\nm = box(1)")).toThrow(/set grid: expected one value, a number or a name \(only set bed takes several\)/);
    expect(() => check("set size [256]\nm = box(1)")).toThrow(/set size: expected one value/);
  });
  it("a render reports the print, warns when it does not fit the bed, and writes the 3MF and a millimetre STL", () => {
    const dir = mkdtempSync(join(tmpdir(), "aixle-"));
    try {
      const r = run("set units cm\nset bed 36 36 30\nm = box(4, 2, 1) | move(0, 1, 0)\nassert wall(m) > 0.5", "plank.aix", dir, { ...BARE, grid: 32 });
      expect(r.files).toContain("model.3mf");
      expect(r.report).toMatch(/## Print/);
      expect(r.report).toMatch(/\| Units \| cm: one unit is a centimetre \(10 mm\) \|/);
      expect(r.report).toMatch(/\| Size \| 40 × 10 × 20 mm/);
      // 40 mm long on a 36 mm plate: turned across it, it fits, so that is said and not warned.
      expect(r.report).toMatch(/\| Bed \| does not fit the 36 × 36 × 30 mm bed square \(40 wide for 36\); turned (-?\d+)° about the vertical on the plate \(as rotate\(y=\1\) turns it, counter-clockwise seen from above\), it fits \|/);
      expect(r.warnings.join()).not.toMatch(/does not fit/);
      expect(r.report).toMatch(/\| Thinnest wall \| 10 mm \(1 units, [\d.]+ cells\) at /);
      expect(r.report).toMatch(/\| Supports \| none/);
      expect(r.report).toMatch(/\| Material \| (7\.9\d|8) cm³ solid/);
      expect(r.report).toMatch(/\| Summary \| one piece, watertight, fits the bed turned -?\d+° \|/);
      const json = JSON.parse(readFileSync(join(dir, "report.json"), "utf8"));
      expect(json.print.units).toBe("cm");
      expect(json.print.wall.thickness).toBeCloseTo(1, 2);
      const stl = readFileSync(join(dir, "model.stl"));
      expect(Math.abs(stl.readFloatLE(84 + 12))).toBeLessThanOrEqual(20.001);
      const big = run("set units cm\nset bed 30 30 30\nm = box(5, 5, 5) | move(0, 2.5, 0)", "cube.aix", dir, { ...BARE, grid: 24 });
      expect(big.warnings.join()).toMatch(/The model is 50 × 50 × 50 mm and does not fit the 30 × 30 × 30 mm bed whichever way it lies/);
      // No units: a unit is taken as a millimetre and the report says so; no 3MF unless asked for.
      const bare = run("m = box(2, 2, 2) | move(0, 1, 0)", "bare.aix", dir, { ...BARE, grid: 24 });
      expect(bare.report).toMatch(/\| Units \| not set: a slicer reads a unit as a millimetre, so this prints 2 mm tall/);
      expect(bare.files).not.toContain("model.3mf");
      expect(run("m = box(2, 2, 2)", "asked.aix", dir, { ...BARE, grid: 24, threemf: true }).files).toContain("model.3mf");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
  it("wall() is the thinnest wall, and a failed promise says where", () => {
    const ev = check("cup = cylinder(1, 2) - (cylinder(0.94, 2) | move(0, 0.2, 0))\nassert wall(cup, 64) > 0.1, \"walls a nozzle can lay down\"");
    const a = ev.asserts[0];
    expect(a.passed).toBe(false);
    expect(a.detail).toMatch(/^0\.0[56]\d* > 0\.1$/);
    expect(a.where).toMatch(/^thinnest at \([-\d., ]+\) in 'cup'$/);
  });
  it("wall() of a part the mesh drops altogether is 0, not a promise kept of nothing", () => {
    // A 0.05 plate 100 wide meshes to nothing at 64 cells: it was Infinity, so wall(plate) > 0.8 held.
    const ev = check("set units mm\nplate = box(100, 0.05, 100) | move(0, 0.025, 0)\nassert wall(plate, 64) > 0.8, \"two lines\"");
    expect(ev.asserts[0].passed).toBe(false);
    expect(ev.asserts[0].detail).toBe("0 > 0.8");
    expect(ev.asserts[0].where).toMatch(/^no surface at a cell of 1\.56: the shape is empty or thinner than a cell everywhere/);
    expect(thinnestWall(O.difference(P.box(1, 1, 1), P.box(2, 2, 2)), 32).thickness).toBe(0);
    expect(thinnestWall(O.move(P.box(1, 0.4, 1), 0, 0.2, 0), 32).thickness).toBeCloseTo(0.4, 2);
  });
});

describe("open edges between two parts", () => {
  it("say how far apart the two surfaces are, or how deep one reaches into the other", () => {
    const cluster = (at: [number, number, number]) => ({ centre: at, at, box: { min: [at[0] - 0.01, at[1] - 0.1, at[2] - 0.1] as [number, number, number], max: [at[0] + 0.01, at[1] + 0.1, at[2] + 0.1] as [number, number, number] }, count: 6 });
    const w = (at: [number, number, number]) => ({ ok: false, holes: 6, nonManifold: 0, note: "no: 6 open edges.", where: cluster(at).box, clusters: [cluster(at)] });
    const apart = check("a = box(1, 1, 1)\nb = box(1, 1, 1) | move(1.01, 0, 0)\nboth = a + b");
    expect(surfaceGap(apart, "a", "b", [0.505, 0.2, 0.1], 0.05)!.gap).toBeCloseTo(0.01, 3);
    const note = watertightNote(w([0.505, 0.2, 0.1]), apart, 0.05);
    expect(note).toMatch(/6 at \(0\.505, 0\.2, 0\.1\) in 'a', 'b', their surfaces 0\.01 apart there \(0\.2 of a cell\)/);
    expect(note).toMatch(/overlap them by a cell or more, or part them by a cell/);
    const sunk = check("a = box(1, 1, 1)\nb = box(1, 1, 1) | move(0.99, 0, 0)\nboth = a + b");
    expect(watertightNote(w([0.495, 0.2, 0.1]), sunk, 0.05)).toMatch(/in 'a', 'b', '[ab]' only 0\.01 into '[ab]' there \(0\.2 of a cell\)/);
    // A cutter's inside is air: pebbles 0.01 inside a recess's wall are 0.01 clear of the dish (round 10's terrarium).
    const dish = check("base = cylinder(0.7, 0.3) | move(0, 0.15, 0)\nrecess = cylinder(0.5, 0.2) | move(0, 0.3, 0)\ndish = base - recess\npebbles = cylinder(0.49, 0.1) | move(0, 0.24, 0)\nm = dish + pebbles");
    const g = surfaceGap(dish, "recess", "pebbles", [0.495, 0.26, 0], 0.0124)!;
    expect(g.gap).toBeCloseTo(0.01, 3);
    expect(g.into).toBeUndefined();
    // At the floor the pebbles sink 0.01 past the recess's floor into the dish: the part is named, then the cut.
    const floor = surfaceGap(dish, "recess", "pebbles", [0.3, 0.2, 0], 0.0124)!;
    expect(floor.gap).toBeCloseTo(-0.01, 3);
    expect(floor.into).toEqual(["pebbles", "recess"]);
  });
});
