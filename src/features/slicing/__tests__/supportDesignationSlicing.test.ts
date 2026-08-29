import assert from 'node:assert/strict';
import test from 'node:test';
import * as THREE from 'three';
import type { LoadedModel } from '@/features/scene/useSceneCollectionManager';
import type { MaterialProfile, PrinterProfile } from '@/features/profiles/profileStore';
import {
  effectiveModelTriangleCount,
  getModelTriangleCount,
  buildSolidSliceMeshForWasm,
} from '../rasterLayerZipExport';
import { setSnapshot } from '@/supports/state';

function createMockModel(
  id: string,
  triangleCount: number,
  isSupportGeometry?: boolean,
  nativeRepairReport?: { model_triangle_count?: number | null; likely_support_geometry?: boolean },
): LoadedModel {
  const positions = new Float32Array(triangleCount * 9);
  for (let i = 0; i < positions.length; i++) {
    positions[i] = (i + 1) * 0.1;
  }
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.BufferAttribute(positions, 3));

  return {
    id,
    name: id,
    visible: true,
    color: '#a3a3a3',
    polygonCount: triangleCount,
    isSupportGeometry,
    fileUrl: '',
    geometry: {
      geometry,
      bbox: new THREE.Box3(new THREE.Vector3(-10, -10, 0), new THREE.Vector3(10, 10, 20)),
      center: new THREE.Vector3(0, 0, 10),
      size: new THREE.Vector3(20, 20, 20),
      flatteningPlanes: [],
      meshDefects: nativeRepairReport ? ({ nativeRepairReport } as any) : undefined,
    },
    transform: {
      position: new THREE.Vector3(0, 0, 0),
      rotation: new THREE.Euler(0, 0, 0),
      scale: new THREE.Vector3(1, 1, 1),
    },
  } as LoadedModel;
}

const mockPrinterProfile: PrinterProfile = {
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
} as PrinterProfile;

const mockMaterialProfile: MaterialProfile = {
  id: 'test-material',
  name: 'Test Material',
  layerHeightMm: 0.05,
} as MaterialProfile;

test('effectiveModelTriangleCount handles isSupportGeometry true, false, and undefined', () => {
  const model10 = createMockModel('m1', 10);
  assert.equal(getModelTriangleCount(model10), 10);

  // isSupportGeometry === true -> 0 model triangles (100% support)
  const supportModel = createMockModel('s1', 10, true);
  assert.equal(effectiveModelTriangleCount(supportModel), 0);

  // isSupportGeometry === false -> 10 model triangles (100% model)
  const modelOnlyModel = createMockModel('mOnly', 10, false);
  assert.equal(effectiveModelTriangleCount(modelOnlyModel), 10);

  // isSupportGeometry === undefined -> fallback to repair report bounds
  const reportSplitModel = createMockModel('r1', 10, undefined, { model_triangle_count: 4 });
  assert.equal(effectiveModelTriangleCount(reportSplitModel), 4);

  const reportSupportModel = createMockModel('r2', 10, undefined, { likely_support_geometry: true });
  assert.equal(effectiveModelTriangleCount(reportSupportModel), 0);

  const reportUnspecifiedModel = createMockModel('r3', 10, undefined);
  assert.equal(effectiveModelTriangleCount(reportUnspecifiedModel), 10);
});

test('buildSolidSliceMeshForWasm partitions designated support models into support section', async () => {
  const modelPart = createMockModel('m1', 2, false); // 2 model triangles
  const supportPart = createMockModel('s1', 3, true); // 3 support triangles

  const solidMesh = await buildSolidSliceMeshForWasm({
    models: [modelPart, supportPart],
    printerProfile: mockPrinterProfile,
    materialProfile: mockMaterialProfile,
    filenameBase: 'test_export',
  });

  // Model triangle count must equal designated model triangles (2)
  assert.equal(solidMesh.modelTriangleCount, 2);
  // Total triangle count in collector must equal 5 (2 model + 3 support)
  assert.equal(solidMesh.trianglesXYZ.length / 9, 5);
});

test('twig contact disks are successfully appended to the sliced geometry', async () => {
  // 1. Create a dummy model
  const model = createMockModel('m1', 2, false);

  // 2. Mock support state with a twig having contactDiskA and contactDiskB
  const mockTwig = {
    id: 'twig-1',
    modelId: 'm1',
    segments: [], // empty segments so we only test contact disks
    contactDiskA: {
      id: 'disk-a',
      pos: { x: 0, y: 0, z: 10 },
      surfaceNormal: { x: 0, y: 0, z: 1 },
      coneAxis: { x: 0, y: 0, z: 1 },
      contactDiameterMm: 1.0,
      profile: {
        type: 'disk' as const,
        diskThicknessMm: 0.2,
        maxStandoffMm: 0.35,
        standoffAngleThreshold: Math.PI / 4,
      },
    },
    contactDiskB: {
      id: 'disk-b',
      pos: { x: 5, y: 5, z: 15 },
      surfaceNormal: { x: 0, y: 0, z: -1 },
      coneAxis: { x: 0, y: 0, z: -1 },
      contactDiameterMm: 2.0,
      profile: {
        type: 'disk' as const,
        diskThicknessMm: 0.3,
        maxStandoffMm: 0.35,
        standoffAngleThreshold: Math.PI / 4,
      },
    },
  };

  const initialSupportState = {
    roots: {},
    trunks: {},
    branches: {},
    leaves: {},
    twigs: { 'twig-1': mockTwig as any },
    sticks: {},
    braces: {},
    anchors: {},
    knots: {},
    selectedId: null,
    hoveredId: null,
    selectedCategory: null,
    hoveredCategory: 'none' as const,
    interactionWarning: null,
  };

  setSnapshot(initialSupportState);

  // 3. Build solid slice mesh
  const solidMesh = await buildSolidSliceMeshForWasm({
    models: [model],
    printerProfile: mockPrinterProfile,
    materialProfile: mockMaterialProfile,
    filenameBase: 'test_twig_disks',
  });

  // 4. Verify triangles are appended.
  // Model triangle count is 2 (from mock model).
  // Total triangles should include:
  // - 2 model triangles
  // - cylinder and sphere from contactDiskA
  // - cylinder and sphere from contactDiskB
  assert.equal(solidMesh.modelTriangleCount, 2);
  assert.ok(solidMesh.trianglesXYZ.length / 9 > 2, 'Should append contact disk triangles to support geometry');

  // Clean up
  setSnapshot({
    roots: {},
    trunks: {},
    branches: {},
    leaves: {},
    twigs: {},
    sticks: {},
    braces: {},
    anchors: {},
    knots: {},
    selectedId: null,
    hoveredId: null,
    selectedCategory: null,
    hoveredCategory: 'none' as const,
    interactionWarning: null,
  });
});

test('anchor supports contribute root, joint, and cone triangles to the sliced geometry', async () => {
  const model = createMockModel('m1', 2, false);

  const mockAnchor = {
    id: 'anchor-1',
    modelId: 'm1',
    rootPos: { x: 0, y: 0, z: 0 },
    rootBaseDiameter: 2,
    rootTopDiameter: 1.5,
    rootHeight: 1,
    joint: { id: 'anchor-1-joint', pos: { x: 0, y: 0, z: 1.1 }, diameter: 1.5 },
    segments: [],
    contactCone: {
      id: 'anchor-1-cone',
      pos: { x: 0, y: 0, z: 3 },
      normal: { x: 0, y: 0, z: -1 },
      surfaceNormal: { x: 0, y: 0, z: -1 },
      profile: {
        type: 'disk' as const,
        contactDiameterMm: 0.4,
        bodyDiameterMm: 1.4,
        lengthMm: 2,
        penetrationMm: 0.05,
        diskThicknessMm: 0.1,
        maxStandoffMm: 0.2,
        standoffAngleThreshold: Math.PI / 4,
      },
    },
  };

  const emptyState = {
    roots: {},
    trunks: {},
    branches: {},
    leaves: {},
    twigs: {},
    sticks: {},
    braces: {},
    anchors: {},
    knots: {},
    selectedId: null,
    hoveredId: null,
    selectedCategory: null,
    hoveredCategory: 'none' as const,
    interactionWarning: null,
  };

  // Baseline: no anchors.
  setSnapshot(emptyState);
  const baseline = await buildSolidSliceMeshForWasm({
    models: [model],
    printerProfile: mockPrinterProfile,
    materialProfile: mockMaterialProfile,
    filenameBase: 'test_anchor_baseline',
  });

  // With one anchor.
  setSnapshot({ ...emptyState, anchors: { 'anchor-1': mockAnchor } });
  const withAnchor = await buildSolidSliceMeshForWasm({
    models: [model],
    printerProfile: mockPrinterProfile,
    materialProfile: mockMaterialProfile,
    filenameBase: 'test_anchor_sliced',
  });

  assert.equal(withAnchor.modelTriangleCount, 2);
  assert.ok(
    withAnchor.trianglesXYZ.length > baseline.trianglesXYZ.length,
    'Anchor root frustum, joint sphere, and contact cone must add slice triangles',
  );

  setSnapshot(emptyState);
});

