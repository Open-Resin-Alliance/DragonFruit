import assert from 'node:assert/strict';
import test from 'node:test';

type Baked = { positions: Float32Array; normals: Float32Array | null };

/**
 * The worker reverses a non-indexed soup's winding by swapping two corners. It
 * swapped the positions and left the normals where they were, so each corner kept
 * the normal of the one it traded places with.
 */
test('a non-indexed mirror moves each normal with its corner', async () => {
  const posted: Baked[] = [];
  const stub = { postMessage: (message: Baked) => posted.push(message) } as {
    postMessage: (message: Baked) => void;
    onmessage?: (event: { data: unknown }) => void;
  };
  (globalThis as { self?: unknown }).self = stub;
  await import('../workers/bakeMirrorWorker');

  // One triangle, each corner's normal pointing at its own corner.
  const corners = [[1, 0, 0], [0, 1, 0], [0, 0, 1]];
  stub.onmessage?.({
    data: {
      positions: new Float32Array(corners.flat()),
      normals: new Float32Array(corners.flat()),
      indices: null,
      posItemSize: 3,
      normItemSize: 3,
      axes: [0],
    },
  });

  const { positions, normals } = posted[0];
  assert.ok(normals);
  for (let corner = 0; corner < 3; corner++) {
    const p: number[] = Array.from(positions.slice(corner * 3, corner * 3 + 3));
    const n: number[] = Array.from(normals.slice(corner * 3, corner * 3 + 3));
    assert.deepEqual(n, p, `corner ${corner}: its normal still points at its own position`);
  }
});
