# Troubleshooting

## `UnsupportedOutput(...)`

Check:

1. `SliceJobV3.output_format` is exact (including leading `.`)
2. registry contains the extension (`supported_output_formats()`)
3. plugin registry artifacts are regenerated after plugin changes

## Validation errors

Likely variants:

- `InvalidDimensions`
- `InvalidLayerSettings`
- `InvalidBuildVolume`
- `InvalidTriangleBuffer`

Verify dimensions/settings are positive and finite, and triangle buffer length is divisible by 9.

## `MissingRenderedLayerPayload(...)`

Usually a capability mismatch between encoder trait flags and what the encoder actually reads. Align `requires_*` with implementation behavior.

## “AA is off but I still see gray/color edges”

Expected for packed modes:

- `gray3_div2`: physical binary pairs are averaged into one logical grayscale pixel
- `rgb8_div3`: physical sub-pixels map into RGB channels and can show channel fringing

Rasterization remains binary at physical sub-pixel resolution when AA is off.

## Encode path unexpectedly slow

Check:

1. encoder returns `Some(...)` for `parallel_encode_fn`
2. dev profile keeps `dragonfruit-slicing-engine` optimized
3. `DF_V3_MAX_CONCURRENT` is not unintentionally low
4. benchmark output to isolate stage regressions

## Memory usage spikes

Potential causes:

- fallback/legacy path using layer materialization
- very high concurrency for very large layers

Tune with `DF_V3_MAX_CONCURRENT`.

## Cancellation appears delayed

Cancellation is cooperative, not preemptive. Delay can occur during heavy per-layer work before next flag check boundary.

## Stale build issues

If symbols/types seem inconsistent after major changes:

- clean/rebuild affected crates
- regenerate plugin registry artifacts
- restart dev runtime/tooling
