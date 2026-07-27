/**
 * Ph1 wiring — the DFST wire format.
 *
 * The header, the two Ph1 length fields and the exact-length assertion are one
 * unit with `STL_RESPONSE_HEADER_BYTES` in `mesh_repair.rs`. The assertion is an
 * EQUALITY, so a writer and reader that disagree do not degrade — every native
 * import fails. These tests pin both halves of that: an extended response is
 * accepted with its classification and run map intact, and anything whose
 * length does not match its own header is rejected rather than misread.
 */
import assert from 'node:assert/strict';
import test from 'node:test';

import { decodeNativeStlResponse } from '../useStlGeometry';

const HEADER_BYTES = 32;

type ResponseParts = {
  flags?: number;
  originalTriangleCount?: number;
  triangles?: number[][];
  runs?: Array<[number, number]>;
  classification?: Record<string, unknown> | null;
  /** Corrupt the emitted buffer by appending / truncating this many bytes. */
  lengthDelta?: number;
};

/** Builds a DFST response exactly as `encode_stl_response` does. */
function buildResponse(parts: ResponseParts): ArrayBuffer {
  const triangles = parts.triangles ?? [[0, 0, 0, 1, 0, 0, 0, 1, 0]];
  const runs = parts.runs ?? [];
  const json = parts.classification === null || parts.classification === undefined
    ? new Uint8Array(0)
    : new TextEncoder().encode(JSON.stringify(parts.classification));

  const geometryBytes = triangles.length * 18 * 4;
  const total = HEADER_BYTES + geometryBytes + runs.length * 8 + json.length;
  const buffer = new ArrayBuffer(total);
  const view = new DataView(buffer);
  const bytes = new Uint8Array(buffer);

  bytes.set([0x44, 0x46, 0x53, 0x54], 0); // "DFST"
  view.setUint32(4, parts.flags ?? 0, true);
  view.setUint32(8, parts.originalTriangleCount ?? triangles.length, true);
  view.setUint32(12, triangles.length, true);
  view.setFloat32(16, 0, true);
  view.setUint32(20, 0, true);
  view.setUint32(24, runs.length, true);
  view.setUint32(28, json.length, true);

  let at = HEADER_BYTES;
  for (const tri of triangles) {
    for (const value of tri) {
      view.setFloat32(at, value, true);
      at += 4;
    }
  }
  // Normals — same footprint as positions; content is irrelevant here.
  at = HEADER_BYTES + triangles.length * 9 * 4;
  for (let i = 0; i < triangles.length * 9; i += 1) {
    view.setFloat32(at + i * 4, 0, true);
  }

  at = HEADER_BYTES + geometryBytes;
  for (const [start, len] of runs) {
    view.setUint32(at, start, true);
    view.setUint32(at + 4, len, true);
    at += 8;
  }
  bytes.set(json, at);

  const delta = parts.lengthDelta ?? 0;
  if (delta === 0) return buffer;
  // Corrupt the LENGTH only — the header still describes the original payload,
  // which is exactly what a writer/reader version skew looks like on the wire.
  const skewed = new Uint8Array(total + delta);
  skewed.set(bytes.subarray(0, Math.min(total, skewed.length)));
  return skewed.buffer;
}

test('the extended DFST header carries the classification and the run map', () => {
  const buffer = buildResponse({
    flags: 1,
    originalTriangleCount: 11_228_556,
    runs: [
      [0, 384],
      [2784, 384],
    ],
    classification: {
      model_triangle_count: 768,
      likely_support_geometry: true,
      connected_components: 201,
      source_triangle_count: 3168,
      dropped_nonfinite_triangles: 0,
      manifold_check_size_guarded: true,
      classify_ms: 3774,
      section_stats_ms: 120,
      run_count: 2,
    },
  });

  const decoded = decodeNativeStlResponse(buffer);
  assert.ok(decoded);
  assert.equal(decoded.isPreview, true);
  assert.equal(decoded.originalTriangleCount, 11_228_556);
  assert.equal(decoded.previewTriangleCount, 1);

  assert.ok(decoded.classification);
  assert.equal(decoded.classification.model_triangle_count, 768);
  assert.equal(decoded.classification.likely_support_geometry, true);
  assert.equal(decoded.classification.connected_components, 201);
  assert.equal(decoded.classification.run_count, 2);
  // The check ran but declined by size — that is UNKNOWN, not "not manifold".
  assert.equal(decoded.classification.model_is_manifold, null);
  assert.equal(decoded.classification.manifold_check_size_guarded, true);

  assert.deepEqual(Array.from(decoded.runMap ?? []), [0, 384, 2784, 384]);
});

test('a response with no classification block still decodes as geometry', () => {
  const decoded = decodeNativeStlResponse(buildResponse({}));
  assert.ok(decoded);
  assert.equal(decoded.classification, null);
  assert.equal(decoded.runMap, null);
  assert.equal(decoded.previewTriangleCount, 1);
});

test('a payload that does not match its own header is rejected, not misread', () => {
  // Truncated: the header promises a run map and JSON that are not there.
  assert.throws(
    () => decodeNativeStlResponse(buildResponse({
      runs: [[0, 4]],
      classification: { run_count: 1 },
      lengthDelta: -8,
    })),
    /truncated/i,
  );

  // Over-long: trailing bytes the header does not account for are just as much
  // a version skew as missing ones.
  assert.throws(
    () => decodeNativeStlResponse(buildResponse({ lengthDelta: 16 })),
    /truncated/i,
  );
});

test('a buffer shorter than the header is nothing to decode, not a corrupt read', () => {
  assert.equal(decodeNativeStlResponse(new ArrayBuffer(0)), null);
  assert.equal(decodeNativeStlResponse(new ArrayBuffer(HEADER_BYTES - 1)), null);
});

test('a response without the DFST magic is refused outright', () => {
  const buffer = buildResponse({});
  new Uint8Array(buffer)[0] = 0x00;
  assert.throws(() => decodeNativeStlResponse(buffer), /unsupported response/i);
});
