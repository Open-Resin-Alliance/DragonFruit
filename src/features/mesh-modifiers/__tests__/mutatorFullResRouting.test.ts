import assert from 'node:assert/strict';
import test from 'node:test';
import * as THREE from 'three';
import type { LoadedModel } from '@/features/scene/useSceneCollectionManager';
import { resolveFullResSourceForModel } from '../prepareModelGeometry';
import { planMutatorFullResStaging } from '@/utils/fullResMutatorStaging';

/**
 * P4 CP1 — the permanent-mutator full-res routing contract (STL import
 * decimation remediation, plan Phase 4; docs in
 * `agents/Claude/STL-import-perf/`).
 *
 * CONTRACT: the three permanent mutators — hollowing apply/preview,
 * manual repair-in-place, hole-punch apply — PERMANENTLY replace the scene
 * geometry with an output built from whatever they stage. For a native-preview
 * (`geometry.nativePreview`) model that scene geometry is a ~2M decimated
 * preview, so mutating it bakes the decimation into the model forever. Phase 4
 * routes such models through the Rust-side full-res splice
 * (`stage_fullres_mesh_into_staged`) BEFORE the mutator's Rust op reads the
 * staging buffer — so the op consumes full resolution and the full-res bytes
 * never enter the WebView (plan §C.2).
 *
 * SEAM: `planMutatorFullResStaging(model)` (utils/fullResMutatorStaging.ts) is
 * the routing oracle every mutator now consults, built on
 * `resolveFullResSourceForModel` (the P1 resolver core, minus the slice-time
 * unbaked-hollowing carve-out that must NOT apply to a mutator whose Apply IS
 * the bake). RED before P4: the mutators unconditionally staged
 * `model.geometry.geometry` (the ~2M preview) — no routing existed.
 */

function buildNativePreviewMockModel(): { model: LoadedModel; previewGeometry: THREE.BufferGeometry } {
  const previewGeometry = new THREE.BufferGeometry();
  previewGeometry.setAttribute('position', new THREE.Float32BufferAttribute([
    0, 0, 0, 2, 0, 0, 0, 2, 0,
    0, 0, 1, 2, 0, 1, 0, 2, 1,
  ], 3));
  previewGeometry.computeBoundingBox();
  const bbox = previewGeometry.boundingBox?.clone() ?? new THREE.Box3();
  const center = bbox.getCenter(new THREE.Vector3());
  const size = bbox.getSize(new THREE.Vector3());

  const model = {
    id: 'preview-plate',
    name: 'pre-supported-plate-12m.stl',
    fileUrl: '',
    sourcePath: 'X:/fixtures/pre-supported-plate-12m.stl',
    visible: true,
    color: '#ffffff',
    polygonCount: 12_000_000,
    geometry: {
      geometry: previewGeometry,
      bbox,
      center,
      size,
      flatteningPlanes: [],
      nativePreview: {
        originalTriangleCount: 12_000_000,
        previewTriangleCount: 2,
        // The stored import-time pre-centering bbox center (raw-file frame) —
        // the local mutator frame v_raw − C_pre depends on it.
        cPre: [100, 85, 2.88] as [number, number, number],
        sourceFingerprint: { sizeBytes: 600_000_084, mtimeMs: 1_700_000_000_000 },
      },
    },
    transform: {
      position: new THREE.Vector3(10, -4, 2.5),
      rotation: new THREE.Euler(0, 0, Math.PI / 6),
      scale: new THREE.Vector3(1.25, 1, 0.8),
    },
  } as unknown as LoadedModel;

  return { model, previewGeometry };
}

test('P4 CP1: a native-preview model routes a mutator to the full-res ORIGINAL, not the preview', () => {
  const { model, previewGeometry } = buildNativePreviewMockModel();
  try {
    const plan = planMutatorFullResStaging(model);
    assert.ok(plan, 'the mutator must route a native-preview model to full resolution');
    assert.equal(
      plan.sourcePath,
      model.sourcePath,
      'the mutator staging source must be the ORIGINAL file, never the ~2M preview',
    );
    // The mutators stage un-transformed local geometry, so the reprojection
    // datum is the LOCAL centering vector T_center = C_pre − geometry.center,
    // NOT C_pre (which would jump the mesh up in Y by half its height).
    // Mock: C_pre = [100, 85, 2.88], preview bbox center = [1, 1, 0.5].
    assert.deepEqual(
      plan.localCenteringVector,
      [100 - 1, 85 - 1, 2.88 - 0.5],
      'the mutator frame datum must be T_center = C_pre − model.geometry.center',
    );
    assert.equal(plan.originalTriangleCount, 12_000_000);
    assert.equal(plan.fingerprint?.sizeBytes, 600_000_084);
  } finally {
    previewGeometry.dispose();
  }
});

test('P4 CP1: a native-preview model WITHOUT a stored cPre degrades to the preview (never guess a frame)', () => {
  const { model, previewGeometry } = buildNativePreviewMockModel();
  try {
    delete (model.geometry.nativePreview as { cPre?: unknown }).cPre;
    // The core resolver still reports full-res-eligible (cPre null)…
    const core = resolveFullResSourceForModel(model);
    assert.equal(core?.kind, 'fullres-source-file');
    assert.equal(core?.cPre, null);
    // …but the mutator planner refuses full-res without a frame datum.
    assert.equal(
      planMutatorFullResStaging(model),
      null,
      'the local mutator frame cannot be reproduced without C_pre — stage the preview',
    );
  } finally {
    previewGeometry.dispose();
  }
});

test('golden: a non-preview model never routes to full-res (byte-identical preview path preserved)', () => {
  const { model, previewGeometry } = buildNativePreviewMockModel();
  try {
    delete (model.geometry as { nativePreview?: unknown }).nativePreview;
    assert.equal(resolveFullResSourceForModel(model), null);
    assert.equal(planMutatorFullResStaging(model), null);
  } finally {
    previewGeometry.dispose();
  }
});

test('a native-preview model with no retained sourcePath cannot full-res', () => {
  const { model, previewGeometry } = buildNativePreviewMockModel();
  try {
    (model as { sourcePath?: string }).sourcePath = undefined;
    assert.equal(resolveFullResSourceForModel(model), null);
    assert.equal(planMutatorFullResStaging(model), null);
  } finally {
    previewGeometry.dispose();
  }
});
