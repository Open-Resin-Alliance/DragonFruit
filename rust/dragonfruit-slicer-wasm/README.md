# dragonfruit-slicer-wasm (Scaffold)

Rust/WASM slicer backend scaffold for DragonFruit.

## Purpose

- Move heavy layer raster + container encoding workloads out of JS.
- Centralize file-format definitions (`.nanodlp`, `.goo`, `.lumen`) in Rust modules.
- Allow complex plugins (e.g., Athena) to own vendor-specific serialization behavior.

## Current status

This is a **scaffold**:

- `src/lib.rs` exposes `encode_slice_job(job_json)` through `wasm-bindgen`.
- `src/formats/nanodlp.rs` contains the Athena NanoDLP format-definition module stub.
- `src/formats/goo.rs` and `src/formats/lumen.rs` are core placeholders.
- Real binary container serialization still needs to be implemented.

## File-format definition location

- Core formats:
  - `src/formats/goo.rs`
  - `src/formats/lumen.rs`
- Athena NanoDLP complex-plugin format:
  - `src/formats/nanodlp.rs` (shim)
  - `plugins/athena/slicing/rust/nanodlp_impl.rs` (plugin-owned implementation)

When adding a new plugin-owned format, add a new Rust module under `src/formats/` and route it from `src/lib.rs`.

## Format scope

- Athena target in this scaffold: `.nanodlp`
- Explicitly not supported in this project scope: `.ctb`

## Suggested build commands (once rust toolchain is available)

- Install target: `wasm32-unknown-unknown`
- Build: `cargo build --release --target wasm32-unknown-unknown`
- Bindings: `wasm-bindgen` (or `wasm-pack`) in a follow-up integration step

## TS integration contract

TypeScript format metadata is in:

- `src/features/slicing/formats/types.ts`
- `src/features/slicing/formats/registry.ts`
- `plugins/athena/slicing/nanodlpFormatDefinition.ts`

These declare which Rust module/export should encode each printer output format.
