# Slice Job Assembly

The slicing engine is shared, but the engine only slices what it is told to. Someone has to turn a
printer profile, a material profile and the prepared scene into the native slice job: the raster
grid, X-packing, build plate, layer height, dithering, format version and settings mode, plus the
`metadata_json` that every format encoder reads its exposure and motion settings from.

That is **job assembly**, and it lives in one pure module:
`src/features/slicing/sliceJobAssembly.ts`. The app's export (`runSliceExportOrchestrator`) builds
its job there, and it is written so that headless callers can do the same without React, Tauri,
`window` or THREE.

Reach for it whenever code needs "the job the app would build" for some profiles. Do not
re-derive any of these fields elsewhere: a hand-written copy drifts, and a drifted copy writes print
files with the wrong exposure or the wrong size.

## Public surface

| Symbol | What it does |
| --- | --- |
| `assembleSliceJob` | The whole profile-driven half of a job: returns an `AssembledSliceJob` with the job fields and the final `metadataJson`. |
| `describeSliceJobModel` | Turns a model (anything with `id`, `name`, `polygonCount` and a position/rotation/scale transform) into the plain `SliceJobManifestModel` the metadata lists. Use it instead of passing THREE objects, which serialize their internals. |
| `buildSliceJobManifestNodes` | The `slicer`, `printer`, `material`, `effective` and `models` nodes of a manifest. Shared by the native manifest and the JS fallback's. |
| `resolveSliceRasterSettings` | Raster grid, X-packing (only for formats whose definition declares `bitdepth-packed-x`), mirroring and layer height. |
| `mergeMetadataOverridesIntoMetadata` | Writes the settings mode and the material's per-format settings (from the format plugin's local-settings adapter) into the metadata. |
| `SLICER_IDENTITY` | The `slicer` node: the app's name, and its version when `NEXT_PUBLIC_APP_VERSION` is set. |

Dithering goes through `resolveEffectiveDitherPolicy` (in `resolveEffectiveDitherPolicy.ts`), which
`assembleSliceJob` calls; pass the user's choice in `dither` and the panel bit depth decides the rest.

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
- **Not here:** anti-aliasing settings, mesh transport, thumbnails and plugin metadata payloads
  (`attachJobMetadataPayloads`). The caller adds those.

## Tests

- `src/features/slicing/__tests__/appSliceJobGolden.test.ts` pins the exact job the real
  orchestrator hands the native slicer, for eight printers, three materials and three panel setups.
  When a change to the job is intended, regenerate with `UPDATE_SLICE_JOB_GOLDEN=1` and review the
  diff of `fixtures/appSliceJobs.golden.json` like code.
- `src/features/slicing/__tests__/sliceJobAssembly.test.ts` checks that `assembleSliceJob` alone,
  without the orchestrator, gives the same fields.
- `src/features/slicing/__tests__/cliJobParity.test.ts` compares the `scene slice` CLI's job with the
  app's.

## Related pages

- [Slicing Engine overview](slicing-engine/index.md)
- [Tauri integration](slicing-engine/tauri-integration.md)
- [Benchmark Suite](slicing-benchmarks.md)
- [CLI reference](../reference/cli.md)
