import assert from 'node:assert/strict';
import test, { after } from 'node:test';
import * as THREE from 'three';
import type { LoadedModel } from '@/features/scene/useSceneCollectionManager';
import type { MaterialProfile, PrinterProfile } from '@/features/profiles/profileStore';
import type { MeshAnalysisJson, MeshHealthReport } from '@/utils/meshRepair';
import type { SupportState } from '@/supports/types';
import { disposeEventLoopChannel } from '@/utils/yieldToEventLoop';
import {
  effectiveModelTriangleCount,
  getModelTriangleCount,
  buildSolidSliceMeshForWasm,
} from '../rasterLayerZipExport';
import { getSnapshot, setSnapshot } from '@/supports/state';
import { createEmptySupportCollections } from '@/supports/supportTypeRegistry';

after(disposeEventLoopChannel);

function emptySupportState(): SupportState {
  return {
    ...createEmptySupportCollections(),
    selectedId: null,
    hoveredId: null,
    selectedCategory: null,
    hoveredCategory: 'none',
    interactionWarning: null,
  };
}

function repairReport(
  triangleCount: number,
  classification: { model_triangle_count?: number | null; likely_support_geometry?: boolean },
): MeshHealthReport {
  const analysis: MeshAnalysisJson = {
    triangle_count: triangleCount, vertex_count: triangleCount * 3,
    non_manifold_edges: 0, non_manifold_vertices: 0, boundary_edges: 0, boundary_loops: 0,
    inconsistent_edges: 0, degenerate_triangles: 0, duplicate_triangles: 0,
    component_count: 1, self_intersections: 0, signed_volume: 1, is_watertight: true,
    timings_ms: { topology_ms: 0, self_intersections_ms: 0, components_ms: 0, total_ms: 0 },
  };
  return {
    version: 1, pre: analysis, post: analysis, steps: [],
    likely_support_geometry: classification.likely_support_geometry ?? false,
    model_triangle_count: classification.model_triangle_count,
    residual_issues: [], fully_repaired: true, total_ms: 0,
  };
}

function expectedModelCoordinates(model: LoadedModel, vertices: readonly number[], order: readonly number[]) {
  // Intrinsic ZYX is THREE's independent representation of global-axis XYZ.
  const { position, rotation, scale } = model.transform;
  const quaternion = new THREE.Quaternion().setFromEuler(new THREE.Euler(rotation.x, rotation.y, rotation.z, 'ZYX'));
  const matrix = new THREE.Matrix4().compose(position, quaternion, scale);
  const worldVertices = order.map((index) => new THREE.Vector3(
    vertices[index * 3], vertices[index * 3 + 1], vertices[index * 3 + 2],
  ).sub(model.geometry.center).applyMatrix4(matrix));
  return { coordinates: Float32Array.from(worldVertices.flatMap((vertex) => vertex.toArray())), worldVertices };
}
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
      meshDefects: nativeRepairReport ? {
        hasDefects: false,
        repairedFloats: 0,
        totalVertices: triangleCount * 3,
        nativeRepairReport: repairReport(triangleCount, nativeRepairReport),
      } : undefined,
    },
    transform: {
      position: new THREE.Vector3(0, 0, 0),
      rotation: new THREE.Euler(0, 0, 0),
      scale: new THREE.Vector3(1, 1, 1),
    },
  };
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

test('buildSolidSliceMeshForWasm orders all model bodies before designated and repair-classified supports', async (t) => {
  const supportPart = createMockModel('designated-support', 2, true);
  const splitPart = createMockModel('repair-split', 3, undefined, { model_triangle_count: 1 });
  const modelPart = createMockModel('model-body', 2, false);
  supportPart.transform.position.x = 30;
  splitPart.transform.position.x = 10;
  modelPart.transform.position.x = -20;
  const savedSupportState = getSnapshot();
  setSnapshot(emptySupportState());
  t.after(() => {
    setSnapshot(savedSupportState);
    for (const model of [supportPart, splitPart, modelPart]) model.geometry.geometry.dispose();
  });

  const solidMesh = await buildSolidSliceMeshForWasm({
    models: [supportPart, splitPart, modelPart],
    printerProfile: mockPrinterProfile,
    materialProfile: mockMaterialProfile,
    filenameBase: 'partition_order',
  });
  const coordinatesFor = (model: LoadedModel) => {
    const source = model.geometry.geometry.getAttribute('position');
    const vertices = Array.from(source.array);
    return expectedModelCoordinates(model, vertices, Array.from({ length: source.count }, (_, i) => i)).coordinates;
  };
  const split = coordinatesFor(splitPart);
  const expected = Float32Array.from([
    ...split.subarray(0, 9), ...coordinatesFor(modelPart),
    ...coordinatesFor(supportPart), ...split.subarray(9),
  ]);
  assert.equal(solidMesh.modelTriangleCount, 3);
  assert.deepEqual(solidMesh.trianglesXYZ, expected);
});

test('model packing preserves centered transforms and winding across position attribute layouts', async (t) => {
  const floatVertices = [4.5, -2, 1, 7, -1.5, 3, 5, 2, 2, 8, 1, 4];
  const normalizedValues = [0, 32768, 65535, 65535, 8192, 16384, 16384, 65535, 32768, 49152, 16384, 8192];
  const interleavedValues = [-32768, 8192, 16384, 32767, -16384, 8192, 16384, 32767, -8192];
  const normalized = new THREE.BufferAttribute(new Uint16Array(normalizedValues), 3, true);
  const interleaved = new THREE.InterleavedBuffer(new Int16Array([
    12345, ...interleavedValues.slice(0, 3), -22222,
    12345, ...interleavedValues.slice(3, 6), -22222,
    12345, ...interleavedValues.slice(6, 9), -22222,
  ]), 5);
  const cases = [
    {
      name: 'indexed float32', attribute: new THREE.BufferAttribute(new Float32Array(floatVertices), 3),
      vertices: floatVertices, index: [2, 0, 3, 3, 1, 2], order: [2, 0, 3, 3, 1, 2],
      scale: new THREE.Vector3(1.75, 0.6, 2.25),
    },
    {
      name: 'non-indexed mirrored float32',
      attribute: new THREE.BufferAttribute(new Float32Array(floatVertices.slice(0, 9)), 3),
      vertices: floatVertices.slice(0, 9), index: null, order: [0, 2, 1],
      scale: new THREE.Vector3(-1.75, 0.6, 2.25),
    },
    {
      name: 'indexed normalized uint16', attribute: normalized,
      vertices: normalizedValues.map((value) => value / 65535),
      index: [3, 1, 0, 2, 0, 1], order: [3, 0, 1, 2, 1, 0],
      scale: new THREE.Vector3(1.75, -0.6, 2.25),
    },
    {
      name: 'non-indexed normalized interleaved int16',
      attribute: new THREE.InterleavedBufferAttribute(interleaved, 3, 1, true),
      vertices: interleavedValues.map((value) => Math.max(value / 32767, -1)),
      index: null, order: [0, 1, 2], scale: new THREE.Vector3(-1.75, -0.6, 2.25),
    },
    {
      name: 'non-indexed half-float positions',
      attribute: new THREE.Float16BufferAttribute(new Uint16Array([
        0x3c00, 0x4000, 0x4200, 0x4400, 0x4500, 0x4600, 0x4700, 0x4800, 0x4880,
      ]), 3),
      vertices: [1, 2, 3, 4, 5, 6, 7, 8, 9], index: null, order: [0, 2, 1],
      scale: new THREE.Vector3(-1.75, 0.6, 2.25),
    },
  ];

  for (const entry of cases) {
    await t.test(entry.name, async (context) => {
      const model = createMockModel(entry.name, 1, false);
      const geometry = model.geometry.geometry;
      geometry.setAttribute('position', entry.attribute);
      geometry.setIndex(entry.index);
      model.geometry.center.set(0.75, -0.5, 1.25);
      model.transform.position.set(3.25, -4.5, 18);
      model.transform.rotation.set(0.29, -0.41, 0.63);
      model.transform.scale.copy(entry.scale);
      const savedSupportState = getSnapshot();
      setSnapshot(emptySupportState());
      context.after(() => {
        setSnapshot(savedSupportState);
        geometry.dispose();
      });
      const { coordinates, worldVertices } = expectedModelCoordinates(model, entry.vertices, entry.order);
      const expectedBounds = new THREE.Box3().setFromPoints(worldVertices);
      const solidMesh = await buildSolidSliceMeshForWasm({
        models: [model], printerProfile: mockPrinterProfile,
        materialProfile: mockMaterialProfile, filenameBase: 'transformed_positions',
      });
      assert.deepEqual(solidMesh.trianglesXYZ, coordinates, 'raw f32 coordinates and triangle vertex order');
      assert.equal(solidMesh.modelTriangleCount, entry.order.length / 3);
      for (const [actual, expected] of [
        [solidMesh.meshBounds.minX, expectedBounds.min.x], [solidMesh.meshBounds.maxX, expectedBounds.max.x],
        [solidMesh.meshBounds.minY, expectedBounds.min.y], [solidMesh.meshBounds.maxY, expectedBounds.max.y],
        [solidMesh.meshBounds.minZ, expectedBounds.min.z], [solidMesh.meshBounds.maxZ, expectedBounds.max.z],
      ]) assert.ok(Math.abs(actual - expected) < 1e-10, `world-space bound ${actual} matches ${expected}`);
      assert.ok(Math.abs(solidMesh.tallestObjectHeightMm - expectedBounds.max.z) < 1e-10);
      assert.equal(solidMesh.totalLayers, Math.ceil(expectedBounds.max.z / mockMaterialProfile.layerHeightMm));
    });
  }
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
    twigs: { 'twig-1': mockTwig },
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
