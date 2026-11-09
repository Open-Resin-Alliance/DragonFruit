import type { MessageDescriptor } from '@lingui/core';
import * as THREE from 'three';
import { buildSupportDeltaTransform, getSnapshot, setSnapshot, transformSupportRecord, type SupportDeltaTransform } from '@/supports/state';
import type { Knot, Roots, Segment, SupportState, Vec3 } from '@/supports/types';
import type { Kickstand } from '@/supports/SupportTypes/Kickstand/types';
import { captureSupportEditSnapshot, pushSupportEditHistory } from '@/supports/history/supportEditHistory';
import { getRaftSettings } from '@/supports/Rafts/Crenelated/RaftState';
import { computeFootprint } from '@/supports/Rafts/Crenelated/geometry/computeFootprint';
import { computeRaftOuterBoundary } from '@/supports/Rafts/Crenelated/geometry/computeRaftOuterBoundary';
import type { SupportBaseCircle } from '@/supports/Rafts/Crenelated/RaftTypes';
import { v4 as uuidv4 } from 'uuid';
import { clonePlainData } from '@/utils/plainDataClone';
import { MODEL_ID_COLLECTION_KEYS, SUPPORT_COLLECTION_KEYS, SUPPORT_TYPES, type SupportCollectionKey, type SupportTypeDescriptor } from '@/supports/supportTypeRegistry';
import { PASTE_SUPPORTS_LABEL } from '@/supports/history/supportHistoryLabels';

/**
 * One array per collection, keyed off the registry.
 *
 * `kickstandRoots`/`kickstandKnots` stay separate because a kickstand owns its
 * root and host knot, and paste remaps those as a unit.
 */
type SupportClipboardPayload = {
  [K in SupportCollectionKey]: SupportState[K][string][];
} & {
  kickstandRoots: Roots[];
  kickstandKnots: Knot[];
};

export type SupportModelBounds2D = {
  minX: number;
  maxX: number;
  minY: number;
  maxY: number;
};

function getOrCreateMappedId(sourceId: string, idMap: Map<string, string>): string {
  const mapped = idMap.get(sourceId);
  if (mapped) return mapped;
  const created = uuidv4();
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
  const snapshot = getSnapshot();

  // Every modelId-bearing collection, so a new type is copied unnamed.
  const owned = {} as { [K in SupportCollectionKey]: SupportState[K][string][] };
  for (const key of SUPPORT_COLLECTION_KEYS) {
    (owned as Record<string, unknown[]>)[key] = [];
  }
  for (const key of MODEL_ID_COLLECTION_KEYS) {
    const record = state[key] as Record<string, { modelId?: string }>;
    (owned as Record<string, unknown[]>)[key] = Object.values(record)
      .filter((item) => item.modelId === modelId)
      .map((item) => clonePlainData(item));
  }
  const kickstands = Object.values(snapshot.kickstands)
    .filter((item) => item.modelId === modelId)
    .map((item) => clonePlainData(item));
  const kickstandRootIds = new Set(kickstands.map((item) => item.rootId));
  const kickstandKnotIds = new Set(kickstands.map((item) => item.hostKnotId));
  const kickstandRoots = Object.values(snapshot.roots)
    .filter((item) => kickstandRootIds.has(item.id))
    .map((item) => clonePlainData(item));
  const kickstandKnots = Object.values(snapshot.knots)
    .filter((item) => kickstandKnotIds.has(item.id))
    .map((item) => clonePlainData(item));

  // Every type's segments, by what the registry declares: a shafted type
  // contributes its segment ids, a prefixed one its own id under that prefix.
  const includedSegmentIds = new Set<string>();
  for (const descriptor of SUPPORT_TYPES) {
    const entities = (owned as Record<string, { id: string; segments?: Segment[] }[]>)[descriptor.location.key] ?? [];
    for (const entity of entities) {
      if (descriptor.segmentSelectionPrefix) {
        includedSegmentIds.add(`${descriptor.segmentSelectionPrefix}${entity.id}`);
        continue;
      }
      for (const segment of entity.segments ?? []) includedSegmentIds.add(segment.id);
    }
  }

  // Knots named by a declared edge onto `knots`, whichever type declares it.
  const referencedKnotIds = new Set<string>();
  for (const descriptor of SUPPORT_TYPES) {
    const fields = descriptor.edges
      .filter((edge) => edge.to === 'knots')
      .map((edge) => edge.field);
    if (fields.length === 0) continue;

    const entities = (owned as unknown as Record<string, Record<string, unknown>[]>)[descriptor.location.key] ?? [];
    for (const entity of entities) {
      for (const field of fields) {
        const value = entity[field];
        if (typeof value === 'string' && value) referencedKnotIds.add(value);
      }
    }
  }

  // Ids of the types a knot can ride instead of a real segment, by prefix.
  const idsByKnotHostPrefix = new Map<string, Set<string>>();
  for (const descriptor of SUPPORT_TYPES) {
    if (!descriptor.knotHostPrefix) continue;
    const entities = (owned as unknown as Record<string, { id: string }[]>)[descriptor.location.key] ?? [];
    idsByKnotHostPrefix.set(descriptor.knotHostPrefix, new Set(entities.map((entity) => entity.id)));
  }

  const knots = Object.values(state.knots)
    .filter((item) => {
      if (referencedKnotIds.has(item.id)) return true;
      if (includedSegmentIds.has(item.parentShaftId)) return true;

      for (const [prefix, ids] of idsByKnotHostPrefix) {
        if (item.parentShaftId.startsWith(prefix)) {
          return ids.has(item.parentShaftId.slice(prefix.length));
        }
      }
      return false;
    })
    .map((item) => clonePlainData(item));

  const hasData = SUPPORT_COLLECTION_KEYS.some((key) => owned[key].length > 0)
    || knots.length > 0
    || kickstandRoots.length > 0
    || kickstandKnots.length > 0;

  if (!hasData) return null;

  return {
    ...owned,
    knots,
    kickstandRoots,
    kickstandKnots,
  };
}

/**
 * One payload cloned onto `targetModelId` and merged into `base`.
 *
 * `delta` moves the clone as it is made, which is what a copy needs: the
 * entities are new, so their geometry can be carried straight to the target's
 * transform instead of being merged and then walked again in the store.
 */
function mergeSupportClipboardPayload(
  payload: SupportClipboardPayload,
  targetModelId: string,
  options?: { base?: SupportState; delta?: SupportDeltaTransform | null },
): { mergedState: SupportState } {
  const state = options?.base ?? getSnapshot();
  const delta = options?.delta ?? null;

  const idMapsByCollection = new Map<SupportCollectionKey, Map<string, string>>();
  for (const key of SUPPORT_COLLECTION_KEYS) idMapsByCollection.set(key, new Map());
  const mapFor = (key: SupportCollectionKey) => idMapsByCollection.get(key)!;

  const rootIdMap = mapFor('roots');
  const knotIdMap = mapFor('knots');
  const segmentIdMap = new Map<string, string>();
  const jointIdMap = new Map<string, string>();
  const kickstandRootIdMap = new Map<string, string>();
  const kickstandKnotIdMap = new Map<string, string>();
  const kickstandIdMap = new Map<string, string>();

  const clonedRoots = payload.roots.map((root) => {
    const id = uuidv4();
    rootIdMap.set(root.id, id);
    const cloned = { ...clonePlainData(root), id, modelId: targetModelId };
    return (delta ? transformSupportRecord('roots', cloned, delta) : cloned) as Roots;
  });

  // Knot ids are claimed before the entities that point at them, so an edge
  // resolves to the knot's real new id rather than minting a placeholder.
  payload.knots.forEach((knot) => {
    knotIdMap.set(knot.id, uuidv4());
  });

  /**
   * One support entity, re-identified for the target model.
   *
   * Everything the clone touches is declared: `hasSegments` says whether to
   * walk shafts, `contactFields` names the contact primitives, and `edges`
   * names each id-bearing field and the collection it points into. A type is
   * copied by declaring it. The stump is the one type with no edges and an
   * inline root, so it appears in no id-remapping list.
   */
  const cloneEntity = (descriptor: SupportTypeDescriptor, entity: Record<string, unknown>) => {
    const id = uuidv4();
    mapFor(descriptor.location.key).set(entity.id as string, id);

    const next: Record<string, unknown> = { ...clonePlainData(entity), id, modelId: targetModelId };

    if (descriptor.hasSegments) {
      next.segments = ((entity.segments as Segment[] | undefined) ?? []).map((segment) => {
        const segmentId = uuidv4();
        segmentIdMap.set(segment.id, segmentId);
        return {
          ...clonePlainData(segment),
          id: segmentId,
          topJoint: remapSupportJoint(segment.topJoint, jointIdMap),
          bottomJoint: remapSupportJoint(segment.bottomJoint, jointIdMap),
        };
      });
    }

    // A stump carries a bare `joint` outside its segments; nothing else does.
    const ownJoint = entity.joint as { id: string } | undefined;
    if (ownJoint) next.joint = remapSupportJoint(ownJoint as never, jointIdMap);

    for (const field of descriptor.contactFields) {
      const contact = entity[field] as { id: string; socketJointId?: string } | undefined;
      if (!contact) continue;
      next[field] = {
        ...clonePlainData(contact),
        id: uuidv4(),
        ...(contact.socketJointId
          ? { socketJointId: getOrCreateMappedId(contact.socketJointId, jointIdMap) }
          : {}),
      };
    }

    for (const edge of descriptor.edges) {
      const value = entity[edge.field];
      if (typeof value !== 'string' || !value) continue;
      // A `segment` edge names a shaft segment, not a collection member.
      next[edge.field] = edge.to === 'segment'
        ? getOrCreateMappedId(value, segmentIdMap)
        : getOrCreateMappedId(value, mapFor(edge.to));
    }

    return delta ? transformSupportRecord(descriptor.id, next, delta) : next;
  };

  /** Cloned entities per collection, keyed the way the merge writes them. */
  const clonedByCollection = new Map<SupportCollectionKey, Record<string, unknown>[]>();
  for (const descriptor of SUPPORT_TYPES) {
    const key = descriptor.location.key;
    const source = (payload as unknown as Record<string, Record<string, unknown>[]>)[key] ?? [];
    clonedByCollection.set(key, source.map((entity) => cloneEntity(descriptor, entity)));
  }

  const clonedKnots = payload.knots.map((knot) => {
    const id = knotIdMap.get(knot.id) ?? uuidv4();

    // A knot names a shaft segment, or one of the prefixed pseudo-shafts a
    // type declares as its `knotHostPrefix` -- resolved through the
    // prefix owner's own id map.
    let parentShaftId = knot.parentShaftId;
    const prefixOwner = SUPPORT_TYPES.find((descriptor) => descriptor.knotHostPrefix
      && parentShaftId.startsWith(descriptor.knotHostPrefix));

    if (prefixOwner) {
      const prefix = prefixOwner.knotHostPrefix!;
      const ownerId = parentShaftId.slice(prefix.length);
      parentShaftId = `${prefix}${getOrCreateMappedId(ownerId, mapFor(prefixOwner.location.key))}`;
    } else {
      parentShaftId = getOrCreateMappedId(parentShaftId, segmentIdMap);
    }

    const cloned = {
      ...clonePlainData(knot),
      id,
      parentShaftId,
    };
    return (delta ? transformSupportRecord('knots', cloned, delta) : cloned) as Knot;
  });

  const clonedKickstandRoots = payload.kickstandRoots.map((root) => {
    const id = uuidv4();
    kickstandRootIdMap.set(root.id, id);
    const cloned = { ...clonePlainData(root), id, modelId: targetModelId };
    return (delta ? transformSupportRecord('roots', cloned, delta) : cloned) as Roots;
  });

  const clonedKickstandKnots = payload.kickstandKnots.map((knot) => {
    const id = uuidv4();
    kickstandKnotIdMap.set(knot.id, id);
    const cloned = {
      ...clonePlainData(knot),
      id,
      parentShaftId: getOrCreateMappedId(knot.parentShaftId, segmentIdMap),
    };
    return (delta ? transformSupportRecord('knots', cloned, delta) : cloned) as Knot;
  });

  const clonedKickstands = payload.kickstands.map((kickstand) => {
    const id = uuidv4();
    kickstandIdMap.set(kickstand.id, id);

    const clonedSegments = kickstand.segments.map((segment) => {
      const segmentId = getOrCreateMappedId(segment.id, segmentIdMap);
      return {
        ...clonePlainData(segment),
        id: segmentId,
        topJoint: remapSupportJoint(segment.topJoint, jointIdMap),
        bottomJoint: remapSupportJoint(segment.bottomJoint, jointIdMap),
      };
    });

    const cloned = {
      ...clonePlainData(kickstand),
      id,
      modelId: targetModelId,
      rootId: getOrCreateMappedId(kickstand.rootId, kickstandRootIdMap),
      hostKnotId: getOrCreateMappedId(kickstand.hostKnotId, kickstandKnotIdMap),
      hostSegmentId: getOrCreateMappedId(kickstand.hostSegmentId, segmentIdMap),
      segments: clonedSegments,
    };
    return (delta ? transformSupportRecord('kickstand', cloned, delta) : cloned) as Kickstand;
  });

  // Every entity collection, from the registry.
  const mergedState: SupportState = { ...state };
  for (const key of SUPPORT_COLLECTION_KEYS) {
    // Kickstands remap through their own root/knot maps, so they arrive
    // already cloned rather than through the generic entity clone.
    const cloned = key === 'roots'
      ? clonedRoots
      : key === 'knots'
        ? clonedKnots
        : key === 'kickstands'
          ? clonedKickstands
          : clonedByCollection.get(key) ?? [];
    if (cloned.length === 0) continue;

    (mergedState as unknown as Record<string, Record<string, unknown>>)[key] = {
      ...(state[key] as unknown as Record<string, unknown>),
      ...Object.fromEntries((cloned as { id: string }[]).map((item) => [item.id, item])),
    };
  }

  // A kickstand's root and host knot live in the shared collections, so they
  // merge alongside every other primitive rather than through a second write.
  mergedState.roots = {
    ...mergedState.roots,
    ...Object.fromEntries(clonedKickstandRoots.map((item) => [item.id, item])),
  };
  mergedState.knots = {
    ...mergedState.knots,
    ...Object.fromEntries(clonedKickstandKnots.map((item) => [item.id, item])),
  };

  return { mergedState };
}

export function captureModelSupportsToClipboard(modelId: string): SupportClipboardPayload | null {
  return extractSupportClipboardPayload(modelId);
}

/**
 * The ground a model's supports stand on: its roots and the raft around them.
 * `estimateSupportBoundsForModel` spans everything it carries, most of it in the air.
 */
export function estimateRaftBoundsForModel(modelId: string): SupportModelBounds2D | null {
    if (!modelId) return null;

    const state = getSnapshot();
    const roots = Object.values(state.roots).filter((root) => root.modelId === modelId);
    if (roots.length === 0) return null;

    let minX = Number.POSITIVE_INFINITY;
    let maxX = Number.NEGATIVE_INFINITY;
    let minY = Number.POSITIVE_INFINITY;
    let maxY = Number.NEGATIVE_INFINITY;

    const expand = (x: number, y: number, radius = 0) => {
        const r = Math.max(0, radius);
        minX = Math.min(minX, x - r);
        maxX = Math.max(maxX, x + r);
        minY = Math.min(minY, y - r);
        maxY = Math.max(maxY, y + r);
    };

    for (const root of roots) {
        expand(root.transform.pos.x, root.transform.pos.y, Math.max(0.001, root.diameter / 2));
    }

    const raftSettings = getRaftSettings();
    if (raftSettings.bottomMode !== 'off') {
        const circles: SupportBaseCircle[] = roots.map((root) => ({
            x: root.transform.pos.x,
            y: root.transform.pos.y,
            r: root.diameter / 2,
        }));

        const thickness = raftSettings.bottomMode === 'line' ? raftSettings.lineHeightMm : raftSettings.thickness;
        const chamferInset = Math.max(0, thickness) * Math.tan((Math.PI / 180) * (90 - Math.min(90, Math.max(45, raftSettings.chamferAngle))));
        const wallInset = raftSettings.wallEnabled ? Math.max(0, raftSettings.wallThickness) : 0;
        const dynamicMargin = 0.2 + Math.max(chamferInset, wallInset);

        const baseProfile = computeFootprint(circles, { marginMm: dynamicMargin, samplesPerCircle: 24 });
        if (baseProfile && baseProfile.length >= 3) {
            const outerProfile = raftSettings.wallEnabled
                ? computeRaftOuterBoundary(baseProfile, raftSettings)
                : baseProfile;
            for (const point of outerProfile) expand(point.x, point.y);
        }
    }

    return Number.isFinite(minX) ? { minX, maxX, minY, maxY } : null;
}

export function estimateSupportBoundsForModel(modelId: string): SupportModelBounds2D | null {
  if (!modelId) return null;

  const state = getSnapshot();
  const snapshot = getSnapshot();
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

    const thickness = raftSettings.bottomMode === 'line' ? raftSettings.lineHeightMm : raftSettings.thickness;
    const chamferInset = Math.max(0, thickness) * Math.tan((Math.PI / 180) * (90 - Math.min(90, Math.max(45, raftSettings.chamferAngle))));
    const wallInset = raftSettings.wallEnabled ? Math.max(0, raftSettings.wallThickness) : 0;
    const dynamicMargin = 0.2 + Math.max(chamferInset, wallInset);

    const baseProfile = computeFootprint(circles, {
      marginMm: dynamicMargin,
      samplesPerCircle: 24,
    });

    if (baseProfile && baseProfile.length >= 3) {
      const outerProfile = raftSettings.wallEnabled
        ? computeRaftOuterBoundary(baseProfile, raftSettings)
        : baseProfile;
      outerProfile.forEach((point) => expand({ x: point.x, y: point.y, z: 0 }, 0));
    }
  }

  const knotBelongsToModel = (knot: Knot) => {
    const parentShaftId = knot.parentShaftId;

    // A knot riding a declared pseudo-shaft belongs to whatever that host does.
    for (const descriptor of SUPPORT_TYPES) {
      const prefix = descriptor.knotHostPrefix;
      if (!prefix || !parentShaftId.startsWith(prefix)) continue;
      const hosts = state[descriptor.location.key] as unknown as Record<string, { modelId?: string }>;
      return hosts?.[parentShaftId.slice(prefix.length)]?.modelId === modelId;
    }

    // Every shafted type, so a knot riding a stump or kickstand resolves too.
    for (const descriptor of SUPPORT_TYPES) {
      if (!descriptor.hasSegments) continue;
      const collection = state[descriptor.location.key] as unknown as Record<string, { modelId: string; segments?: Segment[] }>;

      for (const entity of Object.values(collection ?? {})) {
        if (entity.modelId !== modelId) continue;
        if (entity.segments?.some((segment) => segment.id === parentShaftId)) return true;
      }
    }

    return false;
  };

  Object.values(state.knots)
    .filter(knotBelongsToModel)
    .forEach((knot) => expand(knot.pos, Math.max(0.001, (knot.diameter ?? 1.2) / 2)));

  const kickstandHostKnotIds = new Set(
    Object.values(snapshot.kickstands)
      .filter((kickstand) => kickstand.modelId === modelId)
      .map((kickstand) => kickstand.hostKnotId),
  );

  Object.values(snapshot.knots)
    .filter((knot) => kickstandHostKnotIds.has(knot.id))
    .forEach((knot) => expand(knot.pos, Math.max(0.001, (knot.diameter ?? 1.2) / 2)));

  const expandSegments = (segments: Array<any>) => {
    segments.forEach((segment) => {
      expand(segment.topJoint?.pos, Math.max(0.001, (segment.topJoint?.diameter ?? segment.diameter) / 2));
      expand(segment.bottomJoint?.pos, Math.max(0.001, (segment.bottomJoint?.diameter ?? segment.diameter) / 2));
    });
  };

  // Every type's shafts and declared contacts. A cone carries its contact
  // diameter on its profile, a disk directly on itself.
  for (const descriptor of SUPPORT_TYPES) {
    const collection = state[descriptor.location.key] as unknown as Record<string, Record<string, unknown>>;

    for (const entity of Object.values(collection ?? {})) {
      if (entity.modelId !== modelId) continue;
      if (descriptor.hasSegments) expandSegments((entity.segments ?? []) as any[]);

      for (const field of descriptor.contactFields) {
        const contact = entity[field] as {
          pos: Vec3;
          contactDiameterMm?: number;
          profile?: { contactDiameterMm: number };
        } | undefined;
        if (!contact) continue;

        const diameter = contact.contactDiameterMm ?? contact.profile?.contactDiameterMm ?? 0;
        expand(contact.pos, Math.max(0.001, diameter / 2));
      }
    }
  }

  Object.values(snapshot.kickstands)
    .filter((kickstand) => kickstand.modelId === modelId)
    .forEach((kickstand) => expandSegments(kickstand.segments as any[]));

  return hasAny ? { minX, maxX, minY, maxY } : null;
}

/** One paste: a payload, the model it lands on, and where that model sits. */
export type SupportPasteTarget = {
  payload: SupportClipboardPayload;
  targetModelId: string;
  sourceTransform: { position: THREE.Vector3; rotation: THREE.Euler; scale: THREE.Vector3 };
  targetTransform: { position: THREE.Vector3; rotation: THREE.Euler; scale: THREE.Vector3 };
};

/**
 * Paste supports for one or more targets in a single store write.
 *
 * Each clone is moved from the source model's transform to its target's while
 * it is made, so nothing has to walk the store again, and every target lands in
 * one merged state: a duplicate of N copies costs one write and one history
 * entry rather than N of each.
 */
export function pasteModelSupports(
  targets: readonly SupportPasteTarget[],
  options?: {
    recordHistory?: boolean;
    historyDescription?: MessageDescriptor;
  },
): number {
  const before = captureSupportEditSnapshot();

  let mergedState = getSnapshot();
  let pastedCount = 0;

  for (const target of targets) {
    if (!target.payload || !target.targetModelId) continue;

    // Every collection, from the registry.
    const hasSupports = SUPPORT_COLLECTION_KEYS
      .reduce((total, key) => total + (target.payload[key]?.length ?? 0), 0);
    if (hasSupports === 0) continue;

    const delta = buildSupportDeltaTransform(target.sourceTransform, target.targetTransform);
    mergedState = mergeSupportClipboardPayload(target.payload, target.targetModelId, {
      base: mergedState,
      delta,
    }).mergedState;
    pastedCount += hasSupports;
  }

  if (pastedCount === 0) return 0;

  setSnapshot(mergedState);

  const shouldRecordHistory = options?.recordHistory ?? true;
  if (shouldRecordHistory) {
    pushSupportEditHistory(options?.historyDescription ?? PASTE_SUPPORTS_LABEL, before, captureSupportEditSnapshot());
  }
  return pastedCount;
}

export function pasteModelSupportsFromClipboard(
  payload: SupportClipboardPayload | null | undefined,
  targetModelId: string,
  sourceTransform: { position: THREE.Vector3; rotation: THREE.Euler; scale: THREE.Vector3 },
  targetTransform: { position: THREE.Vector3; rotation: THREE.Euler; scale: THREE.Vector3 },
  options?: {
    recordHistory?: boolean;
    historyDescription?: MessageDescriptor;
  },
): number {
  if (!payload || !targetModelId) return 0;

  return pasteModelSupports([{ payload, targetModelId, sourceTransform, targetTransform }], options);
}

export type { SupportClipboardPayload };
