import assert from 'node:assert/strict';
import test from 'node:test';
import * as THREE from 'three';
import type { LoadedModel } from '@/features/scene/useSceneCollectionManager';
import { prepareLoadedModelsForOutput } from '../prepareModelGeometry';

test('classified support shells are materialized as a support-only slice model', async () => {
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.Float32BufferAttribute([
    0, 0, 0, 2, 0, 0, 0, 2, 0,
    10, 0, 0, 12, 0, 0, 10, 2, 0,
  ], 3));
  // Classification is recorded against the reordered position soup. A later
  // index must not redefine the model/support boundary.
  geometry.setIndex([3, 4, 5, 0, 1, 2]);
  geometry.computeBoundingBox();
  const bbox = geometry.boundingBox?.clone() ?? new THREE.Box3();
  const center = bbox.getCenter(new THREE.Vector3());
  const size = bbox.getSize(new THREE.Vector3());
  const source = {
    id: 'combined',
    name: 'combined.stl',
    visible: true,
    polygonCount: 2,
    geometry: {
      geometry,
      bbox,
      center,
      size,
      flatteningPlanes: [],
      meshDefects: {
        hasDefects: false,
        repairedFloats: 0,
        totalVertices: 6,
        nativeRepairReport: {
          model_triangle_count: 1,
          likely_support_geometry: false,
        },
      },
    },
    transform: {
      position: new THREE.Vector3(3, 4, 5),
      rotation: new THREE.Euler(0, 0, Math.PI / 4),
      scale: new THREE.Vector3(2, 3, 1),
    },
  } as unknown as LoadedModel;

  const prepared = await prepareLoadedModelsForOutput([source]);
  try {
    assert.equal(prepared.models.length, 2);
    const [modelPart, supportPart] = prepared.models;
    assert.equal(modelPart.polygonCount, 1);
    assert.equal(supportPart.polygonCount, 1);
    assert.equal(modelPart.geometry.geometry.getIndex(), null);
    assert.equal(supportPart.geometry.geometry.getIndex(), null);
    assert.equal(
      modelPart.polygonCount + supportPart.polygonCount,
      source.polygonCount,
    );
    assert.deepEqual(
      Array.from(modelPart.geometry.geometry.getAttribute('position').array),
      [0, 0, 0, 2, 0, 0, 0, 2, 0],
    );
    assert.deepEqual(
      Array.from(supportPart.geometry.geometry.getAttribute('position').array),
      [10, 0, 0, 12, 0, 0, 10, 2, 0],
    );
    assert.equal(
      supportPart.geometry.meshDefects?.nativeRepairReport?.likely_support_geometry,
      true,
    );
    assert.equal(
      supportPart.geometry.meshDefects?.nativeRepairReport?.model_triangle_count,
      null,
    );

    const sourceVertex = new THREE.Vector3(10, 0, 0)
      .sub(source.geometry.center)
      .multiply(source.transform.scale)
      .applyEuler(source.transform.rotation)
      .add(source.transform.position);
    const supportPosition = supportPart.geometry.geometry.getAttribute('position');
    const preparedVertex = new THREE.Vector3(
      supportPosition.getX(0),
      supportPosition.getY(0),
      supportPosition.getZ(0),
    )
      .sub(supportPart.geometry.center)
      .multiply(supportPart.transform.scale)
      .applyEuler(supportPart.transform.rotation)
      .add(supportPart.transform.position);

    assert.ok(sourceVertex.distanceTo(preparedVertex) < 1e-6);
  } finally {
    prepared.dispose();
    geometry.dispose();
  }
});
