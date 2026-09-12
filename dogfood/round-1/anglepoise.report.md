# Anglepoise lamp: the agent's report (summary)

Round 1. Brief: an anglepoise desk lamp as a rig with three joints,
poses and an animation, from the docs alone. The agent's report was not
kept verbatim; what follows is the list of friction it raised, as
recorded when the fixes were made, and what changed because of it. The
program is the agent's, with `set pose reading` written the way the docs
showed (which did not work at the time, see below).

## Friction raised

- `set pose reading` failed with `'reading' is not defined`; only
  `set pose "reading"` worked, and the docs showed the bare word. Fixed:
  a bare word after `set pose` and `set focus` is the name.
- No `--pose` flag, and `check` ignored `set pose`, so a posed rig's
  sizes could not be read. Fixed: `--pose NAME` on `render` and `check`,
  with `check` printing the posed sizes.
- `poses.png` and `anim_*.png` were too small to verify a pose. Fixed:
  meshed finer and framed from their meshes; a full-size check of one
  pose is `--pose`.
- The posed report, sheet title and floor grid used the loose bounds of
  turned joints. Fixed: they read the surface extent.
- The sign of rotations, the origin of `helix` (y from 0 to h) and of
  `extrude` (centred), and the text profile's padding were undocumented.
  Fixed: all stated.
- A thin `shell` wall, `text` weight or `tube` radius inside a thick part
  was never warned about, because bounds cannot see it. Fixed: shapes
  carry their thinnest feature and `check` warns from it.
- Small parts were illegible on the sheet. Fixed: `--focus`.
- Slices of a posed rig cut through the rest pose's centre. Fixed: the
  slices cut the posed model.
- The bounds after a `difference` were loose. Documented.
- A worked rig snippet was missing from the skill. Fixed: added.

## Not done

- A full-size `pose_<name>.png` per pose; `--pose` does one at a time.
