# Frog on a lily pad, again: the agent's report

Round 3: the round-2 brief re-run by a fresh agent against the tool as
fixed after round 2, with three additions to the brief: use at least one
of the new features, ship a GLB, and verify it by a viewer screenshot and
a re-import round trip. The agent was forbidden to read the earlier
attempt. Seven model renders plus six four-line probe renders.

What follows is the agent's report, verbatim. The "fixed" notes in the
index (`dogfood/README.md`) say what changed in the tool because of it.
`frog_reimport_probe.aix` is the round-trip program.

## 1. The model

A cartoon frog, 4.4 × 2.77 × 4.4 units (frog itself 2.7 tall, pad 0.2), facing +z on a notched lily pad. Torso and head are two ellipsoids in `union(k=0.35)` with `displace(0.02, 0.18)` and a low-contrast speckle skin; a cream belly, a smile, and two nostrils are `decal`s; the eyes are two white spheres with `decal` pupils; four legs are three-point `tube`s (hip–knee–ankle, so the back legs fold) with a `def foot()` of a flat ellipsoid, three toe capsules and an extruded web polygon; the pad is a `cylinder` minus a rotated wedge, with nine radial veins as a `ring` of thin boxes applied as a decal. It matches the plan closely; the only compromise was thickening the pad from 0.12 to 0.2 (see friction). New features used: **`decal`** (pupils, mouth, belly, nostrils, veins), **`curve`** (mouth path, into `tube`, into `decal`), **`set light_azimuth`/`set light_elevation`**, and **`--focus eyes --beauty`**. All did what the docs said: decals added no geometry (the re-import confirms it), the curve tube was smooth, the focus render re-extracted at cell 0.018 and framed the eyes.

## 2. Friction log

- **Thin flat base silently clipped from the mesh (the big one).** Lines 17/19 (original: `pad_disc = cylinder(2.2, 0.12, round=0.04) | move(0, 0.06, 0)`), line 61 `model = frog + pad`. Expected: a 4.4-wide disc, as `check` printed (`model 4.4 × 2.69 × 4.4`) and as step 3 in `steps.png` showed. What happened: sheet title said `3.61 × 2.69 × 3.28`, the top view showed the pad clipped to a rounded square, report `Surface extent x -1.807..1.806`, no warning. Reproduced with 4 lines (`cylinder(2.2, 0.12) + sphere(1)|move(0,1,0)` → extent ±1.366); `--grid 200` does not help (±1.33); a 0.3-thick disc is complete; adding a `sphere(0.1)` at the rim "rescues" the whole disc. So a coarse pre-pass that sizes the extraction domain misses a plate thinner than its spacing lying at y = 0 and independent of `--grid`. Workaround: pad 0.2 thick. Nothing in the docs mentions this; it is a wrong-size that `check` cannot see and the sheet reports without comment.
- **Feet floated above the pad and the "separate pieces" warning was misattributed.** Line 61 originally `(frog | move(0, 0.12, 0)) + pad`: feet bottom at 0.10–0.13 plus 0.12 landed at 0.22 over a pad top of 0.12. The warning said the loose piece (vol 0.546 at (-0.2, 0.078, 0.41)) was in `'mass', 'skinned'`; it was the pad (or the whole frog vs pad), and neither `pad` nor `legs` was named. Workaround: `frog | ground() | move(0, pad_thick - 0.01, 0)`. The probe version attributed correctly (`'pad_disc', 'model'`), so the attribution is unreliable with blended/decalled steps whose loose bounds contain the point.
- **Spurious thin-part warning on a decal region.** Line 20 `vein = box(2.0, 0.3, 0.035)`: `check` warned "'vein' is only 0.035 units thin ... may be missing or broken in the mesh ... set grid 315". `vein` is only ever a `decal` region (line 22) and adds no geometry; the warning is wrong and its advice (grid 315) would cost 15× the samples. I widened it to 0.05 to silence it.
- **Watertight warning names decal regions and blend inputs.** Report: "37 edges ... in 'belly_region', 'torso', 'head'". `belly_region` is not geometry (line 29–30), and `torso`/`head` were blended into `mass`. The location is right (the belly/skin boundary), the step names are not helpful.
- **Slices draw a decal region as a filled interior solid.** `slices.png` X=0 shows the belly (line 29 region) as a tan blob *inside* the green body, as if the belly were a separate solid inside the frog. The doc says "filled means solid"; here the fill colour distinguishes materials by whichever region contains the point, so a decal reads as an internal part. I could interpret it only because I wrote it.
- **Z=0 slice shows two unexplained black dots** above the head: the eye spheres (centre z 0.45, r 0.45) graze z = 0 and appear as black dots rather than white; nothing on the sheet says they are tangencies.
- **Speckle at 0.07 units looked like camouflage blocks on the sheet.** Line 9 originally `scale=0.07` with cell 0.034: the sheet colours per vertex, so a pattern near the cell size becomes a blotchy mosaic; the beauty render was fine. The docs warn about patterns *larger* than the part, not smaller than a cell. Fixed with scale 0.11 and closer colours.
- **Pad veins are jagged on the sheet, clean in beauty** (lines 20–22): same per-vertex colouring; a 0.05-wide decal is a stair-step on the sheet. Not documented that sheet materials are vertex-sampled.
- **Focus render clips decal regions into dark blobs.** `--focus eyes` sheet shows the mouth decal as dark patches at the clip frame's bottom corners (the clip box cuts through the region). Interpretable, but it looks like a defect until you know the frame is a clip.
- **Beauty framing is loose.** At `--beauty-size 768` the model fills ~45% of the frame; no documented way to zoom the beauty camera (only azimuth/elevation), short of `--focus`.
- **`check` does not list `def` bodies** (`toe`, `foot`, lines 46–50), so a `def`'s sizes are only visible once called and named; `foot()` had to be judged in `back_foot`'s thumbnail.
- **Import is slow:** `import("../out/frog/model.glb")` took 18.3 s to sample 115 k triangles at cell 0.046 on both `check` and `render` (it is not cached between the two), longer than meshing the original from scratch (2.2 s).
- **`ground()` after `union(k=)` leaves the bounds at y −0.01** (line 61: `model ... y -0.01..2.76`) while the surface is at 0: expected from the docs, but it means every `check` line for the model looks a hair below the floor.
- **Viewer could not be verified** (see 3); the page shows no message when three.js fails to load, just a blank canvas under a correct header.

## 3. Export verification

- **Viewer screenshot:** `frog_viewer.png` shows the page header rendered correctly ("model 4.40 × 2.77 × 4.40 units · 115400 triangles", Perspective/Front/Right/Top/Wireframe/Grid buttons) over a blank grey canvas. `shot.mjs` reported `webgl: true, errors: []` after 8 s; one retry with a 30 s wait and full console capture gave `net::ERR_CONNECTION_RESET` and `TypeError: Failed to fetch dynamically imported module: https://cdn.jsdelivr.net/npm/three@0.160.0/build/three.module.js`. `curl` reaches that URL (HTTP 200 through the proxy), so it is the headless browser's path to the CDN in this sandbox, not the page. Not pursued further, per the brief.
- **GLB round trip:** `model.glb` is 3.69 MB with a 1024 px atlas (`model.png`, 610 charts). Original: 4.4 × 2.765 × 4.4, 115,400 triangles, volume 9.139. Re-import (`frog_reimport.aix`): 4.401 × 2.761 × 4.401, 111,368 triangles, volume 9.127, surface extent identical (±2.2, y −0.001..2.76), one piece, no warnings. The re-import sheet is the same frog in untextured clay: pad, notch, eyes, folded legs, toes and web all present; skin slightly smoother (sampled at cell 0.046); all decals gone (belly, mouth, nostrils, pupils, veins), as expected for a geometry-only import.

## 4. What worked well

`check` in ~1 s with every step's box; the sheet/slices/steps trio (the steps sheet let me see `pad` intact and thereby pin the clipping to the final extraction); `decal` for every facial feature with no geometry cost; `curve` + `tube` as a decal region for the mouth; `tube` through three points for folded legs; `mirror` for symmetry; `def` for the foot; `union(k=)` + `displace` for a soft body; `--focus ... --beauty` and `--out` for a close-up without clobbering the main render; the beauty render's shading and shadows made the character presentable in three iterations; `--no-export --no-viewer` for fast diagnostic renders.

## 5. Three changes that would have helped most

1. **Fix or warn on the domain-sizing pre-pass:** the extraction domain must never be smaller than the output's bounds when the field is negative there; at minimum, warn when "Surface extent" is smaller than a primitive's exact bounds ("'pad_disc' reaches x ±2.2 but the mesh stops at ±1.81"). `check` said 4.4 and the sheet said 3.61 with no comment.
2. **Treat decal regions as regions:** no thin-part warning, no watertight/loose-piece attribution to them, and draw them in slices as a surface-only colour rather than a filled interior solid (or mark region-only steps on `steps.png`).
3. **Document sheet-versus-beauty material sampling and a beauty zoom:** say that the sheet colours per vertex so patterns and decals near a cell look blocky while the beauty render and atlas are exact; and give the beauty camera a framing/zoom setting (`set zoom` or a fill percentage) so the presentation image is not half empty.
