# Playground: dogfood report

Program: `/home/user/aixle/.claude/worktrees/agent-aab25fdfa042c3396/dogfood/playground.aix` (160 lines). Probe: `dogfood/playground_reimport.aix`. Outputs in `out/playground/` (`model.glb` 8.9 MB, `model.stl` 14.4 MB, `beauty.png` 1024 px) and `out/playground_reimport/`. Renders used: 13 of the model (1 quick, 11 full, 1 focus) plus 2 of the re-import probe, 15 of the 25 budget.

## 1. The model

A children's playground, one unit a metre, 10 × 8 on a rubber pad (y 0..0.1) with every piece sunk 0.02-0.07 into it. `scene slide, pad, swing_set, seesaw, climber, bench, bin` gives seven objects; the GLB has 10 nodes (seven objects plus the three joints). Each object is built at the origin and `move`d into place; the two rigs are built in place and the whole assembly moved above the joint (allowed; a rotation above a joint is not).

- **swing_set**: a `tube` beam on two splayed A-legs meeting in sphere fittings, painted blue. Each swing is `joint(swing(x), "swing_a"|"swing_b", x, beam_h, 0)`: two galvanised clamps on the beam, two chains, two eye spheres, a rubber seat. The chain is my own (`link()`, lines 46-57): a 2D stadium `rect(..., round=) | shell(2r)` extruded to a square wire, links alternately `rotate(x=90)`, spaced 0.39 so each nose sits *inside* the previous tip wire.
- **slide**: yellow platform (0.9 × 0.12), four legs, two smoothed-tube rails, an inclined ladder (stringers with rungs passing through them), and the bed: a U `polygon` profile `sweep`t along a `curve` from inside the platform down to 0.3 above the pad, green plastic, on two feet.
- **seesaw**: blue A-stands each carrying a galvanised pillow block under the axle; `tilt = joint(plank + hub + handles + seats, "seesaw", 0, piv_h, 0)` — the plank rides on a hub round the axle, 1.5 cells clear of the blocks at full tip.
- **climber**: four blue posts, three yellow rungs per face, a rounded cube boss at each of the 12 nodes with two `hardware.hex_bolt(0.1, 0.15)` heads seated on its outer faces.
- **bench**: my own oak bench (two end frames, four seat slats, two leaning back slats) turned `rotate(y=180)` to face the playground; **bin**: a cylinder minus an inner cylinder open at the top, torus rim, green.
- Poses `swing` (±30° about x), `tip` (12° about z), `play` (both), animation `playing`; `set pose play`, `set grid 256`.

Final `check`: pose play; 40 named shapes and 11 numbers, e.g. `pad 10 × 0.1 × 8`, `frame 4.3 × 2.58 × 2.1`, `swing_a 0.82 × 2.08 × 1.4` (posed line `y 0.62..2.7`), `swing_set 4.3 × 2.67 × 2.37`, `slide 0.94 × 2.5 × 5.23`, `tilt 3.15 × 1.27 × 0.4` (posed `y 0.27..1.25`), `seesaw 3.15 × 1.38 × 0.99`, `climber 2 × 1.91 × 2`, `bench 1.6 × 0.96 × 0.7`, `bin 0.52 × 0.8 × 0.52`, `chain_len = 1.96`, `link_d = 0.39`; `output: scene 10 × 2.81 × 8`, `grid 256: cell 0.0391 units`, `no warnings`.

## 2. Print-readiness and re-import

Final `report.md` (pose play, grid 256, 287,136 triangles):

| Row | Value |
| --- | --- |
| Pieces | **1** |
| Watertight | **no: 3 edges** shared by more than two triangles: 1 at (-0.817, 1.699, -2.732) in 'legs' (with itself), 1 at (-0.902, 1.788, -2.107) in 'legs' (with itself), 1 at (-3.404, 0.728, -2.027) in 'stringer' (with itself). All three lie on the surface of a plain two-point inclined `tube` with nothing else nearby; I could not find a geometric cause and take them as the mesher's noise floor (started at 78, then 224, down to 3). |
| Stands | yes, centre of mass 3.953 inside the footprint |
| Overhangs | 4.1% |
| Cavities | none |
| Surface extent | x -5..5, y -0.001..2.63, z -4..4; volume 9.606 |

Re-import (`import("../out/playground/model.glb", resolution=160)`, 21 s to sample 290,276 triangles): `check` says `back 10 × 2.63 × 8`, no warnings — the same size as the export's surface extent (the box, 2.81, includes the swings' rest boxes). A full render at grid 160 (the import's own cell, 0.0625) shows all seven objects in place and **at rest** (swings hanging, plank level), confirming the GLB carries the rest pose; volume 8.799 vs 9.606; Pieces 5 (the largest 8.779, then 0.013 at the bench's top back slat and three chain specks ≤ 0.001); 227 edges. What did not survive the 0.063 sampling: the 0.08 chain wire is broken in places, the 0.06-tall hex heads are mostly gone, all materials (documented: positions and triangles only). The `--quick` probe render (cell 0.156) was useless: 20 pieces, 15 specks.

## 3. Friction

1. **std chain is never watertight** — line 35 (first draft) `hardware.chain(12, 0.3, 0.04)`; report: `Watertight | no: 224 edges ... mostly 23 at (1.592, 1.099, -1.587) in 'swing_b' (with itself: two of its own surfaces cross there) ... By step: 'swing_b' 62.` The doc says links are "each hooked through the next"; the upright link's wire is exactly the flat link's inner width, so hooked links touch tangentially. Expected a shipped part to be usable in a scene; wrote my own link (lines 36-57), which took four renders to get right.
2. **Chain length is not documented** — `aixle doc std/hardware.aix` gives `chain(n=8, pitch=0.3, r=0.03)` but not its length; a probe `check` measured `c6 1.08 × 0.24 × 0.24`, `c8 1.36`, i.e. 0.14 a link plus 0.38, not 0.3 a link. Expected the pitch to be the length per link.
3. **Most open edges were unattributed** — the report said `78 edges ... By step: 'swing_b' 62` (later `102 ... 'swing_b' 17, 'swing_a' 7`): 16 to 162 edges named by no cluster and no step; `report.json` has no edge list (keys: name, output, bounds, size, triangles, cellSize, grid, materials, objects, physics, joints, poses, animations, steps, warnings, files, timings). I found them by reading the program for sub-cell features by hand, over four renders.
4. **Sub-cell contacts have no check-time warning** — none of these produced any message from `check`, only anonymous edges in the render: tube caps poking 0.005-0.01 through a face (lines 76-77, 81: `plat_h` end points with round caps reaching 1.55 through the 1.54 platform top), a hub top 0.01 under the plank's top (line 106), seat pads overhanging the plank by 0.01 (109), handle caps 0.02 through the plank's underside, the bed's top face coincident with the platform's (91), hex heads whose corners sat 0.011-0.03 above a sphere boss (128-130, now cubes), rung caps of equal radius tangent to the stringers (`4 at (-3.276, 0.256, -2.298) in 'stringer', 'rungs'`, line 87), and a stringer passing a leg with a 0.037 gap (`3 at (-3.249, 1.314, -1.633) in 'plat_legs', 'stringer'`, line 81). The docs say overlap by a cell; the converse (a protrusion or gap under a cell is an open edge) is what cost the renders.
5. **std bench left a loose sliver with no thin-part warning** — line 109 (draft) `f.bench(1.6, 0.45)`: `Pieces | 2 (the largest 9.297; then 0.004 at (-1.601, 0.94, 3.579) in 'bench', 'pad')`; `check` printed nothing about the bench's slats being under the 0.039 cell. `--focus bench` reported `Close-up watertight | yes at cell 0.007` and repeated the whole-model `Pieces | 2`, so the close-up could not say whether the sliver was the bench or the grid. Rebuilt the bench (lines 134-147).
6. **Attribution names a buried step** — `2 at (0.294, 0.503, 1.482) in 'plank', 'stand'`: the culprit was the bearing housing (line 103) poking under a cell through the tipped plank; `stand` was named because its cap ends inside the housing. Found by computing the plank's posed height by hand.
7. **"with itself" on a plain tube** — `1 at (-0.817, 1.699, -2.732) in 'legs' (with itself: two of its own surfaces cross there)` on a single two-point `tube` (line 29): a straight tube has no second surface; the message cannot be acted on. Three remain in the final.
8. **Watertightness judged in the pose, STL is "as shown"** — the same chain gave `'swing_b' 62, swing_a 0` in one run and `'swing_a' 10, 'swing_b' 7` in another; edges depend on which joint angle lands where on the grid. The GLB is at rest, the STL and the report are posed; there is no row for the rest mesh without a second render.
9. **`--quick` judges pieces on an import** — `warning: The model is 20 separate pieces: the largest is 0.313, the loose pieces are volume 0.025 at (4.407, 1.206, 0.189) in 'back'...` at a 0.156 quick cell over a 0.063 import; the quick pass's "dropped thin steps, not judging pieces" rule did not fire because the import is one step.
10. **A cylinder-plus-half-torus stadium link is unbuildable** — my first link (tube + `torus & box` halves) left near-coincident surfaces where the arc meets the straight tube tangentially (`7 at (1.603, 2.371, -2.262) in 'swing_b' (with itself...)`); nothing in the docs warns that arc-to-line joins are tangencies. The 2D `shell` + `extrude` route (line 50) worked.

## 4. What worked well

`check` is fast and exact: the `posed` lines, number steps (`chain_len = 1.96`) and the `surface` line for the swept bed let me place things without rendering. The report's Pieces and Cavities rows with positions found real faults immediately (the bin's sealed top as `Cavities | volume 0.05 at (-0.3, 0.421, 3.4)`; the bench sliver). `scene` + `joint` + `pose` worked first time, `poses.png` and `anim_playing.png` confirmed pivots and directions, and the exported GLB re-imports at rest with the right size. `sweep(profile, curve(...))` gave a clean slide bed in one go; `--focus` gave a real close-up; the beauty render is presentable; `aixle doc std/hardware.aix` and `use` were painless; the 9-19 s full-render loop at grid 256 made iterating affordable.

## 5. Three changes that would have helped most

1. **Attribute every open edge and expose them**: a per-step tally that sums to the total (or an `edges` array in `report.json` / `--edges`), naming the *exposed* step rather than one buried inside a neighbour. Items 3, 6 and 7 cost about five renders.
2. **A `check`-time contact audit**: warn on a round cap or head ending within ±1.2 cells of a host's face, two parallel faces under a cell apart, equal-radius tube crossings, and members of a `use`d library part thinner than the scene's cell (the std bench slats, the std chain wire). Items 4, 5 and 10.
3. **Make std/hardware's chain printable and documented**: overlap hooked links by a cell instead of touching, and state the length per link in its doc comment; also let `--quick` skip the pieces verdict when an import's sampling is finer than the quick cell (items 1, 2, 9).
