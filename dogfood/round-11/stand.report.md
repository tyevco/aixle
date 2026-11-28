# Round 11: a phone stand (`dogfood/stand.aix`)

Files: `dogfood/stand.aix` (the program, 117 lines, 10 asserts), `dogfood/stand_probe_phone.aix` (a probe: the program copied up to its `show`, with the phone and the cable drawn as scene objects), and this report. 10 renders (2 quick; 8 at the full grid: 3 of the model, 2 `--focus` close-ups, 1 of the probe scene, 2 of scratch copies), 23 `check` runs (9 on the program and the probe, 14 on scratch copies for the deliberate failures and to split the support estimate), 4 `fmt` runs, 4 read-backs of `model.3mf` and `model.stl` with Node scripts, 1 crop of a sheet.

## 1. The finished stand

A desk stand for a phone, printed in PLA standing on its base as modelled; no reorientation is needed. It measures **70 × 95 × 116.8 mm** (width x, depth z, height y) and fits the declared 220 × 220 × 250 mm bed. Units and bed are set in the program (`set units mm`, `set bed 220 220 250`), at `set grid 200` (cell 0.584 mm). It is 132.2 cm³, which the report puts at 163.9 g of PLA at full infill.

**How it is made.** One side profile in the y/z plane, extruded 70 wide along x (`extrude(side, 70, "x") | flip("z")`, as language.md prescribes for a side profile drawn with its front on the right). The profile is a `curve2` of 46 points. Doubled points make corners where the shape must be sharp: the two feet on the bed, the cradle's two corners, and the ends of every straight run. Evenly spaced points make the arcs: the lip's round top (r 3), the support's round top (r 3), the fillet where the support's back meets the base (tangent 8 mm along each, r 5.1, through 115 degrees) and the rounded top of the back end (r 4). Every point is written in a lean frame, `lean(t, s)`: t runs up the 65-degree support face and s across it, measured from the cradle's back corner q at (z 8.5, y 38). The outline therefore reads as the design does, and no point was worked out by hand.

**Parts.**
- Base plate: 6 mm thick, 95 mm deep (z -50 to 45), on y = 0.
- A slab leaning back at 65 degrees from the bed to the cradle, 23 mm thick: a 6 mm front leg, the 11 mm channel continued, and the 6 mm support continued.
- The cradle: a floor 11 mm across (phone 9 plus a 2 mm gap) perpendicular to the lean, so the phone's bottom edge sits flat. In front of it is a lip 9 mm high and 6 mm thick with a round top.
- The support: 6 mm thick, a flat face 85 mm long above q, leaning back at 65 degrees, with a round top.
- The cable path:
  - a slot 14 mm wide (x) under the cradle floor, from the cradle down to 1 mm into the base and out the back of the slab under a ceiling that falls back at 50 degrees (40 from vertical);
  - a groove 14 × 1 mm along the base top, out through the back end.
- **PERCH** engraved 1.2 mm deep in the leaning front face, centred 22 mm down the face from q's level. Cap height 9 mm, stroke 1.8 mm, `spacing=2`. It reads from the front: the face looks 25 degrees above the horizontal.

**Promises (all 10 hold, `check --brief`, about 7 s):**

| Assert | Value |
| --- | --- |
| `abs(width(stand) - width_x) < 0.5`, about 70 wide | 0 |
| `abs(bottom(stand)) < 0.01`, the base on y = 0 | 0 |
| `clearance(phone_probe, stand) > 0.1`, the phone fits the cradle | 0.3 |
| `clearance(phone_probe, stand) < 0.6`, and rests on the support and floor | 0.3 |
| `clearance(phone_slid, stand) < 0`, the lip stops it sliding (the phone moved 3 mm along the floor) | -1.3 |
| `void(cable, stand)`, a 3.6 mm cable from behind to the phone's bottom edge | holds |
| `clearance(cable, stand) > 0.1`, and it clears every wall | 0.2 (to the groove floor) |
| `pieces(stand) == 1` | 1 |
| `wall(stand) > 1.6`, no wall thinner than 1.6 mm | 2.0 |
| `overhang(stand) < 0.002` | 0.001305 |

The phone probe is a 75 × 150 × 9 box turned `rotate(x=lean_deg - 90)` and set 0.3 mm off the support and the floor at q. The cable probe is `tube(1.8, ...)` from 10 mm behind the base, along the groove, into the slot and up to 2 mm above the cradle floor.

**The report's Print section:** "one piece, watertight, fits the bed; support under 0.1% of the surface".
- Thinnest wall: 2 mm, between the P and the E of the engraving (the doc's formula for the gap between letters, size/5 + spacing - weight = 1.8 + 2 - 1.8, predicted 2.0).
- Support: about 61.8 mm³, all of it on the model and none standing on the plate. About 56 mm³ of that is under the upper walls of the word's grooves. About 5 mm³ is one 0.23 mm² sliver at the slot's corner, which still sets the "tallest column 33.8 mm".
- On the plate: 6645.7 mm² flat on the bed.
- Stands: centre of mass (0, 33.0, 5.3), 35 mm inside the footprint.

With the phone in place (the probe scene, phone at the stand's density), the scene still stands, its centre of mass at z -5.2, 35 inside.

**How close it came to the plan.** The plan held: base, leaning slab, a tilted cradle with a lip, a 65-degree support, a slot and groove for the cable, an engraved word, and printing as modelled with nothing facing down more than 40 degrees except the word's grooves. It departs from the plan in four places:
1. The first outline used close pairs of points to end straight runs. The spline overshot and looped, so every straight run now ends in a corner.
2. The slot's top corner moved 1.5 mm up the support face, off q, because of the support estimate (section 3).
3. "The cable gets through" needed a `clearance` promise beside the `void`.
4. It is heavier than a stand need be: 164 g solid, because the slab under the cradle is solid. Hollowing it would bring a bridge under the cradle floor, the one overhang this design avoids. A slicer's infill takes most of that out.

The lip hides the bottom 9 mm of the phone's face, and the phone stands 2.5 mm proud of each side, which is meant for its buttons.

## 2. Verification

**Asserts.** The 10 above, printed with their numbers on every `check`. The promises that reach a print are `pieces`, `wall` and `overhang`. These mesh at the program's grid 200, and `check` still runs in about 7 s.

**Pictures, each read:**
- First quick sheet (`render --quick`): the profile was right in outline. A 2x crop of the right view showed a spike and notch at the heel fillet and a bump on the back end. That was the `curve2` overshoot, and the reason for the 0.0191 thin-part warning.
- Second quick sheet, after the rewrite: the profile is clean. The right view shows the slab, the cradle notch, the lip, the support, the heel fillet and the rounded back end.
- Full `sheet.png`:
  - perspective: the stand from the front right, PERCH legible;
  - front: the support face above the front face, PERCH centred;
  - right: the side profile, exactly the plan;
  - top: the slot as a notch in the middle of the cradle and the groove leaving the back end. The two leaning faces are dark from above, which is expected.
- `slices.png`:
  - X = 0, through the slot, is the picture that proves the cable path. It shows the pocket open from the cradle to a 5 mm floor and out the back, the support's foot cut on the 50-degree ceiling, the front leg 6 thick with the engraving's notches, and the base groove.
  - Y = 58.4: the 6 mm support.
  - Z = 0: the support, and the base with the 1 mm groove.
- `steps.png`: 8 steps.
  - body and stand are in the output;
  - slot, groove and word are tagged CUT, and slot is drawn as the wedge prism it removes;
  - phone_probe, phone_slid and cable are tagged REGION.
- `callouts.png`: names body and word (cut); slot and groove are listed as not seen from that view, which is true.
- `--focus slot --azimuth 215 --elevation 30` close-up (cell 0.32): the perspective was hard to read, because the clipped side walls hide the slot (section 3). Its slices were clear: Y = 25.6 shows the slot leaving only the front leg across the middle 14 mm.
- `--focus word` close-up (cell 0.253): PERCH is crisp, the grooves even, and the right view is the clipped wedge of the leaning face.
- Probe scene (`stand_probe_phone.aix`, `--azimuth 60 --elevation 20`):
  - the phone seated against the support with the lip in front, standing 2.5 mm proud on each side in the front view;
  - the X = 0 slice shows the cable along the groove, round into the pocket and up to the phone's bottom edge;
  - the Z = 0 slice shows the cable lying in the groove.
  - This was rendered before the 1.5 mm slot-corner change. The probe file has since been regenerated from the final program and checked.
- `turntable.png`: the back views (125 to 260 degrees) show the groove along the base and the slot's opening at the foot of the slab.
- `beauty.png`: an orange stand, PERCH engraved and shadowed. The cradle's open end shows as a dark notch between the lip and the support. The slot cannot be seen from the default camera.

**The 3MF, read back** with a Node script that walks the zip's central directory and inflates the entries with `zlib.inflateRawSync`:
- entries `[Content_Types].xml`, `_rels/.rels` and `3D/3dmodel.model` (deflated 2,320,745 to 22,686,269 bytes);
- `<model unit="millimeter" ...>`, one `<object type="model">` with a base material `orange` `#E07A2AFF`, and one build item;
- 133,032 vertices and 266,064 triangles: the full mesh, not the decimated 200,000 of the GLB;
- extent x -35.003..35.006, y -44.953..50.009, z 0.000..116.781, that is **70.009 × 94.961 × 116.781 mm**, z up, on the plate at z = 0, its front at -y;
- 399,096 edges, every one shared by exactly two triangles, so it is closed.

`model.stl` read the same way: header `Aixle stand`, 266,064 triangles, the same extent to the micron. A slicer gets millimetres and the right size.

**Deliberate failures** (scratch copies, one change each; `check` exit 1 unless said):
1. `slot_w = 3` under the 3.6 mm cable: **void held**: `assert (line 113) holds: void(cable, stand): a 3.6 mm cable runs from behind, through the slot, to the phone's bottom edge`. That is a false pass, with the cable 0.3 mm into both walls for 60 mm. `inside(cable, stand) == 0` also held. `clearance(cable, stand)` caught it: `assert (line 114) fails: clearance(cable, stand) > 0.1 is -0.2729 > 0.1, deepest overlap at (-1.77, 24.57, 20.49): and clears every wall (void alone passed a 3 mm slot)`. That is why the final program has both.
2. `slot_w = 2`: `assert (line 113) fails: void(cable, stand), solid at (-1.2, 6.81, 13) in 'body': a 3.6 mm cable runs from behind, through the slot, to the phone's bottom edge`.
3. `thick = 1.4`: `assert (line 115) fails: wall(stand) > 1.6 is 0.1998 > 1.6, thinnest at (2.02, 18.27, 30.06) in 'body': no wall thinner than 1.6 mm`. That is the engraving's floor in a front leg now 1.4 thick; the place is right.
4. `gap = -1` (cradle narrower than the phone): `assert (line 110) fails: clearance(phone_probe, stand) > 0.1 is -1.3 > 0.1, deepest overlap at (-35, 49.13, 12.14): the phone fits the cradle`. The phone runs into the lip.
5. `spacing=0` on the word: `assert (line 115) fails: wall(stand) > 1.6 is 0.3 > 1.6, thinnest at (3.15, 26.19, 31.52) in 'body': no wall thinner than 1.6 mm`. The fins between letters shrink to almost nothing.
6. `ceil_deg = 15` (a flat slot ceiling): passed my first threshold (`overhang(stand) < 0.005` at 0.003518). It fails the final one: `assert (line 117) fails: overhang(stand) < 0.002 is 0.003518 < 0.002: prints standing on its base without support (the word's grooves are the only overhang)`.
7. `slot_w = 80` (the slot through the whole width, freeing the support): `assert (line 115) fails: pieces(stand) == 1 is 2 == 1, the smallest piece is 36600 at (0, 76.36, -12.71): one piece`.

**Splitting the support estimate.** On a scratch copy without the word, the estimate was 206.5 mm³ on 7.34 mm², tallest 32.7 mm at the slot's corner. With the slot's corner moved 1.5 mm up the support face, it fell to 5.41 mm³ on 0.229 mm². The final model reports 61.8 mm³, which is the word's grooves plus that sliver.

**`aixle fmt`.** On the finished program, `fmt --check` printed nothing and exited 0, and `fmt` printed the file byte for byte. It changed nothing, so there was nothing to keep or reject. The program was written to the layout the docs describe: one space round operators, trailing comments in one column, `=` not padded. To be sure fmt had looked at the file, I ran it on a scratch copy with `stand=body-slot -  groove-word`, `gap=2 #` and four blank lines. It reported `not formatted`, exited 1, and fixed all three. The `gap` comment went two spaces after the code rather than back into its neighbours' column, which is the documented behaviour. I would keep that result too, though I would realign the comment by hand.

## 3. Friction

- **Plan, SKILL.md step 1 vs the print paragraph.** SKILL.md says "Pick a unit and keep the whole model within about 1 to 20 units", and the agent guide's style list says "Keep the whole model within about 1 to 20 units; the grid resolution is relative to the longest side". The same SKILL.md, a page later, says for a print `set units mm` ("a millimetre is assumed without"), and the brief says model in millimetres. A 95 x 117 x 70 mm stand is 117 units. Neither page says whether the 1-20 rule still applies to a print, or what breaks past 20 (the second sentence suggests nothing does, since the grid is relative). Expected: one line, "for a print, model in mm and ignore the 1-20 range" or the reason for the range. Cost: no render, a few minutes of doubt; I modelled in mm because the brief says so.
- **`curve2` overshoots when the points are unevenly spaced; the docs never say to space them evenly.** First outline: the front face, support face and back face as long runs ending in a pair of close points (`lean(sup_len - 2, 0) + lean(sup_len, 0)`) so the run would stay straight up to a small round end. `check` printed `side profile 95.1 × 119` where the support's round top tops out at 116.8 by hand, and `warning: 'body' (line 52) has a part (a wall, slat, rod, tube at its thin end, or stroke) only 0.0191 thick, 0.032 of the 0.596 cell: it may be missing or broken in the mesh. Thicken it to 1.193 (two cells) or raise the grid (set grid 512).` The quick sheet, cropped and enlarged, showed a spike and a notch at the heel fillet and a bulge on the back end: the spline takes a long tangent from the far neighbour (85 mm away) into a 2 mm piece and loops. language.md says a doubled point is a corner and "the run between two corners is straight", and that a spline "overshoots" at a sharp turn, but nothing about a short piece next to a long one. Expected: a line saying the tangent at a point comes from its neighbours, so space the points evenly or end a straight run in a corner. Cost: one check, one quick render, a crop of the sheet, and a rewrite of the outline with corners at every straight run and arcs of evenly spaced points.
- **The thin-part warning on a profile does not say where.** `'body' ... only 0.0191 thick` names the step and the thickness but not the place, on a 30-point outline. The watertight and wall messages give coordinates; this one does not. Expected `at (z, y)` as the report's thinnest-wall row does. Cost: I had to crop the quick sheet's right view and enlarge it to find the loop.
- **Misread of the quick sheet (minor, partly mine).** At the sheet's size the right view's dark outline and the orange fill of the 23 mm slab read to me as two thin plates with background between them; only a 2x crop showed it was solid. A side profile is what this model is, and the right view is the one picture of it.
- **`--no-asserts` turns the probes back into warnings.** `render --quick --no-asserts` (to keep the quick loop at two seconds) printed `warning: 'phone_probe' (line 98) is not part of the output; add it to the model or remove it` for all three probes, which `check` with the asserts calls regions and does not warn about. The sheet's title then counts "3 WARNINGS". Expected: a step only asserts read is still a region when the asserts are skipped. Cost: nothing but noise in the loop; a later agent could "fix" it by deleting the probes.
- **A program's shapes cannot be reused by a probe.** To draw the phone and the cable in the stand I tried `use "stand" as s` then `s.phone_probe`: `dogfood/stand_probe_phone.aix: line 3: 'stand' has no 'phone_probe'; it has lean_deg, phone, gap, cradle, ... lean, w3`. The message is clear and language.md does say a library's "shapes stay its own", but it left me no way to look at the probes except copying the whole program into the probe file. Note the list also exports `a`, my loop counter. Expected: either a `show` of a region for a picture (`render --show phone_probe`?) or shapes exported. Cost: one check; the probe is a copy of the program with a scene at the end.
- **A cutter's corner placed on the body's corner made a 33 mm support tower in the estimate.** The first full report: `Supports | about 262.9 mm³ under the overhangs (0 mm³ standing on the plate, 262.9 mm³ on the model itself), over 50.8 mm² of the plate; the tallest column is 32.7 mm under (-6.761, 37.776, 8.338)`. That point is the cradle's back corner q at the slot's side, where my slot polygon's first vertex sat exactly on the outline's doubled corner. Nothing there faces down by more than 40 degrees in the true shape (the slices and a close-up agree). Removing the word (a scratch copy) left 206.5 mm³ on 7.34 mm², all of it there; moving the slot's corner 1.5 mm up the support face took it to 5.41 mm³ on 0.229 mm². The row gives the place, which is good, but reads as a real 33 mm column a slicer would build. Expected: a note when the down-facing faces under a column are a few slivers at a sharp edge, or the same advice the watertight row gives for coincident faces ("move the part by half a cell"). Cost: two scratch renders and some head-scratching.
- **"0 mm³ standing on the plate ... over 50.8 mm² of the plate" reads as a contradiction.** The area is the footprint of columns that stand on the model, projected; "of the plate" made me look for support on the bed. Expected "over 50.8 mm² in plan". Cost: a read of report.json to be sure (`fromFloorMm3: 0`, `areaMm2: 50.83`).
- **`void(cable, stand)` passed with the cable 0.3 mm into both walls of the slot.** Deliberate failure: `slot_w = 3` under a 3.6 mm cable probe. `check` said `assert (line 113) holds: void(cable, stand): a 3.6 mm cable runs from behind, through the slot, to the phone's bottom edge`, a false pass along 60 mm of cable. At `slot_w = 2` it failed (`void(cable, stand), solid at (-1.2, 6.81, 13) in 'body'`). language.md says "`void` walks the surface too, so a pin thinner than the lattice is caught"; a skin of intrusion thinner than the lattice is not. `inside(cable, stand) == 0` held at both widths. `clearance(cable, stand)` caught both: `-0.2729` and `-0.7729` (the true 0.3 and 0.8). Expected: void to be the safe promise for "the hole goes through", as the docs present it. Cost: three scratch checks; the program now promises `clearance(cable, stand) > 0.1` beside the void.
- **`overhang()` is a share of the whole surface, so a bad ceiling hides in it.** Deliberate failure: the slot's ceiling at 15 degrees instead of 50 (facing down 75 degrees, a flat bridge 14 mm wide) moved `overhang(stand)` from 0.001305 to 0.003518, under my first threshold of 0.005, and the assert held. On a 95 x 117 x 70 mm part any one feature is a small share. Expected: a query for what the brief asks about, the support volume the report already estimates (`support(stand) < 50` in mm³), so the promise is in the unit a printer cares about. Cost: the threshold is now 0.002, tuned to this model, which is a weaker promise than it looks.
- **A failing `pieces()` gives a bare number.** `pieces(stand) == 1 is 2 == 1, the smallest piece is 36600 at (0, 76.36, -12.71)`: 36600 is a volume in cubic millimetres (the floating support plate), but the message gives no unit and no step, where the void and wall failures name the step. Expected `36600 mm³ ... in 'body'`. Cost: a moment's arithmetic (85 x 70 x 6 = 35700) to recognise it.
- **`fmt --check` is silent on success (minor).** On the finished program `aixle fmt --check dogfood/stand.aix` printed nothing and exited 0; `aixle fmt` printed the file byte for byte. On a scratch copy with `stand=body-slot -  groove-word`, `gap=2 #` and four blank lines it said `...stand_messy.aix: not formatted; aixle fmt --write ...` and exit 1, and fixed all three, but put the `gap` comment two spaces after the code rather than back in the column of the comments above and below it (the docs promise a column is kept, not mended, so this is as documented). Expected: a one-word "formatted" on success, so a silent pass is not mistaken for a skipped file. Cost: one extra run on a messy copy to be sure fmt had looked at all.

## 4. What worked well

- **`extrude(profile, h, "x") | flip("z")` did exactly what language.md says.** The side profile drawn with its front on the right faced +z the first time, and the right view was the profile.
- **`curve2` corners, once understood.** With every straight run between two corners and the arcs as evenly spaced points, the outline is exact: `check` gave the profile 95 × 117 and y up to 116.8, the number worked out by hand. The faces the phone touches are truly flat, and the rounds are smooth on the sheet and in the beauty render.
- **Lists joined with `+`, and a `def` that returns a point.** `def lean(t, s) = [...]`, plus loops that build `lip_top`, `sup_top`, `fillet` and `back_end`, let me write the whole outline in the design's own frame: along the lean and across it. The slot polygon and the probes reuse the same frame, so the parts cannot drift apart.
- **`check` is fast and says what it measured.** Ten asserts, including `wall`, `pieces` and `overhang` at grid 200, take about 7 s. Every passing assert prints its number (0.3 mm seat, -1.3 lip, 2.0 wall), which is how the deliberate failures could be read at a glance. The `print:` line gives the size in mm and the bed verdict without a render.
- **Failures say where.** `clearance` gives the deepest overlap point, `wall` the thinnest point and step, `void` the solid point and step. Each one pointed at the right feature.
- **The Print section.** The thinnest wall came with both end points and both steps: the gap between P and E. language.md's formula for that gap (size/5 + spacing - weight) predicted the 2.0 mm exactly. The support row's location found the coincident-corner artifact.
- **The slices through the slot** (X = 0) proved the cable path in one picture, and the probe scene's slice showed the phone seated and the cable routed.
- **`--focus word`** drew the lettering at a cell of 0.253 with no change to the program.
- **The 3MF and STL are right:** millimetre unit, closed, the full mesh rather than the decimated one, z up, the front to the front of the plate, and a colour.
- **`fmt`** is safe. It found nothing to change on a program written to the documented layout, and on a messy copy it fixed spacing without touching meaning.
- **The quick loop is about 1.8 s** for the sheet.

## 5. Three changes that would have helped most

1. **A `support(shape)` query in mm³**, the number the report's Print section already estimates, so "the support kept small" can be promised in the program. The estimate should also flag a column that stands on a few sliver faces at a sharp edge. Today the only promise is `overhang()`, a share of the whole surface: a flat 14 mm bridge moved it from 0.0013 to 0.0035, and the threshold had to be tuned to this model to catch it. Meanwhile a mesh sliver at a coincident cutter corner reported a 33 mm support tower that does not exist.
2. **Make `void(region, shape)` catch a thin skin of intrusion along a long probe, or document that it cannot.** It passed a 3.6 mm cable through a 3 mm slot, 0.3 mm into both walls for 60 mm, and `inside` == 0 passed too. Only `clearance(probe, shape) > 0` caught it. The docs present `void` on a rod as the way to promise that a hole goes through, so the false pass is the dangerous kind.
3. **Say how `curve2` takes its tangents, or take them so uneven spacing cannot loop.** The first outline put a point 2 mm from a corner whose other neighbour was 85 mm away. The spline overshot by 2.2 mm and looped into a 0.019 mm sliver. The only sign was a thin-part warning with no location. One sentence in language.md ("the tangent at a point comes from its neighbours: space points evenly, and end a straight run in a doubled point") and a place on the warning (`at (z, y)`) would have saved a render and a rewrite.
