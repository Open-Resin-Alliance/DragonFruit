import assert from 'node:assert/strict';
import test from 'node:test';
import * as THREE from 'three';
import type { LoadedModel } from '@/features/scene/useSceneCollectionManager';
import { buildSolidSliceMeshForWasm, type FullResSplicedModel } from '../rasterLayerZipExport';

/**
 * Ph3 — THE STAGING-ORDER CONTRACT.
 *
 * The slicing engine takes ONE split index (`model_triangle_count`), so the
 * staged buffer has to be `[every model triangle | every support triangle]`
 * across the whole scene. A spliced model appends to that buffer Rust-side, and
 * the WebView collector appends to it through `flushBinaryMeshChunk`. Both write
 * into the same buffer, so the only thing keeping the two blocks separable is
 * the ORDER of the four passes:
 *
 * ```text
 *   ① splice model runs   ② collector model   ③ splice support   ④ collector support
 * ```
 *
 * If ③ ran beside ① (the obvious implementation) the layout would be
 * `[spliced model | spliced support | collector model | collector support]` —
 * and one split index cannot describe that. Reading it with one index slices a
 * pre-supported plate's supports as model, with full confidence. So this test
 * exercises `buildSolidSliceMeshForWasm` with a mixed spliced/collector scene
 * and asserts the ordering it produces, not the code that produces it.
 *
 * RED BEFORE THE FIX: `onModelSectionStaged` did not exist, so this file did not
 * compile. That is a compile-only red and is recorded as such in the Ph3 AAR —
 * the behavioural half of the red lives in the Rust `splice_streams_model_runs_only`
 * / `splice_sections_partition_the_source_exactly` pair, which were measured
 * failing (3 168 staged where 768 was correct).
 */

function makeCollectorModel(id: string, modelTris: number, supportTris: number): LoadedModel {
  const total = modelTris + supportTris;
  const positions = new Float32Array(total * 9);
  for (let t = 0; t < total; t += 1) {
    // Model triangles sit high (z ≈ 5), support triangles low (z ≈ 1), so a
    // mis-ordered buffer is visible in the floats and not only in a count.
    const z = t < modelTris ? 5 : 1;
    positions.set([0, 0, z, 1, 0, z, 0, 1, z], t * 9);
  }
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.BufferAttribute(positions, 3));
  geometry.computeBoundingBox();
  const bbox = geometry.boundingBox?.clone() ?? new THREE.Box3();

  return {
    id,
    name: `${id}.stl`,
    visible: true,
    polygonCount: total,
    geometry: {
      geometry,
      bbox,
      center: bbox.getCenter(new THREE.Vector3()),
      size: bbox.getSize(new THREE.Vector3()),
      flatteningPlanes: [],
      meshDefects: {
        hasDefects: false,
        repairedFloats: 0,
        totalVertices: total * 3,
        nativeRepairReport: {
          model_triangle_count: modelTris,
          likely_support_geometry: true,
        },
      },
    },
    transform: {
      position: new THREE.Vector3(0, 0, 0),
      rotation: new THREE.Euler(0, 0, 0),
      scale: new THREE.Vector3(1, 1, 1),
    },
  } as unknown as LoadedModel;
}

/** A model the collector must skip entirely — it is staged Rust-side. */
function makeSplicedModel(id: string): LoadedModel {
  const model = makeCollectorModel(id, 1, 1);
  return model;
}

const PRINTER = {
  id: 'test-printer',
  name: 'Test',
  buildVolumeMm: { width: 200, depth: 120, height: 250 },
  bitDepth: 8,
  display: {
    resolutionX: 64,
    resolutionY: 64,
    outputFormat: 'raw',
    formatVersion: 1,
    mirrorX: false,
    mirrorY: false,
  },
} as never;

const MATERIAL = {
  id: 'test-material',
  name: 'Test Resin',
  layerHeightMm: 0.05,
  normalExposureSec: 2,
  bottomExposureSec: 30,
  bottomLayerCount: 5,
  liftDistanceMm: 6,
  liftSpeedMmMin: 60,
  retractSpeedMmMin: 150,
} as never;

test('the staged buffer stays model-contiguous across a mixed spliced/collector scene', async () => {
  const collectorModel = makeCollectorModel('collector', 4, 3);
  const splicedModel = makeSplicedModel('spliced');

  // What the Rust splice would have appended, in the order the orchestrator
  // drives it. Pass ① has already run when `buildSolidSliceMeshForWasm` starts.
  const fullResSplices = new Map<string, FullResSplicedModel>([
    ['spliced', {
      modelTriangleCount: 100,
      supportTriangleCount: 0,
      worldMin: [0, 0, 0],
      worldMax: [10, 10, 9],
    }],
  ]);

  /** Every append to the staged buffer, in order. */
  const appends: Array<{ from: 'splice'; section: string } | { from: 'collector'; zs: number[] }> = [
    { from: 'splice', section: 'model' },
  ];

  const result = await buildSolidSliceMeshForWasm({
    models: [collectorModel, splicedModel],
    printerProfile: PRINTER,
    materialProfile: MATERIAL,
    filenameBase: 'staging-order',
    meshChunkTargetBytes: 16 * 1024 * 1024,
    fullResSplices,
    flushBinaryMeshChunk: async (chunk) => {
      const floats = new Float32Array(chunk.buffer, chunk.byteOffset, chunk.byteLength / 4);
      const zs: number[] = [];
      for (let i = 2; i < floats.length; i += 3) zs.push(floats[i]);
      appends.push({ from: 'collector', zs });
    },
    onModelSectionStaged: async () => {
      // Pass ③ — the orchestrator's support splice. Recorded here, and the
      // bookkeeping it performs is reproduced so the assertions below see the
      // same numbers production would.
      appends.push({ from: 'splice', section: 'support' });
      const entry = fullResSplices.get('spliced')!;
      entry.supportTriangleCount = 60;
    },
  });

  const order = appends.map((entry) => (
    entry.from === 'splice' ? `splice:${entry.section}` : 'collector'
  ));

  // The support splice must sit strictly between the collector's model output
  // and its support output — not beside the model splice.
  const supportSpliceAt = order.indexOf('splice:support');
  assert.notEqual(supportSpliceAt, -1, 'pass ③ must run');
  assert.equal(order[0], 'splice:model', 'pass ① comes first');
  assert.ok(supportSpliceAt > 1, 'the collector must emit its model triangles before pass ③');

  const collectorBefore = appends
    .slice(0, supportSpliceAt)
    .flatMap((entry) => (entry.from === 'collector' ? entry.zs : []));
  const collectorAfter = appends
    .slice(supportSpliceAt + 1)
    .flatMap((entry) => (entry.from === 'collector' ? entry.zs : []));

  assert.ok(collectorBefore.length > 0, 'the collector must have flushed its model block before ③');
  assert.ok(collectorAfter.length > 0, 'the collector must still have support triangles to emit');
  // The bake centres and transforms the geometry, so the absolute z values are
  // not the fixture's — but the two bands stay separated, which is the point.
  assert.ok(
    Math.min(...collectorBefore) > Math.max(...collectorAfter),
    'everything flushed BEFORE the support splice must be the high (model) band and '
    + 'everything after it the low (support) band — a mis-ordered flush interleaves them',
  );

  // The single split index the job carries: spliced model runs + collector
  // model triangles. Everything staged after it is support.
  assert.equal(
    result.modelTriangleCount,
    100 + 4,
    'the split index counts the spliced MODEL section plus the collector model block — '
    + 'never the spliced support section',
  );
});

test('a model spliced whole contributes nothing to the support block', async () => {
  // No `onModelSectionStaged` ⇒ no pass ③, which is exactly the pre-Ph3 path a
  // source with no model/support split still takes.
  const collectorModel = makeCollectorModel('collector', 2, 2);
  const fullResSplices = new Map<string, FullResSplicedModel>([
    ['spliced', {
      modelTriangleCount: 50,
      supportTriangleCount: 0,
      worldMin: [0, 0, 0],
      worldMax: [4, 4, 4],
    }],
  ]);

  const result = await buildSolidSliceMeshForWasm({
    models: [collectorModel, makeSplicedModel('spliced')],
    printerProfile: PRINTER,
    materialProfile: MATERIAL,
    filenameBase: 'whole-splice',
    fullResSplices,
  });

  assert.equal(result.modelTriangleCount, 50 + 2);
});
