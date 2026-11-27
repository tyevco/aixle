# Round 11: a kitchen stand mixer (`dogfood/mixer.aix`)

Files: `dogfood/mixer.aix` (149 lines), probes `dogfood/mixer_probe_bowl.aix`, `dogfood/mixer_probe_posed.aix`, `dogfood/mixer_probe_units.aix` and five deliberate-failure copies `dogfood/mixer_probe_fail_{sunk,float,gap,tilt,thin}.aix`; renders in `out/mixer/` (final), `out/mixer_tilted/`, `out/mixer_sunset/`, `out/mixer_hinge/`, `out/mixer_nose/`, `out/mixer_q/`, `out/mixer_probe_bowl/`. 16 renders (7 full-grid renders of the mixer, 3 of them with `--beauty`; 7 `--quick`; 2 of the bowl probe), 26 `check` runs (13 on the program, 13 on probes: 6 timing one assert each, 5 deliberate failures, 1 posed-step probe, 1 units probe), 3 `fmt` runs, 1 `--help`.

## 1. The finished mixer

A tilt-head stand mixer in red enamel with a steel bowl, steel trim and a white flat beater, drawn in decimetres (one unit is 10 cm), front +z. Its size from the report is 2.68 × 3.66 × 3.58 units, 26.8 cm wide with the bowl's handle, 36.6 cm tall, 35.8 cm deep, about a real Artisan's size. It is a `scene body, bowl` at `set grid 200` (cell 0.0189).

The parts, each built from a record of named sizes (`base_dims`, `plate_dims`, `column_dims`, `hinge_dims`, `head_dims`, `hub_dims`, `trim_dims`, `bowl_dims`, `lock_dims`, `beater_dims`, `tilt_deg`):

- **Base**: a 14-point `curve2` plan outline, offset in by the 0.1 rounding, extruded 0.25 and rounded back out by 0.1: 2.12 × 0.45 × 3.58, flat underneath, soft on every edge.
- **Clamp plate and lock**: a steel disc of radius 0.74 sunk 0.02 into the base, with two hooks (a post and a lip) at ±x. The bowl's two tabs rest on the plate under the lips with a 0.025 gap, so the bowl is held without being clamped into the plate.
- **Column**: a side outline (`curve2` in z/y, extruded across x and turned to face +z with `flip("z")`) intersected with a front outline (`curve2` extruded along z), offset in and rounded by 0.06. It is wide at the foot, waisted, and leans back under the head, with a low flat top under the hinge.
- **Hinge**: a pin of radius 0.05 along x at (0, 2.47, −1.45), with two column knuckles (x 0.54..0.8 each side, on webs into the column top) and one head knuckle (x ±0.5), all radius 0.11, with 0.04 between them.
- **Head**: a 10-point `curve2` profile (radius 0.66, 2.95 long) revolved about its own long axis and laid along +z. The underside is flattened at y 2.45 by `difference(..., k=0.08)`, which leaves a fillet. It has a steel band as a `decal` at z −0.95, a steel nose cap, the drive hub (radius 0.24) under the head over the bowl's axis, and a speed lever with a knob on the left side. The knuckle is blended into the head with `union(k=0.03)`.
- **Bowl**: one open `curve2(..., wall=0.05)` centre line of 9 points from the axis along the floor and up the side, plus a 5-point three-quarter curl (`curl_pt(deg)`, radius 0.055) that rolls the rim outward and leaves it open underneath, all revolved. Under it are a revolved skirt foot, the two lock tabs, and a handle that is a tube along an exact `curve()`. Its size is 2.68 × 1.75 × 2.45 with the handle.
- **Beater**: a flat paddle cut from the bowl's own geometry. `cavity` is the solid the bowl's centre line encloses (the same points closed along the axis and the rim). The paddle is `(cavity | offset(-(t/2 + gap))) & slab`, a 0.06 slab, minus windows made by a further 0.08 offset with a central spine left in, so its outline follows the inside of the bowl at exactly the 0.07 gap. A shaft of radius 0.05 runs up into the hub.
- **Rig**: `joint(head_hinged + nose + hub + lever + beater, "tilt", 0, 2.47, -1.45, axis=[1, 0, 0])`, `pose("tilted", tilt=-55)`, and `animation("tilt", ["rest", "tilted", "tilted", "rest"], times=[0, 1.2, 1.8, 3], ease=1)`. The head rises, holds 0.6 s and settles back, in a loop.
- **Presentation**: a warm key and a cool rim light, a `hero` camera (azimuth 35, elevation 18, zoom 1.15) that is also the sheet's view, an `into_bowl` camera focused on the paddle (azimuth 330, elevation 45), `set slice beater` with `set slice_y 1.3`, and `set environment studio`, chosen after `--environment studio,sunset`.

**Promises** (all 12 pass on the final `check`):

| Promise | Assert | Value |
| --- | --- | --- |
| beater clears the bowl's inside at rest | `clearance(beater, bowl) > 0.05` | 0.07 |
| the paddle hangs inside the bowl | `inside(paddle, cavity) > 0.99` | 1 |
| nothing of the bowl pokes into its own inside | `void(cavity \| offset(-bowl_dims.t / 2 - 0.01), bowl)` | holds |
| tilted, the head and beater clear the bowl | `clearance(head, bowl) > 0.1, pose=tilted` | 0.5912 |
| bowl not sunk into the base | `overlap(bowl, base + plate + hooks) < 0.0002` | 0 |
| bowl rests on the plate, not floating | `clearance(bowl, plate) < 0.01` | −2.1e-17 (touching) |
| the head's back swings clear of the column | `clearance(head_shell, column) > 0.02, pose=tilted` | 0.04847 |
| the head clears the column's knuckles, at rest and tilted | `clearance(head_shell, column_knuckles) > 0.02` (twice) | 0.0751, 0.0751 |
| the head's knuckle turns free | `clearance(head_hinged, column + column_knuckles) > 0.015` | 0.04 |
| the hooks hold the tabs without touching | `clearance(bowl, hooks) > 0.015` | 0.025 |
| the bowl's wall is at least 4 mm | `wall(bowl, 96) > 0.04` | 0.045 (a 0.05 band, read at a 0.025 cell) |

**Against the plan.** The plan (sizes in dm, front +z, bowl on the axis at z 0.45, hinge at the column's back top, a tilt of −55 so the beater lifts clear) held. The head's back swing ended at 0.048 from the column, and the beater's lowest point tilted is at y 3.03, 0.77 above the rim. Departures:

- The head came out too tall and round at radius 0.72. I took it to 0.66 and flattened the underside.
- The hinge was redesigned twice. First the pivot came down from 2.55 to 2.47 and the column's top was lowered to 2.31 under it. Then the knuckles were widened from ±0.28/0.62 to ±0.5/0.8, because the column's knuckles were sunk 0.011 to 0.018 into the head's side, which the watertight row found and no promise of mine had covered.
- The rolled rim began as a tight curl whose hole was under a cell. It became an open three-quarter turn of radius 0.055.
- The trim began as chrome and became steel after the sky comparison.
- The beater hangs on the bowl's axis. A real planetary beater is off-centre and orbits; mine does neither.
- The paddle's edges are square.
- The 5 mm wall is about five times a real bowl's, chosen for 2.6 cells at the grid.
- The lock is tabs under hooks, with no twist.
- The fused scene's mesh keeps one open edge at the head knuckle (F12). Each object on its own is watertight.

## 2. Verification

**Asserts.** The 12 above, judged on every `check` and render. Their numbers are printed every time, which is how I caught a regression that never failed. After I added the bowl's handle, `clearance(beater, bowl)` went from `0.07` to `0.05206 > 0.05`, still passing. 0.07 is the gap by construction, so something was nearer: the handle's lower end cap reached 0.015 through the inner wall. I moved the ends out and added the `void(cavity | offset(...), bowl)` promise so it would fail next time.

**Deliberate failures** (copies of the program with one change, `check --brief`; every one failed with the numbers and a place):

- Bowl sunk 0.02 (`mixer_probe_fail_sunk.aix`): `assert (line 140) fails: overlap(bowl, base + plate + hooks) < 0.0002 is 0.004181 < 0.0002, they overlap at (-0.61, 0.5, 0.39): the bowl sits on the plate, not sunk into it`.
- Bowl raised 0.03 (`..._float.aix`): `assert (line 141) fails: clearance(bowl, plate) < 0.01 is 0.03 < 0.01, closest at (-0.55, 0.54, 0.45): the bowl rests on the plate, not floating above it`, and with it `assert (line 146) fails: clearance(bowl, hooks) > 0.015 is -0.005 > 0.015, deepest overlap at (-0.62, 0.58, 0.38)`, because the raised tabs hit the lips.
- Beater gap 0.01 (`..._gap.aix`): `assert (line 136) fails: clearance(beater, bowl) > 0.05 is 0.01 > 0.05, closest at (-0.18, 0.71, 0.42)`, the paddle's bottom against the floor.
- Tilt only −12 (`..._tilt.aix`): `assert (line 139) in pose tilted fails: clearance(head, bowl) > 0.1 is 0.08947 > 0.1, closest at (-1.04, 2.12, 0.66)`, the paddle's top corner at the rim.
- Wall 0.03 (`..._thin.aix`): `assert (line 147) fails: wall(bowl, 96) > 0.04 is 0.02998 > 0.04, thinnest at (0.04, 1.82, -0.63) in 'bowl'` (F7).

**Pictures, final render (`out/mixer/`):**

- `sheet.png`: all four views match the plan. In the front view the hooks and tabs show under the bowl, the knuckles sit behind the head and the lever is on the left. In the right view the head's flat underside sits over the rim, the column waists, the band is on the head and the handle is seen end-on. In the top view the paddle shows as a line across the bowl and the handle sticks out at +x. There are also two 2-pixel dark dashes on the bowl's inner wall just in front of the nose that I could not explain. A `--focus nose` close-up showed the cap clean.
- `slices.png` (through the beater, `slice_y` 1.3): this is the picture the brief asked for.
  - X = 0 has the paddle edge-on, hanging from the hub through the bowl's section down to just above the floor, with the rolled rim curling outward on both sides.
  - Y = 1.3 has the three bars of the frame (two sides and the spine) as small rectangles inside the bowl's ring at an even gap.
  - Z = 0.45 has the paddle face-on, its outline running parallel to the inner wall all the way round, the shaft up into the hub, and the tabs under the hooks on the plate.
- `steps.png` (31 thumbnails): each step is what it should be. The windows cut reads as two half-bowls, the paddle as a frame with a spine, and `head_hinged` shows the knuckle under the head.
- `callouts.png`: 20 of 21 steps named and placed right, except `SLAB` on the plate (F9).
- `poses.png` and `anim_tilt.png`: the head swings up about the pin and back. Over the 8 frames (0 to 3 s) the beater rises out of the bowl, holds at 1.29 s and 1.71 s, and returns. The bowl's thin wall is a sieve at the strip's coarse cell, as expected.
- `turntable.png`: 8 views. The back of the column and the hinge read as built, and the lever shows at 260 to 305 degrees.
- `environments.png` (studio | sunset, one run): see the choice below.
- `beauty.png` / `beauty_hero.png` (the same shot, F6): the red enamel reads, the bowl is steel with the base reflected pink in its lower wall, and the paddle's top bar shows inside the bowl.
- `beauty_into_bowl.png`: the shot over the front-left rim, under the head, shows the paddle's top bar, the spine and one side bar curving down against the wall.
- `lights.png`: the key does the work; the rim (×3.5) edges the head and column from behind.
- `report.md`: Pieces 1, stands (centre of mass 1.012 inside the footprint), Asserts 12 pass. In the Assembly rows the body and the bowl are each `Watertight yes`; the fused scene has 1 edge. Cavities: `volume 0.112 at (0, 0.581, 0.45)` is the air under the bowl's floor inside its foot ring, sealed by the plate, which is true of the real thing.

**Other renders:**

- `out/mixer_tilted/` (`--pose tilted`): the sheet at full size shows the head about 55 degrees up and the beater 0.77 above the rim. Its slices cut the paddle edge-on in the air (F11 for its coarser cell).
- `out/mixer_hinge/` (`--focus head_knuckle`): the knuckle and pin in context.
- `out/mixer_probe_bowl/`: found the curl's sample-plane seam (F4).
- `out/mixer_sunset/`: all shots under sunset, and the camera warning that aimed `into_bowl` (F5).

**The sky.** I chose studio, set in the program. Under studio the enamel is its own red, the steel bowl and trim read as pale steel, and the silhouette stands clear of the backdrop. Under sunset the bowl goes grey-violet with a blue rim, the warm brown ground and backdrop take the contrast from the red base and the column's shadow side, and only the trim reads better. The chrome trim I started with was a white disc under studio, as the docs warn, so I made the trim steel rather than move to sunset.

**`aixle fmt`.** `fmt dogfood/mixer.aix --check` exited 0 with no output, and `fmt --write` left the file byte-identical (`cmp` against a copy). Nothing changed, because I had written it in the layout the docs show. It also leaves 21 lines over 100 characters, the longest 212 (the column knuckles' web), since fmt by design never splits a line. I keep the result, there being nothing to reject, but I would rather it had offered to break those lines.

## 3. Friction

In the order they happened. Each has the command or line, the message, what I expected and what it cost.

### F1. A joint's `surface` line leaves out a thin plate inside it (first `check`)

`npx tsx src/cli.ts check dogfood/mixer.aix` printed, for the head joint that carries the beater:

```
head               2.18 × 3.19 × 3.04   x -1.09..1.09  y 0.67..3.86  z -1.64..1.4
  surface          1.42 × 1.61 × 3.04   x -0.71..0.71  y 2.25..3.86  z -1.64..1.4
```

The `surface` line is meant to be "the true extent" (SKILL.md: "A `surface` line under a step is the true extent of a turned box"), but the beater's paddle (0.06 thick in z, 2.18 wide, reaching down to y 0.77) is inside `head` and the surface line says the head ends at y 2.25 and x ±0.71: it is the head without its beater. language.md does say, further down, that the rays "can slip between" a plate thinner than their spacing, so it is documented, but the line itself gives no hint it may be short, and a reader trusting "true extent" would conclude the beater is gone. Expected: either the beater included, or a mark on the line that a thin part may be missing. Cost: a minute of doubt; I knew from the box line above it that the beater was there.

### F2. `--quick` took 20 s, not "a second or two": the asserts run at full cost in the quick pass

`npx tsx src/cli.ts render dogfood/mixer.aix --quick` took `real 0m20.316s`; the same with `--no-asserts --no-poses` took `real 0m2.299s` (mesh 1014 ms). Timing each assert alone in a probe copy: five of them cost under 0.1 s each, `assert wall(bowl) > 0.04` cost 5.3 s in `check` (6.19 s against 0.88 s). `wall(shape)` with no resolution meshes the shape "at the program's `set grid`" on *the shape's own longest side*, so with `set grid 200` the 2.4-wide bowl is meshed at a 0.012 cell, finer than the whole mixer is ever meshed (0.019). The skill says "`--quick` while iterating (the sheet in a second or two)"; nothing says the quick pass still evaluates every promise at the program's full grid, or that a `wall()` on a part is finer than the model's own mesh. `--no-asserts` is documented only "for a big rig's loop". Expected: the quick pass to skip or coarsen the promises (it already drops the strips), or the docs to say a quick render pays for every assert. Fixed by giving the wall its own resolution, `wall(bowl, 96)` (a 0.025 cell, two across the 0.05 wall), and by `--no-asserts` while placing. Cost: about 3 minutes and four timed runs.

### F3. The quick sheet's list of dropped steps leaves out the bowl's wall, which is visibly broken on it

After the bowl got its handle, tabs and a bigger rolled rim, `render --quick` said: `warning: quick pass: 5 steps are thinner than this pass's 0.0591 cell and may be missing or broken on this sheet (hook_post, hook_lip, slab, paddle_outer, paddle)`. The bowl's wall is 0.05 thick (0.85 of that cell) and the quick sheet draws it as a speckled sieve, but `bowl_wall` is not in the list. The first quick render of the same wall (before the rim was rolled into a three-quarter curl) did list it: `4 steps ... (bowl_wall, slab, paddle_outer, paddle)`. I guess the curl, where the band doubles back on itself, now counts as the wall's thickness. Expected: a band revolved from `curve2(..., wall=0.05)` to be named whenever 0.05 is under the cell, as language.md promises ("A closed outline carries its thinnest wall ... for the thin-part warning"). Cost: nothing, because I knew the wall was thin; a reader who did not would take the sieve for a modelling fault.

### F4. The Assembly row says the bowl alone has 17 open edges, and nothing anywhere says where

Full render, `report.md`, Assembly: `| bowl | no: 17 edges | 1 | yes, 0.547 inside | 10% |`. The Watertight row above it (the fused scene) lists 3 edges, all between `head_round` and `column_knuckles`, none in the bowl. `report.json` has `watertight.clusters` for the fused mesh only; `objects` is just `[{"name": "body", "copies": 1}, {"name": "bowl", "copies": 1}]`. language.md: "A scene's report has, under Assembly, a row per object ... watertight, pieces, stands, overhangs" and, for the whole model, "the report prints the three largest clusters of open edges, and `report.json` lists every one under `watertight.clusters` (its position, its edge count and the steps whose surfaces pass there)". Expected the same for an object's row, since the object's own mesh is the one a GLB node carries. I had to guess (the handle's end caps and the foot tabs each stop about 0.005 short of the wall's inner face) and render again to find out. Cost: one full render (97 s) spent on a guess.

   Follow-up: I found the bowl's edges by copying the bowl's lines into `dogfood/mixer_probe_bowl.aix` with `show bowl` and `set grid 142` (the bowl's 2.68 longest side over the scene's 0.0189 cell, so the lattice matched). It reproduced them, 16 edges, and this time placed them: `all on the plane y = 2.205` in `bowl_wall` alone, which is the top of the rolled rim's hole (a horizontal tangent of the curl lying on a sample plane), not the handle or the tabs I had guessed and moved. Raising the rim by half a cell (`rim_h` 1.64 to 1.65) made the probe `Watertight | yes`. So the tool knew where they were; the scene report just does not pass it on for an object. Total cost: one wasted full render, one probe file, two probe renders.

### F5. A focused camera on a part inside a bowl under a head: the hidden-fraction warning is good, but only arrives after the 2 m 45 s render

`camera("into_bowl", focus="paddle", azimuth=60, elevation=45, zoom=1)` under `render --beauty-only --environment sunset`: after the run, `warning: camera "into_bowl" (line 131): 64% of paddle is hidden behind the rest of the model from azimuth 60, elevation 45; from azimuth 330 it is 41%`. The warning is exactly what I needed (and it was right: the shot shows the shaft and a corner of the frame). But it is computed by the render, so finding a usable angle costs a beauty run per guess (this one 2 m 45 s with the sheet, the lights strip and both shots). `check` lists the cameras but says nothing about what they see. Expected: the same hidden-fraction test in `check` (it is a few rays, not a picture), or a `--camera NAME --quick` path that only answers the question. My first try (`focus="bowl", azimuth=20, elevation=62`) showed the top of the head and almost none of the beater, with no warning, because the bowl itself was visible. Cost: two beauty runs to aim one camera.

### F6. With `set camera hero`, `beauty.png` and `beauty_hero.png` are the same shot, rendered twice

language.md: "`set camera hero` makes that shot the sheet's perspective view and `beauty.png` as well". The render then writes both `beauty.png` and `beauty_hero.png`, and renders each: the full render's timings were `beauty 21102, ... beauty:hero 20735`, and in a `--quick --beauty` pass `beauty 8496, lights 9802, beauty:hero 8159`. Reading the two files, they are the same picture with a different caption (`SCENE 2.68 × 3.66 × 3.58` against `SCENE, CAMERA HERO 2.68 × 3.66 × 3.58`). Expected: one render written twice, or `beauty.png` alone. Cost: about 21 s of every full beauty run on a shared 4-CPU machine. Related: the skill's "`--quick --beauty` is a few seconds" was 30 s here (`real 0m30.452s`), because two lights add `lights.png` (9.8 s) and the hero shot is drawn twice.

### F7. A failing `wall()` names the step the assert was given, not the part with the thin wall

Deliberate failure, `bowl_dims.t` 0.05 to 0.03 (`dogfood/mixer_probe_fail_thin.aix`): `assert (line 147) fails: wall(bowl, 96) > 0.04 is 0.02998 > 0.04, thinnest at (0.04, 1.82, -0.63) in 'bowl': the bowl's wall is at least 4 mm`. The point is right (the back of the wall), but "in 'bowl'" is just the argument back; the report's Thinnest wall row names the innermost steps on both sides (`in 'bowl_foot', 'plate', through to ...`), and the docs say a failing `wall` says "in which step". `bowl_wall` would have been the useful name. Also, `check` printed `no warnings` for a 0.03 wall at a 0.0189 cell (1.6 cells), which language.md puts in the "meshes but often not watertight" band; the earlier note `Parts between 1.2 and 2 cells thick mesh but often not watertight` appeared without `--brief` at grid 128, so `--brief` may be hiding it, which is fair, but it is the mode the docs suggest for "a promise loop". Cost: none, a note.

### F8. `check --pose tilted` prints no `posed` line for a step that was assigned twice

`head_shell` is assigned on two lines (`head_shell = difference(...) | paint(enamel)`, then `head_shell = decal(head_shell, ..., trim)` for the chrome band). `npx tsx src/cli.ts check dogfood/mixer.aix --pose tilted` printed `posed` lines for `head_hinged`, `nose`, `hub`, `lever`, `paddle`, `shaft` and `beater`, but under `head_shell` only its rest box and `surface` line. The asserts do measure it posed (probe `dogfood/mixer_probe_posed.aix`: `top(head_shell)` is `3.66` at rest and `5.43` with `pose=tilted`), so only the printout misses it. Expected a `posed head_shell` line like its neighbours'. Cost: a probe to make sure my pose promise on `head_shell` was not being judged at rest.

### F9. `callouts.png` puts the label `SLAB` on the clamp plate, where no slab shows

Every full render labelled `SLAB` somewhere: the first time near the bowl's handle, in the final render at the clamp plate's rim beside the right-hand hook (enlarged crop: the leader ends on the plate's top, by the bowl's foot). `slab` is `box(3, beater_dims.top, beater_dims.thick)`, the 0.06-thick operand of `paddle_outer = (cavity | offset(-inset)) & slab`: its only visible faces are the paddle's two flat faces, inside the bowl. It runs from y 0 to 1.95 at z 0.42..0.48, so it passes through the plate and the hook inside its own box, and I guess a plate-top point within a cell or so of the slab's face counts as the slab's surface. agent-guide.md says a callout names "the innermost part whose surface it is" and that "the larger operand of an `&` ... is a *mask*, tagged so and never labelled"; here the slab is the smaller operand, so it is labelled, but on a surface that is not its own. Expected: `PLATE` or `HOOK_POST` there, or `SLAB` on the paddle. Cost: two enlarged crops to make sure the plate was not part of the beater; I would otherwise have trimmed the slab's height to the paddle's span to keep it out of the plate.

### F10. The mixer is drawn in decimetres, as the docs' "1 to 20 units" advice led me to, and the tool cannot be told so

The skill: "Pick a unit and keep the whole model within about 1 to 20 units". A stand mixer is 36 cm deep, so centimetres would be 36 units; I chose a decimetre (the program's first comment says so). The report then has a Print section I did not ask for that reads `Units | not set: a slicer reads a unit as a millimetre, so this prints 3.66 mm tall` and a Summary `check first: not watertight; a wall 0.0438 mm thin`. To say what a unit is I tried a probe (`dogfood/mixer_probe_units.aix`): `warning: set units dm: no such unit; a unit can be mm, cm, m, in (millimetres are assumed when units are not set)`. Expected `dm` to be accepted, or the docs' range advice to say that a print's unit must be one of the four, or a way to say "not a print" so a kitchen appliance is not reported as a 3.66 mm part. Cost: a probe; the Print section stays wrong in the final report.

### F11. Rendering the tilted pose meshes the whole mixer a third coarser, at the same `set grid 200`

`render dogfood/mixer.aix --pose tilted ... --out out/mixer_tilted`: `mesh: 231964 triangles, cell 0.0275`, against `cell 0.0189` at rest. The title says the posed scene is `2.68 × 5.22 × 4.21`, and 0.0275 × 200 = 5.5, which is the top of the tilted joint's loose box (`check --pose tilted`: `head ... y 1.27..5.5`), not the 5.22 surface. So the bowl's 0.05 wall, which nothing in the pose moves, drops from 2.6 cells to 1.8, and the posed report reads `Watertight (in pose tilted ...) | no: 31 edges` and a `Thinnest wall | 0.0113 ... 0.4 cells` at the bowl's foot, where the rest render was clean. language.md says to judge a pose "at full size with `set pose`", which suggests the same quality as the rest render; it is not, and nothing says the cell follows the posed box. Expected: the rest pose's cell kept for a pose render (or the title bar to say the cell changed and why). Fix available: `--grid 280` for the pose render. Cost: a moment's alarm at 31 edges in a part the pose does not touch.

### F12. The documented cure for a shallow-angle seam, `union(..., k=)`, did not clear the last edge in the scene mesh

The head's hinge knuckle (a cylinder along x) grazes the head's curved side where its top line meets it. Report: `1 at (-0.448, 2.569, -1.397) in 'column_knuckles', 'head_round', 'head_round' only 0.00691 into 'column_knuckles' there (0.4 of a cell)`, then, once the knuckles were moved, `in 'head_round', 'head_knuckle', 'head_round' only 0.00526 into 'head_knuckle'`. language.md: "blend them with `union(k=)`, which also seals the void a tangency leaves". I blended, `head_hinged = union(head_shell, head_knuckle, k=0.03)`: the body object's own row went from `no: 4 edges` to `yes`, but the fused scene still reads `no: 1 edge ... at (-0.455, 2.573, -1.394) in 'head_round', 'head_knuckle', 'head_round' only 0.000825 into 'head_knuckle' there (0.0 of a cell)`. One edge of mesher noise in the union of two objects that are each watertight; I left it. The report names `head_round` and `head_knuckle`, the steps under the blend, not `head_hinged`, so it reads as if the blend were not there. Cost: one render and a line of code that fixed the half of the problem I could not see.

## 4. What worked well

- **`curve2(..., wall=)` revolved is a bowl in one line.** The centre line from the axis, a curl appended from a small `def curl_pt(deg)`, and the band came out with a flat floor, a thin even wall and a rolled rim. Points as lists joined with `+` made the curl a parametric addition.
- **Deriving the beater from the bowl.** The same point list closed along the axis gave the cavity. `offset(-(t/2 + gap)) & slab` then gave a paddle whose edge is the bowl's inside at exactly the gap, so `clearance` read 0.07, the number I wrote, and `inside(paddle, cavity)` read 1. The Z = 0.45 slice shows it.
- **`joint(..., axis=[1, 0, 0])` with a one-number pose.** language.md's sign rule ("a lid on a back hinge along +x with its front at +z opens with a negative angle") was right first time.
- **Promises in a pose are measured where the pose puts the step**, including a step two levels inside the joint. Every failure names a point I could find on the sheet.
- **`set slice beater` with `set slice_y 1.3`** put the three planes exactly where the brief wanted them, the beater's cut bold and the rest faint.
- **The watertight row's diagnoses were exact and came with a number.** `all on the plane y = 2.205 ... move the part by half a cell (0.00945) along y` fixed the rim in one edit. `'column_knuckles' only 0.0166 into 'head_round' there (0.9 of a cell)` found a clash between moving and fixed parts that none of my promises covered.
- **`--environment studio,sunset`** gave the comparison in one run, and the camera's hidden-fraction warning named an azimuth (330) that worked.
- **`extrude(p, h, "x") | flip("z")`** for a side profile, as documented, and `difference(a, b, k=)` for a filleted flat, each right the first time.
- **`check` in under a second** without the `wall()` promise, with every record printed as written, so the program reads as its sizes.

## 5. Three changes that would have helped most

1. **Locate an object's open edges.** In a scene, give each Assembly row the same clusters the Watertight row has (place, count, steps, gap), in `report.md` and in `report.json` under the object. That is the mesh the GLB carries. `bowl | no: 17 edges` with no place cost me a full render on a wrong guess, a probe file and two probe renders, to learn what the tool had already computed.
2. **Keep the quick loop quick.** `--quick` should not evaluate every promise at full cost, or should say it is doing so. `wall(part)` without a resolution should default to the model's cell, not the program's grid count laid across the part's own longest side. One `wall(bowl)` turned a 2.3 s quick render into 20 s and every `check` into 6 s.
3. **Aim and render cameras cheaply.** Run the camera's hidden-fraction test in `check`, which already lists the cameras; aiming one camera cost two beauty runs of 2 to 4 minutes. Render a `set camera` shot once, not as both `beauty.png` and `beauty_<name>.png` (21 s twice per full run).

