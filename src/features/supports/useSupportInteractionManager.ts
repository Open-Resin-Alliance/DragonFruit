import { useCallback, useEffect, useMemo, useSyncExternalStore, useRef } from 'react';
import * as THREE from 'three';
import type { SupportMode } from '@/supports/types';
import type { SupportPlacementPreviews } from '@/supports/rendering';
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
import { computeAndApplyTrunkDiameterProfile } from '@/supports/SupportTypes/Trunk/TrunkReplacement';
import { cloneSupportState, getSelectedId, getSelectedCategory, findShaftOwnerOfJoint, findShaftOwnerOfSegment, getSupportEntities, getSupportTypeOf, getSupports, getSnapshot, removeBranch, removeBrace, removeLeaf, removeSupportEntity, removeJointById, updateKnot, setSelectedId, setHoveredState, subscribe } from '@/supports/state';
import { registerDeleteHandler } from '@/features/delete/deleteRegistry';
import { pushSupportHistory } from '@/supports/history/supportHistory';
import { SUPPORT_UPDATE_TRUNK, SUPPORT_UPDATE_BRANCH, SUPPORT_AUTO_BRACE_REPLACE, type SupportBranchRemovePayload, removeAction } from '@/supports/history/actionTypes';
import { findKnotHost, getSupportTypeBySelectionCategory, getSupportTypeDescriptor, KNOT_HOST_PRECEDENCE, RESHAPED_REMOVAL_PAYLOADS, SUPPORT_TYPES, updateSupportEntity } from '@/supports/supportTypeRegistry';
import { MODEL_SURFACE_GESTURE_TYPES } from '@/supports/supportTypeRegistry';
import type { ModelSurfaceGestureTypeId } from '@/supports/supportTypeRegistry';
import { knotFields } from '@/supports/interaction/shared/selection/selectedIdsByType';
import { clearSupportSelection, getResolvedPrimarySelection, selectSupportIds } from '@/supports/interaction/shared/selection/selectionController';
import { useHotkeyConfig } from '@/hotkeys/HotkeyContext';
import { resolveSupportPlacementHotkeyBindings } from '@/supports/interaction/shared/placement/hotkeys/supportPlacementHotkeyResolver';
import { resolveSupportPlacementRouting, routeModelPlacementHit } from '@/supports/interaction/shared/placement/hotkeys/supportPlacementRouting';
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
 * which resolves every type and brace's `braceSegment:` prefix from the registry.
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
   */
  const modelPlacementByOwner = useMemo(() => ({
    branch: branchPlacement,
    leaf: leafPlacement,
  } satisfies Record<ModelSurfaceGestureTypeId, SupportModelPlacementHandlers>), [branchPlacement, leafPlacement]);

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
      dispatchModelHover('leaf', hit);
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

  // Handler for SUPPORT hover (branch base preview when hovering existing support shafts)
  // NOTE: We do NOT check isPlacementDisabled here because branch placement
  // REQUIRES hovering over supports. The isPlacementDisabled check would
  // always be true when hovering a support, breaking branch placement.
  const onSupportHover = useCallback((hit: THREE.Intersection | null) => {
    if (mode !== 'support') return;

    if (isSupportEditInteractionActive()) {
      leafPlacement.onSupportHover(null);
      branchPlacement.onSupportHover(null);
      return;
    }

    const fanningActive = leafPlacement.sproutParentingLockHeld || leafPlacement.stage === 'awaitingSproutTip';
    if (fanningActive) {
      branchPlacement.onSupportHover(null);
      leafPlacement.onSupportHover(hit);
      return;
    }

    const routing = resolvePlacementRouting();

    if (routing.supportHoverOwner === 'leaf') {
      leafPlacement.onSupportHover(hit);
      branchPlacement.onSupportHover(null);
    } else if (routing.supportHoverOwner === 'branch') {
      branchPlacement.onSupportHover(hit);
      leafPlacement.onSupportHover(null);
    } else {
      leafPlacement.onSupportHover(null);
      branchPlacement.onSupportHover(null);
    }
  }, [mode, branchPlacement, leafPlacement, resolvePlacementRouting]);

  // Handler for SUPPORT click (branch base placement on existing support shaft)
  const onSupportClick = useCallback((hit: THREE.Intersection) => {
    if (mode !== 'support') return;

    if (isSupportEditInteractionActive()) {
      return;
    }

    const fanningActive = leafPlacement.sproutParentingLockHeld || leafPlacement.stage === 'awaitingSproutTip';
    if (fanningActive) {
      leafPlacement.onSupportClick(hit);
      return;
    }

    const routing = resolvePlacementRouting();

    if (routing.blocksDefaultSupportPlacement) {
      return;
    }

    if (routing.supportClickOwner === 'leaf') {
      leafPlacement.onSupportClick(hit);
    } else if (routing.supportClickOwner === 'branch') {
      branchPlacement.onSupportClick(hit);
    }
    // Note: clicking on supports in non-branch mode is handled by SupportRenderer (selection)
  }, [mode, branchPlacement, leafPlacement, resolvePlacementRouting]);

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
        // full-state snapshot. The payload map is keyed per action, so each
        // push stays narrow while the DECISION comes from the registry.
        const descriptor = getSupportTypeDescriptor(result.typeId);
        if (recordHistory && descriptor.historyUpdate) {
          const description = `Delete ${descriptor.singular} joint`;
          if (result.typeId === 'trunk') {
            pushSupportHistory({
              type: SUPPORT_UPDATE_TRUNK,
              description,
              payload: { before: result.before, after: result.after },
            });
          } else if (result.typeId === 'branch') {
            pushSupportHistory({
              type: SUPPORT_UPDATE_BRANCH,
              description,
              payload: { before: result.before, after: result.after },
            });
          }
        }
        setSelectedId(result.id);
        return true;
      }

      if (category === 'segment') {
        const owner = resolveSupportOwnerFromSegmentId(id);
        if (!owner) return false;
        return deleteSelectionByCategoryAndId(owner.category, owner.id, recordHistory);
      }

      if (category === 'leaf') {
        const snapshots = removeLeaf(id);
        if (!snapshots) return false;
        if (recordHistory) {
          pushSupportHistory({
            type: removeAction('leaf'),
            payload: { leaf: snapshots.leaf, knot: snapshots.knot ?? null },
          });
        }
        setSelectedId(null);
        return true;
      }

      // Types whose removal is the cascade plus one history entry, under the
      // action they declare. Branch, leaf and brace reshape their payload and
      // keep their own blocks below.
      const removalDescriptor = getSupportTypeBySelectionCategory(category);
      if (removalDescriptor && !RESHAPED_REMOVAL_PAYLOADS.has(removalDescriptor.id)) {
        const snapshots = removeSupportEntity(removalDescriptor.id, id);
        if (!snapshots) return false;
        if (recordHistory) {
          pushSupportHistory({
            type: removalDescriptor.historyRemove,
            payload: snapshots,
          } as Parameters<typeof pushSupportHistory>[0]);
        }
        setSelectedId(null);
        return true;
      }

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

      if (category === 'branch') {
        const beforeSnapshot = getSnapshot();
        const snapshots = removeBranch(id);
        if (!snapshots) return false;
        const afterSnapshot = getSnapshot();

        let trunkUpdate: SupportBranchRemovePayload['trunkUpdate'];
        let knotUpdates: SupportBranchRemovePayload['knotUpdates'];
        const removedRootBranch = snapshots.branches.find(b => b.id === id) ?? snapshots.branches[0];
        const parentKnot = removedRootBranch?.parentKnotId ? beforeSnapshot.knots[removedRootBranch.parentKnotId] : undefined;
        const parentSegId = parentKnot?.parentShaftId;
        const trunkId = parentSegId
          ? Object.values(beforeSnapshot.trunks).find(t => t.segments.some(s => s.id === parentSegId))?.id
          : undefined;

        if (trunkId && afterSnapshot.trunks[trunkId]) {
          const applied = computeAndApplyTrunkDiameterProfile(afterSnapshot, trunkId);
          if (applied) {
            for (const u of applied.knotUpdates) updateKnot(u.after);
            updateSupportEntity('trunk', applied.trunk);
            const beforeTrunk = beforeSnapshot.trunks[trunkId];
            if (beforeTrunk) {
              trunkUpdate = { before: structuredClone(beforeTrunk), after: structuredClone(applied.trunk) };
              knotUpdates = applied.knotUpdates;
            }
          }
        }

        if (recordHistory) {
          pushSupportHistory({
            type: removeAction('branch'),
            payload: {
              ...snapshots,
              trunkUpdate,
              knotUpdates,
            },
          });
        }
        setSelectedId(null);
        return true;
      }

      if (category === 'brace') {
        const snapshots = removeBrace(id);
        if (!snapshots) return false;
        if (recordHistory) {
          pushSupportHistory({
            type: removeAction('brace'),
            payload: { brace: snapshots.brace, startKnot: snapshots.startKnot ?? null, endKnot: snapshots.endKnot ?? null },
          });
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
      // Every support type is deletable; 'joint' too. Enumerating them here is
      // how anchors ended up deletable but gated out of single-selection Delete.
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
            const snapshot = getSnapshot();
            const childLeaves = Object.values(snapshot.leaves).filter(l => l.parentKnotId === id);
            const childBranches = Object.values(snapshot.branches).filter(b => b.parentKnotId === id);
            const children = [
              ...childLeaves.map(l => ({ id: l.id, category: 'leaf' })),
              ...childBranches.map(b => ({ id: b.id, category: 'branch' })),
            ];
            if (children.length > 0) {
              children.sort((a, b) => a.id.localeCompare(b.id));
              selectSupportIds([children[0].id]);
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
    // Support interaction (for branch base placement)
    onSupportHover,
    onSupportClick,
    previewError: trunkPlacementV2.previewError,
    previewWarning: trunkPlacementV2.previewWarning,
    /**
     * Placement previews, keyed by type. Brace names its field `preview`
     * where the others use `previewData`; that is the only difference.
     */
    placementPreviews: {
      trunk: trunkPlacementV2.previewData,
      branch: branchPlacement.previewData,
      leaf: leafPlacement.previewData,
      brace: bracePlacement.preview,
      kickstand: kickstandPlacement.previewData,
    } satisfies SupportPlacementPreviews,
  };
}
