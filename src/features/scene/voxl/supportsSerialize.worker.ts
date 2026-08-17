import { zlibSync } from 'fflate';

import type {
  SupportsSerializeRequest,
  SupportsSerializeResponse,
} from './supportsSerialize.worker.shared';
import {
  SUPP_COMPRESSION_NONE,
  SUPP_COMPRESSION_ZLIB,
  SUPP_MIN_COMPRESS_BYTES,
} from './supportsSerialize.worker.shared';

const encoder = new TextEncoder();

async function sha256Hex(bytes: Uint8Array): Promise<string> {
  // Copy into a standalone buffer so `digest` never sees a pooled/oversized view.
  const buf = new ArrayBuffer(bytes.byteLength);
  new Uint8Array(buf).set(bytes);
  const digest = await crypto.subtle.digest('SHA-256', buf);
  const view = new Uint8Array(digest);
  let hex = '';
  for (let i = 0; i < view.length; i += 1) hex += view[i].toString(16).padStart(2, '0');
  return hex;
}

/** A transferable ArrayBuffer that is EXACTLY the chunk bytes (no pooled slack). */
function toExactBuffer(bytes: Uint8Array): ArrayBuffer {
  if (bytes.byteOffset === 0 && bytes.byteLength === bytes.buffer.byteLength) {
    return bytes.buffer as ArrayBuffer;
  }
  return bytes.slice().buffer as ArrayBuffer;
}

self.onmessage = async (event: MessageEvent<SupportsSerializeRequest>) => {
  const { requestId, supports } = event.data;
  try {
    const raw = encoder.encode(JSON.stringify(supports));
    // Digest is over the RAW bytes — matches the codec's fingerprint contract.
    const digest = await sha256Hex(raw);

    let compression = SUPP_COMPRESSION_NONE;
    let out: Uint8Array = raw;
    if (raw.length > SUPP_MIN_COMPRESS_BYTES) {
      const compressed = zlibSync(raw, { level: 6 });
      // Only keep the compressed form when it actually shrinks — identical rule
      // to the inline codec path, so bytes stay reproducible.
      if (compressed.length < raw.length) {
        compression = SUPP_COMPRESSION_ZLIB;
        out = compressed;
      }
    }

    const buffer = toExactBuffer(out);
    const response: SupportsSerializeResponse = {
      type: 'ok',
      requestId,
      compression,
      data: buffer,
      uncompressedSize: raw.length,
      digest,
    };
    (self as unknown as Worker).postMessage(response, [buffer]);
  } catch (err) {
    const response: SupportsSerializeResponse = {
      type: 'error',
      requestId,
      error: err instanceof Error ? err.message : String(err),
    };
    (self as unknown as Worker).postMessage(response);
  }
};
