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
2. **Write `model.aix`**, one part per named line. For a bolt, a chair,
   a tree or the like, `use "std/hardware"`, `"std/furniture"` or
   `"std/plants"` first (`npx aixle doc std/hardware.aix` says what each
   has and how it is placed) rather than building it; put parts you
   repeat in a library file of `def`s beside the program and `use` it.
   Build each part at the
   origin, then `rotate`, then `move` into place; where two parts meet,
   `anchor` the meeting points and `attach` one to the other instead of
   computing the move (`lamp | attach("bottom", arm, "tip")`), and use
   `at(part, "name")` as the end of a `tube`. Paint parts before
   joining them. End with `show model`.
3. **`npx aixle check model.aix`**: syntax and type errors, every step's
   size (profiles and numbers too), every warning, in a second. Sizes
   that look wrong are wrong. A `surface` line under a step is the true
   extent of a turned box; with `--pose`, a `posed` line is where a step
   ends up once the joints above it have turned.
4. **`npx aixle render model.aix --quick`** while iterating (the sheet in
   a second or two; on a rig add `--no-poses` until the geometry settles,
   the strips come with the full render), then read `out/model/sheet.png`. Drop `--quick` for
   the full render: read `slices.png` if anything is hollow or nested,
   `steps.png` if a part is missing or misplaced; `report.md` has the
   numbers, including whether the model stands and is in one piece; a
   quick sheet that dropped thin steps says so and does not judge the
   pieces. `--focus step` is a close-up meshed at its own finer cell,
   where the step is in the pose shown, with its own watertight row.
   `npx aixle diff before.aix after.aix` shows two versions side by side.
   On a program you did not write, `npx aixle explain model.aix` first: the
   tree from the output down, each step with its source line, size,
   material and anchors, so you know which step feeds which before you
   render anything.
5. **Promise it with `assert`** once a thing is right: `assert
   pieces(model) == 1`, `assert clearance(handle, rim) > 0.05`, `assert
   tall(model) < 2.2`. `check` then fails, with the numbers, when a later
   edit breaks it.
6. **Compare with the plan.** Fix, back to 3. Done when the sheet matches
   the plan and the report has no warning you cannot explain. Then
   `--beauty` for the presentation picture, and `--minecraft` when the
   model is for Bedrock: `model.geo.json` and its texture, the model
   voxelised at 16 pixels to the block (one unit is a block; keep every
   member at least 1/16 thick, or `set minecraft 32`; `--minecraft-entity`
   for an entity, which faces north; a rig's joints are bones and its
   animations go to `model.animation.json`); `--roblox` when it
   is for Roblox Studio: `model.roblox.glb` facing -Z with an
   `anchor(m, "HatAttachment", ...)` as the attachment, one mesh under
   4000 triangles for an accessory (`set grid 40`), a unit a stud.

## Reading the sheet

- Title bar: size as `w × h × d`, triangle count, cell size. A model 10
  tall that should be 1 is wrong before anything else is.
- Front is from +z, right from +x, top from above with the back at the top.
  Grids are whole units; darker lines pass through the origin. The
  perspective view's red, green, blue lines are +x, +y, +z.
- A red frame in `steps.png` is a shape that never reached the output;
  "too fine for this thumbnail" is a tiny part the thumbnail's grid could
  not draw, nothing wrong with the model.
- Slices are the truth about interiors: filled means solid.

## The language in one screen

```
name = expr                      # a step
def part(a, b=1) = expr          # a parametric part
for i in range(6) { ... }        # loops; range(a, b), range(a, b, step), [1, 2.5]
show name                        # the output (default: the last shape)
assert pieces(m) == 1, "why"     # a promise; check fails with the numbers when it breaks

box(w, h, d)  sphere(r)  cylinder(r, h)  cone(r1, r2, h)  capsule(r, h)  torus(R, r)  prism(n, r, h)
circle(r)  rect(w, h)  ngon(n, r)  star(n, r1, r2)  polygon(x,y, ...)  text("Abc", size, arc=r)   # 2D
extrude(profile, h)  revolve(profile, angle=360)  loft(a, b, h)                          # 2D to 3D
tube(r, [x,y,z, ...], smooth=6, taper=1, cap="flat")  sweep(profile, [x,y,z, ...], smooth=6, twist=0, taper=1)
helix(r, h, turns)  arc(r, from, to)  spline(points)                                     # path lists
bezier(points)  curve(points)   tube(r, c)  sweep(profile, c)   text("Ab", 1, face="serif") # exact curves, serifs
import("part.obj", size=2)                                                               # a mesh as a shape
scene a, b, c   place(shape, [x,y,z,yaw, ...])   joint(part, "elbow", x, y, z)          # assemblies
pose("reach", elbow=[0, 0, 40], hand=xform(move=[0, 0.2, 0], scale=1.1))   animation("wave", ["rest", "reach", "rest"], seconds=2, ease=1)
height(s, x, z)  top(s)  bottom(s)  width(s)  depth(s)  tall(s)  angle("elbow")           # read sizes and the pose to place parts
pieces(s)  clearance(a, b)   a < b  a == b  a != b                                        # measure for assert (1 or 0)
set grid 200   set size 768   set focus lid   set pose reach   set azimuth 60             # settings (CLI flags override)
set light_azimuth -40   set light_elevation 55   set ambient 1.5   material("#fc6", glow=1)  # beauty lighting

a + b   a - b   a & b            # union, difference, intersection; union(a, b, k=0.3) blends
a | move(x, y, z) | rotate(y=45) | scale(2) | mirror("x") | round(r) | shell(t)
  | twist(deg) | bend(deg) | wrap(r) | displace(amp, size) | array(n, dx, dy, dz) | grid(nx, nz, dx, dz)
  | ring(n, radius, axis="y") | ground() | center() | paint("wood") | decal(region, "black")
```

y is up, angles are degrees, primitives are centred on the origin and stand
along y, `a | f(x)` is `f(a, x)`, `|` binds tighter than `+ - &`. Rotation
is right-handed: `rotate(x=+θ)` turns +y towards +z, `rotate(y=+θ)` turns
+z towards +x, `rotate(z=+θ)` turns +x towards +y. `extrude(p, h)` lays the
profile flat (its y along -z); `"z"` stands it facing the front; `"x"`
facing +x (its x along -z), the one for a side profile.

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
wrong point has the wrong pivot. `check` prints the joints as a tree
with their pivots, so check the nesting there first. To judge one pose properly render it
at full size with `--pose name` (or `set pose name`); `check --pose name`
prints the posed sizes; `--focus part` makes the pose sheet and strips
close-ups of that part. A pose value may be `xform(rotate=, move=,
scale=)` for a hop or a squash, and an animation takes `times=[...]`
for uneven keys and `ease=1` to settle into each pose (a looping cycle
adds `ease_ends=0` so its seam runs through). Asserts are judged at
rest unless one names its pose: `assert ..., pose=reach`. The language doc's
rig section has the limb sign rules and the axis-joint convention.

```
upper = capsule(0.15, 1.6) | move(0, 1.8, 0) | paint("steel")
fore  = capsule(0.12, 1.2) | move(0, 3.2, 0) | paint("steel")
elbow = joint(fore, "elbow", 0, 2.6, 0)             # pivot is a world point
arm   = joint(upper + elbow, "shoulder", 0, 1, 0)   # the elbow turns with the shoulder
pose("reach", shoulder=[0, 0, -40], elbow=[0, 0, 60])
set pose reach
show arm
```

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
| a shell wall, tube or lettering is broken though the part is thick | its wall, radius or stroke weight is under a cell | `check` names the step and the grid to set; thicken it or raise the grid |
| a small part is a few pixels on the sheet | the whole model sets the framing | `--focus name` or `set focus name` |
| stone or wood reads as flat colour | the pattern is larger than the part | `material("granite", scale=0.3)` |
| eyes, a mouth or a label bulge out of the surface | painted geometry | `decal(shape, region, material)` paints a region of the surface, adds nothing |
| a limb has no knee | one rotated capsule | `tube(r, [hip, knee])` then `tube(r, [knee, ankle])` |
| a label or name must go round a cylinder | text is flat | `extrude(text(...), h, "z") \| wrap(r)` |
| stripes run the wrong way | patterns stack along the material's `axis` (y) in the paint frame | `material(..., axis="x")`, or paint standing, then lay down |
| gold or silver look dull on the sheet | the sheet has no environment to reflect | judge metals in `--beauty` (`--quick --beauty` is a few seconds) |
| a rig part swings about the wrong point | the pivot is not at the hinge | give `joint` the hinge's world point, after the part is in place |

## Style that renders well

Overlap parts slightly rather than butting them; `round=` on boxes and
cylinders, `union(..., k=)` for organic joins; `ground()` last; name steps
for what they are, since the names are what the sheets show you.
