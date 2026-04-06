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

## Registry behavior

Registry initialization is lazy (`OnceLock`) and sourced from generated plugin encoder wiring.

Common operations:

- find encoder by extension
- list supported extensions

## Generated wiring

`src/encoders/generated_plugin_encoders.rs` is generated. Do not manually edit it.

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
