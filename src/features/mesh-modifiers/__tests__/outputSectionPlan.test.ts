import assert from 'node:assert/strict';
import test from 'node:test';
import * as THREE from 'three';
import type { LoadedModel } from '@/features/scene/useSceneCollectionManager';
import { prepareLoadedModelsForOutput, resolveOutputSectionPlan } from '../prepareModelGeometry';

/**
 * Ph3 — THE F3 REPLACEMENT.
 *
 * Ph2 finding F3: `splitClassifiedModelForOutput` decided whether to cut a
 * model into model/support halves by comparing the classification's
 * `model_triangle_count` against the SCENE geometry's triangle count, bailing
 * when the former was larger. Once Ph1's wiring made that count
 * full-resolution, an 11M count against a 2M preview happened to trip that
 * guard — so the code did the right thing for a reason nobody had written down
 * and nothing enforced. It READ as a degenerate-classification check while
 * WORKING as a resolution-mismatch check, and the day a preview held more
 * triangles than a model section it would have cut the preview at a
 * file-derived index and sliced supports as model, silently.
 *
 * `resolveOutputSectionPlan` replaces it with the structural question: does
 * `model_triangle_count` index THIS geometry at all? It does not when the
 * geometry is a native preview, because the classification describes the SOURCE
 * FILE — no arithmetic, no size dependence, no accident.
 *
 * RED BEFORE THE FIX: `resolveOutputSectionPlan` did not exist (compile-only).
 * The behavioural red is the second test below — under the old guard, a preview
 * SMALLER in triangle count than its own model section was split at the wrong
 * index, which is exactly what "safe by arithmetic accident" means.
 *
 * ## ⚠ CORRECTION, 2026-07-27 (F3 frame realignment, steps R2/R6)
 *
 * The "structural question" framing above is wrong about WHICH count is being
 * guarded. `nativeRepairReport.model_triangle_count` (frame (B)) is measured on
 * the buffer it is attached to — a decimated preview runs its own classify pass
 * over its own triangles and is reordered to match — so it DOES index the
 * preview. The contract quoted ("the classification describes the SOURCE FILE")
 * belongs to `ImportClassificationJson.model_triangle_count` (frame (A)), which
 * never reaches a report. See
 * `agents/Claude/STL-import-perf/20260727-Audit-model-triangle-count-frames.md`.
 *
 * The `describes-source-file` arm is nevertheless RETAINED (audit step R4, not
 * authorised): it is what routes a preview's Split-to-Bodies to Ph3d's
 * re-sourcing. These tests therefore still pin it — but the fixtures that paired
 * `nativePreview` with a count LARGER than the buffer have been re-tuned to
 * reachable counts, because frame (B) is bounded by its own buffer by
 * construction and those shapes cannot occur (audit §6, step R6).
 */

function makeModel(input: {
  sceneTriangles: number;
  modelTriangleCount: number | null;
  nativePreview?: boolean;
  sourcePath?: string | null;
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
    sourcePath: input.sourcePath ?? null,
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

test('a splice-eligible model has its sections expressed by the splice, not by a cut', () => {
  // R6: the count was 6_000_000 against 10 scene triangles — unreachable, since
  // a preview's report is bounded by its own buffer. A reachable count changes
  // nothing here: `spliced-sections` short-circuits before the report is read.
  const model = makeModel({
    sceneTriangles: 10,
    modelTriangleCount: 4,
    nativePreview: true,
    sourcePath: 'C:/models/plate.stl',
  });
  assert.deepEqual(resolveOutputSectionPlan(model), { kind: 'spliced-sections' });
  model.geometry.geometry.dispose();
});

test('a preview whose model section OUT-COUNTS it is still never cut', () => {
  // THE BEHAVIOURAL RED. `modelTriangleCount` (4) is LESS than the preview's
  // triangle count (10), so the old `modelTriangleCount >= totalTriangleCount`
  // guard would have let this through and cut the preview at triangle 4 — an
  // index derived from a file this geometry is only a reduction of. No
  // sourcePath, so it is not splice-eligible and the splice cannot rescue it.
  const model = makeModel({
    sceneTriangles: 10,
    modelTriangleCount: 4,
    nativePreview: true,
    sourcePath: null,
  });
  assert.deepEqual(resolveOutputSectionPlan(model), {
    kind: 'whole',
    reason: 'describes-source-file',
  });
  model.geometry.geometry.dispose();
});

test('a decimated-output model is left whole for a stated reason, not an accident', () => {
  // Ph2's toggle: the user chose the decimated mesh AS the original. It is not
  // splice-eligible, it is still a preview, and the arm that catches it is
  // structural rather than arithmetic.
  //
  // R6: the count was 11_000_000 against a 2 000 000-triangle preview — the
  // shape the old subtraction bailed on by accident, and unreachable in
  // production. Re-tuned to 1 500 000, which is REACHABLE (a 7M plate with a
  // 1.5M model body) and which the old arithmetic guard would have waved
  // straight through. Same verdict, and now for a reason a fixture can reach.
  const model = makeModel({
    sceneTriangles: 2_000_000,
    modelTriangleCount: 1_500_000,
    nativePreview: true,
    sourcePath: 'C:/models/plate.stl',
  });
  (model as unknown as { outputPolicy: { mode: string } }).outputPolicy = { mode: 'decimated' };
  assert.deepEqual(resolveOutputSectionPlan(model), {
    kind: 'whole',
    reason: 'describes-source-file',
  });
  model.geometry.geometry.dispose();
});

test('a non-preview classified model is still split, exactly as before', () => {
  const model = makeModel({ sceneTriangles: 10, modelTriangleCount: 4 });
  assert.deepEqual(resolveOutputSectionPlan(model), {
    kind: 'scene-split',
    modelTriangleCount: 4,
    totalTriangleCount: 10,
  });
  model.geometry.geometry.dispose();
});

test('a classification that cannot index its own geometry is refused, loudly', () => {
  // Not a preview, so the count is SUPPOSED to index this mesh — and does not.
  // Under the old guard this returned null indistinguishably from the preview
  // case and said nothing.
  //
  // R6: this shape is UNREACHABLE in production too (audit §6) — a report cannot
  // out-count the buffer it was measured on, and the one mutator that could
  // carry a report across a triangle-count change drops `meshDefects` entirely.
  // The test is KEPT, not deleted: the arm it covers is retained as a deliberate
  // tripwire, and an untested tripwire is one that will not fire when the
  // invariant it watches finally breaks.
  const model = makeModel({ sceneTriangles: 10, modelTriangleCount: 10 });
  const warnings: string[] = [];
  const originalWarn = console.warn;
  console.warn = (...args: unknown[]) => { warnings.push(String(args[0])); };
  try {
    assert.deepEqual(resolveOutputSectionPlan(model), {
      kind: 'whole',
      reason: 'count-exceeds-geometry',
    });
  } finally {
    console.warn = originalWarn;
    model.geometry.geometry.dispose();
  }
  assert.equal(warnings.length, 1);
  assert.match(warnings[0], /does not\s+describe this mesh/);
});

test('an unclassified model reports no split', () => {
  const model = makeModel({ sceneTriangles: 10, modelTriangleCount: null });
  assert.deepEqual(resolveOutputSectionPlan(model), { kind: 'whole', reason: 'no-split' });
  model.geometry.geometry.dispose();
});

test('prepareLoadedModelsForOutput splits exactly the scene-split plans', async () => {
  const splittable = makeModel({ sceneTriangles: 10, modelTriangleCount: 4 });
  const preview = makeModel({ sceneTriangles: 10, modelTriangleCount: 4, nativePreview: true });
  preview.id = 'preview';

  const prepared = await prepareLoadedModelsForOutput([splittable, preview]);
  try {
    assert.equal(prepared.models.length, 3, 'the splittable model becomes two; the preview stays one');
    assert.equal(prepared.models.filter((m) => m.id === 'preview').length, 1);
  } finally {
    prepared.dispose();
    splittable.geometry.geometry.dispose();
    preview.geometry.geometry.dispose();
  }
});
