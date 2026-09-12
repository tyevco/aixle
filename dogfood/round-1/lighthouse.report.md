# Lighthouse: the agent's report (summary)

Round 1. Brief: a lighthouse on a rocky outcrop with a keeper's cottage
and a stone path, as a scene, from the docs alone. Three render
iterations. The agent's report was not kept verbatim; what follows is
the list of friction it raised, as recorded when the fixes were made,
and what changed because of it.

## Friction raised

- The report told a scene that sat on the floor to `ground()` itself,
  because a `difference` keeps the bounding box of what it cut away and
  the note read the box. Fixed: the note, the floor grid and a "Surface
  extent" row read the mesh.
- There was no way to set something down on a blended or bumpy top
  without guessing its height. Fixed: `height(s, x, z)` and the bounds
  queries `top`, `bottom`, `width`, `depth`, `tall`.
- A small part of a large scene was a few pixels on the sheet. Fixed:
  `--focus name` and `set focus name` frame every view on one step or
  object (and in round 2 became a real close-up).
- `granite` on a small block read as flat grey; there was no way to
  shrink a preset's pattern. Fixed: `material("granite", scale=0.4)`
  derives a material from a preset.
- The slices of a scene cut through the middle of the whole scene, which
  was air. Fixed: a scene's default cut goes through its first object.
- Docs did not state the bounds rule, that glass shows what is behind it
  rather than inside it, the CLI flags, or polygon winding. Fixed: all
  four documented.

## Not done then, done since

- A per-object close-up sheet: `--focus` re-extracts the focused step at
  its own cell since round 2.

## Not done

- A larger default sheet for scenes (the docs point at `--size`).
