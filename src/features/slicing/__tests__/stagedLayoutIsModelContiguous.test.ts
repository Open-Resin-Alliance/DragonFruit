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

function makeCollectorModel(
  id: string,
  modelTris: number,
  supportTris: number,
  options: {
    /** Mark the buffer a decimated stand-in for a larger source file. */
    nativePreview?: boolean;
    /**
     * Override the report's `model_triangle_count`. Defaults to `modelTris`,
     * i.e. a report that agrees with the geometry — which is the only shape a
     * production classify pass can produce. Overriding it is how the
     * contradiction tripwire is reached at all.
     */
    reportModelTriangleCount?: number | null;
    likelySupportGeometry?: boolean;
  } = {},
): LoadedModel {
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
      ...(options.nativePreview
        ? {
          nativePreview: {
            originalTriangleCount: 11_240_000,
            previewTriangleCount: total,
            cPre: [1, 2, 3] as [number, number, number],
            sourceFingerprint: { sizeBytes: 562_000_000, mtimeMs: 1_700_000_000_000 },
          },
        }
        : {}),
      meshDefects: {
        hasDefects: false,
        repairedFloats: 0,
        totalVertices: total * 3,
        nativeRepairReport: {
          model_triangle_count: options.reportModelTriangleCount === undefined
            ? modelTris
            : options.reportModelTriangleCount,
          likely_support_geometry: options.likelySupportGeometry ?? true,
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

/**
 * ══ F3 FRAME REALIGNMENT, step R3 (2026-07-27) ═══════════════════════════════
 *
 * The three tests below replace the three Ph3e added and then had reverted.
 *
 * Ph3e read the contract of `ImportClassificationJson.model_triangle_count`
 * (frame (A) — measured on the SOURCE FILE by `classify_import`, travels in the
 * DFST header and the run map) and applied it to
 * `meshDefects.nativeRepairReport.model_triangle_count` (frame (B)). Those are
 * different numbers. A decimated preview does NOT reuse the file's
 * classification: `processGeometry` withholds it (`preClassified` stays `null`
 * because `_isNativePreview === true`) and runs a fresh `mesh_classify_staged`
 * pass over the preview's OWN triangles, which reorders the scene buffer
 * model-first and writes it back. The count that comes out is bounded by that
 * buffer by construction and indexes it exactly.
 *
 * So Ph3e's CP1 asserted the wrong result, and the "fix" it measured green was
 * the defect: returning `totalTriCount` for a preview makes
 * `modelTriangleCount === totalTriangles`, which trips
 * `model_triangle_count >= total_triangles` in `SupportMaskContext::from_job`
 * (`engine.rs`) and **disables support anti-aliasing for the whole slice** —
 * imported supports then get model-grade AA, softening the tip pixels that do
 * the adhering.
 *
 * CP1 below is that test INVERTED. Audit:
 * `agents/Claude/STL-import-perf/20260727-Audit-model-triangle-count-frames.md`.
 */

test('CP1 (inverted): a decimated preview IS cut at its own geometry-frame boundary', async () => {
  // The exact shape Ph3e's CP1 used — 1 500 model of 2 000 preview triangles —
  // and the exact opposite assertion. This is what Ph3e broke: it staged all
  // 2 000 as model, which is the state that puts 500 SUPPORT triangles into the
  // model block, and it killed the support mask on the way past.
  const preview = makeCollectorModel('preview', 1_500, 500, { nativePreview: true });

  const zs: number[] = [];
  const result = await buildSolidSliceMeshForWasm({
    models: [preview],
    printerProfile: PRINTER,
    materialProfile: MATERIAL,
    filenameBase: 'preview-split',
    meshChunkTargetBytes: 16 * 1024 * 1024,
    flushBinaryMeshChunk: async (chunk) => {
      const floats = new Float32Array(chunk.buffer, chunk.byteOffset, chunk.byteLength / 4);
      for (let i = 2; i < floats.length; i += 3) zs.push(floats[i]);
    },
  });

  assert.equal(
    result.modelTriangleCount,
    1_500,
    'a decimated preview carries its OWN classification, measured over its OWN triangles and '
    + 'reordered to match — so 1 500 stages 1 500 model + 500 support, exactly as the preview '
    + 'says. Returning 2 000 here (Ph3e) hands the slicer model_triangle_count === total, which '
    + 'makes SupportMaskContext::from_job bail and disables support anti-aliasing entirely',
  );

  // The number being right is not enough — the cut has to be in the right PLACE.
  // Model triangles were built high (z ≈ 5), support low (z ≈ 1); the bake
  // recentres them, so the absolute values move but the bands stay separated.
  assert.equal(zs.length, 2_000 * 3, 'every triangle reached the collector');
  const modelZs = zs.slice(0, 1_500 * 3);
  const supportZs = zs.slice(1_500 * 3);
  assert.ok(
    Math.min(...modelZs) > Math.max(...supportZs),
    'the first 1 500 staged triangles must all be the high (model) band — if the boundary is '
    + 'off by even one triangle the two bands interleave here',
  );

  preview.geometry.geometry.dispose();
});

test('CP3 lock: a NON-preview model splits at the same count, by the same arithmetic', async () => {
  // The regression lock. Identical numbers to CP1 with the preview marker
  // removed: both frames are the same frame, so both must answer 1 500. A
  // divergence between these two tests means a `nativePreview` term has been
  // reintroduced at this site.
  const model = makeCollectorModel('verbatim', 1_500, 500);

  const result = await buildSolidSliceMeshForWasm({
    models: [model],
    printerProfile: PRINTER,
    materialProfile: MATERIAL,
    filenameBase: 'verbatim-split',
  });

  assert.equal(result.modelTriangleCount, 1_500);
  model.geometry.geometry.dispose();
});

test('a count that exceeds this geometry stages whole and warns ONCE per model per slice', async () => {
  // THE TRIPWIRE. Unreachable in production — frame (B) is measured on the
  // buffer it is attached to and bounded by it (audit §6) — which is precisely
  // why it must be audible rather than clamped in silence: if it ever fires,
  // some upstream writer attached a report to a mesh it does not describe.
  //
  // `Math.min` still clamps, belt-and-braces over Rust's own
  // `.min(total_triangles)` in `engine.rs`. The clamp is cheap and it is a real
  // buffer bound; what it must not do any more is swallow the contradiction.
  const model = makeCollectorModel('contradiction', 2_000, 0, {
    reportModelTriangleCount: 3_000,
  });

  const warnings: string[] = [];
  const originalWarn = console.warn;
  console.warn = (...args: unknown[]) => { warnings.push(String(args[0])); };
  let result;
  try {
    result = await buildSolidSliceMeshForWasm({
      models: [model],
      printerProfile: PRINTER,
      materialProfile: MATERIAL,
      filenameBase: 'contradiction',
    });
  } finally {
    console.warn = originalWarn;
  }

  assert.equal(result.modelTriangleCount, 2_000, 'clamped to the buffer, not the claim');
  assert.equal(
    warnings.filter((line) => line.includes('exceeds its geometry')).length,
    1,
    'exactly once — `effectiveModelTriangleCount` runs FOUR times per model per slice (the '
    + 'split index, the [SupportAA] diagnostic, pass ② and pass ④), so a warning keyed per '
    + 'CALL would quadruple on every slice of an already-broken model',
  );

  model.geometry.geometry.dispose();
});
