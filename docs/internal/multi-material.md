# Multi-material: branch notes

Tracking branch `feat/multi-material`, based on `feat/plugins-v2`. Nothing is
implemented yet; this file exists so the draft PR has a commit and the open
questions live next to the branch.

## Why this is not started

The feature has three materially different meanings, and the choice decides the
data model, the slice job and the encoder protocol. Writing code before picking one
is how a slicer grows a second material system that matches neither.

1. **Per-model assignment, single-resin prints.** Models carry their own material
   profile, imports keep per-material groups, the viewport and model list show the
   assignment, and the slice job / plugin metadata carry it. A single-vat printer
   warns when the scene mixes materials. No engine change; groundwork every other
   version needs.
2. **Sequential multi-vat.** Slice per material slab and emit a pause/switch at the
   boundary. Needs per-material exposure in the encoder, a pause concept in the
   job, and a printer that can change resin mid-print.
3. **Per-region in one layer.** Different materials inside a layer, as polyjet/inkjet
   machines do. The LCD exposure path cannot represent it; it needs a different
   encoder/format (per-pixel dosing or multiple exposures), realistically a partner
   plugin format rather than a stock profile.

## What already exists (so the work does not reinvent it)

- One active material profile per printer; the whole job slices with it
  (`getActiveMaterialProfile`, `sliceJobAssembly`).
- `DFMX` emits one body per leaf mesh object and deliberately not one per material
  `pid` group (`docs/dev/mesh-wire-formats.md`), because the app imports bodies as
  models.
- The slicing engine has no material concept: `SliceJobV3` carries one exposure,
  lift and retract set.
- The plugin import container has no material field, and a plugin encoder job carries
  the same single set (`docs/dev/plugins-sdk/file-types.md`,
  `docs/dev/plugins-sdk/index.md` under "Known gaps").
- `docs/dev/backlog.md` records "per-material geometry" as the import gap that
  "lands with multi-material support".

## What is on the branch

- `PrinterProfile.materialMode: 'single' | 'multiTank'`, absent meaning **Single
  Material** and `multiTank` shown as **Multi-Tank**; a preset may carry it so a
  machine that ships with several tanks declares that from the library. The printer settings' Output section has the
  matching **Material Mode** control, and the value is sanitised on load and on
  update (an unknown value is dropped rather than guessed).
- Switching semantics are **not defined**: nothing reads the value yet. It is the
  field the next slice will hang off.

## Next step

Pick one of the three meanings above; then the first slice is the scene model change
(`materialProfileId` on a model, material groups from import), because all three
versions need it and it is the only part that can ship without a product decision on
printing.
