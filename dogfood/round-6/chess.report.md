# Dogfood report: `chess`

Files: `dogfood/chess.aix` (the model), `dogfood/chess_pieces.aix` (the piece library it `use`s), `dogfood/chess_reimport.aix` (GLB re-import probe), `dogfood/chess_probe_nodes.aix` (export-node probe). Outputs in `out/chess/` (sheet, slices, steps, `model.glb`, `model.stl`, `beauty.png` at 1024). Nothing committed; nothing outside `dogfood/` and `out/` touched. 16 renders used of the 25 budget (11 of the model, 5 of the piece library).

## 1. The model

A chess set in the starting position on a 4 × 0.18 × 4 board; the king is 0.5 tall (0.65 top of the scene with the board). Unit: the board is 4 across, a square is 0.45, the border 0.2.

**Pieces** (`chess_pieces.aix`): one `def` per kind, all built from `turn(pts) = revolve(polygon(pts))` with a closed (r, y) profile on x ≥ 0, unpainted so the same def serves both colours:
- pawn: turned base/stem/collar + `sphere` ball, `union(k=0.012)`
- rook: turned drum minus two crossed boxes (`ring(2)`) for four crenellations, minus a cylinder well
- knight: turned base + a side profile (14-point polygon) `extrude(..., 0.062, "x") | round(0.006)`, blended on with `union(k=0.018)`; muzzle towards +z
- bishop: turned stem + `ellipsoid` mitre, minus a slanted `box | rotate(x=-40)` slot, + ball, `union(k=0.01)`
- queen: turned flaring crown minus eight vertical cylinders `ring(8)` for the coronet, + ball
- king: turned crown + two boxes for the cross

**Board** (`chess.aix`): `slab - recess` gives a walnut slab with a 0.03 recessed field so the border stands proud; the squares are two `decal`s on the recess floor: a maple `field` box straddling y = 0.15, then `darks` = a dark `tile` at a1 copied by `grid(4, 4, 0.9, -0.9)` plus the same offset one square. No geometry for the squares, so no coincident faces.

**Placement**: `def square(f, r)` returns a square's centre; `rank_of`/`pawn_rank` build `[x,y,z,yaw, ...]` lists for `place()`. Black pieces are placed with yaw 180 so the knights face white.

**Scene**: `scene board, w_rooks, w_knights, w_bishops, w_queen, w_king, w_pawns, b_rooks, ...` (13 objects). I started with the brief's `scene board, white, black` and moved off it: see friction item 3.

Final `check`: `use p chess_pieces: turn, pawn, rook, knight, bishop, queen, king`; numbers `sq 0.45, top_y 0.15, a1 -1.57`; board steps `slab/body/board 4 × 0.18 × 4`, `recess 3.6 × 0.2 × 3.6`, `field/darks 3.6 × 0.06 × 3.6`, `tile 0.45 × 0.06 × 0.45`; piece groups `w_rooks 3.33 × 0.32 × 0.18`, `w_knights 2.45 × 0.37 × 0.2` (surface line 2.43 × 0.36 × 0.19), `w_bishops 1.55 × 0.42 × 0.2`, `w_queen 0.22 × 0.46 × 0.22`, `w_king 0.22 × 0.5 × 0.22`, `w_pawns 3.31 × 0.25 × 0.16`, black the mirror at z −1.69..−1.04; `output: scene 4 × 0.65 × 4`, `grid 320: cell 0.0125`, `no warnings`.

## 2. Print-readiness and re-import

Final `out/chess/report.md`:

| Row | Value |
| --- | --- |
| Size | 4 × 0.65 × 4 |
| Triangles | 510544 (STL: 510544, one mesh of the scene as shown) |
| Watertight | yes |
| Stands | yes, centre of mass 2 inside the footprint |
| Overhangs | 0.4% of the surface faces down more than 45° |
| Pieces | 1 |
| Cavities | none |
| Objects | board, 12 piece groups: 41 GLB nodes, 13 meshes, each copy a node with its own translation (verified by reading the GLB JSON: `w_pawns_1 … b_pawns_8`) |

Close-up rows from focus renders: `w_king` watertight yes at cell 0.002; `w_bishops`, `b_knights` frames were not watertight only at 3 edges each in the queen's crown rim (sphere notches), fixed by switching the notches to cylinders; the queen close-up then reads yes at cell 0.004.

Honesty note on "Pieces 1": the 32 pieces only touch the board (bases at exactly y = 0.15), yet the whole scene counts as one piece, and it stays 1 at `--grid 300` where 0.15 is not on a sample plane. So the count treats touching-from-above as joined; for a slicer the truth is 33 bodies, which is what the GLB's 41 nodes / 13 meshes deliver. The STL is the single fused mesh.

Re-import (`chess_reimport.aix`, `import("../out/chess/model.glb", resolution=320)`): size 4 × 0.651 × 4 vs 4 × 0.65 × 4; volume 2.573 vs 2.575; all 32 pieces present with their tops recognisable in the top view (cross, coronet, crenellations, knight heads, bishop balls); materials gone (documented: positions and triangles only); Pieces 1; Watertight no: 2 edges at (0.233, 0.607, ∓1.56/1.59), i.e. the two kings' cross junctions, 'with itself'. Sampling 532188 triangles at resolution 320 took 88 s (resolution 160: 23 s, with a warning that it is coarser than the render's cell).

## 3. Friction

1. `chess.aix` (first version) `scene board, white, black`, where `white = w_rooks + w_knights + ... + w_pawns` with each a `place()`: the render printed `exports: 3 meshes in 3 nodes`, GLB 15.7 MB, OBJ 48 MB. `docs/language.md` "Scenes" says of `place`: "the export is one mesh with a node per copy, so a forest costs one tree". Expected the 28 placed copies to be nodes; they were flattened once the placed group went through `+`. Probed with `chess_probe_nodes.aix` (one scene object per group): `13 meshes in 41 nodes`. Worked around by making every group a scene object, against the brief's "board and the two armies".
2. `chess.aix:33` and the report: 32 pieces resting on the board report `Pieces 1`, and still 1 at `--grid 300`. The docs say parts "that only touch ... leave a seam that reads as an open edge or a second piece"; here touching read as joined, with Watertight yes. I cannot tell from the report whether a scene's pieces are counted per object or for the union. Left as is, noted above.
3. `chess_pieces.aix:44` (first version `box(0.3, 0.06, 0.014) | rotate(x=-35) | move(0, 0.36, 0.035)`): the bishop's slot cut produced no visible mark on the plate or the `--focus bishop_p` sheet and no warning: the slab was 0.014 thick, near the plate's cell and tangent to the mitre. Nothing told me the cut removed almost nothing; I found it by looking. Rewrote as a 0.022 slab through the front quarter of the mitre.
4. `chess_pieces.aix:55` (first version `sphere(0.024) | move(0.072, 0.412, 0) | ring(8)`): `check` said no warnings, the plate looked fine, but `--focus w_bishops` and `--focus b_knights` on the model reported `Close-up watertight: not watertight at cell 0.006: 1 edges at (-0.246, 0.549, 1.503) in 'w_queen'` — three edges in the queen, found only because the focus frame happened to include her. The message named the step and place (good) but appeared on a frame focused on a different step. Replaced the sphere dimples with vertical cylinders; watertight.
5. `--focus w_bishops` / `--focus b_knights`: focusing on a `place()` group frames the whole span between the two copies (c1 to f1, with queen and king in between), and `--focus white` framed the whole army at cell 0.0121, no better than the main sheet. There is no way to focus on one copy of a placed shape. Worked around by making the king and queen plain moved steps (they are single anyway), and judging the others on the library plate at their own scale.
6. `chess_pieces.aix:71-76` (first version `plate = (pawn() | move(...)) + ...`): the library's loose-pieces warning (`The model is 6 separate pieces: ... in 'plate'`) named only `plate` because the pieces were inline; I had to give each a named step to get `'queen_p', 'plate'` and to be able to `--focus`. Expected, but the "put a def call inline" habit from the docs' examples loses both the names and the focus target.
7. `chess.aix:32`: `grid(nx, nz, dx, dz)` — the reference does not say which direction the copies step (from the original towards +x/+z, or centred). I guessed positive and used `dz = -2 * sq` to step back from a1; the first quick sheet's top view confirmed it. A one-word "copies step in +x and +z from the original" would have saved the guess.
8. `chess.aix:33` `decal(field, maple)` then `decal(darks, walnut_sq)`: worked first time, but the docs suggest a region "should reach a cell or two past the surface"; nothing says whether the region box may extend below the surface into the solid (it may; I used ±0.03). Fine, just unstated.
9. `chess_reimport.aix:3`: the warning after the first `check` (`an import sampled at cell 0.025, coarser than this render's 0.013 ... Give import() resolution=320 to match`) was exactly right, but the cost was not stated: 88 s of sampling, run again by `render` (the docs do say check and render each sample). A cached sampling between `check` and `render` would halve the loop.
10. The report's Overhang row for a scene (0.4%) is for the union; for print I wanted it per object (a knight's muzzle, a queen's flaring crown). Same for Watertight and Pieces: with 13 objects in the Assembly line, the physics rows are still one set for the whole scene.
11. Tooling, not the language: the environment refused a `cat > file <<EOF && npx aixle check` compound command ("too complex to verify that it stays inside the worktree"); split into Write + a plain command. Not Aixle's fault, but it cost a turn.

## 4. What worked well

- `revolve(polygon(...))` with a def `turn(pts)` made every turned piece a one-line profile; `check` sizes matched the plan on the first try and the plate render at grid 256 (1 s) was immediately judgeable.
- `use "chess_pieces" as p` plus a `show plate` in the library gave a self-testing parts file, exactly as the docs describe.
- `decal` for the squares: no geometry, no coincident faces, no speckle, and the first quick sheet showed the a1-dark checker correct.
- `place()` with lists built by defs (`rank_of`, `pawn_rank`); `check` prints the numbers.
- Close-up watertight rows on `--focus` renders named the exact step and coordinates of the three bad edges.
- The GLB has clean per-copy nodes with translations, and the beauty render at 1024 is a usable product shot straight off; `set zoom 1.3` framed it.
- Whole-scene full render with exports at grid 320: 12-17 s.

## 5. Three changes that would have helped most

1. **Keep `place()` copies as nodes through `+` and `scene`**, or say plainly in `docs/language.md` that only a `place()` that is itself a scene object keeps its per-copy nodes. Right now the doc's "node per copy" promise is only true in that one position, and the brief's natural structure (board + two armies) silently gives one mesh per army.
2. **Per-object rows for a scene** in `report.md`: watertight, pieces, overhang, stands, for each object (and each `place()` copy once), and `--focus` on a single copy (`--focus w_pawns_3`). A print-ready set is judged one piece at a time; today the physics section is for the fused union, and "Pieces 1" for 33 bodies resting on a board is not the answer a slicer needs.
3. **A warning when a cut removes almost nothing** (a `-` whose subtracted volume inside the target is under a few cells, as the bishop slot was), the same way an empty output or an unused step is flagged. It is the one wrong thing here that neither `check` nor the sheet caught.
