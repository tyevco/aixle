# Building a model with Aixle: the agent's loop

You write a program; the tool draws it; you look; you fix. Nothing about
the model is taken on faith: sizes are printed, every step is drawn, and
the inside is cut open.

## The loop

1. **Plan in words first.** What is it, how big, which way does it face,
   what are its parts. Decide the unit. Decide the front is +z.
2. **Write `model.aix`** part by part, one named step per line. Before
   building a bolt, a chair or a tree, `use "std/hardware"`,
   `"std/furniture"` or `"std/plants"` (`aixle doc std/hardware.aix` lists
   what is there) and place the part; keep your own repeated parts in a
   library file of `def`s next to the program and `use` that. Build each
   part at the origin, then `rotate`, then `move` into place, or better,
   `anchor` the points where parts meet and `attach` them: `seat |
   attach("bottom", legs, "top")` needs no arithmetic and survives a
   change to the legs. `at(part, "name")` is a point for a `tube` between
   two parts. Paint parts before joining them. End with `show model`.
3. **`npx aixle check model.aix`.** Fixes syntax and type errors in a
   second, prints each step's size and every warning. Sizes that look wrong
   here are wrong.
4. **`npx aixle render model.aix --quick`** while iterating: the sheet
   in a second or two (a rig's pose sheet is drawn too, its strips only by
   the full render; `--no-poses` while the geometry is still moving). Then
   the full render: read `out/model/sheet.png`,
   then `slices.png` if anything is hollow or nested, then `steps.png` if a
   part is missing or misplaced, to see which step went wrong,
   `callouts.png` when you are not sure which step a thing in the picture
   is (the perspective view with the largest visible steps named: a
   surface gets the innermost part whose surface it is, the later of two
   in the same box, so a shell or a painted cut is named rather than its
   primitive; a cut face is the cutter's, as `slot (cut)`), and
   `report.md` for the numbers (does it stand, is it one piece).
5. **Say what the model promises**, with `assert`: one piece, a gap
   that must stay open, a size that must hold (`assert pieces(model) ==
   1`, `assert clearance(handle, rim) > 0.05`), a void that must stay
   empty and parts that must not sink into each other (`assert
   void(cavity, mug)`, `assert overlap(frog, pad) < 0.001`, `assert
   inside(spring, box) == 1`; a hole that must go through is `void` on
   a thinner rod reaching past both faces, never on the cutter, which is
   empty by construction; `inside` wants the solid, not a shell; a
   failing `void`, `inside` or `overlap` says where and in which step;
   `assert overhang(part) < 0.05` for a print), and for a rig a promise
   about a pose (`assert abs(at(dog, "sole_fl")[1]) < 0.01, pose=walk_a`:
   in a pose assert a step is measured where the pose puts it). `check`
   fails when one is broken and says by how much, prints every passing
   promise with its numbers, so the next edit cannot silently undo
   what the pictures once showed.
6. **Compare with the plan**, fix the program, go to 3. Stop when the sheet
   matches the plan and `report.md` has no warnings you cannot explain.

## The commands

```
npx aixle check model.aix                  sizes and warnings, no pictures (--pose NAME: in that pose)
npx aixle doc std/furniture.aix            what a library offers: each def with its parameters and the comment above it
npx aixle explain model.aix                the program as a tree from the output down: each step's source line, size, material, anchors; read this first on a program you did not write
npx aixle render model.aix --quick         the sheet only, small grid, fast; --watch re-renders on save
npx aixle render model.aix                 sheet, views, slices, steps, turntable, OBJ, GLB, viewer, report
npx aixle render model.aix --focus lid     frame every view on one step or object (or `set focus lid`)
npx aixle render model.aix --pose reach    show a rig in one pose at full size (or `set pose reach`)
npx aixle render model.aix --no-anims      skip the animation strips (--anim turn draws one); --no-asserts skips the promises: both for a big rig's loop
npx aixle render model.aix --beauty        plus beauty.png, ray-marched with shadows (--beauty-size 1024 for a big one)
npx aixle render model.aix --quick --beauty   a small beauty render in a few seconds to try materials (parts thinner than the quick cell are missing from it)
npx aixle render model.aix --focus lid --beauty   the beauty render framed on one part (slices cut through it too)
                                           with light(), camera() and set environment in the program: several lights, a shot per camera as beauty_<name>.png, a sky
npx aixle render model.aix --grid 200 --size 768   finer mesh, bigger pictures (or `set grid`, `set size`)
npx aixle render model.aix --no-export --no-viewer   pictures only: skips the OBJ, GLB, atlas and viewer page
npx aixle render model.aix --no-poses --out closeup   skip the pose sheets; write somewhere other than out/model/
npx aixle diff before.aix after.aix        the two sheets side by side
```

## Reading the sheet

- The title bar has the size as `w × h × d` and the cell size. If the model
  is 10 units tall and you meant 1, fix the numbers before anything else.
- **Front** is from +z, **right** from +x, **top** from above with the back
  at the top of the image. The grid is in whole units; the darker lines
  pass through the origin.
- The perspective view's floor grid is at y = 0 (or under the model if it
  goes lower); the red, green and blue lines are +x, +y, +z at the origin.
- A part visible in the steps sheet with a red frame is not in the output:
  you forgot to add it. A thumbnail that says "too fine for this
  thumbnail" is a small part in a large step (bolts along a bench) that
  the thumbnail's own grid could not draw; the output is not affected. "No
  surface" in the warning colour means the step really has none.
- **Slices** are the truth about interiors: a cup that is not hollow, a wall
  that is thicker on one side, a hole that does not go through, a cavity
  that broke out where it should not. Filled means solid.
- A small part of a large model is a few pixels on the sheet: `--focus
  name` (or `--focus name_3` for one copy of a placed set) frames every
  view on that step alone, meshed at the frame's own
  finer cell, where the step is in the pose being shown, with the rest
  of the model in the frame drawn faint; the report adds
  a "Close-up watertight" row for that mesh, so a lug or a tooth can be
  judged sound on its own.
- A quick sheet that dropped thin steps says so and does not judge the
  pieces count; teeth, rails and rods at a quick cell are blobs or gone,
  so judge a working end at full grid.
- With joints, `poses.png` shows every pose and `anim_<name>.png` frames
  through each animation, coarsely; to judge one pose properly, `--pose
  name` renders the whole sheet in it, and `check --pose name` prints the
  posed sizes.

## Common mistakes and their fixes

| Symptom | Cause | Fix |
| --- | --- | --- |
| a part is on the wrong side of the model | `rotate` is about the origin, applied after `move` | rotate first, then move |
| a chair faces away from the table | its front was +z and it was placed on the +z side | `rotate(y=180)` for that one |
| the model has no inside in the slices | `shell` was applied after the opening was cut, or the cutter did not reach | shell first, then subtract the opening; make cutters longer than the wall |
| a lid or cap does not touch the body | the sizes do not add up | read the step sizes in `report.md`; overlap parts by a little rather than butting them |
| the whole model is one colour | `paint` was applied to the union | paint each part, then combine |
| a hole is missing | the cutter is thinner than a grid cell | raise the grid, or widen the cutter |
| stripes or checks look stretched | the pattern is in the painted frame, before a non-uniform scale | paint after scaling, or use a smaller `scale=` in `material()` |
| "is not part of the output" | a step never got added to the final shape | add it, or delete it |
| an edge looks jagged | the grid is coarse for the size | `--grid 200` (slower, cubic) |
| a shell wall, a tube or lettering is broken or gone, though the part is thick | the wall, tube radius or stroke weight is under a grid cell | `check` says which step and what grid; thicken it or raise the grid |
| a library part comes out broken, or leaves a loose sliver, in a scene | a slat, rod or wall of the `use`d part is thinner than the scene's cell | `check` names the step and the size; raise the scene's grid, or use a bigger part |
| open edges at a cap, a bolt head or a hub, with nothing thin nearby | the part reaches through a face, or stops short of it, by less than a cell | sink it a cell or more into the host, or leave a cell or more clear |
| open edges "in 'x' twice, as 'a' and 'b'" | two placements of one step cross each other there | move one, or bury one in the other by a cell |
| a small part cannot be judged on the sheet | the whole model sets the framing | `--focus name`, or `set focus name` |
| a stone or wood part reads as flat colour | the pattern's feature size is larger than the part | `material("granite", scale=0.3)` (the preset with a smaller scale) |
| the eyes, mouth or a label need geometry you do not want | a painted sphere bulges, a painted tube sticks out | `decal(shape, region, material)` paints the surface inside a region and adds nothing |
| a fine pattern looks like blocks or camouflage on the sheet | the sheet colours per vertex and the pattern is near the cell size | judge it in the beauty render, or coarsen `scale=` |
| a label, a logo or a face must be a picture, not strokes | patterns are procedural | a PNG beside the program: `decal(part, box, image="label.png")` fits it to the box; `material(..., image="skin.png", projection="cylindrical")` wraps it |
| lettering is a blob on the sheet | a 0.05 stroke at a whole model's cell | `--focus name`: the step at its own cell |
| the report says "separate pieces" for a lidded cup | it is an enclosed void | the report's Cavities row lists it; it is not a loose part |
| the beauty render leaves the model small in the frame | the camera fits the box's corners, so a diagonal model has empty corners | `set zoom 1.2` or `--zoom 1.2` (it stops where the box would touch the edge) |
| the beauty render is flat, or one side is black | one key light from the upper left | `light("key", ...)` and `light("rim", azimuth=150, elevation=20, power=0.5)`; `set environment sunset` or `night` for a mood; `camera("detail", focus="part", zoom=1.5)` for a second shot; `--camera NAME` and `--environment NAME` to try one shot or one sky without editing |
| a night scene is black but for the flame | `night` scales the ambient down to 0.4 | `set ambient 1.6` and a moon at `power=0.9`; a glow lights itself only, never its neighbours |
| a low shot still looks down on the base; a fire cannot be a light | elevation is about the model's centre; a light is a direction | `camera(..., elevation=-8)`; a warm light from above and in front (`azimuth=20, elevation=35`) |
| chrome or silver is a white blob | `studio` and `overcast` are white skies, and a mirror reflects them | `sunset` or `night` for a mirror metal, or `steel`, `iron`, `brass` |
| glass reads frosted and opaque in `--quick --beauty` | the quick grid is 64 cells and the wall is under a cell | judge glass at the full grid; keep a glowing part a cell clear of its glass |
| contour lines behind glass | a `loft` or a smooth union is a bound, not a distance; or two faces coincide | a rounded box or an exact primitive under `transmit`; grow a liquid a cell into its cavity and promise `inside(liquid, cavity) > 0.9` |
| "is not part of the output" for a probe or a cavity region | it was warned as unused | it no longer is: a step an assert, a decal or a camera reads is a region, tagged `(region)` in `check` and on the steps sheet |
| a fine speckle renders as square blocks | `speckle` is a cubic block pattern at `scale` | `"noise"` at a small scale for a soft mottle; `scale` is the block size |
| a part stuck on a curved body reads as a disc | two convex surfaces meeting | a skin of the body's own surface: `(offset(body, 0.05) - offset(body, -0.012)) & oval`, `intersect(..., k=)` for the rim |
| a material boundary speckles in the views | two painted surfaces nearly coincide (under 35 degrees apart), so each vertex picks either | give them a clear angle, or one shape with a `decal`; a seam at a crease is clean, and the beauty render is unaffected |
| a box or a join reads soft, as if bevelled, in the viewer or a GLB | one smooth normal per vertex, from `set crease 0` | leave `crease` at its default (35), which splits vertices at edges |
| a limb built with `rotate` and `move` has no knee | one capsule per limb | `tube(r, [hip, knee])` and `tube(r, [knee, ankle])`: a point list is the joint chain |
| "watertight: no" with edges you cannot find | two surfaces pass through one cell | the report says where the edges are and which steps hold them |
| letters or a label need to go round a cylinder | text is flat | `extrude(text(...), h, "z") \| wrap(r)`; `bend(deg)` curves about z instead |
| stripes run the wrong way, or a pattern is missing on a thin sheet | patterns are stacked along the material's axis (y) in the paint frame | `material(..., axis="x")`, or paint the part standing and then lay it down |
| the counter under the awning is black, the flame is a dark blob | the key light is fixed at the upper left and nothing glows | `set light_azimuth`, `set light_elevation`, `set ambient 2`; `material("#ffc860", glow=1.5)` for the flame |
| gold looks olive, silver looks charcoal | a metal is mostly what it reflects, and the sheet has no environment | judge metals in the beauty render, which reflects the sky, ground and the model itself |
| "separate pieces" but everything looks joined | a part stops a hair short of its neighbour | the warning names the loose piece's volume, centre and step; overlap by a little |
| a rig's part swings about the wrong point | the joint's pivot is not where the part turns | give `joint` the world point of the hinge, after the part is moved into place |
| `set pose reach` shows the rest pose | the pose is not named that | the warning lists the poses that exist |

When the model is right, `npx aixle render model.aix --beauty` adds
`beauty.png`, the field ray-marched with shadows, for showing rather than
checking; `viewer.html` next to it orbits the mesh in a browser and
plays a rig's animations (loop, speed, a scrub bar, all in turn), and
`model.glb` carries the materials as a baked texture (`model.png`), so it
looks the same wherever it is loaded.

## Rigs

```
upper  = capsule(0.15, 1.6) | move(0, 1.8, 0) | paint("steel")        # built in place
fore   = capsule(0.12, 1.2) | move(0, 3.2, 0) | paint("steel")
elbow  = joint(fore, "elbow", 0, 2.6, 0)                              # pivot: a world point
arm    = joint(upper + elbow, "shoulder", 0, 1, 0)                    # the inner joint turns with it
pose("reach", shoulder=[0, 0, -40], elbow=[0, 0, 60])
animation("wave", ["rest", "reach", "rest"], seconds=2)
set pose reach
show arm
```

Angles are degrees about x, then y, then z, right-handed, and a nested
joint's angles are relative to its parent. A pose value can be a whole
transform, `hand=xform(rotate=[0, 0, 20], move=[0, 0.2, 0], scale=1.1)`,
for a hop, a squash or a breath; an animation takes `times=[0, 0.15,
0.6]` for uneven keys and `ease=1` to settle into each pose instead of
turning sharply (`ease_ends=0` keeps a loop's seam moving), and the
strip's bar says which. An assert is judged at rest; one about a pose
names it, `assert clearance(hand, face) > 0.02, pose=reach`. `angle("elbow")` reads the
current pose's angles, which is how a member between two moving parts (a
hydraulic cylinder) finds its end points; the language doc has the
cylinder written out. Sizes printed by `check` and
shown on the sheet are for the pose being shown: a step built at rest and
turned by a joint above it keeps its rest box and gets a `posed` line
saying where it ends up, and a step whose box is a turned box gets a
`surface` line with the true extent. The exports are at rest
and carry the joints and animations. Loose pieces and open edges are
named by the innermost step whose surface passes there, in the pose
shown, so a lug welded to a boom is blamed as the lug, not the boom.

## Style that renders well

- Overlap parts by at least a grid cell (a peg 0.05 into its hole) rather
  than touching: coincident faces are exact for the booleans but leave a
  few non-manifold edges in the mesh and look like seams.
- `round=` on boxes and cylinders, or `union(..., k=)` for organic joins;
  chamfer nothing by hand.
- `| ground()` when the lowest point should touch the floor. It reads the
  surface itself, so a blend or a cut that leaves the bounding box loose
  does not lift the model; a base already on y = 0 does not need it.
- Keep the whole model within about 1 to 20 units; the grid resolution is
  relative to the longest side, so a giant scene loses small detail.
- Name steps for what they are (`lid`, `left_arm`, `stair_3`), since the
  names are what the steps sheet and the report show you.
