import test from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from 'three';
import type { KickstandState } from '@/supports/SupportTypes/Kickstand/types';
import type { SupportState } from '@/supports/types';
import { JOINT_DIAMETER_OFFSET_MM } from '@/supports/constants';
import { SupportGeometryGenerator } from './SupportGeometryGenerator';
import { buildScopedSupportExportDocument, buildScopedSupportGeometryGroup } from './supportExportReconstruction';

function makeSupportState(): SupportState {
  return {
    roots: {
      'root-a': {
        id: 'root-a',
        modelId: 'model-a',
        transform: { pos: { x: 0, y: 0, z: 0 }, rot: { x: 0, y: 0, z: 0, w: 1 } },
        diameter: 3,
        diskHeight: 0.8,
        coneHeight: 1.2,
      },
      'root-b': {
        id: 'root-b',
        modelId: 'model-b',
        transform: { pos: { x: 20, y: 0, z: 0 }, rot: { x: 0, y: 0, z: 0, w: 1 } },
        diameter: 3,
        diskHeight: 0.8,
        coneHeight: 1.2,
      },
    },
    trunks: {
      'trunk-a': {
        id: 'trunk-a',
        modelId: 'model-a',
        rootId: 'root-a',
        segments: [{ id: 'trunk-a-seg', diameter: 1, topJoint: { id: 'trunk-a-joint', pos: { x: 0, y: 0, z: 8 }, diameter: 1.2 } }],
      },
      'trunk-b': {
        id: 'trunk-b',
        modelId: 'model-b',
        rootId: 'root-b',
        segments: [{ id: 'trunk-b-seg', diameter: 1, topJoint: { id: 'trunk-b-joint', pos: { x: 20, y: 0, z: 8 }, diameter: 1.2 } }],
      },
    },
    branches: {
      'branch-a': {
        id: 'branch-a',
        modelId: 'model-a',
        parentKnotId: 'knot-a',
        segments: [{ id: 'branch-a-seg', diameter: 0.8 }],
      },
      'branch-b': {
        id: 'branch-b',
        modelId: 'model-b',
        parentKnotId: 'knot-b',
        segments: [{ id: 'branch-b-seg', diameter: 0.8 }],
      },
    },
    leaves: {
      'leaf-a': {
        id: 'leaf-a',
        modelId: 'model-a',
        parentKnotId: 'knot-a',
        contactCone: {
          id: 'leaf-a-cone',
          pos: { x: 1, y: 0, z: 9 },
          normal: { x: 0, y: 0, z: -1 },
          profile: { type: 'disk', contactDiameterMm: 0.4, bodyDiameterMm: 1.2, lengthMm: 2, penetrationMm: 0.05, diskThicknessMm: 0.1, maxStandoffMm: 0.2, standoffAngleThreshold: Math.PI / 4 },
        },
      },
      'leaf-b': {
        id: 'leaf-b',
        modelId: 'model-b',
        parentKnotId: 'knot-b',
        contactCone: {
          id: 'leaf-b-cone',
          pos: { x: 21, y: 0, z: 9 },
          normal: { x: 0, y: 0, z: -1 },
          profile: { type: 'disk', contactDiameterMm: 0.4, bodyDiameterMm: 1.2, lengthMm: 2, penetrationMm: 0.05, diskThicknessMm: 0.1, maxStandoffMm: 0.2, standoffAngleThreshold: Math.PI / 4 },
        },
      },
    },
    twigs: {},
    sticks: {},
    braces: {
      'brace-a': {
        id: 'brace-a',
        modelId: 'model-a',
        startKnotId: 'knot-a',
        endKnotId: 'brace-knot-a',
        profile: { diameter: 0.6 },
      },
      'brace-b': {
        id: 'brace-b',
        modelId: 'model-b',
        startKnotId: 'knot-b',
        endKnotId: 'brace-knot-b',
        profile: { diameter: 0.6 },
      },
    },
    anchors: {
      'anchor-a': {
        id: 'anchor-a',
        modelId: 'model-a',
        rootPos: { x: -2, y: 0, z: 0 },
        rootBaseDiameter: 2,
        rootTopDiameter: 1.2,
        rootHeight: 1,
        joint: { id: 'anchor-a-joint', pos: { x: -2, y: 0, z: 1 }, diameter: 1.2 },
        segments: [{ id: 'anchor-a-seg', diameter: 1 }],
        contactCone: {
          id: 'anchor-a-cone',
          pos: { x: -2, y: 0, z: 3 },
          normal: { x: 0, y: 0, z: -1 },
          profile: { type: 'disk', contactDiameterMm: 0.4, bodyDiameterMm: 1.2, lengthMm: 2, penetrationMm: 0.05, diskThicknessMm: 0.1, maxStandoffMm: 0.2, standoffAngleThreshold: Math.PI / 4 },
        },
      },
    },
    knots: {
      'knot-a': { id: 'knot-a', parentShaftId: 'trunk-a-seg', pos: { x: 0, y: 0, z: 4 }, diameter: 1.1 },
      'knot-b': { id: 'knot-b', parentShaftId: 'trunk-b-seg', pos: { x: 20, y: 0, z: 4 }, diameter: 1.1 },
      'brace-knot-a': { id: 'brace-knot-a', parentShaftId: 'braceSegment:brace-a', pos: { x: 0.5, y: 0, z: 5 }, diameter: 0.8 },
      'brace-knot-b': { id: 'brace-knot-b', parentShaftId: 'braceSegment:brace-b', pos: { x: 20.5, y: 0, z: 5 }, diameter: 0.8 },
    },
    selectedId: null,
    selectedCategory: null,
    hoveredId: null,
    hoveredCategory: 'none',
    interactionWarning: null,
  };
}

function makeKickstandState(): KickstandState {
  return {
    kickstands: {
      'kickstand-a': {
        id: 'kickstand-a',
        modelId: 'model-a',
        rootId: 'kick-root-a',
        hostKnotId: 'kick-knot-a',
        hostSegmentId: 'trunk-a-seg',
        hostMinT: 0,
        segments: [{ id: 'kick-seg-a', diameter: 0.7 }],
        profile: { bodyDiameterMm: 0.7, terminalStartDiameterMm: 0.7, terminalEndDiameterMm: 0.9 },
      },
      'kickstand-b': {
        id: 'kickstand-b',
        modelId: 'model-b',
        rootId: 'kick-root-b',
        hostKnotId: 'kick-knot-b',
        hostSegmentId: 'trunk-b-seg',
        hostMinT: 0,
        segments: [{ id: 'kick-seg-b', diameter: 0.7 }],
        profile: { bodyDiameterMm: 0.7, terminalStartDiameterMm: 0.7, terminalEndDiameterMm: 0.9 },
      },
    },
    roots: {
      'kick-root-a': {
        id: 'kick-root-a',
        modelId: 'model-a',
        transform: { pos: { x: -1, y: 0, z: 0 }, rot: { x: 0, y: 0, z: 0, w: 1 } },
        diameter: 2,
        diskHeight: 0.5,
        coneHeight: 0.8,
      },
      'kick-root-b': {
        id: 'kick-root-b',
        modelId: 'model-b',
        transform: { pos: { x: 19, y: 0, z: 0 }, rot: { x: 0, y: 0, z: 0, w: 1 } },
        diameter: 2,
        diskHeight: 0.5,
        coneHeight: 0.8,
      },
    },
    knots: {
      'kick-knot-a': { id: 'kick-knot-a', parentShaftId: 'trunk-a-seg', pos: { x: 0, y: 0, z: 6 }, diameter: 0.8 },
      'kick-knot-b': { id: 'kick-knot-b', parentShaftId: 'trunk-b-seg', pos: { x: 20, y: 0, z: 6 }, diameter: 0.8 },
    },
    selectedId: null,
  };
}

test('scoped support export document keeps only requested model supports', () => {
  const supportState = makeSupportState();
  const kickstandState = makeKickstandState();

  const scoped = buildScopedSupportExportDocument(supportState, kickstandState, ['model-a'], 'test-export');

  assert.equal(scoped.roots.length, 1);
  assert.equal(scoped.trunks.length, 1);
  assert.equal(scoped.branches.length, 1);
  assert.equal(scoped.leaves.length, 1);
  assert.equal(scoped.braces.length, 1);
  assert.equal(scoped.anchors?.length ?? 0, 1);
  assert.equal(scoped.kickstands?.length ?? 0, 1);

  for (const collection of [scoped.roots, scoped.trunks, scoped.branches, scoped.leaves, scoped.braces, scoped.anchors ?? []]) {
    for (const item of collection) {
      assert.equal(item.modelId, 'model-a');
    }
  }

  assert.ok(scoped.knots.every((knot) => !knot.id.endsWith('-b')));
  assert.equal(scoped.kickstands?.[0]?.kickstand.modelId, 'model-a');
});

test('scoped support geometry group only contains requested model metadata', () => {
  const supportState = makeSupportState();
  const kickstandState = makeKickstandState();

  const group = buildScopedSupportGeometryGroup(supportState, kickstandState, ['model-a']);

  assert.ok(group.children.length > 0);

  group.traverse((node) => {
    if (node === group) return;
    const modelId = (node.userData as { modelId?: string | null }).modelId;
    if (modelId == null) return;
    assert.equal(modelId, 'model-a');
  });
});

test('export joint and knot diameters use non-edit display sizing', () => {
  const jointDisplayDiameter = SupportGeometryGenerator.getExportJointDiameter(1.2);
  const knotDisplayDiameter = SupportGeometryGenerator.getExportKnotDiameter(1.2);

  assert.equal(jointDisplayDiameter, 1.2 - (JOINT_DIAMETER_OFFSET_MM * 0.75));
  assert.equal(knotDisplayDiameter, 1.2 - JOINT_DIAMETER_OFFSET_MM);
});

test('export cone mesh uses the visible contact-side sphere instead of a socket sphere', () => {
  const coneGroup = SupportGeometryGenerator.generateConeMesh({
    pos: { x: 0, y: 0, z: 10 },
    normal: { x: 0, y: 0, z: -1 },
    surfaceNormal: { x: 0, y: 0, z: -1 },
    diskLengthOverride: 0.5,
    profile: {
      type: 'disk',
      contactDiameterMm: 0.4,
      bodyDiameterMm: 1.2,
      lengthMm: 2,
      penetrationMm: 0.05,
      diskThicknessMm: 0.1,
      maxStandoffMm: 0.2,
      standoffAngleThreshold: Math.PI / 4,
    },
  });

  const sphereMeshes = coneGroup.children.filter((child) => (child as THREE.Mesh).geometry?.type === 'SphereGeometry');
  assert.equal(sphereMeshes.length, 1);
  assert.equal(sphereMeshes[0]?.position.z, 9.5);
});

test('kickstand export does not add a host-knot sphere affordance', () => {
  const supportState = makeSupportState();
  const kickstandState = makeKickstandState();
  const group = buildScopedSupportGeometryGroup(supportState, kickstandState, ['model-a']);

  const kickstandGroup = group.children.find((child) => child.name === 'Kickstand_kickstand-a');
  assert.ok(kickstandGroup);

  kickstandGroup!.updateMatrixWorld(true);

  const hostSphereMeshes: THREE.Object3D[] = [];
  kickstandGroup!.traverse((node) => {
    if ((node as THREE.Mesh).geometry?.type !== 'SphereGeometry') return;
    const worldPos = new THREE.Vector3();
    node.getWorldPosition(worldPos);
    if (Math.abs(worldPos.x - 0) < 1e-6 && Math.abs(worldPos.y - 0) < 1e-6 && Math.abs(worldPos.z - 6) < 1e-6) {
      hostSphereMeshes.push(node);
    }
  });

  assert.equal(hostSphereMeshes.length, 0);
});
