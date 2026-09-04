import assert from 'node:assert/strict';
import test from 'node:test';
import * as THREE from 'three';
import { eulerFromGlobalEuler } from '@/utils/rotation';
import type { LoadedModel } from '@/features/scene/useSceneCollectionManager';
import type { ModelTransform } from '@/hooks/useModelTransform';

function createMockModel(id: string, name: string, transform?: Partial<ModelTransform>, linkGroupId?: string): LoadedModel {
  return {
    id,
    name,
    fileUrl: `blob:${id}`,
    geometry: {
      geometry: {} as any,
      bbox: {} as any,
      center: {} as any,
      size: {} as any,
      flatteningPlanes: [],
    },
    transform: {
      position: transform?.position ?? new THREE.Vector3(0, 0, 0),
      rotation: transform?.rotation ?? eulerFromGlobalEuler({ x: 0, y: 0, z: 0 }),
      scale: transform?.scale ?? new THREE.Vector3(1, 1, 1),
    },
    visible: true,
    color: '#a3a3a3',
    polygonCount: 1000,
    linkGroupId,
  };
}

// Logic implementations under test matching useSceneCollectionManager
function applyLinkModels(models: LoadedModel[], idsToLink: string[], generatedLinkId: string): LoadedModel[] {
  const ids = new Set(idsToLink);
  if (ids.size < 2) return models;

  const targetModels = models.filter((m) => ids.has(m.id));
  if (targetModels.length < 2) return models;

  return models.map((m) => {
    if (ids.has(m.id)) {
      return { ...m, linkGroupId: generatedLinkId };
    }
    return m;
  });
}

function applyUnlinkModels(models: LoadedModel[], idsToUnlink: string[]): LoadedModel[] {
  const ids = new Set(idsToUnlink);
  if (ids.size === 0) return models;

  const targetModels = models.filter((m) => ids.has(m.id) && m.linkGroupId);
  if (targetModels.length === 0) return models;

  const affectedGroupIds = new Set(targetModels.map((m) => m.linkGroupId!));

  let nextModels = models.map((m) => {
    if (ids.has(m.id)) {
      return { ...m, linkGroupId: undefined };
    }
    return m;
  });

  affectedGroupIds.forEach((gId) => {
    const remaining = nextModels.filter((m) => m.linkGroupId === gId);
    if (remaining.length < 2) {
      nextModels = nextModels.map((m) => {
        if (m.linkGroupId === gId) {
          return { ...m, linkGroupId: undefined };
        }
        return m;
      });
    }
  });

  return nextModels;
}

function applyDeleteModelsWithDissolution(models: LoadedModel[], idsToDelete: string[]): LoadedModel[] {
  const ids = new Set(idsToDelete);
  const existing = models.filter((m) => ids.has(m.id));
  if (existing.length === 0) return models;

  const nextModelsWithoutDeleted = models.filter((m) => !ids.has(m.id));
  const deletedLinkGroupIds = new Set(existing.map((m) => m.linkGroupId).filter(Boolean) as string[]);

  let nextModels = nextModelsWithoutDeleted;
  if (deletedLinkGroupIds.size > 0) {
    deletedLinkGroupIds.forEach((gId) => {
      const remaining = nextModels.filter((m) => m.linkGroupId === gId);
      if (remaining.length < 2) {
        nextModels = nextModels.map((m) => {
          if (m.linkGroupId === gId) {
            return { ...m, linkGroupId: undefined };
          }
          return m;
        });
      }
    });
  }

  return nextModels;
}

function applySymmetricTransformUpdate(
  models: LoadedModel[],
  targetId: string,
  newTransform: ModelTransform,
): LoadedModel[] {
  const targetModel = models.find((m) => m.id === targetId);
  if (!targetModel) return models;

  const beforeTransform = targetModel.transform;
  const deltaPos = newTransform.position.clone().sub(beforeTransform.position);
  const deltaRotX = newTransform.rotation.x - beforeTransform.rotation.x;
  const deltaRotY = newTransform.rotation.y - beforeTransform.rotation.y;
  const deltaRotZ = newTransform.rotation.z - beforeTransform.rotation.z;
  const deltaScale = newTransform.scale.clone().sub(beforeTransform.scale);

  const updateMap = new Map<string, ModelTransform>();
  updateMap.set(targetId, newTransform);

  if (targetModel.linkGroupId) {
    const linkGroupId = targetModel.linkGroupId;
    const peerModels = models.filter((m) => m.linkGroupId === linkGroupId && m.id !== targetId);
    for (const peer of peerModels) {
      const peerBefore = peer.transform;
      const peerNextPos = peerBefore.position.clone().add(deltaPos);
      const peerNextRot = eulerFromGlobalEuler({
        x: peerBefore.rotation.x + deltaRotX,
        y: peerBefore.rotation.y + deltaRotY,
        z: peerBefore.rotation.z + deltaRotZ,
      });
      const peerNextScale = peerBefore.scale.clone().add(deltaScale);
      updateMap.set(peer.id, {
        position: peerNextPos,
        rotation: peerNextRot,
        scale: peerNextScale,
      });
    }
  }

  return models.map((m) => {
    const nextT = updateMap.get(m.id);
    return nextT ? { ...m, transform: nextT } : m;
  });
}

test('linkModels assigns a common linkGroupId to specified models', () => {
  const modelA = createMockModel('model-a', 'Model A');
  const modelB = createMockModel('model-b', 'Model B');
  const modelC = createMockModel('model-c', 'Model C');
  const initial = [modelA, modelB, modelC];

  const linked = applyLinkModels(initial, ['model-a', 'model-b'], 'link-group-100');

  assert.equal(linked[0].linkGroupId, 'link-group-100');
  assert.equal(linked[1].linkGroupId, 'link-group-100');
  assert.equal(linked[2].linkGroupId, undefined);
});

test('linkModels requires at least 2 models', () => {
  const modelA = createMockModel('model-a', 'Model A');
  const initial = [modelA];

  const linked = applyLinkModels(initial, ['model-a'], 'link-group-100');
  assert.equal(linked[0].linkGroupId, undefined);
});

test('unlinkModels removes linkGroupId from specified model and dissolves group if < 2 remain', () => {
  const modelA = createMockModel('model-a', 'Model A', {}, 'link-group-100');
  const modelB = createMockModel('model-b', 'Model B', {}, 'link-group-100');
  const initial = [modelA, modelB];

  // Unlinking A leaves B alone in link-group-100, which dissolves
  const unlinked = applyUnlinkModels(initial, ['model-a']);

  assert.equal(unlinked[0].linkGroupId, undefined);
  assert.equal(unlinked[1].linkGroupId, undefined);
});

test('unlinkModels keeps group active when >= 2 models remain in link group', () => {
  const modelA = createMockModel('model-a', 'Model A', {}, 'link-group-100');
  const modelB = createMockModel('model-b', 'Model B', {}, 'link-group-100');
  const modelC = createMockModel('model-c', 'Model C', {}, 'link-group-100');
  const initial = [modelA, modelB, modelC];

  // Unlinking C leaves A and B (2 models) in link-group-100
  const unlinked = applyUnlinkModels(initial, ['model-c']);

  assert.equal(unlinked[0].linkGroupId, 'link-group-100');
  assert.equal(unlinked[1].linkGroupId, 'link-group-100');
  assert.equal(unlinked[2].linkGroupId, undefined);
});

test('symmetric transform delta propagation applies position, rotation, and scale deltas to linked peer models', () => {
  const modelA = createMockModel(
    'model-a',
    'Model A',
    {
      position: new THREE.Vector3(0, 0, 0),
      rotation: eulerFromGlobalEuler({ x: 0, y: 0, z: 0 }),
      scale: new THREE.Vector3(1, 1, 1),
    },
    'link-group-200',
  );

  const modelB = createMockModel(
    'model-b',
    'Model B',
    {
      position: new THREE.Vector3(50, 20, 10),
      rotation: eulerFromGlobalEuler({ x: 0.1, y: 0, z: 0 }),
      scale: new THREE.Vector3(2, 2, 2),
    },
    'link-group-200',
  );

  const modelC = createMockModel(
    'model-c',
    'Unlinked Model C',
    {
      position: new THREE.Vector3(100, 0, 0),
    },
    undefined,
  );

  const initial = [modelA, modelB, modelC];

  const newTransformA: ModelTransform = {
    position: new THREE.Vector3(10, 5, -5),
    rotation: eulerFromGlobalEuler({ x: 0.5, y: 0.2, z: 0 }),
    scale: new THREE.Vector3(1.5, 1.5, 1.5),
  };

  const result = applySymmetricTransformUpdate(initial, 'model-a', newTransformA);

  // Model A updated
  assert.equal(result[0].transform.position.x, 10);
  assert.equal(result[0].transform.position.y, 5);
  assert.equal(result[0].transform.position.z, -5);
  assert.equal(result[0].transform.scale.x, 1.5);

  // Model B received symmetric delta:
  // pos delta: (+10, +5, -5) -> (50+10, 20+5, 10-5) = (60, 25, 5)
  // scale delta: (+0.5, +0.5, +0.5) -> (2+0.5, 2+0.5, 2+0.5) = (2.5, 2.5, 2.5)
  assert.equal(result[1].transform.position.x, 60);
  assert.equal(result[1].transform.position.y, 25);
  assert.equal(result[1].transform.position.z, 5);
  assert.equal(result[1].transform.scale.x, 2.5);

  // Model C unaffected
  assert.equal(result[2].transform.position.x, 100);
});

test('deleteModels dissolves link group when remaining peer count falls below 2', () => {
  const modelA = createMockModel('model-a', 'Model A', {}, 'link-group-300');
  const modelB = createMockModel('model-b', 'Model B', {}, 'link-group-300');
  const initial = [modelA, modelB];

  // Deleting model A leaves model B alone in link-group-300 -> dissolves group
  const afterDelete = applyDeleteModelsWithDissolution(initial, ['model-a']);

  assert.equal(afterDelete.length, 1);
  assert.equal(afterDelete[0].id, 'model-b');
  assert.equal(afterDelete[0].linkGroupId, undefined);
});

test('deleteModels retains link group when >= 2 peer models remain after deletion', () => {
  const modelA = createMockModel('model-a', 'Model A', {}, 'link-group-300');
  const modelB = createMockModel('model-b', 'Model B', {}, 'link-group-300');
  const modelC = createMockModel('model-c', 'Model C', {}, 'link-group-300');
  const initial = [modelA, modelB, modelC];

  // Deleting model A leaves B and C (2 models) in link-group-300 -> stays active
  const afterDelete = applyDeleteModelsWithDissolution(initial, ['model-a']);

  assert.equal(afterDelete.length, 2);
  assert.equal(afterDelete[0].id, 'model-b');
  assert.equal(afterDelete[0].linkGroupId, 'link-group-300');
  assert.equal(afterDelete[1].id, 'model-c');
  assert.equal(afterDelete[1].linkGroupId, 'link-group-300');
});
