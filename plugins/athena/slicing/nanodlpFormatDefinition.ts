import type { SlicingFormatDefinition } from '@/features/slicing/formats/types';

/**
 * Athena-specific NanoDLP format definition.
 *
 * This is intentionally metadata-only in TS: the binary format encoder lives in
 * Rust/WASM under `rust/dragonfruit-slicer-wasm/src/formats/nanodlp.rs`.
 */
export const ATHENA_NANODLP_FORMAT_DEFINITION: SlicingFormatDefinition = {
  id: 'athena.nanodlp.v1',
  outputFormat: '.nanodlp',
  displayName: 'NanoDLP (Athena)',
  ownership: 'plugin',
  pluginId: 'athena-builtin',
  rustModulePath: 'formats::nanodlp',
  wasmExportName: 'encode_nanodlp_container',
  notes: 'Complex-plugin-owned container format implementation for Athena workflows.',
};
