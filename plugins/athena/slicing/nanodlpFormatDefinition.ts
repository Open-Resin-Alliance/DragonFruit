import type { SlicingFormatDefinition } from '@/features/slicing/formats/types';

/**
 * Athena-specific NanoDLP format definition.
 *
 * This is intentionally metadata-only in TS: the binary format encoder lives in
 * Rust under `rust/dragonfruit-slicing-engine/src/encode.rs` and
 * `rust/dragonfruit-slicing-engine/src/engine.rs`.
 */
export const ATHENA_NANODLP_FORMAT_DEFINITION: SlicingFormatDefinition = {
  id: 'athena.nanodlp.v1',
  outputFormat: '.nanodlp',
  displayName: 'NanoDLP (Athena)',
  ownership: 'plugin',
  layerDataKind: 'png',
  pluginId: 'athena-builtin',
  rustModulePath: 'formats::nanodlp',
  wasmExportName: 'encode_nanodlp_container',
  notes: 'Complex-plugin-owned container format implementation for Athena workflows.',
};
