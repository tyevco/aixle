# Roadmap: what the language needs next

Proposals, not promises. Each says why an agent would want it, what it
would look like in a program, how it would be built on what exists, and
what must be prototyped before building on it (the repo's rule: measure
first). They are ordered by how much they would change what an agent can
make, judged from three rounds of dogfooding. Items move out of here into
`design.md` when they are built.

## 1. Anchors: name points on a part, and they move with it

**Why.** Every dogfooding round spent most of its iterations on placement
arithmetic: a hand computed at `(0.5, 2.22, 0.38)`, a cylinder rod's end
worked out with `sin` and `cos`, a star floated 0.1 above its post. The
program has the numbers but not the meaning, so an inherited program
reads as a wall of coordinates.

**What.** A shape can carry named points, and every transform carries
them along:

```
post = cylinder(0.08, 1) | anchor("top", 0, 1, 0)
arm = box(1, 0.2, 0.2) | anchor("root", -0.5, 0, 0) | anchor("tip", 0.5, 0, 0)
arm2 = arm | rotate(z=30) | attach("root", post, "top")     # root lands on the post's top
p = at(arm2, "tip")                                          # a world point, [x, y, z]
rod = tube(0.05, [at(base, "pin"), at(arm2, "tip")])
```

`attach(part, anchor, target, targetAnchor)` is a `move`; `at()` returns
a list. Primitives get free anchors (`top`, `bottom`, `centre`, the six
face centres), so `box(...) | attach("bottom", table, "top")` needs no
numbers at all. Joints keep their anchors, and `at()` in a pose returns
the posed point, which makes a hydraulic cylinder one line with no
trigonometry.

**How.** `anchors?: Record<string, Vec3>` on `Shape3`, mapped by `move`,
`rotateBy`, `scale`, `joint` (turned by the pose) and kept by wrappers;
unions merge their parts' anchors (a duplicate name warns). `check`
prints a step's anchors after its box.

**Must prototype.** Whether an agent reaches for `attach` unprompted once
the skill shows it (one dogfood round); how a union should resolve two
parts that both define `top`.

## 2. PBR textures baked from the field

**Why.** The GLB carries one baked albedo atlas and per-material
metal/rough factors. A viewer shows flat plastic where the beauty render
shows displaced skin, brushed metal and a glowing flame, because those
live only in the field. "Beautiful" in a browser or a game engine needs
the rest of the PBR set.

**What.** No new syntax for the common case: the atlas baker writes a
normal map from the field's own detail (a `displace` or a fine pattern
becomes bumps on a coarser mesh), a metallic-roughness map wherever a
material varies them, and an emissive map from `glow`. Materials gain
what patterns already imply:

```
m = material("#8a6a3a", "rust", rough=0.9, metal=1, wear=0.3)   # edges worn to bright metal
p = material("plastic", bump=0.02, bump_scale=0.1)               # baked as a normal map
```

`wear` reads the field's curvature (second differences of `dist`, cheap
and exact) so convex edges brighten and cavities darken, which is what
makes a rendered object look used rather than new; the same curvature
feeds the beauty render.

**How.** `albedo()` becomes `surface()` returning colour, roughness,
metal, emission and a height; the baker already has the local point per
texel and calls the same function, so the three extra atlases are the
same loop; the GLB writer adds `normalTexture`,
`metallicRoughnessTexture`, `emissiveTexture`. Normals come from the
field gradient at the texel's surface point minus the mesh normal,
tangent-space encoded.

**Must prototype.** Tangent generation on dual-contoured meshes (charts
are axis-aligned, which helps); whether curvature from `dist` is stable
enough on blended shapes; atlas memory at four maps.

## 3. Modules: `use "file.aix"`

**Why.** Every round rebuilt bolts, chains, lanterns and crates from
scratch, and a `def` cannot be shared between programs. Libraries of
parts are how a language grows past its builtins without growing them.

**What.**

```
use "parts/hardware.aix"            # its defs, relative to this file
use "std/furniture" as f            # shipped with the tool
bolt = hardware.hex_bolt(0.2, 1)
chair = f.chair(seat=0.45)
```

A used file runs in its own scope; its top-level `def`s (and material
names) are exported; its shapes are not, so using a file has no cost
until a `def` is called. `aixle doc parts/hardware.aix` documents a
library the way the reference documents builtins, from the `def` lines
and their leading comments.

**How.** The parser has `import` for meshes already; `use` resolves
through the same resolver; the interpreter evaluates the module once and
binds its defs under the prefix. A `std/` folder in the package with a
handful of audited parts (hardware, furniture, plants) seeds it.

**Must prototype.** How a library `def` states its own frame and anchors
so callers place it without reading it (depends on 1).

## 4. Printing: STL, hollowing, a print report

**Why.** Round 4's bar is print-readiness, and the pieces, cavity,
watertight, stands and overhang checks now exist; what is missing is the
file a printer takes and the two operations every print needs.

**What.** `model.stl` (binary) next to the OBJ and GLB; `hollow(shape,
wall, drain=[x, y, z])` which is `shell` plus a drain hole and no cavity
warning; and a print section in the report: minimum wall thickness found
(from the feature sizes and the mesh), support volume estimate from the
overhang faces, whether it fits a named bed (`set bed 200 200 200`), and
the unit assumed (`set units mm`).

**How.** STL is forty lines over the mesh; `hollow` is `shell` minus a
cylinder along the drain direction; the print report reads what physics
already computes plus one pass over the mesh for the thinnest local
wall (ray from each vertex inward along its normal).

**Must prototype.** Whether the inward-ray wall thickness agrees with
the feature sizes on the examples.

## 5. Smooth 2D profiles

**Why.** `polygon` is the only way to draw a profile, so a vase, a
bottle, a chair's side or a car's outline is a list of corners and looks
it once revolved; `curve()` exists for paths but not for profiles.

**What.** `curve2([x,y, x,y, ...])` through the points and
`bezier2([...])` from handles, as 2D profiles for `extrude`, `revolve`,
`sweep` and `loft`, exact like their 3D counterparts.

**How.** The nearest-point machinery in `curves.ts` restricted to a
plane; a closed profile needs the sign from winding, which `polygon`
already computes.

**Must prototype.** Nothing; the 3D version is measured.

## 6. `assert`: the model's own tests

**Why.** Agents verify by reading pictures, which works, but a program
cannot say what it promises, so the next agent to edit it cannot know
what it broke. Every round's report had a line like "the handle must
clear the rim text" that lived only in the report.

**What.**

```
assert width(model) < 5, "fits the box"
assert pieces(model) == 1
assert clearance(handle, rim_text) > 0.05
```

`check` evaluates every assert and lists the failures with the message;
`render` counts them as warnings on the sheet. `pieces()` and
`clearance()` (the minimum distance between two shapes, from the field)
are the queries that make it useful.

**How.** A statement; `clearance` samples one shape's surface points
(from a coarse mesh) into the other's `dist`.

**Must prototype.** Whether agents write asserts unprompted, or only when
the skill's loop tells them to.

## 7. Image textures and decals

**Why.** A label, a logo, a face, a map: things that are pictures, not
patterns. `decal` paints a region one colour; it cannot paint an image.

**What.** `material(image="label.png")` with a projection (`planar`,
`cylindrical`, `spherical`, `triplanar`, default triplanar) and
`decal(shape, region, image="logo.png")` which projects along the
region's shortest axis.

**How.** A PNG decoder (zlib is already there for writing); the image is
sampled in `albedo()` from the local point; the atlas baker and the
beauty render need nothing else.

**Must prototype.** Filtering: an image sampled per texel at a coarse
atlas aliases; a box filter over the texel's footprint is probably
enough.

## 8. Lights, cameras and environments in the language

**Why.** The beauty render has one key light with a size and direction,
and one camera set by azimuth, elevation and zoom. A presentation needs
a rim light, a coloured fill, an evening sky, and two or three named
shots.

**What.**

```
light("key", azimuth=-40, elevation=55, size=1.5, color="#fff2e0")
light("rim", azimuth=150, elevation=20, power=0.5)
set environment "studio"          # or "overcast", "sunset", "night"
camera("hero", azimuth=30, elevation=20, zoom=1.4)
camera("detail", focus="nameplate", zoom=2)
```

`render` writes `beauty_hero.png` and `beauty_detail.png`; `set camera
hero` picks one for the sheet.

**How.** The ray marcher already loops over one light; several are a
loop. Environments are procedural sky functions the metals already
reflect. Cameras reuse `--focus` and `--zoom`.

**Must prototype.** Render time with three lights and soft shadows on
the market scene.

## 9. Callouts: the picture labelled with the program's names

**Why.** An agent maps a picture back to a step by inference. A view
with each visible step's name drawn at its centroid, and a legend, would
make "the thing at the top left is `lantern_ring`" a fact.

**What.** `callouts.png`: the perspective view with a leader line and
label per named step that is visible, the largest twenty. `--callouts`
to include it in the sheet.

**How.** The per-vertex material and the step's bounds give each
triangle a step; a label at the projected centroid of each step's
visible triangles, pushed apart so they do not overlap.

**Must prototype.** Whether the labels are readable at 512 pixels on a
fifty-step scene.

## 10. `aixle explain`: an outline of an inherited program

**Why.** Round 4 asked agents to take over programs written by others.
`check` prints steps and boxes; what a reader wants is the tree: which
steps feed which, which are transforms of which, what the output is
built from, with sizes and materials.

**What.** `aixle explain model.aix` prints an indented tree from the
output down (`model = body + lid + handles`, then each), each line with
its size, material state and line number; `--json` for tools.

**How.** The evaluation already records every step's dependencies and
the shape tree; this is a printer over them.

**Must prototype.** Nothing.

## Smaller, worth doing when passing

- `aixle fmt`: one layout for programs, comments kept, so diffs are
  about the model.
- Records: `p = {x: 1, y: 2}` with `p.x`, for readable parameters.
- `distance(a, b)` between two shapes from the field, for fits.
- An import cache keyed by the file's hash, so `check` and `render` do
  not both sample a large mesh.
- `def` bodies listed in `check`.
- An APNG turntable, since the PNG writer is there.
- A `--stl`-style `--3mf` for slicers that want units and colours.
- Mesh decimation for web exports.

## What was considered and set aside

- **A full material node graph.** Patterns as a fixed set with
  parameters have covered every request so far; the extensibility that
  matters is `use` and image textures, not a graph language.
- **Runtime plugins in JavaScript.** They would break the rule that a
  program means the same thing everywhere; libraries in the language
  itself (`use`) give the same growth without it.
- **Physics simulation.** Stability and pieces are checked; anything
  more belongs to the engine the GLB is loaded into.
