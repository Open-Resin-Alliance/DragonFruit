import type { SlicingFormatDefinition } from '@/features/slicing/formats/types';

export type WasmSliceJobEnvelope = {
  outputFormat: string;
  widthPx: number;
  heightPx: number;
  layerHeightMm: number;
  totalLayers: number;
  layerPngs: Uint8Array[];
  metadataJson: string;
};

/**
 * Bridge contract for the upcoming Rust/WASM module.
 *
 * This intentionally does not import the generated wasm pkg yet, so the
 * scaffold can land before the wasm build pipeline is wired.
 */
export async function encodeWithSlicerWasm(
  format: SlicingFormatDefinition,
  job: WasmSliceJobEnvelope,
): Promise<Uint8Array> {
  void format;
  void job;
  throw new Error('WASM slicer bridge not wired yet. Build and bind rust/dragonfruit-slicer-wasm first.');
}
