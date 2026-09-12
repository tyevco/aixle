## Report: `bicycle`

### 1. The model

`dogfood/bicycle.aix` (132 lines) is a diamond-frame bicycle, 4.09 × 2.45 × 1.69 units, facing +x with the drive side on +z so the front view is the product side. Geometry is written in metres from a real road bike (BB 0.27 m up, 73° seat tube, 72° head angle, 0.34 m wheels) through `def P(x, y, z=0) = [x*s, y*s, z*s]` with `s = 2.4`, and every frame member is a `tube` between two of those named points, so the joins meet by construction:

- **Frame**: top, down, seat and head tubes, a BB shell, chainstays and seat stays mirrored across z, dropout plates. Seat stays end on the seat-tube axis and chainstays inside the BB shell (see friction 5 for why).
- **Wheel** (one template, moved twice): rubber torus tyre, silver torus rim, chrome hub drum and axle, 16 spokes (8 a side, `ring(8, 0, axis="z")`, the other side flipped and offset 22.5°), a valve and an orange reflector so a 90° roll is visible. The rear wheel adds a freewheel boss and a 16-tooth cog.
- **Steering**: crown, two curved fork blades (`smooth=6`), steerer, stem, stem cap, chrome bar with rubber grips, plus the front wheel; all wrapped in `joint(..., "steer", hmid)` at the head tube's midpoint; the front wheel has its own nested `front` joint at the axle.
- **Saddle**: two blended ellipsoids in leather (`scale=0.03`), on a chrome post and rail.
- **Crankset**: crank arms + pedal axles + rubber pedals, right at −35°, left at 145°, a 26-tooth chainring cut from a 2D profile with five lightening holes, a spindle through the BB.
- **Chain**: a `tube` around a point list computed in-program from the two pitch circles' external tangents (`phi`, `beta`, `top_a`, `bot_a` are number steps, printed by `check`).
- **Centre stand**: two iron legs with rubber feet and a pivot buried in the chainstays, so the bike stands on four points.
- **Poses**: `turned` = `steer=[8.2, 23.7, 1.72]` (the xyz-Euler decomposition of 25° about the 72° head axis, computed outside the tool), `rolling` = rear and front 90°, animation `roll`.

Final `check`: 76 steps, `output: bike 4.09 × 2.49 × 1.7`, `grid 300: cell 0.0136 units`, **no warnings**. `check --pose turned`: `steer` surface `1.52 × 2.25 × 1.55  y 0.03..2.27` (the front wheel lifts 0.03 when turned about the raked axis, as a real bike does).

Renders of the model: 17 of 25 (1 quick, 12 full, 1 pose, 1 focus, 1 beauty, 1 re-import). Outputs in `out/bicycle/`: `model.glb` (6.2 MB, 4 nodes: frame, rear, steer, front), `model.stl` (9.1 MB), `beauty.png` at 1024.

### 2. Print readiness and re-import

Final `out/bicycle/report.md`:

| Row | Value |
| --- | --- |
| Pieces | **1** |
| Watertight | **no**: 74 edges shared by more than two triangles; clusters of 3–4 edges at tube crossings (chainstay through the stand pivot, seat stay caps, spokes leaving the hub drum). See friction 4–6 for why the reported locations are not usable and what I could and could not remove (started at 221 edges). |
| Stands | **yes**, centre of mass 0.296 inside the 16-point footprint (two tyres + two stand feet) |
| Overhangs | **11%** |
| Cavities | none |
| Volume | 0.272; 182,004 triangles at cell 0.0136 |

Re-import (`dogfood/bicycle_reimport.aix`, `import("../out/bicycle/model.glb", resolution=200)`):

| | Source | Re-imported |
| --- | --- | --- |
| Surface extent | 4.094 × 2.449 × 1.694 | 4.095 × 2.448 × 1.695 |
| Pieces | 1 | 1 |
| Stands | yes, 0.296 | yes, 0.297 |
| Overhangs | 11% | 11% |
| Volume | 0.272 | 0.255 (spokes and chain are thinned at the 0.02 sampling cell) |
| Watertight | no, 74 edges | no, 154 edges, all around the rear hub/cog |
| Materials | 8 | none (positions only, as documented) |

Every part survived: spokes, reflectors, valve, chain, cog teeth and the lightening holes are all on the re-import sheet. Sampling took 92 s in `check` and again 92 s in `render`.

### 3. Friction

1. **`bicycle.aix` line 77/78 (first version)** — `crank_r = (crank_arm + pedal_axle | paint("chrome")) + pedal | move(0, 0, 0.052 * s) | rotate(z=-20)`. `check` said: `warning: 'crankset' (line 89) joins painted and unpainted parts: a part has no material and will render as clay. '|' binds tighter than '+', so a + b | paint(m) paints only b: wrap the union in parentheses.` The warning is excellent for `paint`, but the same line's `| move | rotate` was also only applied to `pedal`, and nothing said so; I found it from `crank_l 0.88 × 0.22 × 0.53` in the size list. Expected the precedence hint to cover any modifier after `+`, not just paint.
2. **Line 129** — the steering axis is tilted 18° from vertical and `joint` only takes xyz Euler angles. No doc says how to turn about an off-axis pivot; I wrote a node script to decompose a 25° rotation about (cos 72°, sin 72°, 0) into `[8.2, 23.7, 1.72]`. It works (poses.png and `--pose turned` confirm) but the number in the program is opaque and the GLB animation would interpolate through the Euler triple, not about the axis.
3. **Line 58 (first version)** — `stem_cap ... | move(...) | rotate(z=-18)` gave `stem_cap 0.11 × 0.1 × 0.1 x 1.51..1.63` (rotated about the origin) and `warning: 'stem_cap' (line 58) is not part of the output`. Both my fault; both caught by `check`. No friction beyond the well-known rotate-then-move rule.
4. **Watertight row, every full render** — the reported locations are cluster centroids and the blame is by proximity to that centroid, so they are frequently not places on the model: `8 at (-0.963, 0.845, 0.058)` with no step names is *inside* the rear hub drum (it is the average of edges around the drum's circumference); `5 at (-0.187, 0.649, 0.072) in 'tyre', 'chainring'` names two parts that are a unit away from that point (the real graze there was the chainstay lying tangent to the stand pivot, lines 30/122); `3 at (-0.223, 0.599, -0.057) in 'tyre', 'stand_leg'` likewise. Renders 6–15 were spent decoding these by hand from the geometry. The `--focus` close-up row was the only one that gave real spots: `Close-up watertight: not watertight at cell 0.008: 7 edges at (-1.054, 0.873, 0.066) in 'spoke_r', 'hub'; ... 7 edges at (-0.231, 0.505, 0.116) in 'chainring', 'chain'`.
5. **Line 26, render 2** — `12 at (0.535, 1.162, -0.041) in 'down_tube', 'bike'` with the explanation "a feature about a cell thin". The down tube is 5 cells thick; its side at z = ±0.0408 lies on a grid plane (z planes at −0.848 + k·0.01616, k = 50 → −0.040). I changed the radius (0.017 → 0.0165) and the cluster moved to the other side (`15 at (0.538, 1.166, 0.039)`); the tyre's widest point (`15 at (-1.46, 0.247, -0.065) in 'tyre', 'rim'`, z = 0.065 = 0.027 × 2.4) did the same on render 5. Surfaces tangent to a grid plane produce non-manifold edges and the message blames thinness.
6. **Lines 41, 31, 120 (spokes, stays, stand legs)** — tubes of 1.3–1.8 cells pass `check` (threshold 1.2) but produce non-manifold edges on their own: `4 at (-1.285, 0.812, 0.03) in 'spoke_r', 'rear_wheel'` is on a lone spoke with nothing else nearby. Going to ≥ 2 cells (0.010–0.012 m × 2.4 at cell 0.0136) removed those. The docs give 1.2 cells as "survives"; the watertight threshold is nearer two and is not stated.
7. **Render 1 (`--quick`)** — `warning: The centre of mass is only 0.065 units inside the base's footprint: the model would balance, barely.` The stand feet (0.048 tall) had been dropped at the 0.063 quick cell, so the footprint was the two tyres only; the full render says `0.297 inside`. The quick pass declines to judge pieces when steps are dropped but still judges standing.
8. **Render 4 (`--pose turned`)** — `warning: The centre of mass (0.156, 1.02, -0.108) is 0.551 units outside the base's footprint: the model would tip over.` True in that pose only because the turned front tyre rises 0.03 (posed surface `y 0.03..2.27`) and leaves the footprint tolerance (`points within 0.026 of y = -0.001`). Physically right, but a rig judged as tipping in a pose where a wheel is 2 cells off the floor reads as a bug at first.
9. **Line 45, render 14** — after changing from 12 to 8 spokes a side the reflector floated: `The model is 3 separate pieces: ... volume 0 at (1.838, 1.037, 0.062) in 'spoke_r', 'reflector'`. This warning was exact and named both parts; no friction, listed for contrast with item 4.
10. **Line 117 (chain among teeth)** — a chain tube at the pitch radius, thinner than the chainring, left slivers between teeth (`'chainring', 'chain'` in the close-up row). The fix was to make the chain fat enough to swallow the teeth on the wrapped half. Not a tool bug, but there is no guidance on tubes running through thin plates.
11. **`check --pose turned`** — `front_wheel_j posed 1.69 × 1.72 × 1.2 y -0.02..1.7` is a loose turned box; only the joint step `steer` got a `surface` line. To know whether the turned wheel still touches the floor I had to read the joint's surface line, not the wheel's.
12. **Re-import** — `import ... sampling 186980 triangles at resolution 200... in 92404 ms`, run again in full by `render`. Documented, but three minutes for one probe.
13. **`hub` (line 39) is used in both wheels** — I could not tell from the docs what `--focus hub` would frame (the template at the origin, which is not in the output, or the copies); I framed `rear_wheel` instead, which worked.

### 4. What worked well

- Tubes between nested point lists with a `def` returning a list: the whole frame is geometry-by-points and no join ever floated. `ring(..., axis="z")`, `flip`, `mirror("z")` did what the reference says.
- `check` printing number steps and lists (`phi = 170`, `beta = 80.5`, the whole `chain_pts`) let me verify the chain's tangent maths without a render.
- The pieces warning (volume, point, both step names) and the "not part of the output" warning were exact every time.
- The steps sheet and poses sheet answered "is it there / does it turn about the right point" at a glance; the steering pose was right first time.
- The beauty render: chrome spokes, red paint and leather read as a product shot with nothing tuned.

### 5. Three changes, in order

1. **Make the watertight row point at real places**: report one actual edge position per cluster (or the cluster's box) and the two steps whose surfaces share that cell, and say "tangent to a grid plane" when that is what happened, rather than "a feature about a cell thin". This was the whole cost of this exercise.
2. **A joint axis**: `joint(part, name, x, y, z, axis=[ax, ay, az])` (or a pose value that is an angle about that axis), so a steering column, a slanted hinge or a tilted rotor is one number, exported as such, instead of an Euler triple computed elsewhere.
3. **State the watertight thickness and honour it**: say in the docs and in `check` that a tube or wall under about 2 cells will mesh but not be watertight (a second, softer warning), and have `--quick` skip the standing judgement when it dropped steps, as it already skips the pieces count.
