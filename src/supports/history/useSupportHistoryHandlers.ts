import { useEffect } from 'react';
import {
  SUPPORT_REPLACE_TRUNK,
  SUPPORT_EDIT_REPLACE,
  SUPPORT_AUTO_BRACE_REPLACE,
  SUPPORT_AUTO_PLACE,
  SUPPORT_BLOCKER_STROKE,
  SupportReplaceStatePayload,
} from './actionTypes';
import { registerSupportHistoryHandler } from './supportHistory';
import { removeSupportEntity, updateKnot, setSnapshot, getSnapshot } from '../state';
import { setSupportBlockedTriangles } from '../autoSupport/supportBlockers';
import { clearSupportSelection } from '../interaction/shared/selection/selectionController';
import { getSupportTypeBySelectionCategory, getSupportTypeDescriptor, parsePrefixedSegmentId, restoreToCollection, updateSupportEntity, SHAFTED_COLLECTION_KEYS, SUPPORT_PRIMITIVE_COLLECTIONS, SUPPORT_REMOVAL_SHAPES, SUPPORT_TYPES, type SupportCollectionKey, type SupportEntityIn, type SupportTypeDescriptor } from '../supportTypeRegistry';

function applySnapshotHistory(payload: SupportReplaceStatePayload, direction: 'undo' | 'redo') {
  clearSupportSelection();
  // setSnapshot restores kickstands too -- they are a SupportState collection.
  setSnapshot(direction === 'undo' ? payload.before : payload.after);
}

/**
 * Whether the current selection still resolves to a live entity in the current
 * snapshot. Used after per-entity undo/redo restores: a joint-move undo must
 * not de-select the very support the user is editing, but a stale selection
 * (entity removed beneath this undo entry) must still be cleared.
 */
function selectionExistsInSnapshot(): boolean {
  const state = getSnapshot();
  const id = state.selectedId;
  const category = state.selectedCategory;
  if (!id || !category) return false;

  // Collection categories resolve by direct lookup, keyed off the registry.
  const descriptor = getSupportTypeBySelectionCategory(category);
  if (descriptor) {
    const record = state[descriptor.location.key as SupportCollectionKey] as Record<string, unknown> | undefined;
    return !!record?.[id];
  }
  for (const primitive of SUPPORT_PRIMITIVE_COLLECTIONS) {
    if (primitive.selectionCategory !== category) continue;
    const record = state[primitive.key] as Record<string, unknown> | undefined;
    return !!record?.[id];
  }

  switch (category) {
    case 'segment':
      {
        const host = parsePrefixedSegmentId(id);
        if (host) {
          const collections = state as unknown as Record<string, Record<string, unknown>>;
          return !!collections[getSupportTypeDescriptor(host.typeId).location.key]?.[host.entityId];
        }
      }
      // fall through to joint scan for regular shaft segments
    case 'joint': {
      const hasJointOrSegment = (segments: Array<{ id: string; topJoint?: { id: string } | null; bottomJoint?: { id: string } | null }>) =>
        segments.some((s) => s.id === id || s.topJoint?.id === id || s.bottomJoint?.id === id);
      // Every shafted type, from the registry.
      for (const key of SHAFTED_COLLECTION_KEYS) {
        const record = state[key] as Record<string, { segments: Array<{ id: string; topJoint?: { id: string } | null; bottomJoint?: { id: string } | null }> }> | undefined;
        if (!record) continue;
        for (const entity of Object.values(record)) {
          if (hasJointOrSegment(entity.segments)) return true;
        }
      }
      return false;
    }
    default:
      return false;
  }
}

/**
 * Register every supports undo/redo handler and return a disposer.
 *
 * Plain module function on purpose: the handlers close over the support
 * stores, not over React state, so registration must not depend on whether
 * any particular renderer happens to be mounted.
 */
/** The fields a type's removal payload carries, from its declared shape. */
function payloadFields(descriptor: SupportTypeDescriptor): {
  self: string;
  cascade: [SupportCollectionKey, string | readonly string[]][];
} {
  const shape = SUPPORT_REMOVAL_SHAPES[descriptor.id];
  return {
    self: shape.self,
    cascade: Object.entries(shape.cascade) as [SupportCollectionKey, string | readonly string[]][],
  };
}

/**
 * The removed entity a payload is keyed on.
 *
 * Normally the declared `self` field. Callers may omit it and send only the
 * type's collection list -- the branch remove path does -- so fall back to the
 * first entry there rather than refusing the entry.
 */
function seedEntity(
  descriptor: SupportTypeDescriptor,
  payload: unknown,
): { id: string } | null {
  const fields = payload as Record<string, unknown> | null | undefined;
  if (!fields) return null;

  const seed = fields[payloadFields(descriptor).self] as
    { id?: string; kickstand?: { id: string } } | undefined;
  if (seed?.id) return seed as { id: string };
  // Nested builds carry the entity one level down.
  if (seed?.kickstand?.id) return seed.kickstand;

  const list = fields[descriptor.location.key] as { id: string }[] | undefined;
  return list?.length ? list[0] : null;
}

/** Puts a removal payload back, walking the collections its shape declares. */
function restoreRemoved(descriptor: SupportTypeDescriptor, payload: unknown): void {
  const fields = payload as Record<string, unknown>;
  const { self, cascade } = payloadFields(descriptor);

  // Hosts first: a leaf cannot be re-added before the knot it hangs from.
  for (const [collection, field] of cascade) {
    for (const name of Array.isArray(field) ? field : [field as string]) {
      const value = fields[name];
      if (!value) continue;
      for (const entity of Array.isArray(value) ? value : [value]) {
        if (entity) restoreToCollection(collection, entity);
      }
    }
  }

  const seed = fields[self];
  if (seed) restoreToCollection(descriptor.location.key, seed);
}

/**
 * Knot and trunk edits some payloads carry alongside the entity.
 *
 * Adding a branch can resize its host knot and rewrite the trunk it hangs from;
 * those edits invert with the entity rather than separately.
 */
function applyHostEdits(payload: unknown, direction: 'undo' | 'redo'): void {
  const fields = payload as {
    knotUpdates?: { before: SupportEntityIn<'knots'>; after: SupportEntityIn<'knots'> }[];
    trunkUpdate?: { before: SupportEntityIn<'trunks'>; after: SupportEntityIn<'trunks'> };
  } | null | undefined;
  if (!fields) return;

  for (const update of fields.knotUpdates ?? []) {
    updateKnot(direction === 'undo' ? update.before : update.after);
  }
  // Stays named: `trunkUpdate` is a field on the stored payload, so the type
  // name is in the history wire format rather than in this dispatch. Goes with
  // the payload shapes, not with this file.
  const trunkUpdate = fields.trunkUpdate;
  if (trunkUpdate) {
    updateSupportEntity('trunk', direction === 'undo' ? trunkUpdate.before : trunkUpdate.after);
  }
}

export function registerSupportHistoryHandlers(): () => void {
  const unregisters = [
    // Add and remove handlers, derived from the registry.
    //
    // Every type's pair inverts the same way: an add undoes by removing the
    // entity and redoes by restoring the payload; a remove does the reverse.
    ...SUPPORT_TYPES.flatMap((descriptor) => [
      registerSupportHistoryHandler(descriptor.historyAdd, (payload, direction) => {
        const seed = seedEntity(descriptor, payload);
        if (!seed) return false;
        if (direction === 'undo') removeSupportEntity(descriptor.id, seed.id);
        else restoreRemoved(descriptor, payload);
        applyHostEdits(payload, direction);
        return true;
      }),
      registerSupportHistoryHandler(descriptor.historyRemove, (payload, direction) => {
        const seed = seedEntity(descriptor, payload);
        if (!seed) return false;
        if (direction === 'undo') restoreRemoved(descriptor, payload);
        else removeSupportEntity(descriptor.id, seed.id);
        applyHostEdits(payload, direction);
        return true;
      }),
    ]),
    // Update handlers, for the types that record a before/after edit of their
    // own. Both directions just apply the stored entity, so the pair is the
    // same code with the payload side swapped.
    ...SUPPORT_TYPES.flatMap((descriptor) => (descriptor.historyUpdate
      ? [registerSupportHistoryHandler(descriptor.historyUpdate, (payload, direction) => {
        const edit = payload as { before?: { id: string }; after?: { id: string } } | undefined;
        if (!edit?.before || !edit?.after) return false;
        updateSupportEntity(descriptor.id, direction === 'undo' ? edit.before : edit.after);
        // Keep the selection across the restore — the support still exists —
        // unless it now points at an entity that was removed underneath.
        if (!selectionExistsInSnapshot()) clearSupportSelection();
        return true;
      })]
      : [])),
    registerSupportHistoryHandler(SUPPORT_REPLACE_TRUNK, (payload, direction) => {
      if (!payload?.before || !payload?.after) return false;
      clearSupportSelection();
      if (direction === 'undo') {
        setSnapshot(payload.before);
      } else {
        setSnapshot(payload.after);
      }
      return true;
    }),
    registerSupportHistoryHandler(SUPPORT_EDIT_REPLACE, (payload, direction) => {
      if (!payload?.before || !payload?.after) return false;
      applySnapshotHistory(payload, direction);
      return true;
    }),
    registerSupportHistoryHandler(SUPPORT_AUTO_BRACE_REPLACE, (payload, direction) => {
      if (!payload?.before || !payload?.after) return false;
      applySnapshotHistory(payload, direction);
      return true;
    }),
    registerSupportHistoryHandler(SUPPORT_AUTO_PLACE, (payload, direction) => {
      if (!payload?.before || !payload?.after) return false;
      applySnapshotHistory(payload, direction);
      return true;
    }),
    registerSupportHistoryHandler(SUPPORT_BLOCKER_STROKE, (payload, direction) => {
      if (!payload || !payload.modelId) return false;
      setSupportBlockedTriangles(payload.modelId, direction === 'undo' ? payload.before : payload.after);
      return true;
    }),
  ];

  return () => {
    unregisters.forEach((fn) => fn());
  };
}

/** Binds {@link registerSupportHistoryHandlers} to the lifetime of the app. */
export function useSupportHistoryHandlers() {
  useEffect(() => registerSupportHistoryHandlers(), []);
}
