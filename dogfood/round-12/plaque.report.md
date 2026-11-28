# Round 12: a cast brass bench plaque (`dogfood/plaque.aix`)

Files: `dogfood/plaque.aix` (the plaque), `dogfood/plaque_probe_metals.aix` (brass beside gold, bronze and a rough brass under the plaque's lights), `dogfood/plaque_probe_failures.aix` (the plaque sabotaged three ways, plus the first version's mirrored hole probe), `dogfood/plaque_probe_groove.aix` (one engraved line cut shallow), this report. 15 renders (1 `--quick`, 2 full with `--beauty`, 12 `--beauty-only`: 10 at 384 px, 2 at 768), 11 checks, 5 other commands (`doc text extrude material light camera cylinder cone box brass`, `doc rect offset round void clearance`, `--help`, `fmt --check` twice). Final picture: `out/plaque/beauty.png` (768 px, camera hero); the same program at 384 px is `out/plaque_384/beauty.png`.

## 1. The finished plaque

A cast brass memorial plaque to be screwed to a park bench, modelled in millimetres
(`set units mm`, `set grid 300`, cell 0.667 mm) lying face up on y = 0 with its top
edge towards -z, so it reads from the front. `check`: `output: plaque 200 × 7 × 80`;
the report: 186616 triangles, watertight, one piece, 85.0 cm³.

Parts, each a named step:

- `base`: the plate, `rect(200, 80, round=8)` extruded 5 mm (y 0..5).
- `border`: the outline less `offset(outline, -6)`, a band 6 mm wide, 2 mm proud (y 4.5..7, sunk 0.5 into the plate).
- `title`: `text("EDITH MARLOWE", 11, weight=1.7, align="center", face="serif", spacing=2)`, raised 2 mm, as high as the border; 151 × 12.7 mm.
- `engraving` (a cut): three sans lines, `1931 - 2019`, `SHE LOVED THIS VIEW`, `SIT AND SHARE IT`, cap 7.5 mm, weight 1.4 (2.1 cells), `spacing=1.2`, cut 2 mm deep (floor at y = 3, 3 cells); 126 × 31.9 mm.
- `holes` (a cut): at x = ±86 on the centre line, a 4.5 mm shank through and a 90 degree countersink 10 mm across at the face (`cone(2.25, 6, 3.75)` from y 2.25 to 6), mirrored.

Materials: `polished = material("brass", rough=0.28)` on the border and the title;
`field = material("brass", rough=0.4, bump=0.06, bump_scale=0.5)` on the plate, a
satin cast grain; the engraving's floors and walls and the holes are cut from the
plate, so they are `field` too. Lights: `light("key", azimuth=160, elevation=40,
size=4, power=0.45)`, behind and to the right, near the direction the face mirrors to
the camera, and `light("fill", azimuth=-30, elevation=35, size=3, power=0.5)` from
the front left. One camera, `camera("hero", azimuth=0, elevation=55, zoom=1.1)`, `set
camera hero`, under the default studio.

The promises, as the last `check` printed them (11 pass):

- `void(rod_l, plaque) == 1 is 1 == 1: the left screw hole goes through` and the same for `rod_r` (rods r 1.2, y -4.5..9.5)
- `clearance(rod_l, plaque) > 0.9 is 1.05 > 0.9: the left hole is open round its probe`, `rod_r` the same 1.05
- `void(groove_probe, plaque) == 1 is 1 == 1: the engraving is open at least 1.9 mm deep` (the lines at weight 0.4, y 3.1..4.9)
- `inside(floor_probe, plaque) > 0.99 is 1 > 0.99: and floored no deeper than 2.1 mm` (the same thin lines, y 2.6..2.9, 0.1 under the floor; together the two pin the depth to 2 ± 0.1 mm)
- `clearance(title, border) > 8 is 9.45 > 8`; `clearance(engraving, border) > 5 is 9.5 > 5`
- `clearance(title, holes) > 3 is 9.908 > 3`; `clearance(engraving, holes) > 3 is 17.73 > 3`
- `pieces(plaque) == 1 is 1 == 1: one casting`

Against the plan: the layout, sizes, lettering and holes are as planned. Departures:
the engraving went from 1.2 mm (1.8 cells) to 2 mm to read in the light I chose; the
engraved lines went from 7 mm cap and 1.2 weight to 7.5 and 1.4, and the title's
spacing from 1 to 2, after `check`'s notes; the finish split into a polished border
and title and a satin field, which I had not planned. Two things a real cast plaque
would do differently: its polished raised letters usually read brighter than the
field, where mine read darker (olive faces with bright bevels; F8 below), and the
report's thinnest wall, `0.737 mm (0.737 units, 1.1 cells) at (58.426, 4.087, 7.775)
in 'engraving', 'base'`, is a fin of plate left between two engraved strokes in the W
of VIEW, which a casting would not hold crisply (real engraving would be cut after
casting, which is what it models).

## 2. Verification

**Asserts.** The eleven above, all passing on the last `check`. The two clearance
promises on the holes were added after a deliberate failure showed that the hole
promise as first written (the docs' pattern) could not fail (F5).

**Pictures**, each read:

- `sheet.png` (quick, then full at 512 and 768): `200 × 7 × 80 MM`, cell 0.667; the top view shows the border, the title, the three lines and the holes white through the plate; front and right views a 7 mm slab. The layout read low first (13 mm above the title, 6.8 below the last line), so I moved every line up 2.7 mm.
- `slices.png`, first full run: X = 0 cuts the hyphen of `1931 - 2019` as an open notch 1.2 mm deep (the depth then) and the raised title as blocks 2 mm proud; two dark filled rectangles at line 3 are the plane running along the S of SHARE. Y = 3.5 drew every engraved letter filled (F3). Final run, `--slice rod_r`: X = 86 and Z = 0.033 cut the right hole lengthwise, a 45 degree countersink running into a shank open from the plate's back to its face; Y = 2.5 a clean round hole in solid brass. Through, as the asserts say.
- `steps.png`: 12 thumbnails; `rod_l`, `rod_r`, `groove_probe`, `floor_probe` framed grey as regions (the floor probe "too fine for this thumbnail"); the cuts drawn as the solids they remove.
- `callouts.png`: base, border, title, engraving (cut), holes (cut), sink (cut), shank (cut), each pointing where it should.
- `turntable.png`: the plate turning flat, the lettering upright at 0 degrees and upside down at 180; nothing loose.
- `lights.png` (final run): the key alone gives the face its colour and the gradient; the fill alone leaves the plate olive with highlights on the left-facing walls of the letters and the border (`FILL ADDS, ×3.3`); under no light the plate is a dark olive brass, the title reading dark.
- `beauty.png`: at 512 (default light), 384 and 768; what each showed is in section 4.

**Deliberate failures** (`dogfood/plaque_probe_failures.aix`, checked; exit status 1):

1. Shank shortened to `cylinder(hole.r, 4)`, so a 0.25 mm skin closes each hole under its countersink:
   `assert (line 53) fails: void(rod_l, plaque) == 1 is 0 == 1, solid at (-87.1, 2, -0.4) in 'base': the left screw hole goes through`;
   `assert (line 55) fails: clearance(rod_l, plaque) > 0.9 is -1.2 > 0.9, deepest overlap at (-86, 2, 0): the left hole is open round its probe` (the right hole the same).
   The first version's mirrored probe on the same closed holes: `assert (line 78) holds: void(rods, plaque) == 1 is 1 == 1` and `assert (line 79) holds: inside(rods, plaque) == 0 is 0 == 0` (F5).
2. Engraving cut 1.8 mm where the probes expect 2: `assert (line 60) fails: void(groove_probe, plaque) == 1 is 0 == 1, solid at (-46.8, 3.18, 4.69) in 'base': the engraving is open at least 1.9 mm deep`.
3. Title moved 9 mm up the plaque: `assert (line 62) fails: clearance(title, border) > 8 is 0.45 > 8, closest at (-38.14, 4.5, -33.55): the title stands clear of the border`.

And `dogfood/plaque_probe_groove.aix`, one line (SIT AND SHARE IT) cut 1.7 mm where the
others are 2, to see whether one region over all three lines catches a local fault:
`assert (line 59) fails: void(groove_probe, plaque) == 1 is 0 == 1, solid at (-41.6, 3.18, 16.27) in 'base'`, z 16.27 being that line. It does.

## 3. Friction

- **F1. `check` prints an inset profile at the size of the outline it came from.**
  Line `inner = offset(outline, -p.border_w)` (outline `rect(200, 80, round=8)`).
  `check` printed `inner              profile 200 × 80     x -100..100  y -40..40`.
  Expected 188 × 68 (the skill says "Sizes that look wrong are wrong").
  The language doc says bounds "can be loose" after a cut, a rotation or a twist,
  and nowhere that `offset` with a negative radius keeps the original box. Cost: a
  minute of doubt; I trusted the arithmetic and moved on. (Check 1.)
- **F2. Letter gaps at a chosen weight are arithmetic the reference leaves out.**
  `text("EDITH MARLOWE", 11, weight=1.8, ..., face="serif", spacing=1)`:
  `warning: 'title' (line 22): the space between A and R is only 0.117 wide, 0.175 of the 0.667 cell, and closes up in the mesh.`
  The warning is good and exact. But `npx aixle doc text` says nothing about the
  gap; only language.md's Text paragraph ("about a fifth of the size in sans, less
  with serifs, plus `spacing=`, less the weight") lets you predict it, and for
  serif it gives no number ("less"), so I could not size `spacing=` ahead. Cost:
  one check.
- **F3. A horizontal slice 0.3 mm under the engraving's floor draws every engraved letter filled, as if cut through.**
  First full render (render 2), `slices.png`, plane `Y = 3.5`: the three engraved
  lines show as solid dark letters on the brass section. The engraving (then 1.2 mm deep) had its floor at
  y = 3.8 (cutter box `y 3.8..6` in `check`), and `assert inside(floor_probe, plaque) > 0.99`
  with the probe at y 3.4..3.7 holds (`is 1 > 0.99`). So the picture says the
  grooves reach below 3.5 and the number says they do not. language.md's Limits
  explains it ("A cross-section draws the surface's outline a cell or so behind the
  cut plane as a thin line, so a plate just behind the plane shows as a dashed
  line"), but what I saw was not a thin line: a 1.4 mm stroke is two cells, so
  the "outline" fills the whole letter, and it is not behind the plane in the
  direction the caption implies (the view is from above, `X→ -Z↑`; the floor is
  above the cut). Without the probe assert I would have concluded the engraving
  was 1.5 mm deep or more. Cost: a crop and a zoom to be sure, no render.
- **F4. Polished engraving reads as outlined letters under a key in the face's mirror direction.**
  L3 (`light("key", azimuth=160, elevation=40, size=4, power=0.45)`, engraving 1.2 mm
  = 1.8 cells, brass preset rough 0.35): every engraved stroke is a dark line on its
  top edge with a floor as bright as the face, so the lines read as an outline font,
  not as cuts. With the default key (render 2) the same strokes read dark and solid.
  The guide's row "a polished engraving is faint, read only at its edges" matches the
  symptom; its fix "`rough=0.2` or more" was already true (brass is 0.35), so the only
  lever left in the row was "cut the letters deeper". Nothing says that the key's
  position (in the face's mirror direction, the very thing that makes flat brass show
  its colour) is what lights the floors.
- **F5. The documented "hole goes through" promise passed a blind hole when the probe rods were made with `mirror("x")`.**
  Program: `rods = cylinder(1.2, 14) | move(hole.x, 2.5, 0) | mirror("x")` and
  `assert void(rods, plaque) == 1, "both screw holes go through"`, exactly the pattern
  the skill and the guide give ("A hole that must go through is `void` on a thin rod past
  both faces"). Deliberate failure (`dogfood/plaque_probe_failures.aix`): the shank cut
  to `cylinder(hole.r, 4)` (y -2..2), so a 0.25 mm skin (0.375 of a cell) closes each
  hole between y = 2 and the countersink's tip at 2.25. `check` said
  `assert (line 49) holds: void(rods, plaque) == 1 is 1 == 1: both screw holes go through`.
  Also holding on the closed holes: `inside(rods, plaque) == 0 is 0 == 0`, though the
  language doc says "A skin of `b` thinner than the lattice inside `a` does not read 0".
  What did catch it: `clearance(rods, plaque) > 0 is -1.2 > 0, deepest overlap at (-86, 2, 0)`;
  one rod not mirrored, `void(rod_one, plaque) == 1 is 0 == 1, solid at (84.9, 2, -0.4) in 'base'`
  (also at 8 and 14 long, 2.4 and 4 across); `height(plaque, hole.x, 0) < 0.01 is 2.25 < 0.01`.
  So the miss is the mirrored region: its box is 174 × 14 × 2.4, and 25 lattice points
  across 174 mm are 7.25 mm apart, wider than each 2.4 mm rod. The docs promise "a skin
  of the shape pressed into the region is found that way however thin, down to a
  hundred-thousandth of the region's longest side" and talk of regions "made of
  copies (a ring of probe rods)" as supported; nothing warns that copies far apart
  thin the lattice out. Expected: a failure. Cost: had I not sabotaged the program on
  purpose, the plaque's headline promise would have been empty. Fixed by one named rod
  per hole and a `clearance` promise beside each `void`.
- **F6. Lit for its colour, flat brass rolls off to lemon, and nothing in the docs says so.**
  L1, `light("key", azimuth=180, elevation=55, size=6, power=1)` (the key where the
  face mirrors it to the camera, so the flat plate shows its colour rather than the
  dark room): the field came out (252,251,193), hue 58 and saturation 0.24, a pale
  lemon that reads as yellow paint or gold leaf. L2 (azimuth 160, elevation 40, size 4,
  power 1): (244,229,121) to (253,251,204). The docs say the render "tone-maps once at
  the end, so a base colour lit square on shows as itself and a highlight rolls off
  rather than clipping"; it does roll off, but toward white through lemon, which takes
  brass (hue 45) out of brass. No troubleshooting row covers a metal reading too
  bright or changing hue; the rows for metals are all about reading dark or dull.
  Fixed by `power=0.45` (L3: (208,178,88), hue 45). Cost: two renders and a pixel
  sampler of my own to see why.
- **F7. A rougher brass reads paler and lemon, not just softer.**
  `dogfood/plaque_probe_metals.aix`, four tiles side by side under the plaque's lights:
  `brass` (rough 0.35) (210,179,89) hue 45 s 0.57; `gold` (238,188,69) hue 42 s 0.71;
  `bronze` (246,213,141); `material("brass", rough=0.5)` (245,232,119) hue 54 s 0.51.
  So the brass preset is told from gold by number, but roughening it (which I did for
  a satin cast field, F2) moves it toward lemon: the language doc says rough "decides
  what a surface reflects" and that from 0.35 to 0.55 "one traced ray is blended into
  the blurred sky, more of the sky the rougher it is", but not that, in the white
  studio, this changes a coloured metal's apparent hue. Cost: one probe render and one
  finish render (F3, back to 0.4).
- **F8. Polished raised brass letters read darker than the field, and the row's fixes do not apply to a plaque.**
  F2, `polished = material("brass", rough=0.2)` on the title: its faces mirror the
  dark room and read olive, with bright bevels, darker than the satin field round
  them. Row: "metal lettering, or a metal face turned to the camera, reads dark ...
  paint the letters a non-metal ..., or turn the face towards the light". A brass
  plaque's letters cannot be a non-metal, and turning a flat plaque's face to the
  light means the key in the mirror direction, which I tried (L4, power 0.45): the
  whole plate went flat lemon (248,242,141), the title near white, and the engraving
  back to outlines (F4). `rough=0.28` (F4) lightened the faces a shade. I kept dark
  faces: they still read as raised, by their bevels and shadows. Cost: two renders.
- **F9. A skin under a cell that closes a hole is invisible to every picture and to `check`'s warnings.**
  The sabotaged 0.25 mm skin (0.375 of a cell): `check` printed `no warnings`; the
  sabotaged sheet's top view shows the holes white through, exactly as the real ones;
  `beauty.png` at 768 draws the closed hole's bottom dark blue like the open one's,
  told apart only by a one-pixel bright ring (crops set side by side). "Detail thinner
  than a grid cell disappears" covers it, but the consequence for a "goes through"
  check is not said: only the asserts can tell, so they had better work (F5).
- **F10. Millimetres come only with a PLA print report.**
  `set units mm` to get millimetres in the sizes made the casting a print: `Summary |
  one piece, watertight; a wall 0.737 mm thin`, `about 105.5 g of PLA`, and `under
  the 1.2 cells the mesh needs to hold a wall: the mesh may be broken there` beside
  `Watertight | yes`. The docs are explicit that `set units` makes a print; there is
  no way to say "millimetres, cast". Cost: a section to read past. (The wall row did
  locate the fin in the W, which was useful.)
- **F11. The default beauty size is not written anywhere.**
  The first `--beauty` wrote `beauty render 512px`; the docs' timings mention both
  384 and 512 px and `set size N` gives no default. `--size 384` also shrinks the sheet
  and `--size 768` gives a 1548 × 1578 sheet; `--beauty-size` is the beauty alone. Cost: nothing but a wrong guess.

## 4. Reading the pictures

**What I read off beauty.png that a number showed wrong.** In the finished plaque,
nothing: I checked each reading against a number. The holes read through (dark
centres in the countersinks), and `void` per rod, `clearance` 1.05 and the
`--slice rod_r` sections agree; the title and lines read clear of the border by about
10 mm, and `clearance` says 9.45 and 9.5; the brass read as brass at L3, and the
metals probe puts the field's (208,178,88) hue 45 s 0.57 on the brass tile's
(210,179,89), not the gold tile's (238,188,69) hue 42 s 0.71. But four readings were
wrong or would have been:

- The sabotaged copy's closed holes (a 0.25 mm skin) read through in `beauty.png` at 768, side by side with the open ones; `void(rod_l, ...)` said `is 0 == 1, solid at (-87.1, 2, -0.4)`, `clearance` -1.2, and `height(plaque, hole.x, 0)` 2.25. A hole going through cannot be read off this camera's picture.
- L1 and L2 I read as gold; the numbers said neither gold nor brass but clipped lemon (hue 58, s 0.24): it was exposure, not material (F6).
- The engraving's depth read off the light, not the cut: the same 1.2 mm strokes read as dark solid cuts under the default key (render 2) and as an outline font under L3 (F4). Not a number contradicting a picture, but depth cannot be read off `beauty.png`.
- Not `beauty.png` but `slices.png`: Y = 3.5 drew the engraved letters as cut through 0.3 mm below their floor; `inside(floor_probe, plaque) > 0.99` held at 1 (F3).

**How many renders the lighting took: 4**, the picture right at the third. L1 key in
the mirror direction (lemon, clipped), L2 off it (still clipped), L3 power 0.45
(kept), L4 back in the mirror direction at 0.45 to brighten the title (flat lemon,
reverted). **The finish took 5**: F1 engraving 1.2 to 2 mm (lines turn solid dark
with a light lip: read as cut), F2 satin bumped field and polished title at 384 and
at 768 (cast grain reads; title faces go olive; field (234,202,101) and saturated,
risk of gold), F3 field rough 0.5 to 0.4 (the left-to-right gradient returns,
(225,194,99) to (244,232,134); more metal), F4 polished rough 0.2 to 0.28 (a shade
lighter title; kept). The probe of four metals was one more render that settled
"brass, not gold" by number.

**Troubleshooting rows met.**

- "a polished engraving is faint, read only at its edges" (guide; skill's "faint, or sparkles"): met at L3. Its "rough=0.2 or more" was already true; its "cut the letters deeper" got me out (1.8 to 3 cells, F1).
- "metal lettering, or a metal face turned to the camera, reads dark": met at F2 on the polished title. Neither fix applied; did not get me out (F8).
- "gold or silver look dull ... on the sheet ... judge metals in beauty.png ... brass the greener yellow": told me where to judge; the metals probe gave the numbers behind "greener".
- "lettering is a blob on the sheet" and "a shell wall, tube or lettering is broken": not met; `check`'s grid-300 notes kept every stroke above two cells.
- Met with no row: a flat metal face blown to lemon when lit for colour (F6); a roughened brass turning lemon (F7); a probe promise that passes on a closed hole (F5, no symptom at all until sabotaged); a sub-cell skin invisible in every picture (F9).

**384 against 768** (final program, `out/plaque_384/beauty.png` and `out/plaque/beauty.png`).
At 384 the plate is about 355 px across, 1.8 px a millimetre; the date line stands
about 14 px tall and the engraved strokes are 2 to 3 px. Every line reads. The
engraved lines are solid dark letters; their light lower lip is a pixel or less, so
they read as dark lettering more than as cuts, and as cuts mainly because they have
no shadows. The title reads, but its olive faces with a one-pixel bright top bevel
and a dark shadow below give each stroke a doubled look, and the slab serifs merge
into the strokes. The field's cast grain is a speckle. At 768 (3.6 px a millimetre,
the date line about 28 px) the title shows clean bevels, serifs and a drop shadow and
reads unmistakably raised; each engraved stroke has a dark floor and a light lip
along its lower edge, and reads cut; the grain reads as a satin casting; the
countersinks show their cones. The field is the same colour at both sizes: at 384
(222,191,95) left, (230,208,108) centre, (243,227,125) right; at 768 (224,193,97),
(232,208,107), (245,231,129).

What I changed to make it read: in the model, letter spacing (title `spacing=2`,
lines 1.2) so no gap closed, engraved strokes 1.2 to 1.4 mm and cap 7 to 7.5 so they
are over two cells, and the engraving 1.2 to 2 mm deep so its floors stay dark under
a key that lights the face; in the material, a satin bumped field (`rough=0.4,
bump=0.06, bump_scale=0.5`) against polished border and title (`rough=0.28`), so the
flat face has grain and a gradient and reads as metal rather than paint; in the
light, a key near but not in the face's mirror direction at under half power
(`azimuth=160, elevation=40, size=4, power=0.45`), which shows brass's colour without
rolling it to lemon, and a front-left fill (`power=0.5`) for the letters' walls.

## 5. What worked well

- `check` before any render caught both lettering problems with numbers: `the space between A and R is only 0.117 wide, 0.175 of the 0.667 cell, and closes up in the mesh` and `'engraving' (1.8 cells); thicken them to two cells or raise the grid`.
- Failing asserts say where and in which step (`solid at (-41.6, 3.18, 16.27) in 'base'`, `closest at (-38.14, 4.5, -33.55)`), so each sabotage was recognisable at once; a probe made from the same `text()` at a thinner weight pins an engraving's depth from both sides, and caught a 0.2 mm fault in one line of three.
- `--beauty-only` is fast enough for a loop: 1.7 to 2.2 s for the shot at 384, 8.2 s at 768, about 7 s a run all told.
- `lights.png` showed at a glance that the key makes the colour and the fill only the walls' highlights.
- `--slice rod_r` (a region) cut the hole lengthwise and framed it: the clearest proof the hole goes through.
- The cavity term: at 3 cells deep the engraving reads dark under a key that lights the face; the docs' "a cut deeper than about 3 cells adds nothing" was the right number.
- The bump finish worked first time at millimetre scale, and the brass preset is, by number, distinct from gold.
- `fmt --check` passed the programs as written.

## 6. Three changes that would have helped most

1. **`void` and `inside` must not thin their lattice over a region of copies far apart.** Lay the lattice per connected piece (or per copy of a `mirror`, `array` or `ring`), or warn when the lattice spacing is wider than the region's thinnest part; until then the skill and the guide should write the "goes through" promise as one rod per hole with `clearance(rod, part) > 0` beside the `void`. As written, the docs' own pattern with `mirror("x")` passed a hole closed by a 0.25 mm skin (F5), and no picture could have shown it (F9).
2. **Guidance, and a warning, for lighting flat metal.** A row or a paragraph for a plaque, nameplate or panel: the face mirrors the direction at the camera's azimuth plus 180 and its elevation; a key there shows the metal's colour but past about half power rolls it to lemon or white (a render note when a metal face clips would say so: "92% of 'base' is over 245 in beauty.png: lower the key's power"); a key there also lights engraved floors, so cut 3 cells or keep the key off that direction; a rougher coloured metal reads paler in the studio; and polished raised letters on a flat plate read darker than a satin field.
3. **Slices that show the cut, not a surface a cell away.** A horizontal plane 0.3 mm under an engraving's floor drew the letters filled as if cut through (F3); draw only what the plane cuts, or label the band of surface within a cell of it, so a slice can be the truth about depth the guide says it is.
