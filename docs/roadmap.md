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

## 4. Printing: STL, hollowing, a print report

**Why.** Round 4's bar was print-readiness, and the pieces, cavity,
watertight, stands and overhang checks exist, as do `model.stl` and
`hollow(shape, wall, x, y, z)` (built for that round); what is missing
is the report a slicer's user wants before opening it.

**What.** A print section in the report: minimum wall thickness found
(from the feature sizes and the mesh), support volume estimate from the
overhang faces, whether it fits a named bed (`set bed 200 200 200`), and
the unit assumed (`set units mm`). Round 4 also asked for the distance
between the two surfaces at an open edge ("the barrel's side is 0.03
from the bracket's top"), which the same inward-ray pass can give.

**How.** The print report reads what physics already computes plus one
pass over the mesh for the thinnest local wall (ray from each vertex
inward along its normal).

**Must prototype.** Whether the inward-ray wall thickness agrees with
the feature sizes on the examples.

## 5. Smooth 2D profiles

**Why.** `polygon` is the only way to draw a profile, so a vase, a
bottle, a chair's side or a car's outline is a list of corners and looks
it once revolved; `curve()` exists for paths but not for profiles.

**What.** `curve2([x,y, x,y, ...])` through the points and
`bezier2([...])` from handles, as 2D profiles for `extrude`, `revolve`,
`sweep` and `loft`, exact like their 3D counterparts.

**How.** The nearest-point machinery in `curves.ts` restricted to a
plane; a closed profile needs the sign from winding, which `polygon`
already computes.

**Must prototype.** Nothing; the 3D version is measured.

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

## 11. An import cache: built

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

## 12. Decimation for web exports: built

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
the row says so below a quarter. Not built: a decimator that weighs
normals as well as positions, which a cap below a quarter would want;
a separate cap for the viewer page, which embeds the GLB as it is; and
decimating the STL, which is for a printer.

## Smaller, worth doing when passing

- `aixle fmt`: one layout for programs, comments kept, so diffs are
  about the model.
- Records: `p = {x: 1, y: 2}` with `p.x`, for readable parameters.
- A `--stl`-style `--3mf` for slicers that want units and colours.
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
