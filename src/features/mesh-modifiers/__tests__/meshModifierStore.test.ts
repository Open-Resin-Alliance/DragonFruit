import assert from 'node:assert/strict';
import test from 'node:test';
import * as THREE from 'three';
import type { LoadedModel } from '@/features/scene/useSceneCollectionManager';
import type { ModelMeshModifiers } from '../types';
import {
  deleteStoredMeshModifiers,
  getStoredMeshModifiers,
  resolveModelMeshModifiers,
  storeModelMeshModifiers,
} from '../meshModifierStore';
import { prepareModelGeometryForOutput } from '../prepareModelGeometry';

const HOLLOWING_MODIFIERS: ModelMeshModifiers = {
  hollowing: {
    enabled: true,
    bakedIntoGeometry: false,
    mode: 'cavity',
    voxelSizeMm: 0.65,
    shellThicknessMm: 1.2,
    openFace: 'z_max',
  },
};

function makeStrippedModel(id: string): LoadedModel {
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute(
    'position',
    new THREE.Float32BufferAttribute([0, 0, 0, 10, 0, 0, 0, 10, 0], 3),
  );
  geometry.computeBoundingBox();
  const bbox = geometry.boundingBox?.clone() ?? new THREE.Box3();
  const center = bbox.getCenter(new THREE.Vector3());
  const size = bbox.getSize(new THREE.Vector3());
  return {
    id,
    name: `${id}.stl`,
    visible: true,
    polygonCount: 1,
    // Models in React state carry meshModifiers: undefined by design — the
    // externalized store is the source of truth.
    meshModifiers: undefined,
    geometry: {
      geometry,
      bbox,
      center,
      size,
      flatteningPlanes: [],
    },
    transform: {
      position: new THREE.Vector3(),
      rotation: new THREE.Euler(),
      scale: new THREE.Vector3(1, 1, 1),
    },
  } as unknown as LoadedModel;
}

test('store round-trip and resolve precedence', () => {
  const id = 'store-roundtrip-model';
  try {
    assert.equal(getStoredMeshModifiers(id), undefined);
    storeModelMeshModifiers(id, HOLLOWING_MODIFIERS);
    assert.equal(getStoredMeshModifiers(id), HOLLOWING_MODIFIERS);

    // Stripped model resolves from the store.
    assert.equal(
      resolveModelMeshModifiers({ id, meshModifiers: undefined }),
      HOLLOWING_MODIFIERS,
    );

    // A copy still attached to the model object wins over the store.
    const attached: ModelMeshModifiers = { hollowing: null };
    assert.equal(
      resolveModelMeshModifiers({ id, meshModifiers: attached }),
      attached,
    );

    // Storing null clears; delete is idempotent.
    storeModelMeshModifiers(id, null);
    assert.equal(getStoredMeshModifiers(id), undefined);
    deleteStoredMeshModifiers(id);
  } finally {
    deleteStoredMeshModifiers(id);
  }
});

// Regression test for the June 2026 externalization regression (`ecaa9186`):
// model objects carry meshModifiers: undefined, so any output path reading
// `model.meshModifiers` directly silently skips unbaked hollowing (and saved
// VOXLs lose re-editability). With modifiers resolved through the store,
// prepareModelGeometryForOutput must ATTEMPT hollowing — outside the Tauri
// desktop runtime that attempt rejects with the "DragonFruit Desktop" error,
// which is exactly the observable proof the modifiers were seen.
test('output preparation resolves unbaked hollowing from the external store', async () => {
  const id = 'stripped-hollow-model';
  const model = makeStrippedModel(id);
  try {
    storeModelMeshModifiers(id, HOLLOWING_MODIFIERS);
    await assert.rejects(
      () => prepareModelGeometryForOutput(model),
      /DragonFruit Desktop/,
      'stored (externalized) hollowing modifiers were not resolved at output time',
    );
  } finally {
    deleteStoredMeshModifiers(id);
    model.geometry.geometry.dispose();
  }
});

test('output preparation leaves unmodified models untouched', async () => {
  const id = 'plain-model';
  const model = makeStrippedModel(id);
  try {
    const prepared = await prepareModelGeometryForOutput(model);
    assert.equal(prepared.geometry, model.geometry.geometry);
    assert.equal(prepared.disposeAfterUse, false);
  } finally {
    deleteStoredMeshModifiers(id);
    model.geometry.geometry.dispose();
  }
});
