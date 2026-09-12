# Market stall, again: the agent's report

Round 3: the round-2 brief re-run by a fresh agent against the tool as
fixed after round 2, with three additions: use at least two new
features, ship a GLB, and verify it by a viewer screenshot and a
re-import round trip. The agent was forbidden to read the earlier
attempt. Fourteen render iterations.

What follows is the agent's report, verbatim. The "fixed" notes in the
index (`dogfood/README.md`) say what changed in the tool because of it.
`market_reimport_probe.aix` and `market_reimport_hi_probe.aix` are the
round-trip programs. Line 73 of `market.aix` keeps the empty
intersection the agent describes, as evidence: the tool now warns about
it.

### 1. The model

`market.aix` is a 13.6 × 5.9 × 7.4 stall facing +z: four wooden posts, a plank-fronted oak counter, a red/cream striped canvas tilted 9.5° with a scalloped valance, a walnut sign with raised serif "ROSIE'S FRUIT" on iron chains, three pine crates (apples by `grid`, oranges by `place` with 14 copies, lemons by `array`), a leaning chalkboard with `decal` chalk prices, seven slightly yawed paper bags, a brass lantern with a hollow `glass` drum, a candle and a glowing flame hung by a `bezier` handle from the front beam, on a "tiles" cobble slab. Eleven `scene` objects, 19 materials. It matches the plan closely; the one plan item that did not land is a fourth lemon row (see friction). New features used: `decal` (chalk text; worked, and the beauty render shows it crisply), `bezier` + `tube` (worked, a clean arc at every grid), `text(face="serif")` (worked, readable on the sheet and beauty), `material(glow=2)` and `axis="x"` stripes (both did what the docs said), `set light_azimuth/elevation/ambient` (worked, and the doc row "the counter under the awning is black" was exactly my problem), `--focus` close-ups (worked for the views, not for the slices — below). Render times: `check` 0.8 s; `--quick` 1.7 s; full render with exports at grid 200: 10–12 s (mesh 1.7–2.5 s, hierarchy/atlas 2–2.5 s); `--focus` 8.6–9.4 s; `--beauty` at 512: ~9.4 s total; full render + 1024 beauty: 20.7–22.4 s; re-import at resolution 96: 14.9 s, at 200: 55 s.

### 2. Friction

- `--focus lantern` slices ignore the focus. `docs/language.md` says of `set focus` "the slices cut through it"; the focus run's `slices.png` is titled "SCENE → LANTERN → STALL" and cuts at X=0, Y=2.8, Z=0 through the stall, identical to the main render's. I could not verify the hollow glass or the flame from it. Workaround: a scratch copy of the program with `set slice_x 4.6 / slice_y 3.1 / slice_z 2.4` appended and a second focus render, which then showed the ring wall and the candle inside.
- "Surface extent" in `report.md` was wrong on the first two full renders: `x -7.001..7.001, y -0.3..5.418, z -1.226..3.676 (from the mesh)` for a mesh whose ground slab visibly spans z ±4.5 and whose back posts reach y 5.6. After trimming the ground to 13.6 × 7.4 the row became correct (`z -3.501..3.9, y ..5.617`). The re-import reports are wrong the same way (`y 0.975..5.227, z -0.155..2.912` for posts standing at y=0 and z=−2.2), and the re-import sheet's title `12.5 × 4.25 × 3.07` disagrees with the picture in it (5.6-tall posts, 4.7 deep). I could not explain it; I stopped trusting the row.
- Piece count flips with the cell. Crates and bags sat exactly on the counter top (`crate_y = 2.08 + crate_h / 2`, counter top 2.08). Pieces was 1 at cell 0.07 and 5 at cell 0.068 after only the ground changed (`ground = box(13.6, 0.3, 7.4) …`), with no Warnings entry and no positions, just `Pieces | 5 (volumes 45.404, 1.052, …)`. The final render still reports `Pieces | 2 (volumes 48.09, 0.137)` with no warning line and no location, while the re-import run of the same geometry does print the full "loose pieces are volume … at (x, y, z) in 'm'" warning. Worked around by sinking things 0.02; still do not know what the 0.137 piece is.
- An empty intersection inside an expression is silent. `+ (lemon_row | move(0.17, 0.58, 0.4) | array(2, -0.34, 0, 0) & box(1.2, 1, 1) | move(2.7, 0, 1.0))` — `|` binds tighter than `&`, so the box is at y −0.5..0.5 and the `&` removed the row entirely. `check` warns about an empty *output*, not an empty sub-expression; the row just is not there (lemons top y 2.81, not 2.99). I noticed only from the numbers. Left as-is in the file, as evidence.
- Chalk decal text at sheet resolution. `text("APPLES  2", 0.17, weight=0.045)` as a `decal` region looked perfect in step #36 `priced` and a white blotch in step #37 `chalkboard` (same shape, after `rotate(x=-8)`) and on the sheet. The docs say decal "adds no geometry", so the "weight under a cell" warning (which did fire) did not seem to apply; in the mesh views it does, since the decal is sampled per vertex. Doubled the weight and used `--focus chalkboard`; the beauty render was crisp from the start.
- Text width guessed. `text("ROSIE'S FRUIT", 0.36, face="serif")` was 3.96 wide on a 3.4 board, and `text("ORANGES 3", 0.2, …)` ran off a 1.34 slate (the focus sheet clipped the digits). Only `check`'s box told me; there is no rule of thumb for width per character in the docs. Fixed by reading the box and resizing.
- `--quick --beauty` is not "the field ray-marched": its beauty showed the 0.08-thick canvas as a checkerboard of separate red and white bars, the quick mesh's artefact. At 2.9 s it was useless for judging this scene; the full 512 beauty at ~9 s was the real tool. The agent-guide sells `--quick --beauty` as "the way to try materials".
- Cobbles: I could not tell from "brick courses and tiles rows lie across it" which plane a `tiles` floor would need. Default axis happened to work (top view shows a grid), but it was a guess.
- Placing the coincident-face warning: the guide says overlap parts, and I still butted them; the tool could name the steps whose faces coincide, since it has that at extraction time.
- The "N steps are thinner than a grid cell" warning is permanent for a scene: at cell 0.068 it always names `letters` (0.06), `lantern_glass` (0.06), etc., and the suggested fix "set grid 512" is cubic. No way to acknowledge it, so the title bar always says "1 WARNING".
- Lantern focus top view is the awning canvas over the lantern: the focus clips to a frame in x/z but the full y column, so the top view was useless. Not wrong, but a surprise.
- Slow: re-import at `resolution=200` took 55 s for a 13.6-unit scene and still produced a 0.106 cell sheet (the render grid is separate from the import resolution, which the docs do not say).
- Chalkboard bounds: `check` printed `y 2.1..3.3` for a box I had computed to bottom at 2.08 after `rotate(x=-8)`; the docs say rotated bounds are conservative, but conservative should be larger, not lifted. Sank it 0.04 instead of understanding it.

### 3. Export verification

Viewer: `viewer.html` loads (header "scene 13.60 × 5.92 × 7.40 units · 256664 triangles" and the view buttons render) but the canvas stays blank: WebGL true, and a 30 s wait surfaced `Failed to load resource: net::ERR_CONNECTION_RESET` and `TypeError: Failed to fetch dynamically imported module: https://cdn.jsdelivr.net/npm/three@0.160.0/build/three.module.js`. The same URL answers 200 to curl through the proxy, so it is the headless browser's network, not the page. The page's own "three.js could not be loaded from the CDN" message did not appear within 30 s either.

Re-import (`market_reimport.aix`, `import("out/market/model.glb")`): original 245,596 triangles, 13.6 × 5.92 × 7.4; re-import 27,418 triangles (the report's "Size" row says 13.601 × 5.909 × 7.401 from the file, the sheet title 12.5 × 4.25 × 3.07). Visible differences: the whole ground slab (0.3 thick) and the awning canvas are gone; posts, beams, valance, counter, crates, fruit (as blobs), sign, chalkboard, bags and lantern survive as one grey shape; fine parts (handle, chains, lettering) are lumps; 9 pieces, "would tip over". At `resolution=200` (48,930 triangles) the canvas returns as separate slats, one per stripe, and the ground is still missing — so the ground loss is not a resolution effect; it looks like the last scene node (or a node below y=0) is dropped by the GLB reader.

### 4. What worked well

`check` in under a second with every box, and its sizes catching the two text overflows before any picture; the steps sheet (step #36 vs #37 pinpointed the decal problem in one look); `place`/`grid`/`array` and `scene` did exactly as documented, and the export really is 11 meshes in 25 nodes; `bezier`, `wrap`-free serif text, `glow`, `axis="x"` stripes, `shell` for the crate and lantern; `--out` for focus renders that do not clobber the main one; full renders in ~10 s so iterating on beauty lighting was cheap; the "black counter under the awning" row in the guide describing my exact problem and its fix.

### 5. Three changes that would have helped most

1. Make `--focus` do what the doc says for slices (cut through the focused object), or drop the claim and document `set slice_*` as the way; and fix or remove the "Surface extent" row, which was wrong on four of the reports I read and makes the re-import sheet title contradict its own picture.
2. Report pieces as a warning with locations and the step names every time (the re-import run does; the main run printed `Pieces | 2` with nothing), and name coincident-face contacts, since the count changes with the cell for exactly that reason.
3. Fix the GLB round-trip (the last/ground node is lost at every resolution) and warn on an empty sub-expression (`… & box(...)` that removes everything), the two silent failures I hit.
