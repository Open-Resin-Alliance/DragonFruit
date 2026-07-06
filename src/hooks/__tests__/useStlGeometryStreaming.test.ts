import assert from 'node:assert/strict';
import test from 'node:test';

import { loadStlBinaryStreaming } from '../useStlGeometry';

function writeTriangle(target: Uint8Array, offset: number, values: number[]) {
  const view = new DataView(target.buffer, target.byteOffset + offset, 50);
  for (let i = 0; i < 9; i++) {
    view.setFloat32(12 + i * 4, values[i], true);
  }
}

test('streaming STL parser preserves a partial first triangle across chunks', async () => {
  const bytes = new Uint8Array(84 + 2 * 50);
  new DataView(bytes.buffer).setUint32(80, 2, true);
  const expected = [
    0, 0, 0, 1, 0, 0, 0, 1, 0,
    0, 0, 1, 1, 0, 1, 0, 1, 1,
  ];
  writeTriangle(bytes, 84, expected.slice(0, 9));
  writeTriangle(bytes, 134, expected.slice(9));

  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => new Response(new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(bytes.slice(0, 84 + 49));
      controller.enqueue(bytes.slice(84 + 49));
      controller.close();
    },
  }));

  try {
    const geometry = await loadStlBinaryStreaming('blob:test');
    assert.ok(geometry);
    const positions = geometry.getAttribute('position').array;
    assert.deepEqual(Array.from(positions), expected);
    assert.ok(Array.from(positions).every(Number.isFinite));
    geometry.dispose();
  } finally {
    globalThis.fetch = originalFetch;
  }
});
