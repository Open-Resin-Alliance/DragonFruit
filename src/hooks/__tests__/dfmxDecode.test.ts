import test from 'node:test';
import assert from 'node:assert/strict';

import { decodeDfmx } from '../useStlGeometry';

/**
 * Build a DFMX payload exactly as `encode_mesh_bodies` writes it: a 32-byte
 * header, an 8-byte entry per body, then one positions+normals soup (72 bytes
 * per triangle) per body. The offsets here are the contract with the Rust
 * encoder; a drift on either side fails this test rather than a load.
 */
function buildDfmx(bodies: number[][]): ArrayBuffer {
  const bodyCount = bodies.length;
  const totalTriangles = bodies.reduce((sum, body) => sum + body.length / 9, 0);
  const bytes = new ArrayBuffer(
    32 + bodyCount * 8 + totalTriangles * 72,
  );
  const view = new DataView(bytes);
  'DFMX'.split('').forEach((character, index) => view.setUint8(index, character.charCodeAt(0)));
  view.setUint32(4, 1, true); // version
  view.setUint32(12, bodyCount, true);

  let offset = 32 + bodyCount * 8;
  bodies.forEach((positions, index) => {
    const triangles = positions.length / 9;
    view.setUint32(32 + index * 8, triangles, true);
    positions.forEach((value, positionIndex) => {
      view.setFloat32(offset + positionIndex * Float32Array.BYTES_PER_ELEMENT, value, true);
    });
    // Normals block: one unit +Z per corner, offset by the positions block.
    for (let corner = 0; corner < triangles * 3; corner += 1) {
      const at = offset + triangles * 36 + corner * 12;
      view.setFloat32(at + 8, 1, true);
    }
    offset += triangles * 72;
  });
  return bytes;
}

test('a two-body payload decodes both bodies at the right offsets', () => {
  const bytes = buildDfmx([
    [0, 0, 0, 1, 0, 0, 0, 1, 0],
    [10, 0, 0, 11, 0, 0, 10, 1, 0, 20, 0, 0, 21, 0, 0, 20, 1, 0],
  ]);

  const decoded = decodeDfmx(bytes);
  const bodies = decoded.bodies;

  assert.equal(bodies.length, 2);
  assert.equal(bodies[0].getAttribute('position').count, 3);
  assert.equal(bodies[1].getAttribute('position').count, 6);
  // Body 1's first vertex is its own, not body 0's tail.
  assert.equal(bodies[1].getAttribute('position').getX(0), 10);
  // Normals are read from each body's own block.
  assert.equal(bodies[1].getAttribute('normal').getZ(0), 1);
});

test('a truncated body is rejected rather than read past the buffer', () => {
  const bytes = buildDfmx([[0, 0, 0, 1, 0, 0, 0, 1, 0]]);
  assert.throws(() => decodeDfmx(bytes.slice(0, bytes.byteLength - 4)), /truncated/);
});

test('a foreign payload is rejected on its magic', () => {
  const bytes = new ArrayBuffer(32);
  new DataView(bytes).setUint32(0, 0x54534644, true); // "DFST" as LE bytes
  assert.throws(() => decodeDfmx(bytes), /unsupported payload/);
});

test('the header facts an STL preview reports come back with the bodies', () => {
  const bytes = buildDfmx([[0, 0, 0, 1, 0, 0, 0, 1, 0]]);
  const view = new DataView(bytes);
  view.setUint32(8, 1, true); // preview flag
  view.setUint32(16, 4_000_000, true); // original count
  view.setUint32(20, 1234, true); // model count

  const decoded = decodeDfmx(bytes);

  assert.equal(decoded.isPreview, true);
  assert.equal(decoded.originalTriangleCount, 4_000_000);
  assert.equal(decoded.previewTriangleCount, 1);
  assert.equal(decoded.modelTriangleCount, 1234);
});

test('a metadata tail comes back as the classification report', () => {
  const json = JSON.stringify({ version: 1, model_triangle_count: 7 });
  const base = buildDfmx([[0, 0, 0, 1, 0, 0, 0, 1, 0]]);
  const bytes = new Uint8Array(base.byteLength + json.length);
  bytes.set(new Uint8Array(base), 0);
  bytes.set(new TextEncoder().encode(json), base.byteLength);
  // The header points at the tail; the bodies are unaffected by it.
  new DataView(bytes.buffer).setUint32(24, json.length, true);

  const decoded = decodeDfmx(bytes.buffer);

  assert.equal(decoded.bodies.length, 1);
  assert.equal(decoded.report?.model_triangle_count, 7);
});
