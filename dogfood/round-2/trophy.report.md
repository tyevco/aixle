# Award trophy: the agent's report

Round 2. Brief: an award trophy about 5 units tall: a stepped marble base
with an engraved two-line nameplate in metal, a fluted or twisted stem, a
cup with two swept handles, raised lettering around the cup's rim that
follows the curve, a figure or star on top, and gold, silver and marble
materials; the engraving legibly deep in the slices, the rim text
readable in the beauty render; iterate until it looks like a product
photo. The agent read only the skill, the two guides, the reference and
three examples. Twelve render iterations of fourteen.

What follows is the agent's report, verbatim. The "fixed" notes in the
index (`dogfood/README.md`) say what changed in the tool because of it.
`trophy_metals_probe.aix` is the probe the agent wrote to see how the
metal presets render.

## 1. The finished model

The trophy is 4.27 × 5.36 × 3.48 units, one piece, stands, no report warnings. From the floor up: two stepped marble boxes (`material("marble", scale=0.4)`), a silver collar, an 8-point-star profile extruded and twisted 70° for the stem, a second collar, a revolved gold cup with a separately revolved cavity, two ellipse-profile handles swept along a spline and mirrored, "CHAMPION" as eight standing extruded letters placed around the rim band (radius 1.3, 13° pitch), and a post through the bowl carrying a knob and a five-point star. The nameplate is a silver box on the front face of the lower step with two lines ("GRAND CHAMPION" / "AIXLE OPEN 2026") subtracted 0.06 deep into a 0.12 plate; the focus slices at Z = 1.72 show both lines as clean voids through the slab, and both lines read in `front.png`. The beauty render shows gold with highlights, silver collars/plate, and legible rim and plate text. Versus the plan: everything landed, with two deviations — the rim text is per-letter placement rather than `text(arc=)`, because `arc=` only bends text in its own 2D plane (a coin face), and gold/silver are custom `material()`s rather than the presets, because the presets render as dull brown and charcoal in the beauty render.

## 2. Friction log

- **`bend` gave no way to know where the bent text lands.** Line (first draft): `rim = extrude(text("CHAMPION", size=0.2, weight=0.06, align="center", spacing=0.03), 0.14) | bend(44) | rotate(x=90) | paint("silver")`. Expected: text wrapped on a circle of radius 57.3/44 ≈ 1.3 that I could then move onto the rim. Happened: `check` printed a loose box `1.49 × 0.26 × 1.49`, and the quick focus render showed a small grey smile of letters *inside* the bowl at the origin, radius ~0.7, along what looked like a spiral. The docs say only "the shape curves up by degrees for every unit along x" — nothing about the centre of curvature, the resulting radius, or the mapping. Gave up on `bend`, wrote the per-letter loop.
- **`text(arc=)` is advertised for a jar label but cannot do it.** `docs/language.md`: "a coin's rim, a label round a jar once revolved... or extruded and wrapped by hand." `arc=` bends in the profile's own x/y plane; there is no documented way to revolve or wrap a standing letter around y, and "wrapped by hand" is not explained. The task said "text with `arc=` or your own approach"; I had to invent the approach (extrude each letter facing +z, `move(0, y, R)`, `rotate(y=...)`), and I had to discover by trial that `for c in ["C","H",...]` over a list of strings, `len()` of it, and a numeric counter `i = i + 1` inside the loop all work — none of these three is in `language.md`, which only shows `for` over `range` and numeric literal lists.
- **The "2 separate pieces" warning does not say which part floats.** Report: `The model is 2 separate pieces (by volume: 12.462, 0.022)`. Expected the step name or the bounds of the loose piece. I had to compute by hand that 0.022 ≈ the star's volume and that its concave vertices (`star(5, 0.42, 0.18)` at y 5.05 → inner radius puts the notch at 4.87) sat above the knob's top (4.80). The front view showed the star apparently touching the knob. Fix: `knob ... move(0, 4.72, 0)`, `star_top ... move(0, 4.94, 0)`.
- **Quick-render warnings recommend a grid the file already exceeds.** With `set grid 240` in the file, `render --quick` printed `warning: 'line1' ... 0.585 of the 0.085 cell ... (set grid 274)` and `'rim' ... (set grid 228)`. The numbers are relative to the quick grid, not the one the full render will use; the message reads as though my settings are wrong. Ignored after realising, but it cost a re-read of the file.
- **The gold and silver presets do not read as gold and silver in the beauty render.** `paint("gold")` and `paint("silver")` (and `material("gold", rough=0.2)`) produced an olive-brown cup and a charcoal plate (the first probe showed even `chrome` as mid-grey). Nothing in the reference's preset table or `material()` doc says metal=1 reflects a dim environment. Worked around with a sphere probe (`trophy_metals_probe.aix`) and `material("#f2c94c", metal=0.5, rough=0.15)` / `material("#e6e9ee", metal=0.5, rough=0.2)`.
- **Silver renders near-black on the sheet too.** In `sheet.png` the `paint("silver")` plate was almost black and the engraved letters light; readable, but the material impression was wrong until I read the beauty render.
- **`--focus` does not frame `beauty.png`.** `render --focus nameplate --beauty` wrote a `beauty.png` identical to the un-focused one. The docs say focus frames "every view"; the beauty render is the exception and nothing says so. I wanted a close beauty shot of the engraving and could not get one.
- **`--quick --beauty` is undocumented but is the fast path.** The docs describe `--quick` as "the sheet only". Trying it with `--beauty` gave a 320 px beauty render in ~3 s, which is what made the material probing affordable; a full `--beauty` run was 34–36 s each (mesh 7.6 s, "hierarchy"/atlas 9.5 s, beauty 5–6 s, plus sheet/views/turntable). Every full iteration paid ~10 s for the GLB atlas I never used; there is no flag to skip exports while iterating.
- **The default slices cannot show a face engraving.** With the default planes (X = 0, Y = mid, Z = 0) the plate cut edge-on shows the engraving as three ~3 px notches — not "legibly deep". Only the focus render's slices (which cut through the focus step's centre, Z = 1.72) showed the letters as voids. The docs mention `set slice_z` but do not say that focus moves the slice planes, which is the thing that actually made the evidence.
- **The bounding box printed for `bend` (and `twist`, and cuts) is too loose to place anything by.** `check` is sold as "sizes that look wrong are wrong", but for `rim` after `bend` the box was of no use for positioning; I needed a render. The doc caveat ("loose after ... a twist") is there, but `bend` is not named in it.
- **The watertight note is unexplained noise for text.** Every full report said `Watertight | no: 32..58 edges shared by more than two triangles ... a feature about a cell thin` while `check` gave no thin-stroke warning at grid 240 (weight 0.055–0.06 vs cell 0.022 = 2.5 cells). Which feature is "about a cell thin" is not said; I assume the letter strokes and moved on.
- **Nothing tells you the rim text band and the handle attachment can collide on screen.** Not a tool bug, but the only way to see that "C" was tangled with the left handle's top was the beauty render; the handle end at `1.2,4.35` sat inside the text band 4.28–4.50. Fixed by ending the spline at `1.22,4.12`.
- **Sandbox, not Aixle:** my first compound shell command (write file + `mkdir -p` + `time`) was refused by the worktree guard, which silently dropped the `mkdir`, so a later `cp` into `dogfood/renders` failed. Minor.

## 3. What worked well

- `check` in under a second with per-step spans; the medal example's comment habit ("check prints each step's x, y, z spans") is exactly how I placed the plate, cavity, post and letters.
- The sheet's four views plus the steps sheet: the first full render immediately confirmed every part's placement, and step 7 showed the engraving cut in.
- The focus render's slices: `Z = 1.72` through the plate is the single most convincing picture of the whole exercise.
- `revolve` of a polygon for the bowl and a second polygon for the cavity (no `shell`): predictable wall, clean rim band for the letters.
- `sweep(ellipse, spline([...]))` for handles: right first time, no faceting.
- `extrude(star(...)) | twist(50)` for the stem: one line, reads clearly at grid 240.
- The report's physics block (stands, pieces, centre of mass) and `report.md` warnings mirrored in the CLI output.
- Loops over string lists and mutable counters — undocumented but they Just Worked.

## 4. The three changes that would have helped most

1. **A documented way to wrap text around y** — either `text(..., wrap=r)` / a `wrap(r)` modifier that puts standing letters on a cylinder, or at minimum a worked snippet in `language.md` for the per-letter loop (and document `for` over string lists, `len`, and counters). And specify `bend`'s geometry (centre, radius = 57.3/deg, which side it curves to) with a check-printable *true* box, or drop "a label round a jar" from the `arc=` text.
2. **Name the culprit in warnings:** "2 separate pieces" should say the nearest step name and the loose piece's bounds; the watertight note should name the step(s) with sub-cell features; quick-mode thin-feature warnings should say "at the quick grid; your `set grid 240` gives 0.022" instead of recommending a smaller grid than the file has.
3. **Make the beauty loop cheap and honest about materials:** document `--quick --beauty` as the preview path, add a flag to skip exports/atlas during iteration, make `--focus` frame `beauty.png` too, and either fix the metal presets so `gold`/`silver`/`chrome` look like their names under the beauty light, or put a rendered swatch strip of the presets in the reference so an agent does not have to probe.
