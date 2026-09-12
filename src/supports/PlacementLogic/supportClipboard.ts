import * as THREE from 'three';
import { getSnapshot, setSnapshot, transformSupportsForModel } from '@/supports/state';
import type { Brace, Branch, Knot, Leaf, Roots, Segment, Stick, SupportState, Trunk, Twig, Vec3 } from '@/supports/types';
import type { Kickstand } from '@/supports/SupportTypes/Kickstand/types';
import { captureSupportEditSnapshot, pushSupportEditHistory } from '@/supports/history/supportEditHistory';
import { getRaftSettings } from '@/supports/Rafts/Crenelated/RaftState';
import { computeFootprint } from '@/supports/Rafts/Crenelated/geometry/computeFootprint';
import { computeRaftOuterBoundary } from '@/supports/Rafts/Crenelated/geometry/computeRaftOuterBoundary';
import type { SupportBaseCircle } from '@/supports/Rafts/Crenelated/RaftTypes';
import { v4 as uuidv4 } from 'uuid';
import { MODEL_ID_COLLECTION_KEYS, SUPPORT_COLLECTION_KEYS, SUPPORT_TYPES, type SupportCollectionKey, type SupportTypeDescriptor } from '@/supports/supportTypeRegistry';

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

function clonePlain<T>(value: T): T {
  if (typeof structuredClone === 'function') {
    return structuredClone(value) as T;
  }
  return JSON.parse(JSON.stringify(value)) as T;
}

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
      .map(clonePlain);
  }
  const roots = owned.roots;
  const trunks = owned.trunks;
  const branches = owned.branches;
  const leaves = owned.leaves;
  const twigs = owned.twigs;
  const sticks = owned.sticks;
  const braces = owned.braces;

  const kickstands = Object.values(snapshot.kickstands)
    .filter((item) => item.modelId === modelId)
    .map(clonePlain);
  const kickstandRootIds = new Set(kickstands.map((item) => item.rootId));
  const kickstandKnotIds = new Set(kickstands.map((item) => item.hostKnotId));
  const kickstandRoots = Object.values(snapshot.roots)
    .filter((item) => kickstandRootIds.has(item.id))
    .map(clonePlain);
  const kickstandKnots = Object.values(snapshot.knots)
    .filter((item) => kickstandKnotIds.has(item.id))
    .map(clonePlain);

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
    .map(clonePlain);

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

function mergeSupportClipboardPayload(
  payload: SupportClipboardPayload,
  targetModelId: string,
): { mergedState: SupportState } {
  const state = getSnapshot();
  const snapshot = getSnapshot();

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
    return {
      ...clonePlain(root),
      id,
      modelId: targetModelId,
    };
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
   * copied by declaring it -- which is how anchors came to be dropped, being
   * the one type with no edges and an inline root.
   */
  const cloneEntity = (descriptor: SupportTypeDescriptor, entity: Record<string, unknown>) => {
    const id = uuidv4();
    mapFor(descriptor.location.key).set(entity.id as string, id);

    const next: Record<string, unknown> = { ...clonePlain(entity), id, modelId: targetModelId };

    if (descriptor.hasSegments) {
      next.segments = ((entity.segments as Segment[] | undefined) ?? []).map((segment) => {
        const segmentId = uuidv4();
        segmentIdMap.set(segment.id, segmentId);
        return {
          ...clonePlain(segment),
          id: segmentId,
          topJoint: remapSupportJoint(segment.topJoint, jointIdMap),
          bottomJoint: remapSupportJoint(segment.bottomJoint, jointIdMap),
        };
      });
    }

    // An anchor carries a bare `joint` outside its segments; nothing else does.
    const ownJoint = entity.joint as { id: string } | undefined;
    if (ownJoint) next.joint = remapSupportJoint(ownJoint as never, jointIdMap);

    for (const field of descriptor.contactFields) {
      const contact = entity[field] as { id: string; socketJointId?: string } | undefined;
      if (!contact) continue;
      next[field] = {
        ...clonePlain(contact),
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

    return next;
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
    // type declares (`leafCone:`, `braceSegment:`) -- resolved through the
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

    return {
      ...clonePlain(knot),
      id,
      parentShaftId,
    } as Knot;
  });

  const clonedKickstandRoots = payload.kickstandRoots.map((root) => {
    const id = uuidv4();
    kickstandRootIdMap.set(root.id, id);
    return {
      ...clonePlain(root),
      id,
      modelId: targetModelId,
    };
  });

  const clonedKickstandKnots = payload.kickstandKnots.map((knot) => {
    const id = uuidv4();
    kickstandKnotIdMap.set(knot.id, id);
    return {
      ...clonePlain(knot),
      id,
      parentShaftId: getOrCreateMappedId(knot.parentShaftId, segmentIdMap),
    };
  });

  const clonedKickstands = payload.kickstands.map((kickstand) => {
    const id = uuidv4();
    kickstandIdMap.set(kickstand.id, id);

    const clonedSegments = kickstand.segments.map((segment) => {
      const segmentId = getOrCreateMappedId(segment.id, segmentIdMap);
      return {
        ...clonePlain(segment),
        id: segmentId,
        topJoint: remapSupportJoint(segment.topJoint, jointIdMap),
        bottomJoint: remapSupportJoint(segment.bottomJoint, jointIdMap),
      };
    });

    return {
      ...clonePlain(kickstand),
      id,
      modelId: targetModelId,
      rootId: getOrCreateMappedId(kickstand.rootId, kickstandRootIdMap),
      hostKnotId: getOrCreateMappedId(kickstand.hostKnotId, kickstandKnotIdMap),
      hostSegmentId: getOrCreateMappedId(kickstand.hostSegmentId, segmentIdMap),
      segments: clonedSegments,
    } as Kickstand;
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

    // Every shafted type, so a knot riding an anchor or kickstand resolves too.
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

export function pasteModelSupportsFromClipboard(
  payload: SupportClipboardPayload | null | undefined,
  targetModelId: string,
  sourceTransform: { position: THREE.Vector3; rotation: THREE.Euler; scale: THREE.Vector3 },
  targetTransform: { position: THREE.Vector3; rotation: THREE.Euler; scale: THREE.Vector3 },
  options?: {
    recordHistory?: boolean;
    historyDescription?: string;
  },
): number {
  if (!payload || !targetModelId) return 0;

  const before = captureSupportEditSnapshot();

  // Every collection, from the registry.
  const hasSupports = SUPPORT_COLLECTION_KEYS
    .reduce((total, key) => total + (payload[key]?.length ?? 0), 0);

  if (hasSupports === 0) return 0;

  const { mergedState } = mergeSupportClipboardPayload(payload, targetModelId);
  setSnapshot(mergedState);

  transformSupportsForModel(targetModelId, sourceTransform, targetTransform);

  const shouldRecordHistory = options?.recordHistory ?? true;
  if (shouldRecordHistory) {
    pushSupportEditHistory(options?.historyDescription ?? 'Paste supports', before, captureSupportEditSnapshot());
  }
  return hasSupports;
}

export type { SupportClipboardPayload };
