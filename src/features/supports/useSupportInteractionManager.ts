import { useCallback, useEffect, useMemo, useSyncExternalStore, useRef } from 'react';
import * as THREE from 'three';
import type { SupportMode } from '@/supports/types';
import type { SupportPlacementActive, SupportPlacementPreviews } from '@/supports/rendering';
import { useTrunkPlacementV2 } from '@/supports/SupportTypes/Trunk/useTrunkPlacement';
import { useBranchPlacement } from '@/supports/SupportTypes/Branch/useBranchPlacement';
import { useLeafPlacement } from '@/supports/SupportTypes/Leaf/useLeafPlacement';
import { useBracePlacement } from '@/supports/SupportTypes/Brace/useBracePlacement';
import { useKickstandPlacement } from '@/supports/SupportTypes/Kickstand/useKickstandPlacement';
import { isContactDiskHudInteractionActive } from '@/supports/SupportPrimitives/ContactDisk/contactDiskHudInteraction';
import { isSupportEditInteractionActive } from '@/supports/interaction/gizmoInteractionLock';
import { useInteractionStatus } from '@/supports/interaction/useInteractionStatus';
import { useJointCreationHotkey } from '@/supports/SupportPrimitives/Joint/useJointCreationHotkey';
import { useCurveHotkey } from '@/supports/Curves/useCurveHotkey';
import { useJointCreationState } from '@/supports/SupportPrimitives/Joint/jointCreationState';
import { cloneSupportState, getSelectedId, getSelectedCategory, findShaftOwnerOfJoint, findShaftOwnerOfSegment, getSupportEntities, getSupportTypeOf, getSupports, getSnapshot, removeJointById, setSelectedId, setHoveredState, subscribe } from '@/supports/state';
import { registerDeleteHandler } from '@/features/delete/deleteRegistry';
import { pushSupportHistory } from '@/supports/history/supportHistory';
import { SUPPORT_AUTO_BRACE_REPLACE } from '@/supports/history/actionTypes';
import { findKnotHost, getSupportTypeBySelectionCategory, getSupportTypeDescriptor, KNOT_HOST_PRECEDENCE, SUPPORT_TYPES } from '@/supports/supportTypeRegistry';
import { removeSupportEntityWithPayload } from '@/supports/history/removalPayload';
import { MODEL_SURFACE_GESTURE_TYPES } from '@/supports/supportTypeRegistry';
import type { ModelSurfaceGestureTypeId } from '@/supports/supportTypeRegistry';
import { knotFields } from '@/supports/interaction/shared/selection/selectedIdsByType';
import { clearSupportSelection, getResolvedPrimarySelection, selectSupportIds } from '@/supports/interaction/shared/selection/selectionController';
import { useHotkeyConfig } from '@/hotkeys/HotkeyContext';
import { resolveSupportPlacementHotkeyBindings } from '@/supports/interaction/shared/placement/hotkeys/supportPlacementHotkeyResolver';
import { resolveSupportPlacementRouting, routeModelPlacementHit, BRACE_PLACEMENT_OWNER, BRANCH_FAMILY_PLACEMENT_OWNER, DEFAULT_PLACEMENT_TYPE_ID, KICKSTAND_PLACEMENT_OWNER, LEAF_PLACEMENT_OWNER } from '@/supports/interaction/shared/placement/hotkeys/supportPlacementRouting';
import type { SupportModelPlacementHandlers, SupportModelPlacementOwner } from '@/supports/interaction/shared/placement/hotkeys/supportPlacementHotkeyTypes';
import { isKeyPressedSync } from '@/hotkeys/hotkeyStore';

interface SupportInteractionOptions {
  mode: SupportMode;
}



/**
 * @deprecated for removal -- prefer `getSupportTypeOf(id)` from state.
 * Kept while callers and tests still name it.
 */
export function resolveSupportCategoryFromSnapshot(id: string) {
  return getSupportTypeOf(id);
}

function collectAllSupportIds() {
  return Object.keys(getSupports());
}

/**
 * @deprecated for removal -- prefer `findShaftOwnerOfSegment(id)` from state,
 * which resolves every type's declared segment prefix from the registry.
 */
export function resolveSupportOwnerFromSegmentId(segmentId: string) {
  const owner = findShaftOwnerOfSegment(segmentId);
  return owner ? { category: owner.typeId, id: owner.id } : null;
}

/**
 * @deprecated for removal -- prefer `findShaftOwnerOfJoint(id)` from state.
 */
export function resolveSupportOwnerFromJointId(jointId: string) {
  const owner = findShaftOwnerOfJoint(jointId);
  return owner ? { category: owner.typeId, id: owner.id } : null;
}

export function useSupportInteractionManager({ mode }: SupportInteractionOptions) {
  // V2 Trunk Placement
  const trunkPlacementV2 = useTrunkPlacementV2();
  const branchPlacement = useBranchPlacement();
  const leafPlacement = useLeafPlacement();
  const bracePlacement = useBracePlacement();
  const kickstandPlacement = useKickstandPlacement();
  const { getHotkey } = useHotkeyConfig();

  /**
   * The model-face placement hooks, keyed by the owner the router names. One
   * owner takes the hit and the rest are cleared, so the handlers index this
   * rather than testing the owner against a type name.
   *
   * The keys are the owners the registry declares, so renaming a type moves them
   * with it: what a type is called is decided in the registry, not here.
   */
  const modelPlacementByOwner = useMemo(() => {
    const handlersByOwner = {} as Record<ModelSurfaceGestureTypeId, SupportModelPlacementHandlers>;
    handlersByOwner[BRANCH_FAMILY_PLACEMENT_OWNER] = branchPlacement;
    handlersByOwner[LEAF_PLACEMENT_OWNER] = leafPlacement;
    return handlersByOwner;
  }, [branchPlacement, leafPlacement]);

  /** Route a model-face gesture: `owner` gets the hit, every other owner null. */
  const dispatchModelHover = useCallback((owner: SupportModelPlacementOwner, hit: THREE.Intersection | null) => {
    trunkPlacementV2.onSupportHover(null);
    const routed = routeModelPlacementHit(MODEL_SURFACE_GESTURE_TYPES, owner, hit);
    for (const id of MODEL_SURFACE_GESTURE_TYPES) {
      modelPlacementByOwner[id].onModelHover(routed[id]);
    }
  }, [trunkPlacementV2, modelPlacementByOwner]);

  const altDownRef = useRef(false);
  const deletingRef = useRef(false);

  // V2 Joint Creation State
  useJointCreationHotkey(mode);
  useCurveHotkey(mode);
  const jointCreationState = useJointCreationState();

  // Centralized interaction status
  const { isPlacementDisabled, isPlacementHardDisabled } = useInteractionStatus();

  // Joint selection state for gizmo transformation
  const globalSelectedId = useSyncExternalStore(subscribe, getSelectedId, getSelectedId);
  const globalSelectedCategory = useSyncExternalStore(subscribe, getSelectedCategory, getSelectedCategory);

  const selectedJointId = globalSelectedCategory === 'joint' ? globalSelectedId : null;

  const resolvePlacementRouting = useCallback(() => {
    const bindings = resolveSupportPlacementHotkeyBindings(getHotkey);
    return resolveSupportPlacementRouting({
      bindings,
      modifierState: {
        ctrlKey: isKeyPressedSync('ctrl'),
        altKey: isKeyPressedSync('alt'),
        shiftKey: isKeyPressedSync('shift'),
        metaKey: isKeyPressedSync('meta'),
      },
      state: {
        branchHotkeyActive: branchPlacement.branchHotkeyActive,
        branchAwaitingBase: branchPlacement.stage === 'awaitingBase',
        leafHotkeyActive: leafPlacement.hotkeyActive,
        leafAwaitingBase: leafPlacement.stage === 'awaitingBase',
        braceHotkeyActive: branchPlacement.braceHotkeyActive,
        braceAwaitingEnd: bracePlacement.stage === 'awaitingEnd',
        kickstandHotkeyActive: kickstandPlacement.hotkeyActive,
      },
    });
  }, [getHotkey, branchPlacement.branchHotkeyActive, branchPlacement.stage, leafPlacement.hotkeyActive, leafPlacement.stage, branchPlacement.braceHotkeyActive, bracePlacement.stage, kickstandPlacement.hotkeyActive]);

  // Handler for MODEL hover (used for trunk placement preview, or branch tip preview)
  const onModelHover = useCallback((hit: THREE.Intersection | null) => {
    if (isSupportEditInteractionActive()) {
      dispatchModelHover('none', null);
      return;
    }

    if (isContactDiskHudInteractionActive()) {
      dispatchModelHover('none', null);
      return;
    }

    if (isPlacementHardDisabled) {
      dispatchModelHover('none', null);
      return;
    }

    if (jointCreationState.isActive) {
      dispatchModelHover('none', null);
      return;
    }

    const fanningActive = leafPlacement.sproutParentingLockHeld || leafPlacement.stage === 'awaitingSproutTip';
    if (fanningActive) {
      dispatchModelHover(LEAF_PLACEMENT_OWNER, hit);
      return;
    }

    const routing = resolvePlacementRouting();

    if (routing.modelHoverOwner !== 'none') {
      dispatchModelHover(routing.modelHoverOwner, hit);
      return;
    }

    if (routing.blocksDefaultModelPlacement) {
      dispatchModelHover('none', null);
      return;
    }

    trunkPlacementV2.onSupportHover(hit);
  }, [isPlacementHardDisabled, trunkPlacementV2, dispatchModelHover, leafPlacement, jointCreationState.isActive, resolvePlacementRouting]);

  // Handler for MODEL click (trunk placement, or branch tip placement)
  const onModelClick = useCallback((hit: THREE.Intersection) => {
    if (isSupportEditInteractionActive()) {
      return;
    }

    if (jointCreationState.isActive) {
      return;
    }

    const fanningActive = leafPlacement.sproutParentingLockHeld || leafPlacement.stage === 'awaitingSproutTip';
    if (fanningActive) {
      leafPlacement.onModelClick(hit);
      return;
    }

    const routing = resolvePlacementRouting();

    if (routing.modelClickOwner !== 'none') {
      modelPlacementByOwner[routing.modelClickOwner].onModelClick(hit);
      return;
    }

    if (routing.blocksDefaultModelPlacement) {
      return;
    }

    trunkPlacementV2.onSupportClick(hit);
  }, [trunkPlacementV2, modelPlacementByOwner, leafPlacement, jointCreationState.isActive, resolvePlacementRouting]);

  useEffect(() => {
    if (mode !== 'support') return;

    const deleteSelectionByCategoryAndId = (category: string, id: string, recordHistory = true): boolean => {
      if (category === 'joint') {
        const result = removeJointById(id);
        if (!result) {
          const kickstandOwner = resolveSupportOwnerFromJointId(id);
          if (!kickstandOwner) return false;
          return deleteSelectionByCategoryAndId(kickstandOwner.category, kickstandOwner.id, recordHistory);
        }
        // Whether a joint removal records an update is the type's declared
        // `historyUpdate`; a type without one (kickstand today) rides the
        // full-state snapshot. The action and payload are the type's own, so
        // the push uses the declared action; the payload cast keeps the
        // per-action payload map the single source of truth for what a handler
        // understands.
        const descriptor = getSupportTypeDescriptor(result.typeId);
        if (recordHistory && descriptor.historyUpdate) {
          const description = `Delete ${descriptor.singular} joint`;
          pushSupportHistory({
            type: descriptor.historyUpdate,
            description,
            payload: { before: result.before, after: result.after } as never,
          });
        }
        setSelectedId(result.id);
        return true;
      }

      if (category === 'segment') {
        const owner = resolveSupportOwnerFromSegmentId(id);
        if (!owner) return false;
        return deleteSelectionByCategoryAndId(owner.category, owner.id, recordHistory);
      }

      // Every type whose removal is the cascade plus one history entry, under
      // the action it declares. A type that shapes its payload -- or has to
      // repair something the removal invalidated -- registered a reshaper in
      // its own folder, so there is no list of names here: the registration is
      // the answer to "does this type reshape".
      if (category === 'knot') {
        // Deleting a knot deletes what it hosts. Which types can host, and the
        // field each reads, come from the declared knot edges; the order is the
        // precedence this has always used, since a knot can host more than one.
        const host = findKnotHost(getSnapshot(), id, KNOT_HOST_PRECEDENCE);
        if (!host) return false;
        return deleteSelectionByCategoryAndId(
          getSupportTypeDescriptor(host.typeId).selectionCategory,
          host.id,
          recordHistory,
        );
      }

      const removalDescriptor = getSupportTypeBySelectionCategory(category);
      if (removalDescriptor) {
        // The removal and its payload are resolved by a plain function so they
        // can be tested; this hook cannot be. See
        // supports/history/removalPayload.ts.
        const removed = removeSupportEntityWithPayload(removalDescriptor.id, id);
        if (!removed) return false;

        if (recordHistory) {
          pushSupportHistory({
            type: removalDescriptor.historyRemove,
            payload: removed.payload,
          } as Parameters<typeof pushSupportHistory>[0]);
        }
        setSelectedId(null);
        return true;
      }

      return false;
    };



    const canDeleteSelection = () => {
      const multiSelectedIds = getResolvedPrimarySelection().selectedIds;
      if (multiSelectedIds.length > 0) return true;

      const category = getSelectedCategory();
      const id = getSelectedId();
      if (!id || !category) return false;
      // Every support type is deletable, and 'joint' too, so this asks the
      // registry rather than listing categories.
      if (category === 'joint' || getSupportTypeBySelectionCategory(category)) return true;

      // A knot is deletable when something hangs off it. Which types can, and
      // by which field, is the declared hostedBy-knots edge set.
      if (category === 'knot') {
        return SUPPORT_TYPES.some((descriptor) => {
          const fields = knotFields(descriptor);
          if (fields.length === 0) return false;
          return getSupportEntities<Record<string, unknown>>(descriptor.id)
            .some((entity) => fields.some((field) => entity[field] === id));
        });
      }

      if (category === 'segment') {
        return resolveSupportOwnerFromSegmentId(id) !== null;
      }

      return false;
    };

    const performDeleteSelection = () => {
      if (deletingRef.current) return;
      deletingRef.current = true;
      try {
      const multiSelectedIds = Array.from(new Set(getResolvedPrimarySelection().selectedIds));
      if (multiSelectedIds.length > 0) {
        const beforeSupportSnapshot = cloneSupportState(getSnapshot());
        let anyDeleted = false;
        for (const supportId of multiSelectedIds) {
          const category = resolveSupportCategoryFromSnapshot(supportId);
          if (!category) continue;
          const deleted = deleteSelectionByCategoryAndId(category, supportId, false);
          if (deleted) anyDeleted = true;
        }

        if (anyDeleted) {
          const afterSupportSnapshot = cloneSupportState(getSnapshot());

          pushSupportHistory({
            type: SUPPORT_AUTO_BRACE_REPLACE,
            description: `Delete ${multiSelectedIds.length} supports`,
            payload: {
              before: beforeSupportSnapshot,
              after: afterSupportSnapshot,
            },
          });
        }

        clearSupportSelection();
        setHoveredState('none', null);
        if (anyDeleted) return;
      }

      const category = getSelectedCategory();
      const id = getSelectedId();
      if (!id || !category) return;

      deleteSelectionByCategoryAndId(category, id);

      setHoveredState('none', null);
      } finally {
        deletingRef.current = false;
      }
    };

    const onKeyDown = (e: CustomEvent) => {
      const { key, code, repeat, ctrlKey, metaKey } = e.detail;

      if (key.toLowerCase() === 'e') {
        const category = getSelectedCategory();
        const id = getSelectedId();
        if (id) {
          const hostedType = getSupportTypeBySelectionCategory(category);
          // The knot a support hangs from is a declared `hostedBy` edge. Only
          // types with exactly one have an unambiguous parent -- a brace hangs
          // from two, so it keeps the knot-side traversal below instead.
          const parentKnotEdges = hostedType?.edges.filter(
            (edge) => edge.to === 'knots' && edge.ownership === 'hostedBy',
          ) ?? [];

          if (parentKnotEdges.length === 1) {
            const snapshot = getSnapshot();
            const entity = (snapshot as unknown as Record<string, Record<string, Record<string, unknown>>>)
              [hostedType!.location.key]?.[id];
            const parentKnotId = entity?.[parentKnotEdges[0].field] as string | undefined;
            if (parentKnotId && snapshot.knots[parentKnotId]) {
              setSelectedId(parentKnotId);
            }
          } else if (category === 'knot') {
            // Children of a knot are whatever types declare a `hostedBy` edge
            // onto knots and name this knot. Derived, so a type that can hang
            // off a knot is walkable here the moment it says so.
            const snapshot = getSnapshot();
            const childIds: string[] = [];
            for (const descriptor of SUPPORT_TYPES) {
              const fields = descriptor.edges
                .filter((edge) => edge.to === 'knots' && edge.ownership === 'hostedBy')
                .map((edge) => edge.field);
              if (fields.length === 0) continue;
              const collection = snapshot[descriptor.location.key] as unknown as
                Record<string, Record<string, unknown>> | undefined;
              for (const [childId, entity] of Object.entries(collection ?? {})) {
                if (fields.some((field) => entity[field] === id)) childIds.push(childId);
              }
            }
            if (childIds.length > 0) {
              childIds.sort((a, b) => a.localeCompare(b));
              selectSupportIds([childIds[0]]);
            }
          }
        }
        return;
      }

      // Delete/Backspace is handled by the delete registry (registerDeleteHandler)
      // — do NOT handle it here or it fires twice: once here (removes the joint,
      // selects the parent) and once via triggerDelete() (deletes the parent).

      if (key === 'Escape') {
        if (getSelectedId() || getResolvedPrimarySelection().selectedIds.length > 0) {
          clearSupportSelection();
          setHoveredState('none', null);
        }
        return;
      }

      if ((ctrlKey || metaKey) && key.toLowerCase() === 'a') {
        const allSupportIds = collectAllSupportIds();
        selectSupportIds(allSupportIds);
        return;
      }

      if (!(key === 'Alt' || key === 'AltGraph' || code === 'AltLeft' || code === 'AltRight')) return;
      if (repeat || altDownRef.current) return;
      altDownRef.current = true;
      console.log('[AltKey]', 'down', { key, code, time: performance.now() });
    };

    const onKeyUp = (e: CustomEvent) => {
      const { key, code } = e.detail;
      if (!(key === 'Alt' || key === 'AltGraph' || code === 'AltLeft' || code === 'AltRight')) return;
      if (!altDownRef.current) return;
      altDownRef.current = false;
      console.log('[AltKey]', 'up', { key, code, time: performance.now() });
    };

    window.addEventListener('app-hotkey-keydown', onKeyDown as EventListener);
    window.addEventListener('app-hotkey-keyup', onKeyUp as EventListener);

    const unregister = registerDeleteHandler(
      () => mode === 'support' && canDeleteSelection(),
      performDeleteSelection,
      100,
    );

    return () => {
      window.removeEventListener('app-hotkey-keydown', onKeyDown as EventListener);
      window.removeEventListener('app-hotkey-keyup', onKeyUp as EventListener);
      altDownRef.current = false;
      unregister();
    };
  }, [mode]);

  return {
    trunkPlacementV2,
    branchPlacement,
    leafPlacement,
    bracePlacement,
    kickstandPlacement,
    jointCreationState,
    isPlacementDisabled,
    isPlacementHardDisabled,
    globalSelectedId,
    globalSelectedCategory,
    selectedJointId,
    // Model interaction (for trunk placement or branch tip)
    onModelHover,
    onModelClick,
    previewError: trunkPlacementV2.previewError,
    previewWarning: trunkPlacementV2.previewWarning,
    /**
     * Placement previews, keyed by type. Brace names its field `preview`
     * where the others use `previewData`; that is the only difference.
     *
     * Keyed by the owners the registry declares rather than by literals, so a
     * renamed type moves its key here too. The record is still indexed by type
     * downstream, which is the point: `placementActive` and `placementPreviews`
     * keep a key per declared type.
     */
    placementPreviews: {
      [DEFAULT_PLACEMENT_TYPE_ID]: trunkPlacementV2.previewData,
      [BRANCH_FAMILY_PLACEMENT_OWNER]: branchPlacement.previewData,
      [LEAF_PLACEMENT_OWNER]: leafPlacement.previewData,
      [BRACE_PLACEMENT_OWNER]: bracePlacement.preview,
      [KICKSTAND_PLACEMENT_OWNER]: kickstandPlacement.previewData,
    } satisfies SupportPlacementPreviews,
    /**
     * Which placement modes are live, keyed by type, next to the previews above
     * so the scene takes one prop rather than one per type. Trunk is absent: it
     * is the default tool rather than a mode anything toggles.
     */
    placementActive: {
      [BRANCH_FAMILY_PLACEMENT_OWNER]: branchPlacement.isActive,
      [LEAF_PLACEMENT_OWNER]: leafPlacement.isActive,
      [BRACE_PLACEMENT_OWNER]: bracePlacement.isActive,
      [KICKSTAND_PLACEMENT_OWNER]: kickstandPlacement.isActive,
    } satisfies SupportPlacementActive,
  };
}
