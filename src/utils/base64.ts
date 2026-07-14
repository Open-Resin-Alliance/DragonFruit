/** Cross-runtime (browser + Node) base64 encode/decode for binary buffers. */

export function bytesToBase64(bytes: Uint8Array): string {
  if (typeof btoa === 'function') {
    const CHUNK_SIZE = 0x8000;
    let binary = '';
    for (let i = 0; i < bytes.length; i += CHUNK_SIZE) {
      const chunk = bytes.subarray(i, i + CHUNK_SIZE);
      binary += String.fromCharCode(...chunk);
    }
    return btoa(binary);
  }

  if (typeof Buffer !== 'undefined') {
    return Buffer.from(bytes).toString('base64');
  }

  throw new Error('Base64 encoding is unavailable in this environment.');
}

export function base64ToBytes(base64: string): Uint8Array {
  const normalized = base64.replace(/\s+/g, '');

  if (typeof atob === 'function') {
    const binary = atob(normalized);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i += 1) {
      bytes[i] = binary.charCodeAt(i);
    }
    return bytes;
  }

  if (typeof Buffer !== 'undefined') {
    return new Uint8Array(Buffer.from(normalized, 'base64'));
  }

  throw new Error('Base64 decoding is unavailable in this environment.');
}
