import assert from 'node:assert/strict';
import test from 'node:test';
import * as THREE from 'three';

import type { GeometryWithBounds } from '@/hooks/useStlGeometry';
import {
  buildLiftDropUpdates,
  getModelLowestWorldZ,
  alignModelToLift,
  isModelAutoLifted,
  PLATE_CLEARANCE_MM,
  preserveModelBottom,
  type LiftDropModel,
} from '@/features/scene/selectionLiftDrop';

function model(
  id: string,
  geometry: THREE.BufferGeometry,
  position: THREE.Vector3,
  rotation = new THREE.Euler(),
  scale = new THREE.Vector3(1, 1, 1),
): LiftDropModel {
  geometry.computeBoundingBox();
  const boundingBox = geometry.boundingBox!.clone();

  return {
    id,
    geometry: {
      geometry,
      bbox: boundingBox,
      size: boundingBox.getSize(new THREE.Vector3()),
    } as GeometryWithBounds,
    transform: { position, rotation, scale },
  };
}

test('Lift places each selected model bottom independently at the requested distance', () => {
  const models = [
    model('model-a', new THREE.BoxGeometry(2, 4, 6), new THREE.Vector3(3, 4, 10)),
    model(
      'model-b',
      new THREE.BoxGeometry(2, 4, 6),
      new THREE.Vector3(-5, 7, 20),
      new THREE.Euler(Math.PI / 2, 0, 0),
      new THREE.Vector3(1, 2, 1),
    ),
  ];

  const updates = buildLiftDropUpdates(models, ['model-b', 'model-a'], 5);

  assert.deepEqual(updates.map((update) => update.id), ['model-a', 'model-b']);
  updates.forEach((update, index) => {
    assert.ok(Math.abs(getModelLowestWorldZ({ ...models[index], transform: update.transform }) - 5) < 1e-6);
    assert.equal(update.transform.position.x, models[index].transform.position.x);
    assert.equal(update.transform.position.y, models[index].transform.position.y);
  });
  assert.notEqual(updates[0].transform.position.z, updates[1].transform.position.z);
});

test('Drop places every selected bottom at zero and skips unselected models', () => {
  const models = [
    model('model-a', new THREE.BoxGeometry(4, 4, 4), new THREE.Vector3(0, 0, 15)),
    model('model-b', new THREE.BoxGeometry(4, 4, 4), new THREE.Vector3(8, 0, 25)),
    model('model-c', new THREE.BoxGeometry(4, 4, 4), new THREE.Vector3(16, 0, 35)),
  ];

  const updates = buildLiftDropUpdates(models, ['model-a', 'model-c'], 0);

  assert.deepEqual(updates.map((update) => update.id), ['model-a', 'model-c']);
  assert.ok(Math.abs(getModelLowestWorldZ({ ...models[0], transform: updates[0].transform })) < 1e-6);
  assert.ok(Math.abs(getModelLowestWorldZ({ ...models[2], transform: updates[1].transform })) < 1e-6);
});

function renderedBottom(source: LiftDropModel, transform = source.transform): number {
  const group = new THREE.Group();
  group.position.copy(transform.position);
  group.rotation.set(transform.rotation.x, transform.rotation.y, transform.rotation.z, 'ZYX');
  group.scale.copy(transform.scale);
  const mesh = new THREE.Mesh(source.geometry.geometry);
  mesh.position.copy(source.geometry.bbox.getCenter(new THREE.Vector3())).negate();
  group.add(mesh);
  return new THREE.Box3().setFromObject(group, true).min.z;
}

test('Scaling up and down keeps plate, raised, and lowered mesh bottoms fixed by moving the centre', () => {
  for (const bottom of [0, 7, -3]) {
    const source = model('mesh', new THREE.BoxGeometry(12, 8, 20), new THREE.Vector3(3, 4, bottom + 10));
    for (const factor of [0.25, 2]) {
      const candidate = { ...source.transform, scale: new THREE.Vector3(factor, factor, factor) };
      const next = preserveModelBottom(source, candidate);
      assert.ok(Math.abs(renderedBottom(source, next) - bottom) < 1e-6);
      assert.equal(next.position.z, bottom + 10 * factor);
      assert.equal(next.position.x, 3);
      assert.equal(next.position.y, 4);
      assert.deepEqual(source.transform.position.toArray(), [3, 4, bottom + 10]);
      assert.deepEqual(candidate.position.toArray(), [3, 4, bottom + 10]);
    }
  }
});

test('Axis scaling of a tilted off-centre irregular mesh anchors actual vertices, not box corners', () => {
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.Float32BufferAttribute([
    2, 4, 6, 14, 4, 6, 2, 12, 6, 2, 4, 26,
  ], 3));
  const source = model('tilted', geometry, new THREE.Vector3(5, -8, 35),
    new THREE.Euler(0.7, -0.4, 0.3, 'ZYX'), new THREE.Vector3(-1, 2, 0.6));
  const bottom = renderedBottom(source);
  for (const axis of [0, 1, 2]) {
    for (const factor of [0.2, 3]) {
      const scale = source.transform.scale.clone();
      scale.setComponent(axis, scale.getComponent(axis) * factor);
      const next = preserveModelBottom(source, { ...source.transform, scale });
      assert.ok(Math.abs(renderedBottom(source, next) - bottom) < 1e-6);
      assert.deepEqual(next.scale.toArray(), scale.toArray());
      assert.deepEqual(next.rotation.toArray(), source.transform.rotation.toArray());
    }
  }
});

test('Group scaling keeps each bottom independently while retaining horizontal spacing changes', () => {
  const sources = [
    model('a', new THREE.BoxGeometry(4, 6, 10), new THREE.Vector3(-10, 2, 5)),
    model('b', new THREE.BoxGeometry(8, 2, 4), new THREE.Vector3(10, -2, 14)),
  ];
  for (const source of sources) {
    const candidate = {
      ...source.transform,
      position: source.transform.position.clone().multiplyScalar(2),
      scale: source.transform.scale.clone().multiplyScalar(2),
    };
    const next = preserveModelBottom(source, candidate);
    assert.ok(Math.abs(renderedBottom(source, next) - renderedBottom(source)) < 1e-6);
    assert.equal(next.position.x, candidate.position.x);
    assert.equal(next.position.y, candidate.position.y);
  }
});

test('Resetting scale and repeated live edits return to the original anchored transform without drift', () => {
  const source = model('mesh', new THREE.BoxGeometry(4, 6, 10), new THREE.Vector3(2, 3, 21),
    new THREE.Euler(0.4, 0.6, -0.2, 'ZYX'), new THREE.Vector3(2, 0.5, 3));
  const bottom = renderedBottom(source);
  let next = source.transform;
  for (const factor of [2, 0.4, 3, 0.2, 1]) {
    next = preserveModelBottom(source, {
      ...next,
      scale: source.transform.scale.clone().multiplyScalar(factor),
    });
    assert.ok(Math.abs(renderedBottom(source, next) - bottom) < 1e-6);
  }
  assert.ok(next.position.distanceTo(source.transform.position) < 1e-6);
  const reset = preserveModelBottom(source, { ...source.transform, scale: new THREE.Vector3(1, 1, 1) });
  assert.ok(Math.abs(renderedBottom(source, reset) - bottom) < 1e-6);
  assert.deepEqual(reset.scale.toArray(), [1, 1, 1]);
});

test('A rotation holds each model at its own bottom, lifted or on the plate', () => {
  const lifted = { ...model('lifted', new THREE.BoxGeometry(4, 6, 8), new THREE.Vector3(0, 0, 15)), autoLift: true };
  const plate = model('plate', new THREE.BoxGeometry(4, 6, 8), new THREE.Vector3(20, 0, 4));
  assert.equal(isModelAutoLifted(lifted), true);
  assert.equal(isModelAutoLifted(plate), false);

  const rotation = new THREE.Euler(0.6, -0.3, 0.4, 'ZYX');
  for (const source of [lifted, plate]) {
    const next = preserveModelBottom(source, { ...source.transform, rotation });
    assert.ok(Math.abs(renderedBottom(source, next) - renderedBottom(source)) < 1e-6);
  }
});

test('An auto-lifted model is seated at the lift distance, a manual one keeps its own bottom', () => {
  const rotation = new THREE.Euler(0.6, -0.3, 0.4, 'ZYX');
  const auto = { ...model('auto', new THREE.BoxGeometry(4, 6, 8), new THREE.Vector3(0, 0, 15)), autoLift: true };
  const manual = model('manual', new THREE.BoxGeometry(4, 6, 8), new THREE.Vector3(20, 0, 15));
  const manualBottom = renderedBottom(manual);

  const autoNext = alignModelToLift(auto, { ...auto.transform, rotation }, 5);
  const manualNext = alignModelToLift(manual, { ...manual.transform, rotation }, 5);

  assert.ok(Math.abs(renderedBottom(auto, autoNext) - 5) < 1e-6);
  assert.ok(Math.abs(renderedBottom(manual, manualNext) - manualBottom) < 1e-6);
});

test('A drop seats the model on the plate and clears the auto-lift mode', () => {
  const source = { ...model('mesh', new THREE.BoxGeometry(4, 6, 8), new THREE.Vector3(0, 0, 15)), autoLift: true };
  const [update] = buildLiftDropUpdates([source], [source.id], PLATE_CLEARANCE_MM);
  const dropped = { ...source, transform: update.transform, autoLift: false };
  assert.ok(Math.abs(getModelLowestWorldZ(dropped) - PLATE_CLEARANCE_MM) < 1e-6);
  assert.equal(isModelAutoLifted(dropped), false);
});