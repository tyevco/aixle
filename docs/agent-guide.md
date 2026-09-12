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
4. **`npx aixle render model.aix`.** Read `out/model/sheet.png`. Then
   `slices.png` if anything is hollow or nested. Then `steps.png` if a part
   is missing or misplaced, to see which step went wrong.
5. **Compare with the plan**, fix the program, go to 3. Stop when the sheet
   matches the plan and `report.md` has no warnings you cannot explain.

## Reading the sheet

- The title bar has the size as `w × h × d` and the cell size. If the model
  is 10 units tall and you meant 1, fix the numbers before anything else.
- **Front** is from +z, **right** from +x, **top** from above with the back
  at the top of the image. The grid is in whole units; the darker lines
  pass through the origin.
- The perspective view's floor grid is at y = 0 (or under the model if it
  goes lower); the red, green and blue lines are +x, +y, +z at the origin.
- A part visible in the steps sheet with a red frame is not in the output:
  you forgot to add it.
- **Slices** are the truth about interiors: a cup that is not hollow, a wall
  that is thicker on one side, a hole that does not go through, a cavity
  that broke out where it should not. Filled means solid.

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

When the model is right, `npx aixle render model.aix --beauty` adds
`beauty.png`, the field ray-marched with shadows, for showing rather than
checking; `viewer.html` next to it orbits the mesh in a browser, and
`model.glb` carries the materials as a baked texture (`model.png`), so it
looks the same wherever it is loaded.

## Style that renders well

- Overlap parts slightly (a peg 0.02 into its hole) rather than touching;
  coincident faces are fine for the geometry but look like seams.
- `round=` on boxes and cylinders, or `union(..., k=)` for organic joins;
  chamfer nothing by hand.
- Give the model a floor: `| ground()` last.
- Keep the whole model within about 1 to 20 units; the grid resolution is
  relative to the longest side, so a giant scene loses small detail.
- Name steps for what they are (`lid`, `left_arm`, `stair_3`), since the
  names are what the steps sheet and the report show you.
