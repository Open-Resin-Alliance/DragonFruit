---
issue: voxl-3-4-plates
kind: decision
date: 2026-10-07
---

# ADR-0044: VOXL 3.4 records plates and embeds the printer a scene was built for

## Context

The sidebar work gave the plate a name widget, a lock, and an add-plate button
that says "Coming Soon!" because the plate model is single-plate. Two things
followed from that:

- **The plate name was collected and then thrown away.** `plateName` exists on
  `VoxlSceneState`, the reader applies it, and `ExportManager` puts it on the
  writer's input, but the input type never declared it and the codec assembled
  the `SCNE` chunk from `activeModelId` and `selectedModelIds` alone. It
  compiled as an excess property and was silently dropped on every save.
- **Multiplate has nowhere to live in a file.** A scene has one implicit plate
  and nothing records its identity.

Separately, a scene is packed for a particular machine. Opening one on a smaller
printer selected by the user leaves the plate's models outside the build volume,
where they are flagged and excluded from the slice, and the user is left to work
out why. Recording a *reference* to that printer was not enough: a custom profile
does not exist on the machine opening the file, and matching an official one by
preset id or name is a guess that fails exactly when it matters.

## Decision

**Revision 3.4 is additive; the container floor does not move.**

`SCNE.plates` carries the scene's plates in display order as `{ id, name? }`, and
`META.printer` carries the printer the scene was written for **whole**, in the
profile library's own bundle shape, with the materials that belong to it.

Embedding the definition rather than naming it is what makes a custom printer
work. An import that finds the selected printer smaller than the embedded one on
any axis offers to switch; switching selects the installed profile the bundle
resolves to, matching the official preset id first, then the local id it was
written with, then the name, and otherwise adds the printer from the bundle
through `importPrinterBundle`, the same path the profile library's own bundle
import uses.

Three kinds of field are left out of the embedded bundle, each for a concrete
reason:

- **The network and connection fields** (`network`, `networkFleet`,
  `networkConnection`, `activeNetworkDeviceId`). They are session state rather
  than facts about the printer, and they carry a LAN address and device ids into
  any scene a user shares.
- **An uploaded printer photo.** It is a data URL, and it would be duplicated
  into every save. A factory printer's image is a bundled asset path that exists
  in every install, so that one travels.
- **The bundle's export timestamp.** The autosave write-skip fingerprints the
  document from each chunk's content digest, so a field that changes on every
  save would stop the skip from ever firing and turn every autosave into a full
  rewrite.

Additive is the right call here, and the floor stays at `2`/`3`:

- Nothing is lost. An older reader ignores both fields and shows every model as
  belonging to one plate, which is what the scene would have been before plates
  existed, and it ignores the printer. The plate split is not shown; the geometry
  is all still there.
- No writer can produce a second plate yet. The app has one plate, so a save
  carries a one-entry list. Speculative floor logic for a file that cannot be
  written would be code with no caller.

When the app can create a second plate, the question ADR-0042 poses has a real
answer: two co-located beds merged by an older reader is a wrong scene, so the
floor should rise to `4` for files that carry more than one plate, exactly as
dedup raises it to `3` for files that share a MESH chunk, and the authoring major
moves with it. That is deliberately not done here.

## Consequences

- The dropped plate name is fixed: a save now writes the plate's identity and its
  name. A scene with exactly one plate also writes the older `plateName`
  shorthand, so a reader that only knows that field still shows the name; with
  several plates the shorthand is omitted, since it cannot say which plate it
  names.
- A scene carries its printer, so it grows by the size of that definition and its
  materials. For an official printer that is a name, a volume, display settings
  and an asset path, and for a custom one it is whatever the user defined. This
  is the price of not depending on the importing machine having it.
- Model-to-plate membership is not expressible yet. With one plate every model
  belongs to it, so a `plateId` on the model entry would be a field that never
  varies. It arrives with the plate-state work, and readers already ignore
  unknown model keys.
- The plugin scene payload (`src/features/slicing/voxlScenePayload.ts`) stays
  model-only. It builds a transport payload for a format's own check, not a saved
  scene, and has no scene context to record.
- A printer mismatch interrupts an import with a prompt, but only when the
  selected profile is smaller on some axis, not whenever the embedded printer
  differs, so casually switching printers does not produce noise.
- `plateLocked` remains a session fact and is still not written.

## References

- `docs/dev/voxl-format-spec.md` — the 3.4 revision section
- ADR-0042 — the compat floor and the authoring revision ladder
- ADR-0043 — the V1 removal that left one container and two floors
- `src/features/profiles/voxlPrinterBundle.ts` — profile to embedded bundle, and
  the volume comparison
- `src/features/profiles/profileStore.ts` — `importPrinterBundle`, which reads
  what the scene embeds
