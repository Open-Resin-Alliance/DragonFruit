import assert from 'node:assert/strict';
import test from 'node:test';
import { zlibSync } from 'fflate';
import { inflateZlib } from '@/utils/inflateZlib';

const original = new Uint8Array(64 * 1024).map((_, i) => (i * 31) % 251);
const packed = zlibSync(original, { level: 1 });

test('inflateZlib inflates through DecompressionStream when it exists', async () => {
  assert.equal(typeof DecompressionStream, 'function');
  assert.deepEqual(await inflateZlib(packed), original);
});

test('inflateZlib falls back to fflate where DecompressionStream is missing', async (t) => {
  const saved = globalThis.DecompressionStream;
  // WebKit before 16.4 (the macOS 12 webview) has no DecompressionStream.
  delete (globalThis as { DecompressionStream?: unknown }).DecompressionStream;
  t.after(() => { globalThis.DecompressionStream = saved; });
  assert.deepEqual(await inflateZlib(packed), original);
});
