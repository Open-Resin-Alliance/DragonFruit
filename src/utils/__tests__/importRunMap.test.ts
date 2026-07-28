/**
 * Ph1 wiring (c) — the run map's cap, its encoding, and the recompute fallback.
 *
 * The property that matters and is easy to get wrong: an over-cap map and an
 * absent map both LOOK like an empty run array. Only the summary's
 * `totalRunCount` distinguishes them, and confusing the two means reading a
 * heavily-interleaved pre-supported plate as having no support section — i.e.
 * slicing supports as model, with full confidence.
 */
import assert from 'node:assert/strict';
import test from 'node:test';

import {
  decodeImportRunMapChunk,
  encodeImportRunMapChunk,
  importRunMapFromResponse,
  resolveImportRunMap,
  summarizeImportRunMap,
  IMPORT_RUN_MAP_MAX_BYTES,
  IMPORT_RUN_MAP_MAX_ENTRIES,
  type ImportRunMap,
} from '../importRunMap';
import { asFileFrameCount } from '../triangleCountFrames';
import {
  makeFileFrameRunMap,
  type FileFrameRunMapFixture,
} from './triangleCountFrameFixtures';

// The defaults stay HERE, unchanged — `makeFileFrameRunMap` supplies none of
// its own (see that module's design rule). All it adds is the statement that
// `modelTriangleCount` is a FRAME (A) source-file count.
function mapWith(
  runs: number[],
  overrides: Partial<FileFrameRunMapFixture> = {},
): ImportRunMap {
  return makeFileFrameRunMap({
    runs: new Uint32Array(runs),
    sourceTriangleCount: 3168,
    modelTriangleCount: 768,
    droppedNonFiniteTriangles: 0,
    totalRunCount: runs.length / 2,
    ...overrides,
  });
}

test('the chunk encoding round-trips exactly', () => {
  const map = mapWith([0, 384, 2784, 384]);
  const encoded = encodeImportRunMapChunk(map);
  assert.ok(encoded);
  assert.equal(encoded.length, 4 * 4, 'two (start,len) pairs = 16 bytes');
  assert.deepEqual(Array.from(decodeImportRunMapChunk(encoded) ?? []), [0, 384, 2784, 384]);
});

test('the cap is 64 KB per model, and an over-cap map is not written', () => {
  assert.equal(IMPORT_RUN_MAP_MAX_BYTES, 64 * 1024);
  assert.equal(IMPORT_RUN_MAP_MAX_ENTRIES, 8192);

  const atCap = new Array(IMPORT_RUN_MAP_MAX_ENTRIES * 2).fill(1);
  assert.equal(encodeImportRunMapChunk(mapWith(atCap))?.length, IMPORT_RUN_MAP_MAX_BYTES);

  const overCap = new Array((IMPORT_RUN_MAP_MAX_ENTRIES + 1) * 2).fill(1);
  assert.equal(encodeImportRunMapChunk(mapWith(overCap)), null);
});

test('a damaged chunk decodes to nothing rather than to a short map', () => {
  assert.equal(decodeImportRunMapChunk(new Uint8Array(0)), null);
  assert.equal(decodeImportRunMapChunk(new Uint8Array(12)), null, 'not a whole number of entries');
});

test('a persisted map plus its chunk resolves as available', () => {
  const map = mapWith([0, 384, 2784, 384]);
  const summary = summarizeImportRunMap(map);
  const chunk = decodeImportRunMapChunk(encodeImportRunMapChunk(map)!)!;

  const resolution = resolveImportRunMap({ summary, persistedRuns: chunk });
  assert.equal(resolution.kind, 'available');
  assert.equal(resolution.kind === 'available' && resolution.map.modelTriangleCount, 768);
  assert.equal(resolution.kind === 'available' && resolution.map.sourceTriangleCount, 3168);
});

test('an over-cap map resolves as RECOMPUTE, never as "no split"', () => {
  const overCap = mapWith(new Array((IMPORT_RUN_MAP_MAX_ENTRIES + 1) * 2).fill(1));
  // The writer drops the array; the summary keeps the count it found.
  const summary = { ...summarizeImportRunMap(overCap), entryCount: 0 };

  const resolution = resolveImportRunMap({ summary, persistedRuns: null });
  assert.equal(resolution.kind, 'recompute');
  assert.equal(resolution.kind === 'recompute' && resolution.reason, 'over-cap');
});

test('a missing chunk beside a summary that expected one resolves as RECOMPUTE', () => {
  const summary = summarizeImportRunMap(mapWith([0, 384]));
  assert.deepEqual(resolveImportRunMap({ summary, persistedRuns: null }), {
    kind: 'recompute',
    reason: 'chunk-missing',
  });
});

test('a chunk whose length contradicts the summary resolves as RECOMPUTE', () => {
  const summary = summarizeImportRunMap(mapWith([0, 384, 2784, 384]));
  assert.deepEqual(
    resolveImportRunMap({ summary, persistedRuns: new Uint32Array([0, 384]) }),
    { kind: 'recompute', reason: 'chunk-damaged' },
  );
});

test('a file written before the run map existed resolves as RECOMPUTE, not "no split"', () => {
  assert.deepEqual(resolveImportRunMap({}), { kind: 'recompute', reason: 'not-persisted' });
});

test('genuinely no split resolves as NONE — there is nothing to recompute', () => {
  const summary = { ...summarizeImportRunMap(mapWith([])), totalRunCount: 0 };
  assert.deepEqual(resolveImportRunMap({ summary, persistedRuns: null }), { kind: 'none' });

  const runtime = mapWith([], { totalRunCount: 0 });
  assert.deepEqual(resolveImportRunMap({ runtime }), { kind: 'none' });
});

test('the in-session map takes precedence over anything persisted', () => {
  const runtime = mapWith([5, 10]);
  const resolution = resolveImportRunMap({
    runtime,
    summary: summarizeImportRunMap(mapWith([0, 384])),
    persistedRuns: new Uint32Array([0, 384]),
  });
  assert.equal(resolution.kind, 'available');
  assert.deepEqual(
    Array.from(resolution.kind === 'available' ? resolution.map.runs : []),
    [5, 10],
  );
});

test('an import with no model/support split records no run map at all', () => {
  assert.equal(
    importRunMapFromResponse({
      runs: null,
      modelTriangleCount: null,
      sourceTriangleCount: 3168,
      droppedNonFiniteTriangles: 0,
      totalRunCount: 0,
    }),
    null,
    'absence of a split is not a split covering everything',
  );
});

test('an import whose map exceeded the transport cap still records the count', () => {
  const map = importRunMapFromResponse({
    runs: null,
    // What boundary 1 (`parseImportClassification`) hands this function: a
    // FRAME (A) count read off the DFST header, describing the source file.
    modelTriangleCount: asFileFrameCount(768),
    sourceTriangleCount: 3168,
    droppedNonFiniteTriangles: 2,
    totalRunCount: 99_999,
  });
  assert.ok(map);
  assert.equal(map.runs.length, 0);
  assert.equal(map.totalRunCount, 99_999);
  assert.deepEqual(resolveImportRunMap({ runtime: map }), {
    kind: 'recompute',
    reason: 'over-cap',
  });
});
