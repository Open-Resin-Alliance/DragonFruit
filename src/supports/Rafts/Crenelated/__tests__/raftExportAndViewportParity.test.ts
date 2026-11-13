import test from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from 'three';
import { DEFAULT_RAFT_SETTINGS } from '../RaftDefaults';
import {
  getRaftStateSnapshot,
  seedRaftStateSnapshot,
  setRaftSettings,
  setRaftSettingsForModel,
} from '../RaftState';
import { collectRaftBaseCirclesByModel } from '../raftFootprintCircles';
import { computeRaftFootprintPolygons } from '../geometry/computeRaftFootprint';
import { collectModelPlateFootprint, type PlateFootprintSource } from '../geometry/modelPlateFootprint';
import { buildSolidViewportRaftMeshes } from '../rendering/RaftRenderer';
import { buildLineViewportRaftMeshes } from '../rendering/LineRaftRenderer';
import { buildExportRaftGroups } from '@/features/export/logic/ExportManager';
import { buildSupportAndRaftWorldTriangles } from '@/features/slicing/rasterLayerZipExport';
import { getSnapshot, setSnapshot } from '@/supports/state';
import { createEmptySupportCollections } from '@/supports/supportTypeRegistry';
import type { Roots, Stump, SupportState } from '@/supports/types';

function makeStump(id: string, modelId: string, x: number, y: number, baseDiameter = 3.0): Stump {
  const joint = { id: `${id}-joint`, pos: { x, y, z: 1.1 }, diameter: 1.5 };
  return {
    id,
    typeId: 'stump',
    modelId,
    rootPos: { x, y, z: 0 },
    rootBaseDiameter: baseDiameter,
    rootTopDiameter: 1.5,
    rootHeight: 1.0,
    joint,
    segments: [
      {
        id: `${id}-seg`,
        type: 'straight',
        diameter: 0.8,
        bottomJoint: joint,
        topJoint: { id: `${id}-top`, pos: { x, y, z: 2.0 }, diameter: 1.2 },
      },
    ],
    contactCone: {
      id: `${id}-cone`,
      pos: { x, y, z: 3.5 },
      normal: { x: 0, y: 0, z: -1 },
      surfaceNormal: { x: 0, y: 0, z: -1 },
      profile: {
        type: 'cone',
        contactDiameterMm: 0.4,
        bodyDiameterMm: 1.2,
        lengthMm: 1.5,
        penetrationMm: 0.05,
      },
    } as any,
  };
}

function makeRoot(id: string, modelId: string, x: number, y: number, diameter = 3.0): Roots {
  return {
    id,
    modelId,
    transform: {
      pos: { x, y, z: 0 },
      rot: { x: 0, y: 0, z: 0, w: 1 },
    },
    diameter,
    diskHeight: 0.5,
    coneHeight: 1.0,
  };
}

function buildSupportState(partial: Partial<SupportState>): SupportState {
  return {
    ...createEmptySupportCollections(),
    selectedId: null,
    hoveredId: null,
    selectedCategory: null,
    hoveredCategory: 'none',
    interactionWarning: null,
    ...partial,
  };
}

function countGroupVertices(group: THREE.Object3D): number {
  let total = 0;
  group.traverse((child) => {
    const mesh = child as THREE.Mesh;
    if (mesh.isMesh && mesh.geometry) {
      const pos = mesh.geometry.getAttribute('position');
      if (pos) total += pos.count;
    }
  });
  return total;
}

function computeGroupXYBox(group: THREE.Object3D): THREE.Box2 {
  const box = new THREE.Box2();
  group.traverse((child) => {
    const mesh = child as THREE.Mesh;
    if (mesh.isMesh && mesh.geometry) {
      const pos = mesh.geometry.getAttribute('position');
      if (!pos) return;
      for (let i = 0; i < pos.count; i += 1) {
        box.expandByPoint(new THREE.Vector2(pos.getX(i), pos.getY(i)));
      }
    }
  });
  return box;
}

test('3D export emits solid and line rafts for stump-only (INLINE_ROOT_TYPES) models matching collectRaftBaseCirclesByModel', () => {
  const savedRaft = getRaftStateSnapshot();
  try {
    const supportState = buildSupportState({
      stumps: {
        s1: makeStump('s1', 'm-stump', 0, 0, 3.0),
        s2: makeStump('s2', 'm-stump', 12, 0, 3.0),
        s3: makeStump('s3', 'm-stump', 6, 10, 3.0),
      },
    });

    const circlesByModel = collectRaftBaseCirclesByModel(supportState);
    const stumpCircles = circlesByModel.get('m-stump') ?? [];
    assert.equal(stumpCircles.length, 3);

    // Solid mode
    seedRaftStateSnapshot({
      global: { ...DEFAULT_RAFT_SETTINGS, bottomMode: 'solid', wallEnabled: false },
      perModel: {},
    });
    const solidGroups = buildExportRaftGroups(supportState);
    assert.equal(solidGroups.length, 1, 'stump-only model must emit a solid Raft group');
    assert.equal(solidGroups[0].name, 'Raft');
    assert.ok(countGroupVertices(solidGroups[0]) > 0, 'solid Raft group must have non-empty mesh geometry');

    const expectedPolys = computeRaftFootprintPolygons({
      circles: stumpCircles,
      raft: { ...DEFAULT_RAFT_SETTINGS, bottomMode: 'solid', wallEnabled: false },
      clearance: [],
    });
    const expectedBox = new THREE.Box2();
    for (const poly of expectedPolys) {
      for (const pt of poly.outer) expectedBox.expandByPoint(pt);
    }
    const actualSolidBox = computeGroupXYBox(solidGroups[0]);
    assert.ok(Math.abs(actualSolidBox.min.x - expectedBox.min.x) < 1e-3);
    assert.ok(Math.abs(actualSolidBox.max.x - expectedBox.max.x) < 1e-3);
    assert.ok(Math.abs(actualSolidBox.min.y - expectedBox.min.y) < 1e-3);
    assert.ok(Math.abs(actualSolidBox.max.y - expectedBox.max.y) < 1e-3);

    // Line mode
    setRaftSettings({ ...DEFAULT_RAFT_SETTINGS, bottomMode: 'line' });
    const lineGroups = buildExportRaftGroups(supportState);
    assert.equal(lineGroups.length, 1, 'stump-only model must emit a line Raft group');
    assert.equal(lineGroups[0].name, 'Raft');
    assert.ok(countGroupVertices(lineGroups[0]) > 0, 'line Raft group must have non-empty beam geometry');
  } finally {
    seedRaftStateSnapshot(savedRaft);
  }
});

test('per-model solid and line raft overrides emit rafts in 3D export and viewport builders when global bottomMode is off', () => {
  const savedRaft = getRaftStateSnapshot();
  try {
    const supportState = buildSupportState({
      roots: {
        r1: makeRoot('r1', 'model-solid', 0, 0, 3.0),
        r2: makeRoot('r2', 'model-solid', 10, 0, 3.0),
        r3: makeRoot('r3', 'model-solid', 5, 8, 3.0),
      },
      stumps: {
        s1: makeStump('s1', 'model-line', 40, 0, 3.0),
        s2: makeStump('s2', 'model-line', 50, 0, 3.0),
        s3: makeStump('s3', 'model-line', 45, 8, 3.0),
      },
    });

    seedRaftStateSnapshot({
      global: { ...DEFAULT_RAFT_SETTINGS, bottomMode: 'off' },
      perModel: {},
    });
    setRaftSettingsForModel('model-solid', { ...DEFAULT_RAFT_SETTINGS, bottomMode: 'solid', wallEnabled: true });
    setRaftSettingsForModel('model-line', { ...DEFAULT_RAFT_SETTINGS, bottomMode: 'line' });

    const exportGroups = buildExportRaftGroups(supportState);
    assert.equal(exportGroups.length, 2, 'must emit raft groups for both overridden models even when global is off');
    for (const group of exportGroups) {
      assert.equal(group.name, 'Raft');
      assert.ok(group.children.length > 0);
      assert.ok(countGroupVertices(group) > 0);
    }

    const scopedSolidOnly = buildExportRaftGroups(supportState, {
      scopedModelIds: new Set(['model-solid']),
    });
    assert.equal(scopedSolidOnly.length, 1);
    assert.ok(computeGroupXYBox(scopedSolidOnly[0]).max.x < 25);

    const solidViewport = buildSolidViewportRaftMeshes(supportState);
    assert.equal(solidViewport.length, 1, 'viewport solid builder must emit only model-solid');
    assert.equal(solidViewport[0].baseMesh.userData.modelId, 'model-solid');

    const lineViewport = buildLineViewportRaftMeshes(supportState);
    assert.equal(lineViewport.length, 1, 'viewport line builder must emit only model-line');
    assert.ok(lineViewport[0].beamMeshes.length > 0);
    assert.equal(lineViewport[0].beamMeshes[0].userData.modelId, 'model-line');
  } finally {
    seedRaftStateSnapshot(savedRaft);
  }
});

test('per-model bottomMode off suppresses empty export Raft groups and viewport meshes when global is solid or line', () => {
  const savedRaft = getRaftStateSnapshot();
  try {
    const supportState = buildSupportState({
      roots: {
        r1: makeRoot('r1', 'model-off', 0, 0, 3.0),
        r2: makeRoot('r2', 'model-off', 10, 0, 3.0),
        r3: makeRoot('r3', 'model-off', 5, 8, 3.0),
      },
    });

    seedRaftStateSnapshot({
      global: { ...DEFAULT_RAFT_SETTINGS, bottomMode: 'solid', wallEnabled: true },
      perModel: {},
    });
    setRaftSettingsForModel('model-off', { ...DEFAULT_RAFT_SETTINGS, bottomMode: 'off' });

    const exportFromSolidGlobal = buildExportRaftGroups(supportState);
    assert.equal(
      exportFromSolidGlobal.length,
      0,
      'model overridden to off must not emit an empty Raft group when global is solid',
    );
    assert.equal(buildSolidViewportRaftMeshes(supportState).length, 0);
    assert.equal(buildLineViewportRaftMeshes(supportState).length, 0);

    setRaftSettings({ ...DEFAULT_RAFT_SETTINGS, bottomMode: 'line' });
    const exportFromLineGlobal = buildExportRaftGroups(supportState);
    assert.equal(
      exportFromLineGlobal.length,
      0,
      'model overridden to off must not emit an empty Raft group when global is line',
    );
    assert.equal(buildSolidViewportRaftMeshes(supportState).length, 0);
    assert.equal(buildLineViewportRaftMeshes(supportState).length, 0);
  } finally {
    seedRaftStateSnapshot(savedRaft);
  }
});

test('line raft emits 0 beamMeshes in viewport (matching export and slice) when a plate-grounded clearanceTarget blocks the connecting edge', () => {
  const savedRaft = getRaftStateSnapshot();
  const savedSupport = getSnapshot();
  const blockerGeometry = new THREE.BoxGeometry(10, 20, 10);
  blockerGeometry.translate(0, 0, 5); // z = 0..10 mm grounded on the plate
  try {
    const supportState = buildSupportState({
      roots: {
        r1: makeRoot('r1', 'model-blocked-line', -15, 0, 3.0),
        r2: makeRoot('r2', 'model-blocked-line', 15, 0, 3.0),
      },
    });
    setSnapshot(supportState);

    const clearanceTarget: PlateFootprintSource = {
      geometry: {
        geometry: blockerGeometry,
        center: new THREE.Vector3(0, 0, 0),
      },
      transform: {
        position: new THREE.Vector3(0, 0, 0),
        rotation: new THREE.Euler(0, 0, 0),
        scale: new THREE.Vector3(1, 1, 1),
      },
      visible: true,
    };

    const lineRaftSettings = {
      ...DEFAULT_RAFT_SETTINGS,
      bottomMode: 'line' as const,
      wallEnabled: false,
    };

    const circles = collectRaftBaseCirclesByModel(supportState).get('model-blocked-line') ?? [];
    assert.equal(circles.length, 2);

    const clearance = collectModelPlateFootprint([clearanceTarget], lineRaftSettings.lineHeightMm);
    const footprint = computeRaftFootprintPolygons({
      circles,
      raft: lineRaftSettings,
      clearance,
    });
    assert.ok(footprint.length >= 2, `expected >= 2 separated footprint polygons, got ${footprint.length}`);

    seedRaftStateSnapshot({
      global: { ...DEFAULT_RAFT_SETTINGS, bottomMode: 'off', wallEnabled: false },
      perModel: {},
    });
    const trisOff = buildSupportAndRaftWorldTriangles(
      new Set(['model-blocked-line']),
      undefined,
      0,
      [clearanceTarget],
    );

    seedRaftStateSnapshot({
      global: lineRaftSettings,
      perModel: {},
    });

    const exportGroups = buildExportRaftGroups(supportState, {
      clearanceTargets: [clearanceTarget as any],
    });
    assert.equal(exportGroups.length, 0, 'export must emit 0 raft beams when clearanceTarget blocks all edges');

    const trisLine = buildSupportAndRaftWorldTriangles(
      new Set(['model-blocked-line']),
      undefined,
      0,
      [clearanceTarget],
    );
    assert.equal(
      trisLine.length,
      trisOff.length,
      'slicer must emit 0 line raft triangles when clearanceTarget blocks all edges',
    );

    const viewportLine = buildLineViewportRaftMeshes(supportState, {
      plateClearanceTargets: [clearanceTarget],
    });
    const viewportBeamCount = viewportLine.reduce((sum, entry) => sum + entry.beamMeshes.length, 0);
    assert.equal(
      viewportBeamCount,
      0,
      'viewport must emit 0 beamMeshes rather than falling back to unfiltered edgePairs through the model',
    );
  } finally {
    blockerGeometry.dispose();
    setSnapshot(savedSupport);
    seedRaftStateSnapshot(savedRaft);
  }
});
