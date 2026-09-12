# Hydraulic excavator: the agent's report

Round 2. Brief: a hydraulic excavator arm on a tracked base, about 8
units long, as a rig: tracks, a cab on a joint about y, boom, stick and
bucket on three joints about x, visible hydraulic cylinders between the
members, yellow-and-black machinery materials, at least three poses and
an animation; verify pivots, that cylinders stay attached in every pose,
and that the machine stands in each pose. The agent read only the skill,
the two guides, the reference and three examples. Ten render iterations
of fourteen.

What follows is the agent's report, verbatim. The "fixed" notes in the
index (`dogfood/README.md`) say what changed in the tool because of it.

## 1. The finished model

A yellow-and-black tracked excavator, 2.7 × 4.47 × 8.14 units at rest (8.9 long in reach), 54 named steps, 10 joints. Base: two rubber track loops (an extruded side profile with a tread-stripe material), yellow frames and iron wheels inside the loops, a crossbeam and a charcoal slew ring. Upper structure on a `swing` joint about y: house, hazard-striped counterweight, cab with navy window band, hood, exhaust, boom and cylinder brackets. Arm in the plane x = 0.4, three joints about x: a two-segment bent boom with a knee boss, a stick with a rear ear, a hollow bucket (box minus box) with an ear and four iron teeth, steel pin bosses at every pivot. Three hydraulic cylinders (twin boom cylinders, one stick, one bucket), each a charcoal barrel on the inner member and a chrome rod on the outer member, on their own joints at the anchors; per pose the aim angles come from trig `def`s so barrel and rod stay collinear and telescope. Poses rest, transport, reach, dig (dig also swings 25°) and a 4-second `cycle` animation. Everything in the plan got built; verification in the 1024-px right views and the X = 0.4 slice shows every rod on its barrel's axis and still inside it in the most folded (transport) and most extended (reach) poses, every joint pivoting at its pin boss, and the report says "Stands: yes", "Pieces: 1" in all four poses (dig's lowest point y = -0.001). The one thing not reached: the mesh is still "not watertight, 10 edges" and I could not find which feature causes it.

## 2. Friction log

- **Focus on a joint step does not zoom.** `--focus boom` (line 120, `boom = joint(..., "boom", ax, b0y, b0z)`) in `--pose transport|reach|dig`: I expected the views framed on the arm. The title changed to "EXCAVATOR → BOOM" but every view still showed the whole machine, and the perspective floor grid dropped to "FLOOR GRID 1 AT Y=-0.37", "-1.91" and "-1.04" below the tracks, because the rotated boom's loose bounding box (y down to -1.26 in reach per `check --pose reach`) is bigger than the machine. Workaround: `--size 1024 --views right` instead, which worked.
- **Loose rotated bounds cost grid resolution in posed renders.** `check --pose reach` prints `excavator 2.7 × 7.53 × 10.4, y -1.26..6.27` while the mesh extent is `y 0..3.38`, so the reach render got cell 0.052 instead of 0.040 and the beauty render framed the machine small (dig: bounds 5.94 × 5.26 × 9.32 vs surface 5.07 × 3.71 × 7.71). Nothing to do about it from the `.aix`; documented as a "limit" but it bites every rig.
- **The report says the mesh is not watertight but not where.** "Watertight: no: 18 edges shared by more than two triangles ... (a feature about a cell thin)". I guessed four candidates (teeth tips r=0.02 at line 98, exhaust r=0.07 line 66, window lip 0.02 line 64, track-frame gap 0.03 line 52), thickened all of them over two rounds, and got 18 → 10 edges; still 10 and no idea where. `check` had no warning at all for any of them at grid 200. A step name or a world position for the offending edges would have ended this in one round.
- **Pose thumbnails are too coarse to verify anything about cylinders**, and the `poses.png` title bar truncates the joint list at "STICK" (10 joints). `anim_cycle.png` frames are ~180 px; I could see the arm move but not whether a rod left its barrel. The docs do say to use `--pose` for judging; the `--pose` sheet's right view (512 px) was still marginal for a 0.16-thick rod, hence `--size 1024`.
- **Doc gap: no way to print a number.** I computed anchor distances (`d1`, `d2`, `d3`, lines 71/79/87) and the per-pose aim angles in `def cyl1..cyl3`, and wanted to see them to size the barrel/rod overlap; `check` prints only shape steps, number steps are silently omitted. I sized the overlap by hand (barrel 0.6·d, rod 0.85·d) and verified only visually.
- **Doc gap: pattern orientation.** `material("rubber", "stripes", ...)` on the track loop (line 51) gave stripes running along the track (bands stacked in y), invisible as tread. Neither language.md nor the reference says which axis stripes/checker/brick run along. Workaround: `track_loop | rotate(x=90) | paint(...) | rotate(x=-90)`, which worked because paint is anchored in the frame where it is applied (that part is documented).
- **Doc gap: a two-ended part in a rig.** Nothing in the rig docs covers a member connecting two moving bodies (a hydraulic cylinder). I had to invent the barrel-joint + rod-joint scheme and 15 lines of trig `def`s (lines 127–145) to aim them per pose; between keyframes the linear angle interpolation means the rod and barrel are slightly off-axis mid-animation (not visible at the strip's size). A worked example, or a `look_at`-style helper, would save an hour.
- **Guess: can `pose()` be called from a `def`, with expression angles?** `def stance(name, sw, tb, ts, tk) = pose(name, swing=[0, sw, 0], ...)` (line 142) worked on the first try, and bare `stance("transport", 0, -15, 50, -50)` as a statement raised no "computed but never assigned" warning. Undocumented; I only found out by trying.
- **`check --pose` for the dig pose reported the bucket 0.02 below the floor only indirectly**: the sheet's "FLOOR GRID 1 AT Y=-0.02" and the report's "footprint of the points within 0.07 of y = -0.022". No warning, no note. Fixed by boom 20→18°.
- **Sandbox, not the tool:** `mkdir -p dogfood/renders && cat > file <<EOF` was refused by the worktree guard, so the directory silently did not exist until the copy step failed. I wrote the file with the Write tool instead.
- **Slow-ish:** every full render is 20–32 s, of which meshing is 3–6 s; the report's timings show `poses 4095`, `anim:cycle 8377`, `hierarchy 2527` ms, so a rig pays ~15 s for thumbnails I could not read anyway. `--no-poses`/`--no-anim` flags do not exist (only steps/slices/turntable/export/viewer).
- **Quick render warnings are noise for a large model:** at `--quick` (cell 0.127) it warned exhaust, bucket_rod, bucket_cyl_b and teeth are "1.1 of the cell"; all fine at the real grid. Expected, but it means quick output has to be mentally filtered.

## 3. What worked well

- `check` on a 150-line file with nested joints, `def`s calling `def`s, `atan(y, x)`, `^`, and `pose` inside a `def` passed first time with zero warnings; the error-free path is genuinely solid.
- The joint model: build in place, pivot as a world point, nest by `+` inside the parent — the three arm joints and the swing all pivoted at their bosses on the first render, no adjustment.
- The sheet layout (front/right/top with unit grids) and `--pose NAME` re-rendering the full sheet; `--size 1024 --views right` gave exactly the diagnostic I needed.
- `set slice_x 0.4` moving the cut plane into the arm plane; the slice showed rods inside barrels and the bucket's hollow unambiguously.
- The physics section: "Stands: yes, centre of mass 1.34 inside the footprint", "Pieces: 1", per pose.
- `extrude(profile, h, "x")` for the track side profile, and paint-in-a-rotated-frame for pattern orientation.
- The beauty render with `--azimuth/--elevation` and `set azimuth/elevation/light_size` in the file was a presentable image on the second try.

## 4. Three changes that would have helped most

1. **Make `--focus`, the render grid and the beauty framing use the surface extent of a rotated/posed step, not its loose bounding box** (or at least tighten `joint`/`rotate` bounds). It broke focus, dropped the floor grid below the model, and cost resolution and framing in every pose.
2. **Name the culprit in the watertight/thin-feature report**: the step (or a world position) of the edges shared by more than two triangles, the way `check` already names thin steps. Two blind rounds would have been one targeted fix.
3. **A rig doc section (and example) for two-ended members**, plus a way to print numbers from `check` (e.g. list number steps, or a `print()`/`note()` builtin) and a line in the reference on which axis each pattern runs along. Together these were most of the time I spent guessing.
