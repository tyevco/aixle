# The Aixle language

A `.aix` file is a list of statements, one per line, run in order, top
to bottom. Every assignment is a step; steps build on earlier steps by
name, and a name can be read only below the line that assigns it (or the
`def` that defines it): `show` goes after the steps it shows, which is
why a file usually ends with it. Without a `show`, the last shape
assigned is the output. A name read above its line is an error that says
where it is assigned: `'lean' is not defined yet: it is assigned on line
12, after this line`.

[`reference.md`](reference.md) lists every function with its signature.
This document is the language around them.

## Coordinates and units

- Right-handed, **y up**. `x` to the right, `z` towards the viewer in the
  front view. `ground()` rests a shape on `y = 0`.
- Units are unitless; pick one (metres, centimetres, "one unit is a brick")
  and stay with it. The renders draw grids in whole units. For a print,
  `set units cm` (or `mm`, `m`, `in`) says which, and the exports and the
  report's Print section use it (see Settings).
- **Angles are degrees**, in `rotate`, `twist`, `bend` and in `sin`/`cos`.
- Every primitive is centred on the origin. Anything with an axis
  (cylinder, cone, capsule, prism, capsule) stands along y; a torus lies
  flat; a box's `w, h, d` are along x, y, z.

## Statements

```
name = expr                 # a step
def name(a, b=2) = expr     # a parametric part; call it like a builtin
def name(a) { ... return expr }   # a part with names and loops of its own
for i in range(5) { ... }   # repeat the block; i is 0..4
show a, b                   # output these (several are unioned)
set grid 200                # a render setting from inside the file
assert width(m) < 5, "fits"  # a promise the model makes; check reports a failure
# a comment, or // a comment
```

A `def` body is one expression, which can span lines, or a block in
braces. A statement continues onto the next line when the line ends with
an operator or `=`, or the next line starts with `+ - * / | &`; a blank
line always ends a statement. Inside parentheses line breaks never
matter.

```
def chair() =
  box(0.9, 0.08, 0.9) | move(0, 0.9, 0)
  + (leg(0.9) | move(-0.38, 0, -0.38) | grid(2, 2, 0.76, 0.76))
```

A block body is for a part that needs its own intermediates or a loop:
the book's cover, its pages and its bands all read `b.w`, `b.h` and
`b.d`, and a case's shelves are a `for`:

```
def book(b) {
  cover = box(b.w, b.h, b.d) | paint(b.color)
  bands = empty()
  for i in range(2) {
    bands = bands + (box(b.w + 0.01, 0.06, 0.02) | move(0, 0.3 + i * 0.4, b.d / 2))
  }
  assert width(cover) < 1, "a book is thinner than a unit"
  return cover + bands
}
```

The block holds assignments, `for` loops and `assert`s, and ends with
`return` and the value the def makes; `show`, `scene`, `set`, `use` and
`def` belong at the top level, and a line that computes a value and
assigns it to nothing is an error, as is a body whose last line is not
the `return` (`def book (line 3): its body ends on a value with no
return; write return cover + bands`) or a `return` inside a loop. The
names it assigns are the def's own, as its parameters are: they are not
steps (no thumbnail, no callout, no size in `check`), they are gone when
the call returns, and a step elsewhere with the same name is a different
thing. Otherwise a block sees what an expression body sees: its
parameters, and the file's (or the library's) defs and constants. An
`assert` in a block is judged on every call, and `check` says which call
each verdict is for: `assert (line 9, in book() called on line 40)
holds: ...`, the call's line being the program's statement that made it
(in a library's def the assert's own line is the library's, and the
line says so: `shelf_lib: assert (line 9, ...)`). A material assigned
to a name in a block takes that name (see Materials). A def calls
itself as any def does, up to the depth guard; with no conditional, a
def that calls itself always reaches it. `aixle fmt` puts the body two
in, as a loop's.

Loops can rebuild the same name; the step keeps its last value:

```
teeth = empty()
for i in range(12) {
  teeth = teeth + (box(0.3, 0.5, 0.2) | move(0, 2, 0) | rotate(z=i * 30))
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
| record | `{w: 0.9, h: 0.45, name: "seat"}`, `{...seat, h: 0.6}` | `seat.w`, `cfg.leg.r`, `legs[0].x`; in lists, as parameters and defaults |

Numbers and shapes share `+` and `-`; the interpreter tells them apart by
what is on either side. A 2D profile and a 3D shape cannot be combined; the
error says to extrude or revolve first.

**Records** name the numbers a part is made from, so a call says what each
one is rather than where it sits in a row of positions:

```
seat = {w: 0.9, h: 0.45, d: 0.8}
legs = [{x: 0.38, z: 0.33}, {x: -0.38, z: 0.33}, {x: 0.38, z: -0.33}, {x: -0.38, z: -0.33}]
def leg(p, h=seat.h) = cylinder(0.04, h) | move(p.x, h / 2, p.z)
frame = empty()
for p in legs { frame = frame + leg(p) }
tall = {...seat, h: 0.6}        # a copy with h changed; seat is as it was
```

A field holds any value: a number, a string, a list, a shape, a material,
a def, another record. A def in a field is called by its dotted name,
`r.f(1)`; one reached through an index or a call is named first
(`f = legs[0].f`, then `f(1)`). Reading a field that is not there is an error that
names the fields there are, and a key written twice in one record is an
error. A record never changes: `seat.h = 0.6` is an error that says to
write `seat = {...seat, h: 0.6}`. `...other` takes another record's
fields where it stands, and a later entry replaces an earlier one in its
place, so `{...seat, h: 0.6}` keeps the order and `{w: 1, h: 2, ...given}`
is defaults that `given` overrides. Entries may run over several lines.
`p.x` and `list[i]` bind tightest of all, after a call or an index too
(`dims().w`, `legs[0].x`); `p.0` is an error, since an item is read by its
index. A used library's name wins over a record of the same name, and
`check` warns whichever of the two came first.

A record of shapes is not a shape: `show parts` is an error, `show
parts.lid` shows that field, and the output is then the step the field
holds, so a record's other parts are still reported as unused. `check`
prints a record as it would be written (`seat = {w: 0.9, h: 0.45, d:
0.8}`), or, when it holds shapes or is too long for a line, a line per
field with a shape's box, as a step's would be. A value's numbers (a
number step, a list's, a record's) are printed to four significant
figures, as an assert's sides are, so `{bump: 0.002}` reads as written;
sizes and places keep two decimals.

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
`&`, then `* / %`, then unary `-`, then `^`, then `|`, then a field `.x`
or an index `[i]`. Parentheses when in doubt. A comparison is a number, 1 or 0, so `assert` can test it and
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
lamp on the end of an arm. That is face on face, a touch, which a fine
grid meshes as two pieces: `attach(..., sink=0.02)` pushes the part that
far into the target, along the line from its anchor to its own centre,
so the two overlap by a cell or two. Rotate a part first, then attach it; the
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
copy of a box is exactly a rotated box. Turning a part round y before the
ring turns it in place, which does nothing to a round part centred on the
axis: copies between another ring's copies come from turning the ring,
`pockets = pocket | ring(6, 0.7) | rotate(y=30)` beside `holes = hole |
ring(6, 0.7)` (a hub's pockets once landed on its holes as `pocket |
rotate(y=30) | ring(6, 0.7)`, and `check` now warns when a turn just
before a ring leaves the part as it was).

**Bounds** are boxes: exact for primitives and unions, loose after a cut
(`a - b` keeps a's box however much was removed), a rotation or a twist;
`a & b` tightens to the overlap, which is the way to trim a bounding box
after a big cut. `check` prints every step's box; the report also gives
the surface's true extent from the mesh. Queries read the box:
`top(s)`, `bottom(s)`, `width(s)`, `tall(s)`, `depth(s)`; and
`height(s, x, z)` marches down to the real surface above a point, so a
stone can be set on a rough rock: `stone | move(1, height(rock, 1, 2), 2)`.

**2D profiles** live in the x/y plane: `circle`, `rect`, `ellipse`, `ngon`,
`star`, `polygon(x1,y1, x2,y2, ...)` (either winding), and the smooth
outlines `curve2` and `bezier2` below. They take the same booleans, `move(x,
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

**Smooth profiles**: a polygon is straight between its points, so a vase,
a bottle or a guitar's body drawn as one looks it once revolved or
extruded. `curve2([x,y, x,y, ...])` is a closed outline through the
points, the same curve `curve()` draws, closed back to the first point;
`bezier2([...])` is one from cubic Bezier anchors and handles, laid out as
`bezier()` takes them (an anchor, then two handles and an anchor for each
piece: 4, 7, 10, ... pairs). Either is a profile like any other, for
`revolve`, `extrude`, `sweep`, `loft`, the 2D booleans and `offset`, and
its distance is exact: the nearest point on the true curve, so there are
no facets at any grid, and a revolve of one is as exact as a revolve of a
circle (glass on it renders clean).

- A point given twice in a row in `curve2` is a sharp corner, and the run
  between two corners is straight. A spline through a sharp turn
  overshoots, so give the points on a revolve's axis and at a foot's edge
  twice: `curve2([0,0, 0,0, 1,0, 1,0, 1.3,1.2, ..., 0,3, 0,3])` has a flat
  underside, a sharp foot and a straight run up the axis. The list wraps,
  and may end on its first point again, which only closes it (give it
  twice there for a corner at the start).
- In `bezier2` a corner is two handles that do not line up, and a handle
  0.5523 r along the tangent makes a quarter circle of radius r (within
  0.03%). The last anchor should be the first; when it is not, a straight
  edge closes the outline back to the first anchor, so an outline drawn
  from the axis round to the axis is closed along the axis.
- `wall=w` leaves the curve open and makes the profile the band `w` wide
  centred on it, ends rounded: a cup's wall drawn as one line from the
  axis out along the floor and up to the lip, `revolve(curve2([0,0.05,
  0.9,0.05, 0.9,0.05, 1.2,1, 0.8,2.4], wall=0.1))`, is a cup with a flat
  floor, a heel sharp inside and rounded by half the wall outside (the
  band is the distance to the line, so every outside corner rounds), a 0.1
  wall and a rounded rim. Corners work the same in an open curve; its ends
  leave along the line to their neighbours.
- An outline that crosses itself is filled as `polygon` fills one (even
  and odd): the lobes of a figure eight are both solid, and where a loop
  overlaps itself the overlap is a hole.
- The profile's box (what `check` prints) is the curve's own extent, not
  its handles'; a box reaching past x = 0 on a revolve's profile means the
  spline overshot the axis, which the corners fix.
- A straight run on x = 0 is inside the solid once revolved all the way
  round, and a full `revolve` measures the outline without it, so the
  cross-sections show no line up the axis and glass or a liquid revolved
  from one has no surface there; a `polygon` drawn on x >= 0 with edges
  on the axis does the same, so `shell()` of a revolved polygon leaves no
  rod up the middle. With `angle` under 360 the axis is an edge of the
  wedge and is kept. Only the profile itself carries this: a 2D boolean,
  move or other transform of it is measured with its axis run, so cut a
  groove after the revolve (`revolve(p) - torus(...)`), not in the
  profile.
- A closed outline carries its thinnest wall (two sides facing each other)
  for the thin-part warning, so a vase drawn as one outline with a wall
  under a cell is named; a straight run on x = 0 is not counted, since the
  solid there is twice what the profile shows.

A smooth profile costs more per sample than a polygon of as many points
(measured: a 22-point vase meshes in 1.5 s against 0.65 s for the 18-point
polygon it replaced), and less than a polygon with enough points to hide
its facets.

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
`twist = 360 * turns` is a rope. `helix()`, `arc(r, from, to, axis="y")` and
`spline(points)` make point lists, and any of them can feed `curve()`
for a smooth tube (a tight helix as a polyline has a join wedge at
every segment; `tube(r, curve(helix(...)))` has none; a helix starts at `(r, 0, 0)` and rises
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
separate from the render grid. Sampling takes a second or a few at the
default resolution, and fifteen seconds or more at 200 (the cost grows
with the cube of the resolution); the samples are then cached on disk by
the file's content, so `check` and the `render` after it, and every run
after those, sample a file once at each resolution (the log says "read
from the cache"; `--no-cache` samples afresh, and an edited file is a
new entry by itself). A mesh of overlapping closed shells (the tool's own
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
plate of every part so `aixle render` on the file is its test. A part
that needs intermediates or a loop is a def with a block body (see
Statements), so a library is one def per part rather than a helper per
sub-part. `check`
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
copy, so a forest costs one tree. A placed copy has its yaw and nothing
else: no joint of its own, no pose. Copies that must move on their own
(a Ferris wheel's gondolas, each hanging level) are a `def` called once
per copy with a named step each, `gondola_1 = car(1, "gondola_1")`,
where the joint's name is built from the index: `"gondola_" + i` joins
a string and a number (`str(i)` is the number as text). A placed set keeps its copies' nodes
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
angles (degrees about x, then y, then z; unnamed joints rest). A joint
can move and scale as well as turn: `pose("hop", body=xform(move=[0,
0.3, 0], scale=[1, 1.1, 1]), head=xform(rotate=[-10, 0, 0]))` gives the
joint a whole transform, scaled about its pivot, then turned, then moved
(the glTF order, so the export plays what the sheet shows); `rotate=`
takes the same triple or single angle a bare pose value does.
`animation("wave", ["rest", "reach", "rest"], seconds=2)` strings poses
into evenly spaced keyframes; `times=[0, 0.15, 0.6]` puts each pose at
its own second instead, the last being the length, and `ease=1` slows
to a stop at every pose (0 is linear, a value between blends the two);
`ease_ends=0` leaves the first and last pose alone, so a loop runs
straight through its seam while easing at the keys between.
Every pose is drawn on `poses.png`, every
animation on `anim_<name>.png` (an eased or timed one says so in its
bar; one camera holds still over every frame of a strip, so a swing
reads as motion and a slide moves), and the GLB carries the joints as nodes with the animations as
glTF rotation, translation and scale channels, which the viewer page
plays with loop, speed and a scrub bar, or all in turn. `set
pose reach` (or `--pose reach` on the command line) makes the sheet, the
views, the slices and the beauty render show that pose, and `check --pose
reach` prints every step's size in it. The report and the STL describe
the model as shown, posed if a pose is set; the GLB and the OBJ are
always at rest, with the joints as nodes. The
thumbnails on `poses.png` are meshed coarsely, so judge a pose that
matters at full size with `set pose`; with `set focus name` (or
`--focus`) the pose sheet and the strips are close-ups of that step
where each pose puts it, at the frame's own cell, with the rest of the
model faint around it, so a crank or a gimbal a few pixels wide on the
whole model can be read. `check` prints
the joints as a tree, each under the joint it turns with, pivots and
axes included and joints made inside a `def` too, so a rig can be
checked before any picture; the report has the same tree. An assert is
judged at rest whatever pose is shown, so "about 2.5 tall" holds through
a jump. `posed` lines in `check --pose` say where the output puts a
step, through every joint and move above it (a part with no joint of
its own gets one too when a parent's joint carries it; a `def`'s step
used in several copies gets its first placement); a step named inside a
`def` has no name, so no line and no thumbnail; give the joint its own
named step. Under a pose an `anchors posed` line gives each anchor's
world point beside its own-frame one.

Signs, in limb terms, all from `rotate`'s right-handed rule: a limb
hanging down (a leg, an arm at rest) swings forward, to +z, with a
*negative* x angle; a left arm at +x lifts outward with a *positive* z
angle, a right arm at -x with a negative one; a head or a tail that
points to +z pitches nose-down with a positive x angle, and one that
points to -z nose-up. A straight leg of length L swung θ lifts its foot
L(1 - cos θ): drop the root joint by that (`body=xform(move=[0, -0.08,
0])`) or bend the knee so the foot lands. A joint about an `axis=`
turns right-handed about the direction given: a lid on a back hinge
along +x with its front at +z opens with a negative angle, a crank shaft
along +x carries its arm from +y to +z with a positive one, and
`axis=[-1, 0, 0]` reverses both. A pose's `move` adds after its `scale`
about the pivot, so a part that must stay on its pivot (a spring on a
box floor) wants the scale alone and a `move` only for what leaves the
pivot; and the scale reaches everything inside the joint, a head on a
spring included: a part that should not stretch reads
`joint_scale("clown")` and `joint_move("clown")` and scales itself by
the inverse, as `angle()` reads the turn. `at()` on a nested joint's own
step is that joint's posed point; the world point is read through the
outer step, `at(arm, "tip")`, which carries every joint above it, and
on a top-level joint's step (`at(blade, "tip")`) the two are the same.
A pose rests every joint it does not name, so a pose that adds to
another starts from it: `pose("hold", from="reach", finger_l=xform(
move=[0.03, 0, 0]))` is the reach with the fingers closed, and an
animation through it keeps the arm out. "rest" needs no `pose()` of its
own (every joint at zero); declaring one adds a second rest thumbnail.
A joint that only slides (`xform(move=)`) turns about nothing, so its
pivot is any point on the part. A tail that both lifts and wags wants a
plain joint, not `axis=`: its x angle lifts, its y angle wags. A
looping cycle (a walk, a rotor) wants `ease_ends=0`, since an ease
stops at every key, its ends included, and a loop's ends are one
moment. `loop=0` makes a one-shot; one that must start at once and
settle takes `ease_ends=0` with `ease=1` at the keys between, and with
only two keys there are none between, so hold the last pose as a third
key: `animation("flick", ["closed", "open", "open"], times=[0, 0.45,
0.6], loop=0, ease=1, ease_ends=0)` (a two-key clip with `ease_ends=0`
is warned about). A rotor turning a
full turn needs keys under 180 degrees apart (`[0, 120, 240, 360]`), or
the export takes the short way round. A bare call such as
`spin_pose("spin_120", 120)` is a statement on its own; its result need
not be named.

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
GLB, the model as shown, in millimetres with z up (Settings has `set
units` and `set bed`). `decal(shape, region, m)` paints only the surface inside `region`, adding
no geometry: a pupil on an eyeball, a mouth along a thin tube, a label on
a jar; `region` is any shape, and it must cross the surface (a sphere
centred on the skin, a box through it): a region that touches none of
the shape's surface paints nothing, and `check` warns. A picture is a
PNG beside the program: `decal(jar, label_box, image="label.png")` fits
it to the region's box across the box's shortest side (u along x where
it can, v down), and its transparent texels leave the base material, so
a label's margin is the label's edge; `material("cream",
image="label.png", projection="cylindrical", scale=0.6)` paints a part
with the picture instead of a pattern, `planar` (one copy flat across
`axis`, `scale` wide, centred on the origin of the frame the part is
painted in), `cylindrical` (round `axis` by arc length, `scale` wide,
repeating, its height by its shape) or `spherical` (one copy round the
origin). Pictures reach the atlas, the Bedrock texture and the beauty
render through the same sampling, bilinear between texels; the report's
Images line says each picture's size and where it went. A decal is a skin: the cross-sections show
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
tiles, dots, rust. `hsl(h, s, l)` and `rgb(r, g, b)` make colour strings.

A material can also carry a finish, which adds no geometry and shows in
the beauty render and the GLB, not on the sheet (the sheet draws the
pattern, so it stays a check of the mesh):

```
iron = material("rust", wear=0.45, bump=0.003, bump_scale=0.05)   # rusty, edges worn bright, hammered
wax = material("#efe2c4", rough=0.5, bump=0.003, bump_scale=0.04)
flame = material("#ffd27a", "noise", color2="#ff8a2a", scale=0.04, glow=1.6)
```

`wear` (0 new, 1 worn hard) reads the shape's curvature: convex edges go
lighter and smoother (bare metal on a metal), creases and hollows darker
and rougher. The band it brightens is about 1.2% of the model's longest
side, the same at any grid; a part thinner than about two bands (a thin
rod, a ring) is all edge and rubbed bright along its length; a smooth
blend (`union(..., k=)`) is a gentle hollow and gathers little grime,
where a hard crease gathers a lot. `bump` is the height of a fractal
noise in model units, either way of the surface, and `bump_scale` its
feature size (ten times the height when not given, which tilts the
surface about ten degrees; a fifth of it reads as stucco). The bumps are
laid out in the frame the part is painted in, height and size alike, so
they move, turn and scale with it: a bumped part scaled after painting
keeps its finish, as a pattern does. The
`rust` pattern (and the `rust` preset, iron with rust on it) eats
patches about `scale` across into the base colour, in the oxide colour
unless `color2` is given; the patches are rough and not metal, and wear
rubs them off the edges. A material with `glow` keeps glowing in the GLB:
a constant colour as the material's emissive colour, a pattern as an
emissive map, a glow above 1 at that strength.

The GLB carries what the beauty render shows: `model.png` is the colour
(wear included), and beside it, only when something needs it,
`model_normal.png` (the bumps, and the relief of a `displace` finer than
the mesh, on the parts that have it), `model_mr.png` (roughness and
metalness, where wear or rust varies them) and `model_emissive.png` (a
glow whose colour varies). The report's Maps row says which materials
each map is for. A plain model's GLB is the colour atlas alone, as it
always was.

Paint applies to everything inside the shape, so **paint parts before
combining them** when they should differ:

```
body = box(1.6, 2, 1) | paint("red")
eyes = mirror(sphere(0.15) | move(0.3, 1, 0.5), "x") | paint("#40e0ff")
robot = body + eyes
```

A pattern is anchored to the frame where `paint` was applied, so it moves
with the part: paint, then `move`.

A material made by `material(...)` takes the name it is assigned to, and
that is its name in the report's Materials row, the GLB, the OBJ's groups
and the 3MF: `body = material("#e9b125", "noise")` is `body`, not
`custom` or `#e9b125`. A material made afresh in a loop takes it on
every iteration, and since each is a material of its own (a plank per
seed, so the six do not share one grain), the second is named `oak_plank_2`,
the third `oak_plank_3`, in the order the loop made them:

```
planks = empty()
for i in range(6) {
  oak_plank = material("#8e6438", "wood", color2="#4c2f17", scale=0.08, seed=i)
  planks = planks + (box(0.18, 2, 0.07) | paint(oak_plank) | move(i * 0.18, 1, 0))
}
```

Passing a named material on (`n = body`, a record's field, a def's
parameter) keeps its name.

## Lights, cameras and environments

The beauty render has one key light unless the program declares its
own: `light("key", azimuth=-40, elevation=55, size=1.5,
color="#fff2e0")` and `light("rim", azimuth=150, elevation=20,
power=0.5, color="#cfe0ff")` are a warm key and a cool rim, each
casting its own soft shadow (azimuth about y, 0 from the front and 90
from +x; `size` 0.5 is a lamp and 3 a window; `power` 1 is the default
key's strength; the colour is a name, a hex or a material). Three
lights cost about half again the time of one. `set environment sunset`
puts the model under an evening sky; `studio` is the default grey-white
backdrop, `overcast` a white sky with even light, `night` a dark sky
and floor where a `glow` material carries the picture. A named shot,
`camera("hero", azimuth=30, elevation=20, zoom=1.4)` or
`camera("detail", focus="nameplate", zoom=2)`, is written by `render
--beauty` as `beauty_<name>.png`, framed on its `focus=` step or object
when it has one and taking the render's own view for whatever it leaves
out; `set camera hero` makes that shot the sheet's perspective view and
`beauty.png` as well (the front, right and top views are unchanged).
`check` and the report list the lights, the cameras and the
environment, so a misspelt name is a warning before any render. With
two or more lights `render --beauty` also writes `lights.png`, the
picture under each light alone and then all of them, so what a rim
light adds is seen rather than guessed from two near-identical shots. Under
each of those is what that light adds on its own: the picture under it
alone minus the picture under no light at all, brightened until its
brightest part is near white, with the gain printed (`spark adds, ×3`),
and last the picture under no light, which is the sky's ambient, the
glows and the metals' reflections. A small point light that changes a
few pixels of the whole picture (a spark over a ring's stone) fills its
own frame there, so its reach and its colour can be judged. The frames
are half the beauty render's size.

What the lights and the skies can and cannot do, measured in round 9:

- A light with an azimuth is a direction, not a place: `elevation=8`
  means "from the horizon", whatever stands there, and a low light
  throws a long shadow across a top-down shot. A campfire's warmth on
  the stones round it is a point light, `light("fire", position=[0,
  0.4, 0], range=2, color="#ff9a3c", power=1.5)`: at a place, its
  strength halving `range` away, shadowed by what stands between, and
  not reaching the far floor. Put it in the air just outside the glowing
  part (a solid the light sits inside shadows everything; inside a glass
  shade is fine, since glass lets its light through dimmed, and a bulb
  beside the light does not shadow what is on the far side of it). A `glow`
  material lights itself only: a flame does not light the stones round
  it or the ground under it unless a point light sits in it.
- `night` scales the ambient light to 0.4 of the studio's, so a first
  render is dark: start from `set ambient 1.6` with a moon of
  `power=0.9`, and let a glow carry the picture. `sunset` is a warm
  band at the horizon under a blue sky, but only a camera near the
  horizon (`elevation` under about 10) sees the band; from above, the
  backdrop is the warm ground, and a brown model disappears into it.
  `overcast` and `studio` are neutral skies, so `chrome` and `silver`
  reflect a white sky and blow out to white under them: give a mirror
  metal a `sunset` or a `night`, or use `steel`, `iron` or `brass`.
  Gold is flat yellow under the neutral skies, deep and warm under
  `sunset`, olive under `night`. A coloured stone (`transmit` about
  0.5) shows what is behind it, so in a closed setting it reads dark;
  open the setting or keep transmit down. `--environment all` writes
  `environments.png`, the same shot under every sky, for one render;
  a list, `--environment studio,overcast`, renders only those, and
  beauty.png takes the first of them (with `all`, beauty.png keeps the
  program's own sky). The strip's frames are half the beauty render's
  size, at the full grid, so glass can be judged there, which a quick
  pass cannot.
- A camera's `elevation` is about the model's centre and may be
  negative: at 0 a perspective camera still looks down on the floor
  round a low model, so a low shot is `elevation=-8`. `elevation=90` is
  a plan view. `zoom` stops where the frame's corners would leave the
  picture, so a wide scene on a slab never gets closer than the slab;
  a camera with `focus=` frames that step instead (with `zoom=0.8` to
  step back from it), and a step in the middle of a scene makes a good
  framing proxy for a composition. A focus shot marches the whole
  model, so a hole under a counterbore reads as through when the camera
  is steep enough to see its floor (a hole 0.14 across through 0.25
  wants an elevation above about 60), and the rest of the model stays
  in the picture at its true depth; when more than
  15% of the focus step's surface facing the camera is hidden behind
  the rest of the model and another azimuth would show much more of
  it, the render warns with the fraction and the better azimuth (a
  stone enclosed in its setting is hidden from every side alike and
  gets no warning). `dof` scales a
  blur that grows with a surface's distance from the focus: 0.3 to 0.5
  is a gentle falloff, 1 blurs everything off the focus plane hard.
- `--azimuth`, `--elevation` and `--zoom` on the command line override
  the sheet's view and `beauty.png` only; a declared camera keeps its
  own angles. `--camera NAME` renders one declared shot (the sheet and
  `beauty.png` take its view, and its `focus=` framing) while a lighting
  loop runs, `--beauty-only` skips the steps, slices, turntable,
  callouts and exports for that loop, and `--environment NAME` tries a
  sky without editing the program. The caption at the foot of
  `beauty.png` and of each shot names the shot and its size for whoever
  checks it; `set caption 0` (or `--no-caption`) leaves it off a
  presentation copy, where at a low camera it can overprint the model.
- `--quick` meshes at 64 cells, so a glass wall thinner than that cell
  renders as a frosted solid and a `transmit` material cannot be judged
  there; judge glass at the full grid. A glowing part inside a glass
  shell must clear the glass by a cell, or the refraction draws rings
  and bars where the two surfaces touch. A `loft` or a smooth `union(k=)`
  is a bound rather than a distance, and glass on one bands the picture
  behind it (a liquid seen through a lofted flacon drew contour lines;
  a rounded box rendered clean; `check` warns when a `transmit`
  material sits on such a field, and a `shell`, a `clearance` or an
  `overlap` on one is only as true as the field: a loft of two profiles
  is measured across its slanted wall, like the cone it is, but a
  smooth union's blend or a twist is a bound); two coincident faces band too, so a
  liquid filling a cavity is grown a cell into the wall, and its promise
  is `inside(liquid, cavity) > 0.9`, not `== 1`. `glow` on a `transmit`
  material is not visible, and a `glow` above 1 washes out the part's
  own shading, so a lamp's cap reads as a flat disc until a point light
  beside it lights its surroundings. The first `light()` replaces the
  default key light, so a program adding a point light declares its key
  too.

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
Whatever else the frame holds is drawn faint and see-through, with a
note under each caption, so a neighbour the frame clips reads as the
context it is and not as a part (a drone's body over its gimbal); the
slices draw the cut through it faint too. The sheet's title gives the
frame's size (the step's box grown a little), not the step's own;
`check` has the step's. Without a focus the title is the surface's
extent from the mesh held within the model's bounds, since a coarse
cell's vertices can stray a little past a face (a quick sheet once
titled a 0.5-tall flange 0.51).
`--out DIR` puts a render somewhere other than `out/<name>/`, so a focus
render does not overwrite the main one. `set pose name` shows a pose. `set azimuth 60` and `set elevation 10` turn the perspective camera used
by the sheet, the turntable and the beauty render (the CLI's `--azimuth`
and `--elevation` override). `set grid N` sets the extraction resolution (cells along the longest side,
default 128; the CLI's `--grid` overrides). `set size N` sets the pixel size
of a view and of the beauty render (`--beauty-size` overrides the latter). `set slice_x 0.5` (and `slice_y`, `slice_z`) moves a
cross-section plane; a scene's default cut goes through its first
object, so list the one to cut first. `set slice tree` (or `--slice
tree`) puts the three planes through one step where the output puts
it, framed on the step with a quarter of its size round it, its own cut
in full and the rest of the model's faint: the check that a plant
stands on the soil is a cut down its stem. The planes go through the
step's solid centroid, or through its widest section where a plane at
the centroid would cut less than half of it (the hole of a ring, the
air between a post and the lamp it carries), never the box's centre,
which a leaning canopy or a reaching arm puts in the air (measured on
74 parts in five programs: through the box's centre a vertical plane
missed the part on 4 of 148 cuts and cut under a quarter of its widest
section on 8; through the centroid, on none). A `slice_x` given as well
still sets that plane. Sliced through a probe or a cutter, the planes
go through its volume and the model is drawn in full, so `--slice rods`
cuts down the holes a promise's ring of rods stands in. A step only sliced
through is a region. `set beauty 1` always writes the ray-marched
`beauty.png` (the CLI's `--beauty` does it once). `set sharp 0` falls back
to rounded vertex placement if a sharp corner ever misbehaves. Edges are
creases: a vertex whose faces meet at more than 35 degrees (a box's edge,
a block standing on a cylinder, a cut) is split so each side shades and
exports with its own normal and its own material, in the sheets, the
viewer and the GLB; `set crease 60` splits only sharper corners, `set
crease 0` keeps one smooth normal per vertex for a sculpted model that
should read soft (`--crease` on the command line). `set texture
2048` sizes the baked texture atlas (`0` turns it off and the GLB carries
vertex colours instead). `set triangles 50000` caps the GLB, the OBJ and
the viewer page at that many triangles (`--triangles` on the command
line; 200000 when neither says, `0` for every triangle): past it the
export is decimated before the atlas is baked, keeping material seams
and creases, and the report's Exports row says from how many and how far
the result strays from the model at a face centre, beside the full
mesh's own; a decimation that strays more than a cell and further than
the full mesh warns. The sheet and the STL are never decimated. Down to
about a quarter of the mesh the export reads as the full one; below
that, curved bands between soft corners (a lathe profile's bends) shade
in streaks though the surface is in place, and the row says so: read
`viewer.html` before shipping a cap that low. `set minecraft 16` also writes Minecraft Bedrock
geometry (`--minecraft` on the command line, with an optional pixel
count): the field is sampled at that many pixels per unit, a unit being
one block, every filled voxel is a pixel of solid, and the voxels are
merged into as few cuboids as they allow, a bone per scene object and
per joint (a joint's bone sits under the joint above it, at its pivot,
with the joint's part as its cubes), each cube face with its own window
in `model.geo.png` painted from the materials; `model.geo.json` is the
geometry, identifier `geometry.<name>`. With joints and animations the
render also writes `model.animation.json`: every animation as Bedrock
keyframes (`animation.<name>.<animation>`, rotation, position and
scale per bone at the sampled times, `loop` when it loops), which is the
rig back in the game it may have come from. A curved thing comes out stepped, which is what a
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
the Normal body scale (the reference lists every attachment name the
export knows with its limit: a hat 1.87 × 2.5 × 1.87 studs, a face piece
1.87 × 1.25 × 1.25, a back piece 9.86 × 8.59 × 4.87), and decimates the
mesh to the budget: a rigid accessory's 4000 triangles when there is an
Attachment anchor (shared across the meshes of a jointed model, each
giving up the same share), a MeshPart's 10000 per mesh otherwise, by
quadric edge collapses that never cross a material seam or fold a face,
so a hat meshed at grid 96 goes out at 4000 with its brim, band and
crown. A jointed model exports its joints as nodes under `Handle` and
its animations as glTF clips, which is an animated rig for Studio
rather than a rigid accessory; with an Attachment anchor it still gets
the accessory's 4000 shared across its meshes, without one a MeshPart's
10000 each, and its export has more triangles than the sheet because
each joint's part is meshed on its own, overlaps at the hinges and all.
`examples/roblox/hatchling.aix` is the
Minecraft repo's pet dragon rebuilt cube for cube as a shoulder pet,
with its Bedrock idle, flap and glide clips as poses and animations.
The report says what it was decimated from. `examples/roblox/` has a
hat, glasses, a backpack, wings, the hatchling, a café set, a lamp, a
plant and a sign; a Roblox accessory hangs on its attachment, so an accessory gets
no warning about standing. Bedrock draws geometry with x mirrored, so
cubes are authored at -x and the model stands in the game as it does on
the sheet, its +z front to the south, the block convention; an entity
faces north, so `set minecraft_entity 1` (or `--minecraft-entity`)
turns the model half a turn about y first, which with the mirror is a
flip of z: cubes and pivots keep their x and have their z negated.
`examples/roblox/hatchling.aix` does both: the Roblox pet and, at
`set minecraft 8`, the Bedrock entity it was rebuilt from, with its
clips. The geometry is the rest pose; the poses are in the animations.
What the animation file holds, per bone and key: for an entity the
pose's angles as they are (`[rx, ry, rz]` in degrees; Bedrock's own
convention and the half turn cancel), for a block `[-rx, ry, -rz]`; a
`move` in geometry pixels (sixteen to the block), z negated for an
entity, x for a block; a `scale` as it is. A linear clip has a key per
pose, an eased one eight per segment, and a held value is its two end
keys. The face texture is painted from the model's own surface behind
each texel (a decal on a face, a skin thinner than a voxel: both reach
it), with each window's u and v running as the game reads them (checked
against the Minecraft repo's viewer), and its unused texels are
transparent. A texel takes the material at its own centre, so a decal
must cover a texel centre to reach the texture: make its region about a
pixel across and on the lattice (an eye as a one-pixel box, not a 0.5
pixel sphere between two centres); a material that paints no texel is
warned about. A part built tilted (a tail at 35 degrees) voxelises to a
stair of cubes; build it axis-aligned and tilt it in a pose. A box model on the game's
lattice is easiest built as the hatchling is: a `cube(ox, oy, oz, w, h,
d)` helper in geometry pixels, each part grown a third of a pixel so
touching bones fuse into one piece (grown upward only at the feet, or
the model stands a hair below the floor), which the voxeliser rounds
away again; `check` warns about a part thinner than a voxel as `render`
does.

For a print, `set units mm` (or `cm`, `m`, `in`; `set units in` works
though `in` is a keyword) says what one unit is, and `set bed 220 220
250` (or `set bed [220, 220, 250]`) is the printer's build volume in
millimetres: width along x, depth along z, height along y. Without
units a unit is taken as a millimetre, which is what a slicer reads an
STL as, and the report says how tall that would print, so a 2.4-unit
mug is told it prints 2.4 mm tall. `model.stl` is always written in
millimetres and with z up, the way a slicer's plate is (the model
stands on it as it stands on the sheet, its front towards the front of
the plate). A program that sets units or a bed also gets `model.3mf`
(`--3mf` asks for it without them): the same mesh in the program's own
unit, welded so a slicer sees it closed, with each material's colour
on its triangles. With units set, the sheet's title gives the size in
them (`3.76 × 2.4 × 2.4 cm`). With a bed set, a model that fits the bed
neither square nor turned about the vertical is a warning. With units or
a bed set, `check` prints a `print:` line with the size in millimetres
and the bed's verdict, from the surface's extent, in no time; when that
box does not fit square, the outline is judged turned and lying from a
coarse mesh, as the render judges its own, so the two agree.

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

## Layout: `aixle fmt`

`aixle fmt model.aix` prints the program in the one layout the tool
keeps; `--write` rewrites the file, `--check` changes nothing and fails
naming each file that is not in it. It moves only the space between
tokens, so it cannot change what a program means: no token is added,
dropped or respelled (a number stays `0.50`), no line is joined or split,
and every comment stays where it was. The layout:

- one space around `=`, `|` and the operators; none around the `=` of a
  named argument or a default (`round=0.1`), after a unary minus or a
  call's name, inside brackets, before a comma, or around a field's dot;
  `{x: 1, y: 2}` for a record;
- after a comma, the space you wrote: `[x,y,z, x,y,z]` keeps its points
  and a table of numbers stays lined up;
- a loop's body two spaces in; a line that continues a statement keeps
  its break, two in from the line that opened its bracket, or lined up
  under the argument it was written under, which stays lined up however
  the line above was respaced; inside brackets, a line that starts with
  an operator written further in than the item above it carries that
  item on and stays two in from it (`  box(1)` over `    | move(0, 1, 0)`);
  a closing bracket that starts a line at its opener's line;
- an `=` (or a record's value) padded into a column with the line above
  or below keeps the column, and every line of the column stays in it
  (pushed right together when one line's code now reaches past it); a
  trailing comment keeps its column unless the code now reaches it, so a
  column of them stays a column;
- one blank line where there were several, none at the ends.

## What the tool checks for you

`aixle check` (a second, or a few with `pieces()` and `overhang()`,
which mesh: once per shape and grid in a run, so the two on one part
share a mesh, and round 10's hub checked in 2.5 s rather than 3.9)
prints every step's size and the warnings: shapes as their
box, 2D profiles as their box in the plane (text on an arc adds the
radii its lettering spans from the origin, `on the arc r 0.255..0.385`,
which is the number to hold against a boss's rim), numbers and lists of numbers
as their values (a number set inside a loop is the last iteration's and
is not listed), then the program's `def`s with their parameters;
`--brief` leaves the sizes out and prints the output, the warnings and
the asserts alone, for a promise loop on a long program. A step whose tree holds a rotation, a warp or a posed
joint gets a second `surface` line when the surface's own extent is
tighter than the box (a box after a rotation is the box of a turned box),
and with `--pose` a `posed` line says where the step ends up once the
joints above it have turned, since a part built at rest and turned by a
joint keeps its rest box. A joint step itself is already turned in a
pose, so its box is the box of the turned box and its `surface` line is
where it is; it gets no `posed` line of its own. Both lines come from rays marched in from the
box's faces, so a plate thinner than the rays' spacing can slip between
them; the render's "Surface extent" row reads the mesh and does not. `aixle render`
also writes the warnings into `report.md` and counts them on the sheet's title bar,
and beside `turntable.png` writes `turntable.apng`, the same turn as an
animated PNG of 24 frames that a browser plays (`--no-turntable` skips both).
Warnings cover: a shape computed but never assigned; a comment after code
that holds what reads as the line's next step (`eye = torus(0.05, 0.015)
| rotate(z=90)   # clears the ring | move(pivot[0], ...)`: a `|` and a
call of a builtin, a def or a used library's, which is ignored with the
rest of the comment, so the part stays where it was); a step that is not part
of the output (a step an assert, a decal or a camera reads is a region
and is not warned about; `check` tags each step `(cut)`, `(region)` or
`(not in output)`); an empty output (a difference that removed everything, an
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
exactly on a sample plane, which a nudge of half a cell cures, and the
report gives the number and the axis; a cutter named there is tagged
`(cut: the face it cut)`, the wall it left in its part);
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
count and the steps whose surfaces pass there). Where a cluster is
between two steps, it says how far apart their surfaces are there
(`in 'barrel', 'bracket', their surfaces 0.012 apart there (0.4 of a
cell)`) or how far one reaches into the other (`'pin' only 0.01 into
'plate' there`, or `'pebbles' only 0.01 past the face 'recess' cut`
when the other is a cutter, whose inside is air), from points of each
surface within a cell and a half of the edge read in the other's field,
so the fix is a number: the gap closed to an overlap of a cell, or
opened to a cell; `report.json` has it as `gap` on the three clusters
the report prints, negative for an overlap. A focused render adds a
"Close-up watertight" row for the close-up's own finer mesh, with the
frame's clip faces left out. The report's Physics section has the numbers: mass at `set
density`, centre of mass, footprint, pieces, and how much of the surface
overhangs (faces down more than 45°, which a printer would need support
under). The Print section has what a slicer's user asks first: a
summary line, the unit (or that it was assumed), the size in
millimetres, the bed (fits; does not fit square, but turned so many
degrees on the plate it does, the smallest turn, in degrees as
`rotate(y=)` turns; only lying on its side; not at all), the
thinnest wall with where it is and the steps on both sides of it, the
support volume under the overhangs (standing on the plate and on the
model, the tallest column and where, an upper estimate since a slicer
bridges short spans), what rests flat on the plate, and the material in
cubic centimetres and grams of PLA. The thinnest wall is measured by a
ray from every vertex inward to the far side of the solid, through the
field, so a wall under a cell is still read at its own thickness, and a
cut's walls (a flute through a vase's side, an engraving's floor) are
found where no step's feature size knows them. Near the tip of a
corner the ray leaves through the side face at a slant, and a reading
counts only where the far side faces back within 30 degrees, so a
corner is not taken for a wall; a blade, or a feather a cut leaves on a
tilted plate (faces meeting under 30 degrees), and a sliver between two
cuts are thin, and count. The share of the surface on walls under 0.8 mm
(two lines of a 0.4 mm nozzle) is given when there is any. `report.json`
has all of it under `print`.

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
An assert is judged at rest, whatever pose `--pose` or `set pose`
shows, because it is a promise about the model as built and a pose is a
view of it; a promise about a pose names it, `assert clearance(hand,
face) > 0.02, "the wave clears the face", pose=reach` (a bare word or a
string), and is judged with the program evaluated in that pose, on every
`check` and `render`. Inside such an assert a query on a step under
other joints (`bottom(paw)`, `clearance(wrist, base)`, `at(foot,
"sole")`) measures the step where the pose puts it, through every joint
above it, so a foot-on-the-floor promise is `assert abs(at(dog,
"sole")[1]) < 0.01, pose=walk_a` or `assert bottom(paw_fl) < 0.01,
pose=walk_a` alike; outside an assert a step's own queries stay in its
own frame, since geometry is built there. `check` prints every passing
assert with its numbers too, so how close a promise came is on the
terminal. A pose that is not defined is a warning and the assert is
never tested. A used library's asserts run with it and are reported
with the library's path.

The queries that make it useful: `pieces(shape, resolution)` is the
number of separate pieces the shape meshes into at that many cells on
its longest side, the program's `set grid` when none is given (64
without one), as the report's Pieces row counts them (it meshes the
shape, so it costs a moment; a whole scene wants the report instead; a
count at 64 cells bridges a gap a finer grid opens, which is how a
chair's floating back once passed); `overhang(shape, resolution)` is
the fraction of the surface that faces down more than 45° with the
floor faces left out, the report's Overhangs row, for `assert
overhang(part) < 0.05` on something to be printed without support (it
meshes too); `wall(shape, resolution)` is the thinnest wall, as the
Print section measures it, in model units: with `set units mm`, `assert
wall(model) > 0.8, "two lines of a 0.4 mm nozzle"`, and a failure says
where the thinnest wall is and in which step (it meshes too, at the
program's grid or 64; a shape with no surface in that mesh, empty or
thinner than a cell everywhere, reads 0 and fails the promise);
`clearance(a, b)` is
the smallest gap between two surfaces, negative by how deep they overlap,
zero when they touch, sampled from the fields at twelve points per side
of each shape's box and then tightened, so it is exact for parts that
face each other and can miss a feature narrower than a twelfth of the
part. Measure parts rather than the whole model: `clearance(handle,
body)`, not `clearance(handle, model)` (the handle is in the model, so
that is zero). `void(region, shape)` is 1 when the region holds no
solid of the shape: `assert void(cavity, mug)` promises nothing pokes
into the cup (the mug example's handle once reached inside it), and a
failure says where the solid is and in which step (`void(cavity, mug),
solid at (0.44, 1.3, 0) in 'handle'`). The region is a shape of its
own, never the cutter: a cutter's volume is empty by construction, so
`void(slot, plate)` holds whether or not the slot went through; "the
hole goes through" is a thinner rod reaching past both faces,
`rod = cylinder(0.04, 0.3) | move(...)` and `assert void(rod, plate)`.
`overlap(a, b)` is the volume two parts share, zero when they only
touch: `assert overlap(frog, pad) < 0.001` keeps a frog on its pad
rather than sunk into it, and `assert overlap(handle, body) > 0.001`
says a handle is joined to its wall, not just touching; a volume is
small (a pin of radius 0.05 sunk 0.07 shares 0.00055; a ring's band, a
torus of radius 0.42 and tube 0.065 standing on a flat cushion, sunk
0.03 into it shares 0.00047, and a band of radius 0.2 sunk as far
0.00034), so take a "joined" threshold from the part's size, and a
failure says where the two overlap. An overlap of 0 says why: the two
only touch there (a board's back face exactly on a wall: sink it), they
stand apart by so much, or they overlap by less than the lattice can
measure over their shared box (promise that on a chunk of the part, `rim
& box(...)`, or as `clearance(a, b) < 0`). `inside(a, b)` is the fraction of a's volume inside b: `== 1`
for a spring that must stay in its housing, `== 0` for a handle that
must stay out of the cavity, and a failure says where a is outside b.
`b` is the solid volume: a mantle hangs in the air inside a shelled
shade, so `inside(mantle, shade)` is 0; keep the un-shelled shape as a
step (`shade = shade_space | shell(0.05)`) and test against that; that
solid includes the wall's own volume, so `inside(gnome, dome_space) == 1`
alone does not keep the gnome out of the glass, and `void(wall,
innards)` beside it does. A failing `clearance` says where the two came
closest or overlapped deepest. All
three sample a lattice (24 cells along the longest side, and `void`
walks the surface too, so a pin thinner than the lattice is caught), so
measure parts, not a scene. The bound queries (`width`, `tall`,
`depth`, `top`, `bottom`, `height`) and the anchors (`at`) are the
rest. A failing `pieces()` names the smallest loose piece and where it
is. A failing `void` whose region is made of copies (a ring of probe
rods) says which copy held the solid, `in copy 3 of the 6 in rods`, and
one whose region is a union of named probes names the probe. A `void` whose region's box never meets the shape's box holds for
no reason, and `check` says so: a probe built in one frame against a
cutter in another promises nothing. A step only an assert reads (a
probe rod, a cavity's region, a union of the neighbours) is a *region*:
not part of the output, not warned about, framed grey and tagged on the
steps sheet, and never labelled in the callouts; a shape subtracted
from a part is a *cut*, tagged so on the steps sheet, which draws it as
the solid it removes; the larger operand of an `&` (a half-space box
that trims a gem, even turned and moved on its way in, `stone & (below
| rotate(x=25) | move(0, h, 0))`) is a *mask*, tagged so and never labelled. `check`
prints the asserts in line order, failures among the passes.

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
  on the strip. A step's thumbnail that is all glass (a gem, a dome on
  its own) has nothing of its own behind it and is drawn solid, so its
  shape reads. The beauty render refracts it properly.
- The sheet and the views colour the mesh per vertex, so a pattern or a
  decal near the cell size looks blocky there (a 0.07 speckle at a 0.03
  cell reads as camouflage); the beauty render and the baked atlas sample
  the material exactly. Judge fine patterns in the beauty render. `wear`
  and `bump` are not on the sheet at all: judge them in `--beauty`.
- Wear's band is a share of the whole model's size, so in a big scene a
  small part reads more of its surface as edge; a lantern in a market
  wears wider than the same lantern alone.
- Only `model.glb` carries the normal, metallic-roughness and emissive
  maps. The OBJ's MTL names `model.png`, the colour with wear in it; the
  Roblox GLB and the Bedrock texture take the pattern's colour alone, no
  wear.
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
  assigned to a name, which it then takes (in a loop, `name_2`, `name_3`
  for the later ones; see Materials).
- A cross-section draws the surface's outline a cell or so behind the cut
  plane as a thin line, so a plate just behind the plane shows as a dashed
  line across an opening that is open. Move the slice (`set slice_x`),
  put the planes through the step itself (`set slice name`), or render
  a `--focus` close-up to be sure.
