import type { Branch, Brace, Knot, Leaf } from '../types';
import { computeJointDragPreviewKnots, type JointDragPreviewSnapshot } from './jointDragPreviewMath';

export function buildBranchesByParentKnotId(branches: Branch[]) {
  const map = new Map<string, Branch[]>();
  for (const branch of branches) {
    const list = map.get(branch.parentKnotId);
    if (list) list.push(branch);
    else map.set(branch.parentKnotId, [branch]);
  }
  return map;
}

export function buildLeafIdsByParentKnotId(leaves: Leaf[]) {
  const map = new Map<string, string[]>();
  for (const leaf of leaves) {
    const list = map.get(leaf.parentKnotId);
    if (list) list.push(leaf.id);
    else map.set(leaf.parentKnotId, [leaf.id]);
  }
  return map;
}

export function buildBraceIdsByKnotId(braces: Brace[]) {
  const map = new Map<string, string[]>();
  for (const brace of braces) {
    const startList = map.get(brace.startKnotId);
    if (startList) startList.push(brace.id);
    else map.set(brace.startKnotId, [brace.id]);

    const endList = map.get(brace.endKnotId);
    if (endList) endList.push(brace.id);
    else map.set(brace.endKnotId, [brace.id]);
  }
  return map;
}

export function buildBranchCandidateKnotIdsByBranchId(
  branches: Branch[],
  knotIdsByParentShaftId: Map<string, string[]>,
) {
  const map = new Map<string, string[]>();

  for (const branch of branches) {
    const knotIds: string[] = [];
    const seen = new Set<string>();

    for (const segment of branch.segments) {
      const segmentKnotIds = knotIdsByParentShaftId.get(segment.id) ?? [];
      for (const knotId of segmentKnotIds) {
        if (seen.has(knotId)) continue;
        seen.add(knotId);
        knotIds.push(knotId);
      }
    }

    if (knotIds.length > 0) {
      map.set(branch.id, knotIds);
    }
  }

  return map;
}

interface ComputeCascadedPreviewKnotOverridesOptions {
  enableCascade: boolean;
  basePreviewKnotOverrides: Record<string, Knot>;
  branchesByParentKnotId: Map<string, Branch[]>;
  branchCandidateKnotIdsByBranchId: Map<string, string[]>;
  branchesById: Record<string, Branch>;
  committedKnotsById: Record<string, Knot>;
}

export function computeCascadedPreviewKnotOverrides({
  enableCascade,
  basePreviewKnotOverrides,
  branchesByParentKnotId,
  branchCandidateKnotIdsByBranchId,
  branchesById,
  committedKnotsById,
}: ComputeCascadedPreviewKnotOverridesOptions) {
  if (!enableCascade) return basePreviewKnotOverrides;
  const merged: Record<string, Knot> = { ...basePreviewKnotOverrides };

  const processedBranchIds = new Set<string>();
  const queuedBranchIds = new Set<string>();
  const branchQueue: string[] = [];
  let branchQueueIndex = 0;

  const enqueueBranchesForKnot = (knotId: string) => {
    const children = branchesByParentKnotId.get(knotId);
    if (!children) return;
    for (const child of children) {
      if (processedBranchIds.has(child.id) || queuedBranchIds.has(child.id)) continue;
      queuedBranchIds.add(child.id);
      branchQueue.push(child.id);
    }
  };

  for (const knotId of Object.keys(merged)) {
    enqueueBranchesForKnot(knotId);
  }

  while (branchQueueIndex < branchQueue.length) {
    const branchId = branchQueue[branchQueueIndex++];
    queuedBranchIds.delete(branchId);
    if (processedBranchIds.has(branchId)) continue;

    const branch = branchesById[branchId];
    if (!branch) continue;

    const parentKnot = merged[branch.parentKnotId];
    if (!parentKnot) {
      processedBranchIds.add(branchId);
      continue;
    }

    const candidateKnotIds = branchCandidateKnotIdsByBranchId.get(branch.id);
    if (!candidateKnotIds || candidateKnotIds.length === 0) {
      processedBranchIds.add(branchId);
      continue;
    }

    const branchPreviewCandidateKnots: Record<string, Knot> = {};
    for (const knotId of candidateKnotIds) {
      const knot = merged[knotId] ?? committedKnotsById[knotId];
      if (knot) branchPreviewCandidateKnots[knotId] = knot;
    }

    const nextBranchPreviewKnots = computeJointDragPreviewKnots(
      { kind: 'branch', supportId: branch.id, support: branch },
      { parentKnot },
      branchPreviewCandidateKnots,
    );

    const changedKnotIds: string[] = [];
    for (const [knotId, knot] of Object.entries(nextBranchPreviewKnots)) {
      const existing = merged[knotId];
      if (!existing || existing.pos.x !== knot.pos.x || existing.pos.y !== knot.pos.y || existing.pos.z !== knot.pos.z || existing.diameter !== knot.diameter) {
        merged[knotId] = knot;
        changedKnotIds.push(knotId);
      }
    }

    for (const knotId of changedKnotIds) {
      enqueueBranchesForKnot(knotId);
    }

    processedBranchIds.add(branchId);
  }

  return merged;
}

interface CollectPreviewLeavesByIdOptions {
  previewKnotOverrideIds: string[];
  previewKnotOverrides: Record<string, Knot>;
  leafIdsByParentKnotId: Map<string, string[]>;
  leavesById: Record<string, Leaf>;
  recomputeLeafPreviewContactCone: (leaf: Leaf, previewKnotPos: { x: number; y: number; z: number }) => Leaf;
}

export function collectPreviewLeavesById({
  previewKnotOverrideIds,
  previewKnotOverrides,
  leafIdsByParentKnotId,
  leavesById,
  recomputeLeafPreviewContactCone,
}: CollectPreviewLeavesByIdOptions) {
  const map = new Map<string, Leaf>();
  for (const knotId of previewKnotOverrideIds) {
    const previewKnot = previewKnotOverrides[knotId];
    if (!previewKnot) continue;

    const leafIds = leafIdsByParentKnotId.get(knotId);
    if (!leafIds) continue;

    for (const leafId of leafIds) {
      const leaf = leavesById[leafId];
      if (!leaf) continue;
      map.set(leaf.id, recomputeLeafPreviewContactCone(leaf, previewKnot.pos));
    }
  }
  return map;
}

interface CollectGhostedBraceIdsOptions {
  activeJointDragPreview: JointDragPreviewSnapshot | null;
  previewKnotOverrideIds: string[];
  braceIdsByKnotId: Map<string, string[]>;
  bracesById: Record<string, Brace>;
  isBraceVisible: (brace: Brace) => boolean;
}

export function collectGhostedBraceIds({
  activeJointDragPreview,
  previewKnotOverrideIds,
  braceIdsByKnotId,
  bracesById,
  isBraceVisible,
}: CollectGhostedBraceIdsOptions) {
  if (!activeJointDragPreview?.support || previewKnotOverrideIds.length === 0) return new Set<string>();

  const ghosted = new Set<string>();
  for (const knotId of previewKnotOverrideIds) {
    const braceIds = braceIdsByKnotId.get(knotId);
    if (!braceIds) continue;

    for (const braceId of braceIds) {
      if (ghosted.has(braceId)) continue;

      const brace = bracesById[braceId];
      if (!brace) continue;
      if (!isBraceVisible(brace)) continue;
      ghosted.add(brace.id);
    }
  }

  return ghosted;
}
