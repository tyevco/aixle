# CLAUDE.md

Guidance for agents working in this repo.

## What this is

Aixle is a procedural 3D modelling language for language models, and the
tool that turns a program into pictures and meshes. Read `README.md` for the
shape of it, `docs/language.md` for the language, `docs/agent-guide.md` for
how to use it to build a model, `docs/design.md` for why it is built this way.

Layers, each pure and under test:

| Directory | What |
| --- | --- |
| `src/sdf/` | shapes as signed distance fields: primitives, 2D profiles, booleans, transforms, modifiers, paths, the stroke font, materials |
| `src/lang/` | the `.aix` language: lexer, parser, interpreter, and the builtin registry that is also the reference |
| `src/mesh/` | surface nets with dual contouring, mesh measures |
| `src/export/` | the texture atlas baker, OBJ+MTL and GLB writers, the self-contained viewer page |
| `src/render/` | canvas, PNG, font, cameras, rasteriser, the sheets (`views.ts`), the ray-marched beauty render |
| `src/pipeline.ts`, `src/cli.ts` | one run from source to a folder; the command line over it |
| `tools/examples.ts` | renders `examples/*.aix` into `examples/renders/` |
| `.claude/skills/aixle/` | the modelling loop as a Claude Code skill; keep it in step with `docs/agent-guide.md` |

## Hard rules

1. **No runtime dependencies.** Node's `zlib` for PNG and nothing else. The
   tool must run wherever an agent has Node.
2. **`src/sdf`, `src/lang` and `src/mesh` are pure**: no file system, no
   process, deterministic. That is what makes them testable and the renders
   reproducible byte for byte.
3. **Every builtin is defined once, in `src/lang/builtins.ts`, with its
   signature.** The interpreter binds arguments from it and `aixle doc`
   generates `docs/reference.md` from it. Adding a function means adding it
   there, running `npm run docs`, and committing the reference with it; CI
   fails on a stale reference. Do not hand-edit `docs/reference.md`.
4. **`examples/renders/` is generated, never hand-edited.** A changed PNG in
   a diff must come from a change in `src/` or `examples/`, made with
   `npm run examples` and committed together; CI regenerates and diffs.
5. **Degrees everywhere.** `rotate`, `twist`, `bend`, `sin`, `cos` all take
   degrees. One convention for a model writing code.
6. **The distance function is the hot path.** `dist(x, y, z)` takes three
   numbers, returns one and allocates nothing. Anything that allocates goes
   in `hit()`, which runs once per vertex. New unions must keep the
   bounding-box cull; new modifiers must propagate bounds conservatively
   (never smaller than the truth) or extraction misses the surface.
7. **Look at the pictures.** A change to the renderer, a primitive or a
   material is not verified until the example sheets have been regenerated
   and read. An image the agent cannot interpret is a bug in the sheet.

## Commands

```
npm test              vitest over every layer
npm run typecheck     tsc, including tools/ and tests/
npm run aixle -- render examples/mug.aix --beauty     the CLI from source (also: npx aixle ...)
npm run docs          regenerate docs/reference.md
npm run examples      regenerate examples/renders/ (pass names to do a few: npm run examples -- mug vase)
npm run check         all of the above, what CI runs
npm run build         compile to dist/ for the bin
```

## Adding things

- A primitive: `src/sdf/primitives.ts` (exact distance, tight bounds), a
  builtin entry, a distance test in `tests/sdf.test.ts` at a known point.
- A modifier: `src/sdf/ops.ts`; both `dist` and `hit`; bounds; a test that
  the sign is right near the axis and the bounds contain the result.
- A material preset: `PRESET_LIST` in `src/sdf/materials.ts`; a pattern is a
  case in `albedo()`. Patterns reach the exports through the atlas baker,
  which calls the same `albedo()`, so nothing else needs to change.
- A glyph: strokes on the 4 by 6 grid in `src/sdf/font.ts`, then render a
  plate of every glyph and read it.
- A view or sheet: `src/render/views.ts`, with the caption baked in, and a
  size assertion in `tests/render.test.ts`.
- An example: `examples/<name>.aix`, then `npm run examples -- <name>`, then
  read the three PNGs before committing them.

## Git

The default branch is `main`. Work on the branch you were given; never force
push or rewrite history on it. Open pull requests as drafts. Commit messages
say why, in prose.
