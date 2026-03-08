import * as THREE from 'three';
import { getSnapshot, setSnapshot, transformSupportsForModel } from '@/supports/state';
import type { Brace, Branch, Knot, Leaf, Roots, Stick, SupportState, Trunk, Twig } from '@/supports/types';
import {
  getSupportBraceSnapshot,
  setSupportBraceSnapshot,
} from '@/supports/SupportTypes/SupportBrace/supportBraceStore';
import type { SupportBrace, SupportBraceState } from '@/supports/SupportTypes/SupportBrace/types';
import { getRaftSettings } from '@/supports/Rafts/Crenelated/RaftState';
import { computeFootprint } from '@/supports/Rafts/Crenelated/geometry/computeFootprint';
import { computeRaftOuterBoundary } from '@/supports/Rafts/Crenelated/geometry/computeRaftOuterBoundary';
import type { SupportBaseCircle } from '@/supports/Rafts/Crenelated/RaftTypes';
import { generateUuid } from '@/utils/uuid';

type SupportClipboardPayload = {
  roots: Roots[];
  trunks: Trunk[];
  branches: Branch[];
  leaves: Leaf[];
  twigs: Twig[];
  sticks: Stick[];
  braces: Brace[];
  knots: Knot[];
  supportBraceRoots: Roots[];
  supportBraceKnots: Knot[];
  supportBraces: SupportBrace[];
};

export type SupportModelBounds2D = {
  minX: number;
  maxX: number;
  minY: number;
  maxY: number;
};

function clonePlain<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

function getOrCreateMappedId(sourceId: string, idMap: Map<string, string>): string {
  const mapped = idMap.get(sourceId);
  if (mapped) return mapped;
  const created = generateUuid();
  idMap.set(sourceId, created);
  return created;
}

function remapSupportJoint<T extends { id: string; pos: { x: number; y: number; z: number }; diameter: number }>(
  joint: T | undefined,
  jointIdMap: Map<string, string>,
): T | undefined {
  if (!joint) return joint;
  const mappedId = getOrCreateMappedId(joint.id, jointIdMap);
  return {
    ...joint,
    id: mappedId,
  };
}

function extractSupportClipboardPayload(modelId: string): SupportClipboardPayload | null {
  const state = getSnapshot();
  const supportBraceState = getSupportBraceSnapshot();

  const roots = Object.values(state.roots).filter((item) => item.modelId === modelId).map(clonePlain);
  const trunks = Object.values(state.trunks).filter((item) => item.modelId === modelId).map(clonePlain);
  const branches = Object.values(state.branches).filter((item) => item.modelId === modelId).map(clonePlain);
  const leaves = Object.values(state.leaves).filter((item) => item.modelId === modelId).map(clonePlain);
  const twigs = Object.values(state.twigs).filter((item) => item.modelId === modelId).map(clonePlain);
  const sticks = Object.values(state.sticks).filter((item) => item.modelId === modelId).map(clonePlain);
  const braces = Object.values(state.braces).filter((item) => item.modelId === modelId).map(clonePlain);

  const supportBraces = Object.values(supportBraceState.supportBraces)
    .filter((item) => item.modelId === modelId)
    .map(clonePlain);
  const supportBraceRootIds = new Set(supportBraces.map((item) => item.rootId));
  const supportBraceKnotIds = new Set(supportBraces.map((item) => item.hostKnotId));
  const supportBraceRoots = Object.values(supportBraceState.roots)
    .filter((item) => supportBraceRootIds.has(item.id))
    .map(clonePlain);
  const supportBraceKnots = Object.values(supportBraceState.knots)
    .filter((item) => supportBraceKnotIds.has(item.id))
    .map(clonePlain);

  const includedSegmentIds = new Set<string>();
  trunks.forEach((item) => item.segments.forEach((segment) => includedSegmentIds.add(segment.id)));
  branches.forEach((item) => item.segments.forEach((segment) => includedSegmentIds.add(segment.id)));
  twigs.forEach((item) => item.segments.forEach((segment) => includedSegmentIds.add(segment.id)));
  sticks.forEach((item) => item.segments.forEach((segment) => includedSegmentIds.add(segment.id)));
  braces.forEach((item) => includedSegmentIds.add(`braceSegment:${item.id}`));

  const referencedKnotIds = new Set<string>();
  branches.forEach((item) => referencedKnotIds.add(item.parentKnotId));
  leaves.forEach((item) => referencedKnotIds.add(item.parentKnotId));
  braces.forEach((item) => {
    referencedKnotIds.add(item.startKnotId);
    referencedKnotIds.add(item.endKnotId);
  });

  const leafIds = new Set(leaves.map((item) => item.id));
  const braceIds = new Set(braces.map((item) => item.id));

  const knots = Object.values(state.knots)
    .filter((item) => {
      if (referencedKnotIds.has(item.id)) return true;
      if (includedSegmentIds.has(item.parentShaftId)) return true;
      if (item.parentShaftId.startsWith('leafCone:')) {
        const leafId = item.parentShaftId.slice('leafCone:'.length);
        return leafIds.has(leafId);
      }
      if (item.parentShaftId.startsWith('braceSegment:')) {
        const braceId = item.parentShaftId.slice('braceSegment:'.length);
        return braceIds.has(braceId);
      }
      return false;
    })
    .map(clonePlain);

  const hasData = roots.length > 0
    || trunks.length > 0
    || branches.length > 0
    || leaves.length > 0
    || twigs.length > 0
    || sticks.length > 0
    || braces.length > 0
    || knots.length > 0
    || supportBraces.length > 0
    || supportBraceRoots.length > 0
    || supportBraceKnots.length > 0;

  if (!hasData) return null;

  return {
    roots,
    trunks,
    branches,
    leaves,
    twigs,
    sticks,
    braces,
    knots,
    supportBraceRoots,
    supportBraceKnots,
    supportBraces,
  };
}

function mergeSupportClipboardPayload(
  payload: SupportClipboardPayload,
  targetModelId: string,
): { mergedState: SupportState; mergedSupportBraceState: SupportBraceState } {
  const state = getSnapshot();
  const supportBraceState = getSupportBraceSnapshot();

  const rootIdMap = new Map<string, string>();
  const knotIdMap = new Map<string, string>();
  const branchIdMap = new Map<string, string>();
  const leafIdMap = new Map<string, string>();
  const twigIdMap = new Map<string, string>();
  const stickIdMap = new Map<string, string>();
  const braceIdMap = new Map<string, string>();
  const supportBraceRootIdMap = new Map<string, string>();
  const supportBraceKnotIdMap = new Map<string, string>();
  const supportBraceIdMap = new Map<string, string>();
  const segmentIdMap = new Map<string, string>();
  const jointIdMap = new Map<string, string>();

  const clonedRoots = payload.roots.map((root) => {
    const id = generateUuid();
    rootIdMap.set(root.id, id);
    return {
      ...clonePlain(root),
      id,
      modelId: targetModelId,
    };
  });

  const clonedTrunks = payload.trunks.map((trunk) => {
    const id = generateUuid();
    const clonedSegments = trunk.segments.map((segment) => {
      const segmentId = generateUuid();
      segmentIdMap.set(segment.id, segmentId);
      return {
        ...clonePlain(segment),
        id: segmentId,
        topJoint: remapSupportJoint(segment.topJoint, jointIdMap),
        bottomJoint: remapSupportJoint(segment.bottomJoint, jointIdMap),
      };
    });

    return {
      ...clonePlain(trunk),
      id,
      modelId: targetModelId,
      rootId: getOrCreateMappedId(trunk.rootId, rootIdMap),
      segments: clonedSegments,
      contactCone: trunk.contactCone
        ? {
            ...clonePlain(trunk.contactCone),
            id: generateUuid(),
            socketJointId: trunk.contactCone.socketJointId
              ? getOrCreateMappedId(trunk.contactCone.socketJointId, jointIdMap)
              : trunk.contactCone.socketJointId,
          }
        : trunk.contactCone,
    } as Trunk;
  });

  payload.knots.forEach((knot) => {
    knotIdMap.set(knot.id, generateUuid());
  });

  const clonedBranches = payload.branches.map((branch) => {
    const id = generateUuid();
    branchIdMap.set(branch.id, id);

    const clonedSegments = branch.segments.map((segment) => {
      const segmentId = generateUuid();
      segmentIdMap.set(segment.id, segmentId);
      return {
        ...clonePlain(segment),
        id: segmentId,
        topJoint: remapSupportJoint(segment.topJoint, jointIdMap),
        bottomJoint: remapSupportJoint(segment.bottomJoint, jointIdMap),
      };
    });

    return {
      ...clonePlain(branch),
      id,
      modelId: targetModelId,
      parentKnotId: getOrCreateMappedId(branch.parentKnotId, knotIdMap),
      segments: clonedSegments,
      contactCone: branch.contactCone
        ? {
            ...clonePlain(branch.contactCone),
            id: generateUuid(),
            socketJointId: branch.contactCone.socketJointId
              ? getOrCreateMappedId(branch.contactCone.socketJointId, jointIdMap)
              : branch.contactCone.socketJointId,
          }
        : branch.contactCone,
    } as Branch;
  });

  const clonedLeaves = payload.leaves.map((leaf) => {
    const id = generateUuid();
    leafIdMap.set(leaf.id, id);
    return {
      ...clonePlain(leaf),
      id,
      modelId: targetModelId,
      parentKnotId: getOrCreateMappedId(leaf.parentKnotId, knotIdMap),
      contactCone: {
        ...clonePlain(leaf.contactCone),
        id: generateUuid(),
        socketJointId: leaf.contactCone.socketJointId
          ? getOrCreateMappedId(leaf.contactCone.socketJointId, jointIdMap)
          : leaf.contactCone.socketJointId,
      },
    } as Leaf;
  });

  const clonedTwigs = payload.twigs.map((twig) => {
    const id = generateUuid();
    twigIdMap.set(twig.id, id);

    const clonedSegments = twig.segments.map((segment) => {
      const segmentId = generateUuid();
      segmentIdMap.set(segment.id, segmentId);
      return {
        ...clonePlain(segment),
        id: segmentId,
        topJoint: remapSupportJoint(segment.topJoint, jointIdMap),
        bottomJoint: remapSupportJoint(segment.bottomJoint, jointIdMap),
      };
    });

    return {
      ...clonePlain(twig),
      id,
      modelId: targetModelId,
      segments: clonedSegments,
      contactDiskA: {
        ...clonePlain(twig.contactDiskA),
        id: generateUuid(),
      },
      contactDiskB: {
        ...clonePlain(twig.contactDiskB),
        id: generateUuid(),
      },
    } as Twig;
  });

  const clonedSticks = payload.sticks.map((stick) => {
    const id = generateUuid();
    stickIdMap.set(stick.id, id);

    const clonedSegments = stick.segments.map((segment) => {
      const segmentId = generateUuid();
      segmentIdMap.set(segment.id, segmentId);
      return {
        ...clonePlain(segment),
        id: segmentId,
        topJoint: remapSupportJoint(segment.topJoint, jointIdMap),
        bottomJoint: remapSupportJoint(segment.bottomJoint, jointIdMap),
      };
    });

    return {
      ...clonePlain(stick),
      id,
      modelId: targetModelId,
      segments: clonedSegments,
      contactConeA: {
        ...clonePlain(stick.contactConeA),
        id: generateUuid(),
        socketJointId: stick.contactConeA.socketJointId
          ? getOrCreateMappedId(stick.contactConeA.socketJointId, jointIdMap)
          : stick.contactConeA.socketJointId,
      },
      contactConeB: {
        ...clonePlain(stick.contactConeB),
        id: generateUuid(),
        socketJointId: stick.contactConeB.socketJointId
          ? getOrCreateMappedId(stick.contactConeB.socketJointId, jointIdMap)
          : stick.contactConeB.socketJointId,
      },
    } as Stick;
  });

  const clonedBraces = payload.braces.map((brace) => {
    const id = generateUuid();
    braceIdMap.set(brace.id, id);
    return {
      ...clonePlain(brace),
      id,
      modelId: targetModelId,
      startKnotId: getOrCreateMappedId(brace.startKnotId, knotIdMap),
      endKnotId: getOrCreateMappedId(brace.endKnotId, knotIdMap),
    } as Brace;
  });

  const clonedKnots = payload.knots.map((knot) => {
    const id = knotIdMap.get(knot.id) ?? generateUuid();

    let parentShaftId = knot.parentShaftId;
    if (parentShaftId.startsWith('leafCone:')) {
      const leafId = parentShaftId.slice('leafCone:'.length);
      parentShaftId = `leafCone:${getOrCreateMappedId(leafId, leafIdMap)}`;
    } else if (parentShaftId.startsWith('braceSegment:')) {
      const braceId = parentShaftId.slice('braceSegment:'.length);
      parentShaftId = `braceSegment:${getOrCreateMappedId(braceId, braceIdMap)}`;
    } else {
      parentShaftId = getOrCreateMappedId(parentShaftId, segmentIdMap);
    }

    return {
      ...clonePlain(knot),
      id,
      parentShaftId,
    } as Knot;
  });

  const clonedSupportBraceRoots = payload.supportBraceRoots.map((root) => {
    const id = generateUuid();
    supportBraceRootIdMap.set(root.id, id);
    return {
      ...clonePlain(root),
      id,
      modelId: targetModelId,
    };
  });

  const clonedSupportBraceKnots = payload.supportBraceKnots.map((knot) => {
    const id = generateUuid();
    supportBraceKnotIdMap.set(knot.id, id);
    return {
      ...clonePlain(knot),
      id,
      parentShaftId: getOrCreateMappedId(knot.parentShaftId, segmentIdMap),
    };
  });

  const clonedSupportBraces = payload.supportBraces.map((supportBrace) => {
    const id = generateUuid();
    supportBraceIdMap.set(supportBrace.id, id);

    const clonedSegments = supportBrace.segments.map((segment) => {
      const segmentId = getOrCreateMappedId(segment.id, segmentIdMap);
      return {
        ...clonePlain(segment),
        id: segmentId,
        topJoint: remapSupportJoint(segment.topJoint, jointIdMap),
        bottomJoint: remapSupportJoint(segment.bottomJoint, jointIdMap),
      };
    });

    return {
      ...clonePlain(supportBrace),
      id,
      modelId: targetModelId,
      rootId: getOrCreateMappedId(supportBrace.rootId, supportBraceRootIdMap),
      hostKnotId: getOrCreateMappedId(supportBrace.hostKnotId, supportBraceKnotIdMap),
      hostSegmentId: getOrCreateMappedId(supportBrace.hostSegmentId, segmentIdMap),
      segments: clonedSegments,
    } as SupportBrace;
  });

  const mergedState: SupportState = {
    ...state,
    roots: {
      ...state.roots,
      ...Object.fromEntries(clonedRoots.map((item) => [item.id, item])),
    },
    trunks: {
      ...state.trunks,
      ...Object.fromEntries(clonedTrunks.map((item) => [item.id, item])),
    },
    branches: {
      ...state.branches,
      ...Object.fromEntries(clonedBranches.map((item) => [item.id, item])),
    },
    leaves: {
      ...state.leaves,
      ...Object.fromEntries(clonedLeaves.map((item) => [item.id, item])),
    },
    twigs: {
      ...state.twigs,
      ...Object.fromEntries(clonedTwigs.map((item) => [item.id, item])),
    },
    sticks: {
      ...state.sticks,
      ...Object.fromEntries(clonedSticks.map((item) => [item.id, item])),
    },
    braces: {
      ...state.braces,
      ...Object.fromEntries(clonedBraces.map((item) => [item.id, item])),
    },
    knots: {
      ...state.knots,
      ...Object.fromEntries(clonedKnots.map((item) => [item.id, item])),
    },
  };

  const mergedSupportBraceState: SupportBraceState = {
    ...supportBraceState,
    supportBraces: {
      ...supportBraceState.supportBraces,
      ...Object.fromEntries(clonedSupportBraces.map((item) => [item.id, item])),
    },
    roots: {
      ...supportBraceState.roots,
      ...Object.fromEntries(clonedSupportBraceRoots.map((item) => [item.id, item])),
    },
    knots: {
      ...supportBraceState.knots,
      ...Object.fromEntries(clonedSupportBraceKnots.map((item) => [item.id, item])),
    },
  };

  return { mergedState, mergedSupportBraceState };
}

export function captureModelSupportsToClipboard(modelId: string): SupportClipboardPayload | null {
  return extractSupportClipboardPayload(modelId);
}

export function estimateSupportBoundsForModel(modelId: string): SupportModelBounds2D | null {
  if (!modelId) return null;

  const state = getSnapshot();
  const supportBraceState = getSupportBraceSnapshot();
  const raftSettings = getRaftSettings();

  let minX = Number.POSITIVE_INFINITY;
  let maxX = Number.NEGATIVE_INFINITY;
  let minY = Number.POSITIVE_INFINITY;
  let maxY = Number.NEGATIVE_INFINITY;
  let hasAny = false;

  const expand = (pos?: { x: number; y: number; z: number } | null, radius = 0) => {
    if (!pos) return;
    const r = Math.max(0, radius);
    minX = Math.min(minX, pos.x - r);
    maxX = Math.max(maxX, pos.x + r);
    minY = Math.min(minY, pos.y - r);
    maxY = Math.max(maxY, pos.y + r);
    hasAny = true;
  };

  const roots = Object.values(state.roots).filter((root) => root.modelId === modelId);
  roots.forEach((root) => {
    const rr = Math.max(0.001, root.diameter / 2);
    expand(root.transform.pos, rr);
    expand({
      x: root.transform.pos.x,
      y: root.transform.pos.y,
      z: root.transform.pos.z + Math.max(0, root.diskHeight) + Math.max(0, root.coneHeight),
    }, rr);
  });

  if (raftSettings.bottomMode !== 'off' && roots.length > 0) {
    const circles: SupportBaseCircle[] = roots.map((root) => ({
      x: root.transform.pos.x,
      y: root.transform.pos.y,
      r: root.diameter / 2,
    }));

    const chamferInset = raftSettings.bottomMode === 'line'
      ? Math.max(0, raftSettings.lineHeightMm) * Math.tan((Math.PI / 180) * (90 - Math.min(90, Math.max(45, raftSettings.chamferAngle))))
      : 0;

    const baseProfile = computeFootprint(circles, {
      marginMm: 0.2 + chamferInset,
      samplesPerCircle: 24,
    });

    if (baseProfile && baseProfile.length >= 3) {
      const outerProfile = raftSettings.wallEnabled
        ? computeRaftOuterBoundary(baseProfile, raftSettings)
        : baseProfile;
      outerProfile.forEach((point) => expand({ x: point.x, y: point.y, z: 0 }, 0));
    }
  }

  Object.values(state.knots)
    .filter((knot) => knot.modelId === modelId)
    .forEach((knot) => expand(knot.pos, Math.max(0.001, (knot.diameter ?? 1.2) / 2)));

  Object.values(supportBraceState.knots)
    .filter((knot) => knot.modelId === modelId)
    .forEach((knot) => expand(knot.pos, Math.max(0.001, (knot.diameter ?? 1.2) / 2)));

  const expandSegments = (segments: Array<any>) => {
    segments.forEach((segment) => {
      expand(segment.topJoint?.pos, Math.max(0.001, (segment.topJoint?.diameter ?? segment.diameter) / 2));
      expand(segment.bottomJoint?.pos, Math.max(0.001, (segment.bottomJoint?.diameter ?? segment.diameter) / 2));
    });
  };

  Object.values(state.trunks).filter((trunk) => trunk.modelId === modelId).forEach((trunk) => {
    expandSegments(trunk.segments as any[]);
    if (trunk.contactCone) {
      expand(trunk.contactCone.pos, Math.max(0.001, trunk.contactCone.profile.contactDiameterMm / 2));
    }
  });

  Object.values(state.branches).filter((branch) => branch.modelId === modelId).forEach((branch) => {
    expandSegments(branch.segments as any[]);
    if (branch.contactCone) {
      expand(branch.contactCone.pos, Math.max(0.001, branch.contactCone.profile.contactDiameterMm / 2));
    }
  });

  Object.values(state.leaves).filter((leaf) => leaf.modelId === modelId).forEach((leaf) => {
    if (!leaf.contactCone) return;
    expand(leaf.contactCone.pos, Math.max(0.001, leaf.contactCone.profile.contactDiameterMm / 2));
  });

  Object.values(state.twigs).filter((twig) => twig.modelId === modelId).forEach((twig) => {
    expandSegments(twig.segments as any[]);
    expand(twig.contactDiskA.pos, Math.max(0.001, twig.contactDiskA.contactDiameterMm / 2));
    expand(twig.contactDiskB.pos, Math.max(0.001, twig.contactDiskB.contactDiameterMm / 2));
  });

  Object.values(state.sticks).filter((stick) => stick.modelId === modelId).forEach((stick) => {
    expandSegments(stick.segments as any[]);
    expand(stick.contactConeA.pos, Math.max(0.001, stick.contactConeA.profile.contactDiameterMm / 2));
    expand(stick.contactConeB.pos, Math.max(0.001, stick.contactConeB.profile.contactDiameterMm / 2));
  });

  Object.values(supportBraceState.supportBraces)
    .filter((supportBrace) => supportBrace.modelId === modelId)
    .forEach((supportBrace) => expandSegments(supportBrace.segments as any[]));

  return hasAny ? { minX, maxX, minY, maxY } : null;
}

export function pasteModelSupportsFromClipboard(
  payload: SupportClipboardPayload | null | undefined,
  targetModelId: string,
  sourceTransform: { position: THREE.Vector3; rotation: THREE.Euler; scale: THREE.Vector3 },
  targetTransform: { position: THREE.Vector3; rotation: THREE.Euler; scale: THREE.Vector3 },
): number {
  if (!payload || !targetModelId) return 0;

  const hasSupports = payload.roots.length
    + payload.trunks.length
    + payload.branches.length
    + payload.leaves.length
    + payload.twigs.length
    + payload.sticks.length
    + payload.braces.length
    + payload.supportBraces.length;

  if (hasSupports === 0) return 0;

  const { mergedState, mergedSupportBraceState } = mergeSupportClipboardPayload(payload, targetModelId);
  setSnapshot(mergedState);
  setSupportBraceSnapshot(mergedSupportBraceState);

  transformSupportsForModel(targetModelId, sourceTransform, targetTransform);
  return hasSupports;
}

export type { SupportClipboardPayload };
