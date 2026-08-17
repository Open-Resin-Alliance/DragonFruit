import { zlibSync } from 'fflate';

import type { DragonfruitImportFormat } from '@/supports/types';
import { sha256Hex } from './meshChunkStore';
import type { CachedChunkPayload } from './voxlChunkCache';
import type {
  SupportsSerializeRequest,
  SupportsSerializeResponse,
} from './supportsSerialize.worker.shared';
import {
  SUPP_COMPRESSION_NONE,
  SUPP_COMPRESSION_ZLIB,
  SUPP_MIN_COMPRESS_BYTES,
} from './supportsSerialize.worker.shared';

/**
 * Main-thread client for the SUPP serialization worker. `serializeSupportsChunk`
 * returns a `CachedChunkPayload` byte-identical to the codec's inline SUPP path,
 * so the codec can store it in the cross-tick chunk cache and feed it to the
 * document fingerprint unchanged. Falls back to an inline (same-thread)
 * computation when Web Workers are unavailable (Node test runner, SSR) or when a
 * worker post fails — the codec always gets a valid payload.
 */

let worker: Worker | null = null;
let triedInit = false;
let requestSeq = 1;
const pending = new Map<number, {
  resolve: (payload: CachedChunkPayload) => void;
  reject: (reason?: unknown) => void;
}>();

function ensureWorker(): Worker | null {
  if (worker) return worker;
  // Only attempt construction once — a failed init (e.g. bundler quirk) should
  // fall back to inline for the rest of the session, not throw every tick.
  if (triedInit) return worker;
  triedInit = true;

  if (typeof Worker === 'undefined') return null;

  try {
    const w = new Worker(new URL('./supportsSerialize.worker.ts', import.meta.url), { type: 'module' });
    w.onmessage = (event: MessageEvent<SupportsSerializeResponse>) => {
      const msg = event.data;
      const entry = pending.get(msg.requestId);
      if (!entry) return;
      pending.delete(msg.requestId);
      if (msg.type === 'error') {
        entry.reject(new Error(msg.error));
        return;
      }
      entry.resolve({
        compression: msg.compression,
        data: new Uint8Array(msg.data),
        uncompressedSize: msg.uncompressedSize,
        digest: msg.digest,
      });
    };
    w.onerror = (event) => {
      // A worker-level failure rejects every in-flight request and drops the
      // worker; the next call re-evaluates `triedInit` and stays on inline.
      for (const [, entry] of pending) entry.reject(new Error(event.message || 'Supports serialize worker failed'));
      pending.clear();
      worker?.terminate();
      worker = null;
    };
    worker = w;
  } catch {
    worker = null;
  }

  return worker;
}

const encoder = new TextEncoder();

/**
 * Inline (same-thread) equivalent of the worker — the byte-identity source of
 * truth shared with the worker. Used as the no-worker fallback.
 */
async function serializeInline(supports: DragonfruitImportFormat): Promise<CachedChunkPayload> {
  const raw = encoder.encode(JSON.stringify(supports));
  const digest = await sha256Hex(raw);
  let compression = SUPP_COMPRESSION_NONE;
  let data: Uint8Array = raw;
  if (raw.length > SUPP_MIN_COMPRESS_BYTES) {
    const compressed = zlibSync(raw, { level: 6 });
    if (compressed.length < raw.length) {
      compression = SUPP_COMPRESSION_ZLIB;
      data = compressed;
    }
  }
  return { compression, data, uncompressedSize: raw.length, digest };
}

export function serializeSupportsChunk(supports: DragonfruitImportFormat): Promise<CachedChunkPayload> {
  const w = ensureWorker();
  if (!w) return serializeInline(supports);

  const requestId = requestSeq++;
  const request: SupportsSerializeRequest = { requestId, supports };
  return new Promise<CachedChunkPayload>((resolve, reject) => {
    pending.set(requestId, { resolve, reject });
    try {
      w.postMessage(request);
    } catch {
      // Structured-clone failure (shouldn't happen for plain JSON) → inline.
      pending.delete(requestId);
      serializeInline(supports).then(resolve, reject);
    }
  });
}
