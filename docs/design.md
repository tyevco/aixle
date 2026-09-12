# Design notes

Why Aixle is built the way it is, and where the edges are.

## Distance fields, not meshes

The choice that everything else follows from: a shape is a function from a
point to its signed distance from the surface (negative inside), plus a
bounding box and a material query. Mesh CSG needs robust intersection of
triangle soups and fails on coincident faces, the exact case a model built
from stacked boxes produces constantly. On distance fields a union is
`min`, a difference is `max(a, -b)`, and they cannot fail. The operations
an agent reaches for to make a model look designed rather than assembled,
rounding, hollowing, smooth blends, twisting, roughening, are one line each
on a field and research problems on a mesh. Cross-sections, the single most
useful check of a model with an inside, are free.

The cost is that nothing is a mesh until the end, and the end is a grid.
Detail thinner than a cell is gone. That is stated on every sheet.

## Exactness where it matters

Primitives use the standard exact formulas. Hard booleans, translation,
rotation and uniform scale keep exactness. Smooth blends, non-uniform
scale, twist, bend and displacement produce a field that is still correct
in sign and near zero at the surface but is no longer a true distance
elsewhere. Surface extraction only needs the sign and the values near
zero, so this is fine for the pictures and the mesh; a `round` applied
*after* a twist is approximate, and the language guide says so.

Bounds are propagated conservatively through everything: never smaller
than the truth, sometimes larger (a rotated box's box, a twisted shape's
cylinder). The extraction grid covers the bounds, so a loose bound costs
cells, never correctness.

## Unions are culled, and flattened

A model is mostly a union of parts. Each `union` node keeps its children's
boxes in flat arrays and skips any child whose box is farther than the best
distance so far, which is exact for `min`. A shape accumulated in a loop
(`all = all + part`) would otherwise nest fifty unions deep, so a hard union
flattens hard unions into one list. A hundred parts cost about a hundred
box tests per sample, and only the near ones are evaluated.

## Surface nets with dual contouring, not marching cubes

One vertex per cell that has a sign change; one quad per crossing lattice
edge. It is closed and manifold for any field, has no case table, and a
sphere at 48 cells is within three percent of its volume. Normals come from
the field's gradient, not from the faces, so shading is smooth where the
surface is smooth.

The vertex is placed by dual contouring: the gradient at each edge crossing
gives a tangent plane, and the vertex is the point that minimises its
squared distance to those planes, regularised towards the crossings' mean
(so a flat face does not slide) and clamped to its cell (so it cannot
wander). A box's vertex lands on its corner to within a few percent of a
cell and a gear tooth keeps its edge. Quads are split along their shorter
diagonal so a quad bent around a corner does not fold. Crossing points and
their normals are computed once per lattice edge and shared by the four
cells around it, so sharpness costs about six field evaluations per
crossing edge. `sharp: false` gives the plain surface-nets mean back.

## One mesh, rendered and exported; one field, for the beauty render

The checking views draw the extracted mesh, not the field. That was a
choice between fidelity and honesty: the picture and the OBJ cannot
disagree, so the agent verifies the file it ships.

`beauty.png` is the other way round: the field itself, ray-marched, with a
soft shadow (a second march towards the light), ambient occlusion (five
samples along the normal) and a studio floor, for the picture that shows
the model as meant. It stays cheap by using the mesh: each ray starts a few
cells short of where the rasterised depth says the surface is, marches only
that window, and falls back to the mesh's point if the march misses; empty
space costs nothing, shadow rays that cannot reach the model's box are
skipped, and only edge pixels (found by comparing depth, normal and
material with their neighbours) are sampled four times. A 512-pixel render
of the mug takes under a second. The rasteriser is a plain z-buffered
triangle filler with perspective-correct attributes and per-pixel shading;
an outline pass darkens depth and normal discontinuities, which is what
keeps a 384-pixel thumbnail readable.

Fixed lights in camera space mean every view is lit the same way whatever
the model's orientation.

## Materials without UVs

A material is a colour, a second colour, and a procedural pattern evaluated
at a 3D point. The point is in the frame where `paint` was applied: the
material query carries it through every transform above the paint, so wood
grain stays on a table leg when the leg is moved. The renderer samples the
pattern per pixel from the interpolated local point; the exporters sample it
per vertex (vertex colours in the GLB; the OBJ can only carry the base
colour in its MTL). Unwrapping to a texture atlas is possible later and
would be the way to carry the patterns into engines that ignore vertex
colour.

Where two materials meet, a triangle takes the material of its nearest
vertex per pixel, which makes a clean edge at grid resolution.

## The language

Designed for a model to write, not a person to type: one statement per
line, everything named, arguments by name where the order is not obvious,
degrees everywhere, `|` for "then", and errors that say the line, the
function, the parameter and the usage. Overloads on the first argument's
kind (a shape or a profile) keep one vocabulary for 2D and 3D. The builtin
table is the reference: the interpreter binds from it and `aixle doc`
prints it, so documentation cannot drift from behaviour.

Deliberately absent: conditionals, recursion beyond a depth guard,
side-effects. A program is a straight-line construction with loops and
parametric parts. That is enough for what has been tried, and it keeps every
step renderable on its own.

## Paths

`tube` is a chain of capsules (exact). `sweep` gives each polyline segment
a frame (across, up, along; the up vector kept as close to world y as the
segment allows, and carried from segment to segment so it does not flip)
and extrudes the profile in that frame, cut at each join by the plane that
bisects the angle, so neighbours tile exactly. The cut only acts beyond its
plane: measured the other way, with the plane's distance inside the piece
too, every join read as a dent, because the extractor interpolates values
across an edge and the marcher trusts them, and a swept handle came out
corrugated. `smooth=` matters on tight bends because each piece is straight. `loft` blends the two
profiles' distances linearly along the height: sign-exact, approximate in
between, and enough for shades, hulls and tapered handles.

## The viewer

`viewer.html` embeds the GLB as base64 so it opens from disk with no
server, and loads three.js from a CDN, so it needs a network connection
once. It exists for people; an agent verifies from the PNGs.

## What is not here yet

- Sweeps along true curves with twist control; text.
- Texture baking to an atlas for the GLB (patterns travel as vertex colours).
- Refraction for glass, area lights, depth of field in the beauty render.
