---
issue: scene-core
date: 2026-10-18
kind: decision
status: proposed
---

# ADR-0045: Scene operations live in pure modules the app, the CLI and scripts share

## Context

DragonFruit can be driven from outside the window in one way: the TypeScript CLI
(`scripts/dragonfruit-ts-cli.ts`), which reads a `.voxl`, changes it and writes it
back. The goal is more than that: scripted batches for print farms, a protocol an AI
agent can use, tests that drive the scene without the window. Every one of those
needs the scene's rules to run without React.

Today they do not. Scene state and the rules that change it live in hooks:
`useSceneCollectionManager.ts` (8,000 lines, 150 returned keys) and `page.tsx`. The
CLI cannot call them, so most of its 27 subcommands restate a rule by hand:
`support add-trunk` builds roots and trunks field by field, `transform-model`
writes the vector directly. Each restatement is a copy that drifts. Measured on
`dev` @ `707a4e72` (2026-10-18):

- **A second plate is dropped from `scene slice` without a word.** A scene with a
  cube on each of two plates, written with the app's own writer, sends 24
  triangles to the slicer and gets the same 667 layers and the same file as the
  first cube alone. The two `.ctb` files differ in 272 header bytes, 64–335; two
  runs of the one-cube scene differ in 271, the same range. The app scopes a slice
  to one plate and shifts it to the origin (`ExportPanelStack`, `SlicingPanel`);
  the CLI does neither, so the second cube lands outside the build area and is
  clipped.
- **Every CLI command that saves turns a multi-plate scene into a single-plate
  one.** `toBuildInput` hands the writer the models, the selection, the supports
  and the extensions, but not `plates`, `activePlateId` or `meta.printer`, all of
  which the writer accepts. After one `transform-model`, the plate list, the active
  plate and the second model's `plateId` are gone.

Two places already show the way out. `assembleSliceJob` (see
[Slice Job Assembly](../dev/slice-job-assembly.md)) is pure, the app's slice and
`scene slice` both build their job with it, and `cliJobParity.test.ts` holds them
to the same fields. `computeHighPrecisionArrangeUpdates` takes the narrow data it
needs (`ArrangeModel`) rather than the app's model type, which is why the CLI's
`scene arrange` is the same algorithm as the panel.

## Decision

**A scene rule is written once, as a pure function over plain data, and the
manager hook, the CLI and any later surface call it.**

1. **Pure means no React, Tauri, THREE, `window` or browser storage.** The same
   constraint `assembleSliceJob` keeps. These modules can be imported by
   `node --import tsx` with nothing preloaded beyond the Lingui stubs every script
   already loads.
2. **Inputs are the narrowest structural type the rule reads.** A function that
   decides which plate a model stands on takes
   `{ transform: { position: { x, y } }, plateId? }`, which the app's
   `LoadedModel` and the file's `VoxlModelEntry` both satisfy. No shared
   "scene document" class is introduced: the app keeps its runtime state and the
   CLI keeps the VOXL document, and both pass what they hold.
3. **Targets are explicit.** A function takes the ids or the plate it works on,
   never "the selection" or "the active plate" implied by context. Blender's
   context-dependent operators are the cautionary case: they are the part of its
   API that breaks when there is no window.
4. **Functions return data and change nothing.** The manager applies the result to
   its state and pushes history as it does today; the CLI applies it to the
   document and saves. Recording an operation's name and parameters in history,
   and a registry with parameter schemas, come later, once enough rules are pure
   for a registry to have more than two entries. Each function's signature is kept
   to a single parameters object so that registering it later does not change it.
5. **Done means parity.** A rule moves when a test shows the app's path and the
   CLI's give the same result for the same scene. The CLI end-to-end check
   (`npm run check:scene-slice`, run in CI) grows a case for each rule that changes
   what is sliced.
6. **A CLI save keeps every field the writer accepts.** The CLI reads a scene the
   app wrote and must hand back what it did not change. A round-trip test pins it.

### The first module: plate layout

Plates are first because both measured failures are plate failures, and because
plate rules already reach a second path more often than any other (the
architecture review counts 10 models-on-plate filters in 5 files, and 15 plate
fixes since 2026-09-20).

`src/features/scene/plates/plateLayout.ts` takes over from the manager:

- `computePlateFrames({ plates, footprint, ordering })` returns
  every plate's world rect and cascade offset (`PlateFrame`), what the manager
  computes today in its `plateFrames` memo. The local rect each plate starts from,
  restated at four other sites in the manager, comes from one helper.
- `resolveModelPlateId(model, frames)` returns the plate a model stands on: the
  frame containing its position, else its stored `plateId` if that plate exists,
  else the first plate. Today's rule, unchanged.
- `modelsOnPlate(models, plateId, frames)` replaces the inline filters.

Consumers in the first change: the manager's `plateFrames` and
`resolveModelPlateId`, `ExportPanelStack`'s slice scopes, and `scene slice`, which
gains `--plate <id or number>`, defaulting to the scene's active plate. It slices
only that plate's models, shifted by its offset as the app does, and names the
models it left out on stderr. The CLI's save carries `plates`, `activePlateId` and
`meta.printer` through.

## Alternatives considered

- **A registry with schemas first.** Generic `df op <name>` commands and an MCP
  adapter both need one, but registering rules that still live in hooks would
  register copies. The registry comes after the rules it lists.
- **A shared scene-document class that both sides adopt.** It would make the app
  convert its runtime state on every change, or make the CLI carry geometry it does
  not need. Structural inputs give the same sharing without either.
- **Run the CLI through the app's hooks** (mount the manager in a DOM runner). The
  DOM runner works for tests, but the manager pulls in roughly 190 files and a
  React Compiler pass, about 22 s cold, for a command that should take
  milliseconds. It also keeps the rules where the next surface cannot reach them.
- **Embed Python, as Blender does.** Blender embeds an interpreter because it is
  C and C++ and needed a scripting language. DragonFruit's rules are already in
  TypeScript; a Python client can talk to them over a protocol later without
  shipping an interpreter on every platform.

## Consequences

- The manager shrinks by what moves, and the moved code gains unit tests that do
  not need a DOM.
- The CLI loses its restated rules one at a time, each with a parity test. Its
  hand-written subcommands stay until a registry can generate them.
- New scene rules have a home that is not the manager. A rule written in the hook
  after this is a rule the CLI and later surfaces cannot use.

## Open questions

- **The origin mode is a viewer preference, but it decides where every plate is.**
  `view3dSettings.originMode` (`center` by default) sets each plate's local rect,
  and the VOXL does not record it. The CLI assumes `center`. Whether a scene should
  carry the origin it was laid out with, as it carries its plate ordering, is for
  the plate work to answer.

## See also

- [Slice Job Assembly](../dev/slice-job-assembly.md): the pattern this generalises.
- ADR-0044: plates and the embedded printer in the file.
- ADR-0025: the CLI entry points and why the TS CLI is a dev script.
