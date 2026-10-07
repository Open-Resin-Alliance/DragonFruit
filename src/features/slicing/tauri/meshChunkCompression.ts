export type MeshChunkPayload = {
  bytes: Uint8Array;
  headers: Record<string, string>;
  compressionMs: number;
};

export type MeshChunkEncoder = {
  compress: (raw: Uint8Array) => Uint8Array;
  readonly memory: WebAssembly.Memory;
};

type Lz4WasmExports = {
  memory: WebAssembly.Memory;
  malloc: (size: number) => number;
  free: (pointer: number) => void;
  LZ4_versionNumber: () => number;
  LZ4_compressBound: (size: number) => number;
  LZ4_compress_default: (input: number, output: number, length: number, capacity: number) => number;
};

const WASM_URL = '/wasm/lz4-1.10.0.wasm';
const MIN_CHUNK_BYTES = 64 * 1024;
const MAX_CHUNK_BYTES = 256 * 1024 * 1024;
let encoderPromise: Promise<MeshChunkEncoder> | null = null;

function validatedExports(exports: WebAssembly.Exports): Lz4WasmExports {
  if (!(exports.memory instanceof WebAssembly.Memory)
    || typeof exports.malloc !== 'function'
    || typeof exports.free !== 'function'
    || typeof exports.LZ4_versionNumber !== 'function'
    || typeof exports.LZ4_compressBound !== 'function'
    || typeof exports.LZ4_compress_default !== 'function') {
    throw new Error('LZ4 WASM is missing required compression exports.');
  }
  // These exports were checked above; their signatures belong to the pinned ABI.
  const wasm = exports as Lz4WasmExports;
  if (wasm.LZ4_versionNumber() !== 11000) throw new Error('Unsupported LZ4 WASM version.');
  return wasm;
}

/** Instantiate the pinned upstream LZ4 1.10.0 library ABI without fetching. */
export async function createMeshChunkEncoder(wasmBytes: Uint8Array): Promise<MeshChunkEncoder> {
  // WebAssembly accepts this byte view; DOM BufferSource typings vary across TS versions.
  const wasmSource = wasmBytes as BufferSource;
  const module = await WebAssembly.compile(wasmSource);
  if (WebAssembly.Module.imports(module).length !== 0) {
    throw new Error('LZ4 WASM must be a standalone library without host imports.');
  }
  const instance = new WebAssembly.Instance(module, {});
  const wasm = validatedExports(instance.exports);

  return {
    memory: wasm.memory,
    compress(raw) {
      if (raw.byteLength === 0 || raw.byteLength > MAX_CHUNK_BYTES) {
        throw new Error('LZ4 mesh input must contain between 1 byte and 256 MiB.');
      }
      const capacity = wasm.LZ4_compressBound(raw.byteLength);
      if (capacity <= 0) throw new Error('LZ4 cannot represent this mesh input size.');
      let inputPointer = 0;
      let outputPointer = 0;
      try {
        inputPointer = wasm.malloc(raw.byteLength) >>> 0;
        outputPointer = wasm.malloc(capacity + 4) >>> 0;
        if (!inputPointer || !outputPointer) throw new Error('LZ4 WASM allocation failed.');
        new Uint8Array(wasm.memory.buffer, inputPointer, raw.byteLength).set(raw);
        const length = wasm.LZ4_compress_default(inputPointer, outputPointer + 4, raw.byteLength, capacity);
        if (length <= 0 || length > capacity) throw new Error('LZ4 mesh compression failed.');
        new DataView(wasm.memory.buffer, outputPointer, 4).setUint32(0, raw.byteLength, true);
        // Native consumption outlives this call; never hand out mutable WASM memory.
        return new Uint8Array(wasm.memory.buffer, outputPointer, length + 4).slice();
      } finally {
        if (outputPointer) wasm.free(outputPointer);
        if (inputPointer) wasm.free(inputPointer);
      }
    },
  };
}

function loadEncoder(): Promise<MeshChunkEncoder> {
  if (!encoderPromise) {
    encoderPromise = (async () => {
      const response = await fetch(WASM_URL);
      if (!response.ok) throw new Error(`Failed to load LZ4 WASM: HTTP ${response.status}.`);
      return createMeshChunkEncoder(new Uint8Array(await response.arrayBuffer()));
    })();
  }
  return encoderPromise;
}

/** Transport-only lossless compression; the caller retains raw geometry counters. */
export async function prepareMeshChunk(raw: Uint8Array, signal?: AbortSignal): Promise<MeshChunkPayload> {
  if (signal?.aborted) throw new DOMException('Slicing canceled by user.', 'AbortError');
  const headers: Record<string, string> = { 'Content-Type': 'application/octet-stream' };
  if (raw.byteLength < MIN_CHUNK_BYTES || raw.byteLength > MAX_CHUNK_BYTES) {
    return { bytes: raw, headers, compressionMs: 0 };
  }
  const started = performance.now();
  const encoder = await loadEncoder();
  if (signal?.aborted) throw new DOMException('Slicing canceled by user.', 'AbortError');
  const encoded = encoder.compress(raw);
  const compressionMs = performance.now() - started;
  if (encoded.byteLength * 8 > raw.byteLength * 7) {
    return { bytes: raw, headers, compressionMs };
  }
  headers['x-mesh-compression'] = 'lz4';
  return { bytes: encoded, headers, compressionMs };
}
