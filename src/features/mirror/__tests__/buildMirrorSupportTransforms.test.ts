import assert from 'node:assert/strict';
import test from 'node:test';
import * as THREE from 'three';

import {
  buildMirrorSupportTransforms,
  reflectTransformAcrossWorldAxis,
} from '../logic/buildMirrorSupportTransforms';
import { computePreciseModelWorldBounds } from '@/utils/modelBounds';
import { quaternionFromGlobalEuler } from '@/utils/rotation';

function identityTransform() {
  return {
    position: new THREE.Vector3(0, 0, 0),
    rotation: new THREE.Euler(0, 0, 0, 'ZYX'),
    scale: new THREE.Vector3(1, 1, 1),
  };
}

function applyTransform(point: THREE.Vector3, t: ReturnType<typeof identityTransform>) {
  const m = new THREE.Matrix4().compose(
    t.position.clone(),
    quaternionFromGlobalEuler(t.rotation),
    t.scale.clone(),
  );
  return point.clone().applyMatrix4(m);
}

test('buildMirrorSupportTransforms returns null for axis z', () => {
  const result = buildMirrorSupportTransforms({
    current: identityTransform(),
    modelLocalBboxCenter: new THREE.Vector3(0, 0, 0),
    axis: 'z',
  });
  assert.equal(result, null);
});

test('buildMirrorSupportTransforms reflects an arbitrary world point through bbox center on X', () => {
  const current = identityTransform();
  current.position.set(10, 0, 0);
  const localCenter = new THREE.Vector3(0, 0, 0);
  const pivotWorld = applyTransform(localCenter, current);

  const result = buildMirrorSupportTransforms({
    current,
    modelLocalBboxCenter: localCenter,
    axis: 'x',
  })!;
  assert.ok(result);

  const sample = new THREE.Vector3(3, 4, 5);
  const beforeWorld = applyTransform(sample, result.before);
  const afterWorld = applyTransform(sample, result.after);

  assert.ok(Math.abs(afterWorld.x - (2 * pivotWorld.x - beforeWorld.x)) < 1e-5);
  assert.ok(Math.abs(afterWorld.y - beforeWorld.y) < 1e-5);
  assert.ok(Math.abs(afterWorld.z - beforeWorld.z) < 1e-5);
});

test('buildMirrorSupportTransforms reflects on Y', () => {
  const current = identityTransform();
  current.position.set(0, 7, 0);

  const result = buildMirrorSupportTransforms({
    current,
    modelLocalBboxCenter: new THREE.Vector3(0, 0, 0),
    axis: 'y',
  })!;
  const pivot = applyTransform(new THREE.Vector3(0, 0, 0), current);

  const sample = new THREE.Vector3(2, 3, 4);
  const before = applyTransform(sample, result.before);
  const after = applyTransform(sample, result.after);
  assert.ok(Math.abs(after.x - before.x) < 1e-5);
  assert.ok(Math.abs(after.y - (2 * pivot.y - before.y)) < 1e-5);
  assert.ok(Math.abs(after.z - before.z) < 1e-5);
});

test('buildMirrorSupportTransforms preserves bbox center under mirror', () => {
  const current = identityTransform();
  current.position.set(5, -3, 2);
  current.rotation.set(0, 0, Math.PI / 6, 'ZYX');
  const localCenter = new THREE.Vector3(1, 1, 1);
  const pivotWorld = applyTransform(localCenter, current);

  const result = buildMirrorSupportTransforms({
    current,
    modelLocalBboxCenter: localCenter,
    axis: 'x',
  })!;

  const pivotAfter = applyTransform(localCenter, result.after);
  assert.ok(Math.abs(pivotAfter.x - pivotWorld.x) < 1e-5);
  assert.ok(Math.abs(pivotAfter.y - pivotWorld.y) < 1e-5);
  assert.ok(Math.abs(pivotAfter.z - pivotWorld.z) < 1e-5);
});

test('worldPivotOverride keeps exact [minZ, maxZ] and X/Y support alignment on tilted asymmetric meshes', () => {
  // Asymmetric tetrahedron whose local bbox center (5,5,5) leaves rotated vertices
  // asymmetric around transform.position.
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.BufferAttribute(new Float32Array([
    0, 0, 0,
    10, 0, 0,
    0, 10, 0,
    0, 0, 10,
  ]), 3));
  geometry.computeBoundingBox();
  const bbox = geometry.boundingBox!.clone();
  const center = bbox.getCenter(new THREE.Vector3());
  const geometryData = { geometry, bbox, center };

  const current = identityTransform();
  current.position.set(12, -4, 10);
  current.rotation.set(0.7, 0.4, 0.2, 'ZYX');

  const beforeBounds = computePreciseModelWorldBounds(geometryData, current);
  const worldPivot = beforeBounds.getCenter(new THREE.Vector3());
  assert.ok(
    Math.abs(worldPivot.z - current.position.z) > 0.5,
    'tilted asymmetric mesh must have tight world Z midpoint distinct from transform.position.z',
  );

  // Without worldPivotOverride, reflecting through local-bbox center (0,0,0) shifts minZ.
  const localOrigin = new THREE.Vector3(0, 0, 0);
  const defaultZAfter = reflectTransformAcrossWorldAxis(current, localOrigin, 'z');
  const defaultZBounds = computePreciseModelWorldBounds(geometryData, defaultZAfter);
  assert.ok(
    Math.abs(defaultZBounds.min.z - beforeBounds.min.z) > 0.5,
    'default local-bbox pivot shifts minZ on tilted asymmetric Z-mirror',
  );

  // With worldPivotOverride, Z-mirror preserves exact [minZ, maxZ].
  const reflectWithOverride = reflectTransformAcrossWorldAxis as (
    c: ReturnType<typeof identityTransform>,
    l: THREE.Vector3,
    a: 'x' | 'y' | 'z',
    worldPivotOverride?: THREE.Vector3,
  ) => ReturnType<typeof identityTransform>;
  const buildWithOverride = buildMirrorSupportTransforms as (args: {
    current: ReturnType<typeof identityTransform>;
    modelLocalBboxCenter: THREE.Vector3;
    axis: 'x' | 'y' | 'z';
    worldPivotOverride?: THREE.Vector3;
  }) => ReturnType<typeof buildMirrorSupportTransforms>;

  const preciseZAfter = reflectWithOverride(current, localOrigin, 'z', worldPivot);
  const preciseZBounds = computePreciseModelWorldBounds(geometryData, preciseZAfter);
  assert.ok(Math.abs(preciseZBounds.min.z - beforeBounds.min.z) < 1e-5, `minZ preserved: ${preciseZBounds.min.z} vs ${beforeBounds.min.z}`);
  assert.ok(Math.abs(preciseZBounds.max.z - beforeBounds.max.z) < 1e-5, `maxZ preserved: ${preciseZBounds.max.z} vs ${beforeBounds.max.z}`);

  // On X-mirror with worldPivotOverride, model and attached supports reflect around the same tight world pivot.
  const preciseXModelAfter = reflectWithOverride(current, localOrigin, 'x', worldPivot);
  const supportTransforms = buildWithOverride({
    current,
    modelLocalBboxCenter: localOrigin,
    axis: 'x',
    worldPivotOverride: worldPivot,
  })!;
  assert.ok(supportTransforms);

  const sampleCenteredVertex = new THREE.Vector3(10, 0, 0).sub(center);
  const beforeSupportWorld = applyTransform(sampleCenteredVertex, supportTransforms.before);
  const afterSupportWorld = applyTransform(sampleCenteredVertex, supportTransforms.after);
  const afterModelWorld = applyTransform(sampleCenteredVertex, preciseXModelAfter);

  assert.ok(afterSupportWorld.distanceTo(afterModelWorld) < 1e-5, 'support stays aligned with reflected model vertex');
  assert.ok(
    Math.abs(afterSupportWorld.x - (2 * worldPivot.x - beforeSupportWorld.x)) < 1e-5,
    `support reflected across tight worldPivot.x (${worldPivot.x}), got ${afterSupportWorld.x}`,
  );
});
