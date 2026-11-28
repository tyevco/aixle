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

## Fewer evaluations: the export's mesh, a cutter's box, a sweep's pieces

With the band sampling only near the surface, what was left was work done
twice and pieces evaluated for nothing. Three changes take it away, and
every field, mesh and export file is the same to the bit.

The export takes the main mesh again. buildHierarchy meshes each object
over its own bounds at the export's cell, ceil(longest / cell) cells
along its longest side, which for one object with no joints and no
placed sets, cut over its bounds, is the very call the pipeline has just
made. The pipeline hands over its mesh with what it was cut with (the
shape, the box, the resolution, the sharpness and the crease), and the
hierarchy takes it when the call it would make is that one. A box the
extent pass tightened, or a resolution the rounding makes one more
(round 8's multitool comes out at 221 cells for a grid of 220), extracts
as before, and a test holds each of these, a joint and another shape to
a miss. The mesh is only read: the decimation cap and the atlas make new
meshes from it, which a test checks byte for byte against a fresh
extraction. 21 of the 25 examples qualify, and 17 of the 47 dogfood and
std programs; none of the 72 has a tightened box.

A difference skips its cutter outside the cutter's box. Outside its box
by bd a cutter reads at least bd, so where the base reads -bd or more,
max(base, -cutter) is the base's value to the bit and the cutter is not
asked; the box distance is taken a hair low so rounding cannot skip a
cutter that decides the value. The box test costs about a primitive, so
it is made only for a cutter of two or more: over a lattice on each
base, a cutter of one primitive took a sample to 0.75 to 1.95 of its
time with the test (the mug's two cylinders 1.05 and 0.83), and one of
two or more to 0.20 to 1.11 (the sign's lettering 0.20, slower only on
a lighthouse's three primitives and a hub's 58). The floor the cull
reads is the one union()'s cull already assumes, and not every field
keeps it. Round 10's ring wraps its inscription, and a wrap shortens arc
length outside its radius, so that cutter read under its box distance
and the cull changed 6 lattice values. Nothing in a cutter may be marked
as a bound on the distance (a twist, a bend or a wrap, a non-uniform
scale, a displacement, a loft, a blend), it may hold no intersection,
whose box is the overlap of its operands' boxes while its field is only
the larger of their fields, nor a joint a pose scales unevenly. And a
leaf is trusted only when it says its field keeps the floor
(`boxFloor`): the exact primitives, a box or a cylinder while its
rounding fits, tubes along a path or a curve, and the extrusions and
revolves of profiles that keep it, lettering among them. Review found
the leaves that do not, each changing the mesh under the first version
of the gate, which trusted every leaf: Quilez's ellipsoid is an
approximation that reads 0.155 by a flat one's rim where its box is
0.224 away, so two flat dimples in a slab moved vertices; an open
imported sheet reads inside above its box, and cut from a plate it came
out at 15264 triangles where it had been 14784; a halfspace is a max of
planes, and a sweep's piece past a mitre reads the distance to a tilted
plane. The repo's programs keep the same culls, 53 of the 64
differences with a cutter of two primitives or more. The cull reads the
base's own value, never more than the difference did, so the band's
bound holds.

A sweep's pieces are visited nearest first. The rope's sweep evaluated
22 of its 120 pieces at a sample near its surface: each piece's box is
its segment's grown by one and a half reaches, and the turns stack, so
a point is inside most of the boxes round it and the box cull skips
almost none. Each piece has a lower bound now. With rho the point's
distance from the segment's line and cap the piece's own end value
(positive past a mitre plane or an end of the path), the piece reads at
least rho - reach between its planes and hypot(max(rho - reach, 0),
cap) past one. The plain distance to the segment is no bound: between
the mitre planes, past the segment's end and off the path, the piece
reads the profile alone, which is less. The bound across the path needs
the profile to read at least its box distance outside its box. A
circle, a rectangle, a polygon and lettering do, and so does what the
hard booleans and the transforms that keep it build of them, which a
profile now says (`boxFloor`). A smooth union does not: chained over
its parts it reads up to k under the least of them, past the k/2 its
box grows by, and a sweep of ten bars blended at 0.5 read differently at
thousands of points under the bound. An ellipse does not: its field reads 0.88 of its box
distance a few sizes off on a diagonal, and with the bound across the
path the teapot's handle read differently at 4307 points of a lattice at
half density. A profile without the floor is bounded by its end values
alone, which hold for any profile. The spatial index bounds the pieces listed in the point's
cell, evaluates the one with the least bound, then only those whose
bound is under the best so far, an equal value taking the best from a
piece later in the list so a tie of 0 and -0 comes out as min()'s; the
scans past the cell keep their
order and their box cull, the bound skipping only a piece that cannot
lower the best, so they give the same bits wherever the bound holds.
Near the rope's surface that is 2.1 pieces a sample against 21.7 (4.4
against 24.9 over its whole box), and a sample there takes a third of
the time. A test holds every bound under its piece at 6000 points out
to five times the sweep's size, sharp turns, a twist and a taper
included, and on a square's diagonal, where the two agree, to within
1e-9. Tubes are as
they were: a capsule is its own bound, and a round cone's capsule bound
took a sample near the surface to 0.91 to 1.10 of its time.

Measured on a machine shared with other work. A script compared the
field before and after bit for bit at every lattice sample of every
sweep, tube and difference in the 72 programs of examples, dogfood and
std (5 sweeps, 141 tubes and 177 differences): on a lattice over each
one's own box, 133 million samples; at every point of the main
extraction's lattice carried into its frame through the moves, turns,
scales and warps above it, 1.37 billion; and the whole model's field at
every point of that lattice, 223 million. Not one differs. The main
extraction of all 72 meshes to the same bytes (positions, indices,
normals, materials, NaN counts), in 152 s against 166 s: the sign's
from 0.64 s to 0.33, the rope's 5.0 s to 2.7, the windmill's and the
tower's by a third, and none slower past the machine's noise (the eight
that read 1.07 to 1.48 times as long read 0.93 to 1.09 run again, the
least of five). model.glb, model.obj, its
atlas and maps, model.stl and viewer.html came out the same to the byte
on the 21 examples the reuse applies to, rendered by `aixle render` from
the tree before and after, and the rope's and the teapot's committed
renders regenerate unchanged. Whole renders, `aixle render` the better of
two runs alternating before and after: the rope from 26.4 s to 19.5 (its
export's hierarchy from 7.2 s to 2.7), the nameplate 8.6 s to 7.9, the
teapot 7.0 s to 6.8, and std/hardware 4.5 s and 4.8, where none of the
three applies (six objects, cutters of one primitive, no sweep).

## One mesh, rendered and exported; one field, for the beauty render

The checking views draw the extracted mesh, not the field. That was a
choice between fidelity and honesty: the picture and the OBJ cannot
disagree, so the agent verifies the file it ships. The rasteriser is a
plain z-buffered triangle filler with perspective-correct attributes and
per-pixel shading; an outline pass darkens depth and normal
discontinuities, which is what keeps a 384-pixel thumbnail readable.
Fixed lights in camera space mean every view is lit the same way
whatever the model's orientation.

`beauty.png` is the other way round: the field itself, ray traced and
shaded as the viewer and the engines shade the GLB, for the picture that
shows the model as meant. Primary rays stay on the field. The mesh is
rasterised first for its depth, and each camera ray marches the field
over a window three cells either side of that depth (pbr.ts, `sample`:
at most 40 steps, a hit within a twentieth of a cell), so empty space
costs nothing; where the window misses at a pixel's centre, the mesh's
point stands in. A pixel whose neighbours differ in material, in depth
by more than four cells, or in normal by more than about 53 degrees (or,
in full quality, in brightness beside a mirror or glass) is an edge and
takes four samples, which march on past the window, so a silhouette
antialiases against the field itself. The four are averaged after the
tone curve: in linear light one very bright subsample decides the mean,
and a glow's edge came out up to 61 levels brighter (measured in
lightstudy.ts, whose frames can only average in linear light).

Secondary rays (reflections, refraction, shadows) cannot be primed by
the camera's depth, and marching the field all the way was the largest
part of a heavy render: the old renderer's shadow march was 39% of the
mixer's beauty time and 63% of the ring's, and a shadow ray cost 20.7 µs
on the mixer, whose field costs 3.3 µs a call near its surface. So every
secondary ray marches the field for its first three cells (`NEAR_CELLS`
in rays.ts), where the mesh is least trustworthy: the surface the ray
left, creases, a part's contact with the floor. Beyond that a bounding
volume hierarchy over the mesh's triangles (bvh.ts: binned surface-area
heuristic, four triangles a leaf, glass and opaque triangles flagged
apart) skips empty space. A shadow ray asks it whether any opaque
triangle lies ahead. A ray that must see something asks it for the
closest triangle and then marches the field over a window of three cells
either side of it, so every hit the kernel shades has the field's
position, normal and material; a window the field marches clear to its
end is the mesh's alone (a thin bar's mesh is fatter than its field) and
the ray goes on past it. Shading the mesh's hits directly was tried and
rejected: up to 19.6% of the medal's reflection rays landed more than
two cells from the field's surface.

The faithfulness was measured against the field alone from the same
origins, on the seven benchmark scenes at 384 pixels (the medal,
tumbler, lantern, teapot, mixer, door and ring; tools/rays-bench.ts).
Mirror rays disagree on hit or miss for 0.008 to 0.24% of rays; 99.67 to
100% of the hits lie within a twentieth of a cell of the field's, and 0
to 0.32% more than two cells off. The key's hard shadow disagrees on
0.005 to 0.76% of the lit pixels whose shadow ray reaches the model's
box, every one of them on a shadow's edge (the lantern's thin bars are
the 0.76; of all its lit pixels they are 0.22%). The price: a shadow ray
beyond the near march costs a median 0.05 to 0.43 µs, a reflection ray
0.41 to 0.95 times a 128-step march of the field (all of these rerun at
862f270), and the hierarchy is built once per mesh, in about a second
for the largest of the render sets (round 2's market, 620,704
triangles). What is lost is what the mesh does not have: a part thinner
than a cell casts no shadow further than three cells from itself and
does not appear in a reflection.

The lights are the program's `light()`s, or the one key the settings
describe (`sceneLights` in pbr.ts). Each adds Lambert and a GGX
highlight in its own colour; on a surface the camera sees, its
unshadowed light and its visibility are kept apart, so the visibility
can be filtered (see Shadows from lights with a size). A camera is a set
of framing choices the render already took; its `focus=` reuses the
close-up's frame and fits the camera to the mesh's points inside it. How
much is sampled is a choice of the run, not the program
(`--quality draft|full`): a program describes a model. Full is the
default and what the render sets commit; draft takes one reflection
bounce, one glossy ray, one glass deep and no brightness test at
mirrors, and is what `--quick --beauty`, `lights.png` and
`environments.png` draw.

The render was designed by building three prototypes, one for shading,
one a path tracer and one for speed (the worker pool, the hierarchy and
area shadows), which a panel of judges compared on the same scenes; the
build took what each did best, and what the sections below call the
shading prototype is the first. Path tracing, as the default or as a
mode, was set aside: five times the time on one thread at 384 pixels,
mottled penumbrae at four samples a pixel, and two looks to keep apart.
The sections after this one say how the light, the materials, the skies,
the reflections, the shadows, the glass, the floor and the threads are
built, and what it all cost.

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

## Light in linear units, and one curve

The old beauty render worked in display values: it multiplied a display
colour by a cosine, an occlusion and a shadow, and added a highlight on
top, so two lights did not add as light does, and a shadow or an
occlusion that halved a display value took away more than three quarters
of the light it stood for. The new one carries linear radiance
throughout (photometry.ts). Every colour a program gives, a material's,
a light's or a palette's, is sRGB and is decoded before it lights
anything; the picture is tone-mapped and encoded once, at the end.

`KEY` is 1.05: a light of power 1 brings a white face turned square to
it to radiance 1.05, so `power` keeps its meaning (1 is the default key)
and a white face under the key displays near white. Diffuse light is
weighted by the share Fresnel does not reflect, so the face measures
1.022, 2.7% under (tests/shading.test.ts). `GLOW` is 1.6: a glow of 1
gives off its colour at 1.6, brighter than a white face a power-1 light
reaches, so a flame reads as a source. A glow is added unshadowed,
lights nothing else and blooms a little; a flame that lights its lantern
is a glow with a point light just outside it.

The tone curve is Khronos PBR Neutral, the curve three.js calls
NeutralToneMapping: a small toe below 0.08, the identity from there to
`TONE_START` (0.76), so a base colour lit square on to unit light
displays as itself, and a shoulder that rolls highlights off towards 1
instead of clipping them. One change: the shoulder is taken per channel,
not on the brightest channel with Neutral's desaturation. Neutral keeps
a colour's hue as it brightens and desaturates it towards white, and
that turned the lantern's orange flame salmon pink; per channel, a flame
or a gold glint goes yellow and then white, as film does. Below the
shoulder the two curves are the same function (within 1e-7 on 1,000
colours, tests/environment.test.ts), so a model's colours are what
three.js shows.

The curve has an exact inverse, `untone` (within 1e-6 over 0 to 20), and
it is what keeps the backdrops. The palettes are the old renderer's
display colours, and each is decoded through the inverse curve, so the
sky the camera sees displays as it always did: within 2 levels
of the old backdrop at 33 elevations in all four skies. The floor's
target is decoded the same way (see The floor), and an edge pixel's mean
of four tone-mapped samples is untoned back into the linear picture
before what follows.

The finish (pbr.ts, `pbrFinish`) runs in a fixed order on the linear
picture: each light's visibility is filtered, the lights are composed,
the model blooms (a channel above 1.25 spills into its neighbours
through two Gaussians, 1% and 3.5% of the picture; only model pixels
bloom, because a sunset's bright band bloomed and washed the sky), depth
of field blurs, and the curve, the sRGB encoding and the dither come
last. Depth of field is a gather blur whose radius grows with distance
from the focus plane through the model's centre, weighted so a sharp
foreground does not smear across a blurred background.

The viewer ends on the same curve. `TONEMAP_GLSL` is the curve written
as a GLSL function body, generated from the same constants, and the page
hands it to three.js as its CustomToneMapping, in both of its modes; the
backdrop it draws in its Scene mode matches beauty.png's pixel for pixel
(219, 216, 210 in the studio).

## The BRDF is the viewer's

A surface is glTF's metallic-roughness model, as three.js's
MeshStandardMaterial shades it (pbr.ts, `shade`): a diffuse colour
base·(1 − metal), a reflectance at normal incidence F0 = mix(0.04, base,
metal), a GGX lobe of α = rough², height-correlated Smith visibility and
Schlick's Fresnel, and for the light from all round Karis's analytic fit
of the split sum and Fdez-Agüera's compensation for the light a rough
lobe loses to scattering more than once. It is the viewer's and every
engine's model because the GLB is shaded with it everywhere else: a
material chosen by reading beauty.png then means the same in the export.
The old loop, Lambert and a Blinn highlight in display values with a
tinted mirror for a metal, read gold as yellow plastic. Two tests hold
the energy: in a constant sky with no lights, a white sphere of
roughness 0.2 to 1, metal or not, returns the sky within 5% (run at an
ambient of 0.5 under a palette of 1.3, so that leaving the sky's
intensity out of the reflections fails it by 54%); a polished metal
square to the camera returns F0 times the sky within 3%. At roughness
0.5 the split sum's fit leaves a metal under F0 at normal incidence, the
more the lower the F0 (copper's red, green and blue at 0.99, 0.90 and
0.875 of theirs), the model's own loss, not a bug.

Two terms darken what a surface reflects where it is enclosed, both read
from the field's ambient occlusion (five taps along the normal, never
under 0.3, the old renderer's, each reading the field as the distance it
bounds: see below). Specular occlusion is Lagarde's, the
occlusion as the reflection sees it, tighter for a smooth surface; it
dims the prefiltered sky. The cavity term is the first three taps (6.4
cells) to the power 3 (`CAVITY_POWER`), and it multiplies everything a
reflection brings, the traced rays as well as the sky, and the lights'
highlights on a crease or an edge in a hollow. That is what makes
lettering cut into polished metal read as dark marks. From inside a
groove the traced rays meet the groove's walls, which reflect the sky as
brightly as the face round them, and with the cavity term on the sky
alone the ring's FOREVER read only at its edges at powers 1, 3 and 5; on
every reflection, at 3, it read darker, and 5 was no better.

It was not dark enough: the blind check (below) found the ring's
inscription fainter than the old renderer's. Measured on the hero shot
at 384, with the letters' pixels found by rendering the program with the
inscription painted on as a glowing green decal instead of cut (and the
decal's reflections in the band left out), the cut letters were 70
levels darker than the same pixels of the uncut band in the old
renderer, 23 when `CAVITY_POWER` was tuned (247fd67; 4 at a power of 1),
22 at the stage-2 merge (230a4d5) and 15 at 862f270. The 6 levels lost
after the merge are one commit's, db438ff (gold to its measured F0
squared, the occlusion's power): the ring's picture is the merge's byte
for byte before it and 862f270's after it. So the tuning's "as the old
renderer drew them" does not hold when measured: the letters were darker
than at a power of 1, not as dark as the old renderer's. Against the
band round them (the gold two to four pixels out) every render shows the
letters well under it, 77 levels in the old renderer and 92 at 862f270,
since the new band is brighter there; that measure misses what the
reader saw.

The lights were the rest. With them switched off the cut letters were 60
levels under the uncut band; with the reflections switched off they were
13 levels over it. The cavity term never touched a light's highlight,
and along a groove's lips and in its corners the field's normal (central
differences half a cell either side) turns through every angle between
the face and the wall, so some of it meets each light's half vector
while the light's rays find the point lit. On FOREVER, strokes 1.75
cells wide, a lip took the key's highlight at 7 to 12 times what a white
matt face square to the key returns, against 0.1 on the groove's walls
beside it, and the letters read as gold-on-gold sparkles. The lips'
cavity term is high (0.74 to 0.82, against 0.59 on a flat gold plate's:
on the band's convex inside, the face beyond the groove falls away from
the taps), so it dimmed their reflections little and would dim their
highlights only by half. Such a point is where the normal's differences
straddle the crease, and the same six samples say so: their second
differences, |d(p + e) + d(p − e) − 2 d(p)| over the three axes in units
of the step e (half a cell), are 1.2 to 1.4 e/R on a smooth surface of
radius R, and on a right-angled edge 1.4 at the line, falling to 0 half
a cell off (1.05 to 1.2 on those lips). A light's highlight takes the
cavity term in proportion to that bend, all of it at 0.5 (`CREASE_BEND`,
a radius of about a cell) or more. The cut letters are now 37 levels
under the uncut band, their mean luma 86 against 862f270's 108 and the
old renderer's 71, 114 levels under the band round them, and 94% of them
under the band's darkest tenth (862f270 76%, the old renderer 85%); the
old renderer's darkest quarter is still darker (31 levels, now 67).
Taken on every highlight (40 levels), the term also took the light off
flat floors a few cells from a wall, which the light's rays rightly find
lit: round 10's hub's blind pockets read as domes from above again, and
its counterbores' steps went black; on creases only, they read as they
did. Gated by the gradient's length instead (1 on a smooth distance,
0.80 on those lips), it also dimmed the highlight on the Roblox wings'
boss, a scaled sphere, whose field is a bound with a gradient under 1
everywhere and whose cavity term was then under 1 in the open too (no
longer: below). An open convex
edge keeps its glint, its cavity term 1. The same change takes out the
dotted line of highlights where two parts meet in a crease (the ring's
cushion on its plinth, the hub's boss on its flange). Diffuse light is
left alone: the area lights' rays shadow it into a groove. Two shading
tests hold it: four grooves under two cells wide in a gold plate, seen
low with the key's highlight on their lips, read 21 levels under the
face round them (9 over it without the change), and a pocket's flat
floor takes the key's highlight exactly as the open face does (with the
term on every highlight it lost up to 97%).

The kernel has little more to give there: the cavity term to the power 6
on those highlights reads 43 levels, and a crease in a hollow with no
highlight at all 48. The rest is the program's, and depth is not it:
cut twice as deep, the ring's letters read as before (36 levels), where
strokes 2.9 cells wide in place of 1.75 read 47 and a satin gold
(`material("gold", rough=0.5)`, the preset is 0.3) 80, on a band that
is brighter there (the letters' mean luma 80, against 86 in polished
gold), all with the letters found as above. The guide's row for a
polished engraving says so.

The occlusion is taken to the power 1.5 on the model's own surfaces, for
the sky's light and its reflection (`AO_POWER`). It was tuned by eye in
the old renderer, which multiplied display colours by it; in linear
light the same factor darkens a groove on the screen only by its 2.2th
root, and the rope's grooves read flat (their 25th percentile 32 levels
against the old renderer's 19). At 1.5 they are 18; at 2 they were 11,
black between the strands. The lights' diffuse light needs no
occlusion: their area rays already shadow it into the grooves. Their
highlights take the cavity term on creases and edges, as above.

The taps read the field as the distance it bounds. A field that is a
bound and not a distance (a non-uniform scale, a smooth union, a loft, a
warp, a sweep, an ellipsoid's far field, a difference above the mouth of
its cut) reads less than its distance in open air, so a tap h out from
such a surface read h − d of occlusion where nothing was near, and the
surface read as a hollow. The Roblox wings' boss is a sphere scaled 1 by
1.2 by 0.7: over its pixels where nothing is near (where the distance to
the extracted mesh finds nothing within the taps), its cavity term had a
median of 0.87 and a twentieth of it under 0.68, its reflections dimmed
to that cubed since the kernel. The cafe set's rug is a cylinder scaled
0.7 across: there its sky light was dimmed to 0.16 (the median) and its
reflections to 0.21. Where a tap reads less than its height,
`boundDistance` (pbr.ts) measures the field's slope there and divides
the value by it: a bound's slope is its ratio to the distance (0.7 on
the rug's top, exactly), a distance's is 1. Three things make the
measure:

- On each axis the slope is the steeper of the two one-sided
  differences half a cell either side. Where two surfaces are equally
  near (a groove's middle, a corner's diagonal, the gap between two
  parts) the distance is the smaller of two and has a kink, and a
  difference across it is short: measured by forward differences, the
  stairs, all exact, moved 1,698 pixels and read further from the
  mesh's distance (off by 0.016, against 0.011). The steeper side is
  never short at such a kink.
- A one-sided difference steeper than 1.2 steps (`BOUND_JUMP`) is a jump
  in the field, and the other side is taken. A union skips a part whose
  box is farther than the nearest value so far (its bounding-box cull),
  which is no lower bound on a scaled part's smaller value, so the field
  steps where the cull starts, ten steps at once above the rug; without
  the rule the measure drew the rug under the table as a flat grey
  patch, with contours round the legs.
- Slopes of 0.98 and over are a distance's and the value is read as it
  is; under 0.95 a bound's in full; a ramp between draws no contour where
  a slope crosses a line (`BOUND_SLOPE_ONE`, `BOUND_SLOPE_FULL`). Half a
  cell either side of a point a cell or two from a small curved part,
  the steps fall a few percent short of 1: with every slope under 0.999
  read as a bound, the stairs' rail of spheres two cells across moved
  400 pixels by up to 4 levels. Lines at 0.95 and 0.9 left more of the
  wings reading as a hollow (their feathers are ellipsoids, whose far
  field is a bound): the wings' occlusion was off by 0.14 against the
  mesh's distance (below), against 0.11 here and 0.08 at 0.999 and
  0.99, which cost 1.3 to 1.9 more samples a pixel.

The steps toward the surface are asked first, the normal's largest axis
first, and stop as soon as they make a slope of 0.98; the other three
sides are asked only when they do not. A tap that reads its height or
more is asked nothing, and a tap of a field that is a distance reads its
own value unless its steps fall short of 0.98 a cell or two from a small
curved part: the mug drew the same bytes, the stairs, all exact, moved
32 pixels by one level. The floor's occlusion and its contact term read
their taps the same way; under a bound they drew a grey ring on the
floor round the cafe set's rug, a wide grey band round the lighthouse's
island and a grey patch past the garden's tray.

Measured against the occlusion read from the distance to the mesh (a
closest-point query on the extracted triangles, the sign the field's;
right to a fraction of a cell where the mesh is) at every other pixel
of the model in each direction, over the 82 programs of the three sets,
the occlusion to the power 1.5 was off by 0.036 on average and is off by
0.023, the cavity term cubed by 0.036 and 0.021. Dividing every tap by
the slope at the surface point instead (gradientInto's, gated off where
the field bends, since across a crease the central differences are short
too: the ring's lips read 0.80) costs nothing and reaches 0.029 and
0.026. It is right for the rug's top, but it divides a tap that reaches
another part's distance too (round the table's legs on the rug the
occlusion to the power 1.5 read 0.43, against the mesh's 0.25 and the
measure's 0.24), and it misses an exact surface whose taps read a bound
(the feathers' far field, the mouth of a cut). Where the field is a
distance nothing moves: on the ring, the mug and the stairs no pixel's
occlusion or cavity term moves by 0.05 (on the hub 4, on the tower 6),
the ring's FOREVER is 37.4 levels darker than the same pixels uncut, as
it was, and the rope's darkest tenth moved by 0.3 of a level.

The measure costs samples where a tap reads short: 5.3 more field
evaluations a pixel on the stairs (against 11.8 for the whole render),
6.8 on the rope (15.5), 12.2 on round 4's frog (13.2) and 13.6 on the
cafe set (15.4), counted over the beauty render's pixels at 384. The
beauty render took, at two threads, the best of three runs interleaved
with the base's on a loaded machine, 2.5 s for the stairs against 2.0,
3.2 against 2.4 for the rope, 3.8 against 2.4 for the frog and 1.9
against 1.4 for the cafe set; timed again on a quieter one, 2.4 against
2.0, 3.0 against 2.2, 3.5 against 2.4 and 1.5 against 1.2, a fifth to a
half more. A tap only adds occlusion, so once the sum reads the floor of
0.3 the taps after it cannot move either term and are not asked: the
same bytes, and the rope's 3.0 s became 2.8 (its grooves fill), the
others no faster. Carrying a tap's slope to the next where the field
grows at that slope between them took a quarter of the samples off the
cafe set and a fourteenth off the frog, and was left out.

In the three sets 98 of the 104 beauty renders changed and 21 moved by
more than 8 levels on more than 200 pixels, every one of them lighter
(one pixel in all is darker by more than 8, by 11, on the wings): the
cafe set's rug and the floor round it, round 4's, 2's and 3's frogs,
the lighthouse's island and its floor, the wings' boss and feathers and
the floor under them, the gold lids of round 3's and 4's trophies (their
domes had read as a dark band), round 5's treehouse's canopy and the
tree's, the lantern's roof, the sailboat's hull, the floor under the
anglepoise's shade and under the teapot's handle (its body did not
move). Of the other 77, none moved by more than 8 levels on more than
159 pixels, 57 by no more than 8 anywhere and 39 by no more than 2.

What the measure gets wrong shows on the floor more than on the model.
The slope a tap reads is that of the part whose field is the smallest
there, and the field is the smallest of the parts' values, not of their
distances: a part whose field reads low hides a nearer one whose field
reads a little higher, and where two parts' fields with different slopes
meet, the reading steps. Under round 3's frog the displaced, blended
body (slope 0.58) is the smallest field over the pad's notch, and
divided by its slope the floor's highest tap reads 19 to 27 cells where
the pad is 14 to 17 away by the mesh: the floor there reads 1.00 where
the mesh says 0.89 to 0.99 and the raw field read within 0.03 of the
mesh, a pale wedge with straight sides. The wings' feathers are
ellipsoids whose slope falls under their ratio to the distance (0.86
against 0.93 below the boss), so past the kink between two feathers the
floor reads 0.85 where the mesh says 0.81, against 0.80 on the near
side: an edge 25 levels high on the floor under the shadow. Round the
lighthouse's island the blended, displaced rocks' kinks read a slope of
1 or more on the steeper side (a difference over a step from one branch,
another from the next), so the correction drops out in specks and the
soft grey band round the island became a ragged rim. The floor under the
anglepoise's shade has a faint straight edge too. Measured from 3,000
points of each program's surface by area and a grid of the floor round
it, against the mesh's distance, these do not undo the gain (the floor's
occlusion times its contact term off by 0.0034 on average, against
0.0058 raw), but they are what a reader sees. Tried against them and not
kept: the one-sided steps grown to nine tenths of the tap's value (the
surface's occlusion off by 0.027 against 0.0215: a long step reads a
curved field's bend as slope); the slope along the descent over nine
tenths of the tap's value as a second reading, the larger kept (one
sample more, the same averages, the frog's wedge a little fainter); that
slope alone (0.018 on average, but 0.62% of the surface's points read
more than 0.1 too open against 0.38%, and the wedge brighter); the
larger of the two one-sided gradients in place of the steeper side per
axis, with a jump at one step (the island's rim smooth, but the stairs,
all exact, lighter by up to 7 levels, 39 pixels by more than 2: a hollow
that is a distance must not lighten). Each part's own slope is what
would answer them, and only the shape tree knows the parts.

A metal preset's colour is its F0, written in sRGB, as glTF means a
metal's base colour, so beauty.png, the viewer and an engine read the
same colour (src/sdf/materials.ts says where each comes from). Silver
and chrome (as chromium) are measured F0 from Real-Time Rendering, 4th
edition, table 9.2: linear 0.972, 0.960, 0.915 (#fcfaf5) and 0.549,
0.556, 0.554 (#c4c5c4). The rest changed when the first measured presets
were read in the regenerated renders, because a measured metal in a
picture does not always read as that metal:

- **Steel** is iron's measured F0 from the same table (0.562, 0.565,
  0.578; #c6c6c8): steel is iron with under 2% carbon and has its
  reflectance, a neutral grey. The stainless value it had first (0.669,
  0.639, 0.598) is warm, and the hub, the gear and the bracket read
  ivory and ceramic under a warm key; the hub's top now measures a
  saturation of 0.02.
- **Iron** is the iron things are made of, wrought, cast or blackened,
  under its skin of black oxide: magnetite, most of mill scale and of a
  blacking, which reflects about 20% across the visible spectrum (ore
  microscopy's reflectance tables give 20 to 21% from 470 to 650 nm),
  neutral, linear 0.20 (#7c7c7c). Bare polished iron's 0.56 drew the
  bench's arms and the door's hinges as chrome tubing and the lantern as
  white enamel. A worn edge rubs it to satin, halfway to bare iron and in
  scuffs (see "The finish, and the maps that carry it"), and the rust
  preset is the same iron, rusting.
- **Gold, brass, copper and bronze** are their measured F0 squared: gold
  Lagarde's (2011: 1.000, 0.766, 0.336), brass (C260 cartridge brass)
  and copper from table 9.2, and bronze, which no table measures, the
  mean of the copper and brass rows (0.933, 0.708, 0.481). That gives
  gold #ffc95e, brass #ebcc75, copper #f5ab92 and bronze #f0bc84. A
  measured F0 is pale (gold #ffe39d): in a neutral room the trophies'
  gold read as champagne, the sign's brass letters as cream and the
  bottle's bronze collar as pink, and a darker room alone turned them
  khaki (the round-4 trophy's cup went from 170, 147, 89 to 129, 109,
  59, where the old renderer drew it 202, 159, 56). Gold reads gold in a
  picture through its own interreflections, and the square is the colour
  of light after two bounces off the metal: each keeps its measured hue
  and the order between them, and takes the saturation a picture of it
  has (the medal's face 0.73, against 0.46 at F0 and the old renderer's
  0.68). It is a stated departure from measured values, and in a glTF
  viewer gold (linear 1.0, 0.59, 0.11) is a deep orange-gold.

Reading F0 as the square root of a metal's colour, which would have kept
the old preset colours, was rejected in the design: it came out pale
khaki, and beauty.png would lie about the GLB, whose base colour an
engine reads as F0 itself.

## Environments as light

A sky (environment.ts) is three things at once: the backdrop the camera
sees, the light a surface takes from all round, and what a metal
reflects. There are four. Each is the old renderer's gradient (a sky
colour, an optional horizon band, the ground) with structure added, and
each is looked at in one of five modes: the light a surface takes
(DIFFUSE), what a glossy surface reflects (FILTERED, which adds the
cards), what the camera sees (BACKDROP), and what a mirror sees, without
the lights (REFLECT) or with each directional light as a softbox
(MIRROR). A sunset tints a chrome ball's rim the way the sky does
because they read the same tables.

The studio is rigged to the camera as a photographer rigs one: the white
sweep behind the model, dark walls on the camera's side above the
horizon and a black flag on the floor there, a dim ceiling, the model's
own shadow on the floor away from the key, and three cards that only
reflections see (a fill card right and low, an overhead strip across the
frame, a rim strip behind on the left; `STUDIO`). A metal facing the
camera reflects the dark and the cards, so its form reads; a model's
shaded side faces the dark, so it is modelled. All of it is out of shot:
BACKDROP leaves the structure out, since folded in it made the studio's
sky 35, 78 and 148 levels darker than the old backdrop at 40 and 60
degrees up and at the zenith. The floor the camera does see carries the
flag too, for reflections only, from where the bottom of the frame meets
the floor outwards (pbr.ts, `flagFrom`); started at the camera instead,
it darkened the bottom half of a plan view's floor from 210 levels to
48, because a camera looking steeply down sees floor beyond its own
place. The flag is lifted on the key's side, where the floor is lit and
a medal's face turned to the camera and the key reflects it; without
that the medal read khaki.

The rig has two sets of walls, ceiling and flag: one for the light a
surface takes (DIFFUSE) and a darker one, reaching further round, for
what it mirrors (`STUDIO.reflect`, read by FILTERED, REFLECT and
MIRROR). A photographer flags reflections harder than light: the room
round and behind the camera is black in a metal and still bounces light
into a shaded side. With one set at the light's darkness every metal
mirrored a mostly white room and read white, cream or ceramic (rough
iron facing up returned 0.8 of the sky); with one set at the
reflections' darkness a white mug's shaded side fell from the old
renderer's 89 levels to 53, the teapot's to 51, and the rope's grooves
went black. With two, and the occlusion's power above, the teapot's
shaded side is 103 levels (the old renderer 90), the mug's 82 (89) and
the rope's grooves 18 (19). The light's rig reaches its darkness right
at the horizon, because a shaded side takes 70% of its sky light from
the ground on its own side and the camera's, and a bright band either
side of the horizon lit shaded sides and almost no reflection. The
darker reflections are the studio's alone: under the overcast sky silver
and steel's upward faces still read near white, and that is the sky a
mirror metal reads white in.

The other skies: the overcast is a white dome, brighter towards the
zenith; the sunset a blue sky over a warm band with a sun 3 degrees up
(`SUN_ELEVATION`) at the key's azimuth, with its glow; the night a dark
blue sky, a moon at the key's azimuth and its elevation held between 25
and 60 degrees (`MOON_ELEVATION`), and stars. The sun and the moon stand
where the key comes from, so every frame of a run shares one sky (but
for a steep shot's turned key, below). The stars sit on a grid of equal
angles (rings 0.008 radians high, 4% of the cells holding a star of
angular radius 0.0018 radians at a hashed place), so they are round dots
at any elevation (measured 0.8 to 1.25 wide for their height); a grid on
the lat-long drew ellipses at the horizon and slivers at the zenith. A
glow ends 90 degrees from its disc without a step, where the prototype's
cut-off drew a 6-level line across a sunset sky.

A surface takes the sky as two tables. Its diffuse light is DIFFUSE's
irradiance as nine spherical-harmonic coefficients per channel,
integrated on a 96 × 48 grid. Its reflection is FILTERED prefiltered by
a GGX lobe at six roughnesses from 0.15 to 1 (`PREFILTER`), read
bilinearly within a map and linearly between two. The maps are filtered
importance sampling (Křivánek and Colbert): the sky is drawn once on a
512-wide lat-long with a mip chain, and each of 64 or 96 Hammersley
samples reads the mip whose texels are as large as its share of the
lobe. Plain samples could not find the studio's bright cards in a lobe
as wide as a hemisphere: against 4,096 samples the roughest map was 6
levels off on average and 43 at worst, and filtered it is 2.4 and 11.7.
In a constant sky the irradiance comes back within 1% and every map
within 0.5%. Each directional light is a softbox in MIRROR, a disc of
the light's own angular size whose radiance is π·KEY·p over its solid
angle, so a mirror shows a light as strongly as it lights (the integral
comes back within 1% at sizes 1 and 3).

One intensity, E (the palette's ambient times `set ambient`), scales
everything the sky gives a surface, diffuse and reflected alike; it does
not scale the lights' softboxes, which are the lights, nor the backdrop.
The shading prototype lit diffuse surfaces with 0.6 of its studio sky
(0.9, 0.9 and 0.4 of the others) and reflected all of it. three.js has
one environment intensity for both, so the viewer could not show that
split, and a look the export cannot carry is not one to decide a
material by. The studio keeps E at 1, as the prototype's reflections had
it, and wins its shaded side's darkness back through its structure; the
overcast and sunset keep the prototype's 0.9 and the night its 0.4,
their reflections dimmed with them (the teapot's shaded side within 1.5
levels of the prototype's in all four).

The tables are built once per run per sky, on the main thread, in 50 to
100 ms, and kept in the run's cache (kernel.ts, `BeautyCache`) keyed by
exactly what each sky depends on: the overcast on nothing, the sunset
and the night on the key, the studio on the camera's azimuth and the key
(the model's shadow on its floor). beauty.png, each camera's shot and
the strips share them, the viewer page builds its sky into the same
cache, and the pool's workers read them on SharedArrayBuffers. A hit and
a miss give the same bytes, which a test checks for all four skies.

The far floor fades into the sky just above the horizon in its own
direction (`horizonRadiance`), from one reach beyond the model's box
(1.5 times the model's diagonal) to four. It is measured from the model,
not the eye: the old renderer's fade by the distance from the camera
took a third of a shadow's depth away right beside the model, where the
floor is a third of the way to the reach of four the fade ran to, and
the tumbler's shadow vanished. Below the horizon the lighting modes
blend from the horizon's colour to the ground's over 0.05 of the look's
downward part, so a reflection has no seam either. From a camera 2
degrees up, the step across the horizon is 1.60 levels at sunset, 1.11
at night, 0.61 in the studio and 0.40 overcast.

The default key (`DEFAULT_LIGHT_DIRECTION`, upper left from the front,
about azimuth −40.2 and elevation 46.6) is fixed in the world for every
shot but one kind: a camera looking steeply down. People read a picture
as lit from above, and in a plan view the front-left key lights the
frame from its bottom, which draws a blind pocket as a dome (round 10's
hub: its plan shot's pockets read as bumps). So from a camera elevation
of 55 to 75 degrees (`STEEP`) the default key turns, smoothly with the
elevation, to the frame's top left: 135 degrees round from the camera's
azimuth, at the default key's elevation (environment.ts, `defaultKey`);
a sunset's sun or a night's moon turns with it. It blends the two
directions rather than their azimuths: turned by azimuth the shortest
way round, two cameras a twentieth of a degree apart, either side of the
one whose target lay straight across from the default key, went round
opposite ways, and their keys were 87 degrees apart. A program that
places its own lights, or sets `light_azimuth` or `light_elevation`,
keeps them: the rule only chooses for a program that did not. An unset
one of those two falls back to −40 or 55 when the other is set, so
`set light_azimuth -40` alone gives a steeper key than the default.
Round 10's hub declares its key at −40, which lights its plan shot from
the bottom left, and its pockets still read as domes; with the key at
the camera's azimuth less 135 they read as holes. The viewer page keeps
the world's key, since its camera turns.

## Reflections

What a surface reflects depends on its roughness and on how much it
reflects (the split sum's weight, F0·A + B), by four cases (pbr.ts):

- **A mirror**, under 0.12 (`MIRROR_ROUGH`): one traced ray, and
  whatever it meets is shaded in full, the model, the lit and shadowed
  floor, or the sky a mirror sees with each light's softbox, its sun and
  its stars. A directional light's highlight is the softbox, so its
  analytic highlight is left out.
- **A glossy metal**, from 0.12 to 0.35 (`GLOSSY_ROUGH`), or a surface
  that glossy whose Fresnel weight passes 0.2, where the camera sees it:
  four GGX rays about the normal. The ones that meet the model bring its
  light; the ones that miss share the prefiltered sky.
- **Other glossy surfaces**, under 0.55 (`TRACED_ROUGH`): one ray along
  the mirror direction, blended into the prefiltered sky by (1 −
  rough)².
- **Everything else**, and any surface whose weight is under 0.015: the
  prefiltered sky alone, dimmed by specular occlusion.

The four glossy rays are one fixed stratified pattern for every pixel,
the lobe's quantiles turned by the golden angle, not random directions:
four random rays left salt and pepper in the mixer's steel bowl, where
four fixed ones are a slight blur. Past 0.35 four rays are grain again
(a steel bowl of roughness 0.45 was salt and pepper with them), so one
ray blended into the smooth prefiltered sky takes over. A glossy ray is
scaled down whole, its hue kept, to a peak of 3 (`GLOSSY_CLAMP`): a ray
of four that met a mirror showing a softbox (150 times a lit face) or a
flame put one pixel in a hundred at white on the lantern's bars and the
ring's band, a sparkle that read as a bump. A mirror's own ray is not
clamped, since it is showing the softbox. In full quality a brightness
jump beside a mirror or glass also makes a pixel an edge, so a sharp
reflection's outline is antialiased.

Reflections are traced to a depth of two in full quality and one in
draft (`MAX_DEPTH`), and a surface a reflection meets traces again only
if it is a mirror (chrome in chrome); a glossy surface met by a
reflection takes the prefiltered sky. That second glossy bounce was 39%
of the mixer's time in the shading prototype, for a reflection of a
reflection that blurs away. Something the glossy rays bring is still not
explained: wavy streaks on the inner wall of the mixer's bowl in its
`into_bowl` shot stay with sixteen rays, so they come from what the
reflections meet, not from the pattern.

## Shadows from lights with a size

A light's size has one meaning: an angular radius of size/18 radians
(`lightAngle`; 1 is about 3.2 degrees, 3 about 9.5). The one angle sizes
the disc its shadow rays aim at, widens its highlight (the lobe's α
becomes min(1, α + 0.5 tan θ), its peak lowered to keep its energy) and
sizes the softbox a mirror sees. A point light is a sphere of radius
0.02·range·size (`pointRadius`). The angle's 18 was calibrated against
the old renderer's look rather than physics: the path-tracing
prototype's size/20 had been sized to keep the old penumbra's width. No
disc is wider than 1.5 radians (`MAX_LIGHT_ANGLE`, size 27), because
past a right angle the disc's tangent turns negative, which turned the
early out's grown boxes into shrunk ones, and a softbox's edge wrapped
round the sphere and shrank it to 0.1 radians at size 100.

A surface's visibility of a light is traced (rays.ts, `areaVisibility`).
The field is marched along the centre ray for the first three cells, the
old soft march, so a contact shadow hardens where a part meets the
floor. Beyond them eight rays go to the light's disc against the mesh:
four on the outer half of its area at one radius, a quarter turn apart,
and four on the inner half turned an eighth further, each uniform over
its half, so the mean is the visible share of the disc without bias. A
pixel's rays are placed by its position, the light and the subsample
(`diskPattern`): the turn is interleaved gradient noise over the pixel
grid, transposed so it does not follow the dither's, and the two radii
an R2 lattice, both shifted by a hash of the light and the subsample.
Neighbouring pixels so take well-spread rotations, and through the
filter that is 13 to 40% less noise than a hash per pixel at 384 (the
medal's floor at 768: 3.0 levels against 3.6). Behind a unit cube the
filtered penumbra's 10 to 90% width is within 1.2% of the exact disc's
at size 1 and 1.5% at size 3, and its 50% line 0.018 from the geometric
edge; the concentric quadrant pattern first specified narrowed it by 7.8
and 14.9%.

When no triangle can meet the cone the eight rays span beyond the near
march, all eight are clear, and the answer is taken without them
(`coneClearRay` in bvh.ts). The test is conservative, so it is exact: on
all seven benchmark scenes no pixel differs from always tracing eight,
and it answers 76 to 93% of calls alone. The early out first specified,
stopping when four quadrant rays agree, put 8.2% of the lantern's pixels
more than 2 levels from eight rays, because a grille lets light through
four probes. There is no early out for a point in full shadow; it takes
its eight rays.

Eight rays a pixel are noisy, so each light's visibility is filtered
(denoise.ts): a joint bilateral filter guided by what the primary rays
saw, the depth, the field's normal, the material and whether a pixel is
the model or the floor, so it never blurs across a silhouette or a
crease; edge pixels, which have four samples of their own, neither give
nor take. It filters visibility alone, a ratio between 0 and 1, and the
light's unshadowed term, with the bump's normal and the texture in it,
is multiplied in after at full resolution. Filtering the whole diffuse
term washed the bump out of the door's stone, because the guides see the
field's normal and not the bump's: the light on the stone faces measured
a high-pass RMS of 7.78 levels unshadowed, 7.52 with the visibility
filtered and 1.32 with the whole diffuse filtered. The radius grows with
the picture, 3 pixels at 384, 4 at 512 and 6 at 768 (`filterRadius`),
since a fixed one left grain at 768. On one thread it takes 0.12 s at
384 and 0.95 s at 768. A shadow ray that crosses glass measures the
glass on the field and dims each channel by Beer's law (see Glass), so
an amber pane's shadow is amber (its red over blue at least 1.3 times
the open floor's, a clear pane's within 5% of 1).

The old shadow was Quilez's soft march: one ray towards the light, the
penumbra taken from how closely it passed the model. That darkens only
outside the hard shadow, the outer half of a penumbra, so a larger light
grew a halo outward while the umbra kept its hard edge, and the march's
steps drew stair-steps (the medal's ribbon, the door's torch wedge) and,
once, the spatial index's grid on the floor (see A grid over the
pieces). An agent reads either as geometry. What the disc costs is that
a physically sized light shrinks or removes the shadows of thin parts
(the lantern's bars, the torch's bracket, the ring's claws), and a large
light's umbra shrinks, as a real one's does.

## Glass

A solid that lets light through (pbr-glass.ts) splits the light by
Schlick's Fresnel at an index of 1.5: a reflection, traced while the
depth budget lasts and otherwise the sky a mirror sees, and what is seen
through it. The refracted ray enters the solid, and the inside march
(rays.ts, `insideMarch`) carries it on the negated field to where it
leaves; there it refracts out by the field's normal and is traced, so
the drink, the far wall and the floor behind are what the glass shows.

The inside march has to tell an exit from a zero that is not one. A zero
the field touches without crossing, where two coincident faces of a
union meet (and, before round 11, along a revolved outline's axis), is
still inside a cell further on, so it is no exit; nor is a sliver of
outside thinner than two cells that the ray runs along, with the solid a
cell away on both sides across it, which is what a liquid revolved a
hundredth above its glass's floor makes (the tumbler's). Without the two
rules the tumbler's drink drew contour bands and dotted lines. A test
holds the rule on two coincident glass boxes, whose shared face is an
exact zero: the exit comes out within 2% of the far face.

Where the exit is past the critical angle the ray reflects inside and
marches again, up to four times (`TIR_EVENTS`), before it gives up on
the sky behind, tinted. The old renderer gave up at the first such exit,
and that drew the white triangles in the tumbler's thick base.

Every stretch inside absorbs by Beer's law, σ = 22(1 − c)/reach per
channel (`BEER` in photometry.ts), with c the glass's colour and the
reach 1.5 times the model's diagonal. One law serves the refracted rays
and the shadow rays through glass, which is what tints an amber shadow,
and it is the law roadmap item 21 would write into the GLB's volume
extension (an attenuation colour of exp(−(1 − c)) at a distance of
reach/22). The old renderer dimmed display values by
exp(−10(1 − c)t/reach); a display value is near linear light to the
power 1/2.2, so the same drink in linear light takes 2.2 times that: at
10 the tumbler's whisky came out the colour of milky tea (182, 148, 98
against the old renderer's 135, 97, 53), at 22 it is the old colour
again. The absorption is integrated stretch by stretch: `hit()` is asked
every six cells and just short of the exit, and each boundary between
materials is found by five bisections, so each material counts for the
length the ray spends in it. Averaging the samples instead counted a
stretch by how many samples happened to fall in it, and drew a stripe
every few rows where the ray crosses the tumbler's base into the drink.

A glass that does not let all its light through (transmit under 1) mixes
in its surface shaded as a smooth dielectric of its colour. A point
light's highlight on glass is analytic, with the occlusion ray the
surface's own shading already traced; a directional light's is the
softbox in the reflection, traced or not. Adding its analytic highlight
too lit a glass seen in a mirror twice (the key's share at the
highlight's peak 15.3 against 10.7).

Glass seen through glass is shaded to a chain of two in full quality and
one in draft (`GLASS_CHAIN` in pbr.ts); past the chain it is the sky
behind, tinted by the glass's colour. With the rules above the tumbler's
drink, inside its glass, shows no contour bands at two (a test holds
every row-to-row step inside the drink under 6 levels at 256 pixels), so
the chain was not cut to one to save time. Each depth keeps its own
absorption: one array shared between depths let the inner glass's shade
overwrite the outer's, and an amber slab in front of a clear pane came
out (0.93, 0.87, 0.80) instead of (0.93, 0.26, 0.09), the tumbler's
drink seen through its upper wall near black.

Two looks in the committed renders were checked and are right. The
tumbler has a dark band where the drink meets its thick base: a probe of
the rays at 384 pixels shows the rows above it refract through the side
wall and the base and see the floor behind the glass (radiance 0.53
before absorption), the band's rows leave the base low and see the
floor's contact shadow right behind it (0.21), and the rows below
reflect totally off the base's underside and see the sky; lifted 0.8 off
the floor, the band goes. Round 9's bottle has red-black mottling in its
lower corners: those rays reflect inside the rounded, filled body two to
four times and leave dimmed by up to exp(−1.46, −3.49, −4.18) per
channel, and neighbouring rays take different sequences of reflections.
The optics are right and the signal is chaotic; smoothing it would take
more samples a pixel there.

Glass is the costliest material. The tumbler took 3.5 times the old
renderer's time on one thread at 384 (3.1 at 768), the one scene past
the plan's twice: inside marches are about 45% of it and shadow rays
through glass about 30%. Sharing the centre ray's transmittance with all
eight of a pixel's shadow rays that cross glass would save about 0.7 s
of its 3.5, and was built and not kept: the amber shadow became a
sharp-edged copy of the glass as the centre ray sees it, and the floor
beside it took a pale band (up to 36 levels, 4,158 pixels by more than
8).

## The floor

The floor's albedo is solved per render (pbr.ts) so that the open floor
near the model shows what the old renderer displayed there, under the
sky's light from above and every directional light at full strength,
capped at 0.95. The target is each palette's `open` (environment.ts),
measured on the committed renders before the rebuild, in red, green and
blue levels: the studio's 211, 208, 204 (over the medal, the teapot and
the hardware plate), the overcast's 207, 206, 203, the sunset's 115, 93,
79 and the night's 13, 13, 17. Solved to the palette's floor colour,
which the old renderer lit and faded towards its ground but never
displayed, the studio's open floor came out 13 levels lighter, close
enough to the white sweep that the horizon all but vanished behind a
light model, the sunset's 40 lighter and the night's two to three times
as bright, so a torch lost the dark ground it pools on. Over the 104
beauty pictures the median shift of the open floor against the old
renderer went from 12.2 levels to 2.6, and a test holds it within 2.5
levels of `open` in all four skies.

Every light reaches the whole floor at full strength. The old floor took
each light's share of the total power, so the candle inside the lantern
never put its bars' shadows on the floor, though an engine lighting the
GLB would. Shadows are traced only near the model, within one reach of
its box and fading out over the last third of it; a point light cut off
there drew its pool's edge as a line across a low shot (the door's
torch, a step of 22 levels between rows). The open floor round the
lantern is now brighter than the old renderer's (206 levels against
187), because its three lights each light it fully.

Under a part standing on the floor the floor takes the field's occlusion
and a wider contact term, four taps up from the floor reaching 19% of
the model's diagonal and darkening by at most three quarters, and the
lights take it as well as the sky. The area rays see the light's disc
past the part but not the darkening a base makes where it meets the
floor: without the contact term on the lights the floor under the
lantern's base was 45% brighter than the old renderer's; with it the
base darkens its floor to 0.67 of the open floor round it, where the old
renderer had 0.68. A tap is not asked where the floor point lies farther
from the model's box than the tap is high, which skips nothing that
could reach.

The floor reflects nothing. A sheen on it, in the shading prototype,
drew a faint ghost of the model under its contact line, which a shot
from above could take for a part. It does stop the lights that come
from under it. A directional light below the horizon, or a point light
below the floor (under min(0, the model's lowest point)), lights
nothing: not the model's sides, which it used to light through the
floor, not the floor, not a mirror (it has no softbox) and nothing
through glass. That is one flag a light, the same flag that already
skipped a light of power 0 at every place a light is evaluated, so it
costs nothing a pixel and every thread count agrees. The test is on the
light's centre, as the floor's own lighting was: a directional light at
elevation 0 still lights the faces turned to it in full while the floor
takes nothing from it, and a disc that dips below the horizon is not
clipped by it. The viewer's Scene mode and an engine reading the GLB
still light from below, since the viewer's ground takes shadows but
casts none.

## Threads

The beauty render runs on a pool of workers kept for the life of the
process (beauty-pool.ts), with the main thread drawing rows beside them.
The shape is a tree of closures the interpreter built, which cannot
cross to another thread, so each worker builds its own by evaluating the
program again: the same source, pose, slice and shown steps, each
library's source and each picture as the main evaluation read them, and
each import's samples as the main thread recorded them. A worker never
samples an import again: it reads the samples from a map keyed by file
and resolution, which fails on a miss, so a file edited during the run
cannot change a worker's field. A worker keeps the last program it was
sent and builds it while the main thread meshes. Everything else crosses
as data on SharedArrayBuffers: the options, the camera, the mesh's
arrays (once per mesh), the kernel's tables (the sky's maps, the
hierarchy) and, per render, the primed depth and the kernel's buffers. A
material is named by a key from its fields (`materialKey`), not by
object identity, since a worker's materials are its own objects; two
identical materials now share an id, which moved four committed renders
by a few pixels on seams between such materials when it came in.

Each job carries the main thread's field at 64 points, and a worker
whose own field differs at any of them, to the bit, draws nothing; the
main thread says once that it drew without it. Rows are claimed one at a
time from an atomic counter by every thread, so a worker still building
its shape simply claims none and a slow row holds up no one. A barrier
comes between the passes: every row's primary samples are done before
any row's edge pass starts, since the edge test reads a row's
neighbours.

The pipeline is synchronous, and so is the pool: the main thread posts
the job, draws rows itself and waits on the counters with
`Atomics.wait`. It cannot hear a worker's events while it waits, so
failure is read from shared memory: a worker that throws or exits sets
the job's error word, and a job that finishes no row for a minute is
taken as failed. The job is then drawn again on the main thread alone,
with the same bytes, the pool is off for the rest of the process, and
the log says so in one line. The workers are unreferenced, so the pool
never keeps the process alive.

Every pixel is a function of its position and the scene: no
`Math.random`, no clock, no state one row leaves for the next, the
filter's rows reading only the unfiltered input. Which thread drew which
row therefore cannot change a byte, and tests compare beauty.png, the
camera shots and lights.png at one, two and four threads, and every
linear float of every light's share at one and three. The command line
draws on min(4, the available cores) threads (`--threads N`); `run()`
defaults to one, so a library caller or a test is single-threaded unless
it asks; the render sets use the command line's count. Measured on the
old renderer's shading moved onto the pool, on a machine of four shared
cores: four threads took 0.40 of one thread's time (the geometric mean
over the seven scenes at 384 and 768), and the render sets, with
lights.png no longer drawn for them, went from 930 s to 633 s.

## What each light adds

`lights.png` began as each light alone, then all, which shows what a key
or a rim light does but not a small point light: under one alone it
changes a few dim pixels of a whole picture, and the ambient sky, which
every frame keeps, swamps them (round 10: a ring's spark). So the strip
has a second row, each light's own contribution brightened until the
99th percentile of what the light reaches shows at 230 levels, the gain
(between 1 and 32) printed, and closes on the picture under no light,
which is what every light adds to.

It is one half-size draft render (lightstudy.ts). With `splitLights` the
kernel keeps the light apart in slots: slot 0 holds what no light brings
(the sky's light, the glows, the backdrop, the sky in a mirror) and slot
i + 1 everything light i brings, on the model and the floor, in a mirror
and through glass. Light i alone is slot 0 plus slot i + 1, all is the
render's own picture, none is slot 0, and what light i adds is its slot
times its gain, on black and unbloomed, so it is that light's radiance
and nothing spread from elsewhere. It replaced a render per light, one
under no light and one under all, which differed in more than the light:
the floor's albedo is solved per render from that render's directional
lights, so each frame showed the palette's own floor and the row
under-reported a light on it (the door's torch alone lit a floor of
albedo 0.95, where the shot's is 0.26, 0.20, 0.10), and a glow near
white in two pictures differs only in the channels not already full, so
a flame a light barely touched came out green once brightened (round
11), which needed a grey mask. A glow is in no light's slot, so what a
light adds on a flame is the light on the flame's colour, and the mask
is gone.

The frames are exact. The rows keep the slots' sum in double precision
beside the slots, and the finish composes the picture from it, adding
each light's direct light in the order an unsplit render does: summed
from the slots, each rounded to a float, the split picture differed from
the unsplit one in about one byte in a hundred thousand. With the total,
52 of 52 split renders drew their unsplit render byte for byte (every
example and dogfood program with two or more lights, draft and full, at
96 and 161 pixels). Light alone less none is that light's slot to the
last bit except where a slot is under 2^−29 of slot 0, where the sum
rounds it (one value of 28,227 in the test scene, off by 0.37 of a unit
in the last place). The one difference left is at silhouettes: the slots
keep an edge pixel's four samples as their linear mean, where the
render's own picture means them after the tone curve, so an edge against
something much brighter, a glow's, is up to 61 levels brighter in the
alone and none frames, and bloom spreads up to 6 levels round it.

On the lantern, the ring and the door, on four threads with 256-pixel
frames, the study takes about a third of the old one's time: 0.31 to
0.38 at 862f270 against 230a4d5, two or three interleaved runs each on
a lightly loaded machine (the lantern 0.80 s against 2.2, the ring 1.05
against 3.3, the door 1.1 against 3.2). The track that built it measured
0.17 to 0.31 on a busier machine, where the old study ranged from 1.8 to
3.5 s on the lantern alone. Each frame's caption is in dark or light ink
by the brightness under it. The strip is part of the full `--beauty`
render and not of `--beauty-only`, the loop for trying a finish, unless
`--lights` asks; the render sets never draw it, since they never commit
it; and the shot `set camera` names is `beauty.png` and is not drawn
again as `beauty_<name>.png` (round 11: the material loop's one shot was
the shot twice and the strip, 28 s against 8).

## What the rebuild costs

The beauty render alone, on the seven benchmark scenes, the old renderer
(at 1697253) against the new kernel, measured when the kernel was
reviewed: the inputs captured as a render set makes them (grid 112),
`renderBeauty` with a fresh cache, so each render pays its own hierarchy
and sky, the better of two runs back to back, on a machine of four
shared cores. Seconds:

| Scene | Old, 384 | New, 384 | New, 384, 4 threads | Old, 768 | New, 768 | New, 768, 4 threads |
| --- | --- | --- | --- | --- | --- | --- |
| medal | 1.56 | 1.47 | 0.97 | 4.46 | 4.95 | 2.39 |
| tumbler | 1.01 | 3.51 | 1.36 | 4.30 | 13.27 | 5.52 |
| lantern | 2.73 | 2.94 | 0.97 | 8.06 | 8.48 | 3.40 |
| teapot | 0.78 | 1.25 | 0.61 | 2.70 | 4.93 | 2.36 |
| mixer | 9.68 | 12.13 | 3.94 | 34.07 | 38.63 | 10.83 |
| door | 6.25 | 5.57 | 1.76 | 19.33 | 18.38 | 5.53 |
| ring | 5.13 | 4.94 | 1.83 | 11.89 | 14.93 | 4.86 |
| total | 27.13 | 31.81 | 11.43 | 84.81 | 103.58 | 34.88 |

On one thread the new kernel takes 1.17 times the old one's time at 384
and 1.22 at 768, inside the plan's 1.4 and 1.5; on four threads 0.42 and
0.41 of the old renderer on one. The tumbler, at 3.5 and 3.1 times, is
the one scene past the plan's per-scene limit of twice (see Glass); the
knob the plan gave for it, two glossy rays instead of four, took the
mixer from 11.6 s to 9.3 and the ring from 4.6 to 4.0 and did not move
the tumbler, so it was turned back. The legibility pass that followed
kept every scene within 5% of the kernel on one thread (at 384, the
better of two to five interleaved runs a scene over three sessions).

CI on the runner (GitHub's ubuntu-latest, four virtual cores), each
run's job from start to end and its steps, from the Actions timings of
pushes to the branch:

| Run | Commit | What it had | Whole check | `npm test` | examples | dogfood | std |
| --- | --- | --- | --- | --- | --- | --- | --- |
| 166 | c5a21bc | the old renderer on one thread, lights.png drawn for the sets | 16 min 6 s | 59 s | 150 s | 728 s | 10 s |
| 168 | 1697253 | the old shading on the pool, no lights.png in the sets | 11 min 40 s | 72 s | 112 s | 490 s | 7 s |
| 170 | cdd3a01 | the same, with fewer evaluations (see Fewer evaluations) | 8 min 55 s | 61 s | 77 s | 364 s | 5 s |
| 172 | 230a4d5 | the new kernel | 9 min 3 s | 67 s | 83 s | 371 s | 7 s |
| 174 | 862f270 | the legibility pass, lights.png in one pass, the export | 10 min 41 s | 87 s | 93 s | 437 s | 8 s |

The pull-request runs of the last two commits agree (run 173:
9 min 32 s, dogfood 389 s; run 175: 10 min 32 s, dogfood 428 s). The
pool, with lights.png dropped from the sets, and the fewer evaluations
paid for the new look: the dogfood set went from 728 s to 490 s and then to 364 s, as
the pool's gain measured locally (see Threads), and the kernel then
added about 15 s to the three sets (6 s to the examples, 7 to dogfood, 2
to std) and 8 s to the whole check. The last row's dogfood set is 39 to
66 s slower than the kernel's on both of its runs, and that is the
runner, not the code. Every program in the log took longer, by 1.11 to
1.27 times (median 1.19), the Roblox props that are mostly meshing and a
sheet as much as the mixer's camera shots, and the examples by a median
1.16. The test step rose by as much, from 67 s to 87. A cost the code
added would fall unevenly: a fixed one on the small programs, the
renderer's on the shots. On one machine the two commits take the same
time: five programs (round 7's jack, round 9's owl, round 5's bicycle,
round 3's excavator and the Roblox hatchling, run by the render set's
own scripts, interleaved, two runs each) summed to 65.9 and 67.0 s at
230a4d5 and 65.6 and 65.5 s at 862f270.

The beauty render's share of a render set was measured at 862f270 on the
same kind of machine (four cores of an Intel Xeon at 2.1 GHz, its load
average 2.4 to 2.8 over the run, the run's own threads included): every
program of the three sets run with `tools/render-set.ts`'s options, four
threads, TMPDIR private, summing each program's `beauty` and
`beauty:<camera>` timings (the camera's fit, the depth raster, the sky
and the hierarchy, the rows, the finish and the PNG) against its whole
run. The 82 programs took 598 s, of which the beauty renders were 142 s,
24%: 28% of the examples (29 s of 106), 23% of the dogfood set (111 s of
486) and 28% of std (1.9 s of 6.9). Per program the median is 26%, from
4% to 64%; the largest shares are scenes of glass, metal and glows,
round 9's bottle (64%, 7.9 s of 12.4), the lamp (57%) and round 10's
ring (54%, 14.1 s of 26.1), and the largest beauty times the ring's and
round 11's mixer's (11.4 s of 41.8). Before the pool, the design had
measured the old shading on one thread at 33 and 34.5% of a render-set
run over two samples of its programs, and 44% over the seven benchmark
scenes.

## Read blind

The new beauty render, as merged at 862f270, was checked blind against
the old one. A script set the beauty shots of eight models side by side:
the medal, teapot, lantern and tumbler from the examples, round 10's
ring, round 11's mixer and door, and the hardware library's plate. Each
pair set the render at 1697253 against the render at 862f270, and which
side each took came from a hash of the subject's name, so neither the
person composing the sheets nor the order of the pairs decided it. A
reader who saw only the pictures, without the programs or the key,
answered the same questions about every pair: the lettering, the counts
of repeated parts, how the model meets the ground, which parts are which
material, what is glass and what is inside it, and which shapes are
ambiguous; and said which side they would trust to check the model. The
answers were then scored against the programs.

| Subject | Old render | New render | Parts and lettering as readable in the new |
| --- | --- | --- | --- |
| medal | gold that "could pass for yellow plastic or paint" | gold, star, letters and loop all read as gold metal | yes |
| ring | gem read as deep magenta or purple (it is a pink-red ruby) | wood, velvet and metal read better; the engraving fainter gold on gold | no: FOREVER, unreadable in both, is less legible |
| teapot | knob "gold metal or yellow paint", body ceramic or plastic | knob polished gold, glazed ceramic, a contact shadow | yes |
| lantern | grey iron with rust, right | the frame read as bright polished steel or chrome; the bars' shadows on the floor read right | yes, but its iron read wrongly |
| tumbler | the drink opaque; the straw's bands miscounted | clear glass, a translucent drink, the bands counted right | yes |
| mixer | the steel bowl read as painted or plastic, the hub as plastic | polished steel, chrome hub, reflections read as reflections | no: the bowl's reflections crowd the beater |
| door | the lower half had to be brightened to count | all 35 heads counted without adjustment; the stone's colour left uncertain under the torch | yes |
| hardware | every part pale blue-grey, read as painted, plastic or dull aluminium | steel and zinc read as such | yes |

Both renders shared some misreadings: the hardware chain's six links
read as four, the ring's chrome inlay as a reflection and its round cup
as a box, the teapot's capped handle as an open tube, the door's walnut
torch handle as black iron, the medal's brass letters as gold, and the
straw below the drink was not seen at all. One shared misreading was the
language's, not the renderer's: both showed the medal's lower legend
mirror-reversed, because that is what `text()` built on a negative arc
until 55de603, which bends it upright and left to right.
Two of the teapot's answers were about its model, not the renderer: its
handle stopped short of the pot, so the free, flat end the reader took
for an open tube was there to be seen, and its spout, which the reader
saw closed at the tip, was closed: the bore was sealed at both ends. The
example now joins the handle to the body at both ends and cuts the bore
through the pot's wall and out of a tip cut flat, with asserts that say
so.

The reader trusted the new render in seven pairs of eight: the metals
read as metal, the glass as clear and the drink in it as translucent,
and the door's studs can be counted without brightening the picture. The
old render was trusted for the lantern, whose iron it showed truthfully.
The render did not meet the plan's bar, which asked for both halves: the
lettering and parts read at least as well in six pairs, not seven (the
ring's inscription and the mixer's beater), and one answer was wrong
only for the new render, the lantern's frame, the rust preset's dark old
iron, read as polished steel or chrome. That is the misreading the dark
iron preset was made to prevent; the first blind check of the kernel,
before the legibility pass, had read the same frame as white enamel. No
count or lettering was read wrongly from the new render alone, and the
one count that differed between the two, the bands on the tumbler's
straw, the new render got right. The two pairs and the lantern's iron
were left open; the plan's next step for legibility is a dogfooding round
that judges the renders.

Three of the misses were answered before that round, and the models they
touch were read blind again the same way, each pair setting the render
at 67ba88d against the answer's:

- **Worn metal** (the lantern and the door). `wear` now rubs a metal's
  edge to satin and breaks it into scuffs, fewer on a thin part ("The
  finish, and the maps that carry it"). Nothing was read wrongly from the new
  render alone. The door's studs and knocker ring, read as "clean,
  polished or oiled" and "newer" than the straps at 67ba88d, now read as
  one old rusty iron with them. The lantern reads old and rusting all
  over, its frame one metal and "much less chrome-like", but its bare
  metal is "still bright and silvery", hedged as rusted steel or
  galvanised. That is the flat faces, which wear never touches: the roof,
  the largest iron in the picture, is the rust preset's dark iron
  (F0 0.20, rough 0.55) taking the studio's overhead strip, and is as
  light at wear 0. The lantern's iron is still open.
- **The faint engraving** (the ring, with the medal and the nameplate as
  controls). A light's highlight now takes the cavity term where the
  field bends ("The BRDF is the viewer's"), so a groove's lips stop
  glinting. Every changed pixel in the three pairs got darker. The
  lettering read as well on both sides of every pair: AIXLE MODELS / FOR
  MACHINES 22 of 22, Ada Lovelace / Analyst 18 of 18, and the ring's
  FOREVER 0 of 7 on both. Nothing was read wrongly from the new render
  alone. The ring's inscription is about 50 by 5 pixels at 384, its
  strokes 1.75 cells wide: darker marks, but not letters. The reader,
  forced to choose, preferred the old side's thinner marks, and on the
  nameplate offered "black infill" for grooves that are bare brass, which
  is the risk of an engraving that reads as dark marks. The guide's row
  for sparkling letters gives a satin finish or strokes about three cells
  wide, measured on the ring.
- **The teapot** is the model's fix described above.

The mixer's beater among its bowl's reflections is not a renderer fault:
a bowl at `rough` 0.2 mirrors what it holds. The guide has a row for it.

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
on a node of its own (glb.ts, `glbLights`): a point light at its
position, and a directional one turned so its -z runs from the light to
the model, its node three radii out from the model's centre for an
engine whose shadow camera needs a place.

Both sides now work in linear light, so the intensities follow from the
beauty render's units rather than being fitted to them. The beauty
render gives a white face turned θ from a light of power p the radiance
KEY·p·cos θ (KEY = 1.05), and a point light's strength at a distance d
is range² / (range² + d²) of that. A physically lit engine (three.js,
Blender, Godot, Filament) gives a white Lambert face 1/π of its
irradiance: lux·cos θ from a directional light, candela·cos θ / d² from
a point light. So a directional light is π·KEY·p lux, 3.30 for power 1,
and agrees with beauty.png on every face at every angle: computed
through the tone curve for powers 0.25 to 2, angles 0 to 80 degrees and
albedos 1, 0.5 and 0.2, the two are within 2 levels on a white face
square on and half a level elsewhere, and a matte grey sphere in the
viewer matches beauty.png to 0.1 levels on average. The display-space
renderer before it could be made to agree on one face angle only. A
point light is π·KEY·p·range² candela, and the two laws agree only far
off: at `range` an engine is twice as bright as beauty.png and at half
of it five times; with glTF's cutoff the two cross at about 1.8 ranges,
the engine is 0.8 of beauty.png at two and a third at two and a half,
and dark at three, where beauty.png keeps a tenth. glTF's `range` is
that cutoff, written as three times the program's (`GLB_RANGE_CUTOFF`).
A point light with no range has the beauty render's, half the model's
longest side, in the GLB too (it was 2 units, which lit a GLB
differently from its picture). Colours go from sRGB to linear. The
apparent size (soft shadows, a mirror's softbox) has no glTF counterpart
and is left out. The cameras stay out of the GLB, since an engine
imports them as objects in the level; the viewer page has them.

The viewer's Scene mode departs from glTF on purpose, to show what
beauty.png shows. It replaces three.js's distance attenuation with
1 / (d² + range²), the range read back from the cutoff, so the GLB's
candela give exactly beauty.png's KEY·p·range² / (range² + d²): with the
inverse square the door's wall beside its torch came out 37 levels too
bright and its non-metal parts 36.8 levels off on average, and with the
emulation 1.0. And it shows a glow at GLOW times the GLB's emissive
strength, which is the glow alone, so the door's flame is 247, 201, 52
against beauty.png's 249, 201, 52 (each glowing material counted once:
three placed bulbs sharing one material first opened at 1.6³ times). An
engine importing the GLB uses glTF's inverse square and the emissive as
written, so the GLB stays standard glTF, and near a point light an
engine is brighter than the picture.

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
a volume a promise is made on, is held to the shape.

The support is split three ways (roadmap item 20). **Bridged** means what
prints without support with supports switched off: a level ceiling that
spans at most 16 mm to solid that stands on something on both sides. The
span is PrusaSlicer's: its stability check for a print with supports off
(SupportSpotsGenerator, `bridge_distance = 16.0f`) adds a support point
to a bridge that runs further unanchored. Hubs' 5 mm is a different
promise, the span under which a bridge shows no sag at all, and a slicer
with supports on fills bridges as well unless told not to (PrusaSlicer's
"Don't support bridges" defaults on, but Prusa's own printer profiles
set `dont_support_bridges: 0`), so the row gives the bridged volume apart
rather than leaving it out silently, and `support(part, span=0)` counts
it. The span is in millimetres through `set units`; a program without it
gets 16 units, a unit read as a millimetre, which is what the STL and the
Units row already say.

A slicer lays each bridge in one direction: PrusaSlicer's BridgeDetector
tries every 5 degrees and the bridge's own edges, keeps the lines whose
two ends land on the layer below, and picks the angle with the most
anchored length, ties within one line spacing going to the shorter
longest line. The research prototype instead gave each face its own
shortest span in any of eight directions. Emulating the detector on the
ceiling's layer (lines 0.45 mm apart) showed where that is wrong. An
L-shaped room's roof, arms 8 wide and 30 long, is crossed on the
diagonal: 966.7 mm of anchored line against 961.5 along an arm, the
longest line 11.8 mm (8 times the square root of 2) where along an arm it
would be 30. A ring of roof from 6 to 10 mm between a post and a wall
ties at every angle, and its longest line is the 16.4 mm chord past the
post, not the 4 mm across the ring; from 3 to 10 the chords reach 19.3.
So each connected, level ceiling here is crossed along one of four axes
45 degrees apart: the one whose lines are anchored at both ends under
the most of it, at any length, ties within a hundredth of its area going
to the shorter longest line; only then does the span say which faces are
bridged. The detector does not know the span, so the span cannot choose
the direction. A bay roofed over, walled on both sides and at the back,
18 wide and 30 deep, is crossed the short way (1235 mm of anchored line
against 849 on a diagonal, whose lines run out of the open front), every
line 18.4 mm, and none of it is bridged; taking instead the axis that
spans the most within 16 mm read 754 of 6460 mm³ bridged, on a diagonal
cut short in the back corners. The L at a 10 mm span keeps its diagonal
and bridges only the corners at the arms' ends (12%), not one arm (30 to
60% by the other rule). At 16 the L reads all bridged with its longest
line 11.7, the 6-to-10 ring 2361 of 2398 mm³ bridged (the rest at the
chords' ends), and the 3-to-10 ring 1311 of 3418 mm³ still needing
support, where the per-face rule read both rings bridged radially. A
closed room ties on all four axes and is crossed the short way, so 18 by
18 none of it is bridged; the detector itself picks 60 degrees there, its
coverage spread over the angles only 7 mm of 744, within the noise of
where its lines fall.

A face is spanned along a line when, half a cell under the ceiling's own
height (one Newton step in the field from the samples that tested its
angle, since a face of a feature a cell or two across sits a fraction of
a cell off it), the line runs under the same ceiling, solid within a
third of a cell above it the whole way, to solid that stands on
something: solid a cell lower, straight down or a cell further on (a
wall, a post, a wall leaning out up to 45 degrees). Without those two
tests the prototype bridged a dome, a pitched roof open at its ends and
the top of a horizontal hole on their own undersides, which slope down
to meet the line; each layer of those is a ledge on the one below, and
the 45-degree rule already had them right. A slope closed at both ends
along its level is another matter: along that level its lines run under
the same ceiling to the walls, so a pitched roof between gables 10 or 14
apart, a ceiling falling at 30 degrees across a channel 10 wide and a
closed horizontal cavity 12 long read bridged. PrusaSlicer agrees: its
`remove_bridges_from_contacts` (SupportCommon.cpp), which "Don't support
bridges" runs, takes a straight overhanging perimeter whose two ends land
on the layer below as a bridge and removes it from the support, with no
limit on its length ("FIXME add supports at regular intervals to support
long bridges!"), and its stability check's LongBridge cause covers
"bridge and straight perimeter extrusion longer than the allowed length"
(SupportSpotsGenerator.hpp). An anchor is whatever the layer below holds
there, as the detector's anchors are the layer below's slices, so a 12
mm cantilever with a 1 mm lip under its end reads bridged from the wall
to the lip, and the lip's own 283 mm³ needs support. It also bridged all of round 11's stand's
word (0 of 55.6 mm³ left): the grooves closed at both ends are bridged
here (21.2 mm³), and 34.5 mm³ stays under the bars that open into a
stem's groove (the E's bars, the H's crossbar), ceilings tilted 25
degrees that each layer cantilevers from the one behind, which a slicer
with supports on fills. Posts 4, 8 and 14 mm apart under a slab are
bridged at 16 and posts 20 and 40 apart, a cantilever, holes 4 to 16 mm
across and a dome are not, as the prototype found for the posts.

A line from every face would read the same points over and over under a
big flat ceiling: a chest's lid at a 0.006 cell took 12 s. So the faces
of a region are taken in levels a tenth of a cell deep; the level faces
of a level of sixteen or more are read once on a lattice half a cell
apart at its height, over the region and two cells round it, and each
direction's reach is swept across the lattice from the far end; the
other faces of a level of eight or more (a chamfer's row, a tilted
groove's ceiling) march along lines they share, a sixteenth of a cell
across; the rest, the faces of a curved or displaced underside whose
lines leave the ceiling within a step or two, march on their own, the
rising way first and not at all along an axis where the ceiling rises
out of the band in one step. The chest then took 0.25 s. Lines run to
their anchors whatever their length, as the direction needs, and that
cost nothing measurable over stopping them at the span (the stand 47 and
49 ms, the tree 622 and 657, the rope 3.0 s either way). Over the 25
examples and the five print programs the pass took 8 ms to 3.0 s
(median 100 ms) against 2 ms to 1.4 s (median 50 ms) for round 11's,
whose column rays it still casts, and under the wall pass on 28 of them
(median 368 ms; the workshop and the rope within a tenth of theirs, on a
machine shared with other work); the dearest is the rope, whose twisted
sweep is the dearest field to read.

An island is a point overhang (Vanek, Galicia and Benes, 'Clever
Support', SGP 2014, section 4): a cone hanging tip down off a wall, its
sides 60 degrees from the horizontal, has no face past 45 degrees and
needs a column at its tip. The proposal's test, a welded vertex lower
than all its neighbours by a tolerance, has no tolerance that works:
dual contouring put a neighbour within 0.011 of a cell of a 50-degree
cone's tip at 64 cells and 0.63 cells under a 70-degree one, and real
tips read 0.01 to 0.63 cells across the angles and grids tried, inside
the noise. What does separate them is how far a minimum hangs before its
part of the surface joins something lower (its persistence in the merge
tree of height over the mesh, the vertices taken lowest first): the
cones' tips at 46 to 80 degrees at 128 and 200 cells hang 22 to 135
cells (at 64 most met the wall only along a line and meshed as a piece
of their own, which floats, an island too), a cube on its corner 12 to
39, the guitar's tuner buttons under their pegs 0.52 and 0.84, and the
mesher's dips on the tree's displaced bark, the trophy's rim text, the
nameplate and every other example and print program at most 0.16 cells;
only the rope, whose coiled turns press on each other and on the spool,
has minima between: 0.11 to 0.49 cells, and four past half a cell (0.50
to 4.3 cells, pits in the creases where the mesh dips, and one at its
cut end). An island hangs more than half a cell, faces down with the
solid above it, is off the plate, and is not at a corner of a patch of
faces needing support a cell or more in plan (a hanging ball's underside
has columns of its own); a floating piece's lowest point hangs the
piece's height, and a speck of under 32 vertices, which the Pieces row
already tells of, is none. Facing down is read on the faces two rings
round the vertex, and the field must fall going up from it. The
vertex's own faces will not do: at a sharp tip the mesher can fold its
last three faces to face up, and a cone at 80 degrees sunk 1 into a
wall lost its island at 112 to 176 cells that way (at 75 degrees, 96 and
112), where the ring beyond faces down by a quarter to two fifths of its
area. The field alone will not either: in the rope's creases, where the
mesh dips into a pit, the field a twentieth of a cell either side of the
vertex faced down and counted 28; read upward half a cell, and with the
ring, 4. Upward only, since round 11's cable, a piece floating 0.2 mm
over its groove's floor, has that floor under its lowest vertex. A keel
that runs level into a wall, its faces steeper than 45 degrees, joins
the wall at its own height and is no island: it is a line in the air,
not a point, and neither count catches it (tilted 5 degrees down away
from the wall, its far end is one). Its column is counted by height and place, not
volume: a point has no area, and the support tip that holds it is the
slicer's choice.

When the tallest column still stands on a sliver, a few faces needing
support under a cell in plan beside a face turned more than 60 degrees
from them, the row gives the sample-plane note's nudge: a cutter's face
laid exactly on the part's own leaves such a sliver, and half a cell's
move of the cutter clears it. Since the field test above, round 11's
coincident slot corner leaves no such column (its 7.9 mm² are skipped);
the note is for what the field test cannot tell from a real overhang.

Whether the model fits the bed is judged
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

## Noise and dither

The procedural patterns and `displace` run on gradient (Perlin) noise:
value noise, which they used first, has its random values at the lattice
points, so its blotches sit on a grid and read as patches on a skin and
bands in a marble's veins, at the coarse atlas above all. Gradient noise
has nothing to show at the lattice. Every computed colour is quantised
to 8 bits through a dither (interleaved gradient noise per pixel, a
triangular distribution one level wide), in the beauty render, the
sheets and the atlas, so a slow gradient becomes fine grain rather than
bands a dozen pixels wide; it is a function of the pixel position, so
renders stay reproducible byte for byte.

The beauty render's sampling is deterministic too. Its one estimator
with a pattern in it is the area light: a pixel's eight shadow rays are
placed by the pixel, the light and the subsample (rays.ts,
`diskPattern`: interleaved gradient noise over the pixel grid,
transposed so its residue does not line up with the dither's, an R2
lattice for the radii and an integer hash of the light and the
subsample). The glossy rays are one fixed pattern for every pixel. There
is no `Math.random` and no clock anywhere in the render, so an unchanged
program draws the same bytes on every run (and on any number of threads,
see Threads), which is what lets CI compare the committed renders with a
fresh regeneration.

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
(nine calls, paid only by a material that wears, and a tenth for a worn
metal's thinness, below) and exact for the level set of any field whose
sign is right: the Laplacian less the second derivative along the
normal, over the gradient's length. The Laplacian alone is what the
roadmap proposed, and it is right only for a true distance: a smooth
union, a loft, a twist or a non-uniform scale bends the field off the
surface, and that bending read as curvature (12 to 24% of the value in a
fillet). The probe is 1.2% of the model's longest side, about one and a
half cells at the default grid, so the worn band is a look rather than a
resolution and a quick pass shows the band the full render will. It
is +1 on a sharp convex edge, -1 in a crease and h/R on a sphere;
wear's threshold falls as the wear rises, so more of the surface counts
as an edge.

On a metal the worn band is rubbed to satin and broken into scuffs; on a
non-metal it is what it was, a lighter, smoother edge. The band used to
be rubbed through to bare polished metal wherever it reached (iron's
0.20 linear reflectance to 0.59, the lantern's roughness 0.55 to 0.31),
and a part thinner than about two probes is all band: the lantern's bars
read about 0.7 all round, so every bar, the ring and most of each post
were bare polished iron, and the blind check read the frame as "bright,
silvery polished steel/chrome with large rust patches", where the old
renderer's greyer draw had read right. The physically based render drew
what it was given. Three things answer it, prototyped alone and together
and judged on the lantern and the door. Satin: a hand or a cloth rubs
the dark skin off the high points and leaves it in the scratches, so at
a pixel's scale rubbed iron is a mix, halfway to bare (0.37 linear,
where bare iron is 0.56) with at most a quarter of its roughness gone
(the lantern's 0.55 to 0.44, a blurred sheen); polish is what a file
leaves, not use. Alone it left the ring and the bars an even grey with
their rust rubbed off: satin steel. Scuffs: what a texturing tool's edge
wear does (Substance's Metal Edge Wear: curvature broken by a grunge
noise), a fractal noise two probes across in the paint frame,
thresholded to cover a share of the band that grows with its strength
and the wear, about three fifths of a sharp edge at wear 0.45, so an
edge reads as a broken, chipped line, and the scuffs move with their
part (the door's knocker in its poses). The band is the field's, in the
model's units, and the noise the paint frame's, so a part scaled after
painting scales its scuffs and not its band; measuring the frame's scale
at every pixel would cost two more `hit` calls, as the bump's slope
does, and no worn part in the examples, the dogfood or the libraries
is scaled after painting. Alone the scuffs left the bars three fifths
rubbed. Thinness: one more call to `dist`, two probes in along
the normal, which is out the other side of a part thinner than about two
probes and still inside a thick part's edge (a wedge's inside goes on,
however sharp); a thin part's share is about 30% (a quarter of the
lantern's bar is rubbed lighter), near the fifth of a round bar that a
line of contact a probe wide would rub. Together the bars are dark iron
and rust with lighter rubbed patches, a box's edge a broken lighter
line, and no part of a worn metal is rubbed whole. The baker reads the
same thinness and draws the same scuffs, so the GLB's maps carry them.
The cost is that call and three of the noise per worn metal sample, 9
calls to 10, between nothing (the lantern's iron) and a fifth (the
door's) of a worn sample's finish, and no render got slower. Four
interleaved runs each at 384 pixels on two threads, measured twice on a
shared machine, took the lantern from 2.13 and 1.90 s to 1.90 and 1.69,
the door's hero shot from 3.79 and 3.22 s to 3.31 and 3.30, its iron
shot from 5.25 and 5.21 s to 4.74 and 4.76 and its torch shot from 2.64
and 2.70 s to 2.63 and 2.44: polished iron at 0.31 took four traced
rays a pixel, satin at 0.44 takes one and the unrubbed iron one or none.
The GLB's bake took the same within its noise (the lantern 4.6 s and
4.4, the door 21.0 and 22.0, two runs each).

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

`viewer.html`'s Studio mode gives three.js a room environment, because a
metal is mostly what it reflects: without one the lantern's bare iron
rendered near black in headless Chromium, and a metallic-roughness map
had nothing to vary. Its Scene mode reflects the beauty render's own sky
(see The viewer).

## The language

Designed for a model to write, not a person to type: one statement per
line, everything named, arguments by name where the order is not obvious,
degrees everywhere, `|` for "then", and errors that say the line, the
function, the parameter and the usage. Overloads on the first argument's
kind (a shape or a profile) keep one vocabulary for 2D and 3D. The builtin
table is the reference: the interpreter binds from it and `aixle doc`
prints it, so documentation cannot drift from behaviour. `aixle doc
sweep` prints the one entry, cut from that same text, where the whole
reference is some 930 lines (an argument that was not a library used
to be ignored and all of it printed); a name it does not have gets the
names that hold it or are a few edits from it (`cylnder`: cylinder),
on the failure. Retrieved documentation helps a model write code for a
library it does not know (DocPrompting, ICLR 2023), though Aixle's
fits in its context whole.

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

## The serif face

Serifs are added by rule, not drawn: a slab across every free end of a
stroke that stops on a guide line and is not running along it. Junctions
(a crossbar meeting a stem) and curved terminals get none. That gives the
sans skeleton a second voice at no authoring cost, and the plate of every
glyph was rendered and read to check it.

## The viewer

`viewer.html` embeds the GLB as base64 so it opens from disk with no
server, and loads three.js from a CDN, pinned to 0.187.0
(`THREE_VERSION` in viewer.ts), so it needs a network connection once.
That release prefilters each level of an environment with a true GGX
lobe, as the beauty render's maps are; it also removed the soft PCF
shadow map and deprecated the Clock the page used, so the page takes the
plain PCF shadow map and a Timer. It exists for people; an agent
verifies from the PNGs. With animations it grows a bar along the bottom:
loop, speed, a scrub bar that pauses the clip at a moment, and a button
that plays every clip once in turn, so a person can check a rig's timing
without a second tool. The page keeps its own paused and finished flags
because three.js's action reports a clip that ran to its end as paused.

Both of its modes end on beauty.png's tone curve (see Light in linear
units, and one curve), so a base colour lit to unit light shows as
itself and highlights roll off instead of clipping. The Studio mode is
the page's own, for judging the maps: a grey backdrop, three.js's room
environment for the metals to reflect, a hemisphere light and a white
key, calibrated together (`STUDIO` in viewer.ts: the room at 0.4, the
hemisphere at 0.1, the key at 1.2 lux) in headless Chromium on a plate
of the presets, every tile turned square to the key. A white face turned
to the key comes to 1.1 in linear light, its Fresnel included, one
turned away to 0.37 and one facing up to 0.94; the 26 solid non-metal
presets show their base colours to within 1.6 levels on average in every
channel, and 4.1 levels tile by tile, the darkest channels lowest, since
a key brings none of the Fresnel lift from all round that Neutral's toe
expects.

The Scene mode is the program's, what beauty.png shows drawn from the
export (round 11: a night scene lit by a torch was shown in a daylight
studio). Its environment is the beauty render's own sky, the
reflections' map (FILTERED, with the studio's dark side and its cards)
as a 128 × 64 lat-long of linear half floats, 64 KB of the page, through
three.js's prefilter at the render's intensity E. Diffuse surfaces are
lit from the sky's spherical harmonics, as the beauty render lights
them, and not from that map, whose cards would light them two to three
times over (a 0.8 grey's shaded side from 128 levels to 178). The lights
are the GLB's own, with beauty.png's point-light law and glow (see
Lights in the export), or the beauty render's one key when the program
declares none; the floor is the albedo the beauty render solves for its
open floor, reflecting nothing and fading into the horizon from one
reach to four as in beauty.png; the backdrop is the sky's display
colours; and each named camera is a button, with one more that frames
the page exactly as beauty.png. The page opens in the scene when the
program declares lights or a sky, from `set camera`'s shot. Read in
headless Chromium against beauty.png at its framing, the non-metal parts
differ by 2.3 levels on average on the medal, 1.0 on the door and 4.2 on
round 10's ring at sunset; the lantern's 7.7 is all its candle inside
the cage (17 to 29 levels brighter), which beauty.png darkens by the
field's occlusion.

What the page cannot show is what the GLB does not carry or three.js
does not do: the field's occlusion and cavity term (there is no
occlusion map, so the medal's lettering barely reads and the candle is
bright), soft shadows from lights with a size (shadow maps are hard, so
the door's torch bracket throws a large dark shadow that beauty.png's
sphere of light dissolves), the model reflected in itself, bloom, glass
(which stays out of the GLB), and the sun's or moon's disc and the stars
in the backdrop. Its far floor fades to the one horizon colour
beauty.png's shot looks towards, so orbiting towards a sunset's sun
leaves the far edge darker than the picture would.

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

## Placing by contact

An anchor needs the contact point known; most contacts are not (a book
leaning on its neighbour touches where its corner happens to meet it).
`rest` and `lean` (`src/sdf/measure.ts`) search a one-parameter rigid
motion, a move along a direction or a turn about a line, for the first
parameter at which the part meets `on`, and return `move` or a turn
about the pivot, so anchors ride along as they do for any transform.
The search has two halves. A coarse one traces points of both surfaces
along the motion through the other's field (sphere tracing; where a
point slides along a face, which pins the field at zero, a short probe
ahead says whether it is going in and then a step of a 48th of the part
keeps it moving, but only while the probe does not find it closing on
the surface: a point coming at a thin sheet at a slant would step
through it), seeds the small leaves of each shape at their own
scale (a bowl's tab, a hook's lip: a lattice over the whole steps past
them), and refines around the earliest meetings. A fine one reads
`clearance()`, which is exact near a touch, to settle the contact the
seeds can only bracket, by regula falsi on the leaf of `on` the part is
pressed into: read whole, a union's clearance is its nearest touch, and
the shelf a book slides along reads zero all the way. Touching is a
clearance within a ten-millionth of the part's size of zero, and the
search ends on the near side, within a millionth. When no seed meets
(two crossed wires), the search steps on `clearance()` alone, each step
a lower bound on the gap. All of it runs on the part and `on` scaled by
the power of two that brings the part to a size between 0.7 and 1.4,
because `clearance()` and the slide onto a surface under it work to
fixed tolerances (a gradient step of 1e-4, a hundredth of a part a
centimetre across in metres). A power of two scales every reading
exactly, so a model built at twice or half the size places the same to
the bit. The roadmap's item 16
has the measurements and the decisions (sink 0, an error for no contact,
backing out of a start inside, the right-handed turn).

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
