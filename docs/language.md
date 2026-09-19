# The Aixle language

A `.aix` file is a list of statements, one per line, read top to bottom.
Every assignment is a step; steps build on earlier steps by name. The file
ends by showing one shape, or the last shape assigned is the output.

[`reference.md`](reference.md) lists every function with its signature.
This document is the language around them.

## Coordinates and units

- Right-handed, **y up**. `x` to the right, `z` towards the viewer in the
  front view. `ground()` rests a shape on `y = 0`.
- Units are unitless; pick one (metres, centimetres, "one unit is a brick")
  and stay with it. The renders draw grids in whole units.
- **Angles are degrees**, in `rotate`, `twist`, `bend` and in `sin`/`cos`.
- Every primitive is centred on the origin. Anything with an axis
  (cylinder, cone, capsule, prism, capsule) stands along y; a torus lies
  flat; a box's `w, h, d` are along x, y, z.

## Statements

```
name = expr                 # a step
def name(a, b=2) = expr     # a parametric part; call it like a builtin
for i in range(5) { ... }   # repeat the block; i is 0..4
show a, b                   # output these (several are unioned)
set grid 200                # a render setting from inside the file
assert width(m) < 5, "fits"  # a promise the model makes; check reports a failure
# a comment, or // a comment
```

A `def` body is one expression; it can span lines. A statement continues
onto the next line when the line ends with an operator or `=`, or the next
line starts with `+ - * / | &`; a blank line always ends a statement.
Inside parentheses line breaks never matter.

```
def chair() =
  box(0.9, 0.08, 0.9) | move(0, 0.9, 0)
  + (leg(0.9) | move(-0.38, 0, -0.38) | grid(2, 2, 0.76, 0.76))
```

Loops can rebuild the same name; the step keeps its last value:

```
teeth = empty()
for i in range(12) {
  teeth = teeth + (box(0.3, 0.5, 0.2) | move(0, 2, 0) | rotate(z = i * 30))
}
```

`for` iterates a list: `range(n)`, `range(a, b)`, `range(a, b, step)`, or a
literal like `[0.5, 1, 2]`.

`for` also runs over any list, including one of strings, and a name
assigned inside the loop keeps its value between iterations, so a counter
is `i = i + 1`; `len(list)` is its length.

```
letters = ["C", "H", "A", "M", "P"]
word = empty()
i = 0
for c in letters {
  word = word + (extrude(text(c, 0.2), 0.05, "z") | move(i * 0.3, 0, 0))
  i = i + 1
}
```

## Values

| Kind | Made by | Combines with |
| --- | --- | --- |
| number | `1.5`, `2 * r + 1`, `sin(30)`, `a < b` (1 or 0) | `+ - * / % ^`, unary `-`, `< > <= >= == !=` |
| string | `"wood"`, `"#a0522d"`, `"x"` | material and axis arguments; `+` joins |
| list | `[1, 2, 3]`, `range(4)` | `for`, `polygon`, `len`, `list[i]` (0-based, `-1` is the last), `+` joins; a path may nest points: `[hip, knee]` with each a `[x, y, z]` |
| shape | `box(...)`, `a + b`, `a \| move(...)` | `+` union, `-` difference, `&` intersection |
| profile (2D) | `circle(...)`, `rect(...)`, `polygon(...)` | same operators; `extrude`, `revolve` make it a shape |
| material | `"oak"`, `material("#c04020", "stripes")` | `paint` |

Numbers and shapes share `+` and `-`; the interpreter tells them apart by
what is on either side. A 2D profile and a 3D shape cannot be combined; the
error says to extrude or revolve first.

## Calls and pipelines

Arguments are positional, by name, or mixed: `cylinder(1, 2)`,
`cylinder(r=1, h=2)`, `box(2, 1, round=0.1)`. Defaults are in the reference.

`a | f(x, y)` means `f(a, x, y)`: the shape flows left to right through its
modifiers. `|` binds tighter than `+ - &`, so

```
base + cap | move(0, 1, 0)      # base + (cap moved up)
(base + cap) | move(0, 1, 0)    # both moved up
```

Precedence, loosest to tightest: `< > <= >= == !=`, then `+ -`, then
`&`, then `* / %`, then unary `-`, then `^`, then `|`. Parentheses when
in doubt. A comparison is a number, 1 or 0, so `assert` can test it and
`min`/`max` can weigh it; `==` on numbers is exact, so compare a measured
size with `<` and `>` and a tolerance, not `==`.

## Building shapes

**Primitives**: `box`, `sphere`, `cylinder`, `cone`, `capsule`, `torus`,
`ellipsoid`, `octahedron`, `prism`, `empty`. `box` and `cylinder` take
`round=` for soft edges.

**Booleans**: `a + b`, `a - b`, `a & b`. The function forms take a blend
radius: `union(a, b, k=0.4)` melts the join; `difference(a, b, k=0.1)`
fillets the cut. Cut surfaces keep the material of the shape being cut.

**Transforms**: `move(x, y, z)`, `rotate(x=, y=, z=)` (about the origin, x
then y then z, right-handed: a positive `x` angle turns +y towards +z, so
`rotate(x=-15)` leans a backrest's top towards -z; a positive `y` angle
turns +z towards +x; a positive `z` angle turns +x towards +y), `scale(s)`
or `scale(x, y, z)`, `mirror("x")` (keeps both halves: model one arm,
mirror it), `flip("x")` (reflects only), `ground()`, `center()`.

Transforms are about the origin, so the order matters: build a part at the
origin, rotate it, then move it into place.

**Anchors**: `anchor(shape, "name", x, y, z)` names a point on a part in
the part's own frame, and every transform, warp and posed joint above it
carries the point along, so the point is where the part is. `at(shape,
"name")` is that point as `[x, y, z]`, and `attach(part, "a", target,
"b")` moves `part` so its anchor `a` lands on the target's anchor `b`:
a placement with no numbers. Every shape also answers to the free
anchors `centre`, `top`, `bottom`, `front`, `back`, `left` and `right`
(its box's face centres, so `centre` of a boom is the middle of its
box, not its end: anchor the end), so `lamp | attach("bottom", arm, "tip")` sets a
lamp on the end of an arm. Rotate a part first, then attach it; the
anchors turn with it. A union keeps every part's anchors (the first part
wins a repeated name), a cut keeps the first shape's, and `check` prints
a step's named anchors under its box. In a pose, `at()` on a joint's
subtree is the posed point, which is how a member between two moving
bodies finds its ends (see the cylinder under Scenes, joints and poses).

```
post = cylinder(0.08, 1) | anchor("top", 0, 0.5, 0) | move(0, 0.5, 0)
arm = box(1, 0.2, 0.2) | anchor("root", -0.5, 0, 0) | anchor("tip", 0.5, 0, 0)
arm2 = arm | rotate(z=30) | attach("root", post, "top")   # root lands on the post's top
lamp = sphere(0.15) | attach("bottom", arm2, "tip")        # and the lamp on the arm's tip
rod = tube(0.05, [at(post, "top"), at(arm2, "tip")])       # a list is a point
```

**Modifiers**: `round(r)` grows the surface outward and rounds edges;
`offset(r)` the same, negative to shrink; `shell(t)` hollows leaving a wall
`t` thick (then subtract something to make an opening); `twist(deg)` per
unit of height; `bend(deg)` per unit along x; `displace(amp, size)`
roughens with noise.

**Repetition**: `array(n, dx, dy, dz)` copies in a line, `grid(nx, nz, dx,
dz)` on the ground, `ring(n, radius)` around y (each copy is first pushed
out along +x by `radius`, then turned). These are real copies, so a rotated
copy of a box is exactly a rotated box.

**Bounds** are boxes: exact for primitives and unions, loose after a cut
(`a - b` keeps a's box however much was removed), a rotation or a twist;
`a & b` tightens to the overlap, which is the way to trim a bounding box
after a big cut. `check` prints every step's box; the report also gives
the surface's true extent from the mesh. Queries read the box:
`top(s)`, `bottom(s)`, `width(s)`, `tall(s)`, `depth(s)`; and
`height(s, x, z)` marches down to the real surface above a point, so a
stone can be set on a rough rock: `stone | move(1, height(rock, 1, 2), 2)`.

**2D profiles** live in the x/y plane: `circle`, `rect`, `ellipse`, `ngon`,
`star`, `polygon(x1,y1, x2,y2, ...)` (either winding). They take the same booleans, `move(x,
y)`, `rotate(deg)`, `scale`, `mirror`, `round`, `offset`, `shell`. Then:

- `revolve(profile)` spins it around y; the profile's x is the radius, so
  draw it on `x >= 0`. A vase is one polygon and one `revolve`.
  `revolve(profile, angle=180)` sweeps only that far, from +z towards +x,
  with flat ends: an arch is a half revolve of a circle laid on its side.
- `extrude(profile, h)` lays the profile flat (its x along x, its y along
  -z) and thickens it `h` up, centred on y = 0; `extrude(profile, h, "z")`
  stands it facing the front (x along x, y along y, thickness along z);
  `extrude(profile, h, "x")` stands it facing +x (x along -z, y along y),
  which is the one for a side profile such as a chair's end frame; since
  the profile's x runs along -z, a side profile drawn with its front on
  the right comes out facing -z, and `| flip("z")` turns it to face +z
  (measured by an agent on an excavator's counterweight).

**Paths**: `tube(r, [x,y,z, x,y,z, ...])` is a round tube along the
points with rounded joins and hemispherical ends that reach `r` past
each end point (`cap="flat"` cuts them flat at the points); `sweep(profile, [points])` carries a 2D profile
along them (its x across the path, its y as near world up as the path
allows; on a vertical run, y points to -z); `loft(a, b, h)` blends from
profile `a` at the bottom to `b` at the top over height `h`, centred on
y = 0 like `extrude` (so from y = -h/2 to +h/2; an earlier version of
this page said 0 to h, and a hull was built on that until `check` said
otherwise), each laid flat (its x along x, its y along -z), so
`loft(rect(1.5, 1.9), rect(2, 2.5), 0.5)` is a skirt 0.5 tall whose
second dimension runs along z. Both path
functions take `smooth=n` to curve the path through the points; a handle is
four points and `smooth=6`. A hollow spout is one tube minus a thinner one
on the same path. `taper=` scales the end relative to the start (a horn,
a tapering tail) and `sweep` also takes `twist=` degrees over the whole
path, so three circles swept along `helix(r, h, turns)` with
`twist = 360 * turns` is a rope. `helix()`, `arc(r, from, to)` and
`spline(points)` make point lists (a helix starts at `(r, 0, 0)` and rises
from y = 0 to `h`, an arc lies on y = 0; move the result afterwards);
`spline` is the one to reach for on a curve: it passes through the points and subdivides until no piece turns
more than three degrees, so the sweep shows no facets. Any list of
numbers works, including one built in a loop. A tapered tube along a
smoothed polyline is a chain of round cones, and where two meet at an
angle their surfaces cross in a ring thinner than any cell, so a bent,
tapered branch leaves open edges at every join (measured: 158 on four
branches); `tube(r, curve([...]), taper=)` has no joins, so use the
exact curve for anything tapered that bends.

**Exact curves**: `bezier([x,y,z, ...])` takes cubic Bezier control
points (an anchor, then two handles and an anchor per piece: 4, 7, 10, ...
points) and `curve([x,y,z, ...])` passes through its points with the same
shape `spline` draws; either goes to `tube(r, c)` or `sweep(profile, c,
twist=, taper=)` in place of the point list. The surface is then the true
offset of the curve, found by the nearest point on it for every sample,
so a scroll or a handle has no facets at any grid; the cost per piece is
about that of a spline's. A `spline` is still fine for anything gentle.

**Text**: `text("Aixle", size=1, weight=0.15, align="center")` is a 2D
profile from a built-in single-stroke font (upper and lower case, digits,
punctuation), laid out on the baseline. `face="serif"` adds slab serifs
to the same letters and sets them a little wider, for a nameplate or a
title; the default face is `"sans"`. A line of n characters is about
0.8 × n × size wide (0.93 with serifs), so 12 characters at size 0.36
need 3.5 units; `check` prints the exact box. Lowercase needs size at
least three times the weight or the counters (the gaps inside e, a, o)
close up; `check` warns when they are under a cell. The space between
neighbouring letters is a gap too (about a fifth of the size in sans,
less with serifs, plus `spacing=`, less the weight), and it is the one
that goes first on small serif lettering: `spacing=` opens it. Judge lettering with
`--focus` on the step: at a whole model's cell a 0.05 stroke is a blob on
the sheet. Extrude it for raised lettering,
subtract an extrusion for engraving. `size` is the cap height, `weight`
the stroke width; keep `weight` above a grid cell or so (`check` warns
when it is not). The profile's box reaches half the weight past the
strokes, so the lettering stands `size` plus `weight` tall. `arc=r` bends the
text onto a circle of radius `r` centred on the origin, reading over the
top (or under the bottom with a negative radius): a coin's rim, a label
round a jar: extrude the text standing (`extrude(t, 0.1, "z")`) and
`wrap(r)` it round the jar's radius (see below).

**Bending and wrapping**: `bend(shape, degrees)` bends about z: the
shape's x axis becomes an arc of a circle of radius `57.3 / degrees`
centred at `(0, R)`, curving up by that many degrees per unit along x
(negative bends down), and a point at height y rides at radius `R - y`.
`wrap(shape, r)` bends about y instead: x goes round a cylinder of
radius `r`, with x = 0 landing on +z and reading left to right from the
front, and depth z riding at radius `r + z`. Both are exact, so the box
`check` prints is the bent shape's. A name round a cup's rim is
`extrude(text("CHAMPION", 0.2, align="center"), 0.06, "z") | wrap(1.3) |
move(0, 4.3, 0)`; it spans `57.3 × width / r` degrees of the cylinder, so
keep that under the angle between the handles; a curved bench seat is a
box bent by a few degrees. Where a point lands: `wrap(r)` takes `(x, y,
z)` to `((r + z) sin(x / r), y, (r + z) cos(x / r))`, and `bend`'s arc
is `(R - y) sin(x / R)` across and `R - (R - y) cos(x / R)` up, so an
edge that must stay on an axis (a sail's luff on its mast) is placed
from those, or anchored and read with `at()` after the warp.

**Import**: `import("part.obj")` or a `.glb`, relative to the program's
folder, makes an existing mesh a shape: it is sampled into a distance
field (`resolution=` cells on its longest side, default 96), so it can be
cut, blended, hollowed and painted like anything else. `size=` scales its
longest side to that many units. Closed meshes work; an open mesh has no
inside, and `check` says so. Positions and triangles only: the mesh's
materials are not read, and `resolution` is the sampling of the import,
separate from the render grid. Sampling a large mesh takes tens of
seconds, and minutes for a scene at resolution 300, and `check` and
`render` each do it. A mesh of overlapping closed shells (the tool's own
GLB of a scene, where objects are sunk into each other) imports as one
solid: the sign is the winding count of crossings, not their parity. The import's own detail is limited by its
resolution: anything in the mesh thinner than about 1.2 of its sampling
cell is gone whatever the render grid, and `check` warns with the
`resolution=` that matches the render's cell when the import's is
coarser, so a fine mesh wants `resolution=160` or so.

## Libraries

`use "parts/hardware.aix"` brings a library's defs and constants in
under a prefix, `hardware.hex_bolt(0.1, 0.6)`; `use "std/furniture" as
f` picks the name, and `std/` is the set shipped with the tool:
`std/hardware` (bolts, nuts, washers, screws, chains, handles),
`std/furniture` (a table, a chair, a stool, a bench, a shelf) and
`std/plants` (a potted plant, a bush, a tree, grass). A path is relative
to the program using it, `.aix` may be left off, and `aixle doc
std/furniture.aix` prints what a library offers: each def with its
parameters and defaults and the comment above it. Every shipped part is
built at the origin standing on y = 0, facing +z, so it is placed with
`move` or `attach` like anything else:

```
use "std/furniture" as f
use "std/hardware"
desk = f.table(1.6, 0.8, 0.75)
bolt = hardware.hex_bolt(0.05, 0.3)
corner = bolt | move(0.7, 0.75, 0.3)
model = desk + corner + (f.chair() | move(0, 0, 0.7))
```

A library runs on its own: its defs see the library's own helpers and
constants (and its own `use`s), never the caller's names, so a library
cannot be broken by what a program calls things; its shapes stay its
own (a library's `show` is its preview when rendered by itself, and
costs the caller nothing); its materials and numbers are exported with
its defs. To write one, put `def`s in a file with a comment line above
each, a comment block at the top saying the conventions (where the
origin is, which way is front, what the units are), and a `show` of a
plate of every part so `aixle render` on the file is its test. `check`
lists what a program uses and `explain` ends with it. A part's slats,
rods and walls carry their thickness into the scene, so `check` warns
when a used part has a member thinner than the scene's cell (a bench's
0.03 slats under a 0.039 cell), at the step that placed it; the fix is
the scene's grid, or a bigger part.

## Scenes, joints and poses

`scene a, b, c` outputs several named objects instead of one shape: the
sheet shows them together, and the GLB has a node per object (the OBJ a
group). `place(shape, [x,y,z,yaw, x,y,z,yaw, ...])` puts copies of a shape
at each position and yaw (degrees about y; `fields=5` adds a scale per
copy): the render is the union, the export is one mesh with a node per
copy, so a forest costs one tree. A placed set keeps its copies' nodes
wherever it sits: joined to a board with `+`, inside a joint's part, or
as a scene object of its own (round 6: joined by `+`, an army became one
mesh). `--focus pawns_3` frames the third copy of a placed set on its
own. A scene's report has, under Assembly, a row per object (a placed
set once, for its base): watertight, pieces, stands, overhangs, since
the rows above are for the fused union, in which thirty-two pieces
resting on their board are one piece.

`ground()` moves one shape, so in a `scene` it moves that object alone
and the others stay where their numbers put them: ground the whole
scene's parts by the same amount, or cut them at y = 0 (a box
subtracted below the floor), rather than grounding one object.

`joint(part, "elbow", x, y, z)` makes a part turn about a pivot. Build the
part in place, declare the joint at its world pivot, then combine it with
`+` and `paint`; a joint nested inside another part's joint turns with it,
and its angles are relative to its parent: a stick at `-45` on a boom at
`35` lies at `-10` in the world. Joint names must be unique.
`joint(fork, "steer", x, y, z, axis=[cos(72), sin(72), 0])` turns about
one axis through the pivot instead, for a raked steering column, a
slanted hinge or a tilted rotor: a pose then gives it one angle
(`steer=25`), `angle("steer")[0]` reads it, and the GLB animation turns
about that axis rather than through an Euler triple.
`pose("reach", shoulder=[0, 0, 25], elbow=[0, 0, -40])` names a set of
angles (degrees about x, then y, then z; unnamed joints rest);
`animation("wave", ["rest", "reach", "rest"], seconds=2)` strings poses
into evenly spaced keyframes. Every pose is drawn on `poses.png`, every
animation on `anim_<name>.png`, and the GLB carries the joints as nodes
with the animations as glTF channels, which the viewer page plays. `set
pose reach` (or `--pose reach` on the command line) makes the sheet, the
views, the slices and the beauty render show that pose, and `check --pose
reach` prints every step's size in it. The report and the STL describe
the model as shown, posed if a pose is set; the GLB and the OBJ are
always at rest, with the joints as nodes. The
thumbnails on `poses.png` are meshed coarsely, so judge a pose that
matters at full size with `set pose`.

A pose is applied by evaluating the program again with the angles, so
anything computed from a joint's shape (its bounds, a `ground()`) follows
the pose, and so does any number you compute from the angles:
`angle("boom")` is the current pose's `[x, y, z]` for that joint (zeros
at rest), so a member between two moving bodies (a hydraulic cylinder, a
strut) is a `tube(r, [a, b])` whose end points you work out from
`angle(...)` with `sin` and `cos`, rebuilt for every pose:

```
b = angle("boom")[0]
tip = [0, 1 + 3 * cos(b), 3 * sin(b)]
ram = tube(0.08, [0, 0.5, 0.4, tip[0], tip[1], tip[2]]) | paint("steel")
```

`angle()` may be read anywhere in the program, before or after the
`joint(...)` it names: it is the pose's number, not the joint's. A
telescoping cylinder is the pattern in full: the barrel is a tube in the
parent's frame from its base pin towards the rod's eye, the rod a tube in
the child's frame from its eye back towards the barrel, and the rod's
visible length is the pin-to-pin distance less the barrel's, so the two
can never gap or overshoot. Both pins are lists, and `surface(shape, x,
y, z)` gives the point on a curved body nearest to a guess when a foot
must sit on it:

```
def turn(p, c, a) = [c[0] + (p[0] - c[0]) * cos(a) - (p[1] - c[1]) * sin(a),
                     c[1] + (p[0] - c[0]) * sin(a) + (p[1] - c[1]) * cos(a)]
a = angle("boom")[0]
base = [0.2, 0.9]                       # barrel pin on the body (y, z)
eye = turn([1.6, 2.4], [0.4, 1.2], a)   # rod pin on the boom, turned about the boom's pivot
ram = sqrt((eye[0] - base[0]) ^ 2 + (eye[1] - base[1]) ^ 2)
barrel = tube(0.11, [0.35, base[0], base[1], 0.35, base[0] + (eye[0] - base[0]) * 1.2 / ram, base[1] + (eye[1] - base[1]) * 1.2 / ram], cap="flat")
```

With anchors the same cylinder needs no `turn`: anchor the barrel pin on
the body and the rod pin on the boom (`boom | anchor("eye", 1.6, 2.4,
0.35)`), and in each pose `at(boom_joint, "eye")` is the eye where the
pose put it, so `barrel = tube(0.11, [at(body, "pin"), at(boom_joint,
"eye")])` is the whole cylinder. The rod is the same tube from `eye` towards `base`, `ram - 1.2 + 0.3`
long, built inside the boom's joint so it turns with it. The cost is
that the GLB's animation moves only joints, so the exported cylinders do
not telescope; the sheets and the beauty render do. Six small joints, one
per barrel and rod, is the form to choose when the export matters.

`pose(...)` may be called
from a `def`, with its angles from the `def`'s parameters, so a set of
poses with a shared shape is one `def` and a line per pose. `check` prints number steps as well as shapes, so the
distances you compute are there to read.

## Materials

`hollow(shape, wall, x, y, z)` is `shell` with a drain hole at the point,
for printing: the void is open, so it is not counted as a cavity and
resin or support can escape; `model.stl` is written next to the OBJ and
GLB, the model as shown. `decal(shape, region, m)` paints only the surface inside `region`, adding
no geometry: a pupil on an eyeball, a mouth along a thin tube, a label on
a jar; `region` is any shape. A decal is a skin: the cross-sections show
the base material underneath, and a step used only as a region is not
geometry, so it gets no thin-part warning and is never named as a loose
piece. Patterns are laid out in the frame the part is painted in, along the
material's `axis` (y unless given): `stripes` are bands stacked along it
(`scale` wide), `wood` is boards laid side by side across it with the
grain running along it (lines a `scale` apart that drift, boards two and
a half scales wide with a dark seam between), `brick`
courses and `tiles` rows lie across it, `checker` and `dots` are cubic.
So stripes on a flat awning need either `material("red", "stripes",
"cream", scale=0.5, axis="x")` or the sheet painted standing and then
laid down; a rotation after painting turns the pattern with the part.
`paint(shape, m)` gives the whole shape one material; `m` is a preset name
(`"wood"`, `"brass"`, `"marble"`, see the reference), a colour (`"red"`,
`"#40e0ff"`), or `material(color, pattern, color2, scale, metal, rough)`.
A preset at another feature size is `material("granite", scale=0.4)`:
start from the preset, change only what is given. Pattern sizes are in
model units (the reference lists each preset's), so wood grain 0.25
apart suits a table and a 20-unit floor wants `scale=2`.
Patterns: solid, checker, stripes, wood, marble, noise, speckle, brick,
tiles, dots. `hsl(h, s, l)` and `rgb(r, g, b)` make colour strings.

Paint applies to everything inside the shape, so **paint parts before
combining them** when they should differ:

```
body = box(1.6, 2, 1) | paint("red")
eyes = mirror(sphere(0.15) | move(0.3, 1, 0.5), "x") | paint("#40e0ff")
robot = body + eyes
```

A pattern is anchored to the frame where `paint` was applied, so it moves
with the part: paint, then `move`.

## Settings

`set light_size 2.5` widens the key light in the beauty render (softer
shadows; 0.5 is a lamp); `set light_azimuth -40` and `set light_elevation
55` place it (azimuth about y, 0 from the front, 90 from +x; these are
the defaults, upper left, fixed in the world, not the camera); `set
ambient 2` lifts the sky and ground light for a shaded interior (0.5 is a
dark room); `set dof 1` adds depth of field there, blurring away from the
model's centre; the camera fits the model's box corners with a small
margin, and `set zoom 1.2` brings it closer, up to the point where the
box would touch the frame's edge and no further, so a zoom never crops
(`--zoom` on the command line). Several `decal`s on one shape are read
in order and the last one wins where regions overlap; a region should
reach a cell or two past the surface it means to paint, since a coarse
mesh's vertices stray out of a region that ends exactly at the surface
(measured: a cockpit floor read as antifouling on a quick sheet); it
may reach into the solid as far as it likes, since only the surface is
painted. A material with `glow=1` gives off its own light in every
render, unshadowed: a flame, a lamp, a screen. A material with `transmit` (the `glass`,
`amber` and `emerald` presets, or `material(color, transmit=0.8)`) is
refracted and reflected by the beauty render and drawn opaque everywhere
else. Glass shows what is behind it, not what is inside it: a lamp
unioned into a solid glass drum is part of one solid and only tints the
light, so make a lantern hollow (`shell`, or a tube minus a thinner one)
and put the lamp in the air inside. `set focus name` makes a close-up
of one step or object (`--focus` on the command line): every view is
framed on it, the model is clipped to that frame and re-extracted at the
frame's own cell so a lantern in a market is drawn with a lantern's
detail, the slices cut through it, and the beauty render is framed on it.
`--out DIR` puts a render somewhere other than `out/<name>/`, so a focus
render does not overwrite the main one. `set pose name` shows a pose. `set azimuth 60` and `set elevation 10` turn the perspective camera used
by the sheet, the turntable and the beauty render (the CLI's `--azimuth`
and `--elevation` override). `set grid N` sets the extraction resolution (cells along the longest side,
default 128; the CLI's `--grid` overrides). `set size N` sets the pixel size
of a view and of the beauty render (`--beauty-size` overrides the latter). `set slice_x 0.5` (and `slice_y`, `slice_z`) moves a
cross-section plane; a scene's default cut goes through its first
object, so list the one to cut first. `set beauty 1` always writes the ray-marched
`beauty.png` (the CLI's `--beauty` does it once). `set sharp 0` falls back
to rounded vertex placement if a sharp corner ever misbehaves. Edges are
creases: a vertex whose faces meet at more than 35 degrees (a box's edge,
a block standing on a cylinder, a cut) is split so each side shades and
exports with its own normal and its own material, in the sheets, the
viewer and the GLB; `set crease 60` splits only sharper corners, `set
crease 0` keeps one smooth normal per vertex for a sculpted model that
should read soft (`--crease` on the command line). `set texture
2048` sizes the baked texture atlas (`0` turns it off and the GLB carries
vertex colours instead). `set minecraft 16` also writes Minecraft Bedrock
geometry (`--minecraft` on the command line, with an optional pixel
count): the field is sampled at that many pixels per unit, a unit being
one block, every filled voxel is a pixel of solid, and the voxels are
merged into as few cuboids as they allow, a bone per scene object, each
cube face with its own window in `model.geo.png` painted from the
materials; `model.geo.json` is the geometry, identifier
`geometry.<name>`. A curved thing comes out stepped, which is what a
block model is; a mug at 16 is about 250 cubes, and `set minecraft 8` is
a chunkier, cheaper model. A part thinner than a voxel (a sixteenth of a
block at 16: a chair leg 0.04 across) is lost, and the render warns which;
geometry is always sixteen to the block, so `set minecraft 32` samples
twice as fine and writes cubes on half pixels, which the game accepts,
with a texel per voxel. `set roblox 1` (or `--roblox`) also writes
`model.roblox.glb` for Roblox Studio's 3D Importer: a unit is a stud, the
model is turned half a turn about y at its root so its +z front faces the
character's -Z, a single object is the one mesh a rigid accessory needs
under a node named `Handle`, a scene keeps a node per object, and every
anchor whose name ends in `Attachment` (`anchor(hat, "HatAttachment", 0,
0, 0)` at the point where the hat meets the head) becomes an empty node
named with the importer's `_Att` suffix for the Accessory Fitting Tool.
The report says whether the model fits that attachment's size limit at
the Normal body scale (a hat 1.87 × 2.5 × 1.87 studs, a face piece
1.87 × 1.25 × 1.25, a back piece 9.86 × 8.59 × 4.87), and decimates the
mesh to the budget: a rigid accessory's 4000 triangles when there is an
Attachment anchor (shared across the meshes of a jointed model, each
giving up the same share), a MeshPart's 10000 per mesh otherwise, by
quadric edge collapses that never cross a material seam or fold a face,
so a hat meshed at grid 96 goes out at 4000 with its brim, band and
crown. A jointed model exports its joints as nodes under `Handle` and
its animations as glTF clips, which is an animated rig for Studio
rather than a rigid accessory: `examples/roblox/hatchling.aix` is the
Minecraft repo's pet dragon rebuilt cube for cube as a shoulder pet,
with its Bedrock idle, flap and glide clips as poses and animations.
The report says what it was decimated from. `examples/roblox/` has a
hat, glasses, a backpack, wings, the hatchling, a café set, a lamp, a
plant and a sign; a Roblox accessory hangs on its attachment, so an accessory gets
no warning about standing. Bedrock draws geometry with x mirrored, so
cubes are authored at -x and the model stands in the game as it does on
the sheet, its +z front to the south, the block convention; an entity
faces north, so turn an entity model `rotate(y=180)` first. Joints are
not carried: the geometry is the rest pose.

## The fast loop

`aixle render model.aix --quick` renders the sheet only, at a small grid
(stepped up, to 128 at most, on a model whose parts are mostly thinner
than the small grid's cell), in a second or two; `--watch` re-renders on every save; `aixle diff a.aix
b.aix` draws two versions side by side, A on the left, for judging a
change. Use the full render for the final check: the quick grid drops
detail thinner than its cell, and the sheet says which steps it dropped.
When it dropped any, the pieces count and the footprint are not judged
on that sheet, since the dropped steps are often the joins or the feet; a bucket's teeth or a rail are
blobs or gone at a quick cell, so judge a working end at full grid, with
`--focus` on the step to spend the cells there.

## What the tool checks for you

`aixle check` prints every step's size and the warnings: shapes as their
box, 2D profiles as their box in the plane, numbers and lists of numbers
as their values. A step whose tree holds a rotation, a warp or a posed
joint gets a second `surface` line when the surface's own extent is
tighter than the box (a box after a rotation is the box of a turned box),
and with `--pose` a `posed` line says where the step ends up once the
joints above it have turned, since a part built at rest and turned by a
joint keeps its rest box. Both lines come from rays marched in from the
box's faces, so a plate thinner than the rays' spacing can slip between
them; the render's "Surface extent" row reads the mesh and does not. `aixle render`
also writes the warnings into `report.md` and counts them on the sheet's title bar.
Warnings cover: a shape computed but never assigned; a step that is not part
of the output; an empty output (a difference that removed everything, an
intersection that did not overlap); a model or part thinner than a grid
cell (the threshold is 1.2 cells: at that thickness the surface nets
still catch it, below it they may not; between 1.2 and 2 cells a tube
or a wall meshes but often not watertight, and the report names such
parts when the mesh has open edges; a rigging line wants about three
cells across to be clean, measured on a dinghy), including a `shell` wall, a
`tube`, a `sweep` profile or a `text` stroke inside a thick part (those
carry their own thickness, since a bounding box cannot see it); a
lettering counter or a slot under a cell (under half a cell it closes,
between half and one it survives but the mesh round it may not be
watertight); a union that paints over parts that already had materials,
or joins painted and unpainted parts; a program that both names a step
`top` and calls `top(...)`; a model in separate pieces (a part that
floats free) or with slivers left by a cut, each named by the innermost
step whose surface passes there, then its nearest named parent (open
edges are placed at an edge that is on the model, with the steps whose
surfaces meet there, exposed ones first; "in 'panel' twice, as 'a' and
'b'" when two placements of one step cross, "alone" when no other part is
within a cell, which is a crease of the step's own surface or the
mesher's noise at a few edges; and a cluster of edges all on one plane is called out as a face lying
exactly on a sample plane, which a nudge of a fraction of a cell cures);
a named step transformed alone on the right of a `+` (`a + b | move(...)`
moves b only, since `|` binds tighter; `(a + b) | move(...)` moves both,
and `+ sphere(0.2) | move(...)` is the ordinary way to place one); a cut
that removes almost nothing, a slot tangent to the surface it was meant
to mark (measured on a bishop's mitre), or a cutter whose box never
reaches the shape; a model
that would tip over, from its centre of mass and the footprint of its
base; and, as a note, a model that does not rest on `y = 0`. Two parts
count as joined when they overlap by about a cell in the field: parts
that only touch (a barrel resting on a beam's top face, a box on a
box) leave a seam that reads as an open edge or a second piece, so sink
one into the other by a cell or two, or blend them with `union(k=)`,
which also seals the void a tangency leaves. The converse holds too: a
part that reaches through a face by less than a cell (a tube's round
cap ending a hair past a plate, a hex head whose corners sit just above
a boss, a hub top just under a plank) or stops less than a cell short of
it (a stringer passing a leg with a cell of gap) leaves the same seam,
and no warning, since nothing there is thin: overlap by a cell or more,
or clear by a cell or more. When the mesh is not watertight the report
prints the three largest clusters of open edges, and `report.json`
lists every one under `watertight.clusters` (its position, its edge
count and the steps whose surfaces pass there). A focused render adds a
"Close-up watertight" row for the close-up's own finer mesh, with the
frame's clip faces left out. The report's Physics section has the numbers: mass at `set
density`, centre of mass, footprint, pieces, and how much of the surface
overhangs (faces down more than 45°, which a printer would need support
under).

### Assertions

```
assert pieces(model) == 1, "one printable piece"
assert clearance(handle, rim_text) > 0.05, "the handle clears the lettering"
assert tall(lamp) < 2.2
assert abs(width(seat) - 0.45) < 0.01, "the seat is 0.45 wide"
```

`assert test, "message"` is a promise the program makes about itself,
tested on every evaluation: `check` prints each failure with the two
sides of the comparison as they came out (`clearance(handle, rim_text) >
0.05 is 0.031 > 0.05: the handle clears the lettering`) and exits with a
failure, `render` counts a failure as a warning on the sheet, and the
report has an Asserts row and `report.json` every assert with its
result. The next agent to edit the program then learns what it broke
from the tool rather than from a picture, and a promise that lived only
in a report ("the handle must clear the rim text") lives in the program.
In a pose (`check --pose reach`) the asserts run in that pose, so a
clearance that must hold when a joint has turned is asserted with `set
pose` or `--pose`. A used library's asserts run with it and are reported
with the library's path.

The queries that make it useful: `pieces(shape, resolution=64)` is the
number of separate pieces the shape meshes into at that grid, as the
report's Pieces row counts them (it meshes the shape, so it costs a
moment; a whole scene wants the report instead); `clearance(a, b)` is
the smallest gap between two surfaces, negative by how deep they overlap,
zero when they touch, sampled from the fields at twelve points per side
of each shape's box and then tightened, so it is exact for parts that
face each other and can miss a feature narrower than a twelfth of the
part. Measure parts rather than the whole model: `clearance(handle,
body)`, not `clearance(handle, model)` (the handle is in the model, so
that is zero). The bound queries (`width`, `tall`, `depth`, `top`,
`bottom`, `height`) and the anchors (`at`) are the rest.

## Limits worth knowing

- Detail thinner than a grid cell disappears. The cell size is on the sheet
  (`CELL 0.03`); raise `--grid` for fine work, at a cubic cost. Edges and
  corners are exact (the vertex placement fits the tangent planes), so a
  box is a box at any grid; only features smaller than a cell go.
- Bounds are boxes and can be loose: a smooth `union(k=)` pads them by the
  blend, a `difference` keeps the left side's box, `twist` and `bend` swing
  a corner's radius. `check` prints bounds; the render's "Surface extent"
  row and `ground()` read the surface itself (rays from below), so they
  are not fooled.
- The sampling lattice starts a fraction of a cell off the model's box,
  so a face at a round coordinate (a plank's edge at x = 3.94, a base at
  y = 0.15) rarely sits exactly on a sample plane, where the extractor
  leaves open edges; a face that still does is called out in the
  watertight row. The perspective views and the beauty render fit the
  model's own points, so a long model on the diagonal fills its frame.
- `--focus` on a placed set frames its first copy, in world orientation
  (`--focus chairs_4` for another); a part that exists only through
  `array`, `ring` or `mirror` cannot be focused on by itself (its step's box is the original, at the origin,
  or the whole set); give one copy a name of its own next to the set, or
  use `place()` for the copies and `--focus name_3`. A def called inline
  (`plate = pawn() + rook()`) is a step with no name of its own: name
  the parts you will want to focus on or see blamed.
- The sheet, the views, the pose sheets and the animation strips draw
  glass (a material with `transmit`) on every other pixel, so what is
  behind it shows through a checker: a pendulum behind a glazed door is
  on the strip. The beauty render refracts it properly.
- The sheet and the views colour the mesh per vertex, so a pattern or a
  decal near the cell size looks blocky there (a 0.07 speckle at a 0.03
  cell reads as camouflage); the beauty render and the baked atlas sample
  the material exactly. Judge fine patterns in the beauty render.
- Non-uniform `scale`, `twist`, `bend` and `displace` distort distances; the
  surface is still right, but a `round` or smooth blend applied *after* them
  is approximate.
- Rotated shapes have conservative bounding boxes, so `ground()` and
  `center()` after a rotation can be off by a little.
- Sweeps follow polylines (smoothed or not): a tight bend needs a few more
  points; `curve` and `bezier` are exact.
- `a & b` and `a - b` keep a's material on every face, including the
  faces b made; paint the result to colour a cut face differently.
- A polygon's sharp tip is thinner than a cell near the point, at any
  grid, and meshes as an open edge there (measured: a clock's hands);
  `check` cannot see it, since a tip has no thickness to report. Blunt
  a tip to a cell's width, as a real hand or blade is.
- Two tubes meeting at one point (two shrouds at a masthead), or a line
  leaving a sheet at its corner, cross in a wedge thinner than any cell:
  give them a fitting to meet in (a tang, a sphere, a boss). The same
  wedge appears wherever two surfaces meet at a shallow angle (a cone hub
  under a canopy at 36 degrees) and where two tubes of equal radius cross
  (a bar through a ring's centre line: tangent at the saddle); bury one
  in the other by a cell, or give one a fitting. A tube ending inside a
  plate thinner than two cells is a sliver either way: run it through.
  A `curve()` bent to a radius tighter than its tube's crosses itself on
  the inside of the bend, and `check` says so at the step.
- `surface(shape, x, y, z)` slides to the nearest surface from the guess
  along the field, so a guess far from the face you mean can land on a
  nearer one (a keel rather than a bottom panel); guess within the part's
  thickness of the face, and on a `loft` or a blend, whose field is a
  bound rather than a distance, expect it close rather than exact.
- A `move` above a `joint` (`(boat + cradle) | ground()`) is carried into
  the export's joint nodes; a rotation or a scale above one cannot be,
  and the render warns: rotate or scale the part before the joint.
- Two thin parts that must stay separate (a clock's two hands, a lid
  and its rim) cannot overlap by a cell as the contact rule says: leave
  a gap of a cell or two between them and bridge it with a hub or a
  post, or they mesh as one part with open edges where they touch.
- The key light comes from above (elevation 55 by default) and does not
  reach far into an opening: an interior behind a door or a window is
  dark unless `set light_elevation` brings the light down, `set ambient`
  lifts the fill, or a `decal` gives the inner walls a lighter colour.
- A preset with overrides (`material("glass", transmit=0.95)`) is listed
  in the report as the preset's name with a star, `glass*`, unless it is
  assigned to a name, which it then takes.
- A cross-section draws the surface's outline a cell or so behind the cut
  plane as a thin line, so a plate just behind the plane shows as a dashed
  line across an opening that is open. Move the slice (`set slice_x`) or
  render a `--focus` close-up to be sure.
