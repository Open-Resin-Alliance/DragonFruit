# Encoders and Output Registry

## Overview

The V3 slicer is format-agnostic at core pipeline level. Final output behavior is owned by implementations of `FormatEncoder`.

## `FormatEncoder` contract

Defined in `src/encoders/mod.rs`.

Required method:

- `output_format() -> &'static str`

Optional capability flags:

- `requires_area_stats()`
- `requires_png_layers()`
- `requires_raw_mask_layers()`

Encoding entrypoints:

- `encode_container_from_rendered_layers(...) -> Result<Vec<u8>, SlicerV3Error>`
- `encode_container_to_path(...) -> Result<(), SlicerV3Error>`
- legacy PNG-only fallback: `encode_container(...)`

## Registry model

`src/encoders/registry.rs` uses `OnceLock<Vec<Box<dyn FormatEncoder>>>`.

- lazy initialization: `build_generated_plugin_encoders()`
- lookup by extension: `find_encoder(output_format)`
- diagnostics: `supported_output_formats()`

## Generated encoder wiring

`src/encoders/generated_plugin_encoders.rs` is generated and should not be manually edited.

The generator is driven by plugin allowlist and plugin capabilities, ensuring encoder registration remains declarative and consistent with plugin definitions.

## Current format support

The generated registry currently includes plugin-owned Athena `.nanodlp` output (`plugins/athena/slicing/rust/encoder_impl.rs`).

## Adding a new encoder

1. Implement `FormatEncoder` in plugin-owned or crate-owned module.
2. Ensure capability flags reflect actual payload requirements.
3. Add/allowlist plugin definition so generator emits encoder entry.
4. Regenerate plugin registry artifacts.
5. Verify `supported_output_formats()` includes expected extension.

## Common pitfalls

- Returning PNG-only logic while declaring `requires_png_layers() == false`.
- Declaring raw-mask requirement without implementing decode/packaging path.
- Bypassing generated registry and introducing hardcoded format branches.
