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

## Values

| Kind | Made by | Combines with |
| --- | --- | --- |
| number | `1.5`, `2 * r + 1`, `sin(30)` | `+ - * / % ^`, unary `-` |
| string | `"wood"`, `"#a0522d"`, `"x"` | material and axis arguments; `+` joins |
| list | `[1, 2, 3]`, `range(4)` | `for`, `polygon`, `len` |
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
then y then z), `scale(s)` or `scale(x, y, z)`, `mirror("x")` (keeps both
halves: model one arm, mirror it), `flip("x")` (reflects only), `ground()`,
`center()`.

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

**2D profiles** live in the x/y plane: `circle`, `rect`, `ellipse`, `ngon`,
`star`, `polygon(x1,y1, x2,y2, ...)`. They take the same booleans, `move(x,
y)`, `rotate(deg)`, `scale`, `mirror`, `round`, `offset`, `shell`. Then:

- `revolve(profile)` spins it around y; the profile's x is the radius, so
  draw it on `x >= 0`. A vase is one polygon and one `revolve`.
- `extrude(profile, h)` lays the profile flat (its y towards -z) and
  thickens it `h` up; `extrude(profile, h, "z")` makes it face the front.

## Materials

`paint(shape, m)` gives the whole shape one material; `m` is a preset name
(`"wood"`, `"brass"`, `"marble"`, see the reference), a colour (`"red"`,
`"#40e0ff"`), or `material(color, pattern, color2, scale, metal, rough)`.
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

`set grid N` sets the extraction resolution (cells along the longest side,
default 128; the CLI's `--grid` overrides). `set size N` sets the pixel size
of a view. `set slice_x 0.5` (and `slice_y`, `slice_z`) moves a
cross-section plane.

## What the tool checks for you

`aixle check` prints every step's size and the warnings; `aixle render`
also writes them into `report.md` and counts them on the sheet's title bar.
Warnings cover: a shape computed but never assigned; a step that is not part
of the output; an empty output (a difference that removed everything, an
intersection that did not overlap); a model thinner than a few grid cells;
and, as a note, a model that does not rest on `y = 0`.

## Limits worth knowing

- Detail thinner than a grid cell disappears. The cell size is on the sheet
  (`CELL 0.03`); raise `--grid` for fine work, at a cubic cost.
- Non-uniform `scale`, `twist`, `bend` and `displace` distort distances; the
  surface is still right, but a `round` or smooth blend applied *after* them
  is approximate.
- Rotated shapes have conservative bounding boxes, so `ground()` and
  `center()` after a rotation can be off by a little.
- There is no text, no sweep along a path, and no import of meshes yet.
