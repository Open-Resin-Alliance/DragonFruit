import assert from 'node:assert/strict';
import test from 'node:test';
import * as THREE from 'three';
import type { LoadedModel } from '@/features/scene/useSceneCollectionManager';
import {
  geometryIsVerbatimImport,
  splitClassifiedSupportGeometry,
} from '@/features/scene/splitClassifiedSupports';
import { resolveSplitToBodiesStrategy } from '@/features/scene/splitToBodiesStrategy';
import { makeGeometryFrameReport } from '@/utils/__tests__/triangleCountFrameFixtures';

/**
 * Ph3 (scene path) — THE F3 DEFECT CLASS ON THE USER-INVOKED SPLIT.
 *
 * `resolveOutputSectionPlan` fixed the OUTPUT path: a `model_triangle_count`
 * measured on the full-resolution source file does not index a decimated
 * preview, so such a model is never cut. `splitClassifiedSupportGeometry` — the
 * Split-to-Bodies cut, and the same function the output path calls once it has
 * decided — kept the old arithmetic and nothing else:
 *
 *     const supportTriangleCount = totalTriangleCount - modelTriangleCount;
 *     if (supportTriangleCount <= 0) return null;
 *
 * That survives the usual shape by luck. An 11M model section against a 2M
 * preview goes negative and bails, which is why nobody saw this. It is not a
 * resolution check — it is a subtraction, and it only says "no" while the
 * source file happens to be much larger than the preview of it.
 *
 * THE BEHAVIOURAL RED, first test below: a preview holding 10 triangles whose
 * classification reports a 4-triangle MODEL SECTION. The subtraction yields 6,
 * every bail passes, and the function cuts the preview's position array at
 * float 36 — an offset derived from a file this buffer is only a reduction of.
 * Two bodies come back, both geometrically meaningless, both presented to the
 * user as a successful split. Before the fix this test failed by receiving a
 * split object; after it, the refusal is structural and size-independent.
 *
 * ## Ph3d update
 *
 * The refusals below are UNCHANGED and still load-bearing: the naive cut must
 * never run on a preview. What changed is what happens INSTEAD of it. Ph3c
 * disabled the affordance; Ph3d makes the split WORK by re-sourcing each section
 * from the original file (`resolveSplitToBodiesStrategy` → `resource-sections`).
 *
 * So this file keeps the fence, and `splitToBodiesStrategy.test.ts` owns the new
 * behaviour. The one test that had to change is the last one, whose premise —
 * "the gate enables exactly what this cut can do" — Ph3d retired.
 *
 * ## ⚠ CORRECTION, 2026-07-27 (F3 frame realignment, step R6)
 *
 * The premise quoted above is WRONG on one point, and it matters for reading
 * these tests. `nativeRepairReport.model_triangle_count` is measured on the
 * buffer it is attached to, previews included — a decimated preview runs its own
 * classify pass over its own triangles and is reordered to match. So the cuts
 * refused below would in fact have landed in the RIGHT place; the refusal is
 * justified by Ph3d's better answer (re-source both halves at full resolution),
 * not by the index being meaningless. See
 * `agents/Claude/STL-import-perf/20260727-Audit-model-triangle-count-frames.md`.
 *
 * The fixtures are trimmed accordingly: a shape pairing `nativePreview` with a
 * count LARGER than the buffer (the 11M-against-2 000 "lucky shape") is
 * **unreachable in production** — frame (B) is bounded by its own buffer by
 * construction — and has been replaced by a reachable one. The refusals
 * themselves are unchanged and still asserted.
 */

function makePreviewSplitModel(input: {
  sceneTriangles: number;
  modelTriangleCount: number;
  nativePreview: boolean;
}): LoadedModel {
  const positions = new Float32Array(input.sceneTriangles * 9);
  for (let t = 0; t < input.sceneTriangles; t += 1) {
    positions.set([0, 0, t, 1, 0, t, 0, 1, t], t * 9);
  }
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.BufferAttribute(positions, 3));
  geometry.computeBoundingBox();
  const bbox = geometry.boundingBox?.clone() ?? new THREE.Box3();

  return {
    id: 'plate',
    name: 'plate.stl',
    visible: true,
    polygonCount: input.sceneTriangles,
    sourcePath: null,
    geometry: {
      geometry,
      bbox,
      center: bbox.getCenter(new THREE.Vector3()),
      size: bbox.getSize(new THREE.Vector3()),
      flatteningPlanes: [],
      ...(input.nativePreview
        ? {
            nativePreview: {
              originalTriangleCount: 11_240_000,
              previewTriangleCount: input.sceneTriangles,
              cPre: [1, 2, 3] as [number, number, number],
              sourceFingerprint: { sizeBytes: 562_000_000, mtimeMs: 1_700_000_000_000 },
            },
          }
        : {}),
      meshDefects: {
        hasDefects: false,
        repairedFloats: 0,
        totalVertices: input.sceneTriangles * 3,
        nativeRepairReport: makeGeometryFrameReport({
          modelTriangleCount: input.modelTriangleCount,
          likelySupportGeometry: true,
        }),
      },
    },
    transform: {
      position: new THREE.Vector3(0, 0, 0),
      rotation: new THREE.Euler(0, 0, 0),
      scale: new THREE.Vector3(1, 1, 1),
    },
  } as unknown as LoadedModel;
}

test('a preview whose model section is SMALLER than it is refuses the cut', () => {
  // 4 < 10, so `totalTriangleCount - modelTriangleCount` is a healthy 6 and the
  // pre-fix guards all wave this through — producing a 4-triangle "model" and a
  // 6-triangle "supports" out of a mesh whose triangles correspond to neither.
  const model = makePreviewSplitModel({
    sceneTriangles: 10,
    modelTriangleCount: 4,
    nativePreview: true,
  });
  try {
    assert.equal(
      splitClassifiedSupportGeometry(model),
      null,
      'the classification indexes the source file, not this decimated preview',
    );
  } finally {
    model.geometry.geometry.dispose();
  }
});

test('the arithmetic that used to carry this case is no longer what decides it', () => {
  // The scaled-up version of the same shape: a 500-triangle model section inside
  // a 2 000-triangle preview. The subtraction yields a healthy 1 500 and every
  // pre-Ph3c bail waves it through, so only the structural refusal stops it.
  //
  // R6, 2026-07-27: this test used to pair the above with a "lucky shape" —
  // 11 000 000 against 2 000 triangles — to show the old subtraction went
  // negative and bailed by accident. That fixture is DELETED as unreachable: a
  // `nativePreview` geometry's report comes from a classify pass over that very
  // buffer and is bounded by it (audit §6), so no production path can attach a
  // count larger than the mesh to a preview. Only the reachable half survives,
  // and it is the half that carries the assertion.
  const unluckyShape = makePreviewSplitModel({
    sceneTriangles: 2_000,
    modelTriangleCount: 500,
    nativePreview: true,
  });
  try {
    assert.equal(splitClassifiedSupportGeometry(unluckyShape), null);
    assert.equal(geometryIsVerbatimImport(unluckyShape.geometry), false);
  } finally {
    unluckyShape.geometry.geometry.dispose();
  }
});

test('a non-preview classified model still splits, byte-for-byte as before', () => {
  const model = makePreviewSplitModel({
    sceneTriangles: 10,
    modelTriangleCount: 4,
    nativePreview: false,
  });
  const split = splitClassifiedSupportGeometry(model);
  try {
    assert.ok(split, 'the classification indexes this geometry — the cut is valid');
    assert.equal(split.modelTriangleCount, 4);
    assert.equal(split.supportTriangleCount, 6);
    assert.equal(split.totalTriangleCount, 10);
    assert.equal(geometryIsVerbatimImport(model.geometry), true);
  } finally {
    split?.modelGeometry.geometry.dispose();
    split?.supportGeometry.geometry.dispose();
    model.geometry.geometry.dispose();
  }
});

/**
 * THE STRATEGY AND THE SCENE CUT MUST AGREE.
 *
 * Ph3c's version of this test asserted that the menu gate enabled exactly what
 * the naive cut could do. **Ph3d retired that premise**: a decimated preview is
 * now splittable, by re-sourcing each section from the original file, so the
 * gate deliberately enables cases the cut refuses.
 *
 * What survives is the narrower and still load-bearing claim: `scene-split` is
 * chosen IF AND ONLY IF the scene cut actually succeeds. That is the invariant
 * whose violation produced the original defect — an affordance that opened a
 * progress panel and did nothing. A `resource-sections` verdict is deliberately
 * not compared against the cut, because it never calls it.
 */
test('the scene-split strategy is chosen exactly when the scene cut works', () => {
  const shapes = [
    { sceneTriangles: 10, modelTriangleCount: 4, nativePreview: true },
    { sceneTriangles: 10, modelTriangleCount: 4, nativePreview: false },
    // R6: was `2_000 / 11_000_000 / preview` — unreachable, a preview's report
    // cannot out-count its own buffer. Replaced by the reachable large-preview
    // shape, which exercises the same routing arm.
    { sceneTriangles: 2_000, modelTriangleCount: 500, nativePreview: true },
    // The `count === total` non-preview shape is ALSO unreachable in production
    // (audit §6) — it is kept deliberately, because it is the only coverage of
    // the `count-exceeds-geometry` tripwire's routing, and a tripwire whose
    // wiring is untested is a tripwire that will not fire.
    { sceneTriangles: 10, modelTriangleCount: 10, nativePreview: false },
    { sceneTriangles: 10, modelTriangleCount: 0, nativePreview: false },
  ];

  const originalWarn = console.warn;
  console.warn = () => {};
  try {
    for (const shape of shapes) {
      const model = makePreviewSplitModel(shape);
      const strategy = resolveSplitToBodiesStrategy(model);
      const split = splitClassifiedSupportGeometry(model);
      assert.equal(
        strategy.kind === 'scene-split',
        split !== null,
        `strategy and cut disagree for ${JSON.stringify(shape)}`,
      );
      split?.modelGeometry.geometry.dispose();
      split?.supportGeometry.geometry.dispose();
      model.geometry.geometry.dispose();
    }
  } finally {
    console.warn = originalWarn;
  }
});
