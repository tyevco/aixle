# Building a model with Aixle: the agent's loop

You write a program; the tool draws it; you look; you fix. Nothing about
the model is taken on faith: sizes are printed, every step is drawn, and
the inside is cut open.

## The loop

1. **Plan in words first.** What is it, how big, which way does it face,
   what are its parts. Decide the unit. Decide the front is +z.
2. **Write `model.aix`** part by part, one named step per line. Build each
   part at the origin, then `rotate`, then `move` into place. Paint parts
   before joining them. End with `show model`.
3. **`npx aixle check model.aix`.** Fixes syntax and type errors in a
   second, prints each step's size and every warning. Sizes that look wrong
   here are wrong.
4. **`npx aixle render model.aix --quick`** while iterating: the sheet
   in a second or two. Then the full render: read `out/model/sheet.png`,
   then `slices.png` if anything is hollow or nested, then `steps.png` if a
   part is missing or misplaced, to see which step went wrong, and
   `report.md` for the numbers (does it stand, is it one piece).
5. **Compare with the plan**, fix the program, go to 3. Stop when the sheet
   matches the plan and `report.md` has no warnings you cannot explain.

## The commands

```
npx aixle check model.aix                  sizes and warnings, no pictures (--pose NAME: in that pose)
npx aixle render model.aix --quick         the sheet only, small grid, fast; --watch re-renders on save
npx aixle render model.aix                 sheet, views, slices, steps, turntable, OBJ, GLB, viewer, report
npx aixle render model.aix --focus lid     frame every view on one step or object (or `set focus lid`)
npx aixle render model.aix --pose reach    show a rig in one pose at full size (or `set pose reach`)
npx aixle render model.aix --beauty        plus beauty.png, ray-marched with shadows (--beauty-size 1024 for a big one)
npx aixle render model.aix --quick --beauty   a small beauty render in a few seconds: the way to try materials
npx aixle render model.aix --focus lid --beauty   the beauty render framed on one part (slices cut through it too)
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
  name` frames every view on that step alone.
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
| a small part cannot be judged on the sheet | the whole model sets the framing | `--focus name`, or `set focus name` |
| a stone or wood part reads as flat colour | the pattern's feature size is larger than the part | `material("granite", scale=0.3)` (the preset with a smaller scale) |
| the eyes, mouth or a label need geometry you do not want | a painted sphere bulges, a painted tube sticks out | `decal(shape, region, material)` paints the surface inside a region and adds nothing |
| a material boundary speckles in the views | two painted surfaces nearly coincide, so each vertex picks either | give them a clear angle, or one shape with a `decal`; the beauty render is unaffected |
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
checking; `viewer.html` next to it orbits the mesh in a browser, and
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

Angles are degrees about x, then y, then z, right-handed. Sizes printed
by `check` and shown on the sheet are for the pose being shown; the
exports are at rest and carry the joints and animations.

## Style that renders well

- Overlap parts slightly (a peg 0.02 into its hole) rather than touching;
  coincident faces are fine for the geometry but look like seams.
- `round=` on boxes and cylinders, or `union(..., k=)` for organic joins;
  chamfer nothing by hand.
- `| ground()` when the lowest point should touch the floor. It reads the
  surface itself, so a blend or a cut that leaves the bounding box loose
  does not lift the model; a base already on y = 0 does not need it.
- Keep the whole model within about 1 to 20 units; the grid resolution is
  relative to the longest side, so a giant scene loses small detail.
- Name steps for what they are (`lid`, `left_arm`, `stair_3`), since the
  names are what the steps sheet and the report show you.
