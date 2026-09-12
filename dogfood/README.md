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

## Running a round

Each agent gets the same instructions: work in a worktree, read only the
skill and the docs, build the brief, follow the loop, iterate on the
beauty render, read every picture, keep a friction log, and end with a
report of the model, every point of friction with the line and the
message, what worked, and the three changes that would have helped most.
The reports are copied here verbatim and the fixes are made in the same
change, so the record and the code move together.
