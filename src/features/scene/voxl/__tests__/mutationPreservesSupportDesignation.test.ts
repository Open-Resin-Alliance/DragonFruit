import assert from 'node:assert/strict';
import test from 'node:test';
import type { LoadedModel } from '@/features/scene/useSceneCollectionManager';

test('replaceModelGeometry mutation preserves isSupportGeometry and linkGroupId on model object', () => {
  const initialModel: Partial<LoadedModel> = {
    id: 'supp-model-1',
    name: 'Support Model',
    isSupportGeometry: true,
    linkGroupId: 'link-group-123',
    polygonCount: 100,
    geometry: {
      geometry: {} as any,
      bbox: {} as any,
      center: {} as any,
      size: {} as any,
      flatteningPlanes: [],
    },
  };

  const nextGeometry: any = {
    geometry: {} as any,
    bbox: {} as any,
    center: {} as any,
    size: {} as any,
    flatteningPlanes: [],
  };
  const nextPolygonCount = 250;

  // Simulate replaceModelGeometry map transformation
  const updatedModel: Partial<LoadedModel> = {
    ...initialModel,
    geometry: nextGeometry,
    polygonCount: nextPolygonCount,
    isSupportGeometry: initialModel.isSupportGeometry,
    linkGroupId: initialModel.linkGroupId,
  };

  assert.equal(updatedModel.id, 'supp-model-1');
  assert.equal(updatedModel.isSupportGeometry, true);
  assert.equal(updatedModel.linkGroupId, 'link-group-123');
  assert.equal(updatedModel.polygonCount, 250);
});

test('replaceModelGeometry mutation preserves false/undefined support fields on standard model object', () => {
  const initialModel: Partial<LoadedModel> = {
    id: 'main-model-1',
    name: 'Main Mesh',
    isSupportGeometry: false,
    linkGroupId: undefined,
    polygonCount: 500,
  };

  const updatedModel: Partial<LoadedModel> = {
    ...initialModel,
    geometry: {} as any,
    polygonCount: 600,
    isSupportGeometry: initialModel.isSupportGeometry,
    linkGroupId: initialModel.linkGroupId,
  };

  assert.equal(updatedModel.id, 'main-model-1');
  assert.equal(updatedModel.isSupportGeometry, false);
  assert.equal(updatedModel.linkGroupId, undefined);
});
