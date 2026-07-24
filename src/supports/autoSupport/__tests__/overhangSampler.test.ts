import assert from 'node:assert/strict';
import test from 'node:test';
import * as THREE from 'three';
import { sampleOverhangContacts, SURFACE_FILL_VOLUME_ID } from '../overhangSampler';

function meshFromGeometry(geometry: THREE.BufferGeometry): THREE.Mesh {
  geometry.computeVertexNormals();
  const mesh = new THREE.Mesh(geometry, new THREE.MeshBasicMaterial());
  mesh.matrixAutoUpdate = false;
  mesh.updateMatrixWorld(true);
  return mesh;
}

test('samples a floating ceiling on the spacing grid', () => {
  const mesh = meshFromGeometry(new THREE.BoxGeometry(20, 20, 4).translate(0, 0, 12));

  const samples = sampleOverhangContacts({
    mesh,
    spacingMm: 5,
    maxDownNormalZ: -0.71,
    minZ: 0.1,
    maxSamples: 100,
  });

  assert.ok(samples.length >= 4, `expected a grid of samples, got ${samples.length}`);
  for (const sample of samples) {
    assert.equal(sample.volumeId, SURFACE_FILL_VOLUME_ID);
    assert.ok(Math.abs(sample.position.z - 10) < 1e-6);
  }
});

test('ignores walls, top faces, and the plate-adhesion zone', () => {
  const mesh = meshFromGeometry(new THREE.BoxGeometry(20, 20, 10).translate(0, 0, 5));

  const samples = sampleOverhangContacts({
    mesh,
    spacingMm: 5,
    maxDownNormalZ: -0.71,
    minZ: 0.1,
    maxSamples: 100,
  });

  assert.equal(samples.length, 0);
});

test('respects exclusions and the sample cap deterministically', () => {
  const mesh = meshFromGeometry(new THREE.BoxGeometry(20, 20, 4).translate(0, 0, 12));
  const base = sampleOverhangContacts({ mesh, spacingMm: 5, maxDownNormalZ: -0.71, minZ: 0.1, maxSamples: 100 });

  const excluded = sampleOverhangContacts({
    mesh,
    spacingMm: 5,
    maxDownNormalZ: -0.71,
    minZ: 0.1,
    maxSamples: 100,
    exclusions: [{ ...base[0].position, radiusMm: 100 }],
  });
  assert.equal(excluded.length, 0);

  const capped = sampleOverhangContacts({ mesh, spacingMm: 5, maxDownNormalZ: -0.71, minZ: 0.1, maxSamples: 2 });
  assert.equal(capped.length, 2);
  assert.deepEqual(capped, base.slice(0, 2));
});

test('returns nothing for a mesh without geometry', () => {
  const samples = sampleOverhangContacts({
    mesh: {} as THREE.Mesh,
    spacingMm: 5,
    maxDownNormalZ: -0.71,
    minZ: 0.1,
    maxSamples: 10,
  });
  assert.equal(samples.length, 0);
});
