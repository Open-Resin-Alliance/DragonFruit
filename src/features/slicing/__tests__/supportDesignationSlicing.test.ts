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
import { getSnapshot, setSnapshot } from '@/supports/state';
import { createEmptySupportCollections } from '@/supports/supportTypeRegistry';

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

function ringBoundsAtZ(triangles: Float32Array, z: number) {
  let minX = Infinity;
  let maxX = -Infinity;
  let minY = Infinity;
  let maxY = -Infinity;
  for (let i = 0; i < triangles.length; i += 3) {
    if (Math.abs(triangles[i + 2] - z) > 1e-5) continue;
    minX = Math.min(minX, triangles[i]);
    maxX = Math.max(maxX, triangles[i]);
    minY = Math.min(minY, triangles[i + 1]);
    maxY = Math.max(maxY, triangles[i + 1]);
  }
  assert.ok(Number.isFinite(minX), 'expected vertices on the contact plane');
  return { minX, maxX, minY, maxY };
}

function assertRingAt(triangles: Float32Array, z: number, diameter: number) {
  const { minX, maxX, minY, maxY } = ringBoundsAtZ(triangles, z);
  for (const coordinate of [minX, minY]) assert.ok(Math.abs(coordinate + diameter / 2) < 1e-5);
  for (const coordinate of [maxX, maxY]) assert.ok(Math.abs(coordinate - diameter / 2) < 1e-5);
}

test('twig contact disks shrink both the cylinder and round terminal without moving the pad', async () => {
  const model = createMockModel('m1', 2, false);
  const mockTwig = {
    id: 'twig-1',
    modelId: 'm1',
    segments: [],
    contactDiskA: {
      id: 'disk-a',
      pos: { x: 0, y: 0, z: 10 },
      surfaceNormal: { x: 0, y: 0, z: 1 },
      coneAxis: { x: 0, y: 0, z: 1 },
      contactDiameterMm: 1.0,
      profile: {
        type: 'disk' as const,
        contactDiameterMm: 1.0,
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
    ...createEmptySupportCollections(),
    twigs: { 'twig-1': mockTwig as any },
    selectedId: null,
    hoveredId: null,
    selectedCategory: null,
    hoveredCategory: 'none' as const,
    interactionWarning: null,
  };
  const savedSupportState = getSnapshot();
  try {
    setSnapshot(initialSupportState);
    const beforeBuilds = getSnapshot();
    const storedTwigs = structuredClone(beforeBuilds.twigs);
    for (const [percent, radius] of [[0, 0.5], [10, 0.45], [25, 0.375]]) {
      const mesh = await buildSolidSliceMeshForWasm({
        models: [model],
        printerProfile: mockPrinterProfile,
        materialProfile: mockMaterialProfile,
        filenameBase: 'test_twig_disks',
        supportTipShrinkPercent: percent,
      });
      assert.equal(mesh.modelTriangleCount, 2);
      // The authored 1 mm disk sets a 0.5 mm standoff, regardless of the transient radius.
      assertRingAt(mesh.trianglesXYZ, 10, radius * 2);
      assertRingAt(mesh.trianglesXYZ, 10.5, radius * 2);
      let terminalTop = -Infinity;
      let topX = 0;
      let topY = 0;
      for (let i = 0; i < mesh.trianglesXYZ.length; i += 3) {
        const x = mesh.trianglesXYZ[i];
        const y = mesh.trianglesXYZ[i + 1];
        const z = mesh.trianglesXYZ[i + 2];
        if (z > 9 && z < 12 && z > terminalTop) {
          terminalTop = z;
          topX = x;
          topY = y;
        }
      }
      assert.ok(Math.abs(terminalTop - (10.5 + radius)) < 1e-5, 'round terminal radius must shrink');
      assert.ok(Math.abs(topX) < 1e-5 && Math.abs(topY) < 1e-5, 'round terminal stays centered on the pad');
      assert.strictEqual(getSnapshot(), beforeBuilds);
      assert.deepEqual(getSnapshot().twigs, storedTwigs);
    }
  } finally {
    setSnapshot(savedSupportState);
    model.geometry.geometry.dispose();
  }
});

test('anchor contact cones shrink only the contact face, preserving socket, shaft and root', async () => {
  const model = createMockModel('m1', 2, false);
  const joint = { id: 'anchor-1-joint', pos: { x: 0, y: 0, z: 1.1 }, diameter: 1.5 };
  const mockAnchor = {
    id: 'anchor-1',
    modelId: 'm1',
    rootPos: { x: 0, y: 0, z: 0 },
    rootBaseDiameter: 2,
    rootTopDiameter: 1.5,
    rootHeight: 1,
    joint,
    segments: [{
      id: 'anchor-1-segment',
      type: 'straight' as const,
      diameter: 0.7,
      bottomJoint: joint,
      topJoint: { id: 'anchor-1-socket', pos: { x: 0, y: 0, z: 1.75 }, diameter: 1.3 },
    }],
    contactCone: {
      id: 'anchor-1-cone',
      pos: { x: 0, y: 0, z: 4 },
      normal: { x: 0, y: 0, z: -1 },
      surfaceNormal: { x: 0, y: 0, z: -1 },
      profile: {
        type: 'disk' as const,
        contactDiameterMm: 0.4,
        bodyDiameterMm: 1.4,
        lengthMm: 2.05,
        penetrationMm: 0.05,
        diskThicknessMm: 0.1,
        maxStandoffMm: 0.2,
        standoffAngleThreshold: Math.PI / 4,
      },
    },
  };
  const emptyState = {
    ...createEmptySupportCollections(),
    selectedId: null,
    hoveredId: null,
    selectedCategory: null,
    hoveredCategory: 'none' as const,
    interactionWarning: null,
  };
  const savedSupportState = getSnapshot();
  try {
    setSnapshot(emptyState);
    const baseline = await buildSolidSliceMeshForWasm({
      models: [model],
      printerProfile: mockPrinterProfile,
      materialProfile: mockMaterialProfile,
      filenameBase: 'test_anchor_baseline',
    });

    setSnapshot({ ...emptyState, stumps: { 'anchor-1': mockAnchor } });
    const beforeBuilds = getSnapshot();
    const storedStumps = structuredClone(beforeBuilds.stumps);
    const meshes = [];
    for (const [percent, diameter] of [[0, 0.4], [10, 0.36], [25, 0.3]]) {
      const mesh = await buildSolidSliceMeshForWasm({
        models: [model],
        printerProfile: mockPrinterProfile,
        materialProfile: mockMaterialProfile,
        filenameBase: 'test_anchor_sliced',
        supportTipShrinkPercent: percent,
      });
      assert.equal(mesh.modelTriangleCount, 2);
      assert.ok(mesh.trianglesXYZ.length > baseline.trianglesXYZ.length);
      assertRingAt(mesh.trianglesXYZ, 4, diameter);
      assertRingAt(mesh.trianglesXYZ, 1.75, 1.4); // Contact cone socket/body ring.
      assert.strictEqual(getSnapshot(), beforeBuilds);
      assert.deepEqual(getSnapshot().stumps, storedStumps);
      meshes.push(mesh);
    }

    const authored = meshes[0].trianglesXYZ;
    for (const reduced of meshes.slice(1)) {
      assert.equal(reduced.trianglesXYZ.length, authored.length);
      for (let i = 0; i < authored.length; i += 3) {
        assert.ok(Math.abs(reduced.trianglesXYZ[i + 2] - authored[i + 2]) < 1e-5, 'contact penetration and all other Z remain unchanged');
        if (Math.abs(authored[i + 2] - 4) < 1e-5) continue; // Only the contact-face XY may differ.
        assert.equal(reduced.trianglesXYZ[i], authored[i], 'root, shaft and socket X remain unchanged');
        assert.equal(reduced.trianglesXYZ[i + 1], authored[i + 1], 'root, shaft and socket Y remain unchanged');
      }
    }
  } finally {
    setSnapshot(savedSupportState);
    model.geometry.geometry.dispose();
  }
});
