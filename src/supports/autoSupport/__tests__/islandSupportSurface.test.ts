import assert from 'node:assert/strict';
import test from 'node:test';
import * as THREE from 'three';
import type { GeometryWithBounds } from '@/hooks/useStlGeometry';
import {
  createIslandSupportMesh,
  disposeIslandSupportMesh,
  resolveIslandSupportSurface,
  resolveIslandSupportSurfaces,
} from '../islandSupportSurface';
import type { DetectedIsland } from '@/volumeAnalysis/Islands/types';

function geometryWithBounds(geometry: THREE.BufferGeometry): GeometryWithBounds {
  geometry.computeBoundingBox();
  geometry.computeVertexNormals();
  const bbox = geometry.boundingBox!.clone();
  return {
    geometry,
    bbox,
    center: bbox.getCenter(new THREE.Vector3()),
    size: bbox.getSize(new THREE.Vector3()),
    flatteningPlanes: [],
  };
}

test('resolves the downward surface at an island contact', () => {
  const geom = geometryWithBounds(new THREE.BoxGeometry(2, 2, 2));
  const mesh = createIslandSupportMesh(geom, {
    position: new THREE.Vector3(10, 20, 5),
    rotation: new THREE.Euler(),
    scale: new THREE.Vector3(1, 1, 1),
  }, 'model-1');

  try {
    const surface = resolveIslandSupportSurface(mesh, new THREE.Vector3(10, 20, 4));
    assert.ok(surface);
    assert.ok(surface.point.distanceTo(new THREE.Vector3(10, 20, 4)) < 1e-6);
    assert.ok(surface.normal.distanceTo(new THREE.Vector3(0, 0, -1)) < 1e-6);
  } finally {
    disposeIslandSupportMesh(mesh);
    geom.geometry.dispose();
  }
});

test('matches the rendered center offset for non-origin geometry', () => {
  const geometry = new THREE.BoxGeometry(2, 2, 2).translate(7, -3, 11);
  const geom = geometryWithBounds(geometry);
  const mesh = createIslandSupportMesh(geom, {
    position: new THREE.Vector3(4, 6, 8),
    rotation: new THREE.Euler(),
    scale: new THREE.Vector3(2, 1, 0.5),
  }, 'model-2');

  try {
    const surface = resolveIslandSupportSurface(mesh, new THREE.Vector3(4, 6, 7.5));
    assert.ok(surface);
    assert.ok(surface.point.distanceTo(new THREE.Vector3(4, 6, 7.5)) < 1e-6);
  } finally {
    disposeIslandSupportMesh(mesh);
    geom.geometry.dispose();
  }
});

test('returns null when no underside is near the contact', () => {
  const geom = geometryWithBounds(new THREE.BoxGeometry(2, 2, 2));
  const mesh = createIslandSupportMesh(geom, {
    position: new THREE.Vector3(),
    rotation: new THREE.Euler(),
    scale: new THREE.Vector3(1, 1, 1),
  }, 'model-3');

  try {
    assert.equal(resolveIslandSupportSurface(mesh, new THREE.Vector3(20, 20, 20)), null);
  } finally {
    disposeIslandSupportMesh(mesh);
    geom.geometry.dispose();
  }
});

test('resolves distinct support surfaces across an island footprint', () => {
  const geom = geometryWithBounds(new THREE.BoxGeometry(4, 4, 2));
  const mesh = createIslandSupportMesh(geom, {
    position: new THREE.Vector3(0, 0, 2),
    rotation: new THREE.Euler(),
    scale: new THREE.Vector3(1, 1, 1),
  }, 'model-4');
  const island: DetectedIsland = {
    id: 'v4',
    source: 'voxel',
    contact: new THREE.Vector3(0, 0, 1),
    baseZ: 1,
    contactVoxels: [
      { x: -1, y: 0 },
      { x: 1, y: 0 },
      { x: 0, y: -1 },
      { x: 0, y: 1 },
    ],
  };

  try {
    const surfaces = resolveIslandSupportSurfaces(mesh, island);
    assert.equal(surfaces.length, 10);
  } finally {
    disposeIslandSupportMesh(mesh);
    geom.geometry.dispose();
  }
});

test('samples nearby surfaces when an island has no voxel footprint', () => {
  const geom = geometryWithBounds(new THREE.BoxGeometry(4, 4, 2));
  const mesh = createIslandSupportMesh(geom, {
    position: new THREE.Vector3(0, 0, 2),
    rotation: new THREE.Euler(),
    scale: new THREE.Vector3(1, 1, 1),
  }, 'model-5');
  const island: DetectedIsland = {
    id: 'm5',
    source: 'minima',
    contact: new THREE.Vector3(0, 0, 1),
    baseZ: 1,
  };

  try {
    const surfaces = resolveIslandSupportSurfaces(mesh, island);
    assert.equal(surfaces.length, 10);
  } finally {
    disposeIslandSupportMesh(mesh);
    geom.geometry.dispose();
  }
});
