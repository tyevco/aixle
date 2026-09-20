# Dogfooding

Aixle is meant to be used by language models, so the test of the tool is
whether a fresh agent, given only the docs, can build something and see
what it built. Each round, a few agents are each handed a brief and a
worktree, told to read only the skill, the guides, the reference and a
couple of examples, and to keep a friction log while they iterate until
the renders look right. Their programs, probes and reports are kept
here, unchanged, and every point of friction is answered in the tool or
the docs, or listed as not done.

The programs are rendered by `npm run dogfood` into `dogfood/renders/`
(the sheet and the beauty render for each, at the examples' size, named
`round-N_model`), and
CI regenerates them like the examples, so they keep working as the tool
changes: a dogfood program that stops rendering is a regression.

| Round | Model | Program | Report | Verdict at the time |
| --- | --- | --- | --- | --- |
| 1 | Park bench | [`round-1/bench.aix`](round-1/bench.aix) | [report](round-1/bench.report.md) | built in two renders; ten friction points, all but one fixed |
| 1 | Lighthouse scene | [`round-1/lighthouse.aix`](round-1/lighthouse.aix) | [report](round-1/lighthouse.report.md) | built in three renders; the report misjudged the floor and small parts were unreadable, both fixed |
| 1 | Anglepoise lamp rig | [`round-1/anglepoise.aix`](round-1/anglepoise.aix) | [report](round-1/anglepoise.report.md) | built; `set pose` failed as documented and poses could not be verified, both fixed |
| 2 | Frog on a lily pad | [`round-2/frog.aix`](round-2/frog.aix) | [report](round-2/frog.report.md) | presentable in ten renders; `ground()` lifted it off its pad, eyes and mouth needed geometry, both fixed |
| 2 | Hydraulic excavator rig | [`round-2/excavator.aix`](round-2/excavator.aix) | [report](round-2/excavator.report.md) | every joint and cylinder verified; loose posed bounds broke focus and cost resolution, fixed |
| 2 | Market stall scene | [`round-2/market.aix`](round-2/market.aix) | [report](round-2/market.report.md) | ten objects, nineteen materials; stripe direction, focus and lighting were the cost, all fixed |
| 2 | Award trophy | [`round-2/trophy.aix`](round-2/trophy.aix) | [report](round-2/trophy.report.md) | product-photo quality; text round the rim and metals that looked like metal were missing, both fixed |
| 3 | Frog on a lily pad, again | [`round-3/frog.aix`](round-3/frog.aix) | [report](round-3/frog.report.md) | presentable in seven renders with decals and a curve; found the extraction box clipping a thin pad, fixed |
| 3 | Hydraulic excavator, again | [`round-3/excavator.aix`](round-3/excavator.aix) | [report](round-3/excavator.report.md) | six extra joints keep every cylinder pin-to-pin; nested joint angles were undocumented and no builtin read the pose, both fixed |
| 3 | Market stall, again | [`round-3/market.aix`](round-3/market.aix) | [report](round-3/market.report.md) | eleven objects with a lit lantern; a silent empty intersection and the clipped ground slab, both fixed |
| 3 | Award trophy, again | [`round-3/trophy.aix`](round-3/trophy.aix) | [report](round-3/trophy.report.md) | product-photo quality in nine renders; a cavity reported as a loose piece and a star reported as a speck, both fixed |
| 4 | Frog, inherited | [`round-4/frog.aix`](round-4/frog.aix) | [report](round-4/frog.report.md) | watertight with no overhangs from a program it read cold; found a webbed foot the round-3 report never mentioned; open edges were blamed on the wrong step, fixed |
| 4 | Excavator, inherited | [`round-4/excavator.aix`](round-4/excavator.aix) | [report](round-4/excavator.report.md) | six cylinder joints replaced by `angle()`, a real bucket, one open edge left; `--focus` in a pose framed the rest position and `check` hid profiles, both fixed |
| 4 | Market stall, inherited | [`round-4/market.aix`](round-4/market.aix) | [report](round-4/market.report.md) | one piece from two, overhangs down, fruit-on-fruit contacts left; a zero-volume piece and a quick pass's pieces count were noise, both fixed |
| 4 | Trophy, inherited | [`round-4/trophy.aix`](round-4/trophy.aix) | [report](round-4/trophy.report.md) | overhangs 8% to 1%, cup filled for the slicer; rim lettering never watertight, which was the space between its letters, now warned |
| 5 | Grandfather clock | [`round-5/clock.aix`](round-5/clock.aix) | [report](round-5/clock.report.md) | watertight, one piece, 4.5% overhang in 15 renders; the gap warning did not say which gap and glass hid the pendulum on every sheet, both fixed |
| 5 | Treehouse scene | [`round-5/treehouse.aix`](round-5/treehouse.aix) | [report](round-5/treehouse.report.md) | four objects, one piece, in 11 renders; open edges blamed on a branch's parent and zero-volume voids called cavities, both fixed |
| 5 | Bicycle | [`round-5/bicycle.aix`](round-5/bicycle.aix) | [report](round-5/bicycle.report.md) | 76 steps of tubes between named points, a raked steering pose; the watertight row pointed inside a hub and the raked axis needed an Euler triple from a script, both fixed |
| 5 | Sailing dinghy | [`round-5/sailboat.aix`](round-5/sailboat.aix) | [report](round-5/sailboat.report.md) | lofted hull, bellied sails, six rigging lines fitting to fitting by anchors; a white sail read as absent for nine renders and the loft doc was wrong, both fixed |
| 6 | Chess set | [`round-6/chess.aix`](round-6/chess.aix) | [report](round-6/chess.report.md) | thirty-two pieces from the agent's own library in 16 renders; placed copies lost their nodes under `+` and a scene's report judged the fused union, both fixed |
| 6 | Footbridge | [`round-6/footbridge.aix`](round-6/footbridge.aix) | [report](round-6/footbridge.report.md) | two Warren trusses with bolted gussets, watertight, in ten renders; the beauty camera left a diagonal model small and a re-import's plank edge lay on a sample plane, both fixed |
| 6 | Café terrace | [`round-6/terrace.aix`](round-6/terrace.aix) | [report](round-6/terrace.report.md) | a terrace with the shipped plants, one piece, in 15 renders; open edges came with a where but no why (equal-radius crossings, a curve bent tighter than its tube), now said at the step or in the guide |
| 6 | Playground | [`round-6/playground.aix`](round-6/playground.aix) | [report](round-6/playground.report.md) | seven objects and two rigs from the shipped libraries in 13 renders; the shipped chain was never watertight and a bench's slats under the scene's cell drew no warning, both fixed |
| 7 | Marionette (Roblox rig) | [`round-7/marionette.aix`](round-7/marionette.aix) | [report](round-7/marionette.report.md) | ten joints, six poses and three clips right first time in nine renders; a rest-size assert failed in the jump pose and the joint tree was nowhere to read, both fixed |
| 7 | Fox (Bedrock entity) | [`round-7/fox.aix`](round-7/fox.aix) | [report](round-7/fox.report.md) | eleven cubes, eight bones, three clips exported in 11 renders; decals reached no face texel and a sitting pose was judged to tip on its tail tip, both fixed |
| 7 | Jack-in-the-box | [`round-7/jack.aix`](round-7/jack.aix) | [report](round-7/jack.report.md) | axis-joint lid and crank, a clown on a helix spring, in seven renders; the sheets re-meshed the shut box a dozen times a render and no bar said one-shot, both fixed |
| 7 | Quadcopter | [`round-7/drone.aix`](round-7/drone.aix) | [report](round-7/drone.report.md) | eleven nested joints and four clips in 14 renders; a gimbal ten pixels wide could not be judged on any sheet and a lifted pose was told it would tip over, both fixed |

Probes the agents wrote to measure what the docs did not say:
[`round-2/market_stripes_probe.aix`](round-2/market_stripes_probe.aix)
(which axis stripes stack along) and
[`round-2/trophy_metals_probe.aix`](round-2/trophy_metals_probe.aix)
(how the metal presets render). Round 3's `*_reimport_probe.aix` files
are the GLB round trips (they import from the agent's own `out/` folder,
so they run only after that model's render). Probes are kept but not
rendered.

Round 3 re-ran round 2's four briefs against the fixed tool with fresh
agents, to measure whether the fixes removed the friction. They did: the
round-2 complaints did not recur, and every agent used the new features
as documented. What they found instead were the next layer (a regression
in the extent pass, misreported pieces, silent empty intersections) and
the export path, which the brief now covers: each agent shipped a GLB,
tried a headless-browser screenshot of the viewer page (blank in this
sandbox, whose proxy drops the browser's connection to the three.js CDN)
and re-imported the GLB through `import()` to compare.

Round 4 changed the shape of the exercise: each fresh agent inherited a
round-3 program, its renders and its report, had to read and understand
it, make it print-ready (one piece, watertight, standing, low overhang,
an STL a slicer takes) and improve it, and verify the result by the
beauty render and a GLB round trip. What they reported was the cost of
working from someone else's program: defects named by the assembly
rather than the part, posed parts framed and listed where they were
built rather than where the pose put them, profiles invisible to
`check`, and a report with rows that hid the number. One agent's own
diagnosis was wrong in an instructive way: the trophy's hundred open
edges were read as acute stroke junctions, and a smooth minimum across
the strokes was tried and changed nothing (29 edges to 30); the edges
were neighbouring letters whose strokes came within a third of a cell of
each other, which the letter spacing now reports as a gap.

Round 5 was four new subjects (a grandfather clock, a treehouse scene, a
bicycle, a sailing dinghy) chosen because each needs parts placed
against parts, to measure whether fresh agents reach for the anchors
built after round 4 without being told. Two of four did: the dinghy's
rigging runs fitting to fitting by `at()` and `anchor()` and its
mainsheet follows the boom's pose, and the bicycle used nested point
lists for every tube; the clock and the treehouse used none, and did
not miss them. The rest of what they found was the tool's, answered
below. The dinghy's `sailboat_probe_A.aix` to `_G.aix` were whole
copies of the model at different grids and are not kept; its named
probes are.

Round 6 was four new subjects (a chess set, a footbridge, a café
terrace, a playground) with `use` and the three shipped libraries
available, to measure whether fresh agents reach for libraries. Three
of four did: the chess set wrote its own piece library and used it, the
terrace took its plants from `std/plants`, the playground its bench, bin
and chain from `std/furniture` and `std/hardware`; the footbridge used
none and did not miss them. What the libraries cost was the round's
finding: a shipped chain whose hooked links touched tangentially and was
never watertight, a bench whose slats were thinner than the scene's
cell with no warning, a bush twice the size its comment said. A
check-time contact audit (two faces within a cell of each other, a cap
through a face) was tried from the steps' boxes and dropped: it fired on
nearly every model. The chess agent's export-node probe is kept as
`chess_nodes_probe.aix` (the report calls it `chess_probe_nodes.aix`)
so the render set skips it like the other probes.

Round 7 was four rigs (a marionette for Roblox, a fox for Bedrock, a
jack-in-the-box, a camera quadcopter) with pose transforms, timed and
eased animations and both game exports available, to measure whether
fresh agents can build, pose, animate and export a rig from the docs.
All four rigs were right first time: no part swung about a wrong pivot,
every nested joint followed its parent, and the strips showed the
timing the programs asked for. What cost renders was around the rig:
`check --pose` numbers printed at two decimals on a 0.4-unit drone; a
gimbal or a crank a few pixels wide on a whole-model thumbnail; a
promise about the model's height failing in its jump; a Bedrock decal
that never reached the face texture; sheets that meshed the same shut
box a dozen times a render. Their reports' three changes each are
answered below; the marionette's re-import probe and the drone's and
jack's are kept and skipped by the render set like the others. Not
done: a default import resolution that follows the grid (the grid is a setting
of the program being evaluated), an offline viewer (three.js is loaded from a CDN by design); the
drone's report of a joint step turned by the pose getting no `posed`
line did not reproduce on its final program (the line is there).

## What each round changed

**Round 1** (bench, lighthouse, anglepoise): overload errors name only
the overloads that fit; unclosed calls name their line; `check` prints
thin-part warnings and the cell; `tube(cap="flat")`; the ground note,
floor grid and surface-extent row read the mesh; `height()` and the
bounds queries; `--focus`; `material(preset, scale=)`; scene slices
through the first object; `set pose name` as a bare word; `--pose` on
render and check; finer pose sheets framed from their meshes; feature
sizes carried by shapes so thin walls, tubes and strokes are warned
about; the rotation sign, extrude mapping, helix origin and text padding
documented; a worked rig snippet.

**Round 2** (frog, excavator, market, trophy): `ground()` and check's
floor note read the surface by rays; extraction over the surface's true
extent; `--focus` as a close-up that also frames the beauty render and
the slices; `decal()`; `wrap()` and an exact `bend`; metals that reflect
the scene; `set light_azimuth`, `set light_elevation`, `set ambient`,
`glow=`; pattern `axis=`; folded thin warnings and a quick pass that
says what it dropped; loose pieces and non-manifold edges located and
named; number steps in `check`; `--no-poses`; the implicit rest pose;
docs for loops over lists, two-ended rig members, `pose` in a `def`,
pattern orientation, `--out`, `--quick --beauty`.

**Round 3** (the same four briefs, fresh agents): extraction extents
found by rays from the bounds' faces with a clipping safety net (the
coarse pass introduced in round 2 clipped a thin lily pad and a market's
ground slab); `decal` regions are skins outside the geometry tree, so
they get no thin warnings, no attribution, and cross-sections show the
base material under them; cavities told apart from loose pieces by the
sign of their volume and listed in their own row; specks judged by
extent as well as volume, with a location; loose pieces and bad edges
attributed by the field and by final placement, and bad edges reported
as clusters; `--focus` slices cut through the focused object in scenes
too; the clip faces of a close-up keep the model's material; a warning
when `&` removes everything; a warning when a union joins painted and
unpainted parts; a warning for letter counters under a cell; `set zoom`
for the beauty camera; `angle("joint")` reads the current pose and
`list[i]` indexes a list; numbers print whole (-100 no longer -1); docs
for nested joint angles being relative, text width and legibility,
`wrap` arc angles, `tiles` orientation, the sheet's per-vertex colouring,
`--quick --beauty` limits, and what `import` keeps.

**Round 4** (round-3 programs inherited by fresh agents, print-ready
as the bar): loose pieces and open edges named by the innermost step
whose surface passes there, found by walking the shape tree with each
transform's inverse, then its nearest named parent; `--focus` frames a
step where the pose puts it and the close-up gets its own watertight
row; `check` lists 2D profiles and number lists, prints a `surface`
line under a turned box and a `posed` line under a step inside a turned
joint; the space between letters counts as a gap, with a softer warning
between half a cell and a cell; a warning when a union paints over parts
that had materials, and when a program names a step after a builtin it
also calls; `surface(shape, x, y, z)` for the nearest surface point;
nested point lists in paths; `a & b` keeps a's material like `a - b`; a
sweep's box allows for its mitres; the beauty camera fits the box's
corners rather than its sphere; zero-volume pieces dropped; the pieces
count not judged on a quick sheet that dropped thin steps; custom
materials named after their step; the overhang row always a number;
`import` says it is sampling before the wait; `check`'s cell to three
figures; docs for `loft`'s frame, the side-profile flip, the `angle()`
cylinder pattern, contact versus overlap, the thin threshold, and the
outline a cross-section draws just behind its plane.

**Round 5** (new subjects, anchors available): `joint(..., axis=)`
turns about one axis and a pose gives it one number; open edges are
placed at an edge on the model with the steps whose surfaces meet
there, "with itself" when one step's surfaces cross, a plane note when
they all lie on a sample plane, and a tally per step; the lettering
warning names the gap (the counter of a, the space between A and W);
glass on the sheets, pose sheets and strips is a screen door so what
is behind it shows; the quick pass steps its grid up on a model of thin
parts and judges neither pieces nor footprint when it dropped any;
attribution ranks by closeness first; `check --pose` measures a step's
surface through the joints' inverses; a parser warning when a named
step is transformed alone on the right of `+`; the views' grounds
darker and matte highlights softer so a white part lit face-on is not
the background; a move above a joint carried into the export's nodes
and a rotation above one reported; an import sampled coarser than the
render warns with the resolution to match; specks dropped from the
pieces and cavities rows; the beauty camera on the surface extent;
`surface()` with backtracking; the loft doc corrected (centred, as it
always was); docs for decal order, wrap and bend landing points, tubes
meeting at a point, the watertight thickness, `ground()` in a scene, a
tapered smoothed tube's joins, and the key light not reaching an
interior.

**Round 6** (new subjects, libraries available): a placed set keeps
its per-copy nodes under `+`, inside a joint and as an object, and can
be hidden; a scene's report judges each object on its own, with
`--focus name_3` for one copy; a cut that removes almost nothing warns;
the beauty camera and the perspective views fit the model's points
rather than its box; the sample lattice starts off the model's box so a
round coordinate misses the sample planes; the thin warning names the
thickness that clears the cell; a box's thinnest side and a cylinder's
diameter or height carry into any union, so a library part's slats and
rods are judged against the scene's cell; the std chain rebuilt as
square-wire links that overlap, with its length per link in its
comment, and the plants the size their comments say; open edges placed
exposed-first and said to be in one step "alone" or "twice, as 'a'
and 'b'" rather than "with itself", with every cluster in
`report.json`; a `curve()` bent tighter than its tube says so at the
step; the quick pass drops an import sampled finer than its cell rather
than judging its pieces; `aixle doc lib.aix` for a library; docs for
the STL and the report following the pose, the converse of the contact
rule, equal-radius crossings, a tube ending inside a thin plate, the
shallow wedge, and what a re-import costs.

**Round 7** (rigs: marionette, fox, jack-in-the-box, quadcopter): the
pose sheet and the strips share a cache of meshes by pose, so the rest
pose and a held key are meshed once, and a quick pass draws the sheet
without the strips; `--focus` applies to the pose sheet and the strips,
each a close-up of the step where the pose puts it; `check` and the
report print the joints as a tree, joints made inside a `def` included,
and the pose sheet's bar names every joint, wrapped; a strip's bar says
`once` or `loop`, and the report's animations line gives each key's
second, the loop and the ease; asserts are judged at rest unless one
names its pose (`pose=pop`, added after the round with `ease_ends`, the
two language items the round left undone); a focus sheet, its slices,
its pose sheet and its strips draw the rest of the model faint around
the focused step, with a note under each caption (added after the round:
the drone's body clipped over its gimbal read as a plate); a posed
report's Stands, footprint and watertight rows say which pose, standing
is not judged when the pose lifts the model off the floor, and the
footprint is taken at y = 0 when a corner dips a little below it;
`check --pose` says a sunk or floating pose is the pose's doing rather
than suggesting `ground()`; `joint_move()` and `joint_scale()` read a
joint's pose beside `angle()`; the Bedrock face texture is painted from
the true surface behind each texel by bisection, so decals and skins
thinner than a voxel reach it, its unused texels are transparent, a held
value is two keys, and a clip's identity channels are left out of the
GLB; `check` runs the Minecraft thinness warning; the report's Minecraft
row says z flips for an entity; numbers below 0.1 print to three
significant figures in `check`, the report and the slice labels; the
reference lists the Roblox attachments with their limits; `xform`'s
defaults read as triples; docs for limb and axis signs, a swung leg's
lift, `move` after `scale` about the pivot, `at()` on a nested joint's
step, steps inside a `def`, loops and ease, full-turn keys, a bare call
as a statement, `--quick --no-poses`, the Bedrock lattice recipe and the
entity's keyframe conventions, and which Roblox budget a rig gets.

## Running a round

Each agent gets the same instructions: work in a worktree, read only the
skill and the docs, build the brief, follow the loop, iterate on the
beauty render, read every picture, keep a friction log, and end with a
report of the model, every point of friction with the line and the
message, what worked, and the three changes that would have helped most.
The reports are copied here verbatim and the fixes are made in the same
change, so the record and the code move together.
