import type { DragonfruitImportFormat } from '@/supports/types';

/**
 * Off-thread SUPP serialization (autosave freeze fix).
 *
 * The SUPP chunk is the whole scene's world-space support forest. Because
 * supports are world-anchored, moving any supported model reanchors that model's
 * supports (`transformSupportsForModel`), so SUPP genuinely changes on the
 * dominant autosave trigger — the cross-tick chunk cache cannot help. The
 * expensive part was the synchronous `JSON.stringify(supports)` + `TextEncoder`
 * on the main thread (compression and the SHA-256 digest were already off-thread
 * via fflate's pool / `crypto.subtle`). This worker moves the stringify + encode
 * + zlib + digest off the main thread entirely, so the main thread only pays the
 * structured-clone of `supports` on the way in and receives the (small) compressed
 * bytes back by transfer — turning the freeze into at most a hitch.
 *
 * Byte-identity contract (load-bearing): the worker MUST produce exactly what the
 * codec's inline "built" branch would (see `codec-v2.ts`):
 *   raw   = UTF-8 of JSON.stringify(supports)
 *   data  = zlib(raw, level 6) iff raw.length > 64 AND it shrinks, else raw
 *   digest = SHA-256 hex of raw (NOT of the compressed bytes)
 * so a worker result and an inline result are interchangeable in the cache and
 * fingerprint, and buffered ≡ streaming ≡ worker output stays identical.
 */
export interface SupportsSerializeRequest {
  requestId: number;
  supports: DragonfruitImportFormat;
}

export interface SupportsSerializeSuccess {
  type: 'ok';
  requestId: number;
  /** 0 = none, 1 = zlib — the container compression tag of `data`. */
  compression: number;
  /** The emitted chunk bytes (compressed or raw), transferred back to the caller. */
  data: ArrayBuffer;
  /** Uncompressed byte length — the directory's rawSize field. */
  uncompressedSize: number;
  /** SHA-256 hex of the RAW (uncompressed) bytes, for the document fingerprint. */
  digest: string;
}

export interface SupportsSerializeError {
  type: 'error';
  requestId: number;
  error: string;
}

export type SupportsSerializeResponse = SupportsSerializeSuccess | SupportsSerializeError;

/** Mirrors `codec-v2.ts` COMPRESSION_NONE / COMPRESSION_ZLIB and the >64 guard. */
export const SUPP_COMPRESSION_NONE = 0;
export const SUPP_COMPRESSION_ZLIB = 1;
export const SUPP_MIN_COMPRESS_BYTES = 64;
