import assert from 'node:assert/strict';
import test from 'node:test';

import { getSnapshot, removeKickstandCascade, resetStore, setSnapshot } from '../state';
import { getKickstandSnapshot, setKickstandSnapshot } from '../SupportTypes/Kickstand/kickstandStore';
import type { KickstandState } from '../SupportTypes/Kickstand/types';
import type { SupportState } from '../types';

function makeState(): SupportState {
  return {
    roots: {
      'root-1': {
        id: 'root-1',
        modelId: 'model-1',
        transform: {
          pos: { x: 0, y: 0, z: 0 },
          rot: { x: 0, y: 0, z: 0, w: 1 },
        },
        diameter: 4,
        diskHeight: 0.5,
        coneHeight: 1,
      },
      'kickstand-root': {
        id: 'kickstand-root',
        modelId: 'model-1',
        transform: {
          pos: { x: 6, y: 0, z: 0 },
          rot: { x: 0, y: 0, z: 0, w: 1 },
        },
        diameter: 2,
        diskHeight: 0.4,
        coneHeight: 0.7,
      },
    },
    trunks: {
      'trunk-1': {
        id: 'trunk-1',
        modelId: 'model-1',
        rootId: 'root-1',
        segments: [
          {
            id: 'trunk-seg-1',
            diameter: 1.2,
            bottomJoint: {
              id: 'trunk-j0',
              pos: { x: 0, y: 0, z: 1.5 },
              diameter: 1.3,
            },
            topJoint: {
              id: 'trunk-j1',
              pos: { x: 0, y: 0, z: 12 },
              diameter: 1.3,
            },
          },
        ],
      },
    },
    branches: {
      'branch-1': {
        id: 'branch-1',
        modelId: 'model-1',
        parentKnotId: 'kickstand-branch-knot',
        segments: [
          {
            id: 'branch-seg-1',
            diameter: 0.8,
            bottomJoint: {
              id: 'branch-j0',
              pos: { x: 6.2, y: 0, z: 4.5 },
              diameter: 0.9,
            },
            topJoint: {
              id: 'branch-j1',
              pos: { x: 7.2, y: 0, z: 8.5 },
              diameter: 0.9,
            },
          },
        ],
      },
    },
    leaves: {
      'leaf-direct': {
        id: 'leaf-direct',
        modelId: 'model-1',
        parentKnotId: 'kickstand-leaf-knot',
        contactCone: {
          id: 'leaf-direct-cone',
          pos: { x: 7, y: 1, z: 7 },
          normal: { x: 0, y: 0, z: 1 },
          profile: {
            contactDiameterMm: 0.4,
            bodyDiameterMm: 1,
            lengthMm: 2,
            penetrationMm: 0.1,
          },
        },
      },
      'leaf-nested': {
        id: 'leaf-nested',
        modelId: 'model-1',
        parentKnotId: 'branch-leaf-knot',
        contactCone: {
          id: 'leaf-nested-cone',
          pos: { x: 8, y: 0, z: 9 },
          normal: { x: 0, y: 0, z: 1 },
          profile: {
            contactDiameterMm: 0.4,
            bodyDiameterMm: 1,
            lengthMm: 2,
            penetrationMm: 0.1,
          },
        },
      },
    },
    twigs: {},
    sticks: {},
    braces: {
      'brace-1': {
        id: 'brace-1',
        modelId: 'model-1',
        startKnotId: 'trunk-brace-knot',
        endKnotId: 'kickstand-brace-knot',
        profile: {
          diameter: 0.7,
        },
      },
    },
    anchors: {},
    knots: {
      'kickstand-host-knot': {
        id: 'kickstand-host-knot',
        parentShaftId: 'trunk-seg-1',
        t: 0.75,
        pos: { x: 0, y: 0, z: 9 },
        diameter: 1.3,
      },
      'kickstand-branch-knot': {
        id: 'kickstand-branch-knot',
        parentShaftId: 'kickstand-seg-1',
        t: 0.4,
        pos: { x: 6, y: 0, z: 4 },
        diameter: 0.9,
      },
      'kickstand-leaf-knot': {
        id: 'kickstand-leaf-knot',
        parentShaftId: 'kickstand-seg-2',
        t: 0.55,
        pos: { x: 6.8, y: 0.5, z: 6.5 },
        diameter: 0.9,
      },
      'kickstand-brace-knot': {
        id: 'kickstand-brace-knot',
        parentShaftId: 'kickstand-seg-3',
        t: 0.65,
        pos: { x: 7.4, y: 0, z: 8.2 },
        diameter: 0.9,
      },
      'trunk-brace-knot': {
        id: 'trunk-brace-knot',
        parentShaftId: 'trunk-seg-1',
        t: 0.5,
        pos: { x: 0, y: 0, z: 6 },
        diameter: 1.3,
      },
      'branch-leaf-knot': {
        id: 'branch-leaf-knot',
        parentShaftId: 'branch-seg-1',
        t: 0.7,
        pos: { x: 7.8, y: 0, z: 8.8 },
        diameter: 0.9,
      },
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
      'kickstand-1': {
        id: 'kickstand-1',
        modelId: 'model-1',
        rootId: 'kickstand-root',
        hostKnotId: 'kickstand-host-knot',
        hostSegmentId: 'trunk-seg-1',
        hostMinT: 0,
        segments: [
          {
            id: 'kickstand-seg-1',
            diameter: 0.8,
            bottomJoint: {
              id: 'kickstand-j0',
              pos: { x: 6, y: 0, z: 1.2 },
              diameter: 0.9,
            },
            topJoint: {
              id: 'kickstand-j1',
              pos: { x: 6, y: 0, z: 4.8 },
              diameter: 0.9,
            },
          },
          {
            id: 'kickstand-seg-2',
            diameter: 0.8,
            bottomJoint: {
              id: 'kickstand-j1',
              pos: { x: 6, y: 0, z: 4.8 },
              diameter: 0.9,
            },
            topJoint: {
              id: 'kickstand-j2',
              pos: { x: 6.7, y: 0.4, z: 7 },
              diameter: 0.9,
            },
          },
          {
            id: 'kickstand-seg-3',
            diameter: 0.8,
            bottomJoint: {
              id: 'kickstand-j2',
              pos: { x: 6.7, y: 0.4, z: 7 },
              diameter: 0.9,
            },
            topJoint: {
              id: 'kickstand-j3',
              pos: { x: 7.5, y: 0, z: 8.8 },
              diameter: 0.9,
            },
          },
        ],
        profile: {
          bodyDiameterMm: 0.8,
          terminalStartDiameterMm: 0.8,
          terminalEndDiameterMm: 1.2,
        },
      },
    },
    roots: {
      'kickstand-root': {
        id: 'kickstand-root',
        modelId: 'model-1',
        transform: {
          pos: { x: 6, y: 0, z: 0 },
          rot: { x: 0, y: 0, z: 0, w: 1 },
        },
        diameter: 2,
        diskHeight: 0.4,
        coneHeight: 0.7,
      },
    },
    knots: {
      'kickstand-host-knot': {
        id: 'kickstand-host-knot',
        parentShaftId: 'trunk-seg-1',
        t: 0.75,
        pos: { x: 0, y: 0, z: 9 },
        diameter: 1.3,
      },
    },
    selectedId: null,
  };
}

test('removeKickstandCascade removes kickstand descendants and mirrored state', () => {
  resetStore();
  setSnapshot(makeState());
  setKickstandSnapshot(makeKickstandState());

  const removed = removeKickstandCascade('kickstand-1');

  assert.ok(removed, 'Expected kickstand removal snapshots');
  assert.equal(removed?.build.kickstand.id, 'kickstand-1');
  assert.deepEqual(new Set(removed?.branches.map((branch) => branch.id)), new Set(['branch-1']));
  assert.deepEqual(new Set(removed?.braces.map((brace) => brace.id)), new Set(['brace-1']));
  assert.deepEqual(new Set(removed?.leaves.map((leaf) => leaf.id)), new Set(['leaf-direct', 'leaf-nested']));
  assert.deepEqual(
    new Set(removed?.knots.map((knot) => knot.id)),
    new Set(['kickstand-branch-knot', 'kickstand-leaf-knot', 'kickstand-brace-knot', 'trunk-brace-knot', 'branch-leaf-knot']),
  );

  const snapshot = getSnapshot();
  const kickstandSnapshot = getKickstandSnapshot();

  assert.ok(snapshot.trunks['trunk-1'], 'Expected trunk to remain');
  assert.equal(snapshot.branches['branch-1'], undefined);
  assert.equal(snapshot.leaves['leaf-direct'], undefined);
  assert.equal(snapshot.leaves['leaf-nested'], undefined);
  assert.equal(snapshot.braces['brace-1'], undefined);
  assert.equal(snapshot.knots['kickstand-host-knot'], undefined);
  assert.equal(snapshot.knots['kickstand-branch-knot'], undefined);
  assert.equal(snapshot.knots['kickstand-leaf-knot'], undefined);
  assert.equal(snapshot.knots['kickstand-brace-knot'], undefined);
  assert.equal(snapshot.knots['trunk-brace-knot'], undefined);
  assert.equal(snapshot.knots['branch-leaf-knot'], undefined);
  assert.equal(snapshot.roots['kickstand-root'], undefined);

  assert.deepEqual(kickstandSnapshot.kickstands, {});
  assert.deepEqual(kickstandSnapshot.roots, {});
  assert.deepEqual(kickstandSnapshot.knots, {});

  resetStore();
});
