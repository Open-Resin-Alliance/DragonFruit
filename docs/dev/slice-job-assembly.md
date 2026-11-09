# Slice Job Assembly

The slicing engine is shared, but the engine only slices what it is told to. Someone has to turn a
printer profile, a material profile and the prepared scene into the native slice job: the raster
grid, X-packing, build plate, layer height, dithering, anti-aliasing, format version and settings
mode, plus the `metadata_json` that every format encoder reads its exposure and motion settings from.

That is **job assembly**, and it lives in one pure module:
`src/features/slicing/sliceJobAssembly.ts`. The app's export (`runSliceExportOrchestrator`) and the
`scene slice` CLI (`scripts/cli/sceneSliceJob.ts`) both build their job there; it imports nothing
from React, Tauri, `window` or THREE.

Reach for it whenever code needs "the job the app would build" for some profiles. Do not
re-derive any of these fields elsewhere: a hand-written copy drifts, and a drifted copy writes print
files with the wrong exposure or the wrong size.

## Public surface

| Symbol | What it does |
| --- | --- |
| `assembleSliceJob` | The whole profile-driven part of a job: returns an `AssembledSliceJob` with the job fields, the anti-aliasing fields (`antiAliasing`) and the final `metadataJson`. |
| `buildNativeSliceJob` | Turns an `AssembledSliceJob` into the native job's fields, short of the mesh, the thumbnail and the output path; the PNG and container compression rules live here. The app's export and `scene slice` both send its output. |
| `describeSliceJobModel` | Turns a model (anything with `id`, `name`, `polygonCount` and a position/rotation/scale transform) into the plain `SliceJobManifestModel` the metadata lists. Use it instead of passing THREE objects, which serialize their internals. |
| `buildSliceJobManifestNodes` | The `slicer`, `printer`, `material`, `effective` and `models` nodes of a manifest. Shared by the native manifest and the JS fallback's. |
| `resolveSliceRasterSettings` | Raster grid, X-packing (only for formats whose definition declares `bitdepth-packed-x`), mirroring and layer height. |
| `resolveSliceLayerCount` | Layer count and tallest object height for a scene, clipped to the printer's build height. |
| `mergeMetadataOverridesIntoMetadata` | Writes the settings mode and the material's per-format settings (from the format plugin's local-settings adapter) into the metadata. |
| `SLICER_IDENTITY` | The `slicer` node: the app's name, and its version when `NEXT_PUBLIC_APP_VERSION` is set. |

Dithering goes through `resolveEffectiveDitherPolicy` (in `resolveEffectiveDitherPolicy.ts`), which
`assembleSliceJob` calls; pass the user's choice in `dither` and the panel bit depth decides the rest.

Anti-aliasing goes through `resolveSliceJobAntiAliasing` (in `sliceAntiAliasing.ts`), which
`assembleSliceJob` calls; pass the user's choice in `antiAliasing` (see below). Without it the job
slices with anti-aliasing off.

## Anti-aliasing

`src/features/slicing/sliceAntiAliasing.ts` turns what the user chose into the anti-aliasing half of
the job. It is the decision the slicing panel used to make inline, moved out unchanged.

The request (`SliceJobAntiAliasingRequest`) has the panel's inputs, minus what the job already has:

| Field | What it is |
| --- | --- |
| `preset` | The auto AA preset: `sharp`, `balanced`, `smooth` or `raw` (off). The panel's default is `balanced`. |
| `override` | A session override: `{ antiAliasingSettings?, minimumAaAlphaPercent? }`, merged over the material's own. Its `enableOverride` decides whether the material settings or the auto preset drive the job. |
| `lutCurves` | The user's LUT curve library; a custom resin type looks its curve up here by `selectedLutCurveId`. |

`resolveSliceAntiAliasing` is the lower-level call the panel also uses for its controls: it returns
the panel's options, a `decision` (mode, level, the auto config, the minimum alpha) and `warnings`.
`resolveSliceJobAntiAliasing` adds the engine clamps and the support tip shrink rule, and returns the
job fields.

A warning is a choice that could not be honoured, such as a custom curve missing from the library.
The panel slices anyway with the fallback; `scene slice` refuses.

The support tip shrink is geometry, applied while the mesh is prepared, so the export orchestrator
resolves the request once before mesh preparation and `assembleSliceJob` resolves it again; both use
the same function and input. `aaOnSupports` is undefined without a request, and only the
orchestrator falls back to the performance setting there, because that one is read from browser
storage.

## Example

```ts
import { assembleSliceJob, describeSliceJobModel } from '@/features/slicing/sliceJobAssembly';

const job = assembleSliceJob({
  printerProfile,                 // resolved, as the profile store holds it
  materialProfile,
  scene: {
    totalLayers,                  // from the prepared geometry
    tallestObjectHeightMm,
    models: models.map(describeSliceJobModel),
  },
  dither: { ditherEnabled: userChoice },   // optional
});

// job.xPackingMode, job.buildWidthMm, job.ditherEnabled, job.metadataJson, …
```

## Constraints

- **Pure.** No React, Tauri, `window`, THREE or browser storage imports. It does read the plugin
  registry (format definitions and local-settings adapters), so the generated registry files must
  exist: `npm run generate:plugin-registry` and `npm run generate:builtin-simple-plugins`.
- **Resolved profiles only.** Pass the printer the way the profile store holds it. Official presets
  ship `buildVolumeMm.width/depth` as `null` and the store derives them from resolution × pixel
  size; a raw preset gives a wrong build plate. In Node, `addPrinterProfileFromPreset` and
  `importPrinterBundle` resolve one without a window.
- **Materials as the store resolves them.** Pass what `getMaterialProfilesForPrinter` (or
  `getActiveMaterialProfile`) returns: those apply the material's stored per-format settings to its
  own fields (layer height, exposure, …), which is what the slicing panel hands over.
- **Per-format settings win.** For formats whose plugin declares local material settings (GOO, CTB,
  Lumen), the merged metadata carries the material's stored per-format values, or the plugin's
  defaults when none are stored, in place of the material profile's own exposure fields. NanoDLP has
  no such adapter and keeps the profile's values.
- **Not here:** mesh transport, thumbnails and plugin metadata payloads
  (`attachJobMetadataPayloads`). The caller adds those.

## Tests

- `src/features/slicing/__tests__/appSliceJobGolden.test.ts` pins the exact job the real
  orchestrator hands the native slicer, for eight printers, three materials and three panel setups.
  When a change to the job is intended, regenerate with `UPDATE_SLICE_JOB_GOLDEN=1` and review the
  diff of `fixtures/appSliceJobs.golden.json` like code.
- `src/features/slicing/__tests__/sliceJobAssembly.test.ts` checks that `assembleSliceJob` alone,
  without the orchestrator, gives the same fields.
- `src/features/slicing/__tests__/cliJobParity.test.ts` compares the job `scene slice` hands
  `slice run --job` with the one the app hands the native slicer, every field and the whole metadata,
  for four anti-aliasing choices. Only the mesh transport, the model triangle count, the thumbnail
  and the output path are left out.
- `src/features/slicing/__tests__/sliceAntiAliasing.test.ts` pins the anti-aliasing decision for
  every printer, auto preset and eight overrides; regenerate with `UPDATE_SLICE_AA_GOLDEN=1` and
  review the diff of `fixtures/sliceAntiAliasing.golden.json` like code.

## Related pages

- [Slicing Engine overview](slicing-engine/index.md)
- [Tauri integration](slicing-engine/tauri-integration.md)
- [Benchmark Suite](slicing-benchmarks.md)
- [CLI reference](../reference/cli.md)
