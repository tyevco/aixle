# Round 8 dogfood report: folding pocket multi-tool

Program: `/home/user/aixle/.claude/worktrees/round8-multitool/dogfood/multitool.aix`. Renders in `/home/user/aixle/.claude/worktrees/round8-multitool/out/multitool` (full + beauty, final), `out/multitool-blade` (`--focus blade`), `out/multitool-brand` (`--focus brand`), `out/multitool-cork` (`--focus corkscrew --pose three_out`), `out/multitool-allout` (`--pose all_out --beauty`), `out/multitool-final` (beauty at 768 px, azimuth 30, elevation 35, zoom 1.15), `out/multitool-knife-q` (quick beauty in `knife`). 11 renders used of 25; nothing committed; nothing outside `dogfood/` and `out/` touched. Probe copies used only for `check` live in the scratchpad.

## 1. The finished tool

A 0.98 × 0.23 × 0.22 pocket tool lying on y = 0 with its length along x: two walnut scales (`material("walnut", scale=0.08)`) on steel liners, a steel backspacer along the −z spine, a steel rear bolster, a lanyard torus through the bolster, raised brass "AIXLE" (`text("AIXLE", 0.07, weight=0.014)` extruded 0.02, half sunk into the top scale), and two brass pins. Four `axis=` joints, all declared at their pin's world point: `blade` (chrome drop-point polygon, 0.66 from the pin), `driver` (tang + bar + flat tip) and `corkscrew` (shank + `tube(0.007, curve(helix(0.016, 0.3, 4)))`) on the front pin at x = 0.38, stacked at y = 0.06 / 0.09 / 0.135 with 0.01 gaps, all `axis=[0, 1, 0]`; `opener` (bar with a notch) on the rear pin at x = −0.36 with `axis=[0, −1, 0]` so a positive angle also swings it out through the open +z side. Poses `closed` (no angles), `knife` (blade 180), `driver_out`, `half` (blade 90), `two_out`, `three_out` and `all_out` (blade 180, driver 135, corkscrew 90, opener 160); six asserts (one piece at rest, `tall` and `width` and the blade tip inside in `closed`, the tip past the handle in `knife`, `clearance(blade, driver)` in `all_out`), all passing; animations `flick`, `unfold`, `fidget`. Report: 1 piece, stands, 2 open edges in `coil` alone (a 3-cell tube, mesher noise), 162 724 triangles at grid 220 (cell 0.00445). It matches the plan; the only compromises are that the blade has no bevel (flat slab) and the opener's hook is a plain notch, and `flick` needed a third key (below).

## 2. Rig verification

Poses (`poses.png`, then `check --pose` `posed` lines):
- `closed`: identical to REST; blade box x −0.28..0.43 inside the handle (−0.45..0.45). Right first time.
- `knife`: blade swings about the front pin to x 0.33..1.04, tip past the handle; the tang stays on the pin. Right first time.
- `driver_out`: driver out along +x (x 0.33..0.91). Right first time.
- `half`: blade straight out to +z (z −0.05..0.66), pivot at the pin. Right first time (a positive angle about +y does swing the −x tip to +z, as the doc's right-hand rule says).
- `all_out`: blade 180, driver angled at 135 (x 0.33..0.77, z to 0.39), corkscrew out to +z, opener off the −x end toward +z (x −0.67..−0.32, z to 0.14): the `axis=[0,-1,0]` reversal worked as documented. Right first time, but the corkscrew is a few pixels on the thumbnail and needed the close-up.

Animations:
- `flick`, first version `["closed", "knife"], seconds=0.6, loop=0, ease=1, ease_ends=0`: bar "FLICK 0.6S ONCE EASE 1 ENDS 0"; the eight frames step about 26° each, i.e. linear, no settle. Second version `["closed", "knife", "knife"], times=[0, 0.45, 0.6]`: ~45° by 0.086 s, ~150° by 0.26 s, settled by 0.43 s, three hold frames; bar "CLOSED 0S → KNIFE 0.45S → KNIFE 0.6S". Right on the second try.
- `unfold` (`times=[0, 0.5, 0.9, 1.3, 1.8]`, `loop=0`, `ease=1`): blade out by 0.51 s, driver by 1.03 s, corkscrew by 1.54 s, opener at 1.8 s; reads as one after another. Right first time.
- `fidget` (loop, `ease=1`, `ease_ends=0`): closed → ~90° at 0.51–0.69 s → closed, slowing around `half`, first and last frames identical. Right first time; but in frames 2 and 7 (blade at ~35°) the chrome blade is drawn black.

Asserts, as `check` printed them:
- Deliberate failure `assert tall(tool) < 0.2, ..., pose=closed`: `assert (line 74) in pose closed fails: tall(tool) < 0.2 is 0.235 < 0.2: closed, nothing stands above the scales`, then `asserts: 5 pass, 1 fail (at rest, or in the pose each names)`, exit 1. The 0.235 also revealed the pins reaching y = −0.005; fixed the pins and set 0.25: `asserts: 6 pass`.
- `assert pieces(tool) == 1`: passed on the first check, then after only raising the pins 0.005 printed `assert (line 73) fails: pieces(tool) == 1 is 2 == 1: one piece at rest`, while the render report at grid 220 said Pieces 1. `pieces(tool, resolution=160)` passes.
- `width(tool) < 1.0` closed (0.98), `at(blade, "tip")[0] > -0.45` closed (−0.28), `at(blade, "tip")[0] > 0.45` knife (1.04), `clearance(blade, driver) > 0.005` all_out: all passed first time. `at()` on the joint's own step gave the posed point.
- Probes (scratch copies): `pose=knfe` gives `warning: assert (line 89) is for pose "knfe", which is not defined; poses: closed, knife, ...; it is never tested`, exit 0. A misspelt anchor `at(blade, "tp")` is a hard error, exit 1, `line 90: at(): at(): no anchor "tp"; this shape has "tip", and every shape has centre, top, ...`, and the other asserts are not reported. `angle("blade")` on the axis joint prints `[180, 0, 0]` in `--pose knife`.

Close-ups:
- `--focus blade` (cell 0.00374, close-up watertight yes): the sheet draws the blade solid with the lower scale, pin, driver and spine faint; each view carries "FAINT: THE REST OF THE MODEL, CLIPPED TO THIS FRAME", and the pose sheet and strip bars say "(THE REST OF THE MODEL FAINT)", so the context read as context and the caption did tell me. The slices cut through the blade's own centre (Y = 0.06) and showed its outline with the tang, which is how I saw the first tip was a symmetric spear point and redrew it as a drop point. The focus `poses.png` frames the blade in every pose (handle faint at the left in `knife`); the focus strips follow the blade, but the faint handle is nearly invisible in the last frames, and in `flick` frames 2–3 the blade is black.
- `--focus brand` (cell 0.00137, close-up watertight yes): "AIXLE" reads cleanly from above and in perspective, strokes rounded, brass; weight 0.014 at size 0.07 (3 cells at the model's grid) is right, as the doc's guidance predicted. On the whole-model sheet it was a legible but blobby word; on the quick sheet a blob, as the doc says.
- `--focus corkscrew --pose three_out` (cell 0.0022): first showed "Close-up watertight: not watertight at cell 0.0022: 1 edges at (0.38, 0.126, 0.0975) in 'coil', 'corkscrew_body'; ..." (seven rings at the helix's inner bore, the polyline tube's joins); after `curve(helix(...))` it is watertight at that cell.

## 3. Friction

- `assert pieces(tool) == 1, "one piece at rest"` (line 73 then): passed, then failed `is 2 == 1` after moving two pins up 0.005, while the render's Pieces row said 1. The default `resolution=64` is a 0.015 cell on a 0.98 model, coarser than the ring's 0.02 tube, and the failure names neither the loose piece nor the resolution. Worked around with `resolution=160`. Expected the assert to count at the program's `set grid`, or the message to say which piece.
- `pin = cylinder(0.02, T + 0.01) | move(pin_x, T / 2, 0)` (pin reaching y = −0.005): `check` printed `note: the lowest point of the surface is at y = 0; pipe the model through ground() to rest it on y = 0`. The note contradicts itself because it rounds −0.005 to 0. Found the real cause only through the `tall` assert's 0.235.
- `animation("flick", ["closed", "knife"], seconds=0.6, loop=0, ease=1, ease_ends=0)`: expected "leave at once, settle open" as the language doc says ("a one-shot that must start at once and settle takes ease_ends=0 with ease=1 at the keys between"); got a linear strip, because a two-key clip has no keys between. Nothing warned. Workaround: a hold key, `["closed", "knife", "knife"], times=[0, 0.45, 0.6]`. The doc should give this idiom, or the tool an `ease_in`/`ease_out` per end.
- `loop=0` is only in the reference signature; the language doc and guide say "one-shot" without naming the parameter. Guessed from the signature.
- Chrome blade drawn black in `anim_fidget.png` frames 2 and 7 and `anim_flick.png` (focus) frames 2–3 at ~30–50°: I first read it as the blade having flipped. The docs say to judge metals in the beauty render, but strips exist to check motion and a part vanishing to black there is misleading; a strip could shade with a fixed matte material.
- Strips reframe every frame on that frame's posed box: in `flick` the tool fills frames 1–6 and shrinks in 7–8 (the whole-model strip), and in `unfold` the handle shrinks as tools come out, so the swing is hard to follow. Expected one fixed frame per strip (the union of the keys' boxes).
- `pose("closed")` with no angles makes a second thumbnail identical to REST; the docs say `rest` would do for the animation, but nothing says a no-angle pose is redundant. Minor.
- The whole-model `slices.png` X = 0 cut is about 80 px wide in a 380 px frame on a 0.98 × 0.23 × 0.22 model, unreadable; it seems each cut is framed on the longest side. Only the focus slices (framed on the step) were readable. Expected each cut framed on its own extent.
- `at(blade, "tp")` in an assert aborts `check` with exit 1 and the doubled prefix `at(): at(): no anchor "tp"`, so the remaining asserts are not reported; a pose typo is a warning and check continues. Inconsistent, and the doubled prefix is a cosmetic bug.
- `coil = tube(0.007, helix(0.016, 0.3, 4))`: `check` and the whole-model report said nothing, the close-up report listed seven open rings on the helix's inner bore. The doc mentions the join wedge only for tapered tubes; a tight untapered helix has it too. `curve(helix(...))` fixed it (the doc does not say a `helix()` list can feed `curve()`, but it works) and doubled `check`'s time (2 s → 4.8 s).
- In the focus close-ups the faint brass pin is drawn a tan/clay colour, the same colour `steps.png` uses for unpainted parts (see `shank`, `opener_bar`), so a faint painted part can be mistaken for an unpainted one.
- Language doc on `at()`: "at() on a nested joint's own step is that joint's posed point; the world point is read through the outer step" left me unsure which step to name for an un-nested joint; `at(blade, "tip")` on the joint step worked. A one-line example with a top-level joint would settle it.
- `check --pose` prints a `posed` line for `opener_notch`, a cutter that is not geometry. Minor noise.
- Time: full render 26 s, of which poses 3.3 s and the three strips 3–5 s each; `--focus` renders repeat all the strips (24 s for `blade`); `--no-poses --no-export --no-viewer` gets a posed sheet in 11 s. Acceptable, but a focus render could draw only the strips whose animations move the focused step.
- Focus sheet caption "FLOOR GRID 0.1 AT Y=−0.0068" for a model resting on y = 0: the frame's padding drives the floor. Harmless but odd.

## 4. What worked well enough to keep

- `joint(..., axis=[0, 1, 0])` with one angle per pose, the sign rule and the `axis=[0,-1,0]` reversal: every pose right first time, and `check`'s joint tree with pivots and axes plus the `posed` lines let me verify the swing numerically before any picture.
- `assert ..., pose=name`: the failure line carries both sides, the line number and the pose, and `at(joint_step, "tip")` in a pose is the posed point, so the "tip past the handle" promise was one line.
- The `--focus` close-ups: framed on the step at its own finer cell, the rest faint and captioned as such, slices through the step, and their own watertight row (which is what found the helix rings).
- The strip bars ("0.6S ONCE EASE 1 ENDS 0", keyframes with times) and the report's Animations row: I could confirm what the tool believed the clip to be.
- The lettering guidance (weight vs cell, "judge with --focus"), `check`'s exact text box, the quick pass naming the steps it dropped, and the beauty render's materials (walnut grain, brass, chrome) with no lighting work.
- `explain`-style step table in `report.md` with lines and boxes; the watertight row naming the step and "alone".

## 5. Three changes that would have helped most

1. Make `pieces()` in an assert count at the program's grid (or at least name the loose piece and the resolution in the failure), so a promise that passed at rest does not flip on an unrelated 0.005 edit while the report says 1.
2. Document the one-shot ease idiom (a hold key, or better an `ease_in`/`ease_out` pair) and name `loop=0` in the language doc; `ease_ends=0` on a two-key clip should warn that there is nothing to ease.
3. Draw animation strips (and the focus strips) in one fixed frame with a matte shading for metals, so a swing reads as motion rather than as a camera zoom and a part going black.
