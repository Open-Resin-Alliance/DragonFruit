import assert from 'node:assert/strict';
import test, { describe } from 'node:test';

import { serializeVoxlDocumentV2, parseVoxlBinaryV2, VOXL_V2 } from '../codec-v2';
import { countVoxlChunks, meshLike, readVoxlVersion, testInput, testModel } from './voxlTestSupport';
import {
  resolveImportRunMap,
  IMPORT_RUN_MAP_MAX_ENTRIES,
  type ImportRunMap,
} from '@/utils/importRunMap';
import {
  makeFileFrameRunMap,
  makeFileFrameRunMapSummary,
  type FileFrameRunMapFixture,
} from '@/utils/__tests__/triangleCountFrameFixtures';

/**
 * Ph1 wiring (c) — run-map persistence in the container.
 *
 * Three properties, in order of how much damage getting them wrong does:
 *
 * 1. A persisted map comes back addressing the SAME source-file triangles.
 * 2. A map too large for the 64 KB cap is NOT written, and what comes back says
 *    "recompute" — not "no split", which would slice supports as model.
 * 3. The chunk is additive: no version bump, and a scene without run maps
 *    serializes byte-identically to one written before the chunk existed.
 */

const MESH = meshLike(11);

const NATIVE_PREVIEW = {
  originalTriangleCount: 11_228_556,
  previewTriangleCount: 3_900_000,
  cPre: [40, 25, 0] as [number, number, number],
};

// Defaults unchanged (including the count derived from the run lengths); the
// factory adds only the FRAME (A) statement — these are SOURCE-FILE indices,
// which is the whole reason the map is persisted separately from the mesh.
function runMap(runs: number[], overrides: Partial<FileFrameRunMapFixture> = {}): ImportRunMap {
  return makeFileFrameRunMap({
    runs: new Uint32Array(runs),
    sourceTriangleCount: 11_228_556,
    modelTriangleCount: runs.filter((_, i) => i % 2 === 1).reduce((a, b) => a + b, 0),
    droppedNonFiniteTriangles: 3,
    totalRunCount: runs.length / 2,
    ...overrides,
  });
}

describe('import run map round trip', () => {
  test('a persisted map comes back addressing the same source-file triangles', async () => {
    const map = runMap([0, 100, 101, 283, 2784, 384]);
    const input = testInput([
      testModel('supported-plate', { nativePreview: NATIVE_PREVIEW, importRunMap: map }),
    ]);

    const bin = await serializeVoxlDocumentV2(input, new Map([[0, MESH]]), new Map([[0, 'sha-a']]));
    assert.equal(countVoxlChunks(bin, 'RUNM'), 1);

    const { document, runMaps } = parseVoxlBinaryV2(bin);
    const summary = document.models[0].nativePreview?.runMap;
    assert.ok(summary, 'the MODL summary must ride with the full-res linkage');
    assert.equal(summary.entryCount, 3);
    assert.equal(summary.totalRunCount, 3);
    assert.equal(summary.sourceTriangleCount, 11_228_556);
    assert.equal(summary.droppedNonFiniteTriangles, 3);

    const resolution = resolveImportRunMap({
      summary,
      persistedRuns: runMaps.get('supported-plate') ?? null,
    });
    assert.equal(resolution.kind, 'available');
    assert.deepEqual(
      Array.from(resolution.kind === 'available' ? resolution.map.runs : []),
      [0, 100, 101, 283, 2784, 384],
    );
    assert.equal(
      resolution.kind === 'available' && resolution.map.modelTriangleCount,
      767,
    );
  });

  test('an over-cap map is not written, and reloads as RECOMPUTE rather than "no split"', async () => {
    const overCap = runMap(
      new Array((IMPORT_RUN_MAP_MAX_ENTRIES + 1) * 2).fill(1),
      { modelTriangleCount: 8193 },
    );
    const input = testInput([
      testModel('fragmented', { nativePreview: NATIVE_PREVIEW, importRunMap: overCap }),
    ]);

    const bin = await serializeVoxlDocumentV2(input, new Map([[0, MESH]]), new Map([[0, 'sha-a']]));
    assert.equal(countVoxlChunks(bin, 'RUNM'), 0, 'over the cap, no chunk is written');

    const { document, runMaps } = parseVoxlBinaryV2(bin);
    const summary = document.models[0].nativePreview?.runMap;
    assert.ok(summary);
    assert.equal(summary.entryCount, IMPORT_RUN_MAP_MAX_ENTRIES + 1);
    assert.equal(
      summary.totalRunCount,
      IMPORT_RUN_MAP_MAX_ENTRIES + 1,
      'the count survives so the reader knows a split EXISTS',
    );

    const resolution = resolveImportRunMap({
      summary,
      persistedRuns: runMaps.get('fragmented') ?? null,
    });
    assert.equal(resolution.kind, 'recompute');
  });

  test('a model with no run map writes no chunk and no summary', async () => {
    const input = testInput([testModel('plain', { nativePreview: NATIVE_PREVIEW })]);
    const bin = await serializeVoxlDocumentV2(input, new Map([[0, MESH]]), new Map([[0, 'sha-a']]));

    assert.equal(countVoxlChunks(bin, 'RUNM'), 0);
    const { document, runMaps } = parseVoxlBinaryV2(bin);
    assert.equal(document.models[0].nativePreview?.runMap, undefined);
    assert.equal(runMaps.size, 0);

    // No summary at all is a file from before the map existed — recompute, not
    // "there are no supports here".
    assert.deepEqual(
      resolveImportRunMap({ summary: document.models[0].nativePreview?.runMap ?? null }),
      { kind: 'recompute', reason: 'not-persisted' },
    );
  });

  test('a summary left on the marker without a live map is not persisted', async () => {
    // What a mutation leaves behind if the strip in `carryPreviewMarkerForward`
    // ever regresses: a marker still claiming runs, with no `importRunMap` to
    // write. Persisting that claim would send every future reader down the
    // recompute path for a model that has nothing to recompute.
    const staleMarker = {
      ...NATIVE_PREVIEW,
      runMap: makeFileFrameRunMapSummary({
        entryCount: 2,
        sourceTriangleCount: 11_228_556,
        modelTriangleCount: 768,
        droppedNonFiniteTriangles: 0,
        totalRunCount: 2,
      }),
    };
    const input = testInput([testModel('mutated', { nativePreview: staleMarker })]);
    const bin = await serializeVoxlDocumentV2(input, new Map([[0, MESH]]), new Map([[0, 'sha-a']]));

    assert.equal(countVoxlChunks(bin, 'RUNM'), 0);
    const { document } = parseVoxlBinaryV2(bin);
    assert.equal(
      document.models[0].nativePreview?.runMap,
      undefined,
      'the summary is derived from the live map and nothing else',
    );
    // The rest of the preview marker is untouched — it describes provenance,
    // which a mutation does not invalidate.
    assert.equal(document.models[0].nativePreview?.originalTriangleCount, 11_228_556);
  });

  test('the chunk is additive — no version bump, and run-map-free scenes are unchanged', async () => {
    const withMap = testInput([
      testModel('a', { nativePreview: NATIVE_PREVIEW, importRunMap: runMap([0, 8]) }),
    ]);
    const withoutMap = testInput([testModel('a', { nativePreview: NATIVE_PREVIEW })]);
    const meshBytes = new Map([[0, MESH]]);
    const sha = new Map([[0, 'sha-a']]);

    const carrying = await serializeVoxlDocumentV2(withMap, meshBytes, sha);
    const plain = await serializeVoxlDocumentV2(withoutMap, meshBytes, sha);

    assert.equal(readVoxlVersion(carrying), VOXL_V2, 'RUNM must not bump the container version');
    assert.equal(readVoxlVersion(plain), VOXL_V2);
    assert.ok(
      carrying.length > plain.length,
      'the map has to actually cost bytes, or it is not being written',
    );
  });

  test('run maps are per model and never shared, even when the geometry is deduped', async () => {
    // Two models, identical mesh bytes and SHA (so MESH dedup fires), different
    // source files and therefore different run maps.
    const input = testInput([
      testModel('copy-a', { nativePreview: NATIVE_PREVIEW, importRunMap: runMap([0, 12]) }),
      testModel('copy-b', { nativePreview: NATIVE_PREVIEW, importRunMap: runMap([40, 8]) }),
    ]);
    const bin = await serializeVoxlDocumentV2(
      input,
      new Map([[0, MESH], [1, MESH]]),
      new Map([[0, 'same-sha'], [1, 'same-sha']]),
    );

    assert.equal(countVoxlChunks(bin, 'MESH'), 1, 'geometry dedup still applies');
    assert.equal(countVoxlChunks(bin, 'RUNM'), 2, 'run maps do not dedup with geometry');

    const { runMaps } = parseVoxlBinaryV2(bin);
    assert.deepEqual(Array.from(runMaps.get('copy-a') ?? []), [0, 12]);
    assert.deepEqual(Array.from(runMaps.get('copy-b') ?? []), [40, 8]);
  });
});
