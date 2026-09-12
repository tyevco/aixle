## Report: `clock` (grandfather clock)

Files: `dogfood/clock.aix` (97 lines), `dogfood/clock_reimport.aix`, outputs in `out/clock/` (sheet, slices, steps, poses, `anim_tick.png`, `model.glb` 5.8 MB, `model.stl` 9.2 MB, `model.obj`, `report.md`) and `out/clock_beauty/beauty.png` (1024, pose `show`). 15 renders of the model, about 10 `check`s.

### 1. The model

A grandfather clock 1.94 × 5.85 × 1.16 units, front on +z, walnut throughout, 41 named steps:

- **Plinth**: `base_mould` + `plinth` + `plinth_cap`, three rounded boxes stacked and overlapped.
- **Waist**: `waist_solid` (1.3 × 3 × 0.8) → `shell(0.08)` → `- door_cut` through the front wall only; a `door_frame` (an extruded rect-minus-rect, "z"); `glass` = a 0.045 pane sunk into the front wall, `material("glass", transmit=0.95)`. The inner walls get a `decal(box…, "tan")` so the interior is not black in the beauty render.
- **Pendulum**: `rod` (r 0.035, reaching 0.05 into the waist's top wall) + `bob` (cylinder r 0.27 turned to face +z) + `bob_boss`, wrapped in `joint(..., "pendulum", 0, 3.86, 0)`.
- **Hood**: `hood_solid - hood_recess` (a 0.06 recess in the front face), two turned `columns` (mirror), `cornice_1`, `cornice_2`, `pediment`, brass `finial`.
- **Dial**: `dial_plate` brass cylinder r 0.5 facing +z, sunk 0.045 into the recess floor; `chapter_region` (ring 0.31..0.49) decal in ivory, `tick_region` (60 boxes via `ring`) and `numeral_region` (twelve Roman numerals, each `text(...)` extruded "z", moved to radius 0.355 and `rotate(z=-30*i)`, so they read radially) decals in black. `bezel` torus, `hub` cylinder bridging both hands.
- **Hands**: `hour_hand` and `minute_hand` are extruded polygons pointing to 12 at rest, each a `joint` at the dial's centre (`hour` at z 0.47, `minute` at z 0.565, separated by a 0.04 air gap and joined through the hub).
- **Maker's plate**: brass `plate` 1.0 × 0.2 under the dial, `maker_text` "FABLE" in serif raised 0.05.
- Poses: `rest`, `three` (hour −90°), `ten_ten` (hour +55°, minute −60°), `swing` (+8°), `swing_back` (−8°), `show` (10:10 with the pendulum at −8°); animation `tick` swing→swing_back→swing over 2 s.

Verified in pictures: `out/clock_three/front.png` (hour on III, minute on XII), `out/clock_dial/sheet.png` (10:10 at cell 0.006, numerals legible, ticks and chapter ring right), `out/clock_maker/sheet.png` (FABLE clean, close-up watertight yes at 0.005), `out/clock/slices.png` (hollow waist, rod and bob inside, the pane in the front wall), the 1024 beauty (dial and plate read, pendulum visible through the glass).

Final `check`: no warnings. Sizes: base 1.9 × 0.18 × 1.12 … hood 1.94 × 2 × 1.12 (y 3.85..5.85), dial 1 × 1 × 0.08 at z 0.38..0.46, hands 0.09 × 0.41 × 0.06 and 0.08 × 0.55 × 0.05, clock 1.94 × 5.85 × 1.12, grid 256 → cell 0.0229.

### 2. Print readiness and re-import

From `out/clock/report.md` (rest pose, the exported one):

| Row | Value |
| --- | --- |
| Watertight | **yes** |
| Pieces | **1** |
| Stands | **yes**, centre of mass 0.555 inside the footprint (18-sided hull) |
| Overhangs | **4.5%** of the surface faces down more than 45° |
| Cavities | volume 2.079 at (0, 2.405, 0.005) — the glazed waist, sealed by design (not drained) |
| Volume | 5.512, triangles 184 596 |

Re-import (`dogfood/clock_reimport.aix`, `import("../out/clock/model.glb", resolution=160)`, 17.4 s to sample in `check` and again in `render`):

| | source | re-import |
| --- | --- | --- |
| Size | 1.94 × 5.85 × 1.16 | 1.941 × 5.85 × 1.16 (z −0.56..0.6 in check, padded) |
| Volume | 5.512 | 5.491 |
| Pieces | 1 | 1 |
| Cavities | 2.079 | 2.082 |
| Stands | yes | yes (0.552 inside) |
| Overhangs | 4.5% | 3.7% |
| Watertight | yes | **no**: 21 edges, "mostly 4 at (−0.031, 4.689, 0.532)" — all at the hub and hands, which are 0.05–0.06 thick and the import's cell is 0.037 |

What survived: every wooden part, bezel, dial disc, the raised FABLE, the hands (as bumps), the finial. Lost, as expected from positions-and-triangles-only: all materials, so the numerals, ticks and chapter ring (decals) and the glass are gone; the door reads as a recessed solid panel.

### 3. Friction

1. **Line 23 (now 28), `glass`** — `warning: 'glass' (line 23) is only 0.03 units thin, 1.128 of the 0.027 cell: it may be missing or broken in the mesh. Thicken it or raise the grid (set grid 488).` Expected a 0.03 pane to be fine at 1.1 cells; the threshold is 1.2. Thickened to 0.045. Clear message, one iteration.
2. **Line 79 (now 84), `maker_text`** — `warning: 'maker_text' (line 79) has gaps (a letter's counters, the space between letters, a slot) only 0.005 wide, 0.175 of the 0.027 cell: they close up in the mesh. Use a larger size, a lighter weight or more spacing=, or raise the grid (set grid 512).` The message does not say *which* gap. I probed: `spacing=0.07` left it at 0.022 (so a counter, not spacing); `weight=0.026` cleared it but gave `has a wall, tube (at its thin end, if tapered) or stroke only 0.026 thick, 0.978 of the 0.027 cell`; size 0.13/weight 0.03 gave `1.128 of the cell`. Five checks and three name/size changes ("FABLE & CO" → "FABLE", 0.07 → 0.14) to land on size 0.14, weight 0.032, which passes. The plate had to grow to 1.0 × 0.2 to hold it.
3. **Glass is opaque on every diagnostic picture.** `sheet.png`, `poses.png` and `anim_tick.png` (8 frames) show a grey pane and nothing behind it; the animation strip shows a clock in which nothing moves. Only `slices.png` (Z = 0 cut) and the beauty render show the pendulum. Expected the strip to show the swing. I verified the swing from the beauty close-up instead (`--focus glass --beauty --pose show`), two extra renders.
4. **Wrong steps blamed for non-watertight edges.** `out/clock_dial/report.md` (`--focus bezel --pose ten_ten`): `Watertight | no: 4 edges ... 1 at (0.386, 4.946, 0.537) in 'dial_plate', 'hood_solid'`. z 0.537 is neither the dial (front 0.46) nor the hood (front 0.475); it is the minute hand's pointed tip. Later, `--pose show` at grid 220: `1 at (-0.195, 4.06, 0.49) in 'hood_solid', 'hood_recess'; 1 at (-0.196, 4.054, 0.504) in 'plate', 'maker_text'` — both are the A's counter in `maker_text`. The blame sent me looking at the hood recess first. Fixed by blunting the hand tips (polygon tips 0.032 wide, line 77–78) and grid 256.
5. **A pointed polygon tip is not warned about.** `check` warns for tubes, strokes and shells under a cell but said nothing about the hands' 0-width tips (`polygon(..., 0,0.47, ...)`, original line 73), which produced the edges in item 4. Expected the same "thin end" warning tubes get.
6. **Two hands at rest both pointing to 12** — line 77–78. First version had hour 0.462..0.507 and minute 0.513..0.557 with the dial front at 0.46: `1 at (-0.064, 4.723, 0.513) in 'dial_plate', 'hour_hand'`. The guide's "overlap by a cell" advice cannot apply to two thin plates that must stay separate parts of a rig; I had to leave a 0.04 gap and bridge it with a hub. Worth a line in the rigs section.
7. **Interior lighting.** First beauty (`out/clock_qb`, 320 px): the door was a black rectangle. Three beauty renders (quick, 640, `--focus glass`) to arrive at `set light_azimuth -20`, `set light_elevation 30`, `set ambient 1.8`, a `tan` decal on the inner walls (line 26) and swinging the `show` pose to −8° so the bob sits on the lit side. The bob is still in shadow in the final picture. Nothing in the docs says how deep a key light at elevation 55 reaches into an opening.
8. **`--quick` is of little use on this model**: `warning: quick pass: 20 steps are thinner than this pass's 0.091 cell ... (plinth_cap, waist_shell, door_frame, glass, rod, bob, ...)`. Half the model is thinner than the quick cell, so every judgement needed the full render (12 s at grid 220, ~20 s at 256). Fine, but the quick loop the skill promises did not apply.
9. **`poses.png` thumbnails cannot show a 0.05-thick hand** (`out/clock/poses.png`): six identical-looking clocks. Documented ("meshed coarsely"), but a `--focus` per pose was the only way to judge the times: two more renders.
10. **Re-import watertight "no"** (item in section 2): `21 edges ... in 'back'` with no way to tell from the report that they are at the hands rather than a real export defect; I inferred it from the coordinates (y 4.69, z 0.53).
11. Minor: `report.md` lists the material I named `blued` by its variable name (`Materials | walnut, tan, brass, steel, glass*, ivory, black, blued`), which is nice, but the `*` on `glass` is unexplained.

### 4. What worked well

`check` is fast and exact, and the size table caught every placement before a render. Decals for the chapter ring, sixty ticks and twelve numerals cost nothing in geometry, survive into the atlas, and read at 1024. `joint`/`pose` was trivial: hands and pendulum right first time, and `--focus bezel --pose three` proved the 3:00 pose at cell 0.006 with its own watertight row. `shell` + one cutter gave the glazed waist; the slices proved it. The beauty render's glass refracts and shows the pendulum, and the report's stands/pieces/cavities rows answered print-readiness directly.

### 5. Three changes that would have helped most

1. **Name the gap in the lettering warning**: "counter of 'A' 0.022 wide" versus "gap between F and A", and offer a concrete pair that clears it ("at weight 0.032 size ≥ 0.14"). Item 2 cost five checks.
2. **Draw `transmit` materials see-through (or as an outline) on the sheet, `poses.png` and the animation strips**, or at least say on the strip that a step is behind glass. Item 3 made the animation strip and pose sheet useless for the one moving part.
3. **Blame the step whose surface actually holds a non-watertight edge, and warn in `check` about a polygon or profile tip thinner than a cell** the way tubes and strokes are warned. Items 4 and 5 were the only misdirections in the whole loop.
