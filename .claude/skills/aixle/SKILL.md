---
name: aixle
description: Build a 3D model by writing an Aixle (.aix) program, rendering it, and reading the renders to verify it. Use when asked to model, sculpt, design or generate a 3D object, scene, prop, part or mesh, or to produce an OBJ or GLB.
---

# Modelling with Aixle

Aixle is a small language for 3D models: primitives combined with
constructive solid geometry, transformed, repeated, blended and painted,
one named step per line. The tool turns the program into pictures you read
to check the model, and into meshes to ship. Nothing is taken on faith:
sizes are printed, every step is drawn, and the inside is cut open.

Reference: `docs/reference.md` (every function, generated from the code),
`docs/language.md` (the language), `examples/*.aix` (ten worked models).

## The loop

1. **Plan in words.** What is it, how big, which way is its front (+z),
   what are its parts. Pick a unit and keep the whole model within about
   1 to 20 units.
2. **Write `model.aix`**, one part per named line. Build each part at the
   origin, then `rotate`, then `move` into place. Paint parts before
   joining them. End with `show model`.
3. **`npx aixle check model.aix`**: syntax and type errors, every step's
   size, every warning, in a second. Sizes that look wrong are wrong.
4. **`npx aixle render model.aix`**, then read `out/model/sheet.png`.
   Read `slices.png` if anything is hollow or nested, `steps.png` if a
   part is missing or misplaced. `report.md` has the numbers.
5. **Compare with the plan.** Fix, back to 3. Done when the sheet matches
   the plan and the report has no warning you cannot explain. Then
   `--beauty` for the presentation picture.

## Reading the sheet

- Title bar: size as `w × h × d`, triangle count, cell size. A model 10
  tall that should be 1 is wrong before anything else is.
- Front is from +z, right from +x, top from above with the back at the top.
  Grids are whole units; darker lines pass through the origin. The
  perspective view's red, green, blue lines are +x, +y, +z.
- A red frame in `steps.png` is a shape that never reached the output.
- Slices are the truth about interiors: filled means solid.

## The language in one screen

```
name = expr                      # a step
def part(a, b=1) = expr          # a parametric part
for i in range(6) { ... }        # loops; range(a, b), range(a, b, step), [1, 2.5]
show name                        # the output (default: the last shape)

box(w, h, d)  sphere(r)  cylinder(r, h)  cone(r1, r2, h)  capsule(r, h)  torus(R, r)  prism(n, r, h)
circle(r)  rect(w, h)  ngon(n, r)  star(n, r1, r2)  polygon(x,y, ...)  text("ABC", size)   # 2D
extrude(profile, h)  revolve(profile)  loft(a, b, h)                                     # 2D to 3D
tube(r, [x,y,z, ...], smooth=6, taper=1)  sweep(profile, [x,y,z, ...], smooth=6, twist=0, taper=1)
helix(r, h, turns)  arc(r, from, to)                                                     # path lists
import("part.obj", size=2)                                                               # a mesh as a shape
scene a, b, c   place(shape, [x,y,z,yaw, ...])   joint(part, "elbow", x, y, z)          # assemblies
pose("reach", elbow=[0, 0, 40])   animation("wave", ["rest", "reach", "rest"], seconds=2)

a + b   a - b   a & b            # union, difference, intersection; union(a, b, k=0.3) blends
a | move(x, y, z) | rotate(y=45) | scale(2) | mirror("x") | round(r) | shell(t)
  | twist(deg) | bend(deg) | displace(amp, size) | array(n, dx, dy, dz) | grid(nx, nz, dx, dz)
  | ring(n, radius) | ground() | center() | paint("wood")
```

y is up, angles are degrees, primitives are centred on the origin and stand
along y, `a | f(x)` is `f(a, x)`, `|` binds tighter than `+ - &`.

## A worked example

```
# A mug: a rounded cup, hollowed and opened at the top, a torus handle.
r = 1.2
body = cylinder(r=r, h=2.4, round=0.12)
cavity = cylinder(r - 0.14, 2.4) | move(0, 0.2, 0)     # taller than needed: it opens the top
cup = body - cavity
handle = torus(0.75, 0.16) | rotate(x=90) | move(r + 0.45, 0.1, 0)
mug = (cup + handle) | paint("porcelain") | ground()
show mug
```

`check` prints the five steps' sizes; the sheet shows the handle on the
right (+x) and the slices show the wall thickness and the open top.

For a rig: build each part in place, wrap it with `joint` at its pivot,
nest the forearm's joint inside the upper arm's part, write poses, then
read `poses.png` and `anim_<name>.png`: a part that swings about the
wrong point has the wrong pivot.

## Mistakes the renders catch

| Symptom | Cause | Fix |
| --- | --- | --- |
| a part is on the wrong side | `rotate` is about the origin, applied after `move` | rotate first, then move |
| a chair faces away from the table | its front was +z and it sits on the +z side | `rotate(y=180)` for that one |
| no cavity in the slices | shell applied after the opening was cut, or the cutter stopped short | shell first; make cutters longer than the wall |
| one colour everywhere | `paint` applied to the union | paint each part, then combine |
| a hole or wall is missing | thinner than a grid cell (see `CELL` in the title bar) | raise `--grid`, or make it thicker |
| speckle on a thin shell | the wall tapers below a cell | thicken it; see `examples/lamp.aix` |
| "is not part of the output" | a step was never added to the final shape | add it or delete it |
| corrugated sweep | tight bends with few points | raise `smooth=` |

## Style that renders well

Overlap parts slightly rather than butting them; `round=` on boxes and
cylinders, `union(..., k=)` for organic joins; `ground()` last; name steps
for what they are, since the names are what the sheets show you.
