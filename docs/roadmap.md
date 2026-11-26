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
48 to 55; at 2048, 17.8 s against 2.1 s and 150 MB against 55. A plain
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

## Smaller, worth doing when passing

- `aixle fmt`: one layout for programs, comments kept, so diffs are
  about the model.
- Records: `p = {x: 1, y: 2}` with `p.x`, for readable parameters.
- An import cache keyed by the file's hash, so `check` and `render` do
  not both sample a large mesh.
- A `--stl`-style `--3mf` for slicers that want units and colours.
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
