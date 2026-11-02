import assert from 'node:assert/strict';
import test from 'node:test';
import * as THREE from 'three';
import type { LoadedModel } from '@/features/scene/useSceneCollectionManager';
import type { MaterialProfile, PrinterProfile } from '@/features/profiles/profileStore';
import type { GeometryWithBounds } from '@/hooks/useStlGeometry';
import { buildSolidSliceMeshForWasm } from '../rasterLayerZipExport';

function triangleGeometry(offsetX: number): GeometryWithBounds {
  const positions = new Float32Array([
    offsetX, 0, 0,
    offsetX + 1, 0, 0,
    offsetX, 1, 0,
  ]);
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.BufferAttribute(positions, 3));
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

function multiBodyModel(): LoadedModel {
  const merged = triangleGeometry(0);
  merged.geometry = new THREE.BufferGeometry();
  const positions = new Float32Array([
    0, 0, 0, 1, 0, 0, 0, 1, 0,
    5, 0, 0, 6, 0, 0, 5, 1, 0,
  ]);
  merged.geometry.setAttribute('position', new THREE.BufferAttribute(positions, 3));
  merged.geometry.computeBoundingBox();
  merged.bbox = merged.geometry.boundingBox?.clone() ?? new THREE.Box3();
  merged.center = merged.bbox.getCenter(new THREE.Vector3());
  merged.size = merged.bbox.getSize(new THREE.Vector3());

  return {
    id: 'multi-body',
    name: 'MultiBodyTest.3mf',
    fileUrl: '',
    visible: true,
    color: '#3b82f6',
    polygonCount: 2,
    geometry: merged,
    splitBodies: [triangleGeometry(0), triangleGeometry(5)],
    bodyMaterialProfileIds: ['mat-blue', 'mat-yellow'],
    bodyColors: ['#3b82f6', '#eab308'],
    materialProfileId: 'mat-blue',
    transform: {
      position: new THREE.Vector3(0, 0, 0),
      rotation: new THREE.Euler(0, 0, 0),
      scale: new THREE.Vector3(1, 1, 1),
    },
  } as LoadedModel;
}

const materialProfile = {
  id: 'mat-blue',
  name: 'Blue Resin',
  layerHeightMm: 0.05,
} as MaterialProfile;

function printer(overrides: Partial<PrinterProfile>): PrinterProfile {
  return {
    id: 'test-printer',
    name: 'Test Printer',
    manufacturer: 'Test',
    buildVolumeMm: { width: 200, depth: 200, height: 200 },
    display: {
      resolutionX: 1000,
      resolutionY: 1000,
      outputFormat: '.nanodlp',
      mirrorX: false,
      mirrorY: false,
    },
    ...overrides,
  } as PrinterProfile;
}

test('a multi-body model sends one tank per body', async () => {
  const solidMesh = await buildSolidSliceMeshForWasm({
    models: [multiBodyModel()],
    printerProfile: printer({
      materialMode: 'multiTank',
      tankCount: 2,
      tankMaterials: ['mat-blue', 'mat-yellow'],
    }),
    materialProfile,
    filenameBase: 'test_export',
  });

  assert.equal(solidMesh.tankCount, 2);
  assert.deepEqual(Array.from(solidMesh.triangleTankIndex ?? []), [0, 1]);
  assert.equal(solidMesh.modelTriangleCount, 2);
});

test('a single-material printer sends no tank indices', async () => {
  const solidMesh = await buildSolidSliceMeshForWasm({
    models: [multiBodyModel()],
    printerProfile: printer({ materialMode: 'single', tankCount: 1 }),
    materialProfile,
    filenameBase: 'test_export',
  });

  assert.equal(solidMesh.tankCount, 1);
  assert.equal(solidMesh.triangleTankIndex, undefined);
});
