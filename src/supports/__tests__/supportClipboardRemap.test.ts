import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert';
import * as THREE from 'three';
import { getSnapshot, resetStore } from '../state';
import {
  captureModelSupportsToClipboard,
  pasteModelSupportsFromClipboard,
  type SupportClipboardPayload,
} from '../PlacementLogic/supportClipboard';
import {
  getSupportBraceSnapshot,
  setSupportBraceSnapshot,
} from '../SupportTypes/SupportBrace/supportBraceStore';

const SOURCE_MODEL_ID = 'model-source';
const TARGET_MODEL_ID = 'model-target';

function makeVec3(x: number, y: number, z: number) {
  return { x, y, z };
}

function makeDiskProfile() {
  return {
    type: 'disk' as const,
    contactDiameterMm: 0.4,
    bodyDiameterMm: 1.2,
    lengthMm: 3,
    penetrationMm: 0.05,
    diskThicknessMm: 0.1,
    maxStandoffMm: 0.25,
    standoffAngleThreshold: Math.PI / 4,
  };
}

function makePayload(): SupportClipboardPayload {
  const sourceRootId = 'root-source';
  const sourceSegmentId = 'seg-source';
  const sourceJointBottomId = 'joint-bottom-source';
  const sourceJointTopId = 'joint-top-source';
  const sourceParentKnotId = 'knot-parent-source';
  const sourceEndKnotId = 'knot-end-source';
  const sourceBraceId = 'brace-source';

  return {
    roots: [
      {
        id: sourceRootId,
        modelId: SOURCE_MODEL_ID,
        transform: {
          pos: makeVec3(0, 0, 0),
          rot: { x: 0, y: 0, z: 0, w: 1 },
        },
        diameter: 3,
        diskHeight: 0.8,
        coneHeight: 1.2,
      },
    ],
    trunks: [
      {
        id: 'trunk-source',
        modelId: SOURCE_MODEL_ID,
        rootId: sourceRootId,
        segments: [
          {
            id: sourceSegmentId,
            type: 'straight',
            diameter: 1,
            bottomJoint: {
              id: sourceJointBottomId,
              pos: makeVec3(0, 0, 1),
              diameter: 1.1,
            },
            topJoint: {
              id: sourceJointTopId,
              pos: makeVec3(0, 0, 8),
              diameter: 1.1,
            },
          },
        ],
        contactCone: {
          id: 'cone-trunk-source',
          pos: makeVec3(0, 0, 10),
          normal: makeVec3(0, 0, 1),
          profile: makeDiskProfile(),
          socketJointId: sourceJointTopId,
        },
      },
    ],
    branches: [
      {
        id: 'branch-source',
        modelId: SOURCE_MODEL_ID,
        parentKnotId: sourceParentKnotId,
        segments: [
          {
            id: 'branch-seg-source',
            type: 'straight',
            diameter: 0.8,
          },
        ],
      },
    ],
    leaves: [
      {
        id: 'leaf-source',
        modelId: SOURCE_MODEL_ID,
        parentKnotId: sourceParentKnotId,
        contactCone: {
          id: 'cone-leaf-source',
          pos: makeVec3(1, 0, 9),
          normal: makeVec3(0, 0, 1),
          profile: makeDiskProfile(),
          socketJointId: sourceJointTopId,
        },
      },
    ],
    twigs: [],
    sticks: [
      {
        id: 'stick-source',
        modelId: SOURCE_MODEL_ID,
        segments: [
          {
            id: 'stick-seg-source',
            type: 'straight',
            diameter: 0.7,
            bottomJoint: {
              id: 'stick-j0-source',
              pos: makeVec3(0, 0, 2),
              diameter: 0.8,
            },
            topJoint: {
              id: 'stick-j1-source',
              pos: makeVec3(0, 0, 6),
              diameter: 0.8,
            },
          },
        ],
        contactConeA: {
          id: 'stick-cone-a-source',
          pos: makeVec3(0, 0, 1),
          normal: makeVec3(0, 0, 1),
          profile: makeDiskProfile(),
          socketJointId: sourceJointBottomId,
        },
        contactConeB: {
          id: 'stick-cone-b-source',
          pos: makeVec3(0, 0, 7),
          normal: makeVec3(0, 0, 1),
          profile: makeDiskProfile(),
          socketJointId: sourceJointTopId,
        },
      },
    ],
    braces: [
      {
        id: sourceBraceId,
        modelId: SOURCE_MODEL_ID,
        startKnotId: sourceParentKnotId,
        endKnotId: sourceEndKnotId,
        profile: {
          diameter: 0.6,
        },
      },
    ],
    knots: [
      {
        id: sourceParentKnotId,
        parentShaftId: sourceSegmentId,
        t: 0.2,
        pos: makeVec3(0, 0, 3),
        diameter: 0.9,
      },
      {
        id: sourceEndKnotId,
        parentShaftId: `braceSegment:${sourceBraceId}`,
        t: 0.8,
        pos: makeVec3(0, 0, 5),
        diameter: 0.9,
      },
    ],
    supportBraceRoots: [
      {
        id: 'support-brace-root-source',
        modelId: SOURCE_MODEL_ID,
        transform: {
          pos: makeVec3(0, 0, 0),
          rot: { x: 0, y: 0, z: 0, w: 1 },
        },
        diameter: 2,
        diskHeight: 0.5,
        coneHeight: 0.8,
      },
    ],
    supportBraceKnots: [
      {
        id: 'support-brace-knot-source',
        parentShaftId: 'support-brace-seg-source',
        t: 0.5,
        pos: makeVec3(0, 0, 4),
        diameter: 0.7,
      },
    ],
    supportBraces: [
      {
        id: 'support-brace-source',
        modelId: SOURCE_MODEL_ID,
        rootId: 'support-brace-root-source',
        hostKnotId: 'support-brace-knot-source',
        hostSegmentId: sourceSegmentId,
        hostMinT: 0,
        segments: [
          {
            id: 'support-brace-seg-source',
            type: 'straight',
            diameter: 0.7,
            bottomJoint: {
              id: 'support-brace-j0-source',
              pos: makeVec3(0, 0, 2),
              diameter: 0.8,
            },
            topJoint: {
              id: 'support-brace-j1-source',
              pos: makeVec3(0, 0, 6),
              diameter: 0.8,
            },
          },
        ],
        profile: {
          bodyDiameterMm: 0.7,
          terminalStartDiameterMm: 0.7,
          terminalEndDiameterMm: 0.9,
        },
      },
    ],
  };
}

describe('support clipboard remap isolation', () => {
  beforeEach(() => {
    resetStore();
    setSupportBraceSnapshot({
      supportBraces: {},
      roots: {},
      knots: {},
      selectedId: null,
    });
  });

  it('never keeps source graph IDs in pasted references', () => {
    const payload = makePayload();

    const sourceTransform = {
      position: new THREE.Vector3(0, 0, 0),
      rotation: new THREE.Euler(0, 0, 0),
      scale: new THREE.Vector3(1, 1, 1),
    };

    const targetTransform = {
      position: new THREE.Vector3(10, 10, 0),
      rotation: new THREE.Euler(0, 0, 0),
      scale: new THREE.Vector3(1, 1, 1),
    };

    const pastedCount = pasteModelSupportsFromClipboard(payload, TARGET_MODEL_ID, sourceTransform, targetTransform);
    assert.ok(pastedCount > 0);

    const state = getSnapshot();
    const supportBraceState = getSupportBraceSnapshot();

    const sourceIds = new Set<string>([
      ...payload.roots.map((item) => item.id),
      ...payload.trunks.map((item) => item.id),
      ...payload.branches.map((item) => item.id),
      ...payload.leaves.map((item) => item.id),
      ...payload.twigs.map((item) => item.id),
      ...payload.sticks.map((item) => item.id),
      ...payload.braces.map((item) => item.id),
      ...payload.knots.map((item) => item.id),
      ...payload.trunks.flatMap((item) => item.segments.map((segment) => segment.id)),
      ...payload.branches.flatMap((item) => item.segments.map((segment) => segment.id)),
      ...payload.twigs.flatMap((item) => item.segments.map((segment) => segment.id)),
      ...payload.sticks.flatMap((item) => item.segments.map((segment) => segment.id)),
      ...payload.supportBraceRoots.map((item) => item.id),
      ...payload.supportBraceKnots.map((item) => item.id),
      ...payload.supportBraces.map((item) => item.id),
      ...payload.supportBraces.flatMap((item) => item.segments.map((segment) => segment.id)),
    ]);

    const sourceJointIds = new Set<string>([
      ...payload.trunks.flatMap((item) => item.segments.flatMap((segment) => [segment.bottomJoint?.id, segment.topJoint?.id]).filter(Boolean) as string[]),
      ...payload.branches.flatMap((item) => item.segments.flatMap((segment) => [segment.bottomJoint?.id, segment.topJoint?.id]).filter(Boolean) as string[]),
      ...payload.twigs.flatMap((item) => item.segments.flatMap((segment) => [segment.bottomJoint?.id, segment.topJoint?.id]).filter(Boolean) as string[]),
      ...payload.sticks.flatMap((item) => item.segments.flatMap((segment) => [segment.bottomJoint?.id, segment.topJoint?.id]).filter(Boolean) as string[]),
      ...payload.supportBraces.flatMap((item) => item.segments.flatMap((segment) => [segment.bottomJoint?.id, segment.topJoint?.id]).filter(Boolean) as string[]),
      ...payload.trunks.map((item) => item.contactCone?.socketJointId).filter(Boolean) as string[],
      ...payload.branches.map((item) => item.contactCone?.socketJointId).filter(Boolean) as string[],
      ...payload.leaves.map((item) => item.contactCone?.socketJointId).filter(Boolean) as string[],
      ...payload.sticks.flatMap((item) => [item.contactConeA?.socketJointId, item.contactConeB?.socketJointId]).filter(Boolean) as string[],
    ]);

    const targetTrunks = Object.values(state.trunks).filter((item) => item.modelId === TARGET_MODEL_ID);
    const targetBranches = Object.values(state.branches).filter((item) => item.modelId === TARGET_MODEL_ID);
    const targetLeaves = Object.values(state.leaves).filter((item) => item.modelId === TARGET_MODEL_ID);
    const targetSticks = Object.values(state.sticks).filter((item) => item.modelId === TARGET_MODEL_ID);
    const targetBraces = Object.values(state.braces).filter((item) => item.modelId === TARGET_MODEL_ID);
    const targetSupportBraces = Object.values(supportBraceState.supportBraces).filter((item) => item.modelId === TARGET_MODEL_ID);

    assert.ok(targetTrunks.length > 0);
    assert.ok(targetBranches.length > 0);
    assert.ok(targetLeaves.length > 0);
    assert.ok(targetSticks.length > 0);
    assert.ok(targetBraces.length > 0);
    assert.ok(targetSupportBraces.length > 0);

    for (const trunk of targetTrunks) {
      assert.ok(!sourceIds.has(trunk.rootId));
      if (trunk.contactCone?.socketJointId) {
        assert.ok(!sourceJointIds.has(trunk.contactCone.socketJointId));
      }
      for (const segment of trunk.segments) {
        assert.ok(!sourceIds.has(segment.id));
        if (segment.bottomJoint?.id) assert.ok(!sourceJointIds.has(segment.bottomJoint.id));
        if (segment.topJoint?.id) assert.ok(!sourceJointIds.has(segment.topJoint.id));
      }
    }

    for (const branch of targetBranches) {
      assert.ok(!sourceIds.has(branch.parentKnotId));
      if (branch.contactCone?.socketJointId) {
        assert.ok(!sourceJointIds.has(branch.contactCone.socketJointId));
      }
    }

    for (const leaf of targetLeaves) {
      assert.ok(!sourceIds.has(leaf.parentKnotId));
      if (leaf.contactCone?.socketJointId) {
        assert.ok(!sourceJointIds.has(leaf.contactCone.socketJointId));
      }
    }

    for (const stick of targetSticks) {
      if (stick.contactConeA?.socketJointId) {
        assert.ok(!sourceJointIds.has(stick.contactConeA.socketJointId));
      }
      if (stick.contactConeB?.socketJointId) {
        assert.ok(!sourceJointIds.has(stick.contactConeB.socketJointId));
      }
      for (const segment of stick.segments) {
        assert.ok(!sourceIds.has(segment.id));
      }
    }

    for (const brace of targetBraces) {
      assert.ok(!sourceIds.has(brace.startKnotId));
      assert.ok(!sourceIds.has(brace.endKnotId));
    }

    for (const knot of Object.values(state.knots)) {
      assert.ok(!sourceIds.has(knot.id));
      if (knot.parentShaftId.startsWith('leafCone:')) {
        const leafId = knot.parentShaftId.slice('leafCone:'.length);
        assert.ok(!sourceIds.has(leafId));
      } else if (knot.parentShaftId.startsWith('braceSegment:')) {
        const braceId = knot.parentShaftId.slice('braceSegment:'.length);
        assert.ok(!sourceIds.has(braceId));
      } else {
        assert.ok(!sourceIds.has(knot.parentShaftId));
      }
    }

    for (const supportBrace of targetSupportBraces) {
      assert.ok(!sourceIds.has(supportBrace.rootId));
      assert.ok(!sourceIds.has(supportBrace.hostKnotId));
      assert.ok(!sourceIds.has(supportBrace.hostSegmentId));
      for (const segment of supportBrace.segments) {
        assert.ok(!sourceIds.has(segment.id));
      }
    }

    for (const root of Object.values(supportBraceState.roots)) {
      assert.ok(!sourceIds.has(root.id));
    }

    for (const knot of Object.values(supportBraceState.knots)) {
      assert.ok(!sourceIds.has(knot.id));
      assert.ok(!sourceIds.has(knot.parentShaftId));
    }
  });

  it('captures clipboard payload for source model', () => {
    const payload = makePayload();

    const sourceTransform = {
      position: new THREE.Vector3(0, 0, 0),
      rotation: new THREE.Euler(0, 0, 0),
      scale: new THREE.Vector3(1, 1, 1),
    };

    const targetTransform = {
      position: new THREE.Vector3(0, 0, 0),
      rotation: new THREE.Euler(0, 0, 0),
      scale: new THREE.Vector3(1, 1, 1),
    };

    pasteModelSupportsFromClipboard(payload, SOURCE_MODEL_ID, sourceTransform, targetTransform);
    const captured = captureModelSupportsToClipboard(SOURCE_MODEL_ID);

    assert.ok(captured);
    assert.ok((captured?.roots.length ?? 0) > 0);
    assert.ok((captured?.trunks.length ?? 0) > 0);
  });
});
