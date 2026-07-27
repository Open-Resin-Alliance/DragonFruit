import assert from 'node:assert/strict';
import test from 'node:test';
import * as THREE from 'three';
import type { LoadedModel } from '@/features/scene/useSceneCollectionManager';
import {
  classificationIndexesGeometry,
  splitClassifiedSupportGeometry,
} from '@/features/scene/splitClassifiedSupports';
import { resolveOutputSectionPlan } from '../prepareModelGeometry';

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
        nativeRepairReport: {
          model_triangle_count: input.modelTriangleCount,
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
  // Same model as above but scaled to the shape that made the defect invisible:
  // an 11M model section against a 2M preview. Both must refuse, and for the
  // same stated reason — if only this one refuses, the guard is a subtraction
  // again.
  const luckyShape = makePreviewSplitModel({
    sceneTriangles: 2_000,
    modelTriangleCount: 11_000_000,
    nativePreview: true,
  });
  const unluckyShape = makePreviewSplitModel({
    sceneTriangles: 2_000,
    modelTriangleCount: 500,
    nativePreview: true,
  });
  try {
    assert.equal(splitClassifiedSupportGeometry(luckyShape), null);
    assert.equal(splitClassifiedSupportGeometry(unluckyShape), null);
    assert.equal(classificationIndexesGeometry(luckyShape.geometry), false);
    assert.equal(classificationIndexesGeometry(unluckyShape.geometry), false);
  } finally {
    luckyShape.geometry.geometry.dispose();
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
    assert.equal(classificationIndexesGeometry(model.geometry), true);
  } finally {
    split?.modelGeometry.geometry.dispose();
    split?.supportGeometry.geometry.dispose();
    model.geometry.geometry.dispose();
  }
});

/**
 * The gate and the cut must not be able to disagree. `page.tsx` enables
 * Split-to-Bodies on `resolveOutputSectionPlan(model).kind === 'scene-split'`;
 * `splitClassifiedSupportGeometry` is what runs when the user clicks it. If the
 * resolver ever says `scene-split` where the cut returns null, the menu offers
 * an action that silently does nothing behind a progress panel — which is
 * exactly the state this change removes.
 */
test('the menu gate and the cut agree on every shape', () => {
  const shapes = [
    { sceneTriangles: 10, modelTriangleCount: 4, nativePreview: true },
    { sceneTriangles: 10, modelTriangleCount: 4, nativePreview: false },
    { sceneTriangles: 2_000, modelTriangleCount: 11_000_000, nativePreview: true },
    { sceneTriangles: 10, modelTriangleCount: 10, nativePreview: false },
    { sceneTriangles: 10, modelTriangleCount: 0, nativePreview: false },
  ];

  const originalWarn = console.warn;
  console.warn = () => {};
  try {
    for (const shape of shapes) {
      const model = makePreviewSplitModel(shape);
      const gateSaysSplittable = resolveOutputSectionPlan(model).kind === 'scene-split';
      const split = splitClassifiedSupportGeometry(model);
      assert.equal(
        gateSaysSplittable,
        split !== null,
        `gate and cut disagree for ${JSON.stringify(shape)}`,
      );
      split?.modelGeometry.geometry.dispose();
      split?.supportGeometry.geometry.dispose();
      model.geometry.geometry.dispose();
    }
  } finally {
    console.warn = originalWarn;
  }
});
