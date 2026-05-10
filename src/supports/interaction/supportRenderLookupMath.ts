import type { Knot, SupportState } from '../types';
import type { KickstandState } from '../SupportTypes/Kickstand/types';

export interface SupportRenderLookupSnapshot {
  supportIdBySegmentId: Record<string, string>;
  supportIdByJointId: Record<string, string>;
  supportIdByKnotId: Record<string, string>;
  supportIdByContactDiskId: Record<string, string>;
  entitySegmentModelIdById: Record<string, string | undefined>;
  entityModelIdByKnotId: Record<string, string | undefined>;
  knotIdsByParentShaftId: Record<string, string[]>;
  kickstandKnotIdsByParentShaftId: Record<string, string[]>;
  previewCandidateKnots: Record<string, Knot>;
}

export interface SupportRenderLookupInput {
  state: Pick<SupportState, 'roots' | 'trunks' | 'branches' | 'leaves' | 'twigs' | 'sticks' | 'braces' | 'knots'>;
  kickstandState: Pick<KickstandState, 'kickstands' | 'knots'>;
  activePreviewSupport?: {
    kind: 'trunk' | 'branch' | 'kickstand' | null;
    support: { segments: Array<{ id: string }> } | null;
  } | null;
}

export interface SupportRenderLookupComputeOptions {
  shouldAbort?: () => boolean;
}

export function computeSupportRenderLookup(input: SupportRenderLookupInput, options?: SupportRenderLookupComputeOptions): SupportRenderLookupSnapshot {
  const { state, kickstandState, activePreviewSupport } = input;
  const shouldAbort = options?.shouldAbort;

  const supportIdBySegmentId: Record<string, string> = {};
  const supportIdByJointId: Record<string, string> = {};
  const supportIdByKnotId: Record<string, string> = {};
  const supportIdByContactDiskId: Record<string, string> = {};
  const entitySegmentModelIdById: Record<string, string | undefined> = {};
  const entityModelIdByKnotId: Record<string, string | undefined> = {};
  const knotIdsByParentShaftId: Record<string, string[]> = {};
  const kickstandKnotIdsByParentShaftId: Record<string, string[]> = {};

  const pushKnotId = (bucket: Record<string, string[]>, parentShaftId: string, knotId: string) => {
    const list = bucket[parentShaftId] ?? (bucket[parentShaftId] = []);
    list.push(knotId);
  };

  for (const trunk of Object.values(state.trunks)) {
    if (shouldAbort?.()) break;
    for (const segment of trunk.segments) {
      if (shouldAbort?.()) break;
      supportIdBySegmentId[segment.id] = trunk.id;
      entitySegmentModelIdById[segment.id] = trunk.modelId;
      if (segment.topJoint?.id) supportIdByJointId[segment.topJoint.id] = trunk.id;
      if (segment.bottomJoint?.id) supportIdByJointId[segment.bottomJoint.id] = trunk.id;
    }
    if (trunk.contactCone?.id) supportIdByContactDiskId[trunk.contactCone.id] = trunk.id;
  }

  for (const branch of Object.values(state.branches)) {
    if (shouldAbort?.()) break;
    for (const segment of branch.segments) {
      if (shouldAbort?.()) break;
      supportIdBySegmentId[segment.id] = branch.id;
      entitySegmentModelIdById[segment.id] = branch.modelId;
      if (segment.topJoint?.id) supportIdByJointId[segment.topJoint.id] = branch.id;
      if (segment.bottomJoint?.id) supportIdByJointId[segment.bottomJoint.id] = branch.id;
    }
    supportIdByKnotId[branch.parentKnotId] = branch.id;
    pushKnotId(knotIdsByParentShaftId, branch.parentKnotId, branch.parentKnotId);
    entityModelIdByKnotId[branch.parentKnotId] = branch.modelId;
    if (branch.contactCone?.id) supportIdByContactDiskId[branch.contactCone.id] = branch.id;
  }

  for (const leaf of Object.values(state.leaves)) {
    if (shouldAbort?.()) break;
    supportIdByKnotId[leaf.parentKnotId] = leaf.id;
    entityModelIdByKnotId[leaf.parentKnotId] = leaf.modelId;
    if (leaf.contactCone?.id) supportIdByContactDiskId[leaf.contactCone.id] = leaf.id;
  }

  for (const twig of Object.values(state.twigs)) {
    if (shouldAbort?.()) break;
    for (const segment of twig.segments) {
      if (shouldAbort?.()) break;
      supportIdBySegmentId[segment.id] = twig.id;
      entitySegmentModelIdById[segment.id] = twig.modelId;
      if (segment.topJoint?.id) supportIdByJointId[segment.topJoint.id] = twig.id;
      if (segment.bottomJoint?.id) supportIdByJointId[segment.bottomJoint.id] = twig.id;
    }
    if (twig.contactDiskA?.id) supportIdByContactDiskId[twig.contactDiskA.id] = twig.id;
    if (twig.contactDiskB?.id) supportIdByContactDiskId[twig.contactDiskB.id] = twig.id;
  }

  for (const stick of Object.values(state.sticks)) {
    if (shouldAbort?.()) break;
    for (const segment of stick.segments) {
      if (shouldAbort?.()) break;
      supportIdBySegmentId[segment.id] = stick.id;
      entitySegmentModelIdById[segment.id] = stick.modelId;
      if (segment.topJoint?.id) supportIdByJointId[segment.topJoint.id] = stick.id;
      if (segment.bottomJoint?.id) supportIdByJointId[segment.bottomJoint.id] = stick.id;
    }
    if (stick.contactConeA?.id) supportIdByContactDiskId[stick.contactConeA.id] = stick.id;
    if (stick.contactConeB?.id) supportIdByContactDiskId[stick.contactConeB.id] = stick.id;
  }

  for (const brace of Object.values(state.braces)) {
    if (shouldAbort?.()) break;
    const braceSegmentId = `braceSegment:${brace.id}`;
    supportIdBySegmentId[braceSegmentId] = brace.id;
    entitySegmentModelIdById[braceSegmentId] = brace.modelId;
    supportIdByKnotId[brace.startKnotId] = brace.id;
    supportIdByKnotId[brace.endKnotId] = brace.id;
  }

  for (const knot of Object.values(state.knots)) {
    if (shouldAbort?.()) break;
    const parentSupportId = supportIdBySegmentId[knot.parentShaftId];
    if (parentSupportId) {
      supportIdByKnotId[knot.id] = parentSupportId;
      pushKnotId(knotIdsByParentShaftId, knot.parentShaftId, knot.id);
    }

    if (knot.parentShaftId.startsWith('braceSegment:')) {
      const braceId = knot.parentShaftId.slice('braceSegment:'.length);
      entityModelIdByKnotId[knot.id] = state.braces[braceId]?.modelId;
    } else if (knot.parentShaftId.startsWith('leafCone:')) {
      const leafId = knot.parentShaftId.slice('leafCone:'.length);
      entityModelIdByKnotId[knot.id] = state.leaves[leafId]?.modelId;
    } else {
      entityModelIdByKnotId[knot.id] = entitySegmentModelIdById[knot.parentShaftId];
    }
  }

  for (const knot of Object.values(kickstandState.knots)) {
    if (shouldAbort?.()) break;
    const parentShaftId = knot.parentShaftId;
    entityModelIdByKnotId[knot.id] = parentShaftId.startsWith('braceSegment:')
      ? state.braces[parentShaftId.slice('braceSegment:'.length)]?.modelId
      : parentShaftId.startsWith('leafCone:')
        ? state.leaves[parentShaftId.slice('leafCone:'.length)]?.modelId
        : entitySegmentModelIdById[parentShaftId];
    const parentSupportId = supportIdBySegmentId[parentShaftId];
    if (parentSupportId) {
      supportIdByKnotId[knot.id] = parentSupportId;
      pushKnotId(knotIdsByParentShaftId, parentShaftId, knot.id);
    }

    pushKnotId(kickstandKnotIdsByParentShaftId, parentShaftId, knot.id);
  }

  const previewCandidateKnots: Record<string, Knot> = {};
  const previewSupport = activePreviewSupport?.support;
  if (activePreviewSupport && previewSupport) {
    for (const segment of previewSupport.segments) {
      if (shouldAbort?.()) break;
      const sharedIds = knotIdsByParentShaftId[segment.id] ?? [];
      for (const knotId of sharedIds) {
        if (shouldAbort?.()) break;
        const knot = state.knots[knotId];
        if (knot) previewCandidateKnots[knotId] = knot;
      }

      const kickstandIds = kickstandKnotIdsByParentShaftId[segment.id] ?? [];
      for (const knotId of kickstandIds) {
        if (shouldAbort?.()) break;
        const knot = kickstandState.knots[knotId];
        if (knot) previewCandidateKnots[knotId] = knot;
      }
    }
  }

  return {
    supportIdBySegmentId,
    supportIdByJointId,
    supportIdByKnotId,
    supportIdByContactDiskId,
    entitySegmentModelIdById,
    entityModelIdByKnotId,
    knotIdsByParentShaftId,
    kickstandKnotIdsByParentShaftId,
    previewCandidateKnots,
  };
}
