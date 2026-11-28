# Building a model with Aixle: the agent's loop

You write a program; the tool draws it; you look; you fix. Nothing about
the model is taken on faith: sizes are printed, every step is drawn, and
the inside is cut open.

## The loop

1. **Plan in words first.** What is it, how big, which way does it face,
   what are its parts. Decide the unit: the real one (millimetres for a
   print, with `set units mm`). Decide the front is +z.
2. **Write `model.aix`** part by part, one named step per line. Before
   building a bolt, a chair or a tree, `use "std/hardware"`,
   `"std/furniture"` or `"std/plants"` (`aixle doc std/hardware.aix` lists
   what is there) and place the part; keep your own repeated parts in a
   library file of `def`s next to the program and `use` that (a part
   with intermediates or a loop is `def part(p) { ... return x }`; a
   name starting with `_` stays the library's own). Before calling a
   builtin whose parameters you are not sure of, look it up:
   `aixle doc sweep` prints its entry (what it does, every signature,
   each parameter), and a misspelt name gets the names nearest it, so
   there is no need to guess an argument or read the whole reference.
   Build each part at the origin, then `rotate`, then `move` into place, or better,
   `anchor` the points where parts meet and `attach` them: `seat |
   attach("bottom", legs, "top")` needs no arithmetic and survives a
   change to the legs. Where a part rests on, slides against or leans on
   another, let the surfaces place it instead of working out the
   contact: `bowl | rest(plate)` drops it until it touches, `book |
   rest(prev, dir=[-1, 0, 0], sink=-0.06)` slides it to 0.06 short of its
   neighbour, `book | lean(prev, pivot="heel", axis=[0, 0, 1])` tips it
   about its heel until it touches. `check` prints how far each moved or
   turned, and the promise of contact holds by construction (round 11's
   leaning books, placed by trigonometry, were 0.007 off; by `rest`,
   1e-6). `at(part, "name")` is a point for a `tube` between two parts.
   Paint parts before joining them. End with `show model`.
3. **`npx aixle check model.aix`.** Fixes syntax and type errors in a
   second, prints each step's size and every warning. Sizes that look wrong
   here are wrong. Under its cameras' line, each `camera(..., focus=)`
   says how much of its focus the rest of the model hides from its angle,
   and which azimuth hides less, so a shot is aimed before any beauty run.
4. **`npx aixle render model.aix --quick`** while iterating: the sheet
   in a second or two (a rig's pose sheet is drawn too, its strips only by
   the full render; `--no-poses` while the geometry is still moving; the
   asserts are judged at full cost, and `--no-asserts` leaves them out
   while placing parts when the run says they took most of it). Then
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
   `assert overhang(part) < 0.05`, `assert wall(model) > 0.8`,
   `assert support(part) < 50` (cubic millimetres with `set units mm`,
   bridges up to 16 mm left out) and `assert islands(part) == 0` (no
   point hanging lower than all around it, a cone's tip, which no face
   angle catches) for a print, `assert stands(model) > 0.1` for a model
   that must stand), and for a rig a promise
   about a pose (`assert abs(at(dog, "sole_fl")[1]) < 0.01, pose=walk_a`:
   in a pose assert a step is measured where the pose puts it). `check`
   fails when one is broken and says by how much, prints every passing
   promise with its numbers (a promise in a loop once, with how many
   times it held and the judgement nearest to failing; the failures last,
   in full), so the next edit cannot silently undo what the pictures
   once showed. An assert that is slow, or does not return, is named on
   the error stream with its time.
6. **Compare with the plan**, fix the program, go to 3. Stop when the sheet
   matches the plan and `report.md` has no warnings you cannot explain.
   For a print, say what a unit is and what the printer holds (`set units
   mm`, or cm, dm, m, in, ft; `set bed 220 220 250` in millimetres): only
   then is the model judged as a print (or with `--3mf`). `check` then
   prints the size in millimetres and whether it fits the bed, and the
   report's Print section has the thinnest wall and where it is, the
   support under the overhangs (with the bridges and the islands apart)
   and what rests on the plate; `model.stl`
   is in millimetres with z up and `model.3mf` carries the unit and the
   colours. Promise the walls with `assert wall(model) > 0.8` (model
   units: 0.8 mm is two lines of a 0.4 mm nozzle). A game asset or a
   piece of furniture sets neither, and its report says in one line
   that it was not judged as a print.

## The commands

```
npx aixle check model.aix                  sizes and warnings, no pictures (--pose NAME: in that pose)
npx aixle doc sweep                        one builtin's entry: what it does, every signature, its parameters (several names at once; a misspelt one gets the nearest names)
npx aixle doc std/furniture.aix            what a library offers: each def with its parameters and the comment above it, each constant with its value
npx aixle explain model.aix                the program as a tree from the output down: each step's source line, size, material, anchors; read this first on a program you did not write
npx aixle render model.aix --quick         the sheet only, small grid, fast; --watch re-renders on save
npx aixle render model.aix                 sheet, views, slices, steps, turntable, OBJ, GLB, viewer, report
npx aixle render model.aix --focus lid     frame every view on one step or object (or `set focus lid`)
npx aixle render model.aix --pose reach    show a rig in one pose at full size (or `set pose reach`)
npx aixle render model.aix --no-anims      skip the animation strips (--anim turn draws one); --no-asserts skips the promises while placing parts (a quick pass that spent most of its time on them says so)
npx aixle render model.aix --beauty        plus beauty.png, the field ray-traced and shaded as the viewer and engines shade the GLB, in full quality on all cores, at most four, the same bytes on any number (--beauty-size 1024 for a big one)
npx aixle render model.aix --quick --beauty   a small beauty render in a few seconds to try materials, in draft: one reflection bounce, one glossy ray, one glass deep (--quality full for the full one; parts thinner than the quick cell are missing from it; with lights and cameras it draws lights.png and every shot too, so --beauty-only for one)
npx aixle render model.aix --focus lid --beauty   the beauty render framed on one part (slices cut through it too)
npx aixle render model.aix --slice stem    slices.png through one step, framed on it, the rest of the model faint
npx aixle render model.aix --show probe,cable   the output with those steps drawn in place: a probe seen without editing the program
                                           with light(), camera() and set environment in the program: several lights, a shot per camera as beauty_<name>.png (set camera's is beauty.png), a sky
npx aixle render model.aix --beauty-only --camera hero   one shot (written once, as beauty.png) and the sheet, nothing else, in full quality on all cores (at most four): the full run's picture, so what the lighting loop settles carries over (--lights adds lights.png)
npx aixle render model.aix --beauty-only --environment studio,overcast   environments.png under those skies in one run (or all), each a half-size draft frame
npx aixle render model.aix --beauty --quality draft   beauty.png and the shots in draft, or --quality full over --quick (lights.png and environments.png are always draft)
npx aixle render model.aix --beauty --threads 2   the beauty renders on that many threads (default: the cores, at most 4); the bytes are the same on any number
npx aixle render model.aix --grid 200 --size 768   finer mesh, bigger pictures (or `set grid`, `set size`)
npx aixle render model.aix --no-export --no-viewer   pictures only: skips the OBJ, GLB, atlas and viewer page
npx aixle render model.aix --3mf           also model.3mf, and the report judges it as a print (both anyway with `set units` or `set bed`); model.stl is always written, in mm, z up
npx aixle render model.aix --triangles 50000   a lighter GLB, OBJ and viewer, decimated (default cap 200000; 0 keeps every triangle)
npx aixle render model.aix --no-poses --out closeup   skip the pose sheets; write somewhere other than out/model/
npx aixle diff before.aix after.aix        the two sheets side by side
npx aixle fmt model.aix --write            the program in the one layout (comments kept, meaning unchanged); --check says formatted, or fails with each line that differs
```

An `import()` is sampled once per file and resolution and cached on
disk, so `check` and the `render` after it do not both pay for a large
mesh; `--no-cache` samples afresh.

## Reading the sheet

- The title bar has the size as `w × h × d` and the cell size. If the model
  is 10 units tall and you meant 1, fix the numbers before anything else.
- **Front** is from +z, **right** from +x, **top** from above with the back
  at the top of the image. The grid lines are the step each view's
  caption names (`grid 0.25`); the darker lines pass through the origin.
- The perspective view's floor grid is at y = 0 (or under the model if it
  goes lower); the red, green and blue lines are +x, +y, +z at the origin.
- Each thumbnail on the steps sheet is captioned with its number and name,
  its size `w × h × d`, and on a third line what it is when it is not a
  part: `cut` (drawn as the solid it removes), `mask`, `region` (framed
  grey) or `unused`. A long name ends in "…"; a size never does.
- A part visible in the steps sheet with a red frame is not in the output:
  you forgot to add it. A thumbnail that says "too fine for this
  thumbnail" is a small part in a large step (bolts along a bench) that
  the thumbnail's own grid could not draw; the output is not affected. "No
  surface" in the warning colour means the step really has none.
- **Slices** are the truth about interiors: a cup that is not hollow, a wall
  that is thicker on one side, a hole that does not go through, a cavity
  that broke out where it should not. Filled means solid. To cut through
  one part (a plant's stem down into the soil it stands in), `--slice
  plant` or `set slice plant`: the planes go through that step's solid,
  framed on it, its cut in full and the rest faint; where the step meets
  the rest of the model (a book on its shelf) the planes across the
  contact go through the contact, so the cut shows what it rests on.
- **`lights.png`** (two or more lights, with `--beauty`; with
  `--beauty-only` only if `--lights`) is one half-size draft render
  that keeps each light's light apart, and every frame is the shot
  `beauty.png` shows. The top row is the shot under each light alone
  and then under all of them. The bottom row is exactly what each light
  adds, its share of that one render on the model and the floor alike,
  brightened by the gain printed under it (`spark adds, ×2.6`: a gain
  of 1 to 32 that shows the 99th percentile of what it brings at about
  230 of 255), so a small point light's reach and colour fill the
  frame; a flame a light falls on shows that light on the flame's own
  colour. The last frame is the shot under no light at all: the sky's
  light, the glows and the sky in the metals. In every frame but "all",
  which is `beauty.png`'s own picture, a silhouette against a glow can
  be a few tens of levels brighter than in `beauty.png` (such a frame
  means an edge pixel's samples before the tone curve, the render after
  it), so judge edges in `beauty.png`.
- The shot `set camera` names is `beauty.png`, captioned with the
  camera's name, and is not written again as `beauty_<name>.png`.
- A render into a folder removes what the last render wrote there and
  this one did not (the log says which), so every picture in `out/model/`
  is from the run you just made.
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
  name` renders the whole sheet in it, meshed at the rest pose's cell
  (the title says `as at rest`), so a part the pose does not move reads
  as it does at rest, and `check --pose name` prints the posed sizes.

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
| open edges at a cap, a bolt head or a hub, with nothing thin nearby | the part reaches through a face by less than a cell, or stops short of it by less than a cell and a half | sink it a cell or more into the host, or leave a cell and a half or more clear (curved faces still seam at 1.4) |
| open edges "in 'x' twice, as 'a' and 'b'" | two placements of one step cross each other there | move one, or bury one in the other by a cell |
| a small part cannot be judged on the sheet | the whole model sets the framing | `--focus name`, or `set focus name` |
| a stone or wood part reads as flat colour | the pattern's feature size is larger than the part | `material("granite", scale=0.3)` (the preset with a smaller scale) |
| the eyes, mouth or a label need geometry you do not want | a painted sphere bulges, a painted tube sticks out | `decal(shape, region, material)` paints the surface inside a region and adds nothing |
| a fine pattern looks like blocks or camouflage on the sheet | the sheet colours per vertex and the pattern is near the cell size | judge it in the beauty render, or coarsen `scale=` |
| a label, a logo or a face must be a picture, not strokes | patterns are procedural | a PNG beside the program: `decal(part, box, image="label.png")` fits it to the box; `material(..., image="skin.png", projection="cylindrical")` wraps it |
| lettering is a blob on the sheet | a 0.05 stroke at a whole model's cell | `--focus name`: the step at its own cell |
| the report says "separate pieces" for a lidded cup | it is an enclosed void | the report's Cavities row lists it; it is not a loose part |
| the beauty render leaves the model small in the frame | the camera fits the box's corners, so a diagonal model has empty corners | `set zoom 1.2` or `--zoom 1.2` (it stops where the box would touch the edge) |
| the beauty render is flat, or one side is black | one default key light, from the upper left and the front | `light("key", ...)` and `light("rim", azimuth=150, elevation=20, power=0.5)`; `set environment sunset` or `night` for a mood; `camera("detail", focus="part", zoom=1.5)` for a second shot; `--camera NAME` and `--environment NAME` to try one shot or one sky without editing |
| a night scene is black but for the flame | `night` scales the ambient down to 0.4 | `set ambient 1.6` and a moon at `power=0.9`; a glow lights itself only, never its neighbours |
| a low shot still looks down on the base; a fire does not light its neighbours | elevation is about the model's centre; a glow lights only itself | `camera(..., elevation=-8)`; a point light in the air just outside the flame, `light("fire", position=[0, 0.4, 0], range=2, color="#ff9a3c")` |
| chrome reads as a dark mirror, silver as a bright one, and neither as a white sphere | a mirror metal shows what is round it: in the `studio`, a dark room round and behind the camera with bright cards and each light's softbox | that is the metal reading as metal; a larger key, `size=3` (an angular radius of about 9.5 degrees), is a larger highlight and a larger softbox in the mirror |
| chrome, silver or steel reads near white | `overcast` is a white sky all round, with no dark room for a mirror to show (steel near white on faces turned up) | the `studio`, `sunset` or `night` for a mirror metal, or a rougher one |
| metal lettering, or a metal face turned to the camera, reads dark, nearly black | a metal face turned to the camera mirrors the dark room behind the camera (the patterns plate's iron labels were lost on their dark board) | paint the letters a non-metal (the plate's are porcelain now), or turn the face towards the light |
| a polished engraving is faint, read only at its edges, or its letters sparkle | a polished face and the floor of its letters mirror the same room, so only the walls and the cavity term (the field's occlusion within about six cells, which dims the reflections in a groove and the lights' highlights on its lips and corners) set the letters apart; a lip out in the open that faces a light still glints | `rough=0.2` or more, or cut the letters deeper; letters that sparkle want a satin finish or bolder strokes, not a deeper cut: round 10's ring's gold FOREVER, strokes 1.75 cells wide and 2.9 deep, sparkled at gold's `rough` of 0.3 and read as dark letters at `material("gold", rough=0.5)` or with strokes 2.9 cells wide (larger letters if their counters close), and cut twice as deep it read as before |
| a part inside a polished bowl or tray is hard to pick out | a polished curved wall mirrors what it holds and the room round it, so the part stands among copies of itself (round 11's mixer: its beater among the reflections of its steel bowl at `rough=0.2`) | that is the metal reading as metal; a satin finish blurs the copies away, and at `material("steel", rough=0.4)` the mixer's beater, its shaft and its hub read on their own against the bowl; or judge the part from a `camera(..., focus="beater")` shot |
| a point light's pool on a wall or the floor is wider than expected | its strength halves `range` away in linear light, which shows wider than the old renderer's pool did (a torch lights more of a wall) | a `range` about the size of what it should light, and more `power` to keep the near side as lit; its sphere is 0.02 × `range` × `size`, so raise `size` as `range` falls to keep its shadows as soft (the lantern's flame: `range=0.8, size=1.75, power=1.6`) |
| a soft shadow is too hard or too soft | a light's `size` is an angle: its angular radius is size/18 radians (1 about 3.2 degrees, 3 about 9.5), and that one angle softens its shadow, widens its highlight and sizes its softbox in a mirror; a point light is a sphere whose radius is 2% of its `range` per unit of size | a larger `size` for a softer shadow (3 a window), a smaller one for a harder (0.5 a lamp); a shadow hardens anyway where a part meets the floor |
| a plan shot's blind holes read as domes or bumps | a hole lit from the frame's bottom reads as a dome: people see a picture as lit from above (round 10's hub, whose plan shot keeps its own key at azimuth -40) | with no `light()` and no `set light_azimuth` or `light_elevation`, a camera above elevation 55 turns the default key towards the frame's top left itself (all the way at 75); with your own lights, put the key at the camera's azimuth less 135 (`light("key", azimuth=-135, elevation=55)` for `camera("plan", azimuth=0, elevation=90)`) |
| glass reads frosted and opaque in `--quick --beauty` | the quick grid is 64 cells and the wall is under a cell, and a draft traces glass seen through glass one deep | judge glass at the full grid and in full quality; keep a glowing part a cell clear of its glass |
| contour lines behind glass | a `loft` or a smooth union is a bound, not a distance; or two faces coincide | a rounded box or an exact primitive under `transmit`; grow a liquid a cell into its cavity and promise `inside(liquid, cavity) > 0.9` |
| "is not part of the output" for a probe or a cavity region | it was warned as unused | it no longer is: a step an assert, a decal or a camera reads is a region, tagged `(region)` in `check` and on the steps sheet |
| a fine speckle renders as square blocks | `speckle` is a cubic block pattern at `scale` | `"noise"` at a small scale for a soft mottle; `scale` is the block size; `examples/patterns.aix` is a plate of all ten |
| a part stuck on a curved body reads as a disc | two convex surfaces meeting | a skin of the body's own surface: `(offset(body, 0.05) - offset(body, -0.012)) & oval`, `intersect(..., k=)` for the rim |
| a material boundary speckles in the views | two painted surfaces nearly coincide (under 35 degrees apart), so each vertex picks either | give them a clear angle, or one shape with a `decal`; a seam at a crease is clean, and the beauty render is unaffected |
| a box or a join reads soft, as if bevelled, in the viewer or a GLB | one smooth normal per vertex, from `set crease 0` | leave `crease` at its default (35), which splits vertices at edges |
| a limb built with `rotate` and `move` has no knee | one capsule per limb | `tube(r, [hip, knee])` and `tube(r, [knee, ankle])`: a point list is the joint chain |
| "watertight: no" with edges you cannot find | two surfaces pass through one cell | the report says where the edges are and which steps hold them |
| a vase, bottle or body outline looks faceted once revolved or extruded | `polygon` is straight between its points | `curve2([...])` through the same points, or `bezier2` from handles: exact, no facets at any grid |
| a smooth profile's base rocks, or its box in `check` reaches past x = 0 | the spline overshoots where the outline turns sharply | give the points on the axis and at the foot's edge twice: a doubled point is a corner, and the run between two is straight |
| letters or a label need to go round a cylinder | text is flat | `extrude(text(...), h, "z") \| wrap(r)`; `bend(deg)` curves about z instead |
| stripes run the wrong way, or a pattern is missing on a thin sheet | patterns are stacked along the material's axis (y) in the paint frame | `material(..., axis="x")`, or paint the part standing and then lay it down |
| the counter under the awning is black, the flame is a dark blob | the one default key comes from the upper left, so the awning shades the counter, and nothing glows | `set light_azimuth`, `set light_elevation`, `set ambient 2`; `material("#ffc860", glow=1.5)` for the flame |
| gold or silver look dull, or a metal flat, on the sheet | a metal is mostly what it reflects, and the sheet has no environment | judge metals in `beauty.png`, which reflects the room, the cards, the sky and the model itself: gold reads deep yellow (orange under `sunset`, amber under `night`), brass the greener yellow, `steel` grey, `iron` dark |
| the model looks new, like plastic, in the beauty render or the viewer | every surface is one smooth colour | `material("iron", wear=0.4)` rubs the edges lighter (a metal to satin, in scuffs) and darkens the creases; `bump=0.003` roughens it below the mesh; `"rust"` (a pattern and a preset) for oxide; all shown in `--beauty` and baked into the GLB, never on the sheet |
| wear or a bump does not show on the sheet | the sheet draws the mesh and the pattern, not the finish | judge it in `--beauty`; the report's Maps row says which materials the GLB's maps carry |
| a thin rod or a ring is worn lighter all along, or in patches | wear's band is about 1.2% of the model's size, and a part thinner than two bands is all edge: a non-metal one is lightened along its length, a metal one rubbed in scuffs over about a third of it | thicken it, or give it a material with less wear (or none) |
| slices show a plant, a lamp or a probe as a floating blob | the planes go through the model's centre, and its stem is off them | `--slice plant`: the planes through that step's own solid |
| a point light's effect is a few pixels in `lights.png` | the light reaches a small part of a whole picture | read the bottom row: exactly what it adds, floor included, brightened by the gain shown |
| `overlap(a, b) > ...` fails at 0 | the failure says why: they only touch, they stand apart by so much, or they overlap thinner than the lattice | sink one into the other; or promise a chunk, `overlap(rim & box(...), base)` |
| a steel boss shows a row of blobs at its foot | a metal reflects the model's own cut faces (a ring of counterbores) | nothing is wrong; the slices and the plan view are the truth about holes |
| `--focus` on a probe region or a cutter | it is not geometry | the frame is the region's, and what is drawn is the model inside it |
| "separate pieces" but everything looks joined | a part stops a hair short of its neighbour | the warning names the loose piece's volume, centre and step; overlap by a little |
| copies meant to sit between another ring's copies land on them | a part centred on y turned before `ring` only turns in place (`check` warns) | turn the ring: `pocket \| ring(6, 0.7) \| rotate(y=30)` |
| a rig's part swings about the wrong point | the joint's pivot is not where the part turns | give `joint` the world point of the hinge, after the part is moved into place |
| a part that should sit on, lean on or stand beside another floats a hair, sinks in, or needs trigonometry to place | the contact is worked out by hand | `rest(on)` moves it until it touches (`dir=` for any direction, `sink=` past the touch or, negative, short of it), `lean(on, pivot, axis)` turns it until it touches; the gap left is a millionth of the part's size (a ten-thousandth on a displaced skin), at any scale |
| `lean` turns the part a long way round, or says it never touches | it turns the right-handed way about `axis`, as `rotate` does | the other sign, `axis=[0, 0, -1]`; check's line says when a turn is more than a quarter |
| `rest` moves a part the wrong way, or lands it on something it should pass | it started inside `on` and was backed out (check's line says so), or `on` holds what it should fall past | start it clear of `on`; leave out of `on` what it passes (a hook a bowl twists under) |
| a part placed with `attach` or `rest` on a corner or an edge is a loose piece | it touches at a point or a line, which can mesh apart (a face on a face meshes as one piece) | `sink=0.02` pushes it in, or put the anchor a cell inside the part |
| text wrapped inside a band reads backwards | `wrap` reads left to right from outside | `flip("x")` the extruded text before the `wrap` for an inscription read from inside |
| `set pose reach` shows the rest pose | the pose is not named that | the warning lists the poses that exist |
| a copy should be left out of a loop, or a value differ by a test | there is no `if`; a comparison is 1 or 0 | a number `(t > 0) * a + (t <= 0) * b`; a shape, a material or a record `[if_false, if_true][t > 0]`; leave a copy out with `[part, empty()][i == k]` (a copy scaled to 0 collapses onto the origin) |
| one copy a loop made cannot be sliced, focused or found in a warning | a name first assigned in a loop is the loop's own, not a step | `books = books + named("book_" + i, bk)`: a step per copy, `--slice book_9` |

When the model is right, `npx aixle render model.aix --beauty` adds
`beauty.png`, for showing rather than checking: the field itself, ray
traced and shaded as the viewer and the engines shade the GLB (glTF's
metallic-roughness model in linear light, through one tone curve), with
traced reflections, soft shadows from lights with a size and
refraction through glass. `viewer.html` next to it orbits the mesh in
a browser and plays a rig's animations (loop, speed, a scrub bar, all
in turn), and `model.glb` carries the materials as a baked texture
(`model.png`), with a normal map for bumps and fine `displace` relief,
a metallic-roughness map for wear and rust and an emissive one for a
patterned glow where the program has them, and with the program's
lights (glTF's `KHR_lights_punctual`) in linear light. A directional
light is 3.30 lux for each unit of `power` (π times the render's 1.05)
and lights a face at every angle as `beauty.png` does; a point light is
3.30 candela for each unit of `power` times its `range` squared, and
since an engine's falls off by the inverse square, it is twice as
bright as in `beauty.png` at its range, five times at half of it, the
same at about 1.8 ranges and dark from three, where glTF's cutoff is.
The materials travel exactly; the picture only in part: an engine has
its own sky, exposure and tone curve, and a part a few cells across
keeps the mesh's polygon outline where the beauty render draws it
round.

`viewer.html` (three.js 0.187.0) shows the GLB two ways, both on
`beauty.png`'s tone curve. **Studio** is its own grey room, a
hemisphere light and a white key, calibrated so that a white face
turned to the key is about 1.1 in linear light, its Fresnel included,
and the non-metal presets show their base colours (within 1.6 levels on
average over a plate of them, 4.1 tile by tile): judge the maps there,
wear, bumps and the atlas. **Scene** is `beauty.png` drawn from the
export, and it opens there when the program declares a light or a sky:
the same sky as light and in the metals (the studio's cards and dark
room, the sunset's glow) at the same strength, diffuse light taken from
the sky as the render takes it, the GLB's lights with `beauty.png`'s
point-light falloff rather than an engine's, glows at the render's
strength, the floor at the render's colour near the model and fading
into the horizon, and the named cameras and `◎ beauty.png` as buttons
that frame each shot as its picture is framed. Measured on non-metal
parts, the door comes within 1.0 level of `beauty.png` on average, the
medal 2.3 and the ring under its sunset 4.2; the lantern is 7.7
brighter, all of it in its candle. What it cannot show: ambient
occlusion and the darkening where parts meet, which the GLB has no map
for (the lantern's candle inside its cage is 17 to 29 levels brighter
than in `beauty.png`, and the medal's lettering barely reads); soft
shadows (its shadow maps are hard, so a torch's bracket throws a large
dark shadow); the model reflected in itself (metals read 15 to 50
levels brighter); bloom; glass, which the GLB carries as opaque; and
the sun's or moon's disc and the stars in the backdrop. A steep shot's
default key, turned to the frame's top left, is `beauty.png`'s alone:
the viewer's camera turns, so its key stays the world's. So judge form,
lettering, metals, glass and shadows in `beauty.png`; judge the maps in
Studio, and in Scene, beside `beauty.png`, what an engine will make of
the GLB's colours and lights.

Past 200 thousand triangles the GLB, OBJ and viewer are
decimated, the cap shared by error over every mesh so flat faces go
first (the report's Exports row says from how many, how far they stray,
each mesh's share, and the cap below which detail starts to go); past
the flat faces, the normal map carries the field's normal for every
material so merged faces shade as the surface does, but their outlines
are coarser, so read the viewer.

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
`surface` line with its surface's own extent (from rays: a union's thin
parts are measured on their own box, a thin plate inside a cut part can
slip between them). The exports are at rest
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
  On anything but the floor, `| rest(on)`: it finds the contact from both
  surfaces (a toe of round 3's frog 0.003 lower than `ground()`'s rays did).
- Draw in the real unit, millimetres for a print (a 117 mm stand is 117
  units, with `set units mm`). Nothing in the mesh, what the checks find
  or the pictures depends on the model's absolute size: measured, a mug
  built at 1, 100, 0.01 and 0.001 times gave the same mesh and the same
  sheet and beauty render, but for the numbers in the captions. What does depend on
  the unit is the few defaults given in units: a material preset's
  pattern size (wood grain 0.25 apart, granite speckle 0.05; the
  reference lists each) and `text`'s size of 1, so a model in
  millimetres gives `scale=` and `size=` (`material("wood", scale=25)`
  on a 120 mm box, `text("PERCH", 9)`). The report and the warnings
  print three decimals, a number under 0.0005 as 0, so a part drawn in
  metres reads its volume and mass as 0 under about 10 to 20 cm, and its
  cell and thin sizes as 0 under about 6 cm: draw a part that small in
  centimetres or millimetres. The grid is cells along the longest side,
  so what loses detail is a big scene with small parts, at any unit:
  raise the grid, or `--focus` the part.
- Name steps for what they are (`lid`, `left_arm`, `stair_3`), since the
  names are what the steps sheet and the report show you, and a part's
  sizes too: `seat = {w: 0.9, h: 0.45}` read as `seat.h` says what each
  number is, where `chair(0.9, 0.45, 0.8)` makes the reader count.
