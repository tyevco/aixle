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

## A narrow band: sampling only near the surface

Most of a heavy render is field evaluation, and most of the lattice is far
from the surface: within a cell of it lie 3 to 10% of the points on the
examples (27% on round 11's bookcase, its books packed close), yet the
lattice was 55 to 87% of the mesher's field calls. The lattice is now
filled by blocks of 32 points a side. A block's centre is read first; if
it reads |d| > L (r + cell) + slack, with r the block's half-diagonal, no
point of the block and no neighbour a lattice edge reaches from it is
within a cell of the surface, so all of them have the centre's sign and
the block takes the centre's value unevaluated. Otherwise the block is
halved, down to two points a side, which are sampled. Both ends of every
lattice edge that crosses the surface are therefore sampled exactly, so the
mesh is the dense lattice's to the byte, and every committed render stays
what it was (a test meshes each kind of field both ways and compares).

L and slack are the field's bound (`fieldBound` in ops.ts): how much more
than the distance the field can read. A distance, or a bound on one,
gives L = 1, and booleans, blends, moves, turns and scales keep it. A step
whose field stretches its child's says so with `lipschitz`: a twist by the
largest stretch of the shear it applies to a surface point at its
radius, (m + sqrt(m^2 + 4)) / 2 with m = k r; a twisted or tapered sweep
the same with its rates; an import sqrt(3), from its trilinear samples.
`displace` drops its noise past three amplitudes, a jump, so it carries a
slack of twice its amplitude instead, scaled by any scale above it. The
band multiplies L by 1.5 more, for the primitives whose fields are
approximations not proven to bound the distance (an ellipsoid, a loft's
blend, an outline's scan): without the named factors a twisted rope left
one skipped point within a cell of the surface and a displaced tree 26, and
at 1.5 none did on any program. `bend` and `wrap` have no bound worked
out (near the circle's centre their unbending stretches without limit, and
across the angle's cut it jumps), so a model with either is sampled
everywhere, as before. A guard catches a field that reads more than its
bound says: a skipped block that a sampled neighbour across its faces
disagrees with in sign is sampled after all, until none does, which
follows a surface into every block it crosses from anywhere sampled; on the
repo's programs it never fires.

Measured on the main extraction of all 72 programs in examples, dogfood
and std at each one's own grid: the same mesh to the byte for every one,
no block sampled after all, and 235 s of extraction down to 115 s. The
band sampled 11 to 66% of the lattice on most (87 to 90% on a multitool
and a sign whose parts fill their box, and all of it on the five that
bend or wrap), and took the mixer from 20 s to 9 s, the terrace from 19 s
to 6 s, the rope from 11 s to 5 s and the stairs from 3.5 s to 1 s. A
cheap field gains little (the mug's lattice costs under half a
microsecond a point either way). Every caller of the mesher gets it: the main mesh, the
step thumbnails, the export, the poses, `pieces()`, `wall()`, `overhang()`
and `support()`.

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
keeps a 384-pixel thumbnail readable. The lights are a loop over the
one the render always had: each adds its diffuse and its highlight in
its own colour, shadowed towards itself, and the floor takes each
light's share by power, so a program with no `light()` renders byte for
byte as before. An environment is a palette (sky, an optional horizon
band, ground, floor, an ambient scale) that the backdrop, the floor and
the metals' reflections all read, so a sunset tints a chrome ball's
rim the way the sky does. A camera is a set of framing choices the
render already took; its `focus=` reuses the close-up's frame and fits
the camera to the mesh's points inside it.

`callouts.png` maps the picture back to the program. Each mesh vertex
is attributed to the smallest named step whose field is within a cell
of it and whose inside is the model's inside just behind the surface:
the second test is what keeps a cutter from claiming the face it cut (a
cavity's field is zero on the cup's inner wall too, but the cup's solid
is outside the cavity), and it uses the model's own field to step back
less at an edge cell rather than hand a rim to the cavity below it. A
third test asks that the step's field rise along the vertex's normal,
as a step's own surface does, at least 0.3 per unit (an exact distance
rises at 1, a blend a little less): a thin operand of an `&` that runs
down through a larger part inside its own box is within a cell of its
side faces all along that part's top, with its inside under it too, so
the first two tests credited the mixer's 0.06 slab with a strip of the
base beside the clamp plate (round 11), where its field does not change
going up. A
step is visible where the depth buffer shows its vertices, its label
sits out from the picture's centre past the visible vertex nearest its
visible centroid (so a ring's label points at the ring, not its hole),
and overlapping labels are pushed apart. The largest twenty are
labelled; the report names the rest.

A picture is a material whose `albedo()` samples pixels instead of a
pattern, so nothing downstream changes: the atlas baker, the Bedrock
texture and the beauty render all ask `albedo()` at a local point and
get the picture. The mapping from point to pixel is the material's
projection, evaluated in the frame the part was painted in like a
pattern's axis; a decal's picture is fitted to its region's box, and
its alpha is what the decal falls through to the base material. The
cylindrical wrap goes by arc length rather than angle so the picture
keeps its shape and repeats round a lid; one copy stretched round it
smeared its lettering five to one.

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
inside the posed shape, for both orientations. The face windows' u and
v directions come from the game's own corner table, as the Minecraft
repo's viewer draws every face (north's u runs from +x to -x in geometry
space, south's the other way, east's from +z to -z, west's the other
way, up's and down's along x), mapped through the mirror for a block and
the half turn for an entity; a test reads every window of a six-dot
probe cube the way that table does and checks each texel is the model's
colour there, and the Aixle export was screenshotted in that viewer
beside Aixle's own sheet (round 7: the first rule had a block's front and
top and an entity's front mirrored). What remains unseen in the game
itself is only what that viewer has not itself been checked against.

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

## A budget for the web

A mesh at a fine grid is what the sheet needs and what a web page does
not: the GLB is about 30 bytes a triangle, so the chest example at its
grid of 160 shipped 459 thousand triangles as a 13.7 MB file and an
18.3 MB viewer page, most of the triangles on flat boards where four
would do. The GLB, the OBJ and the viewer therefore have a budget like
a Roblox accessory's, 200 thousand triangles unless the program says
otherwise, met by the same decimation before the atlas is baked. It is
set where a model at the default grid is rarely touched (four of the
twenty-three examples: three at finer grids of their own, and the rope,
whose twisted strands make 205 thousand at the default 128, by 2%) and a scene at
grid 300 still makes a file a browser opens. The sheet and the STL are
never decimated: the sheet is how the model is checked, and the STL is
for a printer, which wants every cell.

The budget is the export's, not each mesh's, and it is spent by error:
the meshes of a scene go into one queue and the cheapest collapse goes
first wherever it is. Round 11 shipped a dungeon door at a cap of 55
thousand when every mesh gave up the same share of its own count: the
flat stone wall kept 35196 triangles and the whole torch 1226, with the
studs and the ring faceted. With one queue the wall's flat faces go
first; at the same cap the ring and the torch keep their full meshes and
the largest deviation is the full mesh's own; at 15 thousand the wall is
down to 3570 and the ring still whole, and at 8 thousand the largest
deviation has grown by 1%. The queue also
counts how far merging only flat faces would go (a collapse that moves a
vertex less than a ten-thousandth of an edge off its planes), without
keeping those collapses, so the report can name the cap below which the
export starts to cost detail. A per-object cap was considered and not
built: what it would buy, triangles where a part needs them, is what the
shared queue does without being asked; an object that must look better
than its error says (a hero prop beside the camera) is the case it
would serve, and none has come up.

How far a decimated export strays is measured where it strays most:
the vertices are the mesher's own and lie on the surface, so the
error is in the middle of the widest faces, and the report gives the
largest |field| at a face centre, each mesh read in its own frame with
its joints hidden as it was extracted, beside the same number for the
full mesh. On the examples the two are equal: the worst face is the
mesher's, at a crease, not the decimation's. What that number cannot
see is shading. A collapse costs nothing when its faces stay in their
planes, so a band between two soft corners (a lathe profile's bends,
under the crease angle) becomes slivers from one corner to the next,
whose normals are both blends of the two bands, and the band shades in
streaks: measured on a vase at 12 thousand of 188 thousand triangles
and a teapot at 11 of 108, both fine at a quarter. So once the queue has
gone past the flat faces, the normal map is baked for every material,
each texel carrying the field's normal under it in the merged face's
tangent frame (the bake inverts the frame the shader builds), and the
vase at 12 thousand shades as the full mesh does in the viewer; its
GLB grows from 0.84 MB to 1.28 and the bake by 4.8 s. A whole model
with no bump and no relief still gets no map: on the full vase it would
add a third to the file (5.9 MB to 7.8) for the mesher's own error at
creases. A bumped or displaced material always carried the field's
normal, not the bump alone: on a stud three cells across, the mesh's
normals lean 8.6 degrees from the field's on average and 29 at most, the
map's 1.2 and 3. What a normal map cannot change is a silhouette, which
is why a door's studs looked faceted in round 11's viewer and round in
its beauty render.

A face whose corners are of two materials straddles a seam. The baker
took a texel's material and paint point from the triangle's nearest
corner, which on the mesher's own band, a cell wide, misplaces the seam
by under half a cell; once decimation stretched those triangles along
the seam, an iron corner claimed a stud's width of oak (round 11: dark
blocks beside a door's clavos, iron texels in the metallic-roughness map
round each stud's foot, absent from the full export). On such a face each
texel now slides to the surface along the interpolated normal and takes
the material and paint point the field has there; the rest keep the
corner rule, which is exact inside one material and costs no `hit()`.
Measured on the door's capped mesh baked both ways: texels that the
metallic-roughness map makes metal where the surface is oak went from
385 to 105, all of those within a quarter of a cell of the iron, and
about 4300 texels of oak on the studs' iron domes, the light blocks a
viewer close-up showed, went with them.
Keeping the band a cell wide in the decimator, by letting a seam vertex
move only along the seam, was tried and measured: the band's triangles
stretched along the seam all the same and the misplaced area did not
shrink (873 cells² against 858), so it was not kept. A face is still in
one material's primitive in the GLB, so a texel of the other material
there takes its primitive's factors where that material has no map.

A decimated export is also a slower import: the sampler's nearest-face
search prunes by boxes, and a sliver up a tin's wall has a box the
height of the wall, so a point inside is near every box (the tin's
capped GLB at resolution 64: 25 s, the full one 5 s).

## Lights in the export

The program's lights are part of the model as shipped: a torch is why a
scene is at night. The GLB writes each as a `KHR_lights_punctual` light
on a node of its own, a point light at its position and a directional
one turned so its -z runs from the light to the model. The beauty render
works in display values (a white face turned θ from a light of power p
reads 0.85 p cos θ, a point light's strength is range² / (range² + d²) of
that) and an engine in linear light with the inverse square, so the two
cannot agree everywhere. They are made to agree on a face turned 60
degrees from the light, at `range` from a point light: 2π (0.425 p)^2.2
lux for a directional light and 2π (0.2125 p)^2.2 range² candela for a
point light. Over a wall beside a point light at 0.3 to 1 range from it
that is within 0.04 to 0.10 of the beauty render's display value (rms),
where agreeing on a face turned to the light was 0.07 to 0.23 off,
brighter. An engine takes the cosine in linear light, so its light is
flatter across angles than the beauty render's: on a face turned square
to the light it is about two thirds as bright as `beauty.png`, at 60
degrees the same, and at a slant brighter (grey plates under a
directional light, read in the viewer's scene and in `beauty.png`: 97
against 159 square on, 70 against 73 at 60 degrees, 42 against 32 at
80); nearer a point light than its range it is brighter. glTF's range is a cutoff, not a
half-strength distance, so it is written as three times the program's,
where the beauty render's strength is a tenth. The apparent size has no
glTF counterpart. The cameras stay out of the GLB, since an engine
imports them as objects in the level; the viewer page has them.

The viewer page has two lightings. Its studio (a grey backdrop, a room
environment for the metals, a white key) is for judging the maps; its
scene is the program's: the GLB's own lights, or the beauty render's
one key when the program declares none (where `set light_azimuth` and
`set light_elevation` put it), the program's sky drawn
behind as the beauty render's backdrop and, scaled by the ambient as the
beauty render scales it, standing in for the light from all round, a
floor of the sky's floor colour, and each named camera as a button that
puts the view where the beauty shot's eye is. It opens in the scene when
the program declares lights or a sky, and from `set camera`'s shot.

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

Sampling is the cost of an import, and on a large mesh it was the sign
pass more than the distances: every grid line tested every triangle, so
the tool's own GLB of the chest (459 thousand triangles) spent 31 of its
34 s there. Each triangle is now binned into the grid lines its box
covers, a line wider each way than rounding could need, and a line runs
the same exact tests over its own bin in triangle order, so it finds the
same crossings in the same order and the field is the same to the bit:
a faster pass that changes no render. The distance search, a BVH query
per sample, remains, and it grows with the cube of the resolution (the
rock at resolution 200: 15 s).

`check` and `render` are two processes, and an agent runs both (and
`--watch` renders on every save, and a pose check evaluates the program
again), so the samples are cached on disk, keyed by a hash of the file's
bytes, how it is read, the resolution and the sampler's version:
everything that decides them and nothing that does not, so an edited
file misses and a renamed or copied one hits. The entry is the grid as
the sampler made it, float32 samples with the origin and cell as
doubles, so the field read back is the same field and every render from
it is the same file. It lives in the user's cache folder rather than
beside the program or in `out/`: keyed by content, one entry serves
every project, it is never in a diff, and an agent clearing `out/` or
rendering elsewhere with `--out` keeps it. It is kept under 512 MB, the
least recently read entries going first, and written beside its place
and renamed in, so a run killed mid-write never leaves half an entry for
the next to read. The sampler stays pure; the cache is the file-system
side, handed to the resolver by the command line, so the library calls
and the tests sample afresh unless they pass one.

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

A pose sheet and the strips share one cache of meshes keyed by the
pose's values, so the rest pose, a pose equal to it and a held key are
meshed once (round 7: a toy's three strips and sheet were 60 of its 82
seconds, most of it the shut box again and again); a quick pass draws
the sheet and leaves the strips to the full render. A focus applies to
them too: the model clipped to the focused step's frame where each pose
puts it, at the frame's cell. Asserts are judged at rest, because they
are promises about the model as built and a pose is a view of it,
unless one names its pose (`pose=reach`), which is judged in that pose's
own evaluation, the same one the pose sheet draws from, and inside such
an assert a query on a step under other joints reads the step placed
through every joint above it (the same placement chain `check --pose`
prints), while geometry built from a query keeps the step's own frame,
since it is built inside that frame (round 8: a tucked wrist's
clearance measured the rest position); a posed report says on its Stands, footprint and watertight rows which
pose it measured, does not judge standing when the pose lifts the model
off the floor, and takes the footprint at y = 0 when a corner dips a
little below it (a sitting fox's tail tip), since a model built on the
floor stands on the floor.

An animation's keys are evenly spaced unless it gives times, and blend
linearly unless it gives an ease, a cosine blend that slows to a stop
at each key; `ease_ends` is the ease at the first and last key alone, so
a loop can run through its seam or a one-shot launch at once, and a
segment eased at one end only is a quarter sine. glTF samplers are
linear (its cubic spline needs tangents a pose does not have), so an
eased segment is written as eight linear keys, a linear one as its two:
the file grows a little and every viewer plays the same curve the strip
shows.

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
from a lattice over its box and over the box where the two meet,
projects the samples onto each surface, reads them in the other field,
and walks the best point on each surface downhill: first by alternating
projections, which close the gap between two faces that face each other
in a step, then along the surface against the other field's gradient,
which alternating projections only creep along when the surfaces are
nearly tangent (a rounded edge resting on a plane read 0.0007 for 0).
Two parts that face each other get their exact gap, and an overlap comes
back negative by the deepest point either surface reaches inside the
other, the distance to move them apart for a face sunk into a face. That
quantity is chosen over the field reading at one surface alone because
it is the same from both sides: a book's top 0.15 into a 0.2 board is
only 0.05 from the board's top, and a promise on the depth should not
depend on which part is named first or where the lattice fell.

The queries that mesh take their default cell from the model, not from
the part: the program's grid laid across a part's own longest side
meshes a small part finer than the model is ever meshed, at a cost that
grows with the cube of the ratio, and counts its pieces at a cell the
report never sees (round 11: a bowl at a 0.012 cell where the mixer
meshes at 0.019, 5.3 s of a 6.2 s check). The model's cell keeps a part
at the report's resolution; the floor of 64 cells across the part keeps
a small part measurable. Every refining query is bounded whatever the
geometry: the overlap lattice keeps to a sample budget by bisection
rather than by assuming each side's count scales with the cell (round
11: a box 1e-16 tall asked for seven billion samples), and each descent
runs a fixed number of steps.

A failed promise is only useful if it says where, so each query carries
a witness: a void the point and the step of the measured shape holding
solid there (and, for a region made of copies, which copy), an overlap
the point the two share or, when they share nothing, whether they touch,
stand apart or overlap more thinly than the lattice resolves, which is
the clearance between them read at its closest pair. The meshing
queries share their work: one evaluation keeps a mesh and its analysis
per shape and grid, so `pieces(hub)`, `overhang(hub)` and `wall(hub)`
mesh the hub once, and a failing `pieces()` names its loose piece from that same
mesh (round 10's hub: `check` from 3.9 s to 2.5 s). The cache is keyed
by the shape object, which never changes once built, so it needs no
invalidation, and an evaluation in another pose has shapes of its own.

A promise at rest is judged once, in the rest evaluation; an evaluation
in a pose (a pose sheet, a strip's frame, a pose's own promises) judges
only the promises that name that pose, and reads the others' probes as
regions from their text. Round 11's mixer judged a five-second `wall()`
at rest again for its tilted pose and its rest thumbnail, three times a
quick pass. Timing is the CLI's, not the language's: `src/lang` stays
free of clocks so an evaluation is the same every time, and tells a
caller as each assert starts and ends. The CLI names a slow one on the
error stream, and a hung one from a worker thread, since the evaluation
holds the main thread for as long as a query runs: the worker reads the
assert being judged from a shared buffer and writes straight to the
error stream after two seconds (round 11's shelf sat silent for twelve
minutes on an `overlap()` and took forty checks to bisect).

A loop's promises are printed as one line per source line, the
judgement nearest to failing standing for the rest, and the failures
after them all: two hundred lines of passes with four failures among
them in line order were read through grep. The margin is a difference,
not a ratio, because the thresholds are distances in the model's unit
and a ratio is meaningless at a threshold of zero.

### Printing

A model is judged as a print only when the program says it is one, with
`set units` or `set bed`, or the run asks for a print's file with
`--3mf`. The Print section used to be written for every model, a unit
taken as a millimetre, and in round 11 a door for a game engine, a
kitchen mixer and a bookcase each got the report's longest section
telling them they printed 2.6 mm tall in 0.00141 g of PLA, with a
summary that opened on a 0.0144 mm wall: three agents read past it every
time, and one drew its model in decimetres to dodge it. Nothing in that
section applies to a model nobody will print, and the program is the
only place that knows. The STL is still written for every model, so it
cannot be what makes one a print.

A slicer reads an STL in millimetres with z up, and Aixle's units are
whatever the program says they are, with y up. So `set units` names the
unit (mm, cm, dm, m, in or ft; with `--3mf` and no unit a millimetre is
assumed, which is what a slicer would assume too, and the report says how
tall that prints), the STL is
scaled to millimetres and turned a quarter turn about x on the way out
(a rotation, so the winding holds and the front faces the front of the
plate), and the 3MF keeps the program's unit in its `unit` attribute
where 3MF can say it. 3MF has micron, millimeter, centimeter, inch, foot
and meter, and no decimetre, so a decimetre model's 3MF is in
millimetres with its coordinates multiplied by 100: the size a slicer
sees is the same, and nothing else in the file depends on the unit. The 3MF's mesh is welded (the crease copies
share a position, and a slicer sees unwelded copies as open edges) and
each triangle names its material, the majority of its corners', from a
`basematerials` group with each material's display colour. Both are the
shown mesh, so what the sheet shows is what is sliced.

The thinnest wall is the measure the feature size cannot give: a cut
makes walls (a flute through a vase's side, an engraving's floor, a
tube's bore), and no step knows how thick the cut left them. It is a
ray from each vertex inward to the far side, marched in the field
rather than intersected with the mesh: each step is the distance to the
nearest surface, so the far wall cannot be stepped over, and a wall
thinner than a cell is read at its own thickness wherever a vertex sits
on it (measured: the teapot's 0.08 spout reads 0.08 at a 0.13 cell). The
direction is the field's gradient at the vertex, not the vertex normal,
because a crease copy's normal is its face's, and from a vertex on an
edge that runs along the other face and reads nothing; the gradient
points between the faces and reads long, which a minimum ignores. A
vertex in the crease where two parts meet sits in a sliver of air, so
the ray is marched in until it is inside rather than assumed to start
there (measured: without it the mug's thinnest wall was 0.0015, where
the handle meets the cup). A reading counts only where the far side
faces back along the ray within 30 degrees: near a corner sharper than
a right angle the ray leaves through the side face at a slant, and that
is the corner, not a wall. A blade or a spike, whose faces meet at
under 30 degrees, still counts, and a sliver left between two cuts
counts at any size.

Support is estimated the way a slicer would place it, under every face
the Overhangs row counts: a ray straight down from the face's centre,
in the field, to the plate or the first surface below, its height times
the face's area on the plate. It is an upper estimate, because a slicer
bridges short spans and fills support sparsely, and it is split into the
part standing on the plate and the part standing on the model, which is
the part that scars a surface. A face counts only where the field at its
centre faces down past 45 degrees too: dual contouring bends the faces
beside a sharp edge a few degrees, most where a cutter's corner lies on
the part's own corner, and a mesh-only test read a slot's 40-degree
ceiling as a 33 mm column (round 11). The overhang share stays a
reading of the mesh, as the Overhangs row always was; the support, being
a volume a promise is made on, is held to the shape. Whether the model fits the bed is judged
from the hull of its vertices on the plate, turned a degree at a time,
so a long model that fits across the diagonal is told so; a slicer turns
a model freely, so only a model that fits no way standing is warned
about.

## Feature sizes

A bounding box sees a thin plate but not a thin wall: a shelled cup is as
big as the cup. So a shape carries `feature`, the thinnest thing it knows
it contains: a shell sets its wall, a tube twice its radius, text its
stroke weight, a smooth outline its thinnest wall (see Smooth profiles),
and every transform, boolean and union passes the smallest
one along (a scale multiplies it by its smallest factor). The thin-part
warning reads it next to the cell size and names the step that introduced
it, which is the line to edit.

A feature is known by where it came from, not by its size: the warning
walks down from a step through every child that carries the same size
(a union's thinnest part, a move or a paint of it, a joint's child) to
the node that introduced it, and two steps that reach the same node, or
nodes the same builtin call made at the same size, are one thin part (a
loop's slats are a new box each time round, and were each a part of
their own, so the first was named again under the output). It used to
report a size once, so a bowl's 0.05 band went unnamed beside a 0.05
hook named first (round 11). The interpreter
remembers which builtin call made each shape, and in which def and
library file, so the warning can name a member a step called inline (a
0.1 back panel built by `box()` in a library's `back_panel()`, which was
'plate' alone), and the node's box, carried through the transforms above
it, says where it is. A `curve2` outline knows the point of its thinnest
wall, and an extrude or a revolve lays that point into its own frame, so
a sliver on a 46-point outline is placed in the profile and in the model.

## The model's size

Nothing in the pipeline should care how big the model is in its own
units, since the unit is the program's choice: the grid is cells along
the longest side, every tolerance in the mesher, the checks and the
beauty render's march follows the cell, and the cameras fit the model.
The skill once told agents to keep a model within 1 to 20 units, which
sent two of round 11's agents to decimetres and left a third unsure
whether a 117 mm print could be 117 units. Measured on a mug with a
lettered label, a worn rusty handle and a wooden saucer, built at 1, 100,
0.01 and 0.001 times: the same 119068 triangles and the same sheet and
beauty render, once four constants were taken out. The beauty render's
steps had a floor of 1e-4 units, three times the cell of the 4 mm mug,
whose contact shadows went; a point light without a range reached 2
units, which lights a model in millimetres to nothing; the sheet's grid
steps stopped at 0.01 and 1000; and sizes under 0.005 printed as 0 in
the titles and spans. The point light now reaches half the model's
longest side, the others follow the model, and none of them moved an
existing render. What stays in units on purpose is what the program
says in units: a preset's pattern size, `text`'s size, a bump's height.
What stays in units not on purpose is the report's and the warnings'
number format, three decimals and anything under 0.0005 as 0: the 4.6
cm mug in metres reads "cell 0 units", "Volume 0" and a gap "0 wide, of
the 0 cell". Printing tiny numbers in full is not the cure, since the
same format hides float noise in a centre of mass (0 for -0.0000274 on
the mug at 1 times); it wants the model's size passed to the format,
and until then the guide says to draw a part that small in centimetres
or millimetres.

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
`surface()` from its interpolated local point, chart borders are dilated so
filtering never bleeds background into a seam, and vertices are split per
chart so each has one UV. The GLB embeds the PNG and samples it; the OBJ
gets `vt` and `map_Kd`. Vertex colours are left out of a textured GLB,
because a viewer multiplies the two and would show the pattern squared.
The known limit is a patch that folds back on itself along its own axis
within one chart: those texels are written twice and the later triangle
wins.

Where two materials meet, a triangle takes the material of its nearest
vertex per pixel, which makes a clean edge at grid resolution.

## The finish, and the maps that carry it

A displaced trunk, a worn edge and a flame live in the field, and an
engine sees only the mesh and its textures, so the GLB carried flat
plastic where the beauty render showed a used object. The finish is one
function, `surface()`: colour, roughness, metalness, glow and a bump
height at a local point, given the curvature there. The beauty render
calls it per pixel and the atlas baker per texel, so the maps are the
picture's surface, not a second description of it. A material with no
wear, no bump and no rust takes the old path in both, which is why no
existing render changed, and a GLB changed only where a `displace` gave
it a normal map or a glow an emissive factor (the tree, the workshop,
the Roblox plant and the two lamps).

Wear reads curvature from second differences of `dist`, which is cheap
(nine calls, paid only by a material that wears) and exact for the
level set of any field whose sign is right: the Laplacian less the
second derivative along the normal, over the gradient's length. The
Laplacian alone is what the roadmap proposed, and it is right only for
a true distance: a smooth union, a loft, a twist or a non-uniform scale
bends the field off the surface, and that bending read as curvature (12
to 24% of the value in a fillet). The probe is 1.2% of the model's
longest side, about one and a half cells at the default grid, so the
worn band is a look rather than a resolution and a quick pass shows the
band the full render will. It is +1 on a sharp convex edge, -1 in a
crease and h/R on a sphere; wear's threshold falls as the wear rises,
so more of the surface counts as an edge. A part thinner than about two
probes is all edge: the lantern's bars are rubbed bright along their
length, which is what a handled bar is.

A bump is a height, not geometry: fractal noise in the paint frame,
shaded by tilting the normal by its slope. The slope is measured along
two directions on the surface, from how far the paint frame's point
moves along each: the beauty render finds that from two nearby hits,
the baker from a triangle's corners, and both call the same
`bumpSlope()`, so they agree. Height and size are both the paint
frame's, so the slope is taken in the frame's units and a part scaled
after painting keeps its finish; taken per world unit, one ball built at
size, built ten times big and scaled down, and built ten times small and
scaled up read as three different finishes. The edge test that decides which
beauty pixels get four samples reads the field's normal, not the bumped
one, or every pixel of a bumped part would be supersampled.

The normal map is tangent space, in glTF's convention (+x toward
increasing u, +y toward decreasing v, since v runs down the image), and
is baked against exactly the frame an engine builds: each vertex's
tangent, its bitangent `cross(N, T) * w`, both interpolated and
normalised, the target normal solved through that matrix rather than
projected on it. The tangents come from the charts, which is what makes
them easy: a chart's two projection axes, laid onto the vertex's tangent
plane along the chart's axis, are the directions the UVs grow in there,
and a vertex belongs to one chart, so there is no averaging across
seams. The ±y projections are mirrored and get w = -1. The field's
normal under a texel is found by sliding from the mesh point along the
mesh normal to the surface, and taken one-sided per axis on whichever
side agrees with the mesh: a central difference at a box's edge mixes in
the next face, and leaned a plain box's texels 45 degrees in a band
along every edge. Past 50 degrees the field's normal is the other face
of an edge the mesh rounds, not detail, and the mesh's normal stands.

A map is written only where it carries something, because most models
are plain and their GLBs should not grow. The metallic-roughness map is
written when some material's texels vary in either (wear, rust); a
material whose texels all took one value other than its own (a bolt
smaller than a rust patch and wholly inside one) gets that value as its
factor, or an engine would shade the atlas's oxide as polished iron. The
emissive map is written when a glowing material's colour varies (a constant one is
a factor, which needs no texture), and the normal map only for relief
the program asked for: a `bump`, or the materials that end up on a
`displace`. The mesh's own error was the reason for that last rule: on
every plain example the dual-contoured mesh leans 3 degrees or more off
the field in a band at creases and junctions (1 to 23% of the texels),
and a normal map would correct it, but baking it would add a map and
sixteen bytes a vertex of tangents to every GLB. Which material a
displace ends up wearing is read from the tree: the material at a point
is the outermost paint above it, so a displace under a paint gives that
paint, and one with no paint above gives the paints and decals inside it.

`viewer.html` gives three.js a room environment, because a metal is
mostly what it reflects: without one the lantern's bare iron rendered
near black in headless Chromium, and a metallic-roughness map had
nothing to vary.

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

A def's body was one expression until round 11, whose bookcase library
needed a book's width, height and depth a dozen times with no name for
an intermediate and a case's shelves as a loop, and split itself into a
helper def per sub-part. A block body (`def book(b) { cover = ...
return cover + bands }`) is the same straight-line construction one
level down: assignments, loops and promises in order, then one
`return`, which must be last, so a def still makes one value from its
arguments with no early exit and no branch. Its names are the call's
own, like its parameters, so they never become steps: a library's part
called thirty times would otherwise fill the steps sheet with its
cover thirty times, and a caller's step that happened to share a name
would read as a part of every book. (The same rule fixed an older leak:
a def's parameter, or a library's constant, read in a call used to be
recorded as a read of the caller's step of that name.) An `assert` in a
block is judged per call, as one in a loop is per iteration, and names
the call's line, since the def's line is the same for every verdict.

A step is a name and the value it ends with, which suits a line run
once. A loop's working names (the shelf's `bk`, `prev`, `board`) ran
thirty-three times and ended holding the last book, so `steps.png`
showed "8. BK", the callouts labelled one flat book `BK` as if it were
a part, and a stand used as a library exported its loop counter. A name
first assigned inside a loop's body is therefore the loop's own: the
interpreter keeps a record of what it read, so a part placed only
through it is still a part, and nothing else. A name assigned before
the loop and grown in it is still a step, since its last value is the
whole of what the loop built. What the shelf wanted instead, a name per
book, is `named("book_" + n, bk)`: a builtin that registers a step of
that name holding that iteration's value and returns the value. It fits
the step model as it is, one name and one value from one line, with the
reads of its argument as the step's reads and the statement around it
reading the step, so the sheets, the slices, `--focus` and the
warnings find book 9 by name with no change of their own.

## Records

A part with five numbers was a call with five positions, and the next
reader counted commas to find the seat height. A record names them:
`{w: 0.9, h: 0.45}` and `seat.h`. It is a value like a list, never
changed in place (`{...seat, h: 0.6}` is the changed copy, and
`seat.h = 0.6` is a syntax error that says so), so a step is still one
value from one line and the program stays a straight-line construction.
The dot was already a library's (`hw.bolt`), and only the interpreter
knows which a name is, so the parser keeps a dotted name whole and the
interpreter tries a used library first, as `use` already warns, then a
record. The fields live in a map of their own rather than as properties
of the value, so no field name (`kind`, `pattern`) can make a record
pass for a shape or a material; a record of shapes is not a shape, and
`show parts.lid` reads the step the field holds, so a record's other
parts are still reported unused.

## One layout

`aixle fmt` re-lays the space between tokens and nothing else. The lexer
keeps each token's offsets and the parser marks the tokens whose role
the spelling does not give (a unary minus, a named argument's `=`, an
index, a record's braces), so the layout is decided from the parse and
printed from the source: tokens are never respelled, lines never joined
or split, which is what makes it safe (a blank line ends a statement and
a leading `|` continues one, so a formatter that re-wrapped could change
a program). It is deliberately lenient where the agents' programs carry
meaning in their spacing, and keeps it: of the 109 programs in the repo,
21 write tight commas to group numbers (`polygon(0,0, 1.5,0)`, the
reference's own `[x,y,z, x,y,z]`), 8 in four dogfood rounds pad a run of
`=` into a column, 15 in seven rounds line up trailing comments, and a
long `pose()` or `union()` is broken under its first argument. Measured
over those programs: the formatter is idempotent on every one, the
formatted program parses to the same tree with every token and comment
in order, it changes 20 of 6071 lines in 11 files (a named argument
written `x = 1`, an `=` padded out of line with its neighbours, one
comment a space from its code), and it takes about 60 ms for all of them.
Round 11 made a column of trailing comments move as one, at least two
spaces after the longest line's code, where fmt had moved only the
comment whose code reached into the two spaces and broken the column;
over the 135 programs of that round, fmt changes 31 of 7730 lines in 12
files rather than 21, the ten more being two such columns (round 4's
market, a copy of round 11's bookcase) moved out by one space whole.

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

## Smooth profiles

`polygon` was the only way to draw an outline, so every lathe profile was a
list of corners and a revolved vase showed them as bands. `curve2` and
`bezier2` are the 2D counterpart of the exact curves: a chain of cubic
pieces, through the points with Catmull-Rom handles (closed, so the
tangent at every point looks at both neighbours) or from anchors and
handles. The handles are centripetal: the knots are spaced by the square
root of each chord, the tangent is the derivative in that parameter, and
each side's handle is the tangent times its own span, so the tangent's
direction halves the angle between the chords and a short piece beside
a long one gets a short handle. The uniform handles `curve()` uses (half
the chord between the neighbours, on both sides) gave a 2 mm piece beside
an 85 mm one a 14 mm handle, and round 11's stand outline looped into a
0.019 mm sliver there; centripetal Catmull-Rom has no cusp or
self-intersection within a piece, and on evenly spaced points it is the
uniform spline exactly, so outlines drawn that way did not move. It
moved what spacing shapes: the vase example's inner floor, a long run
after a short piece, now dips 0.024 below its line where it dipped
0.012. The 3D `curve()` keeps the uniform handles: on the nine dogfood
programs that use it the centripetal ones move no curve by more than
1.6% of its length and loop none. The distance is the nearest point on each piece,
the scan and Newton of the 3D curves in the plane, with Newton kept inside
the scan's bracket, except that Newton searches every basin the scan shows
(round each sample lower than both its neighbours, and in each step over
which the slope turns from falling to rising), not only the one round the
nearest sample: a teardrop drawn as one piece from its point and back
passes a point beside its tip twice, and searching only round the nearest
sample read 0.28 there against a true 0.015. Before any search the distance to a few points on the
curve (each piece's start and middle) gives an upper bound, and a piece
whose exact box (from its turning points, not its handles) is farther is
skipped, so a sample searches about two pieces of twenty. The sign is the
even-odd count of crossings of a ray towards +x, which `polygon` already
uses: each piece is split at build time where its height turns, and on a
part that only rises or only falls the crossing is one root, found by
Newton within the part, and only when the point is inside the part's box.
Because the count changes exactly where the ray crosses the curve, the
sign flips on the curve and nowhere else, and an outline that crosses
itself still gives a field whose zero is the curve.

Prototyped and measured: against a polygon of 4000 points per piece, the
distance agreed to 6e-9 over 4000 random points round a vase outline,
with the sign the same everywhere and the gradient's length 1.00000
within 0.05 of the curve. A circle from four Bezier quarters with handles
0.5523 r is within 2.8e-4 r of the true circle; a `curve2` through 8
points of a circle is within 8.5e-3 r and through 16 within 5.5e-4 r,
where the polygons through the same points are off by their sagitta,
7.6e-2 and 1.9e-2. The cost is a distance call of about 500 ns for a
16-piece outline (400 ns before every basin was searched) against 120 ns
for an 18-point polygon and 720 ns for the 128-point polygon it would take
to hide the facets; the vase's body meshes at grid 128 in 1.5 s against
0.65 s for the polygon it replaced.
Past two dozen pieces the pieces go into the grid the sweeps use (see A
grid over the pieces), laid flat, and the crossing count reads only the
parts listed in the query's band of height, so a long outline costs about
what a polygon through the same points does: extruded and meshed at grid
128, 0.69 s against 0.44 s at 24 points, 1.0 s against 0.81 s at 120 and
2.4 s against 2.0 s at 360 (measured before every basin was searched,
which adds 10 to 25%).

Corners are a point given twice, because a spline through a sharp turn
overshoots (a foot's edge bows the underside down, the axis run bulges
past x = 0) and a model reaches for a sharp foot and a straight axis in
every lathe profile: at a doubled point the curve leaves and arrives with
one-sided tangents, as an open curve does at its ends, so the run between
two corners is straight. `bezier2` closes with a straight edge when its
last anchor is not its first, which is the other common lathe outline,
drawn from the axis round to the axis. `wall=` takes the band along an
open curve instead (the distance to the curve less half the wall), for a
wall drawn as one line.

A lathe profile's run up the axis is an edge of the outline but not of
the solid: spun, it is inside. With the plain distance the revolved field
is zero all along the axis, which the cross-sections draw as a line and
the glass march takes for a surface (measured: a liquid revolved from a
polygon, as in the tumbler, shows its two halves through the glass), and
which `shell()` turned into a hollow rod of the wall's thickness up the
middle (measured: the teapot carried one in every slice from the first
round until this was found). So a `curve2`, a `bezier2` or a `polygon`
on x >= 0 whose outline has straight runs on x = 0 also carries the
distance without them, and a full revolve with no offset uses that one;
the sign still counts them. A transform or a boolean drops it, and a
partial revolve keeps the plain distance, since there the axis is an
edge of the wedge's flat ends.

A closed outline carries a feature size, its thinnest wall: from sixteen
points per piece (fewer past a hundred pieces: a thousand-point outline
builds in about 0.3 s, though three thousand take about 2 s, since a march
deep inside a long outline reads every piece's box) the march along the
inward normal to the far side,
counted where the two sides face each other (normals within 10 degrees of
opposite) and not within that distance of a corner, so a vase drawn as one
outline with a wall under a cell is warned like a shell is. A spike counts
only once it is sharper than about 10 degrees, and a straight run on the
axis is skipped, since a revolve doubles the solid there.

## Extents before extraction, and close-ups

The bounding box sets the cell size, and a box is loose whenever a joint
turns (the box of a turned box), a union blends, or a difference cuts;
measured on a posed excavator, the box was twice the surface and cost a
third of the resolution. So extraction runs twice: a coarse pass finds
the surface's extent, and the fine pass is laid over that box. A focused
render goes further: the model is clipped to the focused step's extent
and re-extracted at that box's own cell, so a small part is drawn with
its own detail rather than the scene's, and the slices and the beauty
render are framed on it too. Focus is a close-up, not a reframing. The
close-up is two meshes: the focused step, placed where the output puts
it, and a ghost of everything else in the frame with the step carved
out of it, meshed at twice the cell and drawn faint and see-through
over the step wherever it is in front by more than a cell (round 7: the
drone's body, clipped flat over the gimbal, was read as an unknown
plate). The pose sheet and the strips do the same per pose.

## Slices through a step

`slices.png` cuts through the model's centre, which is right for a cup
and wrong for a plant in a terrarium: its stem is off every plane, and
the cut shows the canopy as a blob floating over the soil (round 10).
`set slice name` cuts through one step instead, where the output puts
it. Where the planes go was measured rather than guessed: the step's box
centre is in the air for anything that leans or reaches (a lamp's arm,
a ring of rocks, a placed set), and on 74 parts in five programs a
vertical plane there missed the part on 4 of 148 cuts and cut under a
quarter of its widest section on 8. The step's solid centroid, sampled
on a 40-cell lattice over its own surface's box, missed none; it is
used unless a plane there cuts less than half the step's widest section
on that axis (a ring's centroid is in its hole), when the widest section
nearest the centroid is used. The frame is the step's own box with a
quarter of its size round it, enough for the soil it stands in or the
wall it is fixed to, and the cut through the rest of the model is drawn
faint, as a focus close-up draws it, so the step is the thing read and
the rest is its context. A probe or a cutter places the planes with its
own volume but is not drawn: what is read there is the model.

The centroid is still wrong for a part that leans on something: a book
leaning 18 degrees on a shelf has its centroid's vertical plane through
a slanted band in the air between two shelves (round 11), and the cut
was asked for to show that the book stands. A slice through a step is
usually there to show what the step meets, so when the step touches the
rest of the model or comes within two cells of it, the planes go
through that contact. The contact is found from the fields, not a mesh:
lattice samples near the step's surface slide onto it, and one is a
contact when, a little way out along its normal, the model is nearer
than the step itself is, which a step's own concave side never is.
Contacts are grouped by lattice neighbours and the lowest group taken,
since what a part rests on is under it (a leaning book also touches its
neighbour at the top). Of the three planes, the one most nearly parallel
to the contact (the horizontal plane under a book on a shelf) would cut
along it and show nothing of it, so it keeps the step's own level; the
other two go through the group's centroid moved two cells into the
step, so they cut the step and what it rests on together. A contact
all round (a stem in its soil) has no direction, and the horizontal
plane keeps its level. A cutter is never given a contact: it is where
the model is not. The two programs that name a slice step at this point
were the shelf, whose X plane moved from the air (x 1.17) onto the
board (x 1.51) once its hand-set `slice_x` was taken out, and the mixer,
whose beater meets the model only where its shaft enters the hub, on
the planes it already had.

## What each light adds

`lights.png` began as each light alone, then all, which shows what a
key or a rim light does but not a small point light: under one alone it
changes a few dim pixels of a whole picture, and the ambient sky, which
every frame keeps, swamps them (round 10: a ring's spark). So the strip
has a second row, each light's own contribution: the frame under that
light alone minus the frame under no light (one light of no power: the
sky's ambient, the glows and the reflections, nothing from any light),
clamped at zero and brightened
until the 99th percentile of what the light reaches is near white, the
gain printed. The lights add up in the shading (each adds its diffuse
and its highlight, shadowed towards itself), so the difference is that
light's term, and the brightening makes its reach and colour readable
whatever its power. It costs one more render than the strip did, and
the frames went from 0.4 to half the beauty size: 6.1 s to 9.6 s on the
ring's three lights. The no-light frame closes the row, since it is
what every light adds to.

The difference is taken from the finished pixels, after the shading has
clipped each channel at white, so on a glowing part it is not that
light's term: a flame near white under no light and a little whiter
under the moon differs only in green and blue, and brightened 7.9 times
it read as a green flame (round 11). The render marks the pixels whose
surface glows, and that row draws them flat grey and leaves them out of
the gain. A light that does reach a glow is still seen on everything
round it.

The strip is four or more marches beside the shot, so it is part of the
full `--beauty` render and not of `--beauty-only`, the loop for trying
a finish, unless `--lights` asks; and the shot `set camera` names is
`beauty.png` and is not marched again as `beauty_<name>.png` (round 11:
the material loop's one shot was the shot twice and the strip, 28 s
against 8).

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
builtins do. Its constants are printed with their values, since a
record of defaults is the only place that says which fields a part
reads. A name that starts with an underscore is not exported: a
library's plate needs helpers of its own, and without a way to keep
them, round 11's bookcase offered its `demo_case` and `demo_y` to every
caller. A leading underscore was chosen over a keyword because it
needs nothing new in the grammar and reads the same in the library
and in an error.

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
are in `roadmap.md`; the built ones (libraries, anchors, `assert`, the
PBR bake, the print report, smooth profiles, image textures, lights and
cameras, callouts, the import cache, the web budget) say there what was
measured and what was left.
