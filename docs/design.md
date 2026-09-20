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

## A grid over the pieces

Box culling alone is linear in the number of parts, and a sweep along a
helix has a hundred pieces whose boxes all overlap. Unions of more than a
dozen parts, tubes and sweeps therefore build a uniform grid over their
pieces' boxes once. Each cell lists the pieces within one cell of it and
carries a floor: the distance from the cell to the nearest unlisted piece's
box. A query evaluates the listed pieces, and only when the floor is below
the best so far scans the unlisted pieces with the ordinary box cull, so
the result is exact everywhere and the scan almost never runs near the
surface. A first version returned the floor itself as a lower bound: that
is sign-exact and never overestimates, which extraction accepts, but the
beauty render's soft shadows read the cell-shaped shortfall as nearby
geometry and drew the grid on the floor. Measured: the staircase went from
twelve seconds to five, the rope from fifty-nine to sixteen, and the
indexed forms agree with the plain minimum to nine places at every sampled
point.

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
The tangent planes' normals come from a finer difference (a tenth of a
cell) than the vertex normals: half a cell each way straddles the next
face near an edge, tilts the plane, and leaves the vertex a quarter of a
cell short of the edge with a sliver of bevel beside it (measured on a
box: an edge at z = -0.5 meshed at -0.484).

Sharp geometry still shaded soft, because a vertex carries one normal
and on an edge that normal is the field's gradient, which points between
the faces; every renderer interpolates it across both, so a box read as
bevelled and a block on a cylinder as melted in, in the sheets, the
viewer and any GLB consumer. A vertex whose faces disagree by more than
the crease angle (35 degrees) is now split once per group of agreeing
faces, each copy with its group's mean face normal and the material read
just inside its own side, so the seam between a red ball and an oak slab
is oak on the slab and red on the ball. An unsplit vertex whose faces
agree within fifteen degrees takes their mean too, which is exact on a
flat face; a surface bent more than that per cell keeps the gradient,
which is smoother there. The copies share a position, so the watertight
and pieces checks weld them back by position before counting.

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

## Minecraft geometry

A Bedrock entity or block model is not a mesh but a list of axis-aligned
cuboids, each face a window into one texture, in pixels at sixteen to the
block. Rather than fit boxes to the mesh, the exporter samples the field
on the pixel lattice (a unit is a block, so a 0.75-tall table is twelve
pixels) and merges the filled voxels greedily: a run along one axis, the
row grown along a second, the slab along the third. Which axis leads
changes the count (a mug's wall wants vertical runs, a table top
horizontal ones), so all six orders are tried and the fewest cubes kept:
a mug is about two hundred. Each face window is painted by reading the
material just inside the face through the same `albedo()` the renders
use, so a decal and a wood pattern come through, and the windows are
shelf-packed into a power-of-two texture. Bedrock draws geometry with x
mirrored (measured in the Minecraft repo this tool grew up beside: a
cube authored on +x lands on the block's west), so cubes are authored at
-x and the model stands in the game as on the sheet. An entity faces
north, so its model is turned half a turn about y first, which with the
mirror is a flip of z.

A joint is a bone: its pivot in geometry pixels, its parent the joint
above it, its cubes the joint's part with the joints inside it left out,
the same walk the GLB's node tree makes. The animations are the same
samples the GLB gets (a linear clip at its keys, an eased one at eight
per segment, since Bedrock interpolates linearly too), written as
keyframes per bone. Bedrock's bone rotation is an Euler triple applied
z, y, x (x first, as `rotate` does) with the x and y angles negated in
geometry space, and geometry space is the mirror of the world: the
convention Blockbench's Bedrock codec and the Minecraft repo's viewer
render with, and the one under which that repo's hatchling flaps the
way its file says. Conjugating through the mirror, a right-handed
rotation (rx, ry, rz) in the world is written (-rx, ry, -rz) for a
block, and for an entity, turned half a turn, it is written as it is:
the Aixle hatchling, built from the Bedrock file's numbers with z
flipped, exports the file's numbers back. A test pushes a cube's centre
through that convention for the exported numbers and checks it lands
inside the posed shape, for both orientations. What the game does with
the texture windows' orientation is still to be seen in it.

## Roblox

Studio's 3D Importer takes a glTF, so Roblox needs no new writer, only
the GLB arranged its way: a unit is a stud, a character faces -Z where an
Aixle model faces +z, so the export's root is turned half a turn about y
and a hat's brim built on +z lands over the face; a rigid accessory is
one mesh under four thousand triangles, so a single object is exported
under a node named `Handle` and decimated to the budget (a MeshPart in a
place gets ten thousand per mesh); and the Accessory Fitting Tool wants
an attachment, so every
anchor named like one (`HatAttachment`, `BodyBackAttachment`) is written
as an empty child node with the importer's `_Att` suffix, at the point
the program gave it. The size limits per attachment type at the Normal
body scale are a table in the exporter and a row in the report, not a
gate: a place's furniture has none. Which face of a piece meets the
character is a modelling convention the examples state: a backpack's
straps on +z, the character's back after the turn.

The decimation is quadric error with half-edge collapses: an edge's ends
are candidates to move onto the other at the cost of the mover's
quadric (its faces' plane quadrics, area-weighted) evaluated at the
survivor, so a vertex on a flat face goes for nothing and a corner
stays. Moving onto an existing vertex rather than to a new optimum keeps
every attribute exact, the survivor's material and local point included,
which is what the atlas baker needs; a collapse that would cross a
material boundary or fold a face over is refused, so seams and the
outline survive. The mesher's crease copies are welded first and the
result re-split by the same rule. A top hat meshed at 71 thousand
triangles comes out at 4000 with its brim, band and crown intact, read
back through `import()`.

## Imported meshes

An imported mesh becomes a field by sampling: unsigned distance on a grid
over the mesh (a bounding-volume hierarchy of point-triangle queries) and
a sign from the parity of ray crossings along each grid line, read back by
trilinear interpolation. Parity is right for closed meshes and is the best
that can be done for open ones, which the report flags. Measured: with the
grid lines starting exactly at the mesh's bounding-box minimum, rays ran
through extreme vertices and edges and whole runs of samples flipped, so
the grid origin is offset by an irrational fraction of a cell and only
strict interior crossings count (a ray on a shared edge then counts zero
for both triangles, which leaves the parity right). The imported detail is
bounded by the sampling grid, and a sampled field is only approximately a
distance, which extraction does not mind.

## Scenes, joints and poses

A scene is several named shapes; the export builds a node tree from them.
An object's own geometry is the shape extracted with every joint inside it
hidden (a joint node reads as empty while hidden), each top-level joint is
a child node at its pivot with its child shape extracted the same way and
made relative to the pivot, and a placed shape is a node per copy over one
mesh. Every mesh is extracted at the same cell size and all of them share
one atlas: they are merged for baking and split again with their UVs.

A joint is a plain transform of its part about the pivot, built with
what a pose gives it (a scale about the pivot, then the turn, then a
move: glTF's own order, so a viewer composes the channels the way the
sheet drew them), and a pose is applied by evaluating the program
again with those values: an evaluation takes milliseconds, every joint
then has exact transformed bounds, and nested joints are set before the
parent is built, so they follow it. The first design had
a joint read live angles from a mutable state instead; its bounds then had
to cover every rotation, which made a five-unit arm sixteen units across
and wasted most of the extraction grid on air. Exports are at rest, with
the poses as glTF rotation channels on the joint nodes, and translation
and scale channels only on the joints a pose moves or scales.

An animation's keys are evenly spaced unless it gives times, and blend
linearly unless it gives an ease, a cosine blend that slows to a stop
at each key. glTF samplers are linear (its cubic spline needs tangents
a pose does not have), so an eased animation is written as eight linear
keys per segment: the file grows a little and every viewer plays the
same curve the strip shows.

## Twist, taper, text

Twist and taper are functions of arc length applied inside each straight
piece of a sweep, so they are continuous across the mitres; a twisted
profile's distance is only sign-exact, like the `twist` modifier, which
extraction does not mind. Text is a single-stroke font: each glyph is a few
polylines on a 4 by 6 grid, and the profile is everything within half the
weight of them, a chain of 2D capsules, so the letters are exact and round
themselves off at the weight. It was checked by rendering every glyph on
one plate and reading it.

## Physical checks

Volume and centre of mass come from the closed mesh by the divergence
theorem; the base footprint is the convex hull of the vertices within a
cell and a half of the lowest point; the model stands when the centre of
mass projects inside that hull, and the margin says by how much. Pieces
are the connected components of the triangle graph, each with its own
volume, so a sliver left by a cut is reported as a speck and a part that
never touched the rest as a floating piece. Overhang is the share of the
surface area whose normal points down more than 45 degrees, floor faces
excluded. None of this needs the field: it is what the mesh says, which is
what would be printed.

### The model's own promises

Every dogfooding report carried a line like "the handle must clear the
rim text" that lived only in the report, so the next agent to edit the
program could not know what it broke. `assert` puts the promise in the
program: a comparison (a number, 1 or 0) with a message, run on every
evaluation, printed by `check` with both sides as they came out and
failing the check, counted by `render` as a warning. The two queries that
make it useful are measured the way the report measures: `pieces` meshes
the shape at a grid and counts as the Pieces row does, so `pieces(m) ==
1` means what the render says; `clearance` samples each shape's field
from a lattice over its box, projects the samples onto its surface, reads
them in the other field, and tightens the best pair by alternating
projections, so two parts that face each other get their exact gap and
an overlap comes back negative by its depth.

## Feature sizes

A bounding box sees a thin plate but not a thin wall: a shelled cup is as
big as the cup. So a shape carries `feature`, the thinnest thing it knows
it contains: a shell sets its wall, a tube twice its radius, text its
stroke weight, and every transform, boolean and union passes the smallest
one along (a scale multiplies it by its smallest factor). The thin-part
warning reads it next to the cell size and names the step that introduced
it, which is the line to edit.

## Glass, a light with a size, depth of field

A transmitting material is shaded by continuing the ray: refract in at the
surface, march the inside of the field (the sign flipped) to the far wall,
refract out, and shade whatever that ray meets next, an opaque surface
(shaded in full, no further glass), the floor with its shadow, or the
backdrop; the colour survives in proportion to the thickness crossed. A
reflection of the same environment is mixed in by Fresnel, and the key
highlight sits on top. One bounce each way is enough for a tumbler and
costs about as much as a shadow ray. The light's size is the softness of
the shadow march; depth of field is a post-process gather blur whose
radius grows with distance from the focus plane through the model's
centre, weighted so a sharp foreground does not smear across a blurred
background.

## Noise and dither

The procedural patterns and `displace` run on gradient (Perlin) noise:
value noise, which they used first, has its random values at the
lattice points, so its blotches sit on a grid and read as patches on a
skin and bands in a marble's veins, at the coarse atlas above all.
Gradient noise has nothing to show at the lattice. Every computed colour
is quantised to 8 bits through a dither (interleaved gradient noise per
pixel, a triangular distribution one level wide), in the beauty render,
the sheets and the atlas, so a slow gradient becomes fine grain rather
than bands a dozen pixels wide; it is a function of the pixel position,
so renders stay reproducible byte for byte.

## Materials without UVs, and the atlas that bakes them anyway

A material is a colour, a second colour, and a procedural pattern evaluated
at a 3D point. The point is in the frame where `paint` was applied: the
material query carries it through every transform above the paint, so wood
grain stays on a table leg when the leg is moved. The renderer samples the
pattern per pixel from the interpolated local point.

For the exports the patterns are baked into a texture atlas (`model.png`),
because most engines ignore vertex colours and a mesh whose colour lives
only in a function cannot leave the tool. Each triangle takes the axis its
normal points along most; triangles sharing an edge and an axis form a
chart; a chart is projected flat along its axis (nearly distortion-free for
a surface facing that way), and charts are shelf-packed at one
texels-per-unit scale with padding. Every texel is shaded by the same
`albedo()` from its interpolated local point, chart borders are dilated so
filtering never bleeds background into a seam, and vertices are split per
chart so each has one UV. The GLB embeds the PNG and samples it; the OBJ
gets `vt` and `map_Kd`. Vertex colours are left out of a textured GLB,
because a viewer multiplies the two and would show the pattern squared.
The known limit is a patch that folds back on itself along its own axis
within one chart: those texels are written twice and the later triangle
wins.

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

## Exact curves

A polyline sweep is exact per segment and mitred at the joins; a spline
densified to a few degrees per piece hides the facets but a close-up still
finds them. `bezier` and `curve` carry a chain of cubic segments and every
distance query finds the nearest point on the true curve (a coarse scan,
then Newton on the dot product with the tangent, all in scalars) and
measures the profile in the normal plane there, which is the plane the
profile lies in. A tube along it is exact; a sweep is exact wherever the
curve's radius exceeds the profile's reach. The frame is rotation
minimising (double reflection at build time, re-orthogonalised against
the exact tangent at the query), so a rectangle swept round a bend does
not roll.

## Extents before extraction, and close-ups

The bounding box sets the cell size, and a box is loose whenever a joint
turns (the box of a turned box), a union blends, or a difference cuts;
measured on a posed excavator, the box was twice the surface and cost a
third of the resolution. So extraction runs twice: a coarse pass finds
the surface's extent, and the fine pass is laid over that box. A focused
render goes further: the model is clipped to the focused step's extent
and re-extracted at that box's own cell, so a small part is drawn with
its own detail rather than the scene's, and the slices and the beauty
render are framed on it too. Focus is a close-up, not a reframing.

## Lighting a metal, lighting a lamp

A metal is mostly what it reflects, and a fixed sky is not enough for
gold to read as gold: the beauty render bounces one ray off a metal
surface into the scene (the model, the floor, the backdrop), blurred
towards the plain sky by roughness, and tints it by the metal's colour.
The key light can be placed (`set light_azimuth`, `set light_elevation`),
the ambient light scaled, and a material can glow, which is added
unshadowed so a flame inside a lantern is a flame.

## The serif face

Serifs are added by rule, not drawn: a slab across every free end of a
stroke that stops on a guide line and is not running along it. Junctions
(a crossbar meeting a stem) and curved terminals get none. That gives the
sans skeleton a second voice at no authoring cost, and the plate of every
glyph was rendered and read to check it.

## The viewer

`viewer.html` embeds the GLB as base64 so it opens from disk with no
server, and loads three.js from a CDN, so it needs a network connection
once. It exists for people; an agent verifies from the PNGs. With
animations it grows a bar along the bottom: loop, speed, a scrub bar
that pauses the clip at a moment, and a button that plays every clip
once in turn, so a person can check a rig's timing without a second
tool. The page keeps its own paused and finished flags because
three.js's action reports a clip that ran to its end as paused.

## Libraries

`use` runs a library file as a program of its own, in its own root
scope, and exports what that run defined that is not a shape: its
defs, materials, numbers, strings and lists, under a prefix. A def
carries its root scope as its closure, so a library's def called from
a program sees the library's helpers, constants and uses, never the
caller's; two libraries may use the same helper names, and a program
may shadow one, and nothing crosses. Its shapes are its own: the `show`
at the bottom of every shipped library is its preview and its test
(`aixle render std/hardware.aix`), and costs a user nothing but the
closures. The shipped `std/` is a folder of ordinary `.aix` files beside
`src/`; there is no registry, and `aixle doc lib.aix` reads the defs and
the comments above them, so a library documents itself the way the
builtins do.

## Anchors

Every dogfooding round spent most of its iterations on placement
arithmetic, so a shape can carry named points. `anchor()` is a wrapper
node holding the point in the part's own frame; nothing else in the tree
knows about anchors. `anchorsOf()` walks down from a node and carries
each child's anchors up through the node's forward map (`warp`), which
every rigid transform, twist, bend, wrap and joint provides (the joint's
is the pose's turn about the pivot), so a point is wherever its part
ended up, in whatever pose. A union merges its parts' anchors, first
part winning a name; a cut keeps the first shape's; a placed set keeps
none. The free anchors (`top`, `centre`, ...) are read from the node's
box on demand, so they cost nothing and every shape has them. `attach`
is `move` by the difference of two anchors; the interpreter has no idea
it is anything else.

## Explain

`aixle explain` is the first thing to run on a program someone else
wrote: the evaluation records which steps each step read, so the tree
from the output down is a printer over that record, each node with its
own source line, size, paint state, joint and anchors. It reads the
program's structure without rendering anything, which round 4's agents
spent their first renders working out.

## What is not here yet

Proposals for what comes next, each with what must be prototyped first,
are in `roadmap.md`: a full PBR bake from the field, `use` for libraries
of parts, a print report, smooth 2D profiles, `assert`, image textures,
lights and cameras in the language, and callouts on the views.
