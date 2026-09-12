# Park bench: the agent's report (summary)

Round 1. Brief: a park bench with oak slats on cast-iron end frames, from
the docs alone. Two render iterations. The agent's report was not kept
verbatim; what follows is the list of friction it raised, as recorded
when the fixes were made, and what changed because of it.

## Friction raised

- An overload error listed every overload of a builtin, most of them
  irrelevant to the argument given. Fixed: only overloads whose first
  parameter accepts the first argument are listed.
- An unclosed call reported the error at the end of the file with no
  line. Fixed: "the call to X opened on line N is never closed".
- `check` printed sizes but no thin-part warnings, so a slat under a cell
  vanished without notice until the render. Fixed: `check` prints the
  thin warnings for the grid it would use, and the cell size.
- "Watertight: no" with no explanation of what it meant or whether it
  mattered. Fixed: the note explains the cause and the consequence.
- A tube's ends were always hemispheres; a flat-ended rail needed a cut.
  Fixed: `tube(..., cap="flat")`.
- The cell size in the sheet's title bar was rounded to two decimals, so
  0.004 read as 0. Fixed: three significant figures.
- A tiny part in a large step showed an empty thumbnail labelled "no
  surface" on the steps sheet, which read as a bug. Fixed: sized by the
  thinnest dimension, and labelled "too fine for this thumbnail" when it
  still cannot draw it.
- The sign of a rotation and the axis mapping of `extrude` were
  undocumented. Fixed: both stated in the reference and the guides.
- The feature size of each material preset was not stated, so `granite`
  read as flat grey on a small part. Fixed: a Feature size column in the
  preset table.
- Nothing said `--quick` existed. Fixed: the skill's loop names it.

## Not done

- Listing the bodies of `def` functions in `check` output.
