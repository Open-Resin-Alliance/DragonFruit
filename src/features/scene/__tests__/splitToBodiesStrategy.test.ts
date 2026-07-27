import assert from 'node:assert/strict';
import test from 'node:test';
import * as THREE from 'three';
import type { LoadedModel } from '@/features/scene/useSceneCollectionManager';
import { resolveSplitToBodiesStrategy, canSplitToBodies } from '../splitToBodiesStrategy';

/**
 * Ph3d — ONE ANSWER for "how does this model split", shared by the menu gate and
 * the action.
 *
 * The defect Ph3c closed was two answers: the menu asked whether
 * `model_triangle_count` was truthy, the action tried to cut the scene geometry
 * at that index, and for a decimated preview those disagree — so the affordance
 * promised a split that flashed a progress panel and did nothing. Ph3c disabled
 * the affordance; Ph3d makes the split work by re-sourcing each section from the
 * original file. Both fixes depend on the same thing: the gate and the action
 * reading one resolver.
 *
 * RED: compile-only. `resolveSplitToBodiesStrategy` did not exist. The
 * behavioural red for this arc lives in `splitClassifiedSupportsPreview.test.ts`,
 * which measured the wrong cut actually happening.
 */

function makeModel(input: {
  sceneTriangles: number;
  modelTriangleCount: number | null;
  nativePreview?: boolean;
  sourcePath?: string | null;
  cPre?: [number, number, number] | null;
  runs?: Uint32Array | null;
  sourceTriangleCount?: number;
  isSection?: 'model' | 'support';
  decimatedOutput?: boolean;
}): LoadedModel {
  const positions = new Float32Array(input.sceneTriangles * 9);
  for (let t = 0; t < input.sceneTriangles; t += 1) {
    positions.set([0, 0, t, 1, 0, t, 0, 1, t], t * 9);
  }
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.BufferAttribute(positions, 3));
  geometry.computeBoundingBox();
  const bbox = geometry.boundingBox?.clone() ?? new THREE.Box3();
  const runs = input.runs === undefined ? new Uint32Array([0, 4]) : input.runs;
  const sourceTriangleCount = input.sourceTriangleCount ?? 11_240_000;

  return {
    id: 'plate',
    name: 'plate.stl',
    visible: true,
    polygonCount: input.sceneTriangles,
    sourcePath: input.sourcePath === undefined ? 'C:/models/plate.stl' : input.sourcePath,
    ...(input.decimatedOutput ? { outputPolicy: { mode: 'decimated' } } : {}),
    geometry: {
      geometry,
      bbox,
      center: bbox.getCenter(new THREE.Vector3()),
      size: bbox.getSize(new THREE.Vector3()),
      flatteningPlanes: [],
      ...(runs
        ? {
          importRunMap: {
            runs,
            sourceTriangleCount,
            modelTriangleCount: input.modelTriangleCount ?? 0,
            droppedNonFiniteTriangles: 0,
            totalRunCount: runs.length / 2,
          },
        }
        : {}),
      ...(input.nativePreview
        ? {
          nativePreview: {
            originalTriangleCount: sourceTriangleCount,
            previewTriangleCount: input.sceneTriangles,
            cPre: input.cPre === undefined ? ([1, 2, 3] as [number, number, number]) : input.cPre ?? undefined,
            sourceFingerprint: { sizeBytes: 562_000_000, mtimeMs: 1_700_000_000_000 },
            ...(input.isSection
              ? { sourceSection: { section: input.isSection, runs, recomputeReason: null } }
              : {}),
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

test('a non-preview classified model is cut in the scene, exactly as before', () => {
  const model = makeModel({ sceneTriangles: 10, modelTriangleCount: 4 });
  assert.deepEqual(resolveSplitToBodiesStrategy(model), { kind: 'scene-split' });
  model.geometry.geometry.dispose();
});

test('a decimated preview re-sources both sections instead of being refused', () => {
  // THE Ph3d BEHAVIOUR. Ph3c returned `unavailable` here; the classification
  // still describes the file, so the answer is not "cannot", it is "not from
  // this mesh".
  const model = makeModel({
    sceneTriangles: 2_000_000,
    modelTriangleCount: 1_500_000,
    nativePreview: true,
    runs: new Uint32Array([0, 750_000, 6_000_000, 750_000]),
    sourceTriangleCount: 7_000_000,
  });
  const strategy = resolveSplitToBodiesStrategy(model);
  assert.equal(strategy.kind, 'resource-sections');
  if (strategy.kind !== 'resource-sections') throw new Error('unreachable');
  assert.equal(strategy.sourcePath, 'C:/models/plate.stl');
  assert.deepEqual(strategy.cPre, [1, 2, 3]);
  assert.deepEqual(Array.from(strategy.runs ?? []), [0, 750_000, 6_000_000, 750_000]);
  assert.equal(strategy.expectedModelTriangleCount, 1_500_000);
  assert.equal(strategy.expectedSourceTriangleCount, 7_000_000);
  model.geometry.geometry.dispose();
});

test('the small-model-section shape that used to cut garbage now re-sources', () => {
  // The exact shape Ph3c's behavioural red used: a model section SMALLER than
  // the preview, where every arithmetic guard passes and the naive cut produced
  // two meaningless bodies.
  const model = makeModel({
    sceneTriangles: 10,
    modelTriangleCount: 4,
    nativePreview: true,
  });
  assert.equal(resolveSplitToBodiesStrategy(model).kind, 'resource-sections');
  model.geometry.geometry.dispose();
});

test('the decimated-output toggle does not block the split', () => {
  // Ruling #12 governs what OUTPUTS come from — it does not say the original
  // file may not be read to separate the sections. Both halves inherit the
  // toggle, so the user's choice survives the split.
  const model = makeModel({
    sceneTriangles: 2_000_000,
    modelTriangleCount: 1_500_000,
    nativePreview: true,
    decimatedOutput: true,
  });
  assert.equal(resolveSplitToBodiesStrategy(model).kind, 'resource-sections');
  model.geometry.geometry.dispose();
});

test('a preview with no retained source path cannot be split', () => {
  const model = makeModel({
    sceneTriangles: 10,
    modelTriangleCount: 4,
    nativePreview: true,
    sourcePath: null,
  });
  assert.deepEqual(resolveSplitToBodiesStrategy(model), {
    kind: 'unavailable',
    reason: 'source-unavailable',
  });
  model.geometry.geometry.dispose();
});

test('a preview with no stored frame datum cannot be split — never guess a center', () => {
  const model = makeModel({
    sceneTriangles: 10,
    modelTriangleCount: 4,
    nativePreview: true,
    cPre: null,
  });
  assert.deepEqual(resolveSplitToBodiesStrategy(model), {
    kind: 'unavailable',
    reason: 'source-unavailable',
  });
  model.geometry.geometry.dispose();
});

test('a half is not splittable again', () => {
  const model = makeModel({
    sceneTriangles: 1_000_000,
    modelTriangleCount: null,
    nativePreview: true,
    isSection: 'model',
  });
  assert.deepEqual(resolveSplitToBodiesStrategy(model), {
    kind: 'unavailable',
    reason: 'already-a-section',
  });
  model.geometry.geometry.dispose();
});

test('an unclassified model reports no split', () => {
  const model = makeModel({ sceneTriangles: 10, modelTriangleCount: null, runs: null });
  assert.deepEqual(resolveSplitToBodiesStrategy(model), {
    kind: 'unavailable',
    reason: 'no-split',
  });
  model.geometry.geometry.dispose();
});

test('a classification that cannot index its own geometry is refused by name', () => {
  const model = makeModel({ sceneTriangles: 10, modelTriangleCount: 10 });
  const originalWarn = console.warn;
  console.warn = () => {};
  try {
    assert.deepEqual(resolveSplitToBodiesStrategy(model), {
      kind: 'unavailable',
      reason: 'count-exceeds-geometry',
    });
  } finally {
    console.warn = originalWarn;
    model.geometry.geometry.dispose();
  }
});

test('canSplitToBodies is exactly "not unavailable"', () => {
  const splittable = makeModel({ sceneTriangles: 10, modelTriangleCount: 4 });
  const preview = makeModel({ sceneTriangles: 10, modelTriangleCount: 4, nativePreview: true });
  const nothing = makeModel({ sceneTriangles: 10, modelTriangleCount: null, runs: null });

  assert.equal(canSplitToBodies(splittable), true);
  assert.equal(canSplitToBodies(preview), true, 'Ph3d: a preview is now splittable');
  assert.equal(canSplitToBodies(nothing), false);

  splittable.geometry.geometry.dispose();
  preview.geometry.geometry.dispose();
  nothing.geometry.geometry.dispose();
});
