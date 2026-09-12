All done: 11 renders used of 25, no warnings on the final check, and the GLB re-imports at the same size. Final report follows.

# Treehouse — dogfood report (`treehouse`)

## 1. The model

`dogfood/treehouse.aix` is a treehouse scene about 10 units tall (surface extent 7.61 × 10.21 × 7.87), output with `scene tree, house, ladder, swing` so the GLB has four nodes. Beauty render: `out/treehouse/beauty.png` (1024); close-up of the hut: `out/treehouse_hut/sheet.png`.

How it is built (44 shape steps, all in the output; the numbers `deck_y`, `hut_x`, `sw_top`, … are printed by `check` too):

- **tree** — `trunk` is a `cone(0.75, 0.4, 7)`. Three `branch(az, y0)` calls (a `def`) are `tube(0.3, curve([...]), taper=0.4)` leaving the trunk at y≈3.6, curving out through the deck and up to r≈2.4 at y≈6.6, each turned by `rotate(y=az)` to azimuths 300°, 60°, 150° so none passes through the hut; `swing_branch` is a fourth, fatter tube that leaves the trunk at y=5.2 (above the deck) and runs out to x=4 at y=6.8, clearing the +x railing. `wood = union(trunk, branches, swing_branch, k=0.25) | displace(0.05, 0.35) | paint(bark)`. `canopy` is seven spheres in a `union(..., k=0.7)`, displaced and painted; `tree = union(wood, leaves, k=0.3) - below`, where `below` is a box under y=0 giving the trunk a flat base exactly on the floor.
- **house** — `deck`: ten `box(4.8, 0.16, 0.4)` planks in an `array`, minus `clearance = branches | offset(0.2)` so the planks are cut clear of the branches that pass through them; a `collar` disc round the trunk closes the gaps there; three `joists` sunk a cell into the planks. `railing`: 20 posts in a `for` over five positions per edge and two rails at deck+0.45 and deck+0.85, with the front rail split to leave the ladder gap. `hut`: `wall_box - inner` (walls 0.1), minus `door_cut` on the front (+z) and `window_cut` on +x, a `mullion` cross, and `roof = extrude(polygon(triangle), 2.0, "x")` — a gable whose ridge runs along x with 0.2 eaves. `lantern`: an iron `hook` tube into the joist, a brass `ring_top` torus, `lan_cap` cone, `lan_glass` amber cylinder with a `glow=2` sphere inside, `lan_base`.
- **ladder** — two `tube(0.06, ...)` rails from (±0.35, 0, 4.5) to (±0.35, 4.8, 2.3), ending in the deck's front edge, and ten `cap="flat"` rungs placed with `lerp` in a `for`.
- **swing** — `seat` box at y=1.5; two rope tubes from inside the seat up to `sw_top = height(wood, 3.4, 0.1) - 0.13`, i.e. measured into the branch, painted with a 0.05 `stripes` material so they read as twisted rope.

Materials: `bark` (noise), `leaf` (noise), `plank` (wood, axis x), `siding` (0.2 stripes, clapboard), `roofwood`, `rope` (stripes), `brass`, `amber`, `iron`, a glowing `#ffd070`. Lighting: `light_azimuth 40`, `light_elevation 50`, `ambient 1.6`, `zoom 1.3`, `grid 200` (cell 0.055).

## 2. Print-readiness (final `out/treehouse/report.md`) and re-import

| Row | Value |
| --- | --- |
| Size | 8.685 × 11.045 × 8.48 (box); surface extent x −3.457..4.154, y −0.004..10.213, z −3.309..4.566 |
| Triangles | 214412 |
| Watertight | **no: 24 edges** — "mostly 2 at (−2.114, 7.839, −2.485) in 'blob', 'canopy'; 2 at (1.142, 8.953, −1.494) in 'blob', 'canopy'; 2 at (−0.651, 0.006, 0.006) in 'trunk', 'below'". These are scattered pairs on the displaced canopy surface and on the trunk's flat base cut — sub-cell folds of `displace`, not a construction fault. (Down from 123 → 194 → 234 → 158 → 38 → 24 over the iterations.) |
| Stands | yes, centre of mass 0.59 inside the footprint (38-sided hull) |
| Overhangs | 19% |
| Pieces | **1** |
| Cavities | none |

Re-import (`dogfood/treehouse_reimport.aix`: `import("../out/treehouse/model.glb", resolution=160)`, 92 s to sample 217360 triangles at cell 0.064):

| | Original | Re-import |
| --- | --- | --- |
| Surface size | 7.61 × 10.21 × 7.87 | 7.61 × 10.22 × 7.87 |
| Volume | 80.159 | 79.369 (−1%) |
| Centre of mass | (0.14, 7.268, 0) | (0.141, 7.292, −0.004) |
| Pieces | 1 | 4: lantern loose (0.021 at (1.9, 3.88, 2.2)), two volume-0 specks at (2.382, 5.14/5.54, 0) |
| Watertight | 24 edges | 86 edges |

What survived: the trunk, branches, canopy, deck, posts, hut with door and window, roof, ladder rails and the two ropes and seat. What went: the 0.08-thick rails (the +x pair became the two specks), the ladder rungs are dotted, and the 0.08 hook, which is why the lantern is a separate piece — all under 1.2 × the import cell (0.077). The GLB itself has all four nodes and 217360 triangles; the losses are the import's sampling, not the export.

## 3. Friction

1. **`check`, first draft, line 71 (then `mullion = ... | rotate(y=90)`).** Sizes showed `mullion 0.5 × 0.5 × 0.07 (z -1.235..-1.165)` — thin in z where I meant thin in x. My mistake, caught by the size line; not a tool fault, but it shows why the sizes matter.
2. **`check`, first draft.** `warning: 5 steps are thinner than a grid cell (mullion, hook, ring_top, lan_base, house), the thinnest 'mullion' at 0.04 ... or set grid 512 covers them all.` Naming `house` (a union of forty parts) as thin because a child is thin is noise, and "set grid 512" is a 17× sample-count recommendation offered as an equal to thickening four steps by 0.03.
3. **Render 3 report, watertight row, lines 23–26 (the branch tubes).** `194 edges ... mostly 17 at (0.476, 4.073, 0.217) in 'trunk', 'swing_branch'; 14 at (3.242, 5.777, 0.057) in 'swing_branch', 'rope_one'; 13 at (0.672, 4.406, -1.134) in 'plank_one', 'wood'`, then after fixing the joints render 5 gave `158 edges ... 18 at (0.914, 5.509, 0.191) in 'swing_branch', 'wood'; 13 at (-1.091, 4.409, -0.534) in 'branches', 'wood'`. The named pair is "innermost step and its parent", not the two surfaces that clash, and every cluster centroid sat *on the axis* of a branch where no other part was. It took three full renders to decode that as rings of sub-cell slivers at the segment joins of a `tube(..., smooth=4, taper=0.4)`; swapping the point list for `curve([...])` (same points, same taper) dropped the count from 158 to 38. Neither `docs/language.md` nor the reference says a smoothed, tapered polyline tube leaves such rings; the docs pitch `curve` only as "no facets".
4. **Renders 3 and 4, Cavities row.** `volume 0 at (1.039, 4.674, 0.008); volume 0 at ... (enclosed voids, not loose parts)` — four sub-cell voids, described as enclosed cavities, at the same tangencies the watertight row was reporting. They vanished with the same fix. Two diagnoses for one cause, and neither said "these are grazing surfaces".
5. **Render 5 report.** `Pieces 2 (the largest 79.355; then 0 at (1.836, 7.958, 0.003) in 'blob', 'canopy')` — a volume-0 speck in the k-blend neck between two canopy spheres counted as a separate piece. The message for a real loose part and for a sub-cell speck is the same row; I fixed it by moving a blob 0.4, which was a guess that worked.
6. **Report only lists three clusters.** With 234 edges, I could not see whether the rest were on the same steps; a per-step tally would have pointed at "all four branch tubes" in one read instead of three renders.
7. **`ground()` in a scene, line 40 of draft 2.** `tree = (wood + leaves) | ground()` was going to lift the tree by the bark's displacement amplitude while `house`, `ladder` and `swing` stayed where their numbers put them; nothing warns that grounding one object of a scene moves it relative to the others. I caught it reading the check box (`tree y -0.04..10.6`) and replaced it with a cut at y=0. The docs describe `ground()` per shape only.
8. **`set zoom 1.3`, line 10.** No visible change between renders 7 and 9: the camera frames the *box* (tree box y −0.32..10.7, x −4.02..4.77) which the `union(k=)` and `displace` padded, not the surface extent (y −0.004..10.21, x −3.46..4.15) that the report knows. The doc's "stops where the box would touch the edge" is accurate, but about 8% of every side of the beauty frame is padding.
9. **Re-import.** `warning: The model is 2 separate pieces: ... the loose piece is volume 0.021 at (1.9, 3.88, 2.2) in 'back'` plus `2 tiny specks of mesh`. The import's cell (0.064 at resolution 160, its longest side being 10.2) is coarser than the render grid (0.055), and nothing says which parts of the mesh fall under it: the thin-step check works on steps, and an import is one step. I had to work out from positions that the hook and the rails were the casualties.
10. **Quick render, first draft.** `warning: 11 tiny specks of mesh ... in 'plank_one', 'joist'` at the quick cell; gone at full grid. The doc says the pieces count is not judged on a quick sheet, but the specks warning is still printed there and read as a fault.
11. **Timing.** Each full render was 30–45 s at grid 200, of which exports were 9–17 s; the import sample was 92 s, run once for `check` and again for `render` (the doc does warn of this).

## 4. What worked well

`check` sizes found every misplacement before a picture was made; the sheet's four views were enough to judge the composition in one read; the slices settled the hut's hollowness and the plank gaps in one look; `--focus hut` at cell 0.0135 showed the door, mullion and eaves at a detail the main sheet could not; `height()` for the rope's top and `offset()` for the plank clearance did exactly what the docs say; `union(k=)` and `curve()` both cleaned the mesh as much as they cleaned the look; `scene` gave four GLB nodes with no extra work; the watertight row naming coordinates and steps, and the Pieces/Stands/Overhangs rows, made print-readiness a number I could drive down rather than a hope.

## 5. Three changes that would have helped most

1. **Name both surfaces at a non-manifold cluster, and tally edges per step.** "18 at (x, y, z) in 'swing_branch', 'wood'" should say what the branch met (the deck, the canopy, or *itself*), and a per-step count would have shown at once that one construct — the `smooth=`/`taper=` tube — carried them all. Add to the docs: a smoothed, tapered polyline tube leaves sub-cell rings at its joins; use `curve()` for a tapered branch.
2. **Make imports report thin features.** Print the import cell next to the model's thinnest parts (or default `resolution` from the render grid so the two cells match), and warn when the re-imported mesh loses pieces to sampling, so a loose lantern is not mistaken for a broken export.
3. **Frame the beauty camera on the surface extent, not the loose box** (or let `zoom` reach the surface extent), since a blended, displaced tree pads its box by up to 10% a side and the report already measures the true extent.

Files: `/home/user/aixle/.claude/worktrees/agent-a11fd7f11ce175f69/dogfood/treehouse.aix`, `/home/user/aixle/.claude/worktrees/agent-a11fd7f11ce175f69/dogfood/treehouse_reimport.aix`; outputs under `/home/user/aixle/.claude/worktrees/agent-a11fd7f11ce175f69/out/treehouse/` (`beauty.png`, `model.glb`, `model.stl`, `report.md`), `out/treehouse_hut/`, `out/treehouse_reimport/`. Nothing committed; nothing outside `dogfood/` and `out/` touched. 11 renders in total.
