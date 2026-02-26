import * as THREE from 'three';
import { getSnapshot, setSnapshot, transformSupportsForModel } from '@/supports/state';
import type { Brace, Branch, Knot, Leaf, Roots, Stick, SupportState, Trunk, Twig } from '@/supports/types';
import {
  getSupportBraceSnapshot,
  setSupportBraceSnapshot,
} from '@/supports/SupportTypes/SupportBrace/supportBraceStore';
import type { SupportBrace, SupportBraceState } from '@/supports/SupportTypes/SupportBrace/types';
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
