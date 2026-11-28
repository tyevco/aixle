# Round 12: a glass decanter (`dogfood/decanter.aix`)

Files: `dogfood/decanter.aix` (the program), four failure probes
(`dogfood/decanter_probe_spill.aix`, `_sunk.aix`, `_through.aix`,
`_thin.aix`), this report. Six renders (one `--quick`, three full
`--beauty`, one `--quick --beauty-only` draft, one `--beauty-only` on a
probe), eleven checks (seven on the program, four on the probes), three
other commands (one `doc`, two `fmt --check`).

## 1. The finished decanter

A round "globe" decanter of clear glass, 17.2 cm across and 21.7 cm to
the top of its lip, half full of a dark amber spirit, its ball stopper
seated in the neck, standing on an oak coaster 20 cm across and 1.2
thick; 27.3 cm to the top of the stopper. Drawn in centimetres, at
`set grid 180` (cell 0.152, so the 0.45 wall is three cells).

Parts:

- **glass**: one `curve2` outline revolved (`long_outer`): a flat foot
  5.6 out with a sharp edge, a round belly 8.6 out at 5.5 up, a shoulder
  sweeping into a straight neck 1.8 out from 19 up. The outline runs on
  past the neck's top to 24 and is trimmed at 21.5 (`outer = long_outer
  & below_lip`); the inside is `long_outer | offset(-0.45)` above a 1.0
  base (`cavity`), so the wall is 0.45 everywhere by construction and the
  inside runs out through the trimmed top: the mouth is open with no
  cutter of its own. A torus bead (R 1.75, r 0.32) is the rolled lip.
  Bore 2.7 across.
- **spirit**: the outside shrunk by the wall less 0.17 (a little over a
  cell), so it reaches 0.17 into the glass wall and base, cut off at a
  level of 6.8 cm above the decanter's foot. A separate step, unioned
  with the glass for the render. 1073 cm³ of the inside's 2137.
- **stopper**: a plug tapering 1.45 to 0.95 over 3.5, a rounded collar
  1.9 out, a ball 1.9 in radius; dropped onto the glass with `rest(glass)`
  (moved 3.3, gap 5.4e-7): the plug meets the bore's top edge 18.7 up
  and the collar stands 0.33 clear of the lip.
- **coaster**: `cylinder(10, 1.2, round=0.35)` in oak, grain along x at
  `scale=1.0`; the decanter `rest`ed on it (backed out of it, moved 1.2
  up, gap 0).

Materials: `glass` (the preset), `spirit_colour = material("#d4862a",
transmit=0.85, rough=0.05)`, `material("oak", scale=1.0, axis="x")`.
Lights: a key at azimuth -35, elevation 50, size 2.5; a rim from behind
right, azimuth 160, elevation 25, power 0.6. Cameras: `hero` (azimuth 25,
elevation 12, zoom 1.2, the `set camera` shot, beauty.png) and `neck`
(focus on the stopper, elevation 15). Sky: `studio`, chosen over
`overcast` from environments.png in one run (below).

The promises (15, all holding in the last check; the numbers are
check's):

| Promise | Number |
| --- | --- |
| `inside(spirit, outer) == 1`: the spirit is inside the decanter's outside | 1 |
| `void(box(40, 40, 40) - outer, spirit)`: no spirit outside the glass | holds |
| `inside(spirit, cavity) > 0.9`: it fills the inside, grown a cell into the wall | 0.9522 |
| `abs(height(spirit, 3, 0) - dec.level) < 0.01`: its surface is at the level | 0.000597 |
| `overlap(spirit, body_inside)` between 0.45 and 0.55 of `overlap(body_inside, body_inside)`: half full | 1073 of 2137, 50.2% |
| `clearance(stopper, glass) > -0.001`: the stopper does not pass into the glass | 6.876e-7 |
| `abs(clearance(stopper, glass)) < 0.01`: it rests on the neck | 6.876e-7 |
| `bottom(stopper) < dec.neck_top - 1.5`: the plug is down in the neck | 18.7 < 20 |
| `bottom(stopper) > 17`: it stays in the neck, above the shoulder | 18.7 > 17 |
| `clearance(seated_collar, glass) > 0.23`: it sits on its plug, the collar clear of the lip | 0.3315 |
| `abs(clearance(decanter, coaster)) < 0.001`: the decanter stands on the coaster | 4.441e-16 |
| `overlap(decanter, coaster) < 0.001`: not sunk into it | 0 |
| `stands(model) > 3` | 9.991 |
| `wall(glass) > 0.4`: a real wall | 0.45 |

Against the plan: the plan held, with three departures. The mouth was
first bored with a cylinder of the bore's own radius, which left 81
non-manifold edges where its face lay on the inside's; I replaced it
with the trimmed outline. The level moved from 7.5 to 6.8 when the
volumes said 7.5 was 57% full. And the collar promise was added late,
when the neck shot could not tell me what the stopper sits on. The
shape is a round flask-like decanter rather than a shouldered one; I
kept it. What remains in the report: `Watertight | no: 81 edges` where
the plug's taper is under a cell from the bore just below its contact
(F4), which the row says renders do not see.

## 2. Verification

**The asserts** are the table above. They were judged by `check` (1.8 s
without `wall()` and `stands()`, 4.3 to 6 s with them; `wall(glass)` is
2 to 2.3 s of it) and again by every render.

**The pictures**, final run (`render --beauty --environment
studio,overcast`, 59 s):

- `sheet.png`: the outline is right in all four views (belly, shoulder,
  straight neck, bead, collar, ball, coaster under it), 20 × 27.3 × 20.
  The glass is a grey checker; the spirit does not show (F1).
- `slices.png` (with `set slice_y 5`): X = 0 and Z = 0 show the wall as a
  pale band of even width, the thick base, the spirit's flat top at the
  level and its sides against the glass, the plug down the neck touching
  the top of the bore, the collar above the bead, the ball. Y = 5 is a
  disc of spirit filling the glass ring with no gap. This picture, not
  beauty.png, is where I read the wall, the base and the contact.
- `steps.png`: 18 thumbnails; `below_lip` and `above_base` tagged MASK,
  `cavity` CUT, `seated_collar` and `body_inside` REGION. The `collar`
  thumbnail's rim is ragged and the `decanter` thumbnail has a few dark
  specks on the glass, both the thumbnail's own coarse mesh.
- `callouts.png`: labels outer, coaster, finial, collar, bead, plug,
  cavity (cut); the spirit is "not seen from this view", hidden behind
  the glass, as on the sheet.
- `turntable.png`: eight checkered views, the same from every side (it is
  round).
- `beauty.png` (hero): clear glass with the key's highlight on the
  shoulder and the rim's along the right; the spirit amber-brown (sampled
  (130, 65, 9) to (134, 72, 53) in its body, (169, 137, 117) on its
  surface seen at a grazing angle); the level a flat ellipse; the stopper
  a clear ball over two rings; the coaster oak with grain and a board
  seam; a soft shadow.
- `beauty_neck.png`: the ball, the collar, the bead, and the plug seen
  through the neck as a pale cyan block with a darker blue foot.
- `lights.png`: key alone, rim alone, both, what each adds, no light. The
  key does most of it; the rim (×5.7) adds the right-hand edge of the
  glass and a band across the spirit; under no light the spirit shows a
  dark band across its middle, the studio's dark flags refracted through
  it (which is how I read the bands in beauty.png, section 4).
- `environments.png`: studio and overcast. Under overcast the glass goes
  pale blue-grey and flat, its outline weak against the grey dome, and
  the spirit's bands soften; in the studio the white sweep keeps the
  glass's edges dark and its highlights crisp. Chose studio.

**Deliberate failures** (each a copy of the program with one thing
broken, checked; messages verbatim):

- `decanter_probe_spill.aix` (the spirit grown 0.6 into a 0.45 wall and
  filled to 23, above the lip): five failures.
  `assert (line 65) fails: inside(spirit, outer) == 1 is 0.9516 == 1,
  spirit is outside outer at (-6.21, 8.81, -5.48), and inside it at
  (-0.37, 7.93, -0.37) in 'outer': the spirit is inside the decanter's
  outside`; `assert (line 66) fails: void(box(40, 40, 40) - outer,
  spirit), solid at (-6.67, 8.33, -5) in 'spirit': no spirit outside the
  glass`; `assert (line 67) fails: inside(spirit, cavity) > 0.9 is 0.7752
  > 0.9, ...`; `assert (line 68) fails: abs(height(spirit, 3, 0) -
  dec.level) < 0.01 is 7.898 < 0.01` (at x = 3 the spirit now stops at
  the shoulder, 15.1); `assert (line 73) fails: overlap(spirit,
  body_inside) < 0.55 * overlap(body_inside, body_inside) is 2137 < 1175,
  they overlap at (0, 8.05, 0): no more than half full, near enough`.
- `decanter_probe_sunk.aix` (`rest(glass, sink=0.3)` on the stopper,
  `rest(coaster, sink=-0.3)` on the decanter): `assert (line 74) fails:
  clearance(stopper, glass) > -0.001 is -0.04243 > -0.001, deepest
  overlap at (-1.35, 21.5, 0): the stopper does not pass into the glass`
  (0.3 down a taper of 0.143 a unit is 0.043 into the bore's edge, as
  expected) and `assert (line 78) fails: abs(clearance(decanter,
  coaster)) < 0.001 is 0.3 < 0.001, closest at (-4.31, 1.5, -2.87): the
  decanter stands on the coaster`. Here the one-sided "rests on the neck"
  (`clearance < 0.01`) still held at -0.04, which is why the final
  program has `abs(...)`.
- `decanter_probe_through.aix` (a stopper narrower than the bore): it
  falls through the neck to the glass floor. `assert (line 77) fails:
  bottom(stopper) > 17 is 1 > 17: the plug stays in the neck, above the
  shoulder`. Every clearance promise still held (it rests, on the floor),
  so "stays in the neck" is the promise that catches it.
- `decanter_probe_thin.aix` (wall 0.1, two-thirds of a cell): `check`
  said `no warnings`; `assert (line 83) fails: wall(glass) > 0.4 is
  0.09986 > 0.4, thinnest at (5.24, 10.32, -5.29) in 'outer',
  'long_outer', through to (5.17, 10.27, -5.23) in 'glass', 'cavity': a
  real wall, two and a half cells` (F6). Its `--beauty-only` render
  shows the glass speckled with bright dots.

**The renders, in order:**

1. `--quick` (2.4 s): the shape as planned; the spirit invisible (F1).
2. full `--beauty` (41 s): glass clear at once; spirit `#c06a1c`,
   transmit 0.75, read reddish-brown, tea or cola rather than amber
   (sampled (110, 60, 50)); level 7.5; bands in the spirit; report: 81
   edges where the mouth cutter's face lay on the inside's ("'cavity'
   only 0 into 'mouth' there (0.0 of a cell)").
3. full `--beauty --environment studio,overcast` (58 s): trimmed mouth
   (those edges gone), spirit `#d4862a` transmit 0.85 amber-brown, level
   6.8; studio chosen.
4. `--quick --beauty-only` (7.5 s, `out/decanter_quickbeauty`), on
   purpose: glass frosted, as the guide's row says.
5. `--beauty-only` on the thin probe (27 s, `out/decanter_thin`).
6. final full `--beauty --environment studio,overcast` (59 s; beauty
   16.1 s, environments 5.6 s, lights 2.7 s): the asserts added since 3,
   the sky set in the program; the pictures as in 3.

## 3. Friction

### F1. The sheet cannot show a liquid inside glass at all (render 1, --quick)

Command: `npx tsx src/cli.ts render dogfood/decanter.aix --quick`. Every
view of `sheet.png` draws the decanter as a grey checker with the floor
grid seen through it; the spirit (a `transmit` material, as any spirit
behind glass must be) is not amber anywhere on the sheet. Sampled pixels
in the front view's belly run 50 to 175 grey-blue
(e.g. `(146, 156, 162)`), none amber. The docs say "The sheet, the views,
the pose sheets and the animation strips draw glass (a material with
`transmit`) on every other pixel, so what is behind it shows through a
checker" (language.md, Limits). The spirit is itself `transmit`, so it is
checkered away too, and since it is unioned into the glass (grown a cell
into the wall, as the docs ask) there is no inner glass surface for the
checker to show it on. Expected: the liquid visible on the sheet, or the
docs to say a liquid in glass is invisible on the sheet and where to look
instead (slices). Cost: nothing in renders, but the sheet, the loop's
first picture, says nothing about the liquid's level. What I did: read
the level in slices.png and in beauty.png instead.

### F2. No `&&`, and the error does not say how to join two tests (check 2)

Line: `assert fill > 0.4 && fill < 0.6, "half full"`. Message, verbatim:
`dogfood/decanter.aix: line 69: expected a value but found '&'`.
Expected: either `&&`/`and`, or an error that says a comparison is a
number and two are joined with `min(a, b)` or `*` (the language doc's
precedence paragraph says "a comparison is a number, 1 or 0, so `assert`
can test it and `min`/`max` can weigh it", which is the answer, but only
if you already know to look there; the error points at `&`, the shape
intersection, and says nothing). Cost: one check. What I did: split it
into two asserts (`fill > 0.4` and `fill < 0.6`), which also prints each
side's number.

### F3. A region read through a number step is warned as not in the output (check 3)

Lines: `body_inside = cavity & below_lip`, then
`fill = overlap(spirit, body_inside) / overlap(body_inside, body_inside)`
and `assert fill > 0.4, ...`. Message, verbatim: `warning: 'body_inside'
(line 67) is not part of the output; add it to the model or remove it`.
The docs say "a step an assert, a decal or a camera reads is a region
and is not warned about" and "a step only asserts read is a region".
Here the assert reads it through a number step (`fill`), and the tool
does not follow that. Expected: a region, no warning (the step exists
only to measure). Cost: one check and a rewrite: the two asserts now
repeat `overlap(spirit, body_inside)` and `overlap(body_inside,
body_inside)` inline (`assert overlap(spirit, body_inside) > 0.45 *
overlap(body_inside, body_inside)`), which is less readable than
`fill > 0.45`, and the warning went away. (`overlap(a, a)` as a volume
is not documented either; I guessed it, and it gave 2137 cm³, which is
plausible: the report's cavity row says 905 cm³ of air above a spirit of
1073.)

### F4. The watertight row's fix contradicts the promise of a stopper that rests (render 3)

Report, verbatim: `Watertight | no: 81 edges shared by more than two
triangles ... 3 at (1.265, 21.861, 0.346) in 'cavity' (cut: the face it
cut), 'plug', their surfaces 0.0907 apart there (0.6 of a cell) ... By
step, over all of them: 'cavity' 81, 'plug' 81. Two parts closer than a
cell and a half, or sunk into each other by less than a cell, leave a
seam: overlap them by a cell or more, or part them by a cell and a
half`. The plug is a taper resting on the bore's top edge (placed by
`rest(glass)`, gap 5.4e-7), so just below the contact the two surfaces
are under a cell apart by construction: a seated taper is a wedge. Both
fixes offered break the brief: sunk a cell, the stopper passes into the
glass (my `clearance(stopper, glass) > -0.001` fails); parted a cell and
a half, it no longer rests. The language doc's Limits has the wedge
("wherever two surfaces meet at a shallow angle ... bury one in the
other by a cell, or give one a fitting"), which is the same advice.
Expected: a word on a part that must rest in a bore (a stopper, a peg,
a lid), that the open edges at a resting contact are the contact and
which way to go. Cost: no render; I accepted the 81 edges, since the
row says "Renders and most viewers are unaffected". The first render's
other 81 edges (my mouth cutter's face lying on the inside's bore, "'cavity'
only 0 into 'mouth' there (0.0 of a cell)") were exactly diagnosed and I
removed them by trimming the outside at the lip instead of boring a mouth.

### F5. check's camera test counts glass as hiding what is behind it (check 1 onwards)

Every check prints `neck: 28% of stopper hidden behind the rest of the
model from azimuth 25, elevation 15; 25% from azimuth 115`. What hides
the plug is the decanter's glass neck, which the beauty render sees
through (beauty_neck.png shows the plug through it plainly). In the
probe where a thin stopper falls into the body it says `100% of stopper
hidden`, though it would be seen through the glass. Expected: glass
(a `transmit` material) not counted as hiding, or the line to say the
share is behind glass. Cost: nothing, once I had seen the shot; but a
line that recommends another azimuth for a part seen through glass sends
an agent to re-aim a shot that needs no re-aiming.

### F6. A glass wall under a cell, made by subtracting an offset, gets no warning from check (probe, check 9)

Probe `dogfood/decanter_probe_thin.aix`: the same program with
`wall: 0.1` (0.66 of the 0.15 cell). `check` printed `no warnings`; the
only thing that caught it was my own `assert wall(glass) > 0.4`: `fails:
wall(glass) > 0.4 is 0.09986 > 0.4, thinnest at (5.24, 10.32, -5.29) in
'outer', 'long_outer', through to (5.17, 10.27, -5.23) in 'glass',
'cavity'`. The docs say check warns about a part thinner than a cell,
"including a `shell` wall, a `tube`, a `sweep` profile or a `text`
stroke inside a thick part (those carry their own thickness)", and the
glass rows say "judge glass at the full grid, with its wall the two
cells `check` asks for". A wall made as `outer - (outer | offset(-t))`
(the natural way when the inside is needed as a step of its own, for the
liquid) carries no thickness, so check asks for nothing. Expected: the
offset's thickness carried as shell's is, or the docs to say that only
`shell` (not a difference with an offset) is checked, and to promise
`wall()` on glass. The render's report did see it, as `Watertight | no:
13729 edges ... in 'long_outer' twice, as 'outer' and 'cavity'`, and the
full-quality beauty.png of the probe (`out/decanter_thin/beauty.png`,
`--beauty-only`) shows it as a scatter of bright dots over the glass and
along the spirit's surface; nothing on the sheet. Cost: one check and one
beauty-only render, spent on purpose.

### F7. "Grow the liquid a cell" needs the cell, which the program cannot read (check 1)

The rule ("a liquid filling a cavity is grown a cell into the wall, and
its promise is `inside(liquid, cavity) > 0.9`") is in cells, but the cell
is the model's longest side over the grid, known only after the model is
built: `check` prints `grid 180: cell 0.152 units` at the end. I wrote
`cell = 0.17  # 30.6 tall / grid 180` from a guess at the height (the
model came out 27.3 tall), which was a little over a cell by luck. Had
I guessed short (say 0.12 at a longer guess), the spirit would sit under
a cell into the glass and, by the docs, band. Expected: either a way to
read the cell in the program, or the rule given in units ("a little over
`check`'s cell"). Cost: none here; a comment corrected afterwards.

## 4. Reading the pictures

**What I read off beauty.png that a number showed wrong.**

- *The level, "half full".* In render 2 the spirit came up to about the
  belly's widest part and I read it as about half full. The volumes
  (`overlap(spirit, body_inside)` over `overlap(body_inside,
  body_inside)`) said 56.9%. At 6.8 they say 50.2%, and beauty.png now
  reads, by eye, as a quarter to a third full: down the centre column
  the spirit's front edge is at row 375, the foot at 460 and the lip at
  about 120, a quarter of the glass's height in the picture (the back
  edge of its surface, at 330, a third). A round body puts half its volume low; the picture
  cannot say "half" and the number can.
- *What the stopper sits on.* In beauty.png and beauty_neck.png the
  collar and the bead read as two rings stacked on each other; I could
  not tell whether the stopper hangs on its collar on the lip or sits on
  its plug in the bore. The number: the plug touches the bore's top edge
  (`clearance(stopper, glass)` 6.9e-7, deepest point at the bore's edge
  in the sunk probe) and the collar is 0.33 clear of the lip
  (`clearance(seated_collar, glass)` 0.3315). Promised since.
- *Bands in the spirit.* Render 2 showed three broad light and dark
  bands across the spirit. The guide's row "contour lines behind glass"
  gives a bound field (loft, smooth union) or coincident faces as the
  cause. Neither applied (an exact revolve, offsets, intersections; the
  spirit 0.17 into the wall, and check gave no bound-field warning).
  environments.png showed the bands change with the sky and lights.png's
  no-light frame showed the dark one as the studio's flags, so they are
  the backdrop refracted through a round body of liquid. That was a
  reading the pictures corrected, not a number.
- Nothing else: the materials (glass clear, spirit amber, oak wood),
  the decanter standing on the coaster (clearance 4.4e-16) and the
  spirit staying inside (`inside` 1, `void` holds) all read in beauty.png
  as the numbers say.

**What I could not tell apart in beauty.png, and what I did.**

- *Glass from liquid at the wall.* The spirit runs right out to the
  silhouette; no clear band of glass shows beside it, at the sides or
  below. Whether it touches the glass, stops short or pokes through
  cannot be read: slices.png (the Y = 5 disc filling the ring), and
  `inside(spirit, cavity)` 0.952, `inside(spirit, outer) == 1` and the
  `void` outside it.
- *The base.* The 1.0 glass base under the spirit is not visible: it
  refracts the spirit above it and reads amber down to the coaster.
  slices.png shows it as a pale band under the spirit.
- *The wall's thickness.* Not readable anywhere in beauty.png; a 0.1
  wall drew the same outline, only speckled. slices.png shows an even
  band; `wall(glass)` reads 0.45.
- *The level.* Readable: a flat ellipse, its front edge a clean line
  through the glass. What it cannot say is how full (above).
- *The plug in the neck.* Readable in the neck shot as a cyan block seen
  through the neck, and only there; in beauty.png it is a pale patch.

**How many renders.** The glass: one. It read as clear glass in the first
full render and never changed; the one draft (`--quick --beauty-only`)
drew it frosted, as the guide warns. The finish: two full renders (the
spirit's colour, reddish-brown at `#c06a1c`/0.75, amber at
`#d4862a`/0.85). The lighting: one. The two lights of the first full
render were kept; lights.png was read twice and the sky chosen from one
environments.png.

**The troubleshooting rows.**

- "glass reads frosted and opaque in `--quick --beauty`": met on purpose
  (render 4); the row describes the picture exactly and its fix (judge
  at the full grid, in full quality) is the loop I followed.
- "contour lines behind glass": met (bands in the spirit). Its causes
  did not apply and its fix (grow the liquid a cell, `inside(liquid,
  cavity) > 0.9`) I had already taken from the language doc. It did not
  explain the bands; environments.png and lights.png did.
- The watertight row's own advice, for the mouth cutter ("'cavity' only
  0 into 'mouth' there (0.0 of a cell)"): got me out, by telling me the
  two faces coincided, though its fix (overlap or part them) did not fit
  two cutters; restructuring did.
- No row for: the spirit invisible on the sheet (F1); a stopper or peg
  seated in a bore, whose resting contact leaves open edges (F4); a
  difference-made glass wall under a cell with no warning (F6).

## 5. What worked well

- **The glass recipe.** A `curve2` revolve shrunk by `offset` gives an
  exact, even wall; the language doc's rule (grow a liquid a cell into
  the wall, promise `inside(liquid, cavity) > 0.9`) and the tumbler
  example were enough to get clear glass and a clean liquid in the first
  full render, with no contour lines and no rings.
- **`rest()` for the stopper.** One line seated a taper in a bore,
  moved 3.3, gap 5.4e-7; the decanter onto the coaster likewise ("it
  started inside coaster and was backed out", as documented). No
  arithmetic, and the contact promises hold by construction.
- **The failure messages.** Each failing promise said the two sides and
  where (`spirit is outside outer at (-6.21, 8.81, -5.48)`, `deepest
  overlap at (-1.35, 21.5, 0)`, `thinnest at (5.24, 10.32, -5.29) in
  'outer'`); every one pointed at the right place.
- **The watertight row** named the mouth cutter's face lying on the
  inside's to a tenth of a cell.
- **environments.png** put the two skies side by side in one run, and
  **lights.png**'s no-light frame explained the bands in the spirit.
- **Speed.** `check` in 1.8 s (4.3 s with `wall()` and `stands()`, and it
  names the slow ones); a full render with two beauty shots and both
  strips in under a minute on shared cores.
- **`aixle doc`** with several names at once answered every parameter
  question without opening the reference.

## 6. Three changes that would have helped most

1. **Show a liquid behind glass on the sheet.** A `transmit` part inside
   another is checkered away to the floor, so the sheet, the turntable
   and the callouts say nothing about the spirit (F1). Draw a transmit
   part seen through glass solid (or the inner one at half checker), or
   at least say in the guide that a liquid in glass is read in the
   slices and in beauty.png, not on the sheet.
2. **Warn about a glass wall under a cell however it is made.** A wall
   made as `outer - (outer | offset(-t))` (the natural way when the
   inside must be a step, for the liquid) carries no thickness, so
   `check` says `no warnings` at two-thirds of a cell (F6), and the glass
   rows' "the two cells `check` asks for" never comes. Carry an offset's
   thickness as `shell`'s is carried, or at least warn on a `transmit`
   part thinner than two cells, and tell the reader to promise
   `wall(glass)`.
3. **Let promises read naturally: `and`, and regions through numbers.**
   "Half full" took two asserts with four `overlap` calls because there
   is no `&&` (the error, `expected a value but found '&'`, does not say
   so, F2) and a step read through a number step is warned as unused
   (F3); a `volume()` query (I guessed `overlap(a, a)`), `&&` or an error
   naming `min()`, and following a number step back to its regions would
   make it `assert fill > 0.45 && fill < 0.55`.
