# Hydraulic excavator, again: the agent's report

Round 3: the round-2 brief re-run by a fresh agent against the tool as
fixed after round 2, with three additions: use at least one new feature,
ship a GLB, and verify it by a viewer screenshot and a re-import round
trip. The agent was forbidden to read the earlier attempt. Thirteen
renders of the excavator plus one re-import.

What follows is the agent's report, verbatim. The "fixed" notes in the
index (`dogfood/README.md`) say what changed in the tool because of it.
`excavator_reimport_probe.aix` is the round-trip program.

## 1. The model

A tracked excavator, 2.6 × 4.9 × 6.6 units at rest and 8.5 long in the reach pose: two rounded tread-striped tracks and a frame, an iron slew ring, a yellow house (joint `cab` about y) with a decal-glazed cab, hood, stack, hazard-striped counterweight and an "AIXLE" serif nameplate; a bowed boom (a `rect` swept along a `bezier`), a stick and a hollow charcoal bucket with four teeth (joints `boom`, `stick`, `bucket` about x). Six more joints are the hydraulic cylinders: each black barrel is a joint pinned to the parent member and each chrome rod a joint pinned to the child, and one `def epose(name, yaw, b, s, k)` computes with `atan`/`sin`/`cos` how far barrel and rod must swing for the given member angles and emits the `pose(...)` — so every cylinder stays pin-to-pin and telescopes in `rest`, `transport`, `reach`, `dig`, and in `animation("cycle", ...)`. The report says Stands: yes and Pieces: 1 in every pose. It matches the plan except that twin boom cylinders share one joint each (rotation about x makes the pivot's x irrelevant) and the bucket has no link-rod. Features used and how they behaved: `bezier` + `sweep` (worked exactly as described, the boom is visibly bowed); `decal` for windows and the nameplate (worked, no geometry added, crisp in the atlas and the beauty render); `text(face="serif")` (readable at size 0.32, weight 0.08); `material(..., "stripes", axis="x"|"z")` (stripes ran the way the doc says); `set light_azimuth`/`light_elevation` (moved the key light as documented).

## 2. Friction log

- **Nested joint angles are relative to the parent, and the docs never say so.** Lines 130–132 (`epose("reach", 0, 35, -45, -30)` originally). I expected `stick=[-45,0,0]` to put the stick at world elevation −60+45 = −15°; the render showed it at −50° (−60 −35 +45) and the bucket cut through the floor, giving "The centre of mass (0.03, 1.449, 0.262) is 4.975 units outside the base's footprint: the model would tip over" — the footprint had moved to the buried bucket. Nothing in `language.md`/`agent-guide.md` states that a child's angle composes with its parent's; I recomputed every pose as relative angles (the comment on line 120 is what the doc should say).
- **`check --pose` sizes are useless for placing a posed part.** `boom` in reach printed `y -2.47..6.22 z -0.11..8.72` (an 8.7 × 8.8 box for a 3-unit member) and `bucket` `y 0.84..3.86 z 2.62..5.37`, centred near its *rest* position. The guide says "`check --pose name` prints the posed sizes" as the way to judge a pose; I had to measure pixels against the sheet grid instead. Only the report's "Surface extent" row is trustworthy in a pose.
- **The program has no way to read the current pose's angles.** `language.md` says a hydraulic cylinder is "a `tube(r, [a, b])` whose end points you work out from the pose's angles with `sin` and `cos`, rebuilt for every pose" — but no builtin exposes the angles, so that sentence cannot be followed literally. I worked around it by making barrels and rods joints of their own (lines 91, 98–99, 111–114) and a `def` that emits `pose()` with derived angles (line 121). It works, but it doubles the joint count and needs the relative-angle rule above.
- **`check` prints `E3 = -100` as `E3 = -1`** (line 23). Every integer ending in 0 loses its zeros (a trailing-zero strip run on an integer). Harmless here but it would mislead anyone reading computed numbers.
- **"Separate pieces" attribution names the wrong steps.** "loose piece is volume 3.859 at (0, 0.432, 0) in 'bucket_lug', 'bucket_shell'": the loose piece was the undercarriage; the bucket steps were named because their *pre-transform* bounds (built at the origin, then rotated and moved on line 90) contain that point. The real cause was the frame top at y 0.775 vs the slew bottom at 0.79 (line 66–67), which only a hand calculation found. In posed renders the "Watertight" row likewise names `'house', 'excavator'` — whole assemblies.
- **Coincident and near-coincident faces cost three iterations.** Bosses 0.01–0.03 apart from the surfaces they sit on (boom boss vs beam corner, stick boss vs boom boss, rod eye vs lug top, teeth flush with the bucket floor) gave 16–41 non-manifold edges; the guide says coincident faces are "fine for the geometry". 14 remain at rest (`stick_beam`, `boom_beam`, `boom_bosses`) that I could not locate.
- **Quick renders hide the cylinders.** `--quick` warned that `plate, teeth, bucket_rod_j, boom_pin` are under its 0.10 cell, so the very parts I needed to check could only be judged at the 30-second full render.
- **Time:** full render ~32 s (mesh 4 s, hierarchy/atlas 3.8 s, poses 5.7 s, anim strip 10 s, steps 3 s); a full `--pose` render with `--no-poses --no-export` ~10 s; the 1024 beauty 16 s; the re-import 10 s just to sample the GLB.
- **Two shell refusals:** a `for p in ...; do npx tsx ... $p` loop was refused by the sandbox ("cannot be shown not to be git"); ran the three pose renders as separate commands.
- **Sweep profile orientation is ambiguous for a vertical-plane path** (line 107): "its x runs across the path, its y up" does not say what "up" is when the path lies in y/z; the boom came out 0.5 wide and 0.62 tall, which was what I wanted, but by luck.
- **Doc gap:** whether two joints may share a name, and whether `pose()` keyword arguments may come from `def` parameters (they can; line 121 works).

## 3. Export verification

- **Viewer:** `model.glb` (6.1 MB, 11 meshes in 11 nodes, 199 512 triangles, 1024 px atlas) and `viewer.html` were written. The screenshot shows only the page chrome ("excavator 2.60 × 4.91 × 6.56 units · 199512 triangles", view buttons, a "▶ cycle" button — so the animation is wired) over a blank canvas; WebGL was available. A second attempt with a 30 s wait reported `net::ERR_CONNECTION_RESET` and "Failed to fetch dynamically imported module: https://cdn.jsdelivr.net/npm/three@0.160.0/build/three.module.js" — the headless browser cannot reach the three.js CDN from this sandbox (curl through the proxy can), so the page could not be verified visually.
- **Re-import** (`m = import("../out/excavator/model.glb")`): 2.601 × 4.915 × 6.522 vs the original 2.6 × 4.914 × 6.555 (identical to 0.03); 77 520 triangles vs 160 408 (import samples at cell 0.068 by default, then meshes at 0.051). The sheet shows the same machine in one clay colour, at rest, with softened edges; the 0.06-radius cylinder rods and boom pin are broken into beads or missing, the teeth are blobs, the nameplate is gone (it was a decal); 416 non-manifold edges, "3 pieces" with two specks.

## 4. What worked well

`check` in one second with every step's box and computed number; the sheet's four views with unit grids; `steps.png` with the pose-independent thumbnails; the pose strip and animation strip for a first look; `--pose` + `--out` for posed full sheets; `report.md`'s Physics section (it caught the buried bucket honestly); `decal`, `bezier` sweeps, serif `text`, `material(axis=)` and the light settings all did exactly what the reference says; the `def`-emits-`pose()` pattern; the beauty render is presentable straight away.

## 5. Three changes that would have helped most

1. Document (in the Rigs sections and the `joint`/`pose` reference) that a nested joint's angles are relative to its parent, with the hydraulic-cylinder pattern spelt out — either a builtin such as `angle("stick")` so `tube(r, [a, b])` can really be rebuilt from the pose, or the two-joint barrel/rod recipe.
2. Make `check --pose` print posed bounds that mean something (the rotated part's real box, or the posed pivot and tip of each joint), and print the posed pin positions in the report's Assembly row, so pivots can be verified numerically instead of by pixel-counting.
3. Attribute "separate pieces" and "watertight" edges by the step's *final* placement (and, for pieces, name the nearest gap: "frame top 0.775 to slew bottom 0.79"), and fix the number printer that turns −100 into −1.
