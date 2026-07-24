import assert from 'node:assert/strict';
import test from 'node:test';
import * as THREE from 'three';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import type { GeometryWithBounds } from '@/hooks/useStlGeometry';
import { createIslandSupportMesh, disposeIslandSupportMesh, resolveSurfaceBelow } from '../islandSupportSurface';
import { routeStickFallback } from '../stickFallback';
import { AUTO_SUPPORT_PRESETS } from '../presets';

function overhangScene(): { geom: GeometryWithBounds; mesh: THREE.Mesh } {
  const body = new THREE.BoxGeometry(10, 10, 4);
  const overhang = new THREE.BoxGeometry(2, 2, 1).translate(0, 0, 8.5);
  const geometry = mergeGeometries([body, overhang], false)!;
  geometry.computeBoundingBox();
  geometry.computeVertexNormals();
  const bbox = geometry.boundingBox!.clone();
  const geom: GeometryWithBounds = {
    geometry,
    bbox,
    center: bbox.getCenter(new THREE.Vector3()),
    size: bbox.getSize(new THREE.Vector3()),
    flatteningPlanes: [],
  };
  const mesh = createIslandSupportMesh(geom, {
    position: new THREE.Vector3(0, 0, 0),
    rotation: new THREE.Euler(),
    scale: new THREE.Vector3(1, 1, 1),
  }, 'model-stick');
  return { geom, mesh };
}

test('finds the upward-facing surface below an overhang', () => {
  const { geom, mesh } = overhangScene();
  try {
    const below = resolveSurfaceBelow(mesh, new THREE.Vector3(0, 0, 4.5), 35);
    assert.ok(below);
    assert.ok(Math.abs(below.point.z + 1.5) < 1e-6);
    assert.ok(below.normal.z > 0.9);
  } finally {
    disposeIslandSupportMesh(mesh);
    geom.geometry.dispose();
  }
});

test('returns null when nothing lies below within range', () => {
  const { geom, mesh } = overhangScene();
  try {
    assert.equal(resolveSurfaceBelow(mesh, new THREE.Vector3(20, 20, 5), 35), null);
  } finally {
    disposeIslandSupportMesh(mesh);
    geom.geometry.dispose();
  }
});

test('routes a collision-checked stick from the overhang to the body below', async () => {
  const { geom, mesh } = overhangScene();
  try {
    const result = await routeStickFallback({
      contacts: [{ id: '1:0', volumeId: 1, position: { x: 0, y: 0, z: 4.5 } }],
      settings: AUTO_SUPPORT_PRESETS.normal,
      modelId: 'model-stick',
      mesh,
    });

    assert.equal(result.failures.length, 0);
    assert.equal(result.supports.length, 1);
    const support = result.supports[0];
    assert.equal(support.kind, 'stick');
    if (support.kind !== 'stick') return;
    const zs = [support.stick.contactConeA.pos.z, support.stick.contactConeB.pos.z].sort((a, b) => a - b);
    assert.ok(Math.abs(zs[0] + 1.5) < 0.05);
    assert.ok(Math.abs(zs[1] - 4.5) < 0.05);
    assert.equal(support.supportData.segments.length, 1);
    assert.equal(support.supportData.contactCones?.length, 2);
  } finally {
    disposeIslandSupportMesh(mesh);
    geom.geometry.dispose();
  }
});

test('detail-size overrides shape the built stick geometry', async () => {
  const { geom, mesh } = overhangScene();
  try {
    const result = await routeStickFallback({
      contacts: [{ id: '1:0', volumeId: 1, position: { x: 0, y: 0, z: 4.5 } }],
      settings: AUTO_SUPPORT_PRESETS.normal,
      modelId: 'model-detail',
      mesh,
      overrides: { shaftDiameterMm: 0.6, tipContactDiameterMm: 0.2, tipBodyDiameterMm: 0.6, tipLengthMm: 1.2 },
    });

    assert.equal(result.supports.length, 1);
    const support = result.supports[0];
    if (support.kind !== 'stick') throw new Error('expected a stick');
    assert.equal(support.stick.segments[0].diameter, 0.6);
    assert.equal(support.stick.contactConeA.profile.contactDiameterMm, 0.2);
    assert.equal(support.stick.contactConeA.profile.lengthMm, 1.2);
  } finally {
    disposeIslandSupportMesh(mesh);
    geom.geometry.dispose();
  }
});

test('plans no sticks when on-model struts are disallowed', async () => {
  const { geom, mesh } = overhangScene();
  try {
    const result = await routeStickFallback({
      contacts: [{ id: '1:0', volumeId: 1, position: { x: 0, y: 0, z: 4.5 } }],
      settings: { ...AUTO_SUPPORT_PRESETS.normal, allowOnModelStruts: false },
      modelId: 'model-no-struts',
      mesh,
    });

    assert.equal(result.supports.length, 0);
    assert.equal(result.failures.length, 1);
  } finally {
    disposeIslandSupportMesh(mesh);
    geom.geometry.dispose();
  }
});

test('skips sticks whose tip would crowd an existing support tip', async () => {
  const { geom, mesh } = overhangScene();
  try {
    const result = await routeStickFallback({
      contacts: [{ id: '1:0', volumeId: 1, position: { x: 0, y: 0, z: 4.5 } }],
      settings: AUTO_SUPPORT_PRESETS.normal,
      modelId: 'model-stick',
      mesh,
      existingTipPoints: [new THREE.Vector3(0, 0, 4.5)],
    });

    assert.equal(result.supports.length, 0);
    assert.equal(result.failures.length, 1);
    assert.equal(result.failures[0].reason, 'tip_spacing');
  } finally {
    disposeIslandSupportMesh(mesh);
    geom.geometry.dispose();
  }
});
