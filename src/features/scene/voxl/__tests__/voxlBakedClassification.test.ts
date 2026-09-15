import assert from 'node:assert/strict';
import test from 'node:test';

import {
  buildVoxlDocumentV1,
  parseVoxlAuto,
  parseVoxlDocument,
  serializeVoxlDocument,
} from '../codec';
import { parseVoxlBinaryV2, serializeVoxlDocumentV2 } from '../codec-v2';
import { loadMeshGeometry } from '@/hooks/useStlGeometry';
import type { MeshAnalysisJson, MeshHealthReport } from '@/utils/meshRepair';
import { meshLike, testInput, testModel } from './voxlTestSupport';

/**
 * VOXL V2.4 — baked mesh classification.
 *
 * The model/support split used to be recomputed on every load: the classifier
 * ran again over triangles it had already classified when the file was saved.
 * V2.4 persists the classify-only report in the `MODL` entry so a reader that
 * honours it can restore the split without the native round trip. These tests
 * pin the container contract: the writer emits it, the reader returns it whole,
 * and a model that has none stays byte-wise as it was.
 */

const analysis = (triangleCount: number, componentCount: number): MeshAnalysisJson => ({
  triangle_count: triangleCount,
  vertex_count: triangleCount * 3,
  non_manifold_edges: 0,
  non_manifold_vertices: 0,
  boundary_edges: 0,
  boundary_loops: 0,
  inconsistent_edges: 0,
  degenerate_triangles: 0,
  duplicate_triangles: 0,
  component_count: componentCount,
  self_intersections: 0,
  signed_volume: 1,
  is_watertight: true,
  timings_ms: { topology_ms: 1, self_intersections_ms: 0, components_ms: 0, total_ms: 1 },
});

/** A classify-only report: the shape `mesh_classify_staged` returns. */
function classification(modelTriangleCount: number | null): MeshHealthReport {
  return {
    version: 1,
    source_path: null,
    pre: analysis(4, 2),
    post: analysis(4, 2),
    steps: [{ name: 'classify_support_geometry_split', duration_ms: 0.4, changed: 0 }],
    likely_support_geometry: false,
    model_triangle_count: modelTriangleCount,
    model_is_manifold: true,
    model_manifold_status: null,
    residual_issues: [],
    fully_repaired: true,
    total_ms: 3.5,
  };
}

test('VOXL V1 round-trip preserves the baked classification', () => {
  const baked = classification(3);
  const input = testInput([
    testModel('m1', { classification: baked, mesh: { mode: 'external-file', fileName: 'm1.stl' } }),
  ]);

  const parsed = parseVoxlDocument(serializeVoxlDocument(buildVoxlDocumentV1(input), false, { compression: 'none' }));

  // Whole-report fidelity: the shell count, manifold verdict and split boundary
  // all come from the report, so a partial round-trip would restore a partial UI.
  assert.deepEqual(parsed.models[0].classification, baked);
});

test('VOXL V2 binary round-trip preserves the baked classification', async () => {
  const baked = classification(3);
  const input = testInput([testModel('m1', { classification: baked })]);
  const meshBytes = new Map<number, Uint8Array>([[0, meshLike(7)]]);

  const binary = await serializeVoxlDocumentV2(input, meshBytes);
  const parsed = parseVoxlBinaryV2(binary);

  assert.deepEqual(parsed.document.models[0].classification, baked);
  assert.deepEqual(parseVoxlAuto(binary).document.models[0].classification, baked);
});

test('a classification with no split round-trips as such', async () => {
  const baked = classification(null);
  const input = testInput([testModel('m1', { classification: baked })]);
  const meshBytes = new Map<number, Uint8Array>([[0, meshLike(8)]]);

  const parsed = parseVoxlBinaryV2(await serializeVoxlDocumentV2(input, meshBytes));

  // null means "the classifier found no model/support boundary" — a reader must
  // tell that apart from "never classified", which is `undefined`.
  assert.equal(parsed.document.models[0].classification?.model_triangle_count, null);
  assert.ok(parsed.document.models[0].classification);
});

test('a model without a classification writes no classification key', async () => {
  const input = testInput([testModel('m1')]);
  const meshBytes = new Map<number, Uint8Array>([[0, meshLike(9)]]);

  const json = serializeVoxlDocument(buildVoxlDocumentV1(input), false, { compression: 'none' });
  const binary = await serializeVoxlDocumentV2(input, meshBytes);

  assert.equal(json.includes('"classification"'), false);
  assert.equal(parseVoxlBinaryV2(binary).document.models[0].classification, undefined);
});

/** Minimal binary STL: 80-byte header + count, then 50 bytes per triangle. */
function binaryStl(triangles: number[][]): Uint8Array {
  const bytes = new Uint8Array(84 + triangles.length * 50);
  const view = new DataView(bytes.buffer);
  view.setUint32(80, triangles.length, true);
  triangles.forEach((triangle, index) => {
    const base = 84 + index * 50 + 12; // skip the face normal
    triangle.forEach((value, slot) => view.setFloat32(base + slot * 4, value, true));
  });
  return bytes;
}

test('the classification a VOXL writes is the one its loader consumes', async () => {
  // Four model-first triangles, so the baked boundary is observable in the
  // sections the loader rebuilds.
  const mesh = binaryStl([
    [0, 0, 0, 1, 0, 0, 0, 1, 0],
    [0, 0, 1, 1, 0, 1, 0, 1, 1],
    [0, 0, 2, 1, 0, 2, 0, 1, 2],
    [0, 0, 3, 1, 0, 3, 0, 1, 3],
  ]);

  const binary = await serializeVoxlDocumentV2(
    testInput([testModel('m1', { classification: classification(3) })]),
    new Map<number, Uint8Array>([[0, mesh]]),
  );
  const parsed = parseVoxlBinaryV2(binary);
  const payload = parsed.meshBytes.get('m1');
  const baked = parsed.document.models[0].classification;
  assert.ok(payload);
  assert.ok(baked);

  let classifyCalled = false;
  const geometry = await loadMeshGeometry(payload, 'm1.stl', {
    bakedClassification: baked,
    nativeProcessingMode: 'none',
    _isTauriRuntime: () => true,
    _classifyFromGeometry: async () => { classifyCalled = true; return null; },
  });

  assert.equal(classifyCalled, false, 'loading the file it wrote must not re-classify');
  assert.equal(geometry.meshDefects?.nativeRepairReport?.model_triangle_count, 3);
  assert.equal(
    geometry.meshDefects?.supportSectionGeometry?.getAttribute('position').count,
    3,
    'the restored split must address the stored triangle order',
  );
});
