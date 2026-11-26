# Roadmap: what the language needs next

Proposals, not promises. Each says why an agent would want it, what it
would look like in a program, how it would be built on what exists, and
what must be prototyped before building on it (the repo's rule: measure
first). They are ordered by how much they would change what an agent can
make, judged from three rounds of dogfooding. Items move out of here into
`design.md` when they are built.

## 1. Anchors: built

`anchor`, `at` and `attach` are in the language (see `language.md` and
the anchors section of `design.md`); every transform, warp and joint
carries them, unions merge them with the first part winning a name, and
`check` prints them. Round 5 measured it: two agents of four reached
for them unprompted (a dinghy's rigging fitting to fitting, with the
mainsheet following the boom's pose), two built a clock and a treehouse
without them and did not miss them. Nobody hit the first-part-wins rule.

## 2. PBR textures baked from the field

**Why.** The GLB carries one baked albedo atlas and per-material
metal/rough factors. A viewer shows flat plastic where the beauty render
shows displaced skin, brushed metal and a glowing flame, because those
live only in the field. "Beautiful" in a browser or a game engine needs
the rest of the PBR set.

**What.** No new syntax for the common case: the atlas baker writes a
normal map from the field's own detail (a `displace` or a fine pattern
becomes bumps on a coarser mesh), a metallic-roughness map wherever a
material varies them, and an emissive map from `glow`. Materials gain
what patterns already imply:

```
m = material("#8a6a3a", "rust", rough=0.9, metal=1, wear=0.3)   # edges worn to bright metal
p = material("plastic", bump=0.02, bump_scale=0.1)               # baked as a normal map
```

`wear` reads the field's curvature (second differences of `dist`, cheap
and exact) so convex edges brighten and cavities darken, which is what
makes a rendered object look used rather than new; the same curvature
feeds the beauty render.

**How.** `albedo()` becomes `surface()` returning colour, roughness,
metal, emission and a height; the baker already has the local point per
texel and calls the same function, so the three extra atlases are the
same loop; the GLB writer adds `normalTexture`,
`metallicRoughnessTexture`, `emissiveTexture`. Normals come from the
field gradient at the texel's surface point minus the mesh normal,
tangent-space encoded.

**Must prototype.** Tangent generation on dual-contoured meshes (charts
are axis-aligned, which helps); whether curvature from `dist` is stable
enough on blended shapes; atlas memory at four maps.

## 3. Modules: built

`use "path"` and `use "std/name" as x` are in the language, with
`std/hardware`, `std/furniture` and `std/plants` shipped and `aixle doc
lib.aix` documenting a library from its defs and comments. A library
runs in its own scope with its own uses, so its defs see only its own
names. Round 6 measured whether agents reach for the shipped libraries
and write their own: three of four did (one wrote its own piece library,
two took plants, furniture and hardware from `std/`), and what the
libraries cost (a chain that was never watertight, slats under the
scene's cell with no warning) is answered; the anchors a library def should carry so callers
place it without reading it (proposal 1, now built) are the next thing
to add to the shipped parts.

## 4. Printing: STL, hollowing, a print report: built

`set units mm|cm|m|in` says what one model unit is (a millimetre is
assumed without it, which is what a slicer reads an STL as, and the
report says so with the height that would print) and `set bed W D H` is
the printer's build volume in millimetres. Every full render's report has
a Print section: a summary, the unit, the size in millimetres, whether it
fits the bed square, turned about the vertical on the plate (the hull of
the vertices, turned a degree at a time), or only lying on a side, the
thinnest wall with where it is and the steps there (named as the
watertight row names an open edge), the support under the overhangs (a
ray straight down from every face the Overhangs row counts, to the plate
or the model below, its height times the face's area on the plate, split
into the part standing on the plate and the part on the model), what
rests flat on the plate, and the material in cubic centimetres and grams
of PLA. A bed the model fits neither square nor turned is a warning;
`check` prints the size and the bed's verdict from the surface's extent
(and a coarse mesh's outline when that box does not fit square) when a
program sets units or a bed. `wall(shape)` is the thinnest wall as
a query, for `assert wall(model) > 0.8`. `model.stl` is written in
millimetres with z up (it was y up, so a slicer laid every model on its
back), and `model.3mf` beside it when the program sets units or a bed or
`--3mf` asks: the program's own unit, the welded mesh, and a
`basematerials` group with a display colour per material that every
triangle names, in a zip written with Node's zlib (stored and deflated
entries, a CRC each, a fixed date so it is reproducible). Open edges
between two named steps now say how far apart their surfaces are there,
or how far one reaches into the other, which round 4 asked for.

Prototyped as asked: whether the inward-ray wall agrees with the feature
sizes. The ray runs from each vertex along the field's gradient, marched
in the field (so a wall under a cell is read at its own thickness), and
counts where the far side faces back within 30 degrees. At the default
grid of each example:

| Example | Feature size `check` knows | Thinnest wall by rays | Where | Rays, ms |
| --- | --- | --- | --- | --- |
| lamp | 0.1 (`stem`) | 0.1 | the stem | 32972, 957 |
| robot | 0.08 (`mouth`) | 0.08 | the mouth | 20116, 277 |
| table | 0.05 (a chair's slat) | 0.05 | a chair | 38760, 1139 |
| stairs | 0.06 (`post`) | 0.06 | a stair | 33703, 2112 |
| chest | 0.0625 (`band`) | 0.0625 | the lock's band | 38281, 537 |
| medal | 0.06 (`under_text`'s stroke) | 0.0564 | the lower lettering | 20995, 683 |
| tin | 0.06 (`lid_top`) | 0.215 | the knob | 32463, 331 |
| mug | none | 0.131 | the rim, cup wall to the rounded edge | 32139, 184 |
| tumbler | 0.18 (`straw`) | 0.164 | the glass's foot, inner wall to outer | 28040, 324 |
| teapot | 0.12 (`pot`'s shell) | 0.08 | the spout, a tube minus a tube | 26946, 379 |
| vase | 0.28 (`flute`) | 0.062 | the wall left behind a flute | 31419, 676 |
| nameplate | 0.05 (`title`'s stroke) | 0.02 | the floor the engraving leaves | 25823, 517 |
| sign | 0.09 (`line`'s stroke) | 0.008 | a sliver between two engraved letters | 25082, 694 |

Where a step carries its thickness (a shell, a slat, a tube, a stroke),
the two agree to within 6% in six of six; the tin's 0.06 disc is fused to
the lid below it, so no wall there is 0.06 thick, and the rays say so.
Where the thinnest wall is made by a cut, the feature size cannot see it
and the rays find it: the vase's flutes leave 0.06 of a 0.15 wall, the
teapot's spout is 0.08 thick, the nameplate's engraving leaves a 0.02
floor and the sign's leaves a 0.008 sliver between two letters, a fifth
of a cell. The reading does not move with the grid: the teapot's spout is
0.08 at grids 48, 64, 128 and 256 (0.6 to 3.2 cells), the vase's flute
wall 0.060 to 0.062. At 45 degrees the medal's star points (43 degrees)
and the sliver of rim under the mug's rounding read a third of a cell, so
the angle is 30. A full report adds 0.2 to 2 s for the walls (40000 rays
at most, the stairs' field being the slowest) and under 0.05 s for the
supports; the 3MF of the mug, 128556 triangles, is 1.2 MB and takes 0.4 s.

Not built: one 3MF object per scene object (the file holds the fused
mesh, as the STL does), a hollowing pass that picks the wall and the
drain itself (`hollow()` is still the program's choice), support that
counts a short bridge as needing none, and an orientation search that
turns the model to need the least support.

## 5. Smooth 2D profiles: built

`curve2([x,y, ...])` is a closed outline through the points (the curve
`curve()` draws, closed) and `bezier2([...])` one from anchors and
handles in `bezier()`'s layout; both are profiles for `revolve`,
`extrude`, `sweep`, `loft`, the 2D booleans and `offset`. The distance is
the nearest point on the true curve (the 3D curves' scan and Newton in the
plane, pieces culled by their exact boxes) and the sign the even-odd
crossing count, solved on each piece's rising and falling parts, so it
flips exactly on the curve; a self-crossing outline is filled as
`polygon` fills one. A point given twice is a corner and the run between
two corners straight (the axis and the foot of a lathe profile); a
`bezier2` whose last anchor is not its first closes with a straight edge;
`wall=` takes an open curve's band instead, a wall drawn as one line. The
bounds are the curve's own extent, the revolve of one is exact (no glass
warning), and a closed outline carries its thinnest facing wall for the
thin-part warning. The vase example is redrawn with one, and the guitar
example extrudes one. Prototyped as asked, though the 3D curves were
measured: against a dense polygon the distance agrees to 6e-9 with the
same sign everywhere and a gradient of length 1; a Bezier circle at
handles 0.5523 r is within 2.8e-4 r; a `curve2` through 8 points of a
circle is within 8.5e-3 r where the 8-gon is off by 7.6e-2; a distance
call costs about 500 ns for 16 pieces against 120 ns for an 18-point
polygon, and the vase's body meshes in 1.5 s against 0.65 s. Not built: a
gap size (the narrowest outside space, as text carries) for outlines; a
note when a revolve's profile overshoots past the axis (the box `check`
prints shows it); an open outline closed along the axis by a straight
line for `curve2` (corners on the axis do it). A revolve of one leaves
its runs on the axis out of the distance, so no line runs up the axis in
the slices and glass or a liquid has no surface there; polygons still
have that line (the tumbler's drink shows it), and the same few lines in
`polygon` would answer it, at the cost of every polygon lathe example's
renders.

## 6. `assert`: built

**Why.** Agents verify by reading pictures, which works, but a program
cannot say what it promises, so the next agent to edit it cannot know
what it broke. Every round's report had a line like "the handle must
clear the rim text" that lived only in the report.

**What.**

```
assert width(model) < 5, "fits the box"
assert pieces(model) == 1
assert clearance(handle, rim_text) > 0.05
```

`check` evaluates every assert and lists the failures with the message;
`render` counts them as warnings on the sheet. `pieces()` and
`clearance()` (the minimum distance between two shapes, from the field)
are the queries that make it useful.

`assert test, "message"` is a statement, with `< > <= >= == !=` on
numbers (1 or 0), `pieces(shape, resolution)` meshed at that grid and
counted as the report counts, and `clearance(a, b)` sampled from the
fields (a lattice over each box projected onto its surface, the best pair
tightened by alternating projections), negative by the overlap. `check`
prints each failure with both sides as they came out and exits with a
failure; `render` warns; the report has an Asserts row. The loop in the
guide and the skill tells agents to write them once a thing is right.

**Still to measure.** Whether agents write asserts unprompted, or only
when the loop tells them to, and whether the asserts they write catch
anything: the next dogfooding round's question.

## 7. Image textures and decals: built

`decal(shape, region, image="label.png")` fits a PNG to the region's
box across its shortest side, transparent texels leaving the base
material; `material(..., image="skin.png", projection=...)` paints a
part with a picture, planar, cylindrical (by arc length, repeating,
which is what keeps a band's lettering its own shape) or spherical. A
PNG decoder beside the encoder (every colour type, 1 to 16 bits, the
five filters, no interlace); the picture is sampled in `albedo()`
bilinear between texels, so the atlas, the Bedrock texture and the
beauty render need nothing else; the report lists the pictures. The
tin example wears one. Prototyped as asked: the label baked into a
1024-pixel atlas at the tin's grid reads clean with bilinear sampling
alone, so no footprint filter was built; a picture much larger than its
region would want one. Not built: `triplanar` (it needs the normal,
which `albedo()` does not have) and a picture on a pattern's second
colour.

## 8. Lights, cameras and environments: built

`light(name, azimuth, elevation, size, color, power)` declares the
beauty render's lights, each with its own soft shadow, the first
replacing the default key; `set environment studio|overcast|sunset|night`
picks a procedural sky, ground and floor the metals reflect, with its
own ambient scale; `camera(name, azimuth, elevation, zoom, focus, dof)`
is a shot written as `beauty_<name>.png`, framed on its focus, and `set
camera name` makes it the sheet's view. Prototyped as asked: the market
scene at 512 px took 4.1 s with one light and 5.9 s with three. Found
on the way: a `--focus` beauty render fitted the camera to every vertex
of the model and framed the whole mug; it now fits the points inside
the frame. Not built: a light's position (they are directions), an
image environment, and a camera path.

## 9. Callouts: built

`callouts.png` is written by every full render: the perspective view
with a label and a leader line for each of the largest twenty visible
named steps, and the report says which were labelled and which were in
view but smaller. Each mesh vertex is attributed to the smallest step
whose field it lies on with the model's inside on the step's inside (so
a cutter's cut face is not the cutter's), a step is visible where the
depth buffer shows its vertices, the label sits out from the picture's
centre past the vertex nearest the step's visible centroid, and
overlapping labels are pushed apart. Prototyped as asked: the
robot's fifteen visible steps read at 400 pixels. `--no-callouts` skips
it; it is not in the sheet, which stays four views.

## 10. `aixle explain`: built

`aixle explain model.aix [--pose NAME]` prints the tree from the output
down (each scene object as a root): every step with its line, its own
source line, size, joint, copies, paint state and anchors, children in
the order the line reads them, numbers after shapes, a step already
printed as "(see above)", and the steps not in the output at the end.
It is a printer over the dependencies the evaluation records. Not built:
`--json`, which waits for a tool that wants it.

## Smaller, worth doing when passing

- `aixle fmt`: built. `aixle fmt model.aix` prints the program in one
  layout, `--write` rewrites it, `--check` fails naming each file that is
  not in it. It moves only the space between tokens (numbers stay as
  written, no line is joined or split, every comment stays), and keeps the
  spacing the agents' programs carry meaning in: tight commas grouping
  points, a column of `=` or of trailing comments, a call broken under its
  first argument. Measured over the 109 programs in the repo: idempotent
  on all, the same syntax tree, tokens and comments after as before, 20 of
  6071 lines changed in 11 files, about 60 ms for all of them. The
  committed programs are not reformatted. Not built: a line-length rule
  (it would re-wrap the calls agents broke by hand) and a CI check.
- Records: built. `{w: 0.9, h: 0.45, name: "seat"}` with `seat.h`,
  nested, after an index or a call (`legs[0].x`), in lists, as parameters
  and defaults, and `{...seat, h: 0.6}` for the changed copy; a missing
  field names the fields there are, a repeated key is an error, and a
  record of shapes is never taken for a shape. The workshop example
  carries its bench's size in one and renders byte for byte as before.
  Not built: string keys, and iterating a record's fields.
- An import cache keyed by the file's hash, so `check` and `render` do
  not both sample a large mesh.
- Mesh decimation for web exports.
- A per-step slice (round 10).

## What was considered and set aside

- **A full material node graph.** Patterns as a fixed set with
  parameters have covered every request so far; the extensibility that
  matters is `use` and image textures, not a graph language.
- **Runtime plugins in JavaScript.** They would break the rule that a
  program means the same thing everywhere; libraries in the language
  itself (`use`) give the same growth without it.
- **Physics simulation.** Stability and pieces are checked; anything
  more belongs to the engine the GLB is loaded into.
