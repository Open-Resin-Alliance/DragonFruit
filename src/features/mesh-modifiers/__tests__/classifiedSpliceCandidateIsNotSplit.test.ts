import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import * as THREE from 'three';
import type { LoadedModel } from '@/features/scene/useSceneCollectionManager';
import { prepareLoadedModelsForOutput, resolveOutputGeometrySource } from '../prepareModelGeometry';

/**
 * THE Ph1 D1 FENCE — regression lock.
 *
 * `splitClassifiedModelForOutput` rebuilds each half from a bare
 * `Float32Array` (`splitClassifiedSupports.ts` → `buildGeometryWithBounds`),
 * which carries no `nativePreview`. For a model whose scene geometry is a
 * reduced native preview that is fatal: `resolveFullResSourceForModel` then
 * returns `null`, `resolveOutputGeometrySource` reports `scene-geometry`, and
 * the splice loop in `sliceExportOrchestrator.ts` drops the model — so a
 * >budget pre-supported STL silently slices at preview fidelity.
 *
 * Today the split fires only for the minority of imports that were classified.
 * Ph1 classifies the FULL-RES mesh at import, which makes
 * `model_triangle_count` the NORMAL case — and would therefore convert this
 * from an edge case into the DEFAULT slicing path for every ≥budget
 * pre-supported model. The fence keeps splice-eligible models whole so Ph1 is
 * behaviour-neutral; Ph3's run-map splice is what finally expresses the split
 * on this path.
 *
 * Ph3 STATUS: the splice now expresses the split (two passes, model runs then
 * the support complement), so the ANSWER these tests pin is unchanged while the
 * reason for it has inverted — from "we cannot express this" to "it is expressed
 * elsewhere, and cutting here would double-count". The decision itself moved to
 * `resolveOutputSectionPlan`; see `outputSectionPlan.test.ts`.
 */

function makeClassifiedModel(overrides: {
  nativePreview?: unknown;
  sourcePath?: string | null;
}): LoadedModel {
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute(
    'position',
    new THREE.Float32BufferAttribute(
      [0, 0, 0, 2, 0, 0, 0, 2, 0, 10, 0, 0, 12, 0, 0, 10, 2, 0],
      3,
    ),
  );
  geometry.computeBoundingBox();
  const bbox = geometry.boundingBox?.clone() ?? new THREE.Box3();

  return {
    id: 'oversized-presupported',
    name: 'presupported.stl',
    visible: true,
    polygonCount: 2,
    sourcePath: overrides.sourcePath ?? null,
    geometry: {
      geometry,
      bbox,
      center: bbox.getCenter(new THREE.Vector3()),
      size: bbox.getSize(new THREE.Vector3()),
      flatteningPlanes: [],
      ...(overrides.nativePreview ? { nativePreview: overrides.nativePreview } : {}),
      meshDefects: {
        hasDefects: false,
        repairedFloats: 0,
        totalVertices: 6,
        nativeRepairReport: {
          model_triangle_count: 1,
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

const NATIVE_PREVIEW = {
  originalTriangleCount: 11_240_000,
  previewTriangleCount: 2,
  cPre: [1, 2, 3] as [number, number, number],
  sourceFingerprint: { sizeBytes: 562_000_000, mtimeMs: 1_700_000_000_000 },
};

test('a classified model that is splice-eligible is NOT split for output', async () => {
  const model = makeClassifiedModel({
    nativePreview: NATIVE_PREVIEW,
    sourcePath: 'C:/models/presupported.stl',
  });

  assert.equal(
    resolveOutputGeometrySource(model).kind,
    'fullres-source-file',
    'fixture must be splice-eligible or it does not exercise the fence',
  );

  const prepared = await prepareLoadedModelsForOutput([model]);
  try {
    assert.equal(
      prepared.models.length,
      1,
      'splitting a splice-eligible model drops nativePreview and silently '
      + 'demotes it to preview-fidelity slicing (D1)',
    );
    const [only] = prepared.models;
    assert.equal(
      resolveOutputGeometrySource(only).kind,
      'fullres-source-file',
      'the prepared model must still resolve to the full-resolution source',
    );
  } finally {
    prepared.dispose();
    model.geometry.geometry.dispose();
  }
});

test('a classified model with no full-res source is still split for output', async () => {
  // The fence is narrow on purpose: models that were never splice-eligible
  // keep today's exact behaviour, so Ph1 changes no output bytes.
  const model = makeClassifiedModel({ nativePreview: null, sourcePath: null });

  const prepared = await prepareLoadedModelsForOutput([model]);
  try {
    assert.equal(prepared.models.length, 2, 'non-splice models must still split');
  } finally {
    prepared.dispose();
    model.geometry.geometry.dispose();
  }
});

test('the slice orchestrator never skips a full-res candidate silently', () => {
  // The splice loop's "not a full-res source" arm was the ONLY degrade in that
  // loop with no warning — every other one calls emitFullResDegradeWarning.
  // The fence removes the way that arm was reached; this pins that it can never
  // be silent again. Source-anchored because the loop's body is unreachable
  // without a live Tauri `invoke`.
  const source = readFileSync(
    path.join(process.cwd(), 'src/features/slicing/sliceExportOrchestrator.ts'),
    'utf8',
  );
  const guardIndex = source.indexOf("if (source.kind !== 'fullres-source-file')");
  assert.notEqual(guardIndex, -1, 'the full-res candidate guard was not found — re-anchor this test');
  // Everything up to the guard's own `continue` — the whole degrade arm.
  const arm = source.slice(guardIndex, source.indexOf('continue;', guardIndex));
  assert.match(
    arm,
    /emitFullResDegradeWarning\(/,
    'the full-res candidate guard degrades with a bare `continue` and no warning '
    + '— the only silent degrade in the splice loop (D1 rider)',
  );
});
