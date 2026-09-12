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

## Running a round

Each agent gets the same instructions: work in a worktree, read only the
skill and the docs, build the brief, follow the loop, iterate on the
beauty render, read every picture, keep a friction log, and end with a
report of the model, every point of friction with the line and the
message, what worked, and the three changes that would have helped most.
The reports are copied here verbatim and the fixes are made in the same
change, so the record and the code move together.
