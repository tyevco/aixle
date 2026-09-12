Everything is done: only `dogfood/` and `out/` were touched, nothing is committed, and the final artefacts are in `out/sailboat/` (`model.glb` 9.6 MB, `model.stl` 15.3 MB, `beauty.png` 1024 px, `viewer.html`). Report follows.

# Dogfood report: `sailboat`

## 1. The model

A hard-chine sailing dinghy, 5.4 units long over the rudder (hull 4.9), 6.9 tall to the masthead, on a wooden two-frame cradle. Bow is +z. Program: `dogfood/sailboat.aix` (240 lines, 54 named steps, all in the output).

How it is built:

- **Hull**: three station tables (keel, chine, sheer as `z, half-beam` pairs) are turned into symmetric `polygon`s by loops, then two stacked `loft`s (keel→chine 0.3 tall, chine→sheer 0.8 tall) make a V-bottom with a hard chine and a raked stem and transom. The curved sheer is a big cylinder (r 11) lying along x subtracted from the top; rocker is an intersection with another (r 12) resting on the keel. `def sheer(z)` is the deck height used by every fitting.
- **Cockpit**: a rounded trapezoid `polygon` extruded and subtracted; a thwart across it.
- **Paint**: hull painted gloss navy, then four `decal`s: deck (the sheer cylinder grown by 0.03), antifouling (everything under the waterline), white boot-top (a 0.1 slab), and the well last.
- **Gunwale**: a `tube` through 24 deck-edge corner points, each found with `surface()` from a guess just outside and above the corner.
- **Rig**: mast, masthead sphere, a masthead crane with `anchor`ed port/starboard tangs, gooseneck collar; **boom** is a `joint` at the gooseneck carrying the boom, a boom-end fitting (anchor `end`) and the mainsail. **Sails** are extruded triangles (0.12 thick; the main with a 4-point roached leech) given a belly by `wrap`, turned with `rotate(y=-90)`, and moved so the luff lands on the mast axis; the jib is additionally tilted by the forestay's rake, computed with `atan` from the stem fitting and masthead anchors, with the clew given in world coordinates and projected along/across the luff.
- **Rudder**: a `joint` "helm" on the stock at the transom: stock, blade, rudder head, tiller; two gudgeons on the hull.
- **Rigging**: forestay (masthead→stem fitting), two shrouds (crane tangs→stern-quarter posts), a bridle between the quarter posts, the mainsheet from `at(boom_rig, "end")` (so it follows the pose) to the bridle's middle, and a jib sheet from the clew to a deck fairlead. Every line is a `tube` between anchors.
- **Cradle**: two beams and two rails on y = 0, four posts leaning in from the beams to `surface()` points under the bottom panels, with rubber pads.
- **Poses**: `rest`; `sailing` = boom 35° about y, helm −20° about y; animation `tack` (rest→sailing→rest, 3 s).

`check` at rest (grid 320, cell 0.0216, no warnings): hull 1.81 × 1.08 × 4.89, deck edge from 1.80 amidships to 2.06 at the transom and 2.09 at the stem; mainsail 0.31 × 4.13 × 2.03 (belly 0.2 to port); jib 0.24 × 4.22 × 2.8; boom 2.09 long at y 2.57; masthead at 6.82; sailboat 2.2 × 6.9 × 5.38. `check --pose sailing`: `boom_rig` posed x −1.38..0.07 (end at x −1.15, z −1.0), `tiller` posed x −0.46..0.05, `mainsheet` rebuilt 1.21 wide to follow the boom end.

## 2. Print readiness and re-import

Final `out/sailboat/report.md` (grid 320, cell 0.022, 305,392 triangles, volume 4.65):

| Row | Value |
| --- | --- |
| Pieces | **1** |
| Watertight | **no**: 37 edges. Mostly 4 at (−0.04, 2.599, 0.334) and 3 at (−0.041, 2.601, −1.13) in `main_flat`/`boom`: the sail's inner face leaving the boom's top (a sub-cell wedge where the 0.12 cloth, bellying away, crosses the 0.045 boom); 3 at (−0.604, 2.016, −2.241) in `upper_hull`/`sheer_cutter`: the deck cut meeting the loft's side at the stern quarter. The rest are single edges on the shroud tubes (0.07 = 3.2 cells). Down from 98 at first; the remaining ones are surface crossings, not thin parts. |
| Stands | **yes**, centre of mass (−0.02, 1.98, 0.04) is 1.06 inside the 20-sided footprint |
| Overhangs | **13%** (the V-bottom panels and the sails' undersides; a boat on a cradle needs support under the hull) |
| Cavities | none; rests on y = 0 |

Re-import (`dogfood/sailboat_reimport.aix`, `import("../out/sailboat/model.glb", resolution=200)`, 73 s to sample 314,368 triangles): size 2.201 × 6.897 × 5.386 vs 2.2 × 6.9 × 5.39 — identical; Pieces 1; Stands yes; volume 4.55 vs 4.65 (−2%, the 0.034 sampling cell shaves the thin parts); watertight no (79 edges, mostly around the rudder stock at cell 0.034). Everything survived: both sails with their belly, all six rigging lines, gunwale, tiller, rudder blade, centreboard, cradle posts; the boom and rudder are at the right heights, so the GLB's `boom`/`helm` nodes (translations (0, 2.566, 0.6) and (0, 2, −2.47)) are placed correctly. Materials are not read, as documented.

## 3. Friction (every stop)

1. **`loft` is centred on y = 0, the docs say y = 0 to h.** `sailboat.aix` line 64 (`lower_hull = loft(keel_p, chine_p, chine_y)`). `check` printed `lower_hull 1.52 × 0.3 × 4.6 y -0.15..0.15`; `docs/language.md` says "`loft(a, b, h)` blends from profile `a` at y = 0 to `b` at y = `h`". Expected y 0..0.3. Fixed with `| move(0, up + chine_y / 2, 0)`. Everything downstream (sheer cut, rocker, the gunwale's `surface()` points all at y 0.7) was wrong until then.

2. **A white part lit face-on is invisible on the sheet — I spent ~9 renders "finding" a sail that was never missing.** Lines 167 (`mainsail`), 190 (`jib`). From the first full render the RIGHT and PERSPECTIVE views showed the jib grey and, where the main should be, only background with a faint leech line; `steps.png` showed the sail in steps 28/29, the Y = 3.45 slice showed both arcs, `--focus mainsail` showed it, the OBJ/STL had 56,370 vertices in its box. Repainting it `"maroon"` (`sailboat_probe_dark.aix`) showed it in place. The ivory cloth (`#f6f2e6`) with its normal towards the camera renders in the sheet's background value; the tilted jib picks up shading. Nothing in the docs' "mistakes the renders catch" table covers a part that is present but reads as absent. Worked around by never trusting a white part's absence again.

3. **The quick sheet mislaid a decal, and I drew the wrong conclusion.** Line 95 (`hull = ... | decal(well_region, ...)` last). Render 1 (`--quick`, cell 0.108) showed the cockpit floor red though the well decal was applied last; I "fixed" it by reordering, and the full render then showed red for a real reason. Probes (`sailboat_probe_decal.aix`, `sailboat_probe_well.aix`) established: the **last** decal wins, and at a 0.108 cell the floor's vertices sat below a region that ended 0.03 under the floor. The docs say nothing about decal precedence or about vertices straying out of a region on a coarse mesh. Fixed by keeping the well last and extending its region 0.1 below the floor (line 94).

4. **`surface()` from a far guess slid to the wrong place in a loft's field.** Line ~230 (`p = surface(hull_cut, x, up + 0.1, z)`). With the guess at y −0.5 the point came back at `[0.13, 0.04, 0.94]` (near the keel) for x = 0.7; the posts converged on the keel in the FRONT view. With a guess 0.1 under the panel it returns `[0.5, 1.3, 1]` — exactly the chine height, 0.07 above the true panel. The reference says "exact on primitives and close on blends and warps"; a loft is neither and the result is only "close". Worked around by guessing near, and the 0.09 pads hide the error.

5. **A transform above a `joint` is not carried into the GLB's joint nodes.** Old line `sailboat = (boat + cradle) | ground()`. The GLB had `boom` at translation (0, 1.566, 0.6) and `helm` at (0, 1, −2.47) while the hull mesh was grounded (+1); the OBJ had the blade at y −0.68..0.57 next to a cradle at 0..1.27. The sheet and report were right; only the exports were wrong, silently. Fixed by building with an `up = 1.0` offset in every y and no `ground()` (line 240). Docs say "exports are at rest" but not "and ignore transforms above joints".

6. **`at(shape, "centre")` on a joint is the box centre, not the part.** Line 214. I wrote `at(boom_rig, "centre")` meaning the boom end; the mainsheet ran from mid-air at y 3.6 and the watertight report blamed `mainsheet`. My error, but the report's location (−0.016, 2.424, −2.16) was what caught it, not the sheet. Fixed with `anchor("end", ...)` on `boom_end` (line 139).

7. **The wrapped luff does not land where the flat luff was.** Lines 149–150, 166, 189. Overshooting the luff by `lap` moves the wrapped edge ~lap·sin(half/r) (0.017) off the axis, so a 0.03 stay in 0.1 cloth left `jib_flat`/`forestay` edges at x = 0.044. The reference for `wrap` gives no formula for where a point lands. Fixed by moving by the angle halfway along the overshoot and thickening the cloth to 0.12.

8. **A stay leaving a sail at a corner made a "piece".** Line 180. Render 13 reported `Pieces 2 (... 0 at (0.064, 5.776, 0.996) in 'jib_flat', 'forestay')` — a zero-volume speck at the jib's head. Fixed by running the luff to the masthead so the exit is inside the masthead sphere. A zero-volume speck counting as a piece is noise the report should filter.

9. **Watertightness of rigging.** Line 205. Tubes at 1.6 cells (r 0.022) gave 98 edges; 2.2 cells still 44 on the tubes alone; 3.2 cells clean. The docs' "1.2 cells" threshold is for being caught at all, not for being watertight; nothing says what watertight needs.

10. **Two shrouds meeting at one point leave a sub-cell wedge.** Old masthead line. Report: "8 at (−0.047, 6.339, 0.297) in 'shroud_p', 'shroud_s'". Fixed with a crane and two tangs (line 131). Not documented.

11. **`check`'s `surface` line missed thin plates.** `boat surface ... y 0..5.9 z -2.62..2.54` while the centreboard reaches −0.9 and the rudder blade −2.84; both were in the mesh. The line is described as the "true extent".

12. **The steps sheet's "in output: yes" and the report do not say whether a step made it into the mesh**, only into the tree; nothing distinguishes "present but white" from "dropped".

13. **Command-line friction, not the tool's:** the sandbox refused every heredoc/`sed` pipeline as "too complex", so probe files had to go through separate scripts.

Budget: 15 renders of the model (quick, 7 full, 2 focus, 3 grid trials, beauty candidate, pose sheet) plus 13 renders of probe programs and the re-import. Beauty at 1024 took 18 s; a full grid-320 render with exports about 60 s (`hierarchy` 13 s, `anim` 8 s).

## 4. What worked well

- `check` in under two seconds, printing numbers as well as shapes: the whole jib geometry (`rake`, `cu`, `cv`, the clew position) was verified before any picture.
- Anchors and `at()` for the rigging: six lines fitting-to-fitting with no arithmetic, and `at(boom_rig, "end")` following the pose so the mainsheet stays on the boom end in `sailing`.
- The watertight report naming the two steps and the point: every remaining edge was diagnosable from that line alone.
- `--focus` with its own cell, and the slices drawn from the field, which are what finally proved the "missing" sail was there.
- `wrap` for sail bellies, `surface()` for the gunwale corners (24 points, all right), `loft` for a hull that reads as a hull.
- The re-import loop closing on the GLB, which is how the joint-placement bug and its fix were both measured.

## 5. Three changes that would have helped most

1. **Make a present-but-invisible part impossible on the sheet**: draw silhouette edges darker and/or shade by normal so a white face-on surface differs from the background; and let `steps.png` or the report say per step whether it produced triangles in the final mesh (a step "in output" that yielded no faces is exactly what I feared). This alone would have saved ten renders.
2. **Fix `loft` to match its doc (y = 0 to h) or fix the doc**, and add to `docs/language.md`: the last `decal` wins; a transform above a `joint` must not be used (or make the exporter apply it); `at(x, "centre")` is the box centre; `surface()` is only "close" on a loft.
3. **Print-readiness guidance in cells**: state that a tube needs about 3 cells across to be watertight and that two surfaces crossing at under ~45° or a stay leaving cloth at a corner will leave edges; and drop zero-volume specks from the Pieces count while still listing them.
