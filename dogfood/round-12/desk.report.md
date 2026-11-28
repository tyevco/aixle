# Round 12: a writing desk at night (`dogfood/desk.aix`)

Files: `dogfood/desk.aix` (the model), `dogfood/desk_probe_failures.aix` (the same program with every promise broken on purpose, for `check` only), this report. 14 renders (2 `--quick`, 7 `--beauty-only`, 5 full), 12 `check`s, and 15 other commands (2 `doc`, 1 `--help`, 1 `fmt --check`, 3 headless Chromium runs on `viewer.html`, 8 short Python scripts reading or cropping the PNGs' pixels). The renders: R1-R2 `--quick` (sheet; `--focus lamp_on`), R3 full `--beauty`, R4-R8 `--beauty-only --lights` (lighting L1-L5), R9 `--beauty-only` (finish), R10 `--beauty-only` (framing), R11 full `--beauty`, R12 full `--slice bulb --no-export --no-viewer --no-turntable`, R13 full `--beauty` (final), R14 full `--triangles 0 --no-turntable --no-slices --no-steps --no-callouts` (an undecimated GLB for the viewer, no beauty). The final picture is `out/desk/beauty.png` from render R13.

## 1. The finished desk

**What it is.** A small writing desk at night, drawn in centimetres (front +z, y up), with a brass desk lamp at its back left whose bulb is a point light, an open hardback in the middle and a cream ceramic mug of coffee on the right. The sky is `set environment night`, and the moon is the second light. 110 × 112 × 55 overall (the surface reaches 110.2 high; the box is 112.7 because of the turned lamp head), one piece, 382180 triangles at `set grid 320` (cell 0.351), stands with its centre of mass 25.5 inside the footprint.

**Parts.**
- Desk (`desk_frame`): a walnut top 110 × 3 × 55 rounded 0.6, its grain along x (`material("walnut", scale=22, axis="x")`); an apron 100 × 9.5 × 47 sunk 0.45 into the top; four legs 4.5 square, 72.5 tall; a drawer front 44 × 7 × 1.2 standing 0.4 proud of the apron, with a brass knob of radius 1.1.
- Lamp (`lamp_on`, 41 × 37.7 × 32.6): a brass base of radius 7, 2 thick; a stem `tube(0.7)` 23 tall; an arm along `curve()` arching 16 out to a brass knuckle of radius 1.6; a head turned 30 degrees towards the book: a brass cone 14 tall (radius 8.5 at the mouth, 3 at the top) shelled to 0.75 and opened at the bottom, a charcoal socket and a glowing bulb of radius 2 (`material("#fff3d6", glow=1.5)`) 1.25 clear of the shade. The whole lamp is turned -28 degrees about y to aim at the book and dropped onto the desktop with `rest(desktop)`.
- Book (`book_on`, 35.9 × 2.3 × 27.9): a maroon cover 33 × 0.8 × 23.5 and two ivory page blocks 15.9 × 1.6 × 22.5, each with 14 lines of grey "ink" painted on by one `decal` over a union of thin boxes; turned -8 degrees, rested on the desktop.
- Mug (`mug_on`): a cream glazed cup (`#ece3d3`, rough 0.2) of radius 4.2, 9.5 tall, wall 0.7, floor 0.8, a torus handle trimmed by the cavity; coffee (`#2b1608`, rough 0.15) filling it to 2.3 below the rim, grown 0.1 into the wall; turned -30 degrees, rested on the desktop.

**Lights and camera.**
- `light("moon", azimuth=150, elevation=40, size=1, color="#9fb4ff", power=0.3)`: the first directional light, so the night sky's moon stands there (behind the desk, on the right); a cool rim on the desk's back edge and left legs.
- `light("lamp", position=at(lamp_on, "light"), range=22, size=2, color="#ffd9a0", power=4)`: a point light 1.5 below the bulb, inside the shade, at (-22.3, 101.0, -4.6), 26 above the desktop; it leaves the shade as a cone about 54 degrees each side of its axis and lays an elliptical pool over the book and the mug.
- `set ambient 1.6`, `set environment night`.
- `camera("desk", azimuth=25, elevation=20, focus="shot_frame", zoom=1.1)`, `set camera desk`, framed on a region `shot_frame` (a box 88 × 36 × 48 round the lamp, book and mug that only the camera reads).

**Promises** (all 10 pass on the final `check`):

| Line | Promise | Number |
| --- | --- | --- |
| 88 | `abs(clearance(lamp_on, desktop)) < 0.01`, the lamp stands on the desk | 0 |
| 89 | `abs(clearance(book_on, desktop)) < 0.01`, the book lies on the desk | 0 |
| 90 | `abs(clearance(mug_on, desktop)) < 0.01`, the mug stands on the desk | 1.665e-16 |
| 91 | `abs(bottom(lamp_on) - top(desktop)) < 0.01`, on the top, not against an edge | 0 |
| 92 | the same for the book | 0 |
| 93 | the same for the mug | 0 |
| 94 | `pieces(lamp_on) == 1`, the lamp in one piece | 1 |
| 95 | `clearance(bulb, shade) > 1`, the shade clears its bulb | 1.25 |
| 98 | `void(shade_mouth, shade)`, a rod down the shade's axis past its mouth: the shade is open below | holds |
| 102 | `void(light_probe, scene_all)`, a sphere of radius 1 at the light (its own sphere is 0.88): the light hangs in the air | holds |

**Against the plan.** The plan was a desk 110 × 75 × 55 with a lamp at the back left lighting an open book and a mug, under a night sky with the moon. It came out as planned, with these departures:
- The lamp was rebuilt once (lighting pass L2 to L3): a deeper, lower shade (14 tall rather than 11, the light 26 rather than 32 above the desk, turned 30 degrees rather than 22), because the first shade poured light over the whole desk rather than a pool.
- The mug went from a teal glaze to cream, and moved 5 to the left into the pool, because the teal read black under the warm light.
- The sky is not in the picture: no stars and no moon disc reach the frame at any shot I tried (F5). The night reads from the dark room and the single warm pool.
- The top 40% of the square `beauty.png` is dark backdrop: a wide desk in a square frame leaves it whatever the zoom (F7).
- The mesh is not watertight (10 open edges, at the shade's mouth lip and the knuckle). The report says renders and viewers are unaffected, and this is not a print (F8).

## 2. Verification

**The asserts.** There are ten, listed above. The contacts hold by construction (`rest`), and `check` printed each call: `rest (line 68) lamp_on onto desktop: moved 15 along [0, -1, 0]; gap 0`, and the same for the book and the mug. Two of them carry the picture's physics:
- **The open mouth** (`void(shade_mouth, shade)`): I added it after the first full render showed a lamp lighting nothing. Its first run failed with `assert (line 86) fails: void(shade_mouth, shade), solid at (-0.27, -5, -0.1) in 'shade_outer': the shade is open at the bottom`. That is the cap `shell()` had left across the cone's base, at y = -5 in the head's frame, exactly where my cutter stopped short (F3). After the fix the cutter reaches two cells past the cap's inner face, and the promise holds.
- **The light's sphere in the air** (`void(light_probe, scene_all)`): it stands in for a check the tool does not make (F9).

**Deliberate failures.** `dogfood/desk_probe_failures.aix` is the program with four changes: the lamp placed by hand 1 into the desk, the mug 0.5 above it, the bulb grown to 3.4, and the light's anchor moved inside the bulb. `check` said, verbatim:
```
assert (line 88) fails: abs(clearance(lamp_on, desktop)) < 0.01 is 1 < 0.01, deepest overlap at (-43.3, 74, -19.34): the lamp stands on the desk
assert (line 90) fails: abs(clearance(mug_on, desktop)) < 0.01 is 0.5 < 0.01, closest at (27.5, 75, 0): the mug stands on the desk
assert (line 91) fails: abs(bottom(lamp_on) - top(desktop)) < 0.01 is 1 < 0.01: the lamp's foot is on the desktop, not against its edge
assert (line 93) fails: abs(bottom(mug_on) - top(desktop)) < 0.01 is 0.5 < 0.01: the mug's foot is on the desktop
assert (line 95) fails: clearance(bulb, shade) > 1 is -0.15 > 1, deepest overlap at (0, 6.4, 0): the shade clears its bulb
assert (line 102) fails: void(light_probe, scene_all), solid at (-23.2, 101.77, -5.18) in 'bulb': the lamp's light hangs in the air under the bulb
asserts: 4 pass, 6 fail
```
- `abs()` hides the sign of a clearance, but the failure still says which way: "deepest overlap" for the sunk lamp, "closest" for the floating mug.
- `pieces(lamp_on) == 1` still held with the bulb pushed through the shade, as it should: the bulb is joined, just in the wrong place.
- `check` printed `no warnings` for the light inside the bulb (F9).

**The pictures, and what each showed.**
- **`sheet.png`** (R13): the plan as drawn. Perspective, front, right and top views of a four-legged desk with a drawer and a knob. The lamp at the back left with its arm arching right and its shade tipped towards the book. The book open in the middle, turned a little. The mug on the right with its handle towards the back right. The top view shows the lamp's arm aimed across the desk at the book.
- **`steps.png`**: 38 thumbnails in program order, none red. The regions (`ink_lines`, `shot_frame`, `shade_mouth`, `light_probe`) are framed grey and tagged; the cutters (`mouth_cut`, `mug_cavity`) are tagged `cut`. `mug_handle` is drawn as a torus with its inner part missing, which is correct: the cavity trims it.
- **`callouts.png`**: 19 of 20 steps named. `mouth_cut (cut)` is named at the shade's lip, which told me the lip is the cut face. `page` and `pages` are both labelled on the book.
- **`slices.png`** (R11 and R13), through the model's centre:
  - X = 0: the desk top over the apron, the book on top, the knob on the front.
  - Y = 55.1: the four legs' squares.
  - Z = 0: the top and apron, the book's thin slab, the mug cut open with its coffee filling it to below the rim, and the shade as a thin outline in the air. That outline cannot be read as open or closed, since the plane cuts the shade's edge, not its axis.
- **`out/desk_slice/slices.png`** (R12, `--slice bulb`): framed on the bulb, the bulb's disc clear of the shade's wall on both sides, with the socket above it. The frame is a quarter of the bulb's size round it, so the mouth itself is out of frame.
- **`turntable.png`**: eight views. The lamp's arm and head read from every side, and the mug's handle and the book never collide with anything.
- **`report.md`**: one piece, it stands, no warnings, 10 asserts pass, and `Watertight | no: 10 edges` (F8).

The pictures this brief is about, `beauty.png` and `lights.png`, are read in section 4.

## 3. Friction

- **F1. `|` binds tighter than `-`, and the warning names the wrong step.** Line 30, `shade = (shade_outer | shell(0.45)) - (cylinder(12, 1) | move(...)) | paint("brass")`, painted only the cutter. `check` said: `warning: 'head' (line 34) joins painted and unpainted parts: a part has no material and will render as clay. '|' binds tighter than '+', so \`a + b | paint(m)\` paints only b: wrap the union in parentheses.` The fix it describes is right. But it names `head` (line 34, the union) and talks about `+`, while the unpainted part was `shade` (line 30) and the operator was `-`. I found the line by reading. Cost: one check, no render. It was my mistake, and the tool caught it before any picture.
- **F2. `--quick` cannot show a lamp built in centimetres on a desk.** `render --quick` said: `warning: quick pass: 6 steps are thinner than this pass's 1.233 cell and may be missing or broken on this sheet: drawer_front, stem, arm, shade, cover, mug_handle; ...`. The sheet showed the shade floating in the air with no stem or arm. `--quick --focus lamp_on` (cell 0.524) drew the 0.6 shade as a sieve.
  - Expected: the quick pass's grid to step up "on a model whose parts are mostly thinner than the small grid's cell" (language.md, The fast loop). Here only six of the parts are thin, so it does not.
  - Cost: two quick renders that could not judge the lamp. Every placement after that went through full renders (10 to 20 s each against 1.3 s), so the quick loop the skill is built on was gone for this model.
- **F3. A closed shade I could not see.** My cutter for the shade's mouth, `cylinder(12, 1) | move(0, -shade_h / 2 - 0.45, 0)`, stopped 0.7 short of the cap that `shell()` leaves across the cone's base.
  - The docs say `shell` "hollows leaving a wall t thick inside its surface. Subtract something to open it up". They do not say that a solid's flat base becomes a cap of the same thickness, which the cutter must pass through.
  - None of the pictures showed it. No view of the sheet looks up into a shade. The Z = 0 slice passed through the shade's edge as an outline I could not read. `beauty.png`, from above, showed a bright brass shade over a dark desk.
  - What told me was `lights.png`: `LAMP ADDS, ×32` (the largest gain) lit nothing on the desk.
  - Then the promise I should have written first, `assert void(shade_mouth, shade)`, failed with `solid at (-0.27, -5, -0.1) in 'shade_outer'`, which named the cap exactly.
  - Cost: one full render (19.6 s), and the first lighting picture wasted.
- **F4. An enclosed point light still lit the far floor.** In that same `lights.png`, `LAMP ADDS, ×32` showed a warm band on the floor far behind the desk and over the horizon, while the light sat inside a closed brass shell. Expected: a light sealed in a solid adds nothing anywhere ("a solid the light sits inside shadows everything"). The frame looked like a lamp that works but is aimed badly, not one sealed in; only the black desk said otherwise.
- **F5. The night sky does not show as a sky.** `set environment night` promises "a dark blue sky with stars and a moon on the key's side". From elevation 15 the upper half of `beauty.png` is one flat colour, (18, 18, 26) on rows 0 to 120 with no pixel brighter than a sum of 68: not a star in it, and no horizon line between floor and sky. Nothing in the picture says "sky".
  - Expected: some stars or a horizon at 512 px.
  - I could not find in the docs at what elevation the horizon enters a shot, or how large the moon's disc is, so I could not aim a shot at the moon without trying.
  - Cost: one lighting render (L4), and I gave up on showing the sky.
- **F6. A framing region is reported as hidden.** `camera("desk", ..., focus="shot_frame")` on a box that holds the desktop made `check` print `desk: 40% of shot_frame hidden behind the rest of the model from azimuth 25, elevation 15`. This is a framing proxy, as the docs suggest: "a step in the middle of a scene makes a good framing proxy for a composition". The final run said `desk: 20% of shot_frame hidden ... from azimuth 25, elevation 20; 19% from azimuth 160`. The box is inside the desk by construction, so the line means nothing for a proxy, and the "better" azimuth is noise. Harmless, but it reads like a warning.
- **F7. `zoom` stops silently.** `camera("desk", ..., focus="shot_frame", zoom=1.5)` drew exactly the framing of `zoom=1.15`; the caption still read `SCENE_ALL, CAMERA DESK → SHOT_FRAME  128 × 53.6 × 72.6`.
  - The docs say zoom "stops where the frame's corners would leave the picture". But neither `check`'s Cameras line nor the render says the zoom was cut, or to what.
  - The guide's row "the beauty render leaves the model small in the frame → `set zoom 1.2` (it stops where the box would touch the edge)" describes this case, but gives no way to tell from a run that it happened.
  - Expected: something like `zoom 1.5 held at 1.1 (the frame's box reaches the edge)`.
  - Cost: a render that changed nothing in the framing. The cure was a narrower framing region, which crops the desk's ends.
- **F8. The open-edge gap at a cut's lip does not move when the cut moves.**
  - Before: `'shade_outer' only 0.532 past the face 'mouth_cut' cut there (1.5 of a cell)` and `only 0.502 past ... (1.4 of a cell)`.
  - I moved the cutter 0.6 (1.7 cells) further into the wall. After: `'shade_outer' only 0.491 past the face 'mouth_cut' cut there (1.4 of a cell)` and `only 0.537 past ... (1.5 of a cell)`.
  - The row's advice, "overlap them by a cell or more, or part them by a cell and a half", has nothing to act on at the lip a cut leaves. The number seems to be how far the cut shape's own surface runs into the cutter beside the lip, which is the same wherever the cut is.
  - The same pass fixed the other clusters, each from its number: the knuckle (radius 1.3 to 1.6, the shade's top sunk 0.6 into it) and the mug's rim (a 0.6 wall rounded 0.5 left a 0.1 flat; wall 0.7 rounded 0.3).
  - Cost: one full render. I left the 10 edges.
- **F9. Nothing warns about a point light inside a solid.** The docs say twice that a point light inside a solid "shadows everything" and must hang in the air. Yet `check` and `render` print `no warnings` when `light("lamp", position=...)` sits inside the bulb (the probe file), or inside a sealed shell (F3). I wrote my own `void(sphere(1) at the light, scene_all)` promise. A fresh agent who did not would get a dark render and the lights.png frame of F4 to puzzle over.
- **F10. The pool-width row lowers `range`, but the pool's width was the light's height and the shade.** In L1 the pool covered the desk, so I followed the row "a point light's pool is wider than expected → a `range` about the size of what it should light, more `power`, `size` up as `range` falls": range 45 to 22, power 2 to 4, size 1 to 2. L2's lamp-alone frame still lit the whole desk evenly.
  - With the light 32 above a desk 110 across, every point of the desktop is at roughly the same distance, so `range` cannot make a pool. What made one was geometry: a deeper shade (the light 5.6 above the mouth rather than 1.9) and a lower head.
  - No row says that a lamp's pool comes from what shadows the light, not from its falloff.
  - Cost: one lighting render (L2) that moved the wrong lever.
- **F11. The moon mirrored in the brass base.** In L2 the moon at azimuth -150, elevation 30 put a white-hot disc on the lamp's brass base. The camera's mirror direction off a level face is azimuth 205 (= -155) and elevation 28, and I had put the moon there by chance. The docs explain mirrors in metals at length, but nothing told me before the render that a light sat in the mirror direction of the camera off the floor-facing faces. `check` could say so in one line (as it does for hidden focus steps). Cost: part of one lighting render.
- **F12. The viewer's page cuts the bottom of the picture.** In both screenshots (900 × 760 and 1000 × 1100 windows) the bottom 70 px of the page are an empty grey band, and the toolbar covers the top 70 px of the picture. `document.querySelector('canvas').getBoundingClientRect()` is `[0, 0, 1000, 1100]`. So the framing the `◎ desk` button sets is `beauty.png`'s, but the desk's legs and floor are cut off at the bottom of the window.
- **F13. A click on the viewer's camera button hangs in headless Chromium.** `page.click('button[data-cam="0"]')` timed out after `performing click action` (the WebGL render loop on a software GPU, I suppose). `page.evaluate(() => button.click())` worked. Not the tool's docs, but anyone scripting the viewer meets it.
- **F14. A caption without its gain.** `lights.png`'s bottom row read `MOON ADDS, ×5.5` and then just `LAMP ADDS`, with no gain. The guide says the gain runs "1 to 32", so a missing one presumably means 1. That is fine once known; I had to work it out.

## 4. Reading the pictures

**What I read off `beauty.png` that a number later showed wrong: nothing.** But the one thing that mattered most I could not read off it at all. The first beauty (R3) showed a dark desk under a bright brass shade. I could not tell from it whether the shade was sealed, aimed badly or too weak; the cap only showed as a number (`void(shade_mouth, shade)` failing at y = -5 in `shade_outer`, F3). What I read off the beauty renders and then checked with a number:
- **The book lies flat on the desk:** clearance 0, bottom = top of the desktop, both exact.
- **The mug stands on the desk:** 1.7e-16 and 0.
- **The coffee sits below the rim:** I read a dark disc inside the cream rim. Its top is at 7.2 against the rim's 9.5, and the Z = 0 slice shows the mug filled to below its rim.
- **The lamp's base is on the desktop, not sunk into it:** 0.
- **The shade clears the bulb:** not visible in any beauty shot (the camera looks down on the shade). The slice through the bulb and `clearance(bulb, shade)` = 1.25 say yes.
- **The bright white disc on the base in L2 was the moon mirrored, not a glow:** confirmed by `lights.png`'s moon-alone frame, which has the same disc.
- **The top of the frame in L4 is the night sky:** I could not tell. Measured, it is one flat colour, (18, 18, 26) (F5).
- **The pool reaches the book and the mug:** lamp-alone frame in `lights.png`: the book bright, the mug's left side lit (mug lit side (70, 52, 29) in `beauty.png`, against the desk in shadow to its right at (14, 2, 14)).

**How many renders the lighting took.** Five `--beauty-only` renders (L1 to L5 = R4 to R8), after the full render R3 whose beauty showed the sealed shade. Between them:
- **L1** (after opening the shade). Settings: moon azimuth -55, elevation 35, power 0.35, `#b8c8ff`; lamp range 45, power 2, size 1, `#ffd9a0`; ambient 1.2. Result: the lamp lights the desk, but evenly from end to end, and the shade's outside (the moon's highlight in the brass) is the brightest thing in the frame.
- **L2.** Change: moon behind the desk (azimuth -150, elevation 30, power 0.4, `#9fb4ff`); lamp range 22, power 4, size 2. Result: worse. The moon lit the desktop blue so the walnut read purple, it mirrored as a white disc in the brass base (F11), and the lamp still lit the whole desk (F10).
- **L3.** Change: the lamp head rebuilt deeper and lower (geometry, for the light's sake); moon azimuth 150, elevation 40, power 0.2; ambient 1.6 (the docs' night row). Result: the picture. A cone of warm light with a soft elliptical edge, the book bright in it, the shade's inside glowing, the room dark.
- **L4.** Change: moon power 0.3, plus the camera lowered to elevation 15 and framed on a region. Result: a slightly stronger cool rim on the left legs; the empty top half of the frame (F5).
- **L5.** Change: camera elevation 20, zoom 1.15, mug moved into the pool. Result: the lighting was settled here.

The finish took one render (R9: the mug's glaze from teal `#3e6e8e` to cream `#ece3d3`; the walnut, brass and maroon cover were right from the first picture). One more `--beauty-only` render (R10) was composition only: a narrower framing region after `zoom` stopped silently (F7).

**`lights.png`, frame by frame** (R13, the final run). Top row, each light alone and then all:
- **`MOON AZ 150 EL 40 POWER 0.3`:** a dim blue-violet desk. The book's pages pale blue, the brass shade bright on its outside where it mirrors the moon, the mug dark, the inside of the shade dark.
- **`LAMP AT -22.297, 100.985, -4.587 POWER 4`:** the warm cone alone. An elliptical pool on the desktop round the book, the book cream-white, the mug's left side lit, the inside of the shade glowing, the shade's outside, the stem and the desk's legs and front in darkness.
- **`ALL`:** the shot.

Bottom row, what each light adds:
- **`MOON ADDS, ×5.5`:** the moon's share brightened. It lights the whole desktop, the book and the outside of the shade evenly, puts a grey sheen on the floor, and throws the desk's shadow forward to the left, so it is the light that gives the legs and the desk's outline their rim.
- **`LAMP ADDS`** (gain 1, F14): the same cone as the lamp-alone frame. Nothing on the floor but a sliver beside the desk's right end, and nothing on the moon's side of the shade.
- **`NO LIGHT`:** the sky's ambient and the glows only. The desk faint, the book faintly blue, the brass mirroring the night sky as dull olive. The bulb's glow does not show from this angle, since it is up inside the shade.

In the first full render (R3) the same strip was what found the sealed shade: `LAMP ADDS, ×32` with nothing on the desk (F3, F4).

**The troubleshooting rows I met.**

| Symptom | Row | Got me out? |
| --- | --- | --- |
| a night scene is dark | "a night scene is black ... `set ambient 1.6` ...; a lamp lighting its neighbours is `light(..., position=..., range=2)` just outside it" | Yes: the point light just under the bulb from the start, `set ambient 1.6` in L3 (the legs became faintly visible). |
| a point light's pool is wider than expected | "a `range` about the size of what it should light, more `power`, and `size` up as `range` falls" | No (F10): range 45 to 22 did not narrow the pool; the shade's geometry did. The `size` part was right: size 2 at range 22 kept the pool's edge soft. |
| a shell wall or tube under a cell | `check` names the step and the grid to set | Yes: the shade 0.45 and the cover 0.5 were flagged at cell 0.462; `set grid 320` and walls of 0.75 and 0.8 cleared them. |
| open edges | the watertight row's "overlap them by a cell or more, or part them by a cell and a half" | Partly: yes for the knuckle and the mug's rim, no for the cut lip (F8). |
| the beauty render leaves the model small | "`set zoom 1.2` (it stops where the box would touch the edge)" | No (F7): the zoom had already stopped, and nothing said so. |

Symptoms with no row at all:
- a point light that lights nothing on the model because it is sealed in a closed shell (F3, F4, F9);
- an empty, flat backdrop where the night sky should be (F5);
- a light mirrored in the camera's reflection off a level metal face (F11).

**The viewer against `beauty.png`.** The GLB was exported (R13, decimated from 382180 to 200000 triangles). Headless Chromium loaded `viewer.html` with three.js 0.187.0 from the CDN, which was reachable, and the page opened in `Scene: night` on the `desk` camera's framing. One run gave the screenshot the brief asks for. A second run clicked `◎ desk` from script and saved the canvas: `out/desk_viewer_desk_canvas.png`, scaled beside `beauty.png` in `out/cmp_marked.png`. Scaled to the same height, the two frame the desk the same way. Matched patches (mean RGB, luma difference viewer minus beauty):

| Region | `beauty.png` | viewer | Δ luma |
| --- | --- | --- | --- |
| book, left page | (227, 210, 166) | (229, 204, 163) | -4 |
| book, right page | (163, 142, 127) | (168, 146, 129) | +4 |
| desk in the pool by the lamp | (109, 56, 13) | (107, 56, 13) | 0 |
| desk in the mug's shadow | (14, 2, 14) | (10, 1, 16) | -1 |
| desk front, left, dark | (6, 0, 3) | (8, 1, 4) | +1 |
| backdrop | (18, 18, 27) | (17, 17, 24) | -1 |
| mug's lit side | (70, 52, 29) | (93, 71, 37) | +19 |
| floor between the legs, under the desk | (13, 12, 16) | (50, 35, 18) | +24 |
| shade, outside (brass) | (34, 27, 3) | (45, 41, 15) | +13 |
| shade, inside round the bulb | (131, 90, 5) | (80, 57, 4) | -35 |

What differed:
- **Non-metals in the light agree closely:** the pages, the lit desk, the shadows and the sky are within 4 levels, as the docs claim (1 to 4).
- **The pool's edge is a hard ellipse in the viewer** and a soft fade in `beauty.png`, and the mug and book throw hard, sharp-edged shadows. The mug's reaches the desk's right edge as a dark band. This is documented: hard shadow maps.
- **The floor under the desk is lit warm in the viewer** (+24 levels): the lamp's light reaches the floor through the desktop, where `beauty.png` has it in the desk's shadow. The docs' list of what Scene mode cannot show does not include this. My guess, unverified: the point light's shadow does not reach that far (the floor is about 100 from the light, beyond three ranges), while its light, on `beauty.png`'s falloff, still does.
- **The shade's inside is 35 levels darker in the viewer.** In `beauty.png` the brass interior mirrors the glowing bulb and its own lit wall, which the docs say the viewer cannot do ("the model reflected in itself"). Here that makes a metal read darker in the viewer, where the docs say metals read 15 to 50 brighter; the shade's outside does read 13 brighter.
- **The mug's lit side is 19 brighter in the viewer**, I assume for want of the contact darkening and occlusion (documented).
- **The book's edges are serrated in the viewer** (the page blocks' 0.35 roundings and the cover's 0.3, about a cell): teeth along every edge, and the ink lines blockier. I re-exported with `--triangles 0` (R14) and screenshotted again: the same teeth, so it is the mesh and its crease normals at a rounding a cell wide, not the decimation. `beauty.png` draws them clean. This is documented for "small round parts".
- **Layout:** the bottom 70 px of the page are grey and the toolbar covers the top 70 px of the picture (F12).

## 5. What worked well

- **The point light did what the docs said once it was in the air.** A sphere 2% of `range` per unit of size, soft shadows by `size`, a falloff I could reason about. When I made the shade deeper, the pool's edge appeared exactly where the cone's rim put it.
- **`lights.png` is the best tool in the loop.** It caught the sealed shade when nothing else did (F3). It told me the white disc in the base was the moon, not the lamp. And the lamp-alone frame showed the pool's shape without the moon's wash.
- **`rest(desktop)` and `at(lamp_on, "light")` placed everything with no arithmetic.** The lamp, the book and the mug went down onto the desktop exactly (0 and 1.7e-16), and the point light followed the lamp's anchor through a turn, an attach, a second turn, a move and a rest. Every lamp change since L1 carried the light with it.
- **Promises fail with places.** `void(shade_mouth, shade)` named the cap at y = -5 in `shade_outer`; the probe file's six failures each said where and by how much, `closest` or `deepest overlap`. The two queries I used as stand-ins (`void` on a rod for an opening, `void` on a sphere for a light in the air) are cheap, and `check` stayed under 2 s throughout.
- **The full render is fast enough to loop on.** About 20 s at grid 320 with exports and a 512 px full-quality beauty on four threads, and a `--beauty-only` pass 8 to 10 s. That is what made losing `--quick` (F2) bearable.
- **The watertight row gives a cause and a number for each cluster.** The steps on both sides and the gap in cells; two of three causes were fixed from the number alone.
- **The viewer's Scene mode is a faithful preview for the matt parts.** Pages, the lit desk, shadows and sky came within 4 levels of `beauty.png`, it opened on the program's own shot, and three.js loaded from the CDN on the first try.
- **`fmt --check` said `formatted`** for a program written by hand.

## 6. Three changes that would have helped most

1. **Warn when a point light can light nothing.** `check` should warn when its sphere is inside a solid, or inside a closed hollow such as a shell with no opening (a ray test from the light's position to the far field would find both), naming the step that encloses it. `lights.png` should say "adds nothing to the model" when a light's share on the model is zero. `shell()`'s docs should say that a flat base becomes a cap the cutter must pass through. This would have saved the first full render and the riddle of F3, F4 and F9.
2. **A `--quick` pass that keeps the thin parts of a scene.** It could mesh the steps it would drop at their own finer cell (as `--focus` does) or step the grid up until the named thin steps survive. A lamp's stem, a mug's handle and a book's cover are what a quick pass is for; at 1.2 cells they vanished (F2), and every placement went to a 10 to 20 s full render.
3. **Say what the camera will see before rendering.** On `check`'s Cameras line, report:
   - the zoom actually used when it stops (`zoom 1.5 held at 1.1`, F7);
   - where the horizon falls in the frame and whether the moon or sun is in shot (F5);
   - whether a light sits in the camera's mirror direction off a level metal face (F11).

   These are geometry, known before any ray is traced, and each cost me a render to find by looking.
