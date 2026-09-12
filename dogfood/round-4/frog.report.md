All of the work is done and verified; nothing further depends on a tool call. Renders used: 8 of 14 (baseline, two quick, three full, one focus, one re-import).

# Report: taking over the round-3 frog

Files (all under `/home/user/aixle/.claude/worktrees/agent-a505fbd58da497fd6/`):
- `dogfood/frog.aix` — the reworked program; `dogfood/frog_reimport.aix` — the round trip
- `dogfood/renders/frog.png`, `frog_slices.png`, `frog_beauty.png`, `frog_reimport.png`
- `out/frog/` — the final full render (`model.glb` 4.27 MB, `model.obj`, `report.md`); `out/frog_before/` — the baseline render of the inherited program; `out/frog_reimport/`
- The round-3 inputs did not exist in this worktree (only in the main checkout, uncommitted), so I copied `dogfood/round-3/*` and the two `round-3_frog*.png` in unchanged to read them.

## 1. Reading the inherited program

**Clear:** the header comment (lines 1–4) matched the code; materials first, then pad, body, face, eyes, feet, legs, assembly, one named step per line; `mirror(…, "x")` for symmetry; the decal chain `skinned → bellied → mouthed → faced` was easy to follow once I knew `decal` adds no geometry; `union(k=)` + `displace` for the body; the mouth as a `curve` fed to `tube` used purely as a decal region. `check` in one second gave every box and confirmed my reading of the sizes.

**Had to guess or compute by hand:**
- `notch = extrude(polygon(0,0, 3,-0.9, 3,0.9), 1) | rotate(y=-35)` (line 18): which way a `-35` turns a +x wedge. I had to work out from the docs that positive y turns +z toward +x, so negative turns +x toward +z, i.e. front-right, and then confirm it in the top view.
- The legs (lines 53, 56) are bare nine-number lists. The comment says hip→knee→ankle, but which triple is the knee, and whether the knee is up and out, is only checkable by reading the baseline `steps.png` thumbnail 21 (a Z-shaped bar floating beside the body).
- `displace(0.02, 0.18, 2)` (line 28): the third positional argument is `seed`; only the reference says so.
- Eye/pupil numbers (`0.54, 2.22, 0.45` and `0.86`): the pupil's z is eye z + r − 0.04 but is written as a literal; nothing says the sphere is meant to sit half-buried in the head.
- `belly_m`/`pupil_m` carry an `_m` suffix while `skin`, `leaf`, `eye_white` do not; `move(0, 0, 0)` on line 49 is a no-op left behind.

**A real bug the previous report did not mention:** the webbed foot. `extrude()` lays a profile with its y along −z, so the web polygon `(0,0, 0.32,0.5, 0,0.58, -0.32,0.5)` on line 49 landed *behind* the heel while the toes point +z. `check` shows it (`back_foot … z 0.01..1.2` for a foot placed at z 0.65) and thumbnail 22 of the baseline steps sheet shows a flat plate pointing backward. The report describes "three toes joined by a thin web"; the web never was between the toes.

**Also by arithmetic:** the original right back foot at (1.2, 0.65) is at 28° from +x, inside the notch wedge (18°–52°), so its centre hung over the hole; in the baseline top view the foot straddles the notch's edge. And the ground()+0.19 lift puts the feet about 0.04 above the pad top (the torso bottom, not the feet, was the lowest point), so the model was one piece only because the legs join the body.

**Did the report match?** Mostly. Its structure and friction log were accurate (I reproduced the misattributed watertight edges, the slice colouring, the quick-pass `vein` warning, and the slow import). It missed the web bug and the foot-over-notch, and its "feet floated, fixed by ground()" claim is not what the arithmetic says.

## 2. Print-readiness: before and after

| Row | Before (round-3 program, my baseline render, grid 128) | After (`dogfood/frog.aix`, grid 160) |
| --- | --- | --- |
| Pieces | 1 | 1 |
| Watertight | no: 37 edges (blamed on `belly_region`, `torso`, `head`) | **yes** |
| Stands | yes, CoM 2.094 inside footprint | yes, CoM 2.094 inside footprint |
| Overhangs | 7% of the surface faces down more than 45° | **none steeper than 45°** |

What changed, all in the program:
- **Body:** the torso's widest ring sits 0.35 above the pad (`torso_y`) so the flank slopes inward all the way up; the head is wider than the torso but blended with k=0.3 so its underside is a ≤37° slope. Everything is trimmed at `floor_y` inside the pad by `eyed & keep` (line 142) so nothing sunk into the pad pokes out underneath.
- **Eyes:** centres a hair below the head's surface, `union(k=0.12)` (line 140) so the underside is a fillet (a lid), not a hanging sphere.
- **Legs:** the floating Z-shaped tubes became a dome haunch whose centre is at the pad's top (no face looks down), a shin lying along the pad sunk 0.08, and arms pressed 0.05 into the chest at 27° off vertical; feet sunk into the pad by more than a cell.
- **Contacts:** the whole frog is a smooth union with the pad (`k=0.1`, line 143), haunches/arms with the body (`k=0.25`), and the foot's own parts (`k=0.05`). Iterations: 37 → 3 edges (toe grooves narrower than a cell where the toes diverge) → 1 edge (left arm tangent to the chest) → 0.
- **Notch:** slimmer, rounded tip, moved to the front under the chin, where no foot sits over it.
- **STL:** the brief says a full render writes `model.stl`; this checkout does not (no file, no flag in `render --help`, no mention in the docs). I shipped `model.glb` and `model.obj`.

## 3. The improvements

1. **The webbed foot fixed and blended** (lines 109–120): web drawn on negative profile y so it lands between the toes; heel, toes and web joined with `k=0.05`. Visible in steps 34/37 and the top view.
2. **The pose** (lines 122–136): folded haunches pressed on the flanks, shins along the pad, feet turned 35° outward, arms hugging the chest. The original legs were bars in the air beside the body; this is both the frog's natural squat and what made overhang and watertightness solvable.
3. **The eyes** (lines 88–106): amber iris, black pupil and a white glint as nested decals, positioned from named numbers (`iris_y = eye_c_y + eye_r * 0.3`), plus lids from the blend. The most visible change in the beauty render.
4. Also: dark back spots as a decal (lines 72–80), a lotus bud with six petals in a sepal cup (lines 53–59), and the notch redesign.

## 4. Friction

- `Watertight | no: 3 edges … x -1.254..1.365 … in 'belly_region', 'torso', 'mass'`: three edges from two unrelated defects (both mirrored toe grooves and the left arm tangency) were reported as one box; the attribution picked the steps whose boxes contain that box's centre, which was the body, nowhere near any edge. Expected the step(s) under each edge (`back_foot`, `front_arm`). Worked around with a `--focus back_foot` render and hand geometry; cost two iterations.
- `frog = eyed & keep` (line 142): `slices.png` paints the frog's lower interior grey (the unpainted `keep` box's material wins inside), as if there were an internal part. Same class as the previous agent's decal note: the slice fill shows which shape's material wins, not solidity.
- `--focus back_foot`: the front arm's outer 0.01 inside the frame appears as a thin vertical blade rising from the pad; it looks like a sliver defect until you know the frame clips.
- Line 49 in the original / `vein` here: `--quick` still warns "`vein` thinner than this pass's cell" for a decal-only region.
- The web polygon (line 119): `extrude` maps profile y to −z, so a profile drawn "up" points to the back. Documented, but it silently produced the inherited bug; I had to draw the web on negative y and say why in a comment.
- Placing anything on a blended surface (mouth curve line 82, nostrils 85, spots 74–79, eye seat 93): no way to ask for the surface point at an (x, y) on the side of a shape; `height()` only marches down in y. I solved the ellipsoid equations by hand and left the formulae in comments; the previous agent's literals had no such trace.
- `check` prints no `def` bodies; `foot()` was judged only through `back_foot`'s thumbnail.
- `Materials | custom, #6db85a, custom, custom, …` (13 entries): unreadable; cannot tell which material is which.
- `import("../out/frog/model.glb")`: 19.9 s to sample 140k triangles at the default resolution 96 (cell 0.046, coarser than the source's 0.028), on top of a 1.2 s mesh.
- The Overhangs row says "none steeper than 45°" with no number, so there is no way to see how close a change came to the threshold; and the docs never state the convention (a face counts when its normal is more than 45° below horizontal), which I inferred from the wording.
- `report.md` says a full render writes STL in the brief, not in the tool (above).

## 5. Re-import comparison

| | original (`out/frog`) | re-import (`out/frog_reimport`) |
| --- | --- | --- |
| Size (surface extent) | 4.4 × 2.48 × 4.38 (bounds 4.5 × 2.64 × 4.5, padded by the blends) | 4.401 × 2.481 × 4.38 |
| Triangles | 140,128 at cell 0.028 | 92,536 (sampled at cell 0.046, meshed at 0.034) |
| Volume / CoM | 9.659 / (−0.013, 0.769, 0.07) | 9.65 / (−0.013, 0.769, 0.07) |
| Watertight / pieces / stands / overhangs | yes / 1 / yes / none | yes / 1 / yes / none |
| Materials | 13 | clay only |

Survives: pad, notch, eye domes, haunches, shins, feet with toes and webs, the fillets, the bud (its petals fuse into a star-shaped lump). Gone: every decal (veins, belly, spots, smile, nostrils, iris, pupil, glint) and the skin speckle — expected for a geometry-only import — and the finest grooves between toes are softened by the coarser sampling.

## 6. Three changes that would most help an inherited program

1. **Named points and surface queries in the language.** `knee = [1.25, 0.95, -0.3]` usable inside `tube(r, [hip, knee, ankle])`, and `surface(shape, x, y, z)` (nearest surface point) or `on(shape, target, …)` so a mouth, a nostril, a spot or an eye can be *declared* to sit on the head instead of being nine literals that only the author could derive. That would have removed every hand-solved ellipsoid in this file and every opaque literal in the inherited one.
2. **Report defects per cluster, attributed to the innermost geometry step, never to a region or a blend input**, with the point; colour slices by surface material only; print `def` bodies once per call. Both agents lost iterations to the same misattribution.
3. **Docs/tool for readers, not just writers:** a short "reading someone else's program" section (extrude's y→−z, how a rotated wedge turns, that `check` boxes are padded by `union(k)`), an `aixle explain` that lists each step's role (geometry / decal region / number / unused) as a tree under the output, and make the STL claim true or remove it.
