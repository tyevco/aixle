# Aixle

A procedural 3D modelling language written for language models to write.
A model is a short program: primitives, combined with constructive solid
geometry, transformed, repeated, blended and painted, each step named and
building on the last. One command turns the program into pictures an agent
can look at to check its work (a contact sheet of views, cross-sections,
one thumbnail per build step, a turntable) and into meshes it can ship
(OBJ with materials, binary glTF with baked colours).

```
# A coffee mug: a rounded cup, hollowed and opened at the top, a torus handle.
r = 1.2
body = cylinder(r=r, h=2.4, round=0.12)
cavity = cylinder(r - 0.14, 2.4) | move(0, 0.2, 0)
cup = body - cavity
handle = torus(0.75, 0.16) | rotate(x=90) | move(r + 0.45, 0.1, 0)
mug = (cup + handle) | paint("porcelain") | ground()
show mug
```

```
npx aixle render examples/mug.aix        # writes out/mug/
```

![the mug's contact sheet](examples/renders/mug.png)

The cross-sections come straight from the distance field, so a hollow you
cannot see from outside is still checkable:

![the mug's cross-sections](examples/renders/mug_slices.png)

And every named shape gets a thumbnail, in program order, with its size; a
red frame means it never made it into the output:

![the mug's build steps](examples/renders/mug_steps.png)

## Working with it

The loop an agent runs is: write a `.aix` file, `check` it, `render` it,
read `sheet.png`, compare against what was intended, fix, repeat.
[`docs/agent-guide.md`](docs/agent-guide.md) is the short version of that
loop with the checklist; drop it into a system prompt or a skill.
[`docs/language.md`](docs/language.md) is the language guide and
[`docs/reference.md`](docs/reference.md) every function with its signature,
generated from the code so it cannot drift.

```
npm install
npx aixle check  model.aix           # parse, evaluate, print sizes and warnings; no pictures
npx aixle render model.aix           # everything, into out/model/
npx aixle render model.aix --grid 200 --size 768 --out somewhere
npx aixle doc                        # the reference, to stdout
```

`render` writes:

| File | What |
| --- | --- |
| `sheet.png` | perspective, front, right and top views on unit grids, with the model's size in the bar |
| `slices.png` | cross-sections on x, y and z, inside filled with the material, outline where the surface is |
| `steps.png` | one thumbnail per named shape in program order; red = not part of the output |
| `turntable.png` | eight views around the model |
| `persp.png`, `front.png`, `right.png`, `top.png` | the views on their own |
| `model.obj`, `model.mtl` | the mesh with one group per material |
| `model.glb` | binary glTF, materials with vertex colours baked from the patterns |
| `report.md`, `report.json` | size, bounds, triangle count, volume, every step's size and whether it is used, warnings |

## The language in one screen

```
name = expr                      # every assignment is a step
def part(a, b=1) = expr          # a parametric part
for i in range(6) { ... }        # loops; also range(a, b), range(a, b, step), or a list [1, 2.5]
show name                        # what to output (default: the last shape)

box(w, h, d)  sphere(r)  cylinder(r, h)  cone(r1, r2, h)  capsule(r, h)  torus(R, r)  prism(sides, r, h)
circle(r)  rect(w, h)  ngon(n, r)  star(n, r1, r2)  polygon(x1,y1, x2,y2, ...)     # 2D profiles
extrude(profile, h)  revolve(profile)                                            # profiles to solids

a + b   a - b   a & b            # union, difference, intersection (also union(a, b, c, k=0.3) for smooth)
a | move(x, y, z) | rotate(y=45) | scale(2) | mirror("x")
  | round(r) | shell(t) | twist(deg) | bend(deg) | displace(amp, size)
  | array(n, dx, dy, dz) | grid(nx, nz, dx, dz) | ring(n, radius)
  | ground() | center() | paint("wood")
```

Units are whatever you say they are; y is up; angles are degrees. Every
primitive is centred on the origin and stands along y. `a | f(x)` is
`f(a, x)`. Paint parts before combining them if they should keep different
materials.

## Examples

[`examples/`](examples/) has eight models exercising the language, each
with its sheet, slices and steps under [`examples/renders/`](examples/renders/):
a mug, a fluted vase from a revolved profile, a table with parametric chairs,
a brick tower, a pair of gears from 2D profiles, a spiral staircase from a
loop, a robot with per-part materials, and a tree with smooth blends and
displacement.

| | | |
| --- | --- | --- |
| ![vase](examples/renders/vase.png) | ![tower](examples/renders/tower.png) | ![gears](examples/renders/gear.png) |
| ![table](examples/renders/table.png) | ![stairs](examples/renders/stairs.png) | ![robot](examples/renders/robot.png) |

## How it works

Shapes are signed distance fields, not meshes. That is why the booleans are
exact and never fail on coincident faces, why `shell`, `round`, smooth
blends, `twist` and `displace` are one line each, and why a cross-section
is free. The surface is extracted once at the end by surface nets on a grid
(`--grid`, default 128 cells on the longest side), and that one mesh is what
the software rasteriser draws and what the exporters write, so the pictures
show the file you get. Materials are procedural patterns evaluated in the
painted part's own frame, sampled per pixel when rendering and per vertex
when exporting; there are no UVs. [`docs/design.md`](docs/design.md) has
the reasoning and the limits.

No runtime dependencies. `npm test` runs the unit tests; `npm run check`
runs typecheck, tests, the reference and the example renders, which CI
compares against the committed files.
