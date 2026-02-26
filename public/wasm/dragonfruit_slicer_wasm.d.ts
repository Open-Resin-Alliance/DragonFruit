/* tslint:disable */
/* eslint-disable */
export function encode_slice_job(job_json: string): Uint8Array;
export function slice_solid_and_encode_job(job_json: string): Uint8Array;
export function slice_solid_and_encode_raw(output_format: string, source_width_px: number, source_height_px: number, width_px: number, height_px: number, x_packing_mode: string, build_width_mm: number, build_depth_mm: number, layer_height_mm: number, total_layers: number, triangles_xyz: Float32Array, metadata_json: string): Uint8Array;
export function slice_solid_layers_chunk_raw(output_format: string, source_width_px: number, source_height_px: number, width_px: number, height_px: number, x_packing_mode: string, build_width_mm: number, build_depth_mm: number, layer_height_mm: number, total_layers: number, triangles_xyz: Float32Array, metadata_json: string, start_layer: number, layer_count: number): Uint8Array;

export type InitInput = RequestInfo | URL | Response | BufferSource | WebAssembly.Module;

export interface InitOutput {
  readonly memory: WebAssembly.Memory;
  readonly encode_slice_job: (a: number, b: number) => [number, number, number, number];
  readonly slice_solid_and_encode_job: (a: number, b: number) => [number, number, number, number];
  readonly slice_solid_and_encode_raw: (a: number, b: number, c: number, d: number, e: number, f: number, g: number, h: number, i: number, j: number, k: number, l: number, m: number, n: number, o: number, p: number) => [number, number, number, number];
  readonly slice_solid_layers_chunk_raw: (a: number, b: number, c: number, d: number, e: number, f: number, g: number, h: number, i: number, j: number, k: number, l: number, m: number, n: number, o: number, p: number, q: number, r: number) => [number, number, number, number];
  readonly __wbindgen_export_0: WebAssembly.Table;
  readonly __wbindgen_malloc: (a: number, b: number) => number;
  readonly __wbindgen_realloc: (a: number, b: number, c: number, d: number) => number;
  readonly __externref_table_dealloc: (a: number) => void;
  readonly __wbindgen_free: (a: number, b: number, c: number) => void;
  readonly __wbindgen_start: () => void;
}

export type SyncInitInput = BufferSource | WebAssembly.Module;
/**
* Instantiates the given `module`, which can either be bytes or
* a precompiled `WebAssembly.Module`.
*
* @param {{ module: SyncInitInput }} module - Passing `SyncInitInput` directly is deprecated.
*
* @returns {InitOutput}
*/
export function initSync(module: { module: SyncInitInput } | SyncInitInput): InitOutput;

/**
* If `module_or_path` is {RequestInfo} or {URL}, makes a request and
* for everything else, calls `WebAssembly.instantiate` directly.
*
* @param {{ module_or_path: InitInput | Promise<InitInput> }} module_or_path - Passing `InitInput` directly is deprecated.
*
* @returns {Promise<InitOutput>}
*/
export default function __wbg_init (module_or_path?: { module_or_path: InitInput | Promise<InitInput> } | InitInput | Promise<InitInput>): Promise<InitOutput>;
