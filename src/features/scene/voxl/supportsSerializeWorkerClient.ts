import { zlibSync } from 'fflate';
import { info as logInfo } from '@tauri-apps/plugin-log';

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
  /** main-thread ms spent inside the synchronous postMessage (structured clone). */
  cloneMs: number;
  /** timestamp the request was posted, for round-trip timing. */
  postedAt: number;
}>();

const nowMs = (): number => globalThis.performance?.now?.() ?? 0;
const MB = (bytes: number): string => (bytes / (1024 * 1024)).toFixed(1);

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
      // DIAGNOSTIC: split the two costs. `cloneMs` is the main-thread freeze
      // suspect (structured-clone of the support graph during postMessage);
      // `roundtripMs − cloneMs` is worker compute, which does NOT block the UI.
      const roundtripMs = nowMs() - entry.postedAt;
      void logInfo(
        `[SceneAutosave] SUPP worker: clone(main-thread) ${entry.cloneMs.toFixed(0)}ms`
        + ` | roundtrip ${roundtripMs.toFixed(0)}ms | raw ${MB(msg.uncompressedSize)}MB`,
      ).catch(() => {});
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

let modeLogged = false;

export function serializeSupportsChunk(supports: DragonfruitImportFormat): Promise<CachedChunkPayload> {
  const w = ensureWorker();
  if (!w) {
    // DIAGNOSTIC: the worker failed to construct (bundling/env) — the "off-thread"
    // work is actually running INLINE on the main thread, so the freeze is
    // unchanged. This log makes that unmistakable in dragonfruit.log.
    if (!modeLogged) {
      modeLogged = true;
      void logInfo('[SceneAutosave] SUPP serialize mode = INLINE (no worker — runs on main thread!)').catch(() => {});
    }
    const t0 = nowMs();
    return serializeInline(supports).then((payload) => {
      void logInfo(
        `[SceneAutosave] SUPP inline(main-thread) ${(nowMs() - t0).toFixed(0)}ms | raw ${MB(payload.uncompressedSize)}MB`,
      ).catch(() => {});
      return payload;
    });
  }

  if (!modeLogged) {
    modeLogged = true;
    void logInfo('[SceneAutosave] SUPP serialize mode = WORKER (off main thread)').catch(() => {});
  }

  const requestId = requestSeq++;
  const request: SupportsSerializeRequest = { requestId, supports };
  return new Promise<CachedChunkPayload>((resolve, reject) => {
    const postedAt = nowMs();
    pending.set(requestId, { resolve, reject, cloneMs: 0, postedAt });
    try {
      // The structured clone of `supports` happens synchronously HERE, on the main
      // thread — this is the span that can still freeze the UI even with a worker.
      w.postMessage(request);
      const entry = pending.get(requestId);
      if (entry) entry.cloneMs = nowMs() - postedAt;
    } catch {
      // Structured-clone failure (shouldn't happen for plain JSON) → inline.
      pending.delete(requestId);
      serializeInline(supports).then(resolve, reject);
    }
  });
}
