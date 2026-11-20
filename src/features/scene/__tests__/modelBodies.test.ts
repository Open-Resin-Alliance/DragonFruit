import assert from 'node:assert/strict';
import test from 'node:test';
import * as THREE from 'three';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import type { GeometryWithBounds } from '@/hooks/useStlGeometry';
import { countTriangles } from '@/utils/geometry';
import { quaternionFromGlobalEuler } from '@/utils/rotation';
import { removeModelBodies } from '../modelBodies';
import type { LoadedModel } from '../useSceneCollectionManager';

function withBounds(geometry: THREE.BufferGeometry): GeometryWithBounds {
  geometry.computeBoundingBox();
  const bbox = geometry.boundingBox?.clone() ?? new THREE.Box3();
  return {
    geometry,
    bbox,
    center: bbox.getCenter(new THREE.Vector3()),
    size: bbox.getSize(new THREE.Vector3()),
    flatteningPlanes: [],
  };
}

/** A 2 mm cube at `x`, in the merged model's space. */
function cubeBody(x: number): GeometryWithBounds {
  return withBounds(new THREE.BoxGeometry(2, 2, 2).toNonIndexed().translate(x, 0, 1));
}

/** Three bodies side by side at x = -10, 0 and 20, as a 3MF import leaves them. */
function threeBodyModel(): LoadedModel {
  const bodies = [cubeBody(-10), cubeBody(0), cubeBody(20)];
  const merged = withBounds(mergeGeometries(bodies.map((body) => body.geometry), false)!);
  return {
    id: 'multi-body',
    name: 'Bodies.3mf',
    fileUrl: '',
    visible: true,
    color: '#3b82f6',
    polygonCount: countTriangles(merged.geometry),
    geometry: merged,
    splitBodies: bodies,
    materialProfileId: 'mat-blue',
    bodyMaterialProfileIds: ['mat-blue', 'mat-yellow', undefined],
    bodyColors: ['#3b82f6', '#eab308', undefined],
    transform: {
      position: new THREE.Vector3(50, 40, 1),
      rotation: new THREE.Euler(0, 0, Math.PI / 2),
      scale: new THREE.Vector3(2, 2, 2),
    },
  };
}

/** Where a local point of the model ends up in the world, the way the renderer draws it. */
function worldPoint(model: LoadedModel, local: THREE.Vector3): THREE.Vector3 {
  const box = model.geometry.geometry.boundingBox ?? new THREE.Box3();
  return local.clone()
    .sub(box.getCenter(new THREE.Vector3()))
    .multiply(model.transform.scale)
    .applyQuaternion(quaternionFromGlobalEuler(model.transform.rotation))
    .add(model.transform.position);
}

function assertNear(actual: THREE.Vector3, expected: THREE.Vector3, message: string) {
  assert.ok(actual.distanceTo(expected) < 1e-6, `${message}: ${actual.toArray()} vs ${expected.toArray()}`);
}

test('deleting one body keeps the model with the other bodies in place', () => {
  const model = threeBodyModel();
  const lastBodyCenter = new THREE.Vector3(20, 0, 1);
  const worldBefore = worldPoint(model, lastBodyCenter);

  const result = removeModelBodies(model, [0]);

  assert.equal(result.kind, 'updated');
  if (result.kind !== 'updated') return;
  const next = result.model;
  assert.equal(next.id, model.id);
  assert.deepEqual(next.splitBodies, [model.splitBodies![1], model.splitBodies![2]]);
  assert.deepEqual(next.bodyMaterialProfileIds, ['mat-yellow', undefined]);
  assert.deepEqual(next.bodyColors, ['#eab308', undefined]);
  assert.equal(next.polygonCount, 24);
  assert.equal(countTriangles(next.geometry.geometry), 24, 'the merged mesh holds only the remaining bodies');
  assert.equal(next.geometry.bbox.min.x, -1);
  assertNear(worldPoint(next, lastBodyCenter), worldBefore, 'a remaining body does not move');
  assert.equal(model.splitBodies?.length, 3, 'the source model is left untouched for undo');
});

test('deleting all but one body leaves a plain model in that body\'s material', () => {
  const model = threeBodyModel();
  const worldBefore = worldPoint(model, new THREE.Vector3(0, 0, 1));

  const result = removeModelBodies(model, [2, 0]);

  assert.equal(result.kind, 'updated');
  if (result.kind !== 'updated') return;
  const next = result.model;
  assert.equal(next.splitBodies, undefined);
  assert.equal(next.bodyMaterialProfileIds, undefined);
  assert.equal(next.bodyColors, undefined);
  assert.equal(next.geometry.geometry, model.splitBodies![1].geometry);
  assert.equal(next.materialProfileId, 'mat-yellow');
  assert.equal(next.color, '#eab308');
  assert.equal(next.polygonCount, 12);
  assertNear(worldPoint(next, new THREE.Vector3(0, 0, 1)), worldBefore, 'the last body does not move');
});

test('deleting every body empties the model, and stray indices change nothing', () => {
  assert.deepEqual(removeModelBodies(threeBodyModel(), [0, 1, 2]), { kind: 'emptied' });
  assert.deepEqual(removeModelBodies(threeBodyModel(), [3, -1, 1.5]), { kind: 'unchanged' });

  const plain = threeBodyModel();
  plain.splitBodies = undefined;
  assert.deepEqual(removeModelBodies(plain, [0]), { kind: 'unchanged' });
});
