# Round 11: a dungeon door with a torch, for a game engine (`dogfood/door.aix`)

Files: `dogfood/door.aix` (the program, 145 lines), three fault probes (`dogfood/door_probe_eye.aix`, `dogfood/door_probe_pivot.aix`, `dogfood/door_probe_bracket.aix`) and this report. Commands: 12 renders (4 full with exports and beauty, 1 undecimated export, 1 focused close-up, 4 `--beauty-only` of which 2 at `--quick`, 2 quick sheets), 19 checks, 3 `fmt`, plus 4 reads of the GLB's JSON chunk with a small Node script, 6 headless-Chromium runs against `viewer.html` (10 screenshots), and 11 PIL scripts to crop the baked maps and set pictures side by side.

## 1. The finished door

A scene of three objects, each a node in the GLB. One unit is a metre (glTF's unit), front is +z, the floor is y = 0. The whole is 2.2 × 2.45 × 0.62 m.

- **`stonework`**: a stone wall 2.2 × 2.45 × 0.24 with an arched opening cut through it. Its material is a grey `brick` pattern at scale 0.25 (blocks about 0.3 × 0.15), dark mortar, bump 0.004 at 0.04, light wear on the arrises.
- **`door_set`**: the leaf. It is 1.08 wide and 2.03 tall: straight sides to y = 1.5, then a semicircular arch of radius 0.54. Its foot is 1 cm off the floor, and it stands 0.022 clear of the opening all round. It is 0.07 thick, front face at z = 0.07, recessed 0.05 behind the wall's face.
  - Six vertical planks, 0.18 wide, each painted in its own frame with its own `seed` of a weathered-oak `wood` material (`#8e6438` / `#4c2f17`, grain 0.08, rough 0.75, wear 0.3, bump 0.0015 at 0.025).
  - V-grooves 0.04 wide between the planks.
  - Iron, all one material (`rust` preset at scale 0.1, wear 0.5, bump 0.0012 at 0.012):
    - three strap hinges, 0.075 × 0.03, with diamond spear ends;
    - three hinge knuckles, 0.06 across, a cell into both the leaf and the jamb;
    - 18 domed studs on the straps and 17 clavos (two rows, and an arc under the arch, one per plank);
    - a rosette 0.13 across carrying an eye (a torus, R 0.05, tube 0.015).
  - The ring knocker (torus, R 0.09, tube 0.016) hangs through the eye. It is the child joint `knocker`: pivot (0.28, 1.27, 0.124), axis [1, 0, 0].
  - Poses: `lifted` (-75°, swung out and up) and `bounce` (-14°). The animation `knock` is rest 0 s, lifted 0.55, rest 0.7, bounce 0.8, rest 0.95 s, looping.
- **`torch`**:
  - A walnut handle 0.5 long, tapering 0.04 to 0.052, leaning 20° out from the wall.
  - A pitch-soaked head 0.092 × 0.13 (dark noise, bump 0.003 at 0.012).
  - A flame: a sphere smooth-joined to a cone and twisted 70°, 0.11 × 0.26. It glows 1.4 in a yellow-to-red noise.
  - An iron bracket: a wall plate 0.09 × 0.32 set a cell into the stone, two arms 0.028 thick out to a collar and a cup round the handle, and two bolt heads.
- **Light**: `set environment night`, `set ambient 1.3`, a faint blue moon (azimuth -50, elevation 40, power 0.35), and the torch as a point light. The torch light is at (0.85, 2.03, 0.44), just above the flame's tip, range 1.8, `#ff9a3c`, power 2.2. Three cameras: `hero` (azimuth 20, elevation 3, zoom 1.2, the one `beauty.png` uses), `iron` (on the knocker, zoom 0.4) and `torch` (on the torch, zoom 0.7).
- **Export** (`out/door/model.glb`, 8,065,120 bytes):
  - 54,996 triangles under `set triangles 55000`, decimated from 130,072. By mesh: wall 35,196, door 18,292, ring 282, torch 1,226.
  - Nodes: `stonework`, `door_set` with child `knocker` (translation = the pivot), and `torch`.
  - 11 materials sharing one 2048 atlas, with a normal map (every material with a bump), a metallic-roughness map (everything with wear or rust) and an emissive map (the flame, `KHR_materials_emissive_strength` 1.4).
  - One animation, `knock`: a 5-key LINEAR rotation channel on `knocker`; the lifted key is the quaternion [-0.609, 0, 0, 0.793], i.e. -75° about x.

The promises, all holding at the end (`check` exits 0):

| Line | Promise | Number |
| --- | --- | --- |
| 134 | the leaf is 2.03 tall | `abs(tall(leaf) - 2.03)` is 4.4e-16 < 0.005 |
| 135 | the leaf stands clear of its opening | `clearance(leaf, stonework)` 0.022 > 0.018 |
| 136 | leaf, iron and mount are one piece | `pieces(door_leaf)` 1 |
| 137 | the ring hangs a cell clear of its eye and the door | `clearance(ring, door_leaf)` 0.019 > 0.016 |
| 138 | the same, lifted | 0.019 > 0.016, `pose=lifted` |
| 139 | the eye stands round the pivot | `inside(eye, eye_disc)` 1 > 0.95 |
| 140 | the ring passes through the eye | `overlap(ring, eye_hole)` 0.0000243 > 0.00001 |
| 141 | the same, lifted | 0.0000243 > 0.00001, `pose=lifted` |
| 142 | handle, head, flame and bracket are one piece | `pieces(torch)` 1 |
| 143 | the bracket's plate is set into the wall | `overlap(plate, stonework)` 0.000454 > 0.0002 |
| 144 | the flame stands off the wall | `clearance(flame, stonework)` 0.234 > 0.2 |
| 145 | the torch is beside the door, not on it | `clearance(torch, door_set)` 0.298 > 0.2 |

**Against the plan.** The plan was the door, the iron, the knocker on a joint, and the torch on a stone wall at night. That is what was built, with these departures:

- **Fixes the renders asked for:**
  - The wall shrank from 2.4 × 2.6 to 2.2 × 2.45 to tighten the shot. I also hoped it would free triangles for the door; it did not (section 3).
  - The `oak` preset became a custom darker wood, because the preset read as new pine in the viewer.
  - The clavos in the arch moved onto the plank centres; one had sat on a groove and left open edges.
  - The gap round the leaf went from 0.012 to 0.022, and the eye from R 0.035 to R 0.05. Both had been under a cell and left seams.
  - The point light moved from in front of the flame to above its tip, so the torch's shadow falls down the wall and not up it.
- **Where it misses the brief's bar:**
  - The torch lights the door only in the beauty render. The GLB has no light (no `KHR_lights_punctual`), and `viewer.html` lights the model with its own daylight studio.
  - In the GLB the 3-cell studs and the ring are faceted, where the beauty render draws them round.
  - At this cap, dark fringes of iron colour appear on the oak beside some studs and the rosette. They are not in the full-mesh export.
- **What a game artist would also want:**
  - The six plank materials are all named `custom` in the GLB.
  - The flat wall takes 64% of the triangle budget.
  - The back of the leaf is plain planks (no battens).
  - The door itself does not swing, only the ring; the brief asked only for the ring.

## 2. Verification

**`check`, every edit.** Sizes first:

- The first `check` caught my zero-scaled clavo at the origin (`clavos ... y 0..1.95 z 0..0.085`).
- A later `check` caught the eye moved to the origin (`door_set ... y -0.065..2.04`).

Then the twelve promises above. The pose ones are judged in `lifted`, and `check` prints `in pose lifted holds`.

**The pictures, and what each showed** (final render unless said):

- `sheet.png`: the arched door in its wall, three spear-ended straps, the ring at the right, the torch on the right leaning out (the right view shows the lean towards +z and the bracket's two arms), and the top view showing the torch standing 0.4 off the wall. Title `SCENE 2.2 × 2.45 × 0.59 UNITS 129040 TRIS CELL 0.0153`.
- `steps.png`: 37 thumbnails in order:
  - `leaf_slab` is tagged MASK, and the cutters (`doorway`, `groove`, `grooves`) are tagged CUT;
  - the probes `eye_hole` and `eye_disc` are in grey frames tagged REGION;
  - the clavos show their arc under the arch;
  - the `torch` thumbnail shows the whole assembly.
- `slices.png`: planes through the first object, the wall.
  - X = 0 shows the leaf as a thin section behind the straps' bumps.
  - Y = 1.23 shows the wall either side, the six planks with their V-grooves, the ring and eye in front of the door, and the bracket's arm on the right.
  - Z = -0.023 shows the opening through the wall.
- `slices.png` from `--focus knocker` (`out/door_knocker/`): the one that proves the knocker. In the X = 0.28 section the ring's tube sits inside the eye's loop with an even gap all round, and the hanging ring's lower tube clears the door.
- `callouts.png`: from the hero camera, labels on stonework, leaf, plank, straps, strap_studs, clavos, knuckles, eye, rosette, knocker, flame, head, collar, plate, handle and cup. `door_set` is labelled on bare wood, since a union is named for the leaf's surface.
- `poses.png` and `anim_knock.png`: the whole scene, where the ring is a few pixels. The `--focus knocker` render's versions are the readable ones. Rest hangs; lifted swings the ring out nearly horizontal with its top still in the eye; bounce is a small swing. The strip runs 0, 0.14 ... 0.95 s: up over 0.55 s, then down, a small bounce, and rest.
- `turntable.png`: eight views. The back (155°, 200°) is the leaf's plain planks in the opening.
- `beauty.png` / `beauty_hero.png` (768 px): the night scene. The torch warms the upper door and the wall round it, and the lower door falls into dark. The stone's bump catches the light. The flame is yellow to orange with a darker twisted tip.
- `beauty_iron.png`: the close-up that shows the finishes. Rust patches eat into the straps, edges are rubbed lighter along the spear tips, the iron is hammered and the studs domed. The ring hangs through the eye, and the oak shows grain and a rough surface.
- `beauty_torch.png`: the bracket's collar, cup and arms. Before the light moved above the flame, this shot showed the torch throwing its shadow up the wall, which is why it moved.
- `lights.png`:
  - The moon alone is a blue-grey night.
  - The torch alone lights the top half of the door and the stone round the bracket, the ring throwing a shadow.
  - The bottom row shows what each adds. The moon's gain is ×7.9, and its frame (and the torch's) paints the flame green (section 3).
- `beauty.png` under `--environment studio` (`out/door_studio/`): the beauty in daylight, for comparison with the viewer.

**The export, checked by hand:**

- **The report's rows.**
  - Exports: `54996 triangles in the GLB, OBJ and viewer, decimated from 130072 (set triangles 55000; 0 for all of them): at most 0.00758 from the surface at a face centre, 0.495 of a cell (the full mesh 0.00758)`.
  - Maps: `normal map (model_normal.png) for stone, custom, custom, custom, custom, custom, custom, iron, handle_wood, pitch; metallic-roughness map (model_mr.png) for stone, custom ×6, iron, handle_wood; emissive map (model_emissive.png) for flame_mat`.
  - Assembly: `stonework yes 1`, `door_set no: 4 edges 1`, `torch no: 3 edges 1`.
- **The GLB's JSON chunk** (my Node script): it confirmed the nodes, the per-mesh triangle counts, the materials, the textures and the animation as listed in section 1.
  - Each of stone, oak, iron and walnut has `baseColorTexture` 0, `normalTexture` 1 and `metallicRoughnessTexture` 2 with factors 1.
  - The pitch has the normal map but a constant roughness 0.95.
  - The flame has `emissiveTexture` 3, `emissiveFactor [1,1,1]` and `KHR_materials_emissive_strength` 1.4.
  - The knocker's mesh is in its node's frame (y -0.198..0.018 below the pivot).
- **The map PNGs**, cropped at full resolution with PIL:
  - `model_normal.png` carries the oak's bump as a fine noise over every plank chart, the V-grooves as blue/pink bands, the hammered iron and the pitch head's bumps.
  - `model_mr.png` shows the oak orange (rough, not metal), darker along the plank tops where wear smooths them. The iron is magenta (metal, smooth), with yellow-orange rust patches on the strap charts. The eye and ring arcs are magenta all over (worn all over, as the docs warn of a thin ring).
  - `model_emissive.png` is black but for the flame's charts.
  - The colour atlas's plank texels average (119, 83, 46), between the two wood colours (142, 100, 56) and (76, 47, 23): the bake is faithful.
- **`viewer.html` in headless Chromium.** The CDN was reachable. The page loaded in about 10 s with no page errors (only "GPU stall due to ReadPixels" driver warnings).
  - Default view (`viewer_persp.png`): the wall, the door, the straps, the ring and a glowing flame, in a grey studio with a white key and a floor shadow.
  - A wheel-zoom on the door's middle (`viewer_closeup.png`, `viewer_zoom.png`): grain and bump on the oak, rust and hammering on the straps, bright worn edges, the ring hammered and bright.
  - The scrub bar set to 0.55 s (`viewer_lifted.png`, label `knock 0.55 / 0.95 s (paused)`): the ring swung out level. The animation plays in the viewer.
- **Viewer against `beauty.png`** (`out/compare_beauty_viewer.png`, `out/compare_studio_viewer.png`).
  - The maps carry what the brief asks: bumps, wear, rust, glow.
  - The pictures differ in the light. Night torchlight against a daylight studio; the viewer's oak at (153, 113, 78) against the atlas's (119, 83, 46). Against the studio beauty the difference is the program's own weak lights, which the beauty keeps.
  - The geometry differs at small round parts (faceted in the viewer).
  - The decimated export has fringes the full export does not. A side-by-side zoom of the 55k GLB and a `--triangles 0` GLB (`out/viewer_zoom_pair.png`) shows dark blocks beside two clavos in the first only. The MR crop shows why: magenta (iron) texels on the plank charts round each stud's foot.

**Deliberate failures** (each a probe file, `check --brief`, exit 1 each, `no warnings` each):

- `door_probe_eye.aix`, the eye's `move` lost to a comment (the slip from my log).
  - The first time, with only `overlap(ring, eye_hole)` promising the eye: **all 11 asserts passed**. My probe was built from the pivot, not from the eye, so it could not see the eye leave. That is why line 139 exists.
  - With it: `assert (line 139) fails: inside(eye, eye_disc) > 0.95 is 0 > 0.95, eye is outside eye_disc at (-0.01, -0.06, -0.01): the eye stands round the pivot (the probe above is the pivot's, so this says the eye is there)`.
- `door_probe_pivot.aix`, the joint's pivot at the ring's centre instead of its top. At rest everything holds; in the lifted pose:
  - `assert (line 138) in pose lifted fails: clearance(ring, door_leaf) > 0.016 is -0.03499 > 0.016, deepest overlap at (0.23, 1.2, 0.03): lifted, the ring still clears the eye and the door`
  - `assert (line 141) in pose lifted fails: overlap(ring, eye_hole) > 0.00001 is 0 > 0.00001, they do not meet: 0.0581 apart, closest at (0.26, 1.25, 0.1): lifted, it still turns in the eye`
  - Nothing but the pose promises noticed.
- `door_probe_bracket.aix`, the plate 3 cm off the wall: `assert (line 143) fails: overlap(plate, stonework) > 0.0002 is 0 > 0.0002, they do not meet: 0.015 apart, closest at (0.92, 1.23, 0.12): the bracket's plate is set into the wall`. `pieces(torch) == 1` still held, as it should: the bracket is still joined to the torch.

## 3. Friction

The export and the viewer:

- **The viewer cannot show the scene the program lights, and the GLB carries no light.**
  - `viewer.html` builds its own studio: `scene.background = new THREE.Color(0xe4e6ea)`, a `RoomEnvironment` for reflections, a hemisphere light and a white key from the upper left. The program's `light("torch", position=..., ...)`, the moon, `set environment night` and `set camera hero` are not used.
  - The GLB has no `KHR_lights_punctual`; its `extensionsUsed` is only `KHR_materials_emissive_strength`. So the torch lights the door in `beauty.png` only. In an engine, and in the viewer, the flame glows and lights nothing.
  - The docs never say the viewer has its own lighting. They say the GLB carries the materials "so it looks the same wherever it is loaded", which is true of the materials and not of the picture.
  - I expected either the point light in the GLB (glTF has a standard extension for it), or the viewer under the program's lights and sky.
  - Cost: the brief's comparison of viewer and beauty is a daylight studio against night torchlight, so it can judge the maps, not the look.
- **`--triangles` / `set triangles` cuts every mesh of a scene by the same share, so a flat wall keeps most of the budget.**
  - With `set triangles 55000` the render said `exports: 4 meshes in 4 nodes, 54996 triangles (decimated from 130060)`.
  - The GLB's JSON showed each mesh at about 0.42 of its own count: the stone wall (a box with an arched hole, flat everywhere) kept 37396 triangles, the door 16240, the whole torch 1078 (its flame 213) and the ring 282. A `--triangles 0` export confirmed the shares: 87848, 38868, 2552, 668 undecimated.
  - I expected an error-driven decimation to collapse the flat wall to a few hundred triangles and leave the detail where the curvature is.
  - Neither the docs nor the Exports row (`decimated from 130060 ... at most 0.00789 from the surface at a face centre`) say how the cap is shared out between objects. I found it only by reading the GLB's accessors.
  - Cost: one script against the GLB, a second full export, and a design question (shrink the wall?) that the docs cannot answer.
- **Neither the wall's grid nor its share of the cap can be set.**
  - Shrinking the wall from 2.4 × 2.6 to 2.2 × 2.45 left the mesh at 130072 triangles. `set grid` is cells along the longest side, so the cell shrank with it (0.0163 to 0.0153).
  - The docs say this ("the grid resolution is relative to the longest side"), so it is my mistake, but it leaves no lever: no per-object grid and no per-object triangle budget.
  - The flat wall still takes 35196 of the GLB's 54996 triangles, and the torch 1226.
- **At 0.42 of the mesh the decimated GLB paints iron onto the wood beside the studs, and the Exports row says it is as good as the full mesh.**
  - With `set triangles 55000` the row read `decimated from 129936 ... at most 0.00789 from the surface at a face centre, 0.486 of a cell (the full mesh 0.00789)`. The docs say the export "reads as the full one" down to about a quarter of the mesh, and the row raised no warning.
  - Screenshots of `viewer.html` zoomed on the door's middle, the 55k GLB beside a `--triangles 0` one (129936 triangles, in `out/door_full`), show dark square blocks of the iron's colour on the oak beside two of the lower clavos, which the full GLB does not have. There are also ragged dark edges along the spear tips and the rosette.
  - The metallic-roughness crop shows magenta (iron) texels on the plank charts round each stud's foot.
  - The row measures geometry only; nothing measures what the bake does at a material seam once the triangles there are merged.
  - Cost: a second full export and four viewer screenshots to pin it on the decimation.
- **The GLB's studs and ring are visibly faceted, where the beauty render draws them round.**
  - At grid 160 a 0.048 stud is three cells across. The beauty render marches the field and shows a smooth dome; the GLB, and so any engine, shows a faceted lump.
  - The docs say the beauty render "marches the field itself, primed by that mesh", which explains it. They do not warn that small round parts look better in `beauty.png` than in the export it previews.
  - Judging the export means a viewer screenshot, not the beauty render.
- **A material made in a loop cannot be named, so the GLB ships six materials called `custom`.**
  - Each plank is painted with `material(oak.color, "wood", ..., seed=i)` so the six do not share one grain. The report's Materials row and the GLB's `materials[1..6].name` all read `custom`; with the `oak` preset they read `oak*` six times.
  - The language doc says a preset with overrides "is listed ... as the preset's name with a star, `glass*`, unless it is assigned to a name, which it then takes". So I assigned it inside the loop: `oak_plank = material(..., seed=i)`, then `paint(oak_plank)`.
  - The Materials row became `stone, oak_plank, custom, custom, custom, custom, custom, ...`: only the first iteration took the name.
  - I expected `oak_plank` six times, a `name=` argument on `material()`, or the name with the seed (`oak_plank_3`). An engine user sees five anonymous materials beside one named one.
  - Cost: one quick render; reverted to the inline form.
- **The Assembly table counts each object's open edges but nothing says where they are.**
  - The report's Assembly rows read `door_set | no: 4 edges` and `torch | no: 3 edges`.
  - The Watertight row and `report.json`'s `watertight.clusters` list only the fused union's clusters (at one point a single one, `'handle' only 0.014 into 'head' there (0.9 of a cell)`). `report.json`'s `objects` entry is just `{"name": "door_set", "copies": 1}`.
  - For a scene shipped as a GLB the per-object meshes are what the engine gets, so those are the edges that matter, and they are the ones left unlocated. I expected each object's clusters (position, steps, gap) in `report.json`, the way the union's are.
  - Cost: guessing (the ring in its eye at 1.2 cells, the knuckles 1.2 cells into the leaf), and leaving it, since a few edges do not show in a viewer.

The renders and the report:

- **`--beauty-only --camera iron` is not "one shot and the sheet, nothing else".**
  - The agent guide gives `npx aixle render model.aix --beauty-only --camera hero   one shot and the sheet, nothing else: the lighting loop`.
  - `render dogfood/door.aix --quick --beauty-only --camera iron --out out/door_try` wrote `beauty.png`, `beauty_iron.png` (the same shot again) and `lights.png` (each light alone, four more marches). It took 28 s, against 8 s for the beauty itself.
  - I expected one picture for the material loop.
  - Cost: about 20 s on every material try. On a 4-CPU machine shared with another agent, that is the difference between trying three finishes and trying one.
- **`set camera hero` renders the same shot twice.**
  - The timings row says `beauty 8918, lights 10401, beauty:hero 9177`: `beauty.png` (433944 bytes) and `beauty_hero.png` (434024 bytes) are the same camera, so nine seconds of the minute went on a duplicate.
  - At 768 px each full render spent about 20 s on the duplicate.
  - I expected one of them to be skipped, or copied, when they are the same shot.
- **`lights.png` ignores `set camera hero`, but follows `--camera`.**
  - With `set camera hero` at azimuth -18, `beauty.png` and `beauty_hero.png` were from the left, as `set camera` promises, but every frame of `lights.png` was from the default view, from the right.
  - With `--camera torch` on the command line, `lights.png` was from the torch shot.
  - The docs say `set camera hero` "makes that shot the sheet's perspective view and beauty.png as well", and say nothing about `lights.png`.
  - I expected the light study to show the shot I am lighting, whichever way it was chosen. Cost: in the full renders the light frames cannot be set beside the beauty render.
- **The "what it adds" frames of `lights.png` paint the flame green or blue.**
  - In the bottom row, `MOON ADDS, ×7.9` shows the flame bright green and `TORCH ADDS` dark green, on a glowing part both lights barely touch. An earlier run's moon frame had it blue.
  - The arithmetic (lit minus unlit, brightened) explains it, but it reads as a broken material. I expected a glowing part to be left out of the difference, or drawn grey.
- **The Pieces row blames the knocker's ring on the wall and the leaf, and rounds its volume to 0.**
  - The final report reads `Pieces | 2 (the largest 0.92; then 0 at (0.28, 1.18, 0.124) in 'wall_block', 'leaf_slab')`.
  - The second piece is the ring, by design: it hangs a cell clear of its eye, in its own joint. (0.28, 1.18, 0.124) is on the ring, in front of the door, nowhere near the wall block's surface, yet the row names `wall_block` and `leaf_slab` and not `ring` or `knocker`.
  - Its volume, about 0.0003, prints as `0`. I expected `in 'ring'` (or "the joint 'knocker''s part, clear of its parent"), and a volume to two significant figures.
  - Cost: a moment's doubt whether something else had come loose. `pieces(door_leaf) == 1` and the slices settled it.
- **Clearing by "a cell or more" was not enough at 1.35 cells.**
  - The docs say: "overlap by a cell or more, or clear by a cell or more".
  - With the leaf 0.022 from its opening at cell 0.0163, the Watertight row still read `3 at (-0.338, 1.937, 0.0486) in 'leaf_slab', 'doorway' (cut: the face it cut), their surfaces 0.022 apart there (1.4 of a cell)`, 5 edges in all, round the arch. At the final cell, 0.0153 (1.44 cells), they were gone.
  - Only the fused union is affected (each object alone was watertight), so it costs nothing in the GLB, but the rule as written did not hold.
- **The report's Print and Physics sections are noise for a game asset.**
  - Without `set units` the report says `units assumed to be millimetres`, `this prints 2.6 mm tall` and `about 0.00141 g of PLA`, and the summary line opens `check first: not watertight; a wall 0.0144 mm thin`.
  - The Assembly table says the wall-mounted torch `Stands | no, 0.0512 outside`.
  - Nothing asked for a print, and a sconce is not meant to stand. I expected the Print section only with `set units`, `set bed` or `--3mf`, or a way to say "this is for an engine". `set units m` would make it a 2.45 m print instead.
  - Cost: reading past it every time.
- **Old pictures stay in an `--out` folder after a run that did not write them.**
  - `render --quick --no-poses --out out/door_try` left the folder holding `beauty.png beauty_iron.png beauty_torch.png lights.png report.json report.md sheet.png`. Several of those were from earlier `--beauty-only` runs into the same folder, and only the timestamps tell them apart.
  - I expected a run to clear what it owns, or the folder to hold only what the log's `wrote N files` line counts.

The language and `check`:

- **A comment pasted mid-line silently cut the line short, and the asserts still passed.**
  - I scripted a replacement of `eye = torus(0.035, 0.012) | rotate(z=90)` and appended a comment, which left `eye = torus(0.05, 0.015) | rotate(z=90)   # its hole clears ... | move(pivot[0], pivot[1], pivot[2])`. The `move` was now inside the comment, so the eye sat at the origin.
  - My error, but nothing said so:
    - no warning;
    - `pieces(door_leaf) == 1` still held, because the eye at the origin happens to touch the leaf's foot;
    - the two ring clearances still held, now measured against the rosette;
    - and the promise I added next, `overlap(ring, eye_hole)`, held too, because its probe was placed from the pivot, not from the eye (section 2).
  - I caught it only because the beauty caption read `SCENE 2.4 × 2.66 × 0.59` where it had read `2.6`, and `check` then showed `door_set 1.11 × 2.1 × 0.21 x -0.57..0.54 y -0.065..2.04`.
  - What would have helped: a warning for a part that lands at the origin while the rest of its union is a metre away. The fix on my side was `inside(eye, eye_disc) > 0.95`.
  - Cost: one beauty-only render on a broken model.
- **`check` prints a record's small numbers rounded to nothing.**
  - `oak_bump = {bump: 0.002, bump_scale: 0.02}` printed as `oak_bump = {bump: 0, bump_scale: 0.02}`. I expected the value I wrote, or at least `0.002`; for a moment I thought the field had not been read.
  - Bump heights and wear bands are naturally in the thousandths of a metre, so the rounding hides exactly the numbers a finish is made of. Cost: a second look, no render.
- **No conditional, so skipping one copy in a loop has no form in the docs.**
  - I wanted the row of clavos at y = 1.15 without the one the knocker hangs over. With no `if` in `docs/language.md`, I tried `scale(1 - skip)` on that copy after its `move`.
  - `check` printed `clavos 0.95 × 1.95 × 0.085 x -0.47..0.47 y 0..1.95 z 0..0.085`: the zero-scaled copy had collapsed onto the origin and stretched the box down to y = 0 and z = 0. My own mistake (a scale after a move is about the origin), but the box in `check` is what caught it.
  - Fix: each row's x positions as a list literal. Cost: one check.

## 4. What worked well

- **`check` is fast, and the box is the first test.** About 2 s for the program, 3.5 s with the `pieces()` promises. Two of my own slips (the clavo at the origin, the eye at the origin) showed first as a step's box in `check`.
- **The assert failures are exact and say where.**
  - `deepest overlap at (0.23, 1.2, 0.03)` for a wrong pivot.
  - `they do not meet: 0.015 apart, closest at (0.92, 1.23, 0.12)` for a loose bracket.
  - `eye is outside eye_disc at (-0.01, -0.06, -0.01)` for a part that wandered.
  - Pose promises (`pose=lifted`) caught the one fault the rest pose cannot show.
- **Probe regions are cheap and sorted out for me.** `eye_hole` and `eye_disc` are tagged REGION on the steps sheet, never warned about, never exported.
- **`--focus knocker` made the rig legible.** At 0.0015 cells, the pose sheet, the strip and the slices made a 0.2 m ring on a 2.4 m scene readable. The X = 0.28 slice is the proof that the ring passes through its eye.
- **The finishes are one line each and come through to the GLB.**
  - `material("rust", wear=0.5, bump=...)` gives the iron the look the brief asks for in the beauty render.
  - The maps carry it: the normal map has the bumps and groove relief, the MR map the worn edges and rust, the emissive the flame, plus `KHR_materials_emissive_strength`. The colour atlas matches the material within the pattern's range.
  - The report's Maps row says which material each map serves.
- **The GLB's structure is what an engine wants.** One node per scene object; the joint as a child node at its pivot, with its mesh in the node's frame; the animation as a single rotation channel whose key I could check by hand (-75° about x).
- **The viewer is a real tool.** It loaded headless with WebGL, and the scrub bar could be driven to an exact time (`knock 0.55 / 0.95 s (paused)`), which made a screenshot of a pose in the export possible.
- **Cameras and lights in the program.** A `focus=` camera gave the close-up of the finishes with no arithmetic, and the point light's guidance ("in the air just outside the glowing part") was right.
- **The Watertight row's gap numbers** (`their surfaces 0.012 apart there (0.7 of a cell)`, `'handle' only 0.014 into 'head' there (0.9 of a cell)`) turned each seam into one number to change.

## 5. Three changes that would have helped most

1. **Carry the program's lights into the export, and let the viewer use the program's scene.** Write each point `light()` as a `KHR_lights_punctual` point light on its own node, so the torch lights the door in an engine. Give `viewer.html` the program's environment, lights and named cameras as a choice beside its studio. Then "the GLB looks as the beauty render does" can be checked like for like. Today it can only be checked for the maps, and the torch, the reason for the night, is lost on export.
2. **Render the export itself, and judge it at its seams.** Add a picture of what ships, beside `beauty.png` and under the same lights: the decimated mesh with its baked atlas and maps. Make the Exports row measure how many texels at a material seam took the wrong material after decimation, not only how far the faces stray. That picture would have shown the faceted studs and the iron fringes on the oak at once. I needed a second export, ten headless-browser screenshots and a dozen crops to find them, and the row said `0.495 of a cell (the full mesh 0.00758)`, as good as the full mesh.
3. **Share the triangle cap by error across a scene, or let an object set its own share.** Today every mesh keeps the same share of its own count, so a flat wall kept 35196 of 54996 triangles while the torch kept 1226. An error-driven budget over all meshes would leave the flat wall a few hundred and put the rest on the studs, the ring and the flame, where the facets and the fringes are. Failing that, `set triangles stonework 2000` or a per-object grid. The Exports row should also say how the cap was shared out.
