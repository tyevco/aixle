Everything is in place: the program, the probe, the final render set (GLB, STL, 1024 beauty) under `out/terrace/`, and the re-import under `out/terrace_reimport/`. Nothing committed; nothing touched outside `dogfood/` and `out/`.

# Dogfood report: `terrace`

Agent `terrace`, brief 6 (café terrace). Program: `/home/user/aixle/.claude/worktrees/agent-a8af5ad2872ba4e8c/dogfood/terrace.aix`. Probe: `dogfood/terrace_reimport.aix`. Output: `out/terrace/` (sheet, slices, steps, report, `model.glb`, `model.stl`, `beauty.png` at 1024). Renders of the model: 15 of the 25 allowed (2 quick, 3 focus, 8 full, 2 re-imports).

## 1. The model

A café terrace, 8 × 3.6 × 5.6 units (metres), front at +z, output as a `scene` of eight objects: `tables` (4 copies via `place`), `chairs` (10 copies), `parasols_red` (2), `parasols_cream` (2), `paving`, `planter`, `menu`, `lamp`.

- **Paving**: one box 8 × 0.11 × 5.6, `material("#a39e95", "tiles", "#7a746c", scale=0.6)`. Every other object is placed at y = 0.08, 0.03 into the paving, so the scene meshes as one piece.
- **Chair** (built once at the origin, placed ten times at five yaws): a round seat, two front legs as tubes whose round caps end at the seat top and read as rivets, one `curve()` tube running rear foot → seat → over the top → rear foot as hoop and rear legs in one, a torus ring held by two short spokes into the hoop. Painted `material("#2f5d43", metal=0.5, rough=0.45)`.
- **Table**: round top, stem, cone foot, same green metal. **Parasol**: pole, finial sphere, a ferrule collar, and a canopy that is a cone minus the same cone shifted down 0.07 (its tip radius 0.02 hides inside the pole). Two canvases: `canvas_red` and `canvas_cream` (noise pattern at 0.06, rough 0.95).
- **Planter** along the back edge: a rounded box minus its void, `material("#8f8274", "wood", ..., axis="x")` so the grain runs along it; a `dirt` soil block down to the floor; eight `plants.bush(0.19)` from `std/plants`.
- **Menu board**: an A-frame of two `pine` panels rotated ±12° about their *top* edge, a hinge block filling the wedge, with a chalkboard and three lines of lettering (`MENU`, `coffee 2`, `cake 3`) as `decal`s of extruded `text`, so they add no geometry.
- **Lamp post** at the front-right corner: cone base, pole, collar, a lantern frame made as a box with two crosswise through-cuts (four posts and two plates, no inner void), a `glow=1.2` box inside, a roof slab, a lofted pyramid cap and a finial. Iron black.

Final `check`: 47 steps, all in the output, `output: scene 8 × 3.6 × 5.6`, `grid 320: cell 0.025 units`, `no warnings`. Steps run: 7 materials; `paving`; chair (`seat, leg, legs, hoop, spokes, ring, chair`); table (`top, stem, foot, table`); parasol (`pole, finial, ferrule, canopy, parasol_red, parasol_cream`); placements (`tables, parasols_red, parasols_cream, chairs`); planter (`planter_box, planter_void, trough, soil, bushes, planter`); menu (`panel, slate, title, line1, line2, board, front_board, back_board, hinge, menu`); lamp (`lamp_base, lamp_pole, collar, lantern_frame, lantern, roof, cap, lamp_top, lamp`).

## 2. Print readiness and re-import

From the final `out/terrace/report.md`:

| Row | Value |
| --- | --- |
| Size | 8 × 3.605 × 5.6 (surface extent x -4..4, y 0..3.605, z -2.8..2.8) |
| Triangles | 499,504 |
| Pieces | **1** |
| Watertight | **no: 1 edge**, at (1.887, 0.938, 1.723) in `hoop` "with itself" — the hoop's `curve()` rounds the two 90° corners at the top of the backrest tighter than the tube radius 0.03, so the tube's inner side self-crosses at one corner of one of the ten copies (the one yawed 195°). Down from 184 on the first full render. |
| Stands | **yes**, centre of mass 2.46 inside the footprint |
| Overhangs | **11%** (the undersides of four canopies and four table tops) |
| Cavities | none |

Re-import (`dogfood/terrace_reimport.aix`, `import("../out/terrace/model.glb", resolution=320)`, `set grid 320`):

| | Original | Re-import |
| --- | --- | --- |
| Size | 8 × 3.605 × 5.6 | 8 × 3.605 × 5.601 |
| Volume | 7.048 | 6.878 |
| Pieces | 1 | **5**: the four canopies, 0.176 each, at (±2, 1.987, ±…) |
| Watertight | 1 edge | 801 edges, "with itself", clustered at the paving top (y ≈ 0.108–0.113) where the planter and tables are sunk into it |
| Specks | none | 4 tiny specks at the table feet, e.g. (-2, 0.096, 0.901) |
| Cavities | none | none (an earlier re-import, before I filled the soil to the trough floor, reported a 0.315 void under the soil that the original's report had **not** listed) |

Visually everything survived (chairs, rings, lettering-free boards, lamp, bushes). What did not survive is every join that the GLB exports as two overlapping closed shells: the canopy overlapping the ferrule inside one object, and the objects sunk into the paving. It looks like the GLB carries a mesh per object (or per material) and the importer's inside test treats a doubly-covered region as outside, so the overlap that joins two parts becomes the gap that separates them. Same result at resolution 256 and 320.

## 3. Friction

1. **`dogfood/terrace.aix` line 84 (then; now 95)**: `check` warned `'+ ... | move(...)' applies move to the right side only`. Good catch, but I had written `... + lantern | move(3.5, 0.08, 2.3)` naturally as "assemble, then move", and I needed brackets around the whole union. Worth its own worked line in the guide's table: it is there, but only as a symptom.
2. **Line 61 (bushes), first check**: `plants.bush(0.28)` came out 0.83 × 0.77, i.e. a "radius 0.28" bush is 0.41 in radius. The doc line says "a bush of radius r: a clump of blended spheres", so I planned a 0.5-deep trough for it and had to shrink to `bush(0.19)` to fit. The `aixle doc` comment should give the finished size.
3. **Line 78/79 (the A-frame, first full render)**: `Watertight: 26 at (-3.222, 0.361, 2.065) in 'panel' (with itself)`. Two boards rotated ±12° about their centres cross at the centre. My mistake, but the message says "panel with itself", and there are two panels; I had to compute the crossing to see it. Naming the two placements (front_board vs back_board both contain `panel`) would have said it.
4. **Lantern, first full render**: `92 at (3.5, 3.345, 2.45) in 'cap', 'lantern_frame'` — three attempts to get a loft cap, a plate and a frame to meet without a sliver. The rule that finally worked (a box with two crosswise through-cuts, no inner void; every meeting face buried at least a cell inside its neighbour) is not written anywhere; the guide's "overlap by a cell" is necessary but not sufficient when a *face* ends up a fraction of a cell from another face.
5. **Chair, first full render**: `5 at (1.243, 0.521, -1.045) in 'leg', 'seat'` — a flat-capped tube ending inside a 0.03 seat (1.2 cells) is a sliver either way: 0.005 from a face. A bistro chair's seat cannot be thicker at this cell. I ended up pushing the legs through to the seat top so the round cap became a rivet. A hint in the thin-part table ("a part ending inside a plate under 2 cells thick: run it through") would have saved a render.
6. **`ring` and `bar` (lines 35–36), three full renders**: a bar of r 0.025 through a torus of tube r 0.025/0.03 at its centre line: 6, then 6, then 4, then 3 open edges, always at the same two turned chairs. Equal-radius perpendicular tubes are tangent at their saddle; a 0.005 radius difference is a fifth of a cell. The report told me where, never why. I replaced the bar with spokes buried in the ring. A line in the guide about equal-radius crossings would have saved three renders.
7. **Sample-plane coincidences, twice**: `4 at (-2.011, 2.279, -1.127) in 'pole', 'canopy', all on the plane y = 2.279` (the cut cone's flat tip ring, 0.015 wide) and `4 at (-3.386, 0.103, 1.966) in 'panel', 'paving', all on the plane y = 0.103` (the paving top at y = 0.10 = exactly 4 cells). The message is excellent ("move the part by a fraction of a cell") but a base at a round number is what everyone writes; the report could suggest the nearest off-plane value.
8. **Parasol hub (one render wasted)**: my cone hub under the canopy made 113 edges in `'hub', 'canopy'` at (-2.11, 2.229, -1.05): two surfaces meeting at 36° form a wedge under a cell wide for two cells either side of the crease. Concave crossings at shallow angles count as thin; the doc only mentions tangencies and touching faces.
9. **`--focus chair` on a `place`d shape**: frames the *first copy*, in world orientation, so the "FRONT" view of the chair was its side, and the neighbouring table top intruded. Fine once understood, but nothing says which copy a focus picks.
10. **`set zoom 1.25`** (line 10) changed the beauty framing barely at all: the paving's far corner already touches the frame's bottom, so the scene sits in the middle third with empty sky above. The doc says a zoom never crops, so this is by design, but a diagonal, flat scene needs an elevation-aware fit or a `set zoom` that may crop empty corners.
11. **Re-import time**: `import(...)` at resolution 256 took 180 s, at 320 273 s, and `check` and `render` each pay it. The doc says "tens of seconds". For an 8-unit scene it is minutes, and a probe `check` that only wants the size costs the same.
12. **Re-import loses the joins** (see section 2): 1 piece → 5, 1 edge → 801, plus specks at the paving top. The language doc says a closed mesh imports fine; a GLB written by the tool itself from a `scene` of overlapping objects does not round-trip, and neither the exporter nor the importer says so.
13. **Missing cavity in the original report**: the first version had a sealed void (0.19 tall) between the trough floor and the soil block. `report.md` said `Cavities: none`; only the re-import (`volume 0.315 at (-0.002, 0.245, -2.456)`) showed it. Either the scene path skips cavity detection or it missed this one; either way a printer would have found it.
14. **`hoop` with itself, the residual edge**: `curve()` through points 0.28 apart turning 90° bends tighter than a 0.03 tube; the crease is invisible on any sheet and reported only as one open edge on one copy. `check` warns about tube radius under a cell, not about a curve's bend radius under the tube's radius.
15. **Quick render** is honest ("11 steps are thinner than this pass's 0.063 cell") but at this scale it shows the furniture as specks, so it was useful once, for layout only; every later judgement needed the 20–35 s full render.

## 4. What worked well

`check` in a second, with exact boxes and the one precedence warning, before any picture. The watertight row naming the *point* and the *steps* of each edge cluster: every fix above was found from it without a probe. `--focus` on a step with its own "Close-up watertight" row. `place` for ten chairs and the scene export with a node per copy. `decal` for lettering at a scale where extruded text would have been mush. `std/plants` bushes as a one-liner. The beauty render is genuinely presentable on the first try, and the `glow` lantern needed no lighting work.

## 5. The three changes that would have helped most

1. **A "why" for open edges, not only a "where"**: classify each cluster (equal-radius tangency, face-within-a-cell-of-face, shallow concave wedge, on a sample plane, curve bent tighter than its tube) and print the one-line fix, as the sample-plane case already does. Items 3–8 and 14 cost eight renders between them and each was one of those five shapes.
2. **Make the tool's own GLB round-trip, or say it will not**: export a `scene` so that a re-import gives back one piece (either a unioned shell per object with sunk parts clipped, or an importer that treats overlapping closed shells as a union), and make `import` report its sampling time up front, cache the sampled field between `check` and `render`, or print the mesh size and an ETA.
3. **Finished sizes in `aixle doc`** for the std parts (`bush(0.19)` is 0.53 across, 0.5 tall), and a `--focus` that says which `place` copy it framed, plus a note that the frame is in world orientation.
