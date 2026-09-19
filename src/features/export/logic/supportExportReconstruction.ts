import * as THREE from 'three';
import { getModelIdForSupportEntityId } from '@/supports/state';
import type { KickstandBuildResult } from '@/supports/SupportTypes/Kickstand/types';
import { buildSupportExportGroup, type SupportExportContext } from '@/supports/exportGeometry/seam';
import { importPayloadCollections } from '@/supports/supportCollections';
import { exportGroupName, getSupportTypeDescriptor, parseKnotHostId, parsePrefixedSegmentId, SUPPORT_TYPES, type SupportTypeDescriptor, type SupportTypeId } from '@/supports/supportTypeRegistry';
import type { DragonfruitImportFormat, Segment, SupportState } from '@/supports/types';
import type { SupportCollectionKey } from '@/supports/supportTypeRegistry';

/** One model's supports, one member per declared collection. */
export type ScopedSupportPayload = {
  [K in SupportCollectionKey]: SupportState[K][string][];
};

function hasAllowedModelId(allowedModelIds: ReadonlySet<string>, modelId: string | null | undefined): boolean {
  return typeof modelId === 'string' && allowedModelIds.has(modelId);
}

function firstAllowedModelId(
  allowedModelIds: ReadonlySet<string>,
  ...candidateIds: Array<string | null | undefined>
): string | null {
  for (const candidateId of candidateIds) {
    if (hasAllowedModelId(allowedModelIds, candidateId)) {
      return candidateId!;
    }
  }

  return null;
}

/** Resolves an entity id to its owning modelId. */
type ModelIdResolver = (id: string | null | undefined) => string | null;

/**
 * An O(1) `entityId -> modelId` resolver, backed by reverse indices built once
 * rather than scanning the graph per call. Index order mirrors
 * {@link getModelIdForSupportEntityId} so ambiguous ids resolve the same way.
 */
function createScopedModelIdResolver(
  supportState: SupportState,
): ModelIdResolver {
  // Ids reachable in the canonical resolver only via linear scans: segment and
  // joint ids, brace start/end knots, and kickstand host knots + segments.
  const scanModelId = new Map<string, string | null>();
  const registerScan = (id: string | null | undefined, modelId: string | null): void => {
    if (id && !scanModelId.has(id)) scanModelId.set(id, modelId);
  };
  const registerSegments = (segments: Segment[], modelId: string | null): void => {
    for (const segment of segments) {
      registerScan(segment.id, modelId);
      registerScan(segment.topJoint?.id, modelId);
      registerScan(segment.bottomJoint?.id, modelId);
    }
  };

  // Every type's shafts and the knots it hangs from, by declaration.
  for (const descriptor of SUPPORT_TYPES) {
    const collection = supportState[descriptor.location.key] as unknown as Record<string, Record<string, unknown>>;

    for (const entity of Object.values(collection ?? {})) {
      const modelId = (entity.modelId as string | undefined) ?? null;

      if (descriptor.hasSegments) {
        registerSegments(entity.segments as Segment[], modelId);
      }
      for (const edge of descriptor.edges) {
        if (edge.to !== 'knots' || edge.ownership !== 'hostedBy') continue;
        const knotId = entity[edge.field];
        if (typeof knotId === 'string') registerScan(knotId, modelId);
      }
    }
  }

  // Knot fallbacks: a knot inherits from a branch/leaf that names it as parent.
  const branchByParentKnot = new Map<string, string | null>();
  for (const branch of Object.values(supportState.branches)) {
    if (!branchByParentKnot.has(branch.parentKnotId)) branchByParentKnot.set(branch.parentKnotId, branch.modelId ?? null);
  }
  const leafByParentKnot = new Map<string, string | null>();
  for (const leaf of Object.values(supportState.leaves)) {
    if (!leafByParentKnot.has(leaf.parentKnotId)) leafByParentKnot.set(leaf.parentKnotId, leaf.modelId ?? null);
  }

  const resolve: ModelIdResolver = (id) => {
    if (!id) return null;

    const span = parsePrefixedSegmentId(id);
    if (span) {
      return supportState.braces[span.entityId]?.modelId ?? null;
    }

    if (supportState.roots[id]) return supportState.roots[id].modelId ?? null;
    for (const descriptor of SUPPORT_TYPES) {
      const entity = (supportState[descriptor.location.key] as unknown as Record<string, { modelId?: string }>)[id];
      if (entity) return entity.modelId ?? null;
    }

    if (scanModelId.has(id)) return scanModelId.get(id) ?? null;

    const knot = supportState.knots[id];
    if (knot) {
      if (knot.parentShaftId) {
        const byParent = resolve(knot.parentShaftId);
        if (byParent) return byParent;
      }
      if (branchByParentKnot.has(id)) return branchByParentKnot.get(id) ?? null;
      if (leafByParentKnot.has(id)) return leafByParentKnot.get(id) ?? null;
    }

    return null;
  };

  return resolve;
}

export function extractScopedSupportPayload(
  supportState: SupportState,
  modelIds: Iterable<string>,
): ScopedSupportPayload {
  const allowedModelIds = new Set(Array.from(modelIds).filter((modelId) => modelId.trim().length > 0));

  // Reverse-indexed resolver: O(1) per lookup after an O(N) build, versus the
  // canonical getModelIdForSupportEntityId which linear-scans the whole graph
  // per call. Called once per branch/leaf/brace/kickstand/knot below, so the
  // linear-scan form made this O(N²) — the multi-second autosave freeze.
  const resolveModelId = createScopedModelIdResolver(supportState);

  /**
   * Whether an entity belongs to a requested model.
   *
   * Its own `modelId` first, then the ids it links through -- a branch borrows
   * its parent knot's model, a kickstand its root's, its host knot's or its
   * host segment's. Those fall-backs are the type's declared `edges`, in
   * declared order. `roots` is excluded: following it would pull in a trunk
   * whose root carries a model the trunk does not.
   */
  const belongsToScope = (descriptor: SupportTypeDescriptor, entity: Record<string, unknown>): boolean => {
    const linked = descriptor.edges
      .filter((edge) => edge.to !== 'roots')
      .map((edge) => {
        const linkedId = entity[edge.field];
        return typeof linkedId === 'string' ? resolveModelId(linkedId) : null;
      });

    return firstAllowedModelId(
      allowedModelIds,
      entity.modelId as string | undefined,
      ...linked,
    ) !== null;
  };

  const scoped = <T>(typeId: SupportTypeId): T[] => {
    const descriptor = getSupportTypeDescriptor(typeId);
    const collection = (supportState as unknown as Record<string, unknown>)[descriptor.location.key] as Record<string, Record<string, unknown>> | undefined;
    return Object.values(collection ?? {}).filter((entity) => belongsToScope(descriptor, entity)) as T[];
  };

  const roots = Object.values(supportState.roots)
    .filter((item) => hasAllowedModelId(allowedModelIds, item.modelId));
  /** The scoped lists, by type id. */
  const scopedEntities: Record<SupportTypeId, unknown[]> = {} as Record<SupportTypeId, unknown[]>;
  for (const descriptor of SUPPORT_TYPES) scopedEntities[descriptor.id] = scoped(descriptor.id);

  /** Every scoped entity, with the descriptor that says what it is. */
  const scopedByType: Array<{ descriptor: SupportTypeDescriptor; entities: Record<string, unknown>[] }> =
    SUPPORT_TYPES.map((descriptor) => ({
      descriptor,
      entities: scopedEntities[descriptor.id] as unknown as Record<string, unknown>[],
    }));

  // Shafts carried by the scope: real segments, or a prefixed id for a type
  // that has none.
  const includedSegmentIds = new Set<string>();
  for (const { descriptor, entities } of scopedByType) {
    for (const entity of entities) {
      if (descriptor.segmentSelectionPrefix) {
        includedSegmentIds.add(`${descriptor.segmentSelectionPrefix}${entity.id as string}`);
        continue;
      }
      for (const segment of (entity.segments as Segment[] | undefined) ?? []) {
        includedSegmentIds.add(segment.id);
      }
    }
  }

  // Knots the scope hangs from, by declared `hostedBy knots` edges.
  const referencedKnotIds = new Set<string>();
  for (const { descriptor, entities } of scopedByType) {
    const knotFields = descriptor.edges
      .filter((edge) => edge.to === 'knots' && edge.ownership === 'hostedBy')
      .map((edge) => edge.field);
    if (knotFields.length === 0) continue;

    for (const entity of entities) {
      for (const field of knotFields) {
        const knotId = entity[field];
        if (typeof knotId === 'string') referencedKnotIds.add(knotId);
      }
    }
  }

  const knots = Object.values(supportState.knots)
    .filter((item) => {
      if (referencedKnotIds.has(item.id)) return true;
      if (includedSegmentIds.has(item.parentShaftId)) return true;
      // A knot riding a pseudo-shaft (a leaf's cone, a brace's span) carries
      // the type's declared prefix. Splitting it through the registry means no
      // literal here to fall out of step when a prefix changes.
      const host: { typeId: SupportTypeId; entityId: string } | null = parseKnotHostId(item.parentShaftId);
      if (host) {
        const owners = scopedEntities[host.typeId] as { id: string }[];
        return owners.some((owner) => owner.id === host.entityId);
      }
      return hasAllowedModelId(allowedModelIds, resolveModelId(item.id));
    });

  // Field names are the collection keys; field order follows the registry,
  // which the payload golden records.
  const payload = { roots } as ScopedSupportPayload;
  const byField = payload as unknown as Record<string, unknown>;
  for (const descriptor of SUPPORT_TYPES) {
    byField[descriptor.location.key] = scopedEntities[descriptor.id];
  }
  byField.knots = knots;
  return payload;
}

export function buildScopedSupportExportDocument(
  supportState: SupportState,
  modelIds: Iterable<string>,
  source = 'dragonfruit-voxl',
): DragonfruitImportFormat {
  const payload = extractScopedSupportPayload(supportState, modelIds);
  // A kickstand serialises as a bundle (`serialisedAsBundle`), so the document
  // nests its root and host knot rather than referencing them by id.
  const rootsById = new Map(payload.roots.map((item) => [item.id, item]));
  const knotsById = new Map(payload.knots.map((item) => [item.id, item]));

  const kickstandBuilds: KickstandBuildResult[] = payload.kickstands
    .map((kickstand) => {
      const root = rootsById.get(kickstand.rootId);
      const hostKnot = knotsById.get(kickstand.hostKnotId);
      if (!root || !hostKnot) return null;
      return { root, hostKnot, kickstand };
    })
    .filter((item): item is KickstandBuildResult => item !== null);

  return {
    version: 1,
    meta: {
      source,
      objectCenter: { x: 0, y: 0, z: 0 },
      updatedAt: Date.now(),
    },
    // `kickstands` is rebuilt above from each one's root and host knot, so it
    // is written after the walk.
    ...importPayloadCollections(payload),
    kickstands: kickstandBuilds,
  };
}

export function buildScopedSupportGeometryGroup(
  supportState: SupportState,
  modelIds: Iterable<string>,
): THREE.Group {
  const payload = extractScopedSupportPayload(supportState, modelIds);
  const group = new THREE.Group();
  group.name = 'ScopedSupportExport';

  const context: SupportExportContext = {
    supportState,
    modelIdOf: getModelIdForSupportEntityId,
  };

  // Each type registers how it exports in its own folder; a type that
  // registered none throws rather than exporting nothing.
  for (const descriptor of SUPPORT_TYPES) {
    const rows = (payload as unknown as Record<string, readonly { id: string }[]>)[descriptor.location.key] ?? [];
    for (const entity of rows) {
      const built = buildSupportExportGroup(descriptor.id, entity, context);
      if (!built) continue;
      built.name = exportGroupName(descriptor.id, entity.id);
      group.add(built);
    }
  }

  group.updateMatrixWorld(true);
  return group;
}
