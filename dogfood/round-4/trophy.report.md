All 14 renders are used and every deliverable is in place. Final report follows.

## Report: taking over the round-3 trophy

Files (all under `/home/user/aixle/.claude/worktrees/agent-aa6a5d0dc6d39f0b1/dogfood/`): `trophy.aix`, `trophy_reimport.aix`, and in `renders/`: `trophy.png` (sheet), `trophy_slices.png`, `trophy_focus_nameplate.png`, `trophy_focus_rim_text.png`, `trophy_beauty.png`, `trophy_reimport.png`. Full outputs in `out/final/` (incl. `model.glb`, `model.stl` 24.8 MB) and `out/before/` (the inherited program rendered unchanged). Note: the worktree was 4 commits behind the branch that carries round-3 and `hollow()`; I fast-forwarded it before starting.

### 1. Reading the inherited program

**Clear:** the part list (a comment per group), the bottom-to-top order, `revolve(polygon)` for the cup, `wrap` for the rim text, `mirror` for the handles. Every step name matched what the steps sheet showed.

**Had to guess or render to find out:**
- The cup's polygon is an outer flank then an inner return; the comment says "wall 0.13, bowl 0.28 thick at the bottom" and I had to subtract point pairs to confirm it. The `Cavities` row and X=0 slice were the proof.
- The handle `curve` starts at `(0.55, 3.2)`. Only after working out the cup's inner radius at that height (0.6) did I see the start is *inside the void*; the Z=0 slice shows two silver stubs inside the cavity. The previous report does not mention it.
- `line1` at `move(0, 0.34, …)` with size 0.18 + weight: `check` shows its box y 0.315..0.545 while the plate ends at 0.53, so "CHAMPION" is cut right through the plate's rounded top edge. The report calls the nameplate fine; the round-3 beauty shows the letters touching the edge. Not stated anywhere in the program.
- Every y is a literal (`move(0, 0.95, 0)`, `2.33`, `2.55`, `4.5`, `4.86`) with the overlap arithmetic in comments ("0.02 into the stone", "stands 0.05 proud" – the last one is wrong: 1.22 − 1.15 = 0.07). Changing one height means re-deriving the five above it. The foot/stem/lid overlaps are 0.01, under a cell, only discoverable by reading the box columns.
- `sweep(ellipse(0.14, 0.09), …)`: which ellipse axis goes across the path had to be read off the right view.

**Previous report vs what I found:** accurate on what it claims (the lid precedence fix is in the code, the cavity is real, the finial floats no more). Its "no warnings" was the tool of that time: today's tool reports Cavities 3.078, Overhangs 8%, 137 non-manifold edges. It omits the handle stubs in the void and the line1/plate-edge overrun.

### 2. Print-ready: before → after (from `out/before/report.md` and `out/final/report.md`)

| Row | Inherited (grid 240) | Final (grid 360) |
| --- | --- | --- |
| Pieces | 1 | 1 |
| Cavities | volume 3.078 at (0, 3.85, 0) | none |
| Watertight | no: 137 edges (rim_text/cup, handle ellipse tips at z ±0.14) | no: 116 edges, all at acute stroke junctions of the rim lettering (A, W, N, R); see friction |
| Stands | yes (CoM 1.678 inside footprint) | yes (1.691 inside) |
| Overhangs | 8% | 1% |
| Size / volume / tris | 3.75 × 5.45 × 3.54, 11.8, 337k | 3.4 × 6.34 × 3.46, 18.2, 497k |

What I changed: **filled the cup** (the profile is now a solid revolve). I chose fill over `hollow()`: the void's walls (0.13 / 0.28) are thicker than a practical shell wall, so `hollow(trophy, wall, 0,0,0)` would add a second drained void under the base yet leave the cup's own void enclosed, and a drain through 2.5 units of stem would show under the base; a filled cup is what a slicer wants and the lid hides it anyway. **Overhangs**: the handles are now rods on a polyline whose two legs are ≤ 42° from vertical (a rod's normals are all perpendicular to its path, so nothing faces down more than the leg's tilt); the bowl's flank climbs at ≥ 50° everywhere with its bottom disc buried in the knop (the old profile had a 34° segment plus a flat downward annulus); the collar is a cone instead of a disc; the lid revolves from the band's own radius (the old cone was 1.2 on a 1.15 band, a downward ring); the nameplate stands 0.06 proud rather than 0.14. **Watertight**: the sweep's 62 open edges are gone (tube), the lid-seam cluster is gone (same radius), lettering gaps are ≥ 2 cells (`spacing=0.025`, weight 0.04, grid 360). Legibility: both focus sheets read every letter.

### 3. Improvements (beyond print-readiness)

1. **Structure/readability**: `def on(part, below, sink=0.04) = part | move(0, top(below) - bottom(part) - sink, 0)`; every part stacks by the measured top of the one below, dimensions are named (`base_w`, `plinth_h`, `cup_h`, `band_h`, `cup_r`), the engraving is a `def` and the two baselines are computed from the plate centre and a `line_gap`. Lengthening the stem from 1.3 to 1.55 moved nothing else by hand.
2. **Base and materials**: a bevelled `loft` between plinth and step, and the step in a black marble (`material("#2b2b31", "marble", "#8a8a94", scale=0.45)`) so the base reads as two stones and the silver plate has contrast.
3. **Proportions and composition**: longer stem (cup:stem closer to 1:1), a pear-shaped convex bowl instead of the near-cone the 45° rule first gave, a thicker star on a boss; beauty with `set zoom 1.05`, `azimuth 18`, `elevation 18`, `light_size 1.5`, `ambient 1.2`, chosen after one `--quick --beauty`.

### 4. Friction

- `handle = sweep(rect(0.24, 0.16, round=0.02), handle_path, smooth=4)` on an in-plane polyline: expected a flat strap. Got two tapering blades meeting in a spike that reached x 1.80 while the step's box said 1.74 — the profile rolls about the path and the smoothed curve overshoots its bounds — and the report showed **62 open edges**. Workaround: `tube(0.1, handle_path)` with no smoothing.
- `check` printed the quick-pass warning as `(line1, line1, line2, line2, rim_text, rim_text)`: every name twice.
- `--focus nameplate` / `--focus rim_text` reports carry the **whole model's** Watertight row verbatim (identical text in all three reports), so the focus mesh, extracted at cell 0.009, is never measured.
- Watertight cluster `at (-0.956, 4.883, 0.705) in 'rim_text', 'cup'`: the text was at y 4.55..4.76; the edges were the lid cone's seam (r 1.16 on the 1.15 band). Attribution is by nearest bounding box, and it cost an iteration.
- Lettering never becomes watertight: 137 edges at cell 0.026, 116 at 0.018, all at acute stroke junctions where the gap between two strokes tapers below any cell. The message says "raise the grid or thicken it"; neither can work there. (`offset(+r) | offset(-r)` to close the wedge is the identity on a true SDF, so there is no user-side fix.)
- `text("AWARD OF EXCELLENCE", 0.16, weight=0.06)`: the E arms' gaps were 0.02 = 0.8 cell and `check` said nothing (line2 at 0.44 cell was warned), yet the mesh had edges there. The counter warning's threshold looks like 0.5 cell; the mesh needs ~2.
- `set zoom 1.3` (guide suggests 1.4): the 1024 beauty cropped the nameplate and star. Nothing says the frame was clipped; 1.05 was the most this tall model allowed.
- `loft(rect(…), rect(…), 0.2)` spans y 0..h, not centred like `extrude`; the reference says only "a solid h tall". `check` showed it; the docs did not.
- Materials row: `marble*, custom, gold, silver` — my black marble is "custom", the two marbles collapse to one starred name.
- `import("out/final/model.glb")`: 39 s at the default resolution with no progress line, as in the previous report; surface extent came back as `y -0.001`.
- Speck warning now has a location and step (the previous agent's request) but reported `Pieces 2 (… then 0 at …)`: a zero-volume piece.

### 5. Re-import (`trophy_reimport.aix`, default resolution 96, sampled at cell 0.066)

Size 3.4 × 6.323 × 3.467 vs 3.4 × 6.34 × 3.46 (mesh extent identical to 6.323); triangles **59 760 vs 496 556**; volume 18.158 vs 18.22; Pieces 1, Cavities none on both; Watertight 7 edges vs 116; Overhangs "none" vs 1% (the sampling smooths away the small downward faces). Survives: base steps and bevel, plate outline, fluted twist (softened), knop, bowl, band, lid, post, star, both handles. Lost: all materials (one clay colour), the engraving (a smear), the rim text (a bumpy band; "…EXCELLENCE" is guessable in the front view only).

### 6. Three changes for inherited programs, in order

1. **Relative placement in the language** — a builtin `on(part, below, sink=)` / `stack`, or at least the `top() - bottom()` idiom in the guide — so programs stop carrying hand-added heights and overlap comments that go stale (the inherited file's "stands 0.05 proud" was wrong).
2. **Make the report say what touches what**: per step, the overlap with its neighbours (foot/step: 0.01 — under a cell) and the material; and attribute non-manifold/open-edge clusters to the steps whose surfaces are actually there, not the nearest box.
3. **Docs/tool on lettering and sweeps**: state that stroke junctions always leave a few non-manifold edges (and stop advising a higher grid for them, or fill the wedge in the font), warn on counters under ~2 cells, document `loft`'s y range, and either fix or warn about `sweep` with a non-round profile plus `smooth`.
