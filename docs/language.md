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
| number | `1.5`, `2 * r + 1`, `sin(30)` | `+ - * / % ^`, unary `-` |
| string | `"wood"`, `"#a0522d"`, `"x"` | material and axis arguments; `+` joins |
| list | `[1, 2, 3]`, `range(4)` | `for`, `polygon`, `len`, `list[i]` (0-based, `-1` is the last), `+` joins |
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

Precedence, loosest to tightest: `+ -`, then `&`, then `* / %`, then unary
`-`, then `^`, then `|`. Parentheses when in doubt.

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
  which is the one for a side profile such as a chair's end frame.

**Paths**: `tube(r, [x,y,z, x,y,z, ...])` is a round tube along the
points with rounded joins and hemispherical ends that reach `r` past
each end point (`cap="flat"` cuts them flat at the points); `sweep(profile, [points])` carries a 2D profile
along them (its x across the path, its y as near world up as the path
allows; on a vertical run, y points to -z); `loft(a, b, h)` blends from
profile `a` at the bottom to `b` at the top over height `h`. Both path
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
numbers works, including one built in a loop.

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
close up; `check` warns when they are under a cell. Judge lettering with
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
box bent by a few degrees.

**Import**: `import("part.obj")` or a `.glb`, relative to the program's
folder, makes an existing mesh a shape: it is sampled into a distance
field (`resolution=` cells on its longest side, default 96), so it can be
cut, blended, hollowed and painted like anything else. `size=` scales its
longest side to that many units. Closed meshes work; an open mesh has no
inside, and `check` says so. Positions and triangles only: the mesh's
materials are not read, and `resolution` is the sampling of the import,
separate from the render grid. Sampling a large mesh takes tens of
seconds, and `check` and `render` each do it. The import's own detail is limited by its
resolution, so a fine mesh wants `resolution=160` or so.

## Scenes, joints and poses

`scene a, b, c` outputs several named objects instead of one shape: the
sheet shows them together, and the GLB has a node per object (the OBJ a
group). `place(shape, [x,y,z,yaw, x,y,z,yaw, ...])` puts copies of a shape
at each position and yaw (degrees about y; `fields=5` adds a scale per
copy): the render is the union, the export is one mesh with a node per
copy, so a forest costs one tree.

`joint(part, "elbow", x, y, z)` makes a part turn about a pivot. Build the
part in place, declare the joint at its world pivot, then combine it with
`+` and `paint`; a joint nested inside another part's joint turns with it,
and its angles are relative to its parent: a stick at `-45` on a boom at
`35` lies at `-10` in the world. Joint names must be unique.
`pose("reach", shoulder=[0, 0, 25], elbow=[0, 0, -40])` names a set of
angles (degrees about x, then y, then z; unnamed joints rest);
`animation("wave", ["rest", "reach", "rest"], seconds=2)` strings poses
into evenly spaced keyframes. Every pose is drawn on `poses.png`, every
animation on `anim_<name>.png`, and the GLB carries the joints as nodes
with the animations as glTF channels, which the viewer page plays. `set
pose reach` (or `--pose reach` on the command line) makes the sheet, the
views, the slices and the beauty render show that pose, and `check --pose
reach` prints every step's size in it; exports are always at rest. The
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
``` `pose(...)` may be called
from a `def`, with its angles from the `def`'s parameters, so a set of
poses with a shared shape is one `def` and a line per pose. `check` prints number steps as well as shapes, so the
distances you compute are there to read.

## Materials

`decal(shape, region, m)` paints only the surface inside `region`, adding
no geometry: a pupil on an eyeball, a mouth along a thin tube, a label on
a jar; `region` is any shape. A decal is a skin: the cross-sections show
the base material underneath, and a step used only as a region is not
geometry, so it gets no thin-part warning and is never named as a loose
piece. Patterns are laid out in the frame the part is painted in, along the
material's `axis` (y unless given): `stripes` are bands stacked along it
(`scale` wide), `wood` rings go round it with the grain along it, `brick`
courses and `tiles` rows lie across it, `checker` and `dots` are cubic.
So stripes on a flat awning need either `material("red", "stripes",
"cream", scale=0.5, axis="x")` or the sheet painted standing and then
laid down; a rotation after painting turns the pattern with the part.
`paint(shape, m)` gives the whole shape one material; `m` is a preset name
(`"wood"`, `"brass"`, `"marble"`, see the reference), a colour (`"red"`,
`"#40e0ff"`), or `material(color, pattern, color2, scale, metal, rough)`.
A preset at another feature size is `material("granite", scale=0.4)`:
start from the preset, change only what is given. Pattern sizes are in
model units (the reference lists each preset's), so a 0.25-unit wood
ring suits a table leg and a 20-unit floor wants `scale=2`.
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
model's centre; `set zoom 1.4` brings the beauty camera closer (1 fits
the model's bounding sphere, which leaves a box-shaped model small in
the frame; `--zoom` on the command line). A material with `glow=1` gives off its own light in every
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
to rounded vertex placement if a sharp corner ever misbehaves. `set texture
2048` sizes the baked texture atlas (`0` turns it off and the GLB carries
vertex colours instead).

## The fast loop

`aixle render model.aix --quick` renders the sheet only, at a small grid,
in a second or two; `--watch` re-renders on every save; `aixle diff a.aix
b.aix` draws two versions side by side, A on the left, for judging a
change. Use the full render for the final check: the quick grid drops
detail thinner than its cell.

## What the tool checks for you

`aixle check` prints every step's size and the warnings; `aixle render`
also writes them into `report.md` and counts them on the sheet's title bar.
Warnings cover: a shape computed but never assigned; a step that is not part
of the output; an empty output (a difference that removed everything, an
intersection that did not overlap); a model or part thinner than a grid
cell, including a `shell` wall, a `tube`, a `sweep` profile or a `text`
stroke inside a thick part (those carry their own thickness, since a
bounding box cannot see it); a model in separate pieces (a part that floats free) or with slivers
left by a cut; a model that would tip over, from its centre of mass and
the footprint of its base; and, as a note, a model that does not rest on
`y = 0`. The report's Physics section has the numbers: mass at `set
density`, centre of mass, footprint, pieces, and how much of the surface
overhangs (faces down more than 45°, which a printer would need support
under).

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
  points. There is no import of meshes yet.
