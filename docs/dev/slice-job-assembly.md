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
| `assertSliceLayerSettingsSupported` | Rejects an incompatible supplied field using resolved format/version capabilities, before preparation or final assembly. |
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
    layerSettingsRanges,           // captured scene-wide printed-layer overrides
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

## Layer settings range resolution

`src/features/slicing/layerSettingsRanges.ts` is the pure scene-range contract. Use
`parseLayerSettingsRanges` at input boundaries to validate and own an array;
`compileLayerSettingsRanges` returns compact inclusive printed-layer segments.
It imports no React, THREE, storage or translation runtime.

```ts
import {
  parseLayerSettingsRanges,
  compileLayerSettingsRanges,
} from '@/features/slicing/layerSettingsRanges';

const ranges = parseLayerSettingsRanges([
  { id: 'wide', startLayer: 3, endLayer: 10,
    settings: { exposureSec: 4, liftHeightMm: 8 } },
  { id: 'narrow', startLayer: 5, endLayer: 6,
    settings: { exposureSec: 7 } },
]);
const segments = compileLayerSettingsRanges(ranges, 12);
// Printed layer 5 has exposureSec=7 and inherits liftHeightMm=8.
```

The `LAYER_SETTING_FIELDS` whitelist defines `LayerSettingField` and
`LayerPrintSettingsPatch`: exposure, light-off and cure/lift waits in seconds;
lift/retract travel in mm; lift/retract speeds in mm/min; and integer `lightPwm`
in 0..255. A height without `2` is **total** travel, and the corresponding
`*Height2Mm` is the part assigned to stage 2, not extra travel. No patch may
change layer height, anti-aliasing, dithering, geometry, masks or tank assignment.
Explicit zero is an override; absent fields inherit.

Ranges have two persisted forms. Existing layer ranges remain
`{ id, startLayer, endLayer, settings }`, with inclusive printed numbers in
1..4294967295. Physical-height ranges are
`{ id, unit: 'mm', startMm, endMm, settings }`, with finite nonnegative bounds.
A millimetre range never stores converted `startLayer`/`endLayer` keys. Mixed
forms, unknown units, nulls and invalid bounds are errors, not sanitized data.

```ts
const heights = parseLayerSettingsRanges([
  { id: 'height', unit: 'mm', startMm: 0.075, endMm: 0.15,
    settings: { exposureSec: 3 } },
]);
compileLayerSettingsRanges(heights, 12, 0.025); // printed layers 3..6
compileLayerSettingsRanges(heights, 12, 0.05);  // printed layers 2..3
// heights still contains the original millimetre bounds in both cases.
```

`compileLayerSettingsRanges` accepts an optional third `layerHeightMm` argument;
it is required for any mm range, including an empty print. The public
`resolveLayerSettingsRangeBounds` returns original, unclipped printed bounds
or null when no grid point matches. Its derived endpoints can lie beyond the
u32 print domain; they are resolution data, never persisted replacements.

Heights are inclusive nominal printed-layer end heights relative to each build
plate. Resolution multiplies the integer layer number by the nominal f64 layer
height, then rounds the resulting height once to binary32; bounds are compared
in that same binary32 space. This preserves Layers→mm round-trips such as layer
3 at 0.03 mm/layer becoming 0.09 mm, and includes layer 6 at 0.05 mm/layer in a
0.3 mm bound, without arbitrary epsilon rules.

The native schedule uses the existing `effective.layerHeightMm` metadata value
when supplied, after checking that it agrees with the job's f32 layer height.
Raw jobs without that nominal value use the shortest display-decimal of their
f32 height. Parsing remains once per outer finalization; no new native job
field or geometry/raster change is introduced.

A zero or off-grid point may match nothing while remaining saved and originally
nonempty. A layer-height change re-resolves mm ranges but never changes stored
mm values; layer-number ranges keep their printed numbers.

Uncovered layers retain the baseline. Narrowest original **resolved layer span**
wins each supplied field, before clipping to the current print; equal spans
prefer the later array entry, including mixed units. Beyond-domain mm bounds
retain extrapolated original spans rather than acquiring clipped priority.
A narrow exposure-only patch inherits motion from the highest-priority wider
supplier. Editing preserves id/order; Add appends. Segment `rangeId` is the
overall display winner, not necessarily every inherited field's supplier.

`fingerprintLayerSettingsRanges` excludes ids and colors, but retains range
order, the raw unit/physical bounds and fields in whitelist order. `findUnsupportedLayerSetting`
returns the first incompatible supplied field in original range/whitelist
order, including shadowed and out-of-print ranges; consumers must reject it,
not silently drop it.

The native counterpart is
`rust/dragonfruit-slicing-engine/src/layer_settings.rs`:
`LayerSettingsSchedule::from_job` validates the root `layerSettingsRanges`
metadata key and format-owned supported fields, resolving mm against
`SliceJobV3.layer_height_mm`; `patch_at` accepts a zero-based
physical layer index. Parsed values remain f64 until record emission. Both
resolvers sweep endpoints with per-field priority heaps, rather than allocate
an array proportional to the print's layer count. Native `is_empty()` means
the original array was empty: a beyond-EOF schedule still requests the format's
per-layer activation policy even when `patch_at` never matches.

The scene supplies `SliceJobScene.layerSettingsRanges`; assembly validates and
owns it, then writes the root metadata key after material/plugin overrides.
Absent/empty schedules omit that key. The opaque `metadataJson` to native
`metadata_json` transport is unchanged. The orchestrator validates its captured
array at format resolution before asynchronous preparation/baking/staging.
The slicing panel performs localized preflight before confirmations, pickers,
save/start callbacks or preparation; native encoding failures remain visible.

The CLI boundary `preflightSceneLayerSettings` in
`scripts/cli/sceneSliceJob.ts` runs immediately after VOXL loading and also guards
direct `buildSceneSliceRun` callers. Empty schedules preserve the legacy
printerless path. Nonempty schedules require resolved printer/material data
(`Scene layer settings ranges require --printer`) and compatible capabilities.
CLI scene modifications/resaves retain the optional SCNE field.

## Slider editor and captured artifacts

`LayerSettingsRangeEditor` is mounted once at page/root lifetime. Its menu request
contains a printed layer (or `null` for an empty print) and the anchor position;
its durable data is the scene manager's `layerSettingsRanges`, changed through
`updateLayerSettingsRanges`. That updater records one lightweight typed undo
entry per applied change. Model-only snapshots leave ranges alone; deleting the
last model clears ranges in the same model/plate action so undo restores both.

`LayerSliderRangeBand` is drawing data, not another settings store.
`LayerSlider`, `CrossSliderPanel` and `PrintingPreviewPane` accept `rangeBands`
and `onRangeContextMenu`. The page maps scene boundary coordinates with `ceil`
(clamped to printed 1..N, including boundary0→layer1), and printing-preview
coordinates with `round`. Scene bands occupy boundary cells [start−1,end];
printing bands use half-layer edges over the 1..N rail, with a full logical span
for N=1 and no bands for N=0. Segment keys include range id and both clipped
segment endpoints, since one range can win several separated intervals. Bands
share the track centerline and width, render over the clip fill but under the
thumbs, and remain pointer-transparent. Adjacent colored segments share a
single 1px separator (0.5px inset per edge), matching a PLS-to-rail separator: the track/fill underlay is clipped into rounded remaining rail
spans, so both sides of a cut have rounded caps and the actual backdrop shows
through instead of a theme-colored paint patch. The SVG clip geometry uses the
rail viewport and CSS percentage/pixel math, without layout measurements. The
colored marker retains a 2px minimum before viewport clipping. Track/handle
glows are absent. Color paint and its rail cutouts follow the live lower/upper
thumb interval; fully outside bands are not rendered, partially intersecting
bands are clipped without extending minimum-size paint beyond that interval,
and hover hints are tied to the same bounds. Fully hidden bands leave the
ordinary rail intact. Handles remain outside these clips. An empty visible set
installs no rail cut geometry; a nonempty singleton-layer rail retains its full
logical span. These are view-only changes: saved bounds, labels and encoded
settings remain unchanged, and restoring the clip window restores the colors.

Call `useLayerSettingsRangeColors` once and share its map across both rails,
menus and Manage rows. It allocates distinct resolved RGB values in persisted
array order, observes root/OS theme changes and does not persist colors.
`formats/layerSettingsFields.ts` owns pure `resolveLayerSettingsFields` for
encoder/version capabilities. The page resolves the active printer's material
adapter through the same `resolveOutputSettingsMode` and
`getProfileLocalMaterialSettingsAdapter` path as the material editor and passes
it as `materialSettings`; the range editor does not hydrate the registry itself.
`layerSettingsMaterialFields.ts` owns pure `resolveLayerSettingsMaterialRows`: it
selects explicitly `perLayerEditable: true`, enabled numeric fields from that
resolved adapter, binds `perLayerField ?? key` to an existing canonical setting,
and intersects with encoder capabilities. Missing/false eligibility, disabled
fields, unknown bindings and unsupported versions produce no editable control.
Existing material placement ordering and `splitWithKey` determine the rows;
there is no separate per-format or four-pair display list.
`layerSettingsRangeMessages.ts` owns shared localized canonical labels, units and
module-scope interpolated messages. Keep translations out of the pure resolver.
See [Plugin UI metadata](plugins-sdk/ui.md) for JSON eligibility and binding examples. The rail's right-click
track command is separate from the existing handle exact-value editor. The
editor receives `layerHeightMm` from its current slider host and offers
Layers/mm bounds. Material-declared motion pairs share one row and toggle when
both members are eligible and encodable; absent companions are not invented.
Single-value controls, bounds and PWM align with the far (second-value) column,
retaining blank first-value/separator cells and an aligned toggle column. Travel pairs are **Total / Stage 2**; speed
pairs are **Stage 1 / Stage 2**. The first travel value is not the material
profile menu's first-stage distance: total = stage 1 + stage 2.

A pair is checked when either field has an explicit override. Explicitly enabling
a pair seeds both supported fields; disabling it removes both and leaves other
settings untouched. Typing/stepping/wheeling one field enables the row but writes
only that field, so its untouched companion keeps inheriting. Opening, cancelling
or applying an unchanged partial pair never freezes that companion into the
patch. Unsupported or mode-hidden fields are not added by the shared toggle. Explicit
stored values outside the current editable field set remain disabled in a
separate **Unavailable stored overrides** section, with per-field removal; a
profile/mode switch never deletes or materializes sparse values. Existing
format-compatible hidden overrides can be preserved by an unchanged Apply;
format-incompatible values still require repair before Apply/output. Where no wider-range
value is known, the editor labels inheritance as the material-mode default rather
than claiming its numeric editing seed is the encoded baseline.

Supported numeric inputs remain editable when off; focus alone creates no
override. MM endpoint fields use six decimal places and a 0.001 mm step. Empty
or beyond-u32 mm coverage cannot be converted into a fabricated layer range;
its physical data remains editable/savable as mm.

### Profile model view

Choose **Profile** in the camera/view selector to overlay the scene's PLS colors
on model surfaces. `MESH_SHADER_TYPES`/`MESH_SHADER_OPTIONS` in
`src/features/shaders/mesh/types.ts` also make the mode a valid persisted view.
The Mesh settings preview has no scene schedule, so it shows the underlying
Standard material rather than invented sample colors; Profile uses Standard's
lighting, roughness and baked-occlusion controls.

`buildLayerSettingsProfileBands` in `layerSettingsProfileBands.ts` reuses the
canonical narrowest-range/later-tie resolver and the same scene color map as the
slider. MM ranges resolve to printed layers before coloring: layer L occupies
((L−1) × height, L × height], with the plate surface included in layer 1. The
projection retains scheduled heights beyond the active plate's EOF so taller
models on other plates are colored too. Uncovered surfaces and negative world
heights keep ordinary shading; the slider's decorative pixel gaps are not mesh
geometry or gaps in the model overlay.

The page passes `profileColorBands` to `SceneCanvas`. Its model-only
`ProfileColorOverlayProvider` shares one RGBA32F table across materials inside
that Canvas. `ProfileMaterial` reuses `SoftClayMaterial`; the pure
`applyProfileColorShader` decorator and uniform types live in
`src/features/shaders/mesh/profileShader.ts`. The shader samples the final
transformed world Z, including instance/batch transforms, and mixes 85% range
color into the material before lighting. Existing clipping, hover/selection,
roughness and baked AO remain active. Model geometry/vertex colors are not
rewritten; grids, beds, supports and existing X-ray/diagnostic helper passes are
not recolored.

With loaded geometry, scene ranges/colors and existing clipping planes:

```tsx
import { Canvas } from '@react-three/fiber';
import { buildLayerSettingsProfileBands } from '@/features/slicing/layerSettingsProfileBands';
import { ProfileColorOverlayProvider, ProfileMaterial } from '@/features/shaders/mesh/profile';

const bands = buildLayerSettingsProfileBands(ranges, rangeColors, layerHeightMm);

<Canvas>
  <ambientLight intensity={1} />
  <ProfileColorOverlayProvider bands={bands} enabled>
    <mesh geometry={geometry}>
      <ProfileMaterial isSelected={false} isHovered={false}
        useVertexColors={false} clippingPlanes={clippingPlanes} />
    </mesh>
  </ProfileColorOverlayProvider>
</Canvas>
```

The provider uses two nearest-sampled float texels per interval: physical bounds
and linear RGB. Integer texture addressing and a binary search avoid a fixed
uniform-array range ceiling. Hardware/GLSL address capacity failures are explicit,
not silent truncation. Uniform boxes stay stable through palette/count edits;
replaced textures are disposed, and disabling the mode releases its table and
invalidates the Canvas. No per-frame CPU vertex scan is needed. Imperative model
materials (the inactive-model dim pass) obtain the shared GPU ref through
`useProfileColorUniformsRef` in `profile.tsx` and pass its current boxes to the
same decorator from their shader callback. Keep these mutable GPU values in
refs, not React state. Their own Profile program-cache key preserves the
existing dither and opacity recipe without a per-model texture.

This is a view-only feature: it does not change scene ranges, encoded settings,
preparation cache identities or an existing slice. See [Ambient Occlusion](ambient-occlusion.md)
for the shared Standard shading recipe.

### Material settings modes

Modes normalize the material baseline before sparse range patches are applied.
Unset fields inherit wider matching ranges, then the mode-adjusted baseline.
New editable range controls follow the active printer/material-mode JSON, not
just the format's possible serialized fields. Simple does not invent a stage-2
control, and Tilting's removed motion fields stay out of the editable list.
Already-stored explicit overrides still apply after baseline normalization;
switching modes does not rewrite scene data. This is not a per-range mode selector
or a change to the encoder contract. Effective height relations and unsupported
serialized fields still fail before output.

A single export captures an owned array before its first await; an all-plate
batch captures once before picking its folder. Both also capture the encoded
input fingerprint:

```ts
const encodedFingerprint = `${sliceProfileFingerprint(printerId, materialId)}::layer-settings:${fingerprintLayerSettingsRanges(capturedRanges)}`;
```

Keep `sliceProfileFingerprint` unchanged. The page compares artifacts with the
live schedule's composed fingerprint, but records each result with the captured
fingerprint supplied by `onSliceArtifactReady` / `onSlicePlateSliced`. Their
callback context is required when the optional callback is invoked. A batch
retains that fingerprint with every completed artifact, including its repeated
end-of-batch handover. Never substitute live settings when a late result lands.

Range edits/undo/redo stale encoded plate artifacts through existing history
notifications, without changing geometry/prepared-mesh identities or launching
background raster work. The old preview/file remains unchanged until re-sliced.
Legacy time/volume/weight/cost estimates are not recalculated for overrides.

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
