import assert from 'node:assert/strict';
import test from 'node:test';
import * as THREE from 'three';

import {
  buildCenterSelectionUpdates,
  buildSelectionPositionUpdates,
  getSelectionGizmoCenter,
  getSelectionPositionOrigin,
  type SelectionPositionModel,
} from '@/features/scene/selectionPosition';
import type { GeometryWithBounds } from '@/hooks/useStlGeometry';

function model(
  id: string,
  geometry: THREE.BufferGeometry,
  position: THREE.Vector3,
  rotation = new THREE.Euler(),
  scale = new THREE.Vector3(1, 1, 1),
): SelectionPositionModel {
  geometry.computeBoundingBox();
  const boundingBox = geometry.boundingBox!.clone();

  return {
    id,
    geometry: {
      geometry,
      bbox: boundingBox,
      center: boundingBox.getCenter(new THREE.Vector3()),
      size: boundingBox.getSize(new THREE.Vector3()),
    } as GeometryWithBounds,
    transform: { position, rotation, scale },
  };
}

test('Position translates the selection by the same center used for the gizmo', () => {
  const models = [
    model('model-a', new THREE.BoxGeometry(2, 2, 2), new THREE.Vector3(4, 7, 10)),
    model('model-b', new THREE.BoxGeometry(6, 6, 6), new THREE.Vector3(14, 27, 30)),
    model('model-c', new THREE.BoxGeometry(2, 2, 2), new THREE.Vector3(40, 50, 60)),
  ];
  const targetIds = ['model-b', 'model-a'];

  const updates = buildSelectionPositionUpdates(
    models,
    targetIds,
    new THREE.Vector3(20, 25, 35),
  );

  assert.deepEqual(getSelectionPositionOrigin(models, targetIds)?.toArray(), [9, 17, 20]);
  assert.deepEqual(getSelectionGizmoCenter(
    targetIds,
    (modelId) => models.find((entry) => entry.id === modelId)?.transform.position,
  )?.toArray(), [9, 17, 20]);
  assert.deepEqual(updates.map((update) => update.id), ['model-a', 'model-b']);
  assert.deepEqual(updates[0].transform.position.toArray(), [15, 15, 25]);
  assert.deepEqual(updates[1].transform.position.toArray(), [25, 35, 45]);

  const updatedModels = models.map((entry) => {
    const update = updates.find((candidate) => candidate.id === entry.id);
    return update ? { ...entry, transform: update.transform } : entry;
  });
  const nextUpdates = buildSelectionPositionUpdates(updatedModels, targetIds, new THREE.Vector3(21, 25, 35));
  assert.deepEqual(nextUpdates[0].transform.position.toArray(), [16, 15, 25]);
  assert.deepEqual(nextUpdates[1].transform.position.toArray(), [26, 35, 45]);
});

test('Center moves the gizmo center to the plate center as one set', () => {
  const models = [
    model('model-a', new THREE.BoxGeometry(2, 4, 6), new THREE.Vector3(5, 10, 8)),
    model(
      'model-b',
      new THREE.BoxGeometry(8, 2, 4),
      new THREE.Vector3(20, 30, 12),
      new THREE.Euler(0, 0, Math.PI / 4),
      new THREE.Vector3(1.5, 1, 2),
    ),
  ];
  const originalOffset = models[1].transform.position.clone().sub(models[0].transform.position);
  const targetCenter = new THREE.Vector2(96, 60);

  const updates = buildCenterSelectionUpdates(models, ['model-a', 'model-b'], targetCenter);
  updates.forEach((update, index) => {
    assert.equal(update.transform.position.z, models[index].transform.position.z);
    assert.ok(update.transform.rotation.equals(models[index].transform.rotation));
    assert.ok(update.transform.scale.equals(models[index].transform.scale));
  });

  const centeredModels = models.map((entry, index) => ({ ...entry, transform: updates[index].transform }));
  const centered = getSelectionPositionOrigin(centeredModels, ['model-a', 'model-b'])!;
  assert.ok(Math.abs(centered.x - targetCenter.x) < 1e-6);
  assert.ok(Math.abs(centered.y - targetCenter.y) < 1e-6);
  assert.ok(
    updates[1].transform.position.clone().sub(updates[0].transform.position).distanceTo(originalOffset) < 1e-6,
  );
});

test('Center preserves single-model pivot centering behavior', () => {
  const models = [
    model(
      'model-a',
      new THREE.BoxGeometry(2, 4, 6),
      new THREE.Vector3(5, 10, 8),
      new THREE.Euler(0, 0, Math.PI / 4),
    ),
  ];

  const updates = buildCenterSelectionUpdates(models, ['model-a'], new THREE.Vector2(96, 60));

  assert.deepEqual(updates[0].transform.position.toArray(), [96, 60, 8]);
});