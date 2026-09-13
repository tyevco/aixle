## Report: `footbridge`

### 1. The model

`dogfood/footbridge.aix` (96 lines): a steel Warren-truss footbridge over a stream, on a small grass base, span along x, front truss on +z, units metres. Built from:

- **Two trusses**, one built in the plane z = 0 and `mirror("z")`ed: 8-unit bottom and top chords (0.12 box), 1.2 apart; six bays of diagonals as boxes rotated ±29° (`atan(bay/2, rise)`) and `array`ed by the bay; verticals at every bottom node that double as handrail posts.
- **Gusset plates** at all 13 nodes per truss, both faces: a trapezoid `polygon | round | extrude(..., "z")` sunk 0.02 into the flush member faces, plus a **ring of eight hex bolt heads** (`prism(6, 0.035, 0.05) | rotate(x=90)` then `ring(8, 0.135, axis="z")`). Outer plates at all nodes are bolted; the inner bottom-node plates are behind the deck and carry no bolts (the bolts collided with the plank edges).
- **Handrail**: a 0.03 tube on brackets inboard of the verticals, one bracket per bay.
- **Deck**: 7 cross beams (one per node) and 33 oak planks `array`ed at 0.24 pitch, sunk into the beams.
- **Abutments**: two concrete blocks, chords sunk 0.03 into their tops; a grass base with a channel cut through and a water slab in it.
- **Lamp post** on the +x abutment: post, foot, collar, cone hood, finial, and a `glow=1.2` bulb.
- Materials: `painted` (green, metal 0.25), `galv` (speckle, metal 0.75) for plates and bolts, `oak` at scale 0.12 with `axis="z"` for planks, `concrete`, `grass`, `water`.

Final `check`: 45 steps, output `bridge` 10.6 × 3.14 × 3.4, grid 400 (cell 0.0265), no warnings. Chords 8 × 0.12 × 0.12 at y 0.6..0.72 and 1.8..1.92; diagonals 0.75 × 1.25 × 0.12 each; plates 0.6 × 0.48 × 0.05; bolts 0.07 × 0.07 × 0.05; trusses 8.6 × 1.48 × 1.94; deck 7.88 × 0.05 × 1.72; abutments 10 × 0.45 × 2.7; lamp 0.44 × 2.54 × 0.44 at x 4.13..4.57.

Ten renders of the model, one of the re-import. Outputs in `out/footbridge/` (GLB 15.4 MB, STL 23.8 MB, beauty 1024).

### 2. Print-readiness and re-import

Final `out/footbridge/report.md`:

| Row | Value |
| --- | --- |
| Triangles | 475404 |
| Volume | 12.055 |
| Watertight | **yes** |
| Stands | **yes**, centre of mass 1.696 inside the footprint (10-sided hull) |
| Overhangs | **10%** of the surface faces down more than 45° (undersides of chords, cross beams, deck and the lamp hood; unavoidable on a bridge printed upright) |
| Pieces | **1** |
| Cavities | none |

Close-up (`--focus gusset_one`): "Close-up watertight: yes at cell 0.002".

Re-import (`dogfood/footbridge_reimport.aix`, `import("../out/footbridge/model.glb", resolution=400)`):

| | Source | Re-import |
| --- | --- | --- |
| Size | 10.6 × 3.14 × 3.4 | 10.601 × 3.143 × 3.401 |
| Surface extent y | 0..3.143 | -0.001..3.14 |
| Triangles | 475404 | 473788 |
| Volume | 12.055 | 11.97 (-0.7%) |
| Watertight | yes | no: 62 edges, all on the sample plane x = 3.937 (a plank edge landing on a sample plane of the re-sampled field) |
| Stands / Pieces | yes / 1 | yes / 1 |
| Overhang | 10% | 9.3% |

The re-import sheet shows every part survived: bolt heads as bumps on the plates, the rail and brackets, planks, lamp finial. Materials are not read back (documented).

### 3. Friction

1. **`ring` defaults to axis y, so my ring of bolts came out lying in the xz plane** (`dogfood/footbridge.aix` line 44, originally `ring(bolt, 8, 0.17)`). `check` showed it: `bolts_lo 0.42 × 0.08 × 0.42 ... z -0.2..0.23` when I expected 0.42 × 0.42 × 0.05. Expected the ring to lie in the plane of the shape's face. Fixed with `axis="z"`; the reference lists `axis` but the one-screen summary in the skill (`ring(n, radius)`) does not.

2. **Thin-plate warning suggests a grid, not a thickness** (line 41, then `plate_t = 0.03`): `warning: 'plate_lo' (line 38) is only 0.03 units thin, 1.132 of the 0.026 cell: it may be missing or broken in the mesh. Thicken it or raise the grid (set grid 512).` Grid 512 on a 10.6-unit model is the expensive answer; the cheap one, "make it 0.055", is not printed. I thickened to 0.05 by hand.

3. **Watertight edges from tangencies, three rounds**: (a) report: `74 edges ... 3 at (-3.31, 1.608, -0.73) in 'bolt', 'rail'` — the inner top-node bolts' ends were exactly tangent to the rail (z 0.73 both); (b) `42 edges ... in 'bolt', 'plate_lo'; ... 'bolt', 'plank'` at (-2.738, 0.691, 0.745) — inner bottom-node bolt edges within a cell of a plank edge; (c) `30 edges ... 2 at (-3.759, 0.998, -0.897) in 'plate_lo', 'diag_up'` — diagonals 0.10 deep left the plate's inner face exactly on the diagonal's face at z = 0.90. The coordinates and step names were enough to find each, but each cost a 40-second full render; `check` could have flagged (a) and (c) (two steps' faces coincident within a cell) without a mesh.

4. **`--focus` on a `def`-like step that is only ever placed by `array` frames the origin** (line 46 `gusset_lo`): its box is `x -0.3..0.3 y -0.14..0.34 z -0.025..0.055` at the origin, where the model has only water. Expected a way to focus on "one copy of gusset_lo". Worked around by adding `gusset_one = gusset_lo | move(...) | paint(galv)` (line 93) coincident with a real gusset and unioning it into the output.

5. **`--zoom` is capped by the bounding box, so a long diagonal model stays small** (lines 8-10): `--zoom 1.3 --elevation 22` left the bridge filling ~60% of the 1024 frame; `--zoom 2 --azimuth 30 --elevation 20` was capped at roughly the same framing. The doc says "it stops where the box would touch the edge"; the box's far corners are empty air here. Expected a fit-to-surface, or a warning saying what zoom was actually used.

6. **Re-import is slow, twice**: `import(..., resolution=400)` sampled 475k triangles in 211690 ms for `check` and again 200 s for `render` (7 minutes for one probe). The doc warns of "tens of seconds"; this was minutes, and nothing is cached between the two commands.

7. **Re-import is not watertight though the source was**: `62 edges ... all on the plane x = 3.937 ... a surface lying exactly on a sample plane` (`footbridge_reimport.aix` line 3). The report's advice, "move the part or the grid by a fraction of a cell", is not available to an import; so a print-ready GLB does not round-trip as print-ready.

8. **The quick sheet is nearly useless at this scale**: `quick pass: 15 steps are thinner than this pass's 0.083 cell ... (vertical, plate_lo, plate_hi, bolt, ...)`. The deck, verticals, plates and bolts were all gone, so after the first layout check every iteration was a 40-second full render (the mesh alone is 9-12 s, the atlas/GLB another 12 s; `--no-export --no-viewer` was essential and I only knew about it from the agent guide's command list).

9. **Slices are unreadable on a wide model**: `slices.png` at Y = 1.57 and Z = 0 showed the whole 10.6-unit width, so the truss section was a few pixels; nothing hollow here, so nothing lost, but a `--focus` was the only way to see a section of a member.

10. Minor: the skill's one-screen summary lists `tube(r, [x,y,z, ...], smooth=6, ...)` but not `cap=`; I found `cap="flat"` only in the reference.

### 4. What worked well

- `check` in a second with every box: it caught the ring-axis mistake before any render, and `atan(y, x)` / `sqrt` made the diagonal length and angle one line each.
- The watertight row naming the two steps and the world point of each bad edge: every tangency was located from the numbers alone.
- `--focus` close-up re-meshed at cell 0.002 with its own watertight row: the hex bolts, the rounded plate and the diagonals behind were all judgeable in one picture.
- `mirror("z")` for the second truss, `array` for bays and planks, `flip("y")`/`flip("z")` for the top-node plates and inner faces: the whole bridge is a handful of lines.
- The beauty render: metal plates, glowing bulb, shadow on the water; the bolt heads read at 1024 as asked.

### 5. Three changes that would have helped most

1. **A tangency check in `check`**: report pairs of steps whose faces coincide or lie within a cell of each other (my three watertight rounds were all this), with the two steps and the plane, before any mesh is built.
2. **`--focus` on a placed copy**, e.g. `--focus gussets[3]` or `--focus gusset_lo@(-2.67, 0.66, 0.925)`, so a part that exists only through `array`/`ring`/`mirror` can be framed without adding a coincident duplicate to the output.
3. **A camera that fits the surface, not the box**, or a `--zoom` that reports the value it clamped to; and, for the same product-picture goal, let the thin-part warning name the thickness that would clear the cell (`0.055`) alongside the grid.
