# Roadmap: what the language needs next

Proposals, not promises. Each says why an agent would want it, what it
would look like in a program, how it would be built on what exists, and
what must be prototyped before building on it (the repo's rule: measure
first). They are ordered by how much they would change what an agent can
make, judged from the dogfooding rounds. Items move out of here into
`design.md` when they are built.

## 1. Anchors: built

`anchor`, `at` and `attach` are in the language (see `language.md` and
the anchors section of `design.md`); every transform, warp and joint
carries them, unions merge them with the first part winning a name, and
`check` prints them. Round 5 measured it: two agents of four reached
for them unprompted (a dinghy's rigging fitting to fitting, with the
mainsheet following the boom's pose), two built a clock and a treehouse
without them and did not miss them. Nobody hit the first-part-wins rule.

## 2. PBR textures baked from the field: built

`albedo()` is the colour part of `surface()`, which returns colour,
roughness, metalness, glow and a bump height at a point, with the wear
a material reads from the field's curvature; the beauty render and the
atlas baker both call it. `material()` takes `bump=` (a height),
`bump_scale=` (a size, ten times the height if not given) and `wear=`
(0..1: convex edges lighter and smoother, bare metal on a metal,
cavities darker and rougher), and a `rust` pattern (and preset) eats
rough, non-metal oxide into the base, which wear rubs off the edges.
The baker writes up to three maps beside the colour atlas, each only
where it carries something: a tangent-space normal map from the field's
gradient under each texel against the mesh's interpolated normal, for
the materials on a displaced surface and the bumped ones; a
metallic-roughness map where a material varies them; an emissive map
where a glowing material's colour varies (a constant one is an
`emissiveFactor`, and a glow above 1 is
`KHR_materials_emissive_strength`). The GLB gains `TANGENT` on the
meshes that read the normal map, the report a Maps row, the output
folder `model_normal.png`, `model_mr.png` and `model_emissive.png`, and
`viewer.html` a room environment for the metals to reflect. The lantern
example wears all four maps.

Prototyped as asked. Tangents: a chart's two projection axes, laid onto
each vertex's tangent plane along the chart's axis, are the directions
of increasing u and decreasing v; the ±y charts are mirrored and carry a
handedness of -1. On a displaced sphere, a displaced rounded box, a
displaced torus and bumped spheres and boxes (25,000 to 39,000 vertices,
6 to 339 charts) no triangle's UVs disagree with its vertices'
handedness, and the normal map decoded across a chart seam through each
side's own frame agrees to 0.9 degrees on average for a bump; for a
displace it is 5.4 degrees at 1024 and 2.7 at 2048, so that is the map's
resolution against the displace's finest octave, not the frames. Decoded
through three.js's frame (bitangent `cross(N, T) * w` per vertex,
interpolated), a bump comes back within 0.26 degrees at the median and
1.6 at the 95th percentile on all six chart axes, and a displace within
1.1 degrees of the field's gradient where the mesh alone is 5.3 off.
Curvature: the Laplacian of `dist` alone counts a bound's own bending
as curvature; less the second derivative along the normal and over the
gradient's length it is the level set's curvature for any field whose
sign is right. Measured against that at a twentieth of the probe, it is
within 0.001 at the median in a smooth union's fillet (the Laplacian
alone is 12 to 24% off there), on a loft, a non-uniformly scaled sphere
and a twisted box, and smooth along a fillet (-0.21 to -0.25 round a
k=0.1 blend). Wear reads it over 1.2% of the model's longest side: a
hard crease (-0.86) gathers grime, a fillet of k 0.1 or more does not at
wear 0.5, a box's edges and a twisted bar's spiralling edges get a
steady bright band. Atlas memory and time, on the lantern (62,000
triangles, four maps): at 1024 the bake takes 4.2 s against 0.6 s for
the colour atlas alone and peaks 75 to 87 MB over the meshing against
48 to 55; at 2048, 17.8 s against 2.1 s and 150 MB against 55. Its
beauty render at 512 pixels takes 4.6 s against 3.4 s without the wear
and the bumps, nearly every pixel being worn and bumped. A plain
model's bake is within the run-to-run spread of what it was (the noise
and the dilation got faster, which pays for the roughness texel), and
its GLB is byte for byte what it was: 27 of the 32 examples. The two
lamps gain an emissive factor (32 and 40 bytes), and the tree, the
workshop and the Roblox plant, whose foliage is displaced, a normal map
and tangents (2.27 to 3.73 MB, 5.59 to 6.40, 0.61 to 1.27).

Found on the way: the normal map's test cannot be a share of bent
texels alone, since the dual-contoured mesh leans 3 degrees or more off
the field in a band at creases and junctions on every plain example (1
to 23% of their texels); baking that would have added a map to every
GLB. The map is for the program's relief, a `displace` or a `bump`, and
for those materials' texels only.

Not built: wear on the sheet (it shows the pattern; the finish is the
beauty render's and the exports'), the maps in the OBJ (its MTL keeps
`map_Kd`) and the Roblox and Bedrock exports (the colour atlas alone, as
before; what Studio's importer makes of a packed metallic-roughness map
on a decimated mesh is untested), an occlusion map, transmission, a
wear width of its own (it is the model's size, so a small part in a big
scene reads more of its surface as edge), and a bump that follows a
pattern (mortar lower than brick).

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
the slices and glass or a liquid has no surface there; after the merge
`polygon` got the same few lines, since the line was worse than a line:
`shell()` made it a hollow rod up the teapot's middle.

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

## 11. Round 10's leftovers: built

Round 10 left a per-step slice, a pair of skies in one run, a bigger
lights strip and the radial span of lettering on an arc undone, and its
hub report measured `check` at 4.9 s. `set slice name` (or `--slice`)
puts the cross-sections through one step where the output puts it,
framed on it with the rest of the model faint; `--environment a,b`
renders `environments.png` under the skies listed, beauty.png under the
first; `lights.png` gained a row of what each light adds on its own,
brightened, and the no-light picture, at frames half the beauty size;
`text(arc=)` carries the radii its ink spans and `check` prints them;
an evaluation meshes a shape once per grid for `pieces()`, `overhang()`
and a failing `pieces()`'s witness. Prototyped as asked: where the
planes go was measured on 74 parts in five programs (the terrarium, the
street corner, the lamp, the garden, the fence): a vertical plane
through the step's box centre missed the part on 4 of 148 cuts and cut
under a quarter of its widest section on 8, the centroid rule (the
solid's centroid, or the widest section where the centroid's plane cuts
under half of it) on none. On the hub, `check` went from 3.9 s to
2.5 s with the output unchanged (the report measured 4.9 s; the tool as
it was took 3.9 s here); on the ring the lights strip went from 6.1 s to 9.6 s for
three lights. Every friction point in the four reports was checked
against the tool as it stands and answered where it was not: an
`overlap` of zero says whether the two touch, stand apart or overlap
thinner than the lattice; a `void` failure on a ring of probes names
the copy; the sample-plane note gives the nudge (half a cell, with the
axis); a cutter named at open edges is tagged as the face it cut; an
all-glass step's thumbnail is drawn solid; a half-space turned on its
way into an `&` is a mask; the callouts line names the steps not seen;
the quick sheet's title is the surface's extent held within the bounds
(it said 0.51 for a 0.5-tall flange); `set caption 0` leaves the caption
off a presentation copy; a turn about a ring's axis just before the
ring that leaves a round part as it was is warned about (sampled: the
field read at 125 points of the part's box and at the same points
turned). Not built: a slice plane chosen to show a
contact rather than a section (the centroid shows the stem; whether it
meets the soil is still read, not computed), and a `--focus` whose
slices use the centroid rule (they still cut through the frame's
centre, which is the step's box grown).

## 12. An import cache: built

`check` and `render` each sampled an import, and so did every save
under `--watch` and every pose `check` evaluated. Measured first, where
the time goes: on the rock garden's 4440 triangles the nearest-triangle
search is most of it (0.75 of 0.95 s at resolution 64), but on a mesh
the size the tool itself writes it was the sign pass, because every
grid line tested every triangle: the chest's GLB (459 thousand
triangles, resolution 96) took 34 s, 31 of them signs, and the
workshop's (170 thousand) 18 s, 14 of them. The sign pass now bins each
triangle into the lines its box covers and finds the same crossings in
the same order, so the field is the same to the bit (compared sample by
sample), and the chest samples in 2.6 s, the workshop in 3.3. What is
left is the distance search, which grows with the resolution (the rock
at 200: 15 s), and that is what the cache is for. An import's samples
are kept on disk, keyed by a hash of the file's bytes, how it is read,
the resolution and the sampler's version, in `~/.cache/aixle/imports`
(or `$AIXLE_CACHE_DIR`; the system's temporary folder when the home
folder cannot be written), under 512 MB with the least recently read
out first; `--no-cache` on `check`, `render`, `explain` and `diff`
samples afresh and stores nothing. Prototyped as asked: `check` of the
workshop's GLB read back at resolution 160 went from 17.7 s to 0.5 s
once cached, the rock at 200 from 16.1 s to 0.5, and a full render of
the rock after a `check` from 20.8 s to 4.9; every file that render
wrote (sheet, slices, steps, callouts, turntable, OBJ, STL, GLB) is the
same byte for byte with and without the cache. Not built: caching
anything but imports (the mesh and the beauty render are deterministic
too, but cost seconds, not tens of them), and sharing a cache between
machines.

## 13. Decimation for web exports: built

The GLB, the OBJ and the viewer page carry at most 200 thousand
triangles (`set triangles N` or `--triangles N`, 0 for all of them):
past it the export's meshes are decimated before the atlas is baked,
by the quadric collapses the Roblox budget uses, which keep material
seams and creases, and the report's Exports row gives the counts and
how far the result strays from the model, the largest |field| at a
face centre beside the full mesh's own, with a warning when the
decimation takes it past a cell. The sheet and the STL stay whole.
Measured first: a GLB is about 30 bytes a triangle plus its atlas, and
four of the twenty-three examples are over 200 thousand at their own
grids; the chest's 459 thousand made a 13.7 MB GLB and an 18.3 MB
viewer page, now 6.4 and 8.5, and the plate of patterns, the tin and
the rope come down to 6.2, 5.9 and 6.9 MB. The decimator itself was
the cost: 4.9 s for the chest, more than its extraction, because its
heap swapped entries by destructuring and a survivor on a flat face
walked every triangle it had ever held; with the same collapses in the
same order (identical meshes) it takes 1.9 s, and the default adds 0.5
to 1.3 s to the four exports it touches. Verified with pictures, the
export mesh rasterised beside the full one: the chest at 200 and at 50
thousand reads as the full mesh, and its largest stray is the mesher's
own (0.22 of a cell), as on all four examples. A vase at 12 thousand
of its 188 and a teapot at 11 of 108 keep their outline and their
stray, but shade in streaks over their curved bands, since a sliver
from one soft corner to the next interpolates their normals across the
band; at a quarter of their triangles both read as the full mesh, so
the row says so below a quarter. The tin's capped GLB, read back
through `import()` at resolution 160, is the tin, lid seam and knob
intact. Found on the way: a decimated GLB is slower to import, since
its long faces have long boxes that the sampler's search cannot prune
(the tin's at resolution 64 took 25 s against 5 s for the full one, at
160 five and a half minutes, once, then cached); a round trip that is
not testing the web export wants `--triangles 0`. Not built: a
decimator that weighs normals as well as positions, which a cap below
a quarter would want; a sampler search that splits long faces; a
separate cap for the viewer page, which embeds the GLB as it is; and
decimating the STL, which is for a printer.

## Proposed from research, November 2026

Six topics were researched in November 2026: field evaluation, mesh extraction, rendering, language models as modellers, export formats and printing. For each, one agent read the sources and prototyped against scratch copies of the repo, and a second re-ran the measurements and reread the sources. What follows is what survived that check, ranked by the friction it removes or the capability it adds for an agent building a model, against its cost.

Round 11's fixes are in and are assumed below. They added `support()` and `stands()`; fix `void()` on a thin skin, the `overlap()` hang and `clearance()` at a sunk corner; place each object's open edges; share the export's triangle cap by error; add decimetres and feet; clear parts by a cell and a half; and give the viewer the program's scene.

Shading, reflections, path tracing, the mesh BVH and worker threads belong to the renderer redesign (render/shading, render/pathtrace, render/accel). What the research found for that effort is in the notes after the proposals.

### 14. Manifold surface nets, with a contacts row in place of open edges

**Why.** design.md says the mesher's one vertex per cell "is closed and manifold for any field". It is not. Dual contouring with one vertex per cell is non-manifold at every ambiguous marching-cubes configuration (Schaefer, Ju and Warren, 'Manifold Dual Contouring', IEEE TVCG 13(3), 2007, §III).

Measured with the repo's own surfaceNets at each program's grid, 45 of 68 programs (dogfood and examples) have edges shared by more than two triangles, or pinched vertices: 2369 such edges and 276 such vertices in all. The rope has 572 of these edges, the tower 134 and round 4's trophy 121. Round 6's terrace has 17 edges and 107 vertices. None has a hole, so every edge the Watertight row has ever called open is one of these. The teapot reads watertight "yes" with 18 pinched vertices, because the row counts edges only. 3MF requires every edge of a model to be shared by exactly two triangles (3MF Core, mesh section: MUST), so the 3MF of most dogfood models breaks the spec.

It is also the friction the record repeats most. 38 to 40 of 43 reports mention watertightness or edges, and about 17 rank them among their top three asks. Several give the cost:
- "the whole cost of this exercise" (round 5's bicycle);
- "eight renders" (round 6's terrace);
- "about five renders" (the playground);
- "three watertight rounds" (the footbridge);
- "no user-side fix" for rim lettering (round 4's trophy);
- "a full render on a wrong guess" (round 11's mixer).

The same row is how agents find contacts, and they value it: "one number to change" (round 11's door), "diagnosable from that line alone" (round 5's sailboat), and the mixer found a clash none of its promises covered. Removing the edges removes that, so its replacement ships in the same change.

**What.** Nothing changes in a program. Where no cell holds two surface patches, the mesh is today's, vertex for vertex; where one does, the mesh is manifold. The Watertight row becomes a Contacts row, per object and for the fused scene, and in report.json:

```
contacts: 'handle' meets 'head' at (0.41, 1.22, 0.03), 0.014 into it (0.9 of a cell): joined by a neck under a cell
          'leaf' and 'arch' at (0, 2.1, 0.4), 0.022 apart (1.4 cells): separate
```

Every place where the extractor had to decide (an ambiguous face, a restored tunnel, a cell with two patches) is a sub-cell contact or a part under about a cell and a half thick. Those places are clustered and named by the code that now places each object's open edges. The row also counts pinched vertices.

**How.**
- Place one vertex per marching-cubes patch in a cell (Nielson, 'Dual Marching Cubes', IEEE Visualization 2004), each by the existing QEF over its own patch's crossings.
- Group each cell's crossing edges into cycles by pairing the crossings on each face. A face with four crossings is paired by one field sample at its centre, cached per face so both cells agree. OpenVDB's VolumeToMesh does this grouping with a 256-entry edge-group table.
- Emit each crossing edge's quad between the patch vertices of its four cells.
- Restore tunnels. The one non-manifold case left is a patch that crosses a shared face twice (Zint, Grosso and Gürtler, Eurographics 2022 short paper). Give it one vertex per face segment, placed by Newton steps in the face. Flipping the face's signs instead, as OpenVDB's correctCellSigns does, disconnects parts: it split a fruit pile into 3 pieces, round 10's ring and round 9's campsite into 2 each, and a 1.3-cell rod into 35 beads.
- Rewrite design.md's claim. Most of the guide's thin-wall rules go, since a 0.9-cell plate meshes clean. The contact rule (overlap by a cell, or clear by a cell and a half) stays, and its symptom becomes pieces rather than open edges.

A scratch prototype on Aixle's lattice, reusing its QEF, measured the topology:
- 0 non-manifold edges, 0 pinched vertices and 0 holes on all 68 programs, before welding.
- The same triangle count except at restored tunnels (the rope gains 956 from 239 tunnels).
- Volume moved by at most 1.9e-4; 23 programs identical to today's mesh.
- Pieces changed only in three market stalls (round 2: 2 to 3; round 3: 2 to 7; round 4: 1 to 2), all at sub-cell contacts, such as a lantern hanging by a touch and fruit resting on fruit.
- pieces() asserts unchanged at their own resolution on the eleven programs checked.
- A tilted plate has no bad edges from 0.9 cells up; today it has 5383 at 0.9 cells and 21 at 2.
- Extra cost: one evaluation per ambiguous face (0 to 595 per program) and about 42 per restored tunnel.

**Prototype first.**
- **The weld.** The prototype's rope has two tunnel vertices at one point. After weldIndices, which watertightReport, the 3MF writer and the decimator all call, the rope has 2 non-manifold edges. Patch and tunnel vertices must never share a position, or welding must stop going by position.
- **Thin rods.** Rods of 1.1 and 1.3 cells, held together today by pinches, become 29 and 9 pieces; from 1.6 cells both meshers give one piece. Count how many parts this hits at the grids agents use (none among the 68 measured), and word the thin warning for it.
- **Cavities and specks.** The teapot's spout bore becomes a cavity shell of its own, and round 4's trophy gains a 12-triangle speck. Read the cavity and void rows on every program.
- **The contacts row.** Log the decided places on the dogfood set. Check that the clusters land where the reports say: the trophy's rim lettering, the mixer's knuckle at 0.4 of a cell, the door's leaf at 1.4 cells and the market's lantern. Measure false alarms: the teapot's two-patch cells are a thin spout wall, not a contact.
- **Tests.** Unit-test every ambiguous configuration and adjacent tunnels; Zint et al. merge up to twelve vertices around one point.
- **Timing.** Time a table-driven core against today's core. The prototype was compared with a full extraction including normals and materials, so it is not yet shown to be free.
- **Renders.** Regenerate every example, dogfood and std render, and read the changed sheets (about 45 programs).

**Cost.** Moderate: about 250 lines in surfaceNets.ts, 30 in mesh.ts and 100 in pipeline.ts, plus tests and docs. Two regula-falsi steps per crossing, in place of linear interpolation (Kobbelt et al., SIGGRAPH 2001), halved the mug's face-centre stray (0.023 to 0.013 cells) at no measured cost. If they are wanted, they can land with this regeneration.

### 15. A narrow band: sample only near the surface: built

Built as proposed, with a guard the proposal did not have: a skipped block
that a sampled neighbour disagrees with in sign is sampled after all. All
72 programs mesh to the same bytes, the main extraction of all of them
takes 115 s against 235 s, and `bend` and `wrap`, whose stretch has no
bound worked out yet, sample densely as before. design.md, "A narrow band",
has the rest. What follows is the proposal as it was written.

**Why.** Most of a heavy render is field evaluation, and most of that is spent far from the surface. On the rope's full render (40 s of CPU), 75% of the time is in src/sdf, and the sweep's pieces alone take 45%. Lattice samples are 55 to 87% of the mesher's field calls, yet only 3 to 10% of them lie within a cell of the surface (27% on round 11's shelf, whose books are packed close).

Every surfaceNets caller pays this: the main mesh, the step thumbnails, the export, pieces(), wall(), overhang(), support(), focus, poses and strips. The cost grows with the cube of the grid, and raising the grid is how the agents cured thin parts: the bicycle at 300, the sailboat at 320, the trophy at 360, the footbridge at 400.

Sparse sampling is standard practice. fogleman/sdf skips batches of 32³ points that lie far from the surface by default, and its README warns that inexact fields such as a non-uniform scale leave holes. OpenVDB stores only a narrow band (Museth, 'VDB', ACM TOG 32(3), 2013).

**What.** Nothing changes in a program, and every output stays the same to the byte.

**How.**
- **Blocks.** surfaceNets fills its lattice by blocks instead of point by point. A block whose centre reads |d| > L·(r + cell), with r its half-diagonal, holds no point within a cell of the surface. Its points take the centre's value unevaluated. Other blocks are halved, down to 2³ points evaluated densely. Both ends of every crossing edge are still evaluated exactly, so the mesh cannot change.
- **The factor L.** It comes from an optional `lipschitz` on Shape3 (default 1): how far a field can overestimate the distance.
  - A twist sets √(1 + (k·ρmax)²) from its bounds. Bend and wrap set their own, and so do a sweep or tube that twists or tapers, and an import.
  - It multiplies through warps and takes the max through booleans; the mesher reads the root's.
  - displace is a jump, not a slope (ops.ts switches its noise off at |v| = 3·amp), so it carries an additive margin of 2·amp instead, scaled through transforms.
  - Non-uniform scale already multiplies by its smallest factor. The union box cull and the spatial index's floor only underestimate.
  - dist() is untouched (rule 6).
- **The asserts.** The same block walker then serves overlap() and inside(). A block is skipped where either shape reads more than L·r, and counted whole where both read less than −L·r. On the mixer, overlap(head, bowl) came back identical to the bit from 1,622 evaluations instead of 83,508.

Two scratch prototypes measured it:
- Meshes byte-identical to the dense mesher (positions, indices, normals, materials, NaN counts) on all 25 examples and 8 dogfood programs; the check re-ran 11 of them.
- 12 to 82% of the lattice evaluated.
- Main extraction 1.1 to 3.9 times faster, on a loaded machine: the mixer 32.8 s to 12.0 (18.5 s to 7.8 in the rerun), the stairs 3.0 s to 1.0, the rope 11.3 s to 4.5.
- Sampling alone: the bicycle at grid 300 in 0.85 s, against 13.6 s dense.
- Doubling the grid costs about 4.5 times rather than 8.
- Without the factors, the rope's twisted sweep left one skipped sample within a cell of zero at L = 1, and the tree's displace left 26. At L = 1.5, none did.

**Prototype first.**
- Test each factor and margin: sample pairs of points near every warped node and assert |f(p) − f(q)| ≤ L·|p − q|.
- Test curve2, whose scan can still miss a dip that falls inside one step.
- Evaluate a block that reads NaN densely, so the NaN warning still gives a count.
- Decide whether cheap fields need a dense fallback at all: the garden ran at 0.83 times once and 1.28 times in the rerun.
- Run `npm run check` and confirm that no PNG, GLB or report changes by a byte.
- Time the whole render and `check` on the rope, stairs, mixer and shelf.

**Cost.** About 150 lines in surfaceNets.ts, a field set by about eight constructors, and tests. A day or two, with the prototype written.

### 16. Place by contact: `rest()` and `lean()`: built

Built as proposed, in `src/sdf/measure.ts` beside clearance(), with
builtin entries and a `check` line per call (`rest (line 14)  bowl onto
plate: moved 0.15 along [0, -1, 0]; gap 0`, a loop's calls on one line).
The search traces points of both surfaces along the motion (sphere
tracing, with a short probe and then a step of a 48th of the part where a
point slides along a face), seeds a part's small leaves (a tab, a hook's
lip) at their own scale, refines around the earliest meetings, then
tightens on clearance(), read a leaf of `on` at a time and following the
leaf the part is pressed into, so the shelf a book slides along, which
reads zero the whole way, cannot pass for the neighbour it slides into.
What the prototype left open, decided:
- **sink defaults to 0.** A face on a face meshes as one piece: pieces()
  read 1 for every book on round 11's shelf, the mixer's bowl on its
  plate, the frog on its pad and a cube on a board at 32 to 317 cells,
  touching or sunk a cell, and the report reads it watertight. In review,
  224 more face-on-face touches (boxes on boards and a box attached to a
  post, at 48 to 256 cells) and round 10's lantern rebuilt alone on its
  collar (160 to 300) were all one piece. A corner on a face touches at a
  point and can mesh as two: a cube standing on its corner did at 128
  cells, and was one at 64, at 200 and sunk 0.02. A cell is not known
  when rest() runs (it comes from the shown model and `set grid`), and a
  cell of sink would break the bookcase's own `clearance(bk, board) >
  -0.002`.
- **No contact is an error** naming both parts, their boxes and the
  direction: a part left where it was would hide the broken promise.
- **A part that starts inside** is backed out against the motion to the
  first place it is clear, so a part built at the origin rests on a shelf
  above it. One sunk only a sliver (under a ten-thousandth of its size)
  is lifted out along the surface's normal first: ground() left round
  11's turned books 4.5e-5 in their shelf, and backing out along a slide
  never frees that.
- **lean turns the right-handed way about `axis`**, as rotate() does, not
  the shorter of the two turns: the other way is often a turn of nothing,
  into the shelf the book stands on. A turn of more than 90 degrees gets
  a note naming the other axis.
- **The tightening** is regula falsi on clearance() (the Illinois rule)
  aimed at half the tolerance, ending clear and within a millionth of the
  part's size of touching.

Measured, against the hand values:
- **Bookcase** (round 11): 33 books and the right bookend placed by 34
  rest() calls, dropped, slid along the shelf to `sink=-0.06` short of the
  one before, or slid against it when leaning. All 271 of the agents'
  asserts hold. The uprights land within 2e-6 of the hand's positions.
  The three leaning books touch at 1.1e-6 to 1.3e-6, where the hand's
  `min(b.h * s, prev_h * s / max(c, 0.01))` left 0.0072, 0.0065 and 0.0076
  (promised < 0.012). The book after the second lean stands 0.0600 from
  it, where the hand's cursor gave 0.0656 (it reckoned the square corner,
  not the rounded one). 44 ms a call; check 5.6 s against 3.7 s by hand.
- **The three leans by lean()**, each book upright with its heel where
  the agents' arithmetic put it, turned until it touches: 18.18, 15.17
  and 20.23 degrees against the 18, 15 and 20 written (the hand's gap
  closed), gaps at most 1.9e-6, about 16 ms each. Turned about the
  rounding's centre, the heel stays 1e-7 from the shelf.
- **Mixer** (round 11): the hand's `bowl_y0` was exact (rest from there
  moves 0); dropped from y = 3 the bowl lands within 2.5e-10 of it, with
  overlap 0 and the hooks' 0.025 as promised. Rested on base, plate and
  hooks together it stops on the hook lips, 0.12 higher, which the first
  build stepped through (a lip as thick as the slide step; now a short
  probe first, and small leaves seeded).
- **Frog** (round 3): rest() finds a toe 0.0031 lower than ground()'s
  rays did, so the hand's `ground() | move(0, pad_thick - 0.01, 0)` sinks
  it 0.0131, not 0.01. One to two seconds a call: the skin is displaced,
  a clearance reading costs 144 ms and the contact takes 11 to 17. The
  displaced field is not a distance, and clearance() on it is good to a
  ten-thousandth of the frog's size: at the place rest() finds, it reads
  +2.9e-4 at its own lattice and -1.7e-4 at four times as fine, and a
  march up the columns under the frog finds it 2e-4 into the pad. The
  same search on the frog scaled by 2 ended 4e-4 off before the review
  below; where it ends now does not depend on the scale.
- **The prototype's cases**, exact by hand: a box tilted 18 degrees onto
  a board 1.0 within 1.2e-7 (the corner the lattice missed by 0.0046); a
  ball into a ring, the contact off the drop line, within 2.9e-7; the
  slide along a ledge 0.01 below, and along the ledge it stands on, square
  or rounded, within 3e-7, where conservative advancement stalled; drops
  onto a 20-degree ramp and along a diagonal into a corner within 1e-6; a
  book leaned on its neighbour at 2.865974 degrees against 2.865984. 10 to
  60 ms each, one to three clearance readings.

An adversarial review then broke it five ways, each fixed with a test
that failed first (tests/contact.test.ts):
- **A thin sheet met at a slant was stepped through.** A card 0.002
  thick turned 60 degrees, dropped from 2 onto a sheet as thin tilted 30
  degrees, landed on the floor 3 below it, silently: every seed of both
  closed on the other at a slant, and the step of a 48th taken near a
  surface jumped the sheet. The trace now goes on from its probe while
  the probe finds the point closing on the surface; the step of a 48th is
  only for a point sliding along one. 12 drop heights onto sheets 0.001
  to 0.008 thick, tilted 30 and 45 degrees, now all land on the sheet,
  and thin cards, rods and wires on thin sheets and rods take 9 to 23 ms
  a call where they took 24 to 230.
- **When no seed met, the search gave up after 1.2 of the part's size.**
  Two crossed wires 0.001 thick, which no seed lies on, fell back on
  stepping by clearance(), read capped at a twentieth of the part, 24
  steps; a drop of 0.6 was said never to touch. The steps are now a
  lower bound on the gap past the cap (the near leaves' readings, the far
  ones' box gaps), up to 64 of them.
- **At a centimetre in metres it slid the wrong way.** A cube 0.007
  across standing on its board read as inside it, through clearance()'s
  fixed tolerances (a gradient step of 1e-4, a surface within 1e-7), and
  was backed out 3.8 times its size the other way; a book 0.02 tall
  stopped 1.1e-5 of its size short. The search now runs on the two scaled
  by the power of two that brings the part to about 1: from 2e-4 to 1e5
  times the size the cube lands within 1e-7 of its size and the book
  within 2.2e-7.
- **A scaled part of `on` was read without its factor.** Read a leaf at a
  time, a board made at four times its size and scaled by 0.25 read four
  times its distance, so a block sunk 8e-5 into it was not lifted out and
  was backed out the wrong way along its slide.
- **Backing out went no farther than the forward search**, which for a
  part deep in the near half of `on` stopped short of freeing it and
  blamed something it would slide along. It now goes back until the
  part's box is behind on's. An empty part or `on` says it is empty.

Not built: a sink for lean() (its contacts are an edge or a corner), and
oriented anchors, as below. A feature thinner than a 48th of the part,
met only while the part slides along another face, can still be stepped
over; the other surface's seeds usually meet it. A field that only
bounds the distance loosely (a twist, a bend) is traced as if it were a
distance; balls dropped on twisted blades and a bent plank met them where
a dense sampling of the ball did, but nothing proves it. When no seed
meets and the gap closes by less than a fifth a step (the motion within
12 degrees of the contact's tangent), 64 steps can run out and the call
says it never touches. What follows is the proposal as it was written.

**Why.** Placement is where code-writing models fail most:
- Coordinates an LLM writes place objects no better than random. In Holodeck, human ranking (MRR) gave LLM coordinates 0.364, random placement 0.369, and relations solved by a solver 0.706 (CVPR 2024).
- Taking SceneCraft's relation graph away drops its constraint score from 64.5 to 3.2 in the cumulative ablation (ICML 2024).
- Against human Blender users, the best VLM's placement loss was about 26 times theirs, its worst task (BlenderGym, CVPR 2025).
- GPT-4 ignored "non-overlapping" but obeyed "in contact with (but not protruding into)" (Makatura et al., arXiv 2307.14377).

Aixle has the point-to-point half (anchor, at, attach), and ground() rests a part on y = 0. Contact with anything else is worked out by hand and promised afterwards:
- Round 11's bookcase placed each leaning book with `min(b.h * s, prev_h * s / max(c, 0.01))` and promised clearance < 0.012.
- The mixer's bowl sits on its plate by arithmetic, promised with clearance(bowl, plate) < 0.01.
- Round 4's fruit-on-fruit contacts and the frog on its pad (rounds 2 and 3) were placed by trial.

**What.**

```
bowl = bowl | rest(plate)                                                  # dropped along -y until it touches
book = book | anchor("heel", 0.17, 0, 0) | lean(prev, pivot="heel", axis=[0, 0, 1])   # turned until it touches
```

`rest(part, on, dir=[0, -1, 0], sink=0)` moves a part along a direction until it touches. `lean(part, on, pivot, axis)` turns it about a pivot (a point or an anchor) until it touches. Both carry anchors along, and `check` prints how far each moved or turned. A promise of contact then holds by construction.

**How.** rest marches rays along the direction through the target's field, from points on the part's surface (the points clearance() already seeds). It takes the shortest hit and tightens it with clearance(). lean bisects the angle on clearance(). Both live in src/sdf beside ground(), are deterministic, and get builtin entries and `npm run docs`.

A scratch prototype measured:
- a tilted box dropped on a board in 10 ms, 0.0046 too far because the corner fell between lattice points (the tightening is for that);
- a ball into a ring, with the contact off the drop line, within 1.3e-5 in 6 ms;
- a box slid into a wall along a ledge 0.01 below it, exact in 35 to 43 ms, where conservative advancement on clearance() stalled at 200 iterations;
- a book leaned against its neighbour at 2.888 degrees against an exact 2.866, in 30 clearance calls and 89 to 97 ms.

The queries that promise these contacts failed on exactly these contacts, and the round-11 query branch fixes both. overlap() hung on a corner resting on a face (the bookcase's 300 s timeout) and now returns 0 for a touch. clearance() read 0 for a corner 0.0046 into a board and now reads -0.0046 (re-run for this proposal).

**Prototype first.**
- With those fixes in, place round 11's 33 books and three leans, the mixer's bowl and the frog by rest and lean, and compare with the agents' hand values.
- Include the grazing slide and the off-axis contact; report the gap left and the time.
- Decide whether sink should default to a cell. A face resting on a face meshes as two pieces until it is sunk, which is why attach(sink=) exists.

Oriented anchors (an anchor with a normal, so attach turns a part onto a face) wait for a round that shows orientation friction attach cannot answer.

**Cost.** One to two days.

### 17. A promise audit: `aixle audit`

**Why.** All 16 agents in rounds 8 to 11 wrote deliberate-failure copies by hand to test their promises (round 11's mixer wrote five), at a check or a render each. Twice a copy found a promise holding when it should not: round 9's void on a buried slot, and round 11's cable sunk 0.3 mm into both walls of its slot.

Mutating real dogfood programs shows how much the promises leave out. A scratch mutator moved each part and cutter 0.05 along each axis, scaled it by 0.9 or removed it, then re-ran every assert at rest and in every pose. It caught:
- 61 of 112 mutants on round 10's hub (0.545);
- 41 of 200 on round 8's arm (0.205, reproduced exactly);
- 54 of 192 on the terrarium (0.281).

The hub's disc, its pockets or its engraving can be deleted with every promise holding, and so can any of 14 of the arm's 25 parts.

Other work points the same way:
- A community benchmark for LLM-written CAD found "a ball socket with no socket scored 1.00" until it probed each stated feature; that probe failed 79 parts that had passed (CADClamp spec 0.2.2, not peer reviewed).
- Feedback the tool measures moves results where a static procedure does not. Revising against finite element analysis lifted a CAD agent from 25.9% to 39.4% of requirements, while a 23-file planning skill moved it from 19.4% to 18.6% (Son et al., arXiv 2605.17448, 2026).

**What.**

```
aixle audit model.aix [--steps a,b] [--budget 60]
pockets: removed, moved 2 cells in x, y, z: no promise fails
disc: removed: unpromised (it shows on the sheet)
caught 61 of 112 (0.54)
```

The audit mutates each step the output uses: it moves the step 2 and 4 cells along each axis, scales it by 0.9, and removes it. It skips a mutant whose output differs by less than a cell's volume, and prints, step by step, what no promise caught. A visible part that can be removed is reported as unpromised, not as a failure: the sheet shows a missing disc, and an assert per part would make the loop slower (round 11's shelf already has 272).

**How.**
- **Reach.** The prototype mutated source lines, which reaches only top-level steps written on one line. Parts made in a loop or a def (the shelf's books, library parts, the chess pieces) need a hook in the interpreter that replaces a step's value as it is made.
- **Equivalence.** A mutant is equivalent when the XOR of the two outputs' signs on a 48³ lattice is under a cell's volume; that takes about 60 ms.
- **Runtime** is the hard part. A mutant costs 60 ms to 2.9 s, because pieces(), overhang() and wall() re-mesh, so the three programs took 13 s to 9 minutes on one thread. The audit needs the narrow band (15), the evaluation's mesh cache shared across mutants that leave a step alone, and the worker pool the render effort is adding.

The prototype's other find was the hub's void() passing a 0.01 intrusion. That was the thin-skin bug the round-11 query branch fixes.

**Prototype first.**
- Run the audit on every dogfood program with asserts (rounds 7 to 11) at 2 and 4 cells.
- Measure the share of survivors that are equivalent, the time per mutant with workers, and which query weaknesses it finds.
- Then hold a dogfood round with the audit available and with defects planted by another agent and held out. Measure whether promises written after reading the audit catch more of them, and whether agents stop writing failure copies by hand.

**Cost.** Two to three days, plus the round.

### 18. A GLB in metres, with each object's pivot at its feet

**Why.** glTF measures in metres, with +y up and the front toward +z (glTF 2.0 specification, coordinate system and units). Aixle matches the axes but writes model units unscaled: toGlbScene takes no units. A program that says `set units mm` arrives a thousand times too large in Unity, Godot, Blender and three.js. Round 11's phone stand is 117 mm tall and would load 117 m tall. With decimetres and feet now settable (round 11's mixer and bookcase are decimetre models), more programs will hit this.

The STL is written in millimetres and the 3MF records its unit. The GLB is the one export whose format defines a unit and which ignores the program's.

Separately, every scene object's node sits at the world origin with world-space vertices. The workshop's stool pivots 0.85 from its own base centre and its shelf 1.1, so in an engine each one drags and turns about a point out in space.

**What.**
- With `set units`, positions, node translations and animation translations are written in metres (mm 0.001, cm 0.01, dm 0.1, in 0.0254, ft 0.3048).
- Without it, a unit stays a metre, and the Exports row says so beside the STL's millimetre.
- Each scene object's node sits at its base centre (its box's x and z centre, its lowest y), with its mesh made relative, so it keeps its place in the world and moves from its feet.

**How.** A scale applied to the hierarchy before the writer, and a translation per root node in hierarchy.ts. The Roblox export (a unit is a stud) and the Bedrock export (a unit is a block) stay as they are, except that the Roblox Handle's attachment nodes become relative to its new pivot.

**Prototype first.** Render the workshop, round 11's stand and the arm. Read each GLB back through import() and compare its size in metres with check's. Check that:
- joints, their animation channels and placed sets' children are unchanged relative to their parents;
- the viewer's framing, the punctual lights' positions and their ranges all scale;
- the Roblox GLB is byte for byte what it was.

**Cost.** About 80 lines and tests, half a day. No committed render changes.

### 19. 3MF that slicers read as the program means it

**Why.** Three things a print promises do not reach the slicer.

- **A promised gap closes in the file.** clearance(a, b) > 0.3 is measured in the field, but the mesh is sampled. Two flat faces fuse at half a cell or less, wherever they fall on the lattice. A round pin in a bore needs about a cell and a half. Measured through the CLI with pieces(), a 0.4 mm radial gap fused at every cell up to 0.292 mm and opened at 0.269 mm, which agrees with the cell and a half the round-11 print branch measured between curved faces. At round 11's stand's 0.584 mm cell, a 0.3 mm print-in-place joint is one solid in model.stl and model.3mf, with every assert passing.
- **Colours reach one slicer.** Aixle writes a basematerials group, with pid and p1 on every triangle. PrusaSlicer 2.9 ignores pid and p1 and reads only its own `slic3rpe:mmu_segmentation` or Bambu's `paint_color`. OrcaSlicer ignores p1, has no basematerials code, and reads paint_color. Only Bambu Studio 2.9.2 maps basematerial colours to extruders. All three were read in each slicer's 3MF reader source.
- **Parts are fused.** The file holds one object at the origin. 3MF Core 1.4.0 says a model SHOULD lie in the positive octant, and interlocking parts SHOULD be components of one object, which a device MUST NOT move apart; separate build items MAY be rearranged. Round 11 read its stand back at x from -35 to 35 and y from -45 to 50.

**What.**
- **A warning for a gap the mesh closes.** A clearance assert that holds in the field between two parts the export's mesh joins becomes a warning. It names the pair, the cell, and the grid that would keep the gap open. That grid is found by meshing the pair, not from a ratio, since curved gaps need twice what flat ones do. For the same reason the STL, the file most people slice, writes each object as its own shell.
- **Extruders on every triangle.** Each triangle carries its material's extruder as paint_color and as slic3rpe:mmu_segmentation, beside pid and p1. Material k is "4", "8", "0C", "1C" and so on to 15 (PrusaSlicer's TriangleSelector::serialize; Bambu and Orca use the same encoding). The Print section gains a Filaments line ("extruder 1 = porcelain #F6F4EE, ..."), and warns past 15.
- **One object per scene object.** Each is meshed alone, as the Assembly rows already are. Objects joined by a joint become components of one object. Everything sits in the positive octant, centred on `set bed` when one is set. The colour group goes on the mesh objects, never on a component container, which the spec forbids.

**Prototype first.**
- Export a pin-in-bore hinge at 0.3 mm and the robot (six materials).
- Open both in PrusaSlicer 2.9, Bambu Studio and OrcaSlicer on a machine that has them (none runs here). Record:
  - whether the faces are painted with extruders 1 to 6;
  - whether Bambu's colour rule agrees with paint_color (two materials of one colour get one extruder by its rule and two by paint_color);
  - whether components stay one object and arrange keeps them together;
  - whether the gap survives slicing (PrusaSlicer closes cracks under 0.098 mm).
- Check that a plain 3MF reader (lib3mf, Windows 3D Viewer) still opens the files.
- Measure the bytes added after deflate, and the time against today's fused mesh, on the chess set and the stand.

**Cost.** Two to three days, most of it in the slicers. No committed render changes.

### 20. Supports that know bridges and islands

**Why.** support() (round 11's first ask, built on the round-11 query branch) counts every face past 45 degrees as needing a column down to the plate or the model below. It is wrong in two ways:
- **Bridges.** A bridge, a face with solid near it on both sides, prints without support. All of round 11's stand's remaining 55.6 mm³ lies under the grooves of its engraved word.
- **Islands.** A point overhang, a vertex lower than all its neighbours, needs support whatever its faces' angles (Vanek, Galicia and Benes, 'Clever Support', CGF 33(5), SGP 2014, §4). A cone hanging tip down off a wall, its sides 60 degrees from horizontal, reads 0.02% overhang and about 10 mm³ of support. Its only column stands at its crease with the wall, never at the tip, so it passes where every slicer must support it.

**What.** The Supports row splits its volume into three: supported, bridged (prints without support when supports are off) and islands, each island with its place. `islands(shape)` is a query, for `assert islands(part) == 0` (a builtin entry and `npm run docs`), and support() reads the supported share. A column standing on a few sliver faces at a crease gets the same half-cell nudge the sample-plane note gives.

**How.** A face is bridged when the layer under it has solid within the span on both sides along one of 8 directions, marched through the field. An island is a welded vertex lower than all its neighbours by more than a tolerance, off the plate.

The span is the printer's choice, and the sources disagree on what it means:
- Hubs says an FDM bridge under 5 mm does not sag.
- PrusaSlicer's stability checker adds a support point once a bridge runs past 16 mm (SupportSpotsGenerator).
- With supports switched on, PrusaSlicer's shipped profiles (dont_support_bridges = 0) and Cura support bridges anyway.

So the row must say what it means by bridged.

Measured on scratch:
- The stand's 62 mm³ (before the bent-face fix) went to 44 mm³ at a 5 mm span and to 0 at 10 or 16.
- Posts 4, 8 and 14 mm apart were fully bridged at 16; posts 20 and 40 apart, and a cantilever, never were.
- The bridge pass cost 14 to 160 ms, against 2 to 22 ms for today's estimate.
- The local-minimum pass found the cone's tip in 0.1 to 0.3 s, and nothing on a sphere on a post.

**Prototype first.**
- Report both estimates and the island count on every example and dogfood print, and read the sheets at each flagged place.
- Check the span rule against PrusaSlicer's choice of bridge direction on an L-shaped ceiling and a ring's underside.
- Measure false islands on displaced and text-heavy models, where mesh noise makes spurious minima, and set the tolerance from that.
- Choose the default span and give its source.

**Cost.** About a day and a half. An orientation search that scores poses with this estimate is listed below under "Kept for after these".

### 21. Glass that stays glass in the GLB

**Why.** Glass runs through the record: round 1's lighthouse, round 9's perfume bottle, round 10's terrarium, the ring's stone and the alley's lantern. Every transmissive material exports as opaque PBR. The tumbler's GLB carries no extension, and three.js draws it as a white cup.

Three Khronos extensions fit Aixle's glass:
- **KHR_materials_transmission** is thin-walled transmission with no refraction. Its transmissionFactor is Aixle's transmit, one to one. A renderer without the extension draws the surface opaque, which is what Aixle writes today.
- **KHR_materials_ior** defaults to 1.5, the beauty render's fixed index.
- **KHR_materials_volume**'s attenuationColor and attenuationDistance are Beer's law. The beauty render's absorption is exactly attenuationColor = exp(−1.5(1 − c)) over 0.15 of its reach (shadeGlass in beauty.ts).

three.js, Blender and Babylon read all three. Unity's glTFast approximates transmission ("100% correct" only for clear glass). Godot ignores them, which is today's opaque fallback. The prototype tumbler passes the Khronos glTF-Validator with 0 issues.

**What.** Transmission and ior on every material with transmit > 0, in the GLB and the viewer, with nothing new in the language. Volume follows only for a material whose region is a closed surface of its own. The extension requires a manifold volume, and a material cut out of the fused mesh is open wherever glass meets another material.

**How.**
- **The factors** take a few lines in glb.ts. attenuationColor is written in linear, since glTF colour factors are linear and Aixle's colours are sRGB.
- **Thickness** comes from marches inward through the same material, as wall() marches. The tumbler's glass reads a median of 0.191 from 56,256 marches in 0.26 s.
- **Contents** need more. In three.js the tumbler's amber drink is invisible through the transmissive wall, because the union's mesh has no face between glass and drink. Each material's region has to be extracted as a closed surface of its own, following the labels hit() returns. paint, decal and regions assign materials too, so a distance difference between two parts is not enough. The same per-material solids would later serve 3MF volumes.

**Prototype first.**
- Render the tumbler and round 9's perfume bottle in three.js beside beauty.png, with the factors alone.
- Compare one thickness per material with a thickness texture.
- Prototype the per-material extraction on the tumbler: whether each region is watertight, how many triangles it adds, and whether the drink then reads through the glass in three.js and Blender.
- Define the absorption law and the index once, with the render redesign, which is changing the beauty render's glass. A per-material ior= would matter for water and for the ring's stone.

**Cost.** A day for the factors with one thickness per material; two to four days for per-material surfaces. No committed render changes.

### 22. Fewer evaluations in a render: reuse the export's mesh, skip a cutter, bound a sweep's pieces

**Why.** Once the narrow band is in, what remains is repeated work and the cost per evaluation of a few primitives:
- **The export meshes the model twice.** buildHierarchy's extract() meshes each object at ceil(longest / cell) over its bounds. For a single object with no joints, that is the main extraction, and it gave back the same positions, indices and normals on six examples. 20 of 24 examples qualify. The second extraction was 8.8 s of the rope's 40 s render, and would be about 3 s after the band.
- **A difference always evaluates its cutter.** Where a point is outside the cutter's box by bd and the base reads at least −bd, the difference equals the base bit for bit, so the cutter can be skipped. On the sign's engraved board this skipped the cutter at 87% of samples (339 to 77 ns a sample, 0 of 193,224 values different), and on the nameplate at 44%. On the mug's single-cylinder cutter it was slower (14 to 17 ns).
- **A sweep evaluates most of its pieces.** The rope's sweep evaluates 24.4 pieces a sample, each a twist's cos and sin plus three circle distances. Every piece's box is grown by 1.5 times the profile's reach and the turns stack, so the boxes overlap heavily. A lower bound per piece, with pieces visited nearest first, would evaluate about 2.3. The sweep's pieces and the spatial index's min take 59% of the rope's whole render. curve2 has the same kind of cost: its distance code is 55% of the self time of the mixer's check.

**What.** Nothing visible, and every output is the same to the byte.

**How.**
- **Reuse.** Pass the pipeline's mesh to buildHierarchy when the object is the whole output, with no joints or placed sets, and its box and resolution match. The decimation cap must copy that mesh, not change it in place.
- **Cull.** Give difference() a box cull when k = 0 and the cutter's cost is above a threshold. It rests on the invariant union()'s cull already relies on: outside its box, a field reads at least its box distance.
- **Bound.** In sweeps and tubes, give each piece a lower bound, such as cos(θ/2)·segDist − reach, with twist and taper in the reach. Visit pieces in order of their bounds, and stop once the next bound reaches the best distance so far. A preallocated scratch per sweep keeps it allocation-free (rule 6), and a min over the same set gives the same bits.

**Prototype first.**
- Confirm the export's resolution formula cannot differ from the grid by floating point on any example, and that a tightened box makes the reuse miss rather than give a wrong mesh.
- Choose the cutter-cost threshold from the mug, sign and nameplate, and measure whole-mesh time after the band, not time per sample.
- Prove the sweep bound, including the mitre wedge past each segment's end, where the plain segment distance is not a lower bound. As a cheaper first step, tighten the piece boxes from 1.5·reach to reach/cos(θ/2).
- Check the field bit for bit at every lattice sample of every sweep and tube in examples, dogfood and std.
- Count curve2's piece visits on the mixer's base and bowl before changing it.
- Run `npm run check` for unchanged bytes, and time whole renders of the rope, the nameplate, the teapot and std/hardware's chain.

**Cost.** An hour or two for the reuse, half a day for the cull, one to two days for sweeps and tubes, and as long again for curve2.

### 23. The viewer's light

**Why.** viewer.html is where an agent and a person see the GLB, and its Studio mode is badly lit in two ways:
- **The room is almost dark.** The viewer builds `new RoomEnvironment()` on three 0.160 without the renderer. RoomEnvironment raises its light to 900 cd only when handed a renderer that renders physical lights, as r160 does, so the light stays at 5 cd; from r165 it is 900 unconditionally. The room's six panels then carry nearly all its light. A white face turned down receives 0.004, and a polished metal reflects six panels on black.
- **There is no tone map,** so linear light is clipped. A white face turned up receives about 1.43 from the key, the hemisphere light and the room. At that level 21 of the 48 opaque non-metal presets clip a channel.

Round 11's door agent replaced the oak preset because it "read as new pine in the viewer": the viewer's oak came out (153, 113, 78) where the baked atlas is (119, 83, 46).

Khronos PBR Neutral is built so that a base colour comes out as itself under unit light: a channel between 0.08 and 0.8 leaves 0.04 lower, with no hue shift (KhronosGroup/ToneMapping). The glTF Sample Renderer defaults to it "for best color reproduction", and three has it from r162. Measured on the presets at unit light:

| Tone map | Levels off the base colour | Chroma kept |
| --- | --- | --- |
| Neutral | 1.8 | 99% |
| AgX | 29.3 | 54% |
| three's ACES | 20.3 | 74% |

**What.** The Studio mode, and the Scene mode the export branch adds, are lit through a tone map. A white face toward the key comes to about 1.0 linear, and a face turned down is not black. Nothing changes in the language.

**How.** Pin three at r165 or later, or pass the renderer on r160 and inject the curve through CustomToneMapping. Calibrate the key, the hemisphere light and scene.environmentIntensity together.

The curve is the render redesign's choice as much as the viewer's, because the viewer should end on the same curve as beauty.png. The two render branches already differ:
- render/shading takes Neutral's toe with a per-channel shoulder, because Neutral's hue-keeping desaturation turned the lantern's flame salmon;
- render/pathtrace uses its own shoulder and a 1.35 power.

Pin r187 if the viewer's glossy reflections are to use a true GGX lobe at each level, as render/shading's prefilter does; r181 to r186 blur each level from the one before.

**Prototype first.**
- Screenshot a plate of presets (white, red, yellow, gold, chrome, the woods) headless and online, since the page loads three from jsDelivr.
- Compare it with beauty.png at the shared default shot; the camera and key already agree to within 1.5 degrees. The target is about 3 levels mean for non-metals, with no clipped channel.
- Check that the Pages viewer pages still load and animate on the new three.
- Read round 11's door in both modes.

**Cost.** About a day. The Pages viewer pages change; no committed render does.

### 24. A leaner GLB and viewer page

**Why.** Indices are 32 to 41% of a plain model's GLB. They are always written as 32-bit, yet every mesh measured except the mug's has fewer than 65,536 vertices (the largest has 58,822). 16-bit indices and normalised 16-bit UVs are core glTF 2.0: every engine reads them, and so does src/import/glb.ts.

viewer.html embeds the GLB as base64, which is why roadmap 13 left "a separate cap for the viewer page" undone. DecompressionStream("deflate-raw") has been Baseline in browsers since May 2023 (MDN). A GLB deflated by Node's zlib and inflated in the page that way takes the mug's page from 5.00 MB to 1.73 and the workshop's from 8.53 MB to 2.84.

**What.** Smaller files, with the same meshes.

**How.**
- **Indices and UVs.** Write uint16 indices wherever a mesh has fewer than 65,536 vertices. Split larger meshes into primitives of at most 65,535 vertices, since the index 65535 is reserved. Write UVs as normalised uint16. The index change alone makes the tumbler 20.5% smaller, the robot 18%, the fence 16.6%, the workshop 16% and the lantern 8%.
- **The viewer.** Its deflate takes 80 to 300 ms, and two runs gave identical bytes.
- **Maps.** The atlas and maps shrink too. Written as RGB with min-sum adaptive filtering, the lantern's three maps are 17 to 19% smaller. The mug's flat atlas is smallest as RGB with no filter, so the encoder tries both per image. This is for atlases and maps only: the sheets keep their encoder, or every committed render would change.
- **Compression.** A quantized or meshopt-compressed GLB (KHR_mesh_quantization, EXT_meshopt_compression; the mug at 0.60 MB) can only be an opt-in second file. Both extensions must be listed as required, and Godot refuses any file whose required extensions it lacks (gltf_document.cpp).

**Prototype first.**
- Read every example's model.glb back through import() and the sheet, before and after, and confirm the mesh is unchanged.
- Check that the deflate gives the same bytes on CI's Node.
- Open each viewer.html headless and online with three 0.160.
- Run the Khronos validator on the new GLBs.

**Cost.** About a day. No committed render changes.

### 25. Promises from the brief, and a critic that has not read the program: an experiment

**Why.** The loop writes promises "once a thing is right", and then has the agent that wrote the program compare its pictures with its own plan. That is the weak kind of self-correction:
- no prior work shows prompted LLMs reliably correcting themselves without outside feedback (Kamoi et al., TACL 2024);
- GPT-4 put a handle on the left and declared it on the right (Makatura et al.);
- a VLM critic "tends to overestimate success" (Articulate-Anything, ICLR 2025).

Questions written from the description before looking beat a free critique. In CADCodeVerify (ICLR 2025) they reached a point-cloud distance of 0.127 against the critique's 0.137, and held the compile rate at 96.5% where the critique lost five points. Tests supplied with a problem also raise code success (Mathews and Nagappan, 2024). Against this: the VLM answered its own questions correctly only 64 to 68% of the time, and a static skill alone did not help (Son et al., 2026).

**What.**
- Step 1 of the skill and the agent guide lists 3 to 8 checkable claims from the brief, each with the number or the view that settles it.
- Every claim that is a number is written as an assert before the geometry, failing at first.
- Before the agent says it is done, a fresh subagent that sees only the brief and the pictures answers the claims.
- A "no" is settled by a number (check, an assert, a slice), never by the author rereading the same picture.

**How.** Docs only, kept in step between SKILL.md and docs/agent-guide.md.

**Prototype first.** An A/B dogfood round: four briefs, the current skill against brief-first with the blind critic. Measure planted defects found, renders to done, promises written and their audit score (17), and how often the critic's "no" was right when checked by a number. Change the docs only on that result. The round also shows whether two things matter: an assert written before the geometry needs step names that do not exist yet, and the critic needs a harness that can start a subagent.

**Cost.** Hours of docs, and one round.

### Notes for the renderer redesign

- **Read the extraction lattice for ray steps away from the surface.**
  - surfaceNets fills a Float32Array over the whole lattice and discards it.
  - A trilinear read costs 43 to 143 ns, against 0.57 to 3.9 µs for dist() on real programs.
  - At 0.5 to 6 cells from the surface, a read is within a median of 0.000 to 0.013 cells of dist(), and at most 0.54 cells off.
  - A hybrid that calls dist() within 2 cells of the surface ran the marched render 1.05 to 1.4 times faster (lantern 1.05, door 1.2, medal 1.3), and the path tracer 1.5 to 1.6 times faster at 4 spp, with pictures within 0.2 levels.
  - Reads must not be biased: shrinking them by half a cell moved 8% of the medal's pixels by more than 24 levels.
  - Against render/accel's mesh BVH (shadow rays 3.4 to 25 times faster), the lattice's value is that it returns distances, which the soft shadow's d/t needs. Benchmark the two per ray type.
  - Settle a memory cap: the full lattice is about 540 MB at 512 per side.
- **One meaning for a light's size.**
  - light(size=1) is 9.5 degrees in render/shading's highlight (tan = size/6) and 2.9 degrees in render/pathtrace's disc (size/20).
  - The disc was chosen to look like the marched render's soft shadow, which draws only the outer half of a penumbra. Against a true disc that shadow's mean error over the penumbra is 0.24 to 0.31. Behind a unit cube at size 3 its 50% line lies 0.47 units too far out.
  - Quilez's inner-penumbra variant with a fixed 1.5-cell thin-sheet guard is better on a 2-cell plate. On plates 4 to 8 cells thick it is worse than today's shadow, at 4.5 times the steps. It waits for a guard that scales with the cone's footprint.
- **One display transform** for beauty.png, the path tracer and the viewer (23). Choose it by the lantern's flame and gold highlights: at unit light every candidate is close to Neutral by construction, so that test cannot decide.
- **Pruning and step size.**
  - Prune the tree per screen tile (Barbier et al., 'Lipschitz Pruning', CGF 44(2), Eurographics 2025: sphere tracing 8 to 629 times faster). The paper's 1.0 to 1.17 active nodes per cell include far-field culling; without it they are 1.43 to 2.56.
  - Segment-trace with the per-node factors from proposal 15 (Galin et al., CGF 39(2), 2020).
  - A far-field stand-in, sign(d)(|d| − R), is safe on primary rays only, never in shadows or AO (design.md, "A grid over the pieces").
- **Over-relaxed sphere tracing does not pay here.** On surfaceExtent's rays it took more evaluations per ray than plain marching (mixer 13.8 to 15.1, rope 14.8 to 16.4, stairs 13.6 to 14.6), gained nothing at ω 1.2 either, and moved hits by up to 0.056. Bán and Valasek (EG 2023) find the variants within 2 to 25% of each other. Rays that miss are 42 to 64% of those evaluations.
- **Workers re-evaluate the program,** since closures cannot cross threads. That took 5 ms for the tree example, 62 for the mug, 264 for the stairs and 508 to 600 for the rope. The same pool could fill the mesher's lattice by slabs with the same bits; measure that after 15, which shrinks the work.
- **Blue-noise sample rotations.** Use a 64×64 void-and-cluster mask, built from a fixed seed at load in 67 ms, in place of the per-pixel hash for the Cranley-Patterson offsets.
  - On one soft-shadow integrand it cut error after a blur by 26% at 4 spp and 20% at 8 (Georgiev and Fajardo, SIGGRAPH 2016 Talks; Heitz and Belcour, EGSR 2019).
  - Measure it through the real à-trous filter against a 256-spp reference before changing the default spp.
  - Interleaved gradient noise and Owen-scrambled Sobol did not help at 4 to 8 spp.
- **Coat and ior.** If the redesign gives materials ior= or a clear coat, the GLB writes KHR_materials_ior and KHR_materials_clearcoat from the same definition. three.js, Blender, Babylon and glTFast read clearcoat; Godot ignores it.
- **Cone-traced AO on the lattice** (6 cones of 6 reads) correlates with ray-traced AO at 0.77 to 0.97, against 0.62 to 0.85 for the five taps. But it was tuned on the same five programs, and at the measured 57 to 143 ns a read it only breaks even on cost. It is an option for render/shading's marched path once the lattice is kept.

### Smaller items from the research

- **`aixle doc NAME`: built.** `aixle doc sweep` prints the entry under its group heading (the description, every signature, which is the usage a failed call prints, and the parameters), `aixle doc joint` a section the reference writes by hand, `aixle doc oak` a preset's row, and several names at once; a name the reference lacks fails with the names nearest it (`cylnder`: cylinder, center). `aixle doc` alone and `aixle doc lib.aix` print what they did. As proposed: `aixle doc NAME` should print one builtin's entry (signature, description, a usage), and the nearest names for an unknown one. Today it prints the whole 886-line reference, because src/cli.ts treats any argument not ending in `.aix` as no argument. Retrieved docs help code generation in unfamiliar libraries (DocPrompting, ICLR 2023; LL3M), though Aixle's 40 thousand tokens of docs fit in context.
- **Roblox: one primitive per mesh.** The importer makes one MeshPart per glTF primitive, and Merge Meshes is off by default. So the shipped tophat accessory's Handle (felt and silk) arrives as two MeshParts, while the report says one mesh. Merging is safe because that export carries only the colour atlas. Two related fixes: the documented limit per mesh is 20,000 triangles against Aixle's 10,000, and the docs allow one animation track per model, which the Roblox row should say when a program has several clips. A person with Studio checks it.
- **Bedrock: the block's limit.** Warn when block geometry (the default `--minecraft` output) is over 30 pixels on a side, reaches past ±30 pixels of the origin, or has no pixel inside the base block on some axis (Microsoft's custom block rules). The mug comes out at 60 × 38 × 38 pixels, x from -41 to 19, with no warning. A `.mcaddon` pack written by the existing zip writer could follow. Its UUIDs should hash the content as well as the name, so two models with one name do not collide in the game.
- **Decimation keeps a manifold mesh manifold.** Refuse a collapse that fails the link condition (Dey et al., 1999). A 2-cell rod cut to 82 triangles gains 3 non-manifold edges; cut to 28, it gains 9 and a pinched vertex. Once 14 is in, the exports are the only outputs that can still lose manifoldness. The export branch has already answered the shading streaks on cut-down meshes, by baking the field's normal for every material.
- **`aixle diff` shows what changed.** Colour the material only in A and only in B (the XOR of the two fields' signs) on its views, and print each changed region's volume and centre with the nearest step. On the mug, a handle moved 0.1 was found and placed in 60 ms at 48³. VLMs miss small differences between two pictures (Rahmanzadehgervi et al., ACCV 2024), and judge two 3D assets reliably only side by side (GPTEval3D, CVPR 2024).
- **'On the plate' by PrusaSlicer's stability heuristic.** The 2%-of-footprint contact rule ignores height. Replace it with a 10 gram-force push at the model's height against the contact patch's section modulus times 0.02 MPa for PLA (SupportSpotsGenerator), and word it as that slicer's heuristic. It flags a 50 mm spire on a 3 mm foot (0.05 against 4.9 N·mm).

### Kept for after these

- **A printer setting, FDM first.** `set printer fdm nozzle=0.4 layer=0.2` would set:
  - the overhang angle, by PrusaSlicer's automatic rule of half the line width over the layer height (48 degrees at 0.45 mm lines; Cura's default is 50, Aixle's fixed angle 45);
  - the bridge span that 20 uses;
  - walls read in lines: 0.45 mm and 0.86 mm for one and two, dropped under 0.1 mm and widened to 0.34 mm by Arachne (PrusaSlicer's Flow.cpp and PrintConfig.cpp).

  Resin and SLS wait until their sources agree and a program targets them. The Form 4 guide gives 0.2 mm walls and 0.75 mm drains where Hubs gives 0.4 to 0.6 and 3.5.
- **Which way up to print,** after 20.
  - Score the exact face-down poses of the mesh's large flat clusters and hull faces, plus the six axis poses, with 20's estimate. PrusaSlicer's Rotfinder, Tweaker-3 and OrcaSlicer's Orient.cpp choose candidates the same way.
  - On the stand at grid 64, 11 candidates took 0.66 s and ranked in grid 200's order (72, 9,036, 8,971 and 102,371 mm³).
  - A sampled sphere of poses misses the flat ones: a 3.4-degree tilt reads 15,368 mm³. Near-duplicate candidates must merge.
  - No agent asked for it, and slicers orient parts themselves.
- **USDZ for AR Quick Look.** A usda layer and the PNGs in a stored zip whose files start on 64-byte boundaries (OpenUSD's usdz spec), as three.js's USDZExporter writes for model-viewer.
  - A scratch converter's mug and lantern passed all 30 of usd-core 26.11's validators. The mug's file is 8.45 MB, against a 3.75 MB GLB.
  - RealityKit ignores a normal map's scale and bias, so the normal map needs a check on a device.
  - model-viewer already makes a USDZ from a GLB, and no round asked for one.

### Researched and set aside

- **Per-block pruned trees for the mesher (Lipschitz pruning).** Aixle's culled unions already evaluate 1.7 to 2.3 children near the surface, against an ideal of 1.0 to 1.15. The remaining cost is inside primitives, which pruning does not touch, and every operator would need a prune case. Bring it back only with a profile, taken after 15 and 22, that shows booleans dominating.
- **Compiling the tree to straight-line JavaScript, or interval and affine evaluators.** Generated code was bit-identical but only 1.03 to 1.64 times faster on realistic parts, and 0.5 times on a cup in the rerun. Fidget's JIT is about 25% faster than its interpreter once pruning is on (project page). Compilation needs an IR and a second definition of every operator, against rule 3. For a 1-Lipschitz field, one scalar sample already bounds a ball as tightly as intervals can.
- **Caching field values and interpolating them** (ADF or VDB style). It gives up exactness. The only exact repeat is the export's mesh, which 22 reuses.
- **Hierarchical lattices for the asserts, as a separate proposal.** They are exact and use 2 to 50 times fewer evaluations, but overlap and void take only 0.1 to 0.5 s of a 5 to 7 s check. The assert time is in meshing for wall() and pieces(), which 15 answers, and in clearance and surfaceExtent. Folded into 15's walker.
- **Octree refinement where a program is thin.** It would be 800 to 1200 lines. Its only measured need is synthetic rods under 1.6 cells. At the agents' own grids the manifold mesher split no thin part, and with the band, grid 300 samples in under a second. Revisit by counting the thin parts that split at the grids agents start from.
- **Exact crossings and a truncated pseudo-inverse QEF, on their own.** The gain is small, no round records friction from them, every render would regenerate, and the error measure misreads bound fields. They can ride along with 14's regeneration.
- **Subgrid marching tetrahedra** (Baktash, Gillespie and Crane, SIGGRAPH 2026). It needs a new grid and a new algorithm, and by its own account can miss thin tube-like features.
- **A Hosek-Wilkie sky.** No round asked for a physical sky, render/shading has just rebuilt the skies, and the cited data are XYZ, not RGB.
- **Run history and a regression warning.** A broken assert already fails check, agents work in git worktrees, and no report lost a better version. The rollback evidence comes from per-brick generation (BrickGPT) and candidate tournaments (BlenderAlchemy), not an edit loop. The diff overlay above is the part worth having.
- **`aixle compare` against a reference shape or a photo.** No brief in eleven rounds came with a reference. IoU needs exact registration: a 0.05 shift of the mug drops it to 0.87. Round 3's re-imports were export checks, now partly done by the Exports row.
- **Coordinate labels, dimension lines and cross-view marks on the sheet.** The literature is sound: VLMs count grid lines poorly, and labelled scaffolds help. But agents take sizes from check's numbers, no report asks for labels, the round-11 evidence offered for it was misread, and every render would regenerate. A reading test with fresh agents comes first.
- **Mass at a slicer's defaults.** The proposal used the profiles' minimum shell thicknesses, not the effective ones: PrusaSlicer's effective top and bottom shells are 1.0 and 0.8 mm, and Cura's 0.8 and 0.8. The estimate was checked only against itself, and round 11 said a slicer's infill takes the weight out anyway.
- **Collision proxies named by convention.** Only Godot reads them; everywhere else, Roblox and Aixle's viewer included, they are a stray mesh.
- **Draco, KTX2/Basis, WebP, MSFT_lod, KHR_texture_transform, GPU instancing and a usdc writer.**
  - Draco and Basis need large native encoders, against rule 1.
  - WebP needs a VP8L encoder and glTFast will not read it; revisit it with glTF 2.1, which promotes it.
  - MSFT_lod is read only by Babylon.
  - The texture transform has nothing to do, since the atlas UVs are already in [0, 1].
  - Instancing saves little, since placements already share a mesh.
  - usdc would be a week of work for a format defined only by OpenUSD's source.

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

## What was considered and set aside

- **A full material node graph.** Patterns as a fixed set with
  parameters have covered every request so far; the extensibility that
  matters is `use` and image textures, not a graph language.
- **Runtime plugins in JavaScript.** They would break the rule that a
  program means the same thing everywhere; libraries in the language
  itself (`use`) give the same growth without it.
- **Physics simulation.** Stability and pieces are checked; anything
  more belongs to the engine the GLB is loaded into.
