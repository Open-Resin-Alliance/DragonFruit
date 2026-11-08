# Encoders and Registry

## Purpose

The core engine is format-agnostic. Container output is owned by encoder implementations.

## Encoder interfaces

### `FormatEncoder`

Base contract for format-specific output:

- `output_format()`
- capability flags (`requires_*`)
- bytes/path container output methods

### `RleStreamEncoder`

V3.1 performance-oriented contract for streaming encoded layers:

- `consume_rle_layer(...)`
- `parallel_encode_fn() -> Option<Arc<...>>`
- `store_encoded_layer(layer_index, bytes)`
- `finalize_to_bytes()` / `finalize_to_path(...)`

If `parallel_encode_fn()` is `Some`, pipeline uses the preferred V3.1 rasterize+encode worker path.

### Multi-tank

A job with `tank_count > 1` renders every layer once per tank and delivers the
run streams to `consume_rle_tank_layer(layer_index, tank_index, runs)`,
tank-major: all layers of tank 0, then tank 1, and so on. Formats that can store
independent per-tank streams override `supports_multi_tank() -> true`; the engine
refuses a multi-tank job on a format that does not, and never falls back to
painting every tank as Tank 1. Support geometry is part of Tank 1's stream by
construction.

## Registry behavior

Registry initialization is lazy (`OnceLock`) and sourced from generated plugin encoder wiring.

Common operations:

- find encoder by extension
- list supported extensions

## Scene-owned layer settings ranges

Formats opt in through `FormatEncoder::supports_layer_settings`; its default is
false. The engine calls `ensure_layer_settings_supported` before initializing
raster/stream output and at direct encode dispatch. Unsupported encoders reject
a nonempty root `layerSettingsRanges` array rather than silently ignore it.
Malformed collections are errors even when no stored layer would match.

The frontend declares the same contract with `layerSettingsFields` on
`SlicingFormatDefinition` and optionally `SlicingFormatVersionOption`.
`resolveLayerSettingsFields` first resolves the normalized/default version;
an explicit version list replaces the format list. Missing capabilities mean
no range support. The pure `findUnsupportedLayerSetting` check rejects the
first supplied incompatible field, including shadowed and beyond-EOF ranges.

| Format/version | Supported range overrides |
| --- | --- |
| GOO V1.2 and V5.1 | All 14 canonical fields |
| CTB V2 | Exposure and light-off delay only |
| CTB V3/V4/V5, ordinary and encrypted | All canonical fields except independent total retract height |
| Anycubic AFF/AZF, all declared printer variants | Exposure, total lift height, lift speed |
| LUMEN/NanoDLP and unopted-in runtime encoders | None in this feature |

Each outer finalizer constructs `LayerSettingsSchedule::from_job` once before
creating a destination. Nested record/container writers borrow the schedule.
Legacy layer bounds remain valid; `{ unit: 'mm', startMm, endMm }` is resolved
against nominal printed-layer end heights without rewriting saved mm values.
The existing `effective.layerHeightMm` metadata retains nominal f64 precision;
when supplied it must cast to the job's f32 layer height. Raw jobs without it
use that f32 height's shortest display-decimal. Bounds and computed end heights
are compared after a single final binary32 rounding, avoiding unit-switch loss
at heights such as 0.03 mm. This changes neither geometry nor raster settings.
`patch_at` is indexed by the actual zero-based physical layer index, independent
of layer arrival order. The record writer selects its existing bottom,
transition or normal baseline first, then merges the sparse patch. Image
compression and raster data do not change. See [Slice Job Assembly](../slice-job-assembly.md)
for the whitelist, units, inheritance, endpoint and priority contracts.

GOO height overrides are total travel plus a stage-2 part; stage 1 is their
difference. Untouched stage pairs keep their original f32 values. CTB stores
total lift directly and derives total retract from it. Both reject an effective
stage-2 height above its total before opening output, checking compiled interval
starts and crossed bottom/nonbottom boundaries. Explicit exposure is a final
constant, not another interpolation endpoint.

AFF/AZF convert explicitly supplied speeds from mm/min to mm/s. AFF writes
parameters in LAYERDEF; SUBIMGS has image references and padding, not duplicate
print settings. AZF keeps its legacy first-stage controller height unless the
patch explicitly supplies total lift height. Originally nonempty schedules
activate the relevant per-layer flags even when all ranges are beyond EOF;
absent/empty schedules preserve the previous flag policy. CTB schedules force
per-layer activation even when metadata explicitly disables it.

Legacy print-time, volume, weight and cost estimates are unchanged and may not
reflect these overrides. Decoded-container checks establish serialized values,
not firmware acceptance of activation flags; desktop/printer acceptance remains
a separate verification step.

## Generated wiring

`rust/dragonfruit-slicing-engine/src/encoders/generated_plugin_encoders.rs` is generated. Do not manually edit it.

Plugin registry scripts own this artifact and should be rerun when plugin encoder metadata changes.

## Current production path

Athena NanoDLP encoder is the primary production implementation and uses V3.1 RLE streaming and packed PNG strategies.

## Adding a new format

1. Implement encoder in plugin-owned Rust module.
2. Set capability flags accurately.
3. Register via generated plugin registry flow.
4. Validate both bytes and path output methods.
5. Confirm `supported_output_formats()` includes the new extension.

## Common mistakes

- capability flags that do not match actual payload consumption
- returning `None` from `parallel_encode_fn` unintentionally (silent perf fallback)
- adding hardcoded format branches in `engine` instead of registry-based resolution
