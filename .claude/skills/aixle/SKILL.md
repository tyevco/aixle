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

Reference: `docs/reference.md` (every function, generated from the code;
`npx aixle doc NAME` prints one entry),
`docs/language.md` (the language), `examples/*.aix` (ten worked models).

## The loop

1. **Plan in words.** What is it, how big, which way is its front (+z),
   what are its parts. Draw in its real unit: millimetres for a print
   (`set units mm`; a 117 mm stand is 117 units), metres or centimetres
   for furniture, a room or a game prop. Nothing in the mesh, what the
   checks find or the pictures depends on the size (the grid is cells along the
   longest side); what does is the defaults given in units, a material
   preset's pattern (wood grain 0.25) and `text`'s size 1, so in
   millimetres give `scale=` and `size=`. The report and the warnings
   print a number under 0.0005 as 0, so a part under about 10 cm reads
   its volume, and under 6 cm its cell, as 0 in metres: draw it in
   centimetres or millimetres.
2. **Write `model.aix`**, one part per named line. For a bolt, a chair,
   a tree or the like, `use "std/hardware"`, `"std/furniture"` or
   `"std/plants"` first (`npx aixle doc std/hardware.aix` says what each
   has and how it is placed) rather than building it; put parts you
   repeat in a library file of `def`s beside the program and `use` it
   (a part with intermediates or a loop is `def part(p) { ... return x
   }`; a name starting with `_` stays the library's own). Look up a
   builtin you are unsure of with `npx aixle doc sweep` (its entry:
   what it does, every signature, each parameter; a misspelt name gets
   the nearest names) rather than guessing its arguments.
   Build each part at the
   origin, then `rotate`, then `move` into place; where two parts meet,
   `anchor` the meeting points and `attach` one to the other instead of
   computing the move (`lamp | attach("bottom", arm, "tip")`); where a
   part rests on, slides against or leans on another, let the surfaces
   place it instead of the arithmetic: `bowl | rest(plate)`, `book |
   rest(prev, dir=[-1, 0, 0], sink=-0.06)` (0.06 short of it), `book |
   lean(prev, pivot="heel", axis=[0, 0, 1])` (`check` prints how far each
   moved or turned; the contact then holds to a millionth of the part).
   Use `at(part, "name")` as the end of a `tube`. Paint parts before
   joining them. End with `show model`.
3. **`npx aixle check model.aix`**: syntax and type errors, every step's
   size (profiles and numbers too), every warning, in a second, and for
   each `camera(..., focus=)` how much of its focus the rest of the model
   hides from its angle (aim a shot here, not with beauty runs). Sizes
   that look wrong are wrong. A `surface` line under a step is its surface's
   own extent where the box is the box of a turned box (from rays, a
   union's thin parts each on its own box; a thin plate inside a cut part
   can still slip between them); with `--pose`, a `posed` line is where a
   step ends up once the joints above it have turned.
4. **`npx aixle render model.aix --quick`** while iterating (the sheet in
   a second or two; on a rig add `--no-poses` until the geometry settles,
   the strips come with the full render; the asserts are judged at full
   cost, so add `--no-asserts` while placing parts when the run says they
   took most of it), then read `out/model/sheet.png`. Drop `--quick` for
   the full render: read `slices.png` if anything is hollow or nested
   (`--slice step` puts its planes through one step, framed on it, and
   through where it meets the rest of the model, so a stem is cut where
   it meets the soil and a leaning book where it stands on the shelf),
   `steps.png` if a part is missing or misplaced, `callouts.png` to read
   which step a thing in the picture is; `report.md` has the
   numbers, including whether the model stands and is in one piece; a
   quick sheet that dropped thin steps says so and does not judge the
   pieces. `--focus step` (on a region or a cutter: the model inside its
   frame) is a close-up meshed at its own finer cell,
   where the step is in the pose shown, the rest of the model faint
   around it, with its own watertight row.
   A render removes what the last render wrote into its folder and this
   one did not, so `out/model/` holds only the run you just made.
   `npx aixle diff before.aix after.aix` shows two versions side by side;
   `npx aixle fmt model.aix --write` lays the program out in the one
   layout (comments kept, meaning unchanged) before you hand it on;
   `--check` says `formatted`, or shows each line that differs.
   On a program you did not write, `npx aixle explain model.aix` first: the
   tree from the output down, each step with its source line, size,
   material and anchors, so you know which step feeds which before you
   render anything.
5. **Promise it with `assert`** once a thing is right: `assert
   pieces(model) == 1`, `assert clearance(handle, rim) > 0.05`, `assert
   void(cavity, mug)` (nothing pokes into the cup), `assert overlap(frog,
   pad) < 0.001` (on the pad, not sunk in), `assert
   tall(model) < 2.2`, `assert overhang(part) < 0.05` (printable without
   support), `assert wall(model) > 0.8` (walls a 0.4 mm nozzle lays in
   two lines, with `set units mm`; the number is in model units),
   `assert support(part) < 50` (the support volume, mm³ with `set units
   mm`, bridges up to 16 mm left out), `assert islands(part) == 0` (no
   point hanging lower than all around it, a cone's tip, which no face
   angle catches), `assert stands(model) > 0.1` (the centre of mass that
   far inside the footprint). A hole that must go through is `void` on a thin rod past
   both faces, not on the cutter (empty by construction); `inside` wants
   the solid, not a shell; a probe step only an assert reads is a region
   and is not warned about; `render --show probe` draws it in place with
   the output for a picture, the program unchanged. `check` then fails, with the numbers and
   where, when a later edit breaks it; a promise inside a loop is one line
   (how many times it held, the judgement nearest to failing), the
   failures come last in full, and a slow or stuck assert is named on
   the error stream. Edit `.aix` files with the Edit
   tool: `sed` trips on their `|` pipes.
6. **Compare with the plan.** Fix, back to 3. Done when the sheet matches
   the plan and the report has no warning you cannot explain. Then
   `--beauty` for the presentation picture: the field ray-traced and
   shaded as the viewer and engines shade the GLB, in full quality on
   all cores (at most four; `--threads N`, the same bytes on any
   number). `--beauty-only` is the lighting loop, the sheet and the one
   shot, also in full, so the picture it settles is the full run's;
   `--quick --beauty` is a draft (one reflection bounce, one glossy
   ray, one glass deep; `--quality full` over it, `--quality draft`
   for any run), and `lights.png` and `environments.png` are always
   draft. Add `--minecraft` when the
   model is for Bedrock: `model.geo.json` and its texture, the model
   voxelised at 16 pixels to the block (one unit is a block; keep every
   member at least 1/16 thick, or `set minecraft 32`; `--minecraft-entity`
   for an entity, which faces north; a rig's joints are bones and its
   animations go to `model.animation.json`); `--roblox` when it
   is for Roblox Studio: `model.roblox.glb` facing -Z with an
   `anchor(m, "HatAttachment", ...)` as the attachment, one mesh under
   4000 triangles for an accessory (`set grid 40`), a unit a stud. For a
   print, `set units mm` (what one unit is: mm, cm, dm, m, in or ft)
   and `set bed 220 220 250` (the build volume in millimetres): only
   then is the model judged as a print (or with `--3mf`, a unit then
   taken as a millimetre); `check` prints the size in millimetres and
   whether it fits, the report's Print section has the thinnest wall
   and where, the support under the overhangs (the bridges and the
   islands apart) and what rests on the plate, `model.stl` is in
   millimetres with z up, and `model.3mf`
   carries the unit and the materials' colours. A model that is not a
   print gets one line in the report saying so, and no Print section.
   The GLB, OBJ and viewer are decimated past 200 thousand triangles
   (`--triangles N` or `set triangles N`, 0 for all; the cap is shared
   by error over every mesh, flat faces first, and the report's Exports
   row says how far they stray, each mesh's share and the cap below
   which detail starts to go; past it merged faces carry the field's
   normal in the normal map but their outlines are coarser, so read the
   viewer). The GLB carries the program's lights in linear light: a
   directional one lights every face angle as `beauty.png` does; a
   point light, under an engine's inverse square, is twice as bright at
   its `range`, five times at half of it, the same at about 1.8 ranges,
   dark from three.
   `viewer.html` (three.js 0.187.0) is on `beauty.png`'s tone curve.
   Its Scene mode, which it opens in when the program declares lights
   or a sky, is `beauty.png` drawn from the export: the same sky, lights,
   point-light falloff and glow strength, the cameras and `◎ beauty.png`
   as buttons, non-metals within 1 to 4 levels on average where
   nothing occludes them; it cannot show occlusion (a candle in a
   cage reads 17 to 29 levels brighter,
   lettering on a medal barely reads), soft shadows, the model reflected
   in itself (metals read brighter), bloom, glass, or the sun's disc and
   the stars, and a steep shot's turned key is `beauty.png`'s alone. Its
   Studio mode, calibrated so non-metal presets show their base colours,
   is for judging the maps. Judge form, lettering, metals and glass in
   `beauty.png`. Small round parts keep the
   mesh's polygon outline in the export where the beauty render draws
   them round. An `import()`
   is sampled once and cached on disk for the next `check` or `render`
   (`--no-cache` samples afresh).

## Reading the sheet

- Title bar: size as `w × h × d`, triangle count, cell size. A model 10
  tall that should be 1 is wrong before anything else is.
- Front is from +z, right from +x, top from above with the back at the top.
  Grid lines are the step each view's caption names (`grid 0.25`);
  darker lines pass through the origin. The
  perspective view's red, green, blue lines are +x, +y, +z.
- A red frame in `steps.png` is a shape that never reached the output;
  "too fine for this thumbnail" is a tiny part the thumbnail's grid could
  not draw, nothing wrong with the model.
- Slices are the truth about interiors: filled means solid.
- `lights.png` (two or more lights) is one half-size draft render of
  the shot `beauty.png` shows, each light's light kept apart: the top
  row each light alone, then all; the bottom row exactly what each
  light adds, floor included, at the gain printed (`spark adds, ×2.6`),
  a flame showing the light on its own colour; last, the shot under no
  light at all. A silhouette against a glow can be tens of levels
  brighter there than in `beauty.png`: judge edges in `beauty.png`.

## The language in one screen

```
name = expr                      # a step
def part(a, b=1) = expr          # a parametric part
def part(a) { ... return x }     # one with names and loops of its own: a statement per line, return last
for i in range(6) { ... }        # loops; range(a, b), range(a, b, step), [1, 2.5]
all = all + named("leg_" + i, leg) # a step per copy a loop makes; a name first assigned in a loop is the loop's own
seat = {w: 0.9, h: 0.45}         # a record: seat.h, legs[0].x, {...seat, h: 0.6} for a changed copy
show name                        # the output (default: the last shape)
assert pieces(m) == 1, "why"     # a promise; check fails with the numbers when it breaks

box(w, h, d)  sphere(r)  cylinder(r, h)  cone(r1, r2, h)  capsule(r, h)  torus(R, r)  prism(n, r, h)
circle(r)  rect(w, h)  ngon(n, r)  star(n, r1, r2)  polygon(x,y, ...)  text("Abc", size, arc=r)   # 2D
curve2([x,y, ...])  bezier2([x,y, ...])  curve2(points, wall=0.1)   # smooth outlines: a point twice is a corner; wall= an open band
extrude(profile, h)  revolve(profile, angle=360)  loft(a, b, h)                          # 2D to 3D
tube(r, [x,y,z, ...], smooth=6, taper=1, cap="flat")  sweep(profile, [x,y,z, ...], smooth=6, twist=0, taper=1)
helix(r, h, turns)  arc(r, from, to)  spline(points)                                     # path lists
bezier(points)  curve(points)   tube(r, c)  sweep(profile, c)   text("Ab", 1, face="serif") # exact curves, serifs
import("part.obj", size=2)                                                               # a mesh as a shape
scene a, b, c   place(shape, [x,y,z,yaw, ...])   joint(part, "elbow", x, y, z)          # assemblies
pose("reach", elbow=[0, 0, 40], hand=xform(move=[0, 0.2, 0], scale=1.1))   animation("wave", ["rest", "reach", "rest"], seconds=2, ease=1)
height(s, x, z)  top(s)  bottom(s)  width(s)  depth(s)  tall(s)  angle("elbow")           # read sizes and the pose to place parts
pieces(s)  overhang(s)  wall(s)  support(s)  islands(s)  stands(s)  clearance(a, b)  void(region, s)  overlap(a, b)  inside(a, b)   a < b  a == b   # measure for assert
set grid 200   set size 768   set focus lid   set slice stem   set pose reach   set azimuth 60   # settings (CLI flags override)
set units mm   set bed 220 220 250                                                       # a print: the report's Print section, model.stl in mm, model.3mf
set light_azimuth -40   set light_elevation 55   set ambient 1.5   material("#fc6", glow=1)  # beauty lighting
light("key", azimuth=-40, elevation=55, size=1.5, color="#fff2e0")  light("rim", azimuth=150, elevation=20, power=0.5)  light("fire", position=[0, 0.4, 0], range=2)   # several lights, a point light; lights.png shows each alone
camera("hero", azimuth=30, elevation=20, zoom=1.4)  camera("detail", focus="part", zoom=2)  set camera hero  set environment sunset   # shots and a sky; set camera's shot is beauty.png, written once (--camera NAME, --environment NAME|a,b|all; --beauty-only: that one shot and the sheet, --lights to add lights.png)
decal(part, label_box, image="label.png")   material("cream", image="skin.png", projection="cylindrical", scale=0.6)   # a PNG as a label or a skin
material("rust", wear=0.4, bump=0.003, bump_scale=0.05)   # a finish: worn edges, rust, bumps below the mesh (beauty and GLB only, not the sheet)

a + b   a - b   a & b            # union, difference, intersection; union(a, b, k=0.3) blends
a | move(x, y, z) | rotate(y=45) | scale(2) | mirror("x") | round(r) | shell(t)
  | twist(deg) | bend(deg) | wrap(r) | displace(amp, size) | array(n, dx, dy, dz) | grid(nx, nz, dx, dz)
  | ring(n, radius, axis="y") | ground() | center() | paint("wood") | decal(region, "black")
  | rest(on, dir=[0, -1, 0], sink=0) | lean(on, pivot="heel", axis=[0, 0, 1])   # moved or turned until it touches `on`
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
at full size with `--pose name` (or `set pose name`), meshed at the rest
pose's cell so an unmoved part reads as it does at rest; `check --pose name`
prints the posed sizes; `--focus part` makes the pose sheet and strips
close-ups of that part. A pose value may be `xform(rotate=, move=,
scale=)` for a hop or a squash, and an animation takes `times=[...]`
for uneven keys and `ease=1` to settle into each pose (a looping cycle
adds `ease_ends=0` so its seam runs through; a two-key one-shot that
should settle holds its last pose as a third key). Asserts are judged at
rest unless one names its pose: `assert ..., pose=reach`, where a step
is measured where the pose puts it. `pose("hold", from="reach", ...)`
adds to a pose. The language doc's
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
| a revolved or extruded outline looks faceted | `polygon` is straight between points | `curve2([...])` through the same points, or `bezier2` from handles |
| a smooth profile's base rocks, or its box passes x = 0 | the spline overshoots at a sharp turn | give the axis points and the foot's edge twice: corners, straight between |
| a label or name must go round a cylinder | text is flat | `extrude(text(...), h, "z") \| wrap(r)` |
| stripes run the wrong way | patterns stack along the material's `axis` (y) in the paint frame | `material(..., axis="x")`, or paint standing, then lay down |
| gold or silver look dull on the sheet | the sheet has no environment to reflect | judge metals in `beauty.png`, which reads them: gold deep yellow, brass greener, `steel` grey, `iron` dark (`--beauty-only` is the one shot in full quality; `--quick --beauty-only` is a draft in a few seconds that cannot judge glass: its grid is coarse) |
| the model looks new, like plastic | one smooth colour everywhere | `wear=0.4` (edges bright, creases dark), `bump=` (roughness below the mesh), `"rust"`; judge in `--beauty`, never on the sheet; the GLB carries them as maps (the report's Maps row) |
| a thin rod or ring is worn bright all over | wear's band is ~1.2% of the model's size; thinner than two bands is all edge | thicken it, or less wear on that part |
| chrome reads as a dark mirror, silver as a bright one | in the `studio` a mirror shows a dark room round the camera, bright cards and each light's softbox | that is metal reading as metal; a `size=3` key gives a larger highlight |
| chrome, silver or steel reads near white | `overcast` is the white sky for mirror metals | `studio`, `sunset` or `night` for a mirror, or a rougher metal |
| metal lettering or a metal face turned to the camera reads dark | it mirrors the dark room behind the camera (the patterns plate's iron labels) | paint the letters a non-metal, or turn the face towards the light |
| a polished engraving is faint, or sparkles | face and groove floor mirror the same room; only the walls and the cavity term (a groove's reflections and the highlights on its lips dimmed) tell them apart; an open lip facing a light still glints | `rough=0.2` or more, or cut it deeper |
| a point light's pool is wider than expected | its strength halves `range` away in linear light, which shows wide | a `range` about the size of what it should light, more `power`, and `size` up as `range` falls to keep the shadows soft |
| a soft shadow is too hard or too soft | `size` is an angle: an angular radius of size/18 radians (1 about 3.2 degrees, 3 about 9.5) for the shadow, the highlight and the softbox | a larger `size` is softer (3 a window), a smaller harder (0.5 a lamp) |
| a night scene is black; a low shot looks down | `night` cuts the ambient; elevation is about the centre | `set ambient 1.6`; `elevation=-8`; a glow lights only itself, so a lamp or a fire lighting its neighbours is `light(..., position=[x, y, z], range=2)` just outside it |
| a plan shot's blind holes read as domes | lit from the frame's bottom, a hole reads as a dome (round 10's hub, with its own key) | no `light()` and no `set light_azimuth`/`light_elevation`: a camera above 55 turns the default key to the frame's top left itself; with your own lights, key at the camera's azimuth less 135 |
| slices show a plant or a lamp as a floating blob | the planes go through the model's centre, off its stem | `--slice plant`: the planes through that step's own solid |
| a small point light cannot be judged in `lights.png` | it changes a few pixels of the whole picture | the bottom row is exactly what each light adds, floor included, brightened by the gain shown |
| `overlap(a, b)` fails at 0 | they only touch, stand apart, or overlap thinner than the lattice: the failure says which | sink one into the other, or promise a chunk of the part |
| a rig part swings about the wrong point | the pivot is not at the hinge | give `joint` the hinge's world point, after the part is in place |
| a part meant to sit on or lean on another floats, sinks a hair, or needs trigonometry | the contact is worked out by hand | `rest(on)` / `lean(on, pivot, axis)`: moved or turned until it touches, a millionth of its size from touching (a ten-thousandth on a displaced skin), at any scale |
| `lean` turns the long way round, or never touches | it turns the right-handed way about `axis`, as `rotate` does | the other sign, `axis=[0, 0, -1]`; check's line flags a turn past a quarter |
| `rest` lands a part on what it should pass, or backs it out | `on` holds what it falls past, or it started inside `on` (check's line says) | leave that out of `on`; start the part clear |
| a copy should be left out of a loop, or a value differ by a test | there is no `if`; a comparison is 1 or 0 | a number `(t > 0) * a + (t <= 0) * b`; a shape, a material or a record `[if_false, if_true][t > 0]`; leave a copy out with `[part, empty()][i == k]` (a copy scaled to 0 collapses onto the origin) |
| one copy a loop made cannot be sliced, focused or found in a warning | a name first assigned in a loop is the loop's own, not a step | `books = books + named("book_" + i, bk)`: a step per copy, `--slice book_9` |

## Style that renders well

Overlap parts slightly rather than butting them; `round=` on boxes and
cylinders, `union(..., k=)` for organic joins; `ground()` last; name steps
for what they are, since the names are what the sheets show you, and a
part's sizes too: `seat = {w: 0.9, h: 0.45}` read as `seat.h` says what
each number is.
