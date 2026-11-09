import test from 'node:test';
import assert from 'node:assert/strict';

import { zlibSync } from 'fflate';
import { decodeDfmx } from '../useStlGeometry';

/**
 * Build a version-2 DFMX payload exactly as `encode_mesh_bodies` writes it: a
 * 32-byte header, an 8-byte entry per body (triangle count, then the length of that
 * body's zlib stream), then the packed bodies. The offsets here are the contract
 * with the Rust encoder; a drift on either side fails this test rather than a load.
 */
function buildDfmx(bodies: number[][]): ArrayBuffer {
  const bodyCount = bodies.length;
  const packed = bodies.map((positions) => {
    const triangles = positions.length / 9;
    const soup = new Float32Array(triangles * 18);
    soup.set(positions, 0);
    // Normals block: one unit +Z per corner, offset by the positions block.
    for (let corner = 0; corner < triangles * 3; corner += 1) {
      soup[triangles * 9 + corner * 3 + 2] = 1;
    }
    return zlibSync(new Uint8Array(soup.buffer), { level: 1 });
  });
  const packedTotal = packed.reduce((sum, bytes) => sum + bytes.byteLength, 0);
  const bytes = new ArrayBuffer(32 + bodyCount * 8 + packedTotal);
  const view = new DataView(bytes);
  'DFMX'.split('').forEach((character, index) => view.setUint8(index, character.charCodeAt(0)));
  view.setUint32(4, 2, true); // version
  view.setUint32(12, bodyCount, true);

  let offset = 32 + bodyCount * 8;
  bodies.forEach((positions, index) => {
    view.setUint32(32 + index * 8, positions.length / 9, true);
    view.setUint32(36 + index * 8, packed[index].byteLength, true);
    new Uint8Array(bytes, offset, packed[index].byteLength).set(packed[index]);
    offset += packed[index].byteLength;
  });
  return bytes;
}

test('a two-body payload decodes both bodies at the right offsets', async () => {
  const bytes = buildDfmx([
    [0, 0, 0, 1, 0, 0, 0, 1, 0],
    [10, 0, 0, 11, 0, 0, 10, 1, 0, 20, 0, 0, 21, 0, 0, 20, 1, 0],
  ]);

  const decoded = await decodeDfmx(bytes);
  const bodies = decoded.bodies;

  assert.equal(bodies.length, 2);
  assert.equal(bodies[0].getAttribute('position').count, 3);
  assert.equal(bodies[1].getAttribute('position').count, 6);
  // Body 1's first vertex is its own, not body 0's tail.
  assert.equal(bodies[1].getAttribute('position').getX(0), 10);
  // Normals are read from each body's own block.
  assert.equal(bodies[1].getAttribute('normal').getZ(0), 1);
});

test('a truncated body is rejected rather than read past the buffer', async () => {
  const bytes = buildDfmx([[0, 0, 0, 1, 0, 0, 0, 1, 0]]);
  await assert.rejects(decodeDfmx(bytes.slice(0, bytes.byteLength - 4)), /truncated/);
});

test('a foreign payload is rejected on its magic', async () => {
  const bytes = new ArrayBuffer(32);
  new DataView(bytes).setUint32(0, 0x54534644, true); // "DFST" as LE bytes
  await assert.rejects(decodeDfmx(bytes), /unsupported payload/);
});

test('the header facts an STL preview reports come back with the bodies', async () => {
  const bytes = buildDfmx([[0, 0, 0, 1, 0, 0, 0, 1, 0]]);
  const view = new DataView(bytes);
  view.setUint32(8, 1, true); // preview flag
  view.setUint32(16, 4_000_000, true); // original count
  view.setUint32(20, 1234, true); // model count

  const decoded = await decodeDfmx(bytes);

  assert.equal(decoded.isPreview, true);
  assert.equal(decoded.originalTriangleCount, 4_000_000);
  assert.equal(decoded.previewTriangleCount, 1);
  assert.equal(decoded.modelTriangleCount, 1234);
});

test('a metadata tail comes back as the classification report', async () => {
  const json = JSON.stringify({ version: 1, model_triangle_count: 7 });
  const base = buildDfmx([[0, 0, 0, 1, 0, 0, 0, 1, 0]]);
  const bytes = new Uint8Array(base.byteLength + json.length);
  bytes.set(new Uint8Array(base), 0);
  bytes.set(new TextEncoder().encode(json), base.byteLength);
  // The header points at the tail; the bodies are unaffected by it.
  new DataView(bytes.buffer).setUint32(24, json.length, true);

  const decoded = await decodeDfmx(bytes.buffer);

  assert.equal(decoded.bodies.length, 1);
  assert.equal(decoded.report?.model_triangle_count, 7);
});

test('a payload that is a view into a larger buffer decodes from its own offset', async () => {
  // How the IPC hands it over today is offset 0, but the reader must not assume
  // it: the views are taken from `byteOffset + body offset`, and a reader that
  // ignored the view's own offset would decode the wrong bytes — or throw on an
  // unaligned `Float32Array`.
  const payload = buildDfmx([[0, 0, 0, 1, 0, 0, 0, 1, 0]]);
  const padded = new Uint8Array(payload.byteLength + 8);
  padded.set(new Uint8Array(payload), 8);

  const decoded = await decodeDfmx(padded.subarray(8));

  assert.equal(decoded.bodies.length, 1);
  assert.equal(decoded.bodies[0].getAttribute('position').getX(1), 1);
  assert.equal(decoded.bodies[0].getAttribute('normal').getZ(0), 1);
});
