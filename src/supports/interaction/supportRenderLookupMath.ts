import type { Knot, SupportState } from '../types';
import type { SupportCollectionKey } from '../supportTypeRegistry';
import { getSupportTypeDescriptor, parseKnotHostId, SUPPORT_TYPES, SHAFTED_COLLECTION_KEYS } from '../supportTypeRegistry';

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
  state: Pick<SupportState, SupportCollectionKey>;
  activePreviewSupport?: {
    kind: 'trunk' | 'branch' | 'kickstand' | null;
    support: { segments: Array<{ id: string }> } | null;
  } | null;
}

export interface SupportRenderLookupComputeOptions {
  shouldAbort?: () => boolean;
}

export function computeSupportRenderLookup(input: SupportRenderLookupInput, options?: SupportRenderLookupComputeOptions): SupportRenderLookupSnapshot {
  const { state, activePreviewSupport } = input;
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

  /**
   * Register a shafted support's segments and joints. Every segment-bearing type
   * does this identically; only the contact primitives differ, so those stay in
   * the per-type blocks below.
   */
  const registerShaft = (entity: { id: string; modelId?: string; segments: Array<{ id: string; topJoint?: { id: string } | null; bottomJoint?: { id: string } | null }> }) => {
    for (const segment of entity.segments) {
      if (shouldAbort?.()) break;
      supportIdBySegmentId[segment.id] = entity.id;
      entitySegmentModelIdById[segment.id] = entity.modelId;
      if (segment.topJoint?.id) supportIdByJointId[segment.topJoint.id] = entity.id;
      if (segment.bottomJoint?.id) supportIdByJointId[segment.bottomJoint.id] = entity.id;
    }
  };

  for (const key of SHAFTED_COLLECTION_KEYS) {
    if (shouldAbort?.()) break;
    const record = (state as Partial<Record<string, Record<string, unknown>>>)[key];
    if (!record) continue;
    for (const entity of Object.values(record)) {
      if (shouldAbort?.()) break;
      registerShaft(entity as Parameters<typeof registerShaft>[0]);
    }
  }

  // Every contact primitive back to the support carrying it, by declared
  // `contactFields`.
  for (const descriptor of SUPPORT_TYPES) {
    if (descriptor.contactFields.length === 0) continue;
    const record = (state as Partial<Record<string, Record<string, unknown>>>)[descriptor.location.key];
    if (!record) continue;

    for (const entity of Object.values(record)) {
      if (shouldAbort?.()) break;
      const fields = entity as Record<string, { id?: string } | undefined> & { id: string };
      for (const field of descriptor.contactFields) {
        const contactId = fields[field]?.id;
        if (contactId) supportIdByContactDiskId[contactId] = fields.id;
      }
    }
  }

  // A knot-hosted type also indexes the knot it hangs from. `knotIdsByParentShaftId`
  // is keyed by segment id only; a knot id keyed to itself would be unreachable.
  for (const descriptor of SUPPORT_TYPES) {
    const hostEdges = descriptor.edges.filter((edge) => edge.to === 'knots' && edge.ownership === 'hostedBy');
    if (hostEdges.length === 0) continue;
    const record = (state as Partial<Record<string, Record<string, unknown>>>)[descriptor.location.key];
    if (!record) continue;

    for (const entity of Object.values(record)) {
      if (shouldAbort?.()) break;
      const fields = entity as Record<string, unknown> & { id: string; modelId: string };
      for (const edge of hostEdges) {
        const knotId = fields[edge.field] as string | undefined;
        if (!knotId) continue;
        supportIdByKnotId[knotId] = fields.id;
        entityModelIdByKnotId[knotId] = fields.modelId;
      }
    }
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

    // A knot on a pseudo-shaft takes its model from the host entity; the
    // prefix naming that host is declared per type.
    const host = parseKnotHostId(knot.parentShaftId);
    if (host) {
      const collections = state as unknown as Record<string, Record<string, { modelId?: string }>>;
      const collection = collections[getSupportTypeDescriptor(host.typeId).location.key];
      entityModelIdByKnotId[knot.id] = collection?.[host.entityId]?.modelId;
    } else {
      entityModelIdByKnotId[knot.id] = entitySegmentModelIdById[knot.parentShaftId];
    }
  }

  // Host knots are ordinary state.knots entries the loop above already indexed;
  // this only fills the bucket the renderer uses for kickstand-hosted knots.
  for (const kickstand of Object.values(state.kickstands)) {
    if (shouldAbort?.()) break;
    const hostKnot = state.knots[kickstand.hostKnotId];
    if (!hostKnot) continue;
    pushKnotId(kickstandKnotIdsByParentShaftId, hostKnot.parentShaftId, hostKnot.id);
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
        const knot = state.knots[knotId];
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
