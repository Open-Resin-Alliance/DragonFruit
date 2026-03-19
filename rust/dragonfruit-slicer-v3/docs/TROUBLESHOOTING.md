# Troubleshooting

## Unsupported output format

Symptom:

- `UnsupportedOutput(...)`

Checks:

1. Confirm requested `SliceJobV3.output_format` matches encoder extension exactly.
2. Inspect runtime-supported list from `supported_output_formats()`.
3. Regenerate plugin registry artifacts and rebuild desktop + slicer crates.

## Invalid job input errors

Possible errors:

- `InvalidDimensions`
- `InvalidLayerSettings`
- `InvalidBuildVolume`
- `InvalidTriangleBuffer`

Checks:

- ensure non-zero dimensions
- ensure finite, positive build sizes and layer height
- ensure `triangles_xyz.len() % 9 == 0`

## Missing rendered payload errors

Symptom:

- `MissingRenderedLayerPayload(...)`

Cause:

Encoder capability flags and implementation expectations are inconsistent (e.g., encoder expects PNG layers but declared otherwise).

Fix:

Align encoder capability methods with actual encoding implementation.

## Slow rendering or high memory pressure

Checks:

- tune `DF_V3_MAX_CONCURRENT`
- verify benchmark trend after each change
- inspect perf counters (`render_wall_ns`, `render_ns`, `png_encode_ns`, `archive_encode_ns`)

## Cancellation seems delayed

Notes:

Cancellation is cooperative. Long-running work segments must hit cancellation checks before exiting. This is expected behavior for non-preemptive cancellation.

## Build/link irregularities in dev

If odd unresolved symbols appear after major generated-registry or module changes:

- clean/rebuild affected crates
- regenerate plugin registry
- restart Tauri dev pipeline

(These issues are often stale artifact/state related in local dev loops.)
