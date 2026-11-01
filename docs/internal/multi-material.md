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
- Switching semantics are **not defined**, but the value is read: the slicing panel's
  Material button and the stats panel's Material row show **Multi-Tank** rather than a
  single profile name while the printer is in that mode.
- Models carry `materialProfileId` and `materialBaseColor`. In multi-material mode the
  model context menu grows a **Material** section listing the resins the printer's tanks
  hold; assigning one also paints the mesh in that resin's colour (remembering the
  colour it replaced, so clearing the assignment gives it back), pushes a single undo
  entry, and the selected model draws a silhouette because a resin colour no longer
  distinguishes selection on its own. Imported models are assigned Tank 1's resin by
  default (a model must always name a material there), and hover draws a fainter grey
  rim instead of a tint.
- Multi-body 3MFs expose their bodies as a drawer under the model row. The bodies are
  processed in the merged model's own space, so a body can be selected on its own and
  given its own material; the renderer then draws one mesh per body (the merged mesh
  stays for picking and overlays). Splitting to bodies still works and carries each
  body's material onto the new model.

## Slicing engine

The engine now has the geometry contract for tanks: `SliceJobV3.tank_count` and
`triangle_tank_index`, with support triangles always in Tank 1
(`tanks::partition_triangles_by_tank`). Nothing renders per tank yet — the next
increments are:

1. ~~pipeline: rasterize each layer once per tank, delivering a run stream per tank~~
   — done (`slice_and_rasterize_rle_multi_tank_v3`, tank-major delivery);
2. ~~`RleStreamEncoder`: a per-tank delivery method and refusal for formats that
   cannot store tanks~~ — done (`supports_multi_tank`, `consume_rle_tank_layer`). No
   format opts in yet: a tank's own image stream inside the container is the next
   decision (Athena/NanoDLP stores one image per layer today);
3. the app payload: map each model/body material to its tank index on the active
   printer and send the assignment with the job;
4. printing: send each tank's stream to its panel/port.

## Next step

Pick one of the three meanings above; then the first slice is the scene model change
(`materialProfileId` on a model, material groups from import), because all three
versions need it and it is the only part that can ship without a product decision on
printing.
