import assert from 'node:assert/strict';
import test from 'node:test';
import { parseRefinedMesh } from '@/utils/tauriMeshBridge';

/** One triangle: three positions then three normals, all 9 floats per triangle. */
function response(triangles: number[][], normals: number[][]): Uint8Array {
  const bytes = new Uint8Array(4 + triangles.length * 72);
  new DataView(bytes.buffer).setUint32(0, triangles.length, true);
  const floats = new Float32Array(bytes.buffer, 4);
  triangles.flat().forEach((value, index) => { floats[index] = value; });
  const offset = triangles.length * 9;
  normals.flat().forEach((value, index) => { floats[offset + index] = value; });
  return bytes;
}

test('a refined mesh decodes into positions and normals in triangle order', () => {
  const bytes = response(
    [[0, 0, 0, 1, 0, 0, 0, 1, 0]],
    [[0, 0, 1, 0, 0, 1, 0, 0, 1]],
  );
  const geometry = parseRefinedMesh(bytes);

  assert.ok(geometry, 'the payload should decode');
  const position = geometry.getAttribute('position');
  const normal = geometry.getAttribute('normal');
  assert.equal(position.count, 3);
  assert.equal(normal.count, 3);
  assert.deepEqual(
    Array.from({ length: 9 }, (_, i) => position.array[i]),
    [0, 0, 0, 1, 0, 0, 0, 1, 0],
  );
  assert.equal(normal.getZ(0), 1, 'normals start after the positions');
  assert.equal(normal.count, position.count);
});

test('a header that does not match the payload is refused', () => {
  const bytes = response([[0, 0, 0, 1, 0, 0, 0, 1, 0]], [[0, 0, 1, 0, 0, 1, 0, 0, 1]]);
  // Two triangles claimed, one present: attaching these would put another mesh's
  // normals on this one.
  new DataView(bytes.buffer).setUint32(0, 2, true);
  assert.equal(parseRefinedMesh(bytes), null);
  assert.equal(parseRefinedMesh(new Uint8Array(2)), null);
  assert.equal(parseRefinedMesh(new Uint8Array(4)), null);
});
