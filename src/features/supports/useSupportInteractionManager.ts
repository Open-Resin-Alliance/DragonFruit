import { useCallback, useEffect, useSyncExternalStore, useRef } from 'react';
import * as THREE from 'three';
import type { SupportMode } from '@/supports/types';
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
import {
  getSelectedId,
  getSelectedCategory,
  getBranches,
  getBraces,
  getLeaves,
  getSnapshot,
  removeBranch,
  removeBrace,
  removeLeaf,
  removeTwig,
  removeStick,
  removeAnchor,
  removeTrunk,
  removeKickstandCascade,
  removeJointById,
  updateKnot,
  updateTrunk,
  setSelectedId,
  setHoveredState,
  subscribe,
} from '@/supports/state';
import { registerDeleteHandler } from '@/features/delete/deleteRegistry';
import { pushHistory } from '@/history/historyStore';
import { SUPPORT_REMOVE_ANCHOR, SUPPORT_REMOVE_BRANCH, SUPPORT_REMOVE_BRACE, SUPPORT_REMOVE_LEAF, SUPPORT_REMOVE_TRUNK, SUPPORT_UPDATE_TRUNK, SUPPORT_UPDATE_BRANCH, SUPPORT_REMOVE_TWIG, SUPPORT_REMOVE_STICK, SUPPORT_AUTO_BRACE_REPLACE, SUPPORT_REMOVE_KICKSTAND } from '@/supports/history/actionTypes';
import { clearSupportSelection, getResolvedPrimarySelection, selectSupportIds } from '@/supports/interaction/shared/selection/selectionController';
import { getKickstandSnapshot } from '@/supports/SupportTypes/Kickstand/kickstandStore';
import { useHotkeyConfig } from '@/hotkeys/HotkeyContext';
import { getSupportPlacementModifierState, resolveSupportPlacementHotkeyBindings } from '@/supports/interaction/shared/placement/hotkeys/supportPlacementHotkeyResolver';
import { resolveSupportPlacementRouting } from '@/supports/interaction/shared/placement/hotkeys/supportPlacementRouting';

interface SupportInteractionOptions {
  mode: SupportMode;
}

function isEditableTarget(target: EventTarget | null) {
  if (!(target instanceof HTMLElement)) return false;
  if (target.isContentEditable) return true;

  const tagName = target.tagName.toLowerCase();
  if (tagName === 'input' || tagName === 'textarea' || tagName === 'select') return true;

  const role = target.getAttribute('role');
  if (role === 'textbox' || role === 'combobox' || role === 'searchbox' || role === 'spinbutton') return true;

  return false;
}

function resolveSupportCategoryFromSnapshot(id: string) {
  const snapshot = getSnapshot();
  if (snapshot.trunks[id]) return 'trunk' as const;
  if (snapshot.branches[id]) return 'branch' as const;
  if (snapshot.leaves[id]) return 'leaf' as const;
  if (snapshot.twigs[id]) return 'twig' as const;
  if (snapshot.sticks[id]) return 'stick' as const;
  if (snapshot.braces[id]) return 'brace' as const;
  if (snapshot.anchors[id]) return 'anchor' as const;
  if (getKickstandSnapshot().kickstands[id]) return 'brace' as const;
  return null;
}

function collectAllSupportIds() {
  const snapshot = getSnapshot();
  const kickstandSnapshot = getKickstandSnapshot();

  return [
    ...Object.keys(snapshot.trunks),
    ...Object.keys(snapshot.branches),
    ...Object.keys(snapshot.leaves),
    ...Object.keys(snapshot.twigs),
    ...Object.keys(snapshot.sticks),
    ...Object.keys(snapshot.braces),
    ...Object.keys(snapshot.anchors),
    ...Object.keys(kickstandSnapshot.kickstands),
  ];
}

function resolveSupportOwnerFromSegmentId(segmentId: string): { category: 'trunk' | 'branch' | 'twig' | 'stick' | 'brace'; id: string } | null {
  if (!segmentId) return null;

  const snapshot = getSnapshot();
  const kickstandSnapshot = getKickstandSnapshot();

  if (segmentId.startsWith('braceSegment:')) {
    const braceId = segmentId.slice('braceSegment:'.length);
    if (snapshot.braces[braceId]) return { category: 'brace', id: braceId };
  }

  for (const trunk of Object.values(snapshot.trunks)) {
    if (trunk.segments.some((segment) => segment.id === segmentId)) {
      return { category: 'trunk', id: trunk.id };
    }
  }

  for (const branch of Object.values(snapshot.branches)) {
    if (branch.segments.some((segment) => segment.id === segmentId)) {
      return { category: 'branch', id: branch.id };
    }
  }

  for (const twig of Object.values(snapshot.twigs)) {
    if (twig.segments.some((segment) => segment.id === segmentId)) {
      return { category: 'twig', id: twig.id };
    }
  }

  for (const stick of Object.values(snapshot.sticks)) {
    if (stick.segments.some((segment) => segment.id === segmentId)) {
      return { category: 'stick', id: stick.id };
    }
  }

  for (const kickstand of Object.values(kickstandSnapshot.kickstands)) {
    if (kickstand.segments.some((segment) => segment.id === segmentId)) {
      return { category: 'brace', id: kickstand.id };
    }
  }

  return null;
}

function resolveSupportOwnerFromJointId(jointId: string): { category: 'brace'; id: string } | null {
  if (!jointId) return null;

  const kickstandSnapshot = getKickstandSnapshot();
  for (const kickstand of Object.values(kickstandSnapshot.kickstands)) {
    const ownsJoint = kickstand.segments.some((segment) =>
      segment.bottomJoint?.id === jointId || segment.topJoint?.id === jointId,
    );
    if (ownsJoint) {
      return { category: 'brace', id: kickstand.id };
    }
  }

  return null;
}

function getNativeEventSource(source: unknown): unknown {
  if (!source || typeof source !== 'object') return null;
  return (source as { nativeEvent?: unknown }).nativeEvent ?? null;
}

export function useSupportInteractionManager({ mode }: SupportInteractionOptions) {
  // V2 Trunk Placement
  const trunkPlacementV2 = useTrunkPlacementV2();
  const branchPlacement = useBranchPlacement();
  const leafPlacement = useLeafPlacement();
  const bracePlacement = useBracePlacement();
  const kickstandPlacement = useKickstandPlacement();
  const { getHotkey } = useHotkeyConfig();

  const altDownRef = useRef(false);

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

  const resolvePlacementRouting = useCallback((source: unknown) => {
    const bindings = resolveSupportPlacementHotkeyBindings(getHotkey);
    return resolveSupportPlacementRouting({
      bindings,
      modifierState: getSupportPlacementModifierState(source),
      state: {
        branchHotkeyActive: branchPlacement.altActive,
        branchAwaitingBase: branchPlacement.stage === 'awaitingBase',
        leafHotkeyActive: leafPlacement.hotkeyActive,
        leafAwaitingBase: leafPlacement.stage === 'awaitingBase',
        braceHotkeyActive: bracePlacement.altActive,
        braceAwaitingEnd: bracePlacement.stage === 'awaitingEnd',
        kickstandHotkeyActive: kickstandPlacement.hotkeyActive,
      },
    });
  }, [getHotkey, branchPlacement.altActive, branchPlacement.stage, leafPlacement.hotkeyActive, leafPlacement.stage, bracePlacement.altActive, bracePlacement.stage, kickstandPlacement.hotkeyActive]);

  // Handler for MODEL hover (used for trunk placement preview, or branch tip preview)
  const onModelHover = useCallback((hit: THREE.Intersection | null) => {
    const nativeEvent = getNativeEventSource(hit);

    if (isSupportEditInteractionActive()) {
      trunkPlacementV2.onSupportHover(null);
      branchPlacement.onModelHover(null);
      leafPlacement.onModelHover(null);
      return;
    }

    if (isContactDiskHudInteractionActive()) {
      trunkPlacementV2.onSupportHover(null);
      branchPlacement.onModelHover(null);
      leafPlacement.onModelHover(null);
      return;
    }

    if (isPlacementHardDisabled) {
      trunkPlacementV2.onSupportHover(null);
      branchPlacement.onModelHover(null);
      leafPlacement.onModelHover(null);
      return;
    }

    if (jointCreationState.isActive) {
      trunkPlacementV2.onSupportHover(null);
      branchPlacement.onModelHover(null);
      leafPlacement.onModelHover(null);
      return;
    }

    const routing = resolvePlacementRouting(nativeEvent ?? hit);

    if (routing.modelHoverOwner === 'leaf') {
      trunkPlacementV2.onSupportHover(null);
      branchPlacement.onModelHover(null);
      leafPlacement.onModelHover(hit);
      return;
    }

    if (routing.modelHoverOwner === 'branch') {
      trunkPlacementV2.onSupportHover(null);
      leafPlacement.onModelHover(null);
      branchPlacement.onModelHover(hit);
      return;
    }

    if (routing.blocksDefaultModelPlacement) {
      trunkPlacementV2.onSupportHover(null);
      branchPlacement.onModelHover(null);
      leafPlacement.onModelHover(null);
      return;
    }

    trunkPlacementV2.onSupportHover(hit);
  }, [isPlacementHardDisabled, trunkPlacementV2, branchPlacement, leafPlacement, jointCreationState.isActive, resolvePlacementRouting]);

  // Handler for MODEL click (trunk placement, or branch tip placement)
  const onModelClick = useCallback((hit: THREE.Intersection) => {
    const nativeEvent = getNativeEventSource(hit);

    if (isSupportEditInteractionActive()) {
      return;
    }

    if (jointCreationState.isActive) {
      return;
    }

    const routing = resolvePlacementRouting(nativeEvent ?? hit);

    if (routing.modelClickOwner === 'leaf') {
      leafPlacement.onModelClick(hit);
      return;
    }

    if (routing.modelClickOwner === 'branch') {
      branchPlacement.onModelClick(hit);
      return;
    }

    if (routing.blocksDefaultModelPlacement) {
      return;
    }

    trunkPlacementV2.onSupportClick(hit);
  }, [trunkPlacementV2, branchPlacement, leafPlacement, jointCreationState.isActive, resolvePlacementRouting]);

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

    const nativeEvent = getNativeEventSource(hit);
    const routing = resolvePlacementRouting(nativeEvent ?? hit);

    if (routing.supportHoverOwner === 'leaf') {
      leafPlacement.onSupportHover(hit);
    } else if (routing.supportHoverOwner === 'branch') {
      branchPlacement.onSupportHover(hit);
    }
  }, [mode, branchPlacement, leafPlacement, resolvePlacementRouting]);

  // Handler for SUPPORT click (branch base placement on existing support shaft)
  const onSupportClick = useCallback((hit: THREE.Intersection) => {
    if (mode !== 'support') return;

    if (isSupportEditInteractionActive()) {
      return;
    }

    const nativeEvent = getNativeEventSource(hit);
    const routing = resolvePlacementRouting(nativeEvent ?? hit);

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
        if (result.kind === 'trunk') {
          if (recordHistory) {
            pushHistory({
              type: SUPPORT_UPDATE_TRUNK,
              description: 'Delete trunk joint',
              payload: { before: result.before, after: result.after },
            });
          }
          setSelectedId(result.trunkId);
        } else {
          if (recordHistory) {
            pushHistory({
              type: SUPPORT_UPDATE_BRANCH,
              payload: { before: result.before, after: result.after },
            });
          }
          setSelectedId(result.branchId);
        }
        return true;
      }

      if (category === 'segment') {
        const owner = resolveSupportOwnerFromSegmentId(id);
        if (!owner) return false;
        return deleteSelectionByCategoryAndId(owner.category, owner.id, recordHistory);
      }

      if (category === 'trunk') {
        const snapshots = removeTrunk(id);
        if (!snapshots) return false;
        if (recordHistory) {
          pushHistory({
            type: SUPPORT_REMOVE_TRUNK,
            payload: {
              trunk: snapshots.trunk,
              root: snapshots.root ?? undefined,
              branches: snapshots.branches,
              braces: snapshots.braces,
              kickstands: snapshots.kickstands,
              leaves: snapshots.leaves,
              knots: snapshots.knots,
            },
          });
        }
        setSelectedId(null);
        return true;
      }

      if (category === 'leaf') {
        const snapshots = removeLeaf(id);
        if (!snapshots) return false;
        if (recordHistory) {
          pushHistory({
            type: SUPPORT_REMOVE_LEAF,
            payload: { leaf: snapshots.leaf, knot: snapshots.knot ?? undefined },
          });
        }
        setSelectedId(null);
        return true;
      }

      if (category === 'knot') {
        const leaves = getLeaves();
        const leaf = leaves.find(l => l.parentKnotId === id);
        if (leaf) {
          const snapshots = removeLeaf(leaf.id);
          if (!snapshots) return false;
          if (recordHistory) {
            pushHistory({
              type: SUPPORT_REMOVE_LEAF,
              payload: { leaf: snapshots.leaf, knot: snapshots.knot ?? undefined },
            });
          }
          setSelectedId(null);
          return true;
        }

        const branches = getBranches();
        const branch = branches.find(b => b.parentKnotId === id);
        if (branch) {
          const beforeSnapshot = getSnapshot();
          const snapshots = removeBranch(branch.id);
          if (!snapshots) return false;
          const afterSnapshot = getSnapshot();

          let trunkUpdate: { before: unknown; after: unknown } | undefined;
          let knotUpdates: unknown[] | undefined;
          const parentKnot = branch.parentKnotId ? beforeSnapshot.knots[branch.parentKnotId] : undefined;
          const parentSegId = parentKnot?.parentShaftId;
          const trunkId = parentSegId
            ? Object.values(beforeSnapshot.trunks).find(t => t.segments.some(s => s.id === parentSegId))?.id
            : undefined;

          if (trunkId && afterSnapshot.trunks[trunkId]) {
            const applied = computeAndApplyTrunkDiameterProfile(afterSnapshot, trunkId);
            if (applied) {
              for (const u of applied.knotUpdates) updateKnot(u.after);
              updateTrunk(applied.trunk);
              const beforeTrunk = beforeSnapshot.trunks[trunkId];
              if (beforeTrunk) {
                trunkUpdate = { before: structuredClone(beforeTrunk), after: structuredClone(applied.trunk) };
                knotUpdates = applied.knotUpdates;
              }
            }
          }

          if (recordHistory) {
            pushHistory({
              type: SUPPORT_REMOVE_BRANCH,
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

        const braces = getBraces();
        const brace = braces.find(br => br.startKnotId === id || br.endKnotId === id);
        if (brace) {
          const snapshots = removeBrace(brace.id);
          if (!snapshots) return false;
          if (recordHistory) {
            pushHistory({
              type: SUPPORT_REMOVE_BRACE,
              payload: { brace: snapshots.brace, startKnot: snapshots.startKnot ?? undefined, endKnot: snapshots.endKnot ?? undefined },
            });
          }
          setSelectedId(null);
          return true;
        }

        const kickstands = Object.values(getKickstandSnapshot().kickstands);
        const kickstand = kickstands.find((ks) => ks.hostKnotId === id);
        if (kickstand) {
          const kickstandSnapshots = removeKickstandCascade(kickstand.id);
          if (!kickstandSnapshots) return false;
          if (recordHistory) {
            pushHistory({
              type: SUPPORT_REMOVE_KICKSTAND,
              payload: kickstandSnapshots,
            });
          }
          setSelectedId(null);
          return true;
        }

        return false;
      }

      if (category === 'branch') {
        const beforeSnapshot = getSnapshot();
        const snapshots = removeBranch(id);
        if (!snapshots) return false;
        const afterSnapshot = getSnapshot();

        let trunkUpdate: { before: unknown; after: unknown } | undefined;
        let knotUpdates: unknown[] | undefined;
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
            updateTrunk(applied.trunk);
            const beforeTrunk = beforeSnapshot.trunks[trunkId];
            if (beforeTrunk) {
              trunkUpdate = { before: structuredClone(beforeTrunk), after: structuredClone(applied.trunk) };
              knotUpdates = applied.knotUpdates;
            }
          }
        }

        if (recordHistory) {
          pushHistory({
            type: SUPPORT_REMOVE_BRANCH,
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

      if (category === 'twig') {
        const snapshots = removeTwig(id);
        if (!snapshots) return false;
        if (recordHistory) {
          pushHistory({
            type: SUPPORT_REMOVE_TWIG,
            payload: snapshots,
          });
        }
        setSelectedId(null);
        return true;
      }

      if (category === 'stick') {
        const snapshots = removeStick(id);
        if (!snapshots) return false;
        if (recordHistory) {
          pushHistory({
            type: SUPPORT_REMOVE_STICK,
            payload: snapshots,
          });
        }
        setSelectedId(null);
        return true;
      }

      if (category === 'anchor') {
        const snapshots = removeAnchor(id);
        if (!snapshots) return false;
        if (recordHistory) {
          pushHistory({
            type: SUPPORT_REMOVE_ANCHOR,
            payload: { anchor: snapshots.anchor },
          });
        }
        setSelectedId(null);
        return true;
      }

      if (category === 'brace') {
        const kickstandSnapshots = removeKickstandCascade(id);
        if (kickstandSnapshots) {
          if (recordHistory) {
            pushHistory({
              type: SUPPORT_REMOVE_KICKSTAND,
              payload: kickstandSnapshots,
            });
          }
          setSelectedId(null);
          return true;
        }

        const snapshots = removeBrace(id);
        if (!snapshots) return false;
        if (recordHistory) {
          pushHistory({
            type: SUPPORT_REMOVE_BRACE,
            payload: { brace: snapshots.brace, startKnot: snapshots.startKnot ?? undefined, endKnot: snapshots.endKnot ?? undefined },
          });
        }
        setSelectedId(null);
        return true;
      }

      return false;
    };

    const isAltEvent = (e: KeyboardEvent) => {
      return e.key === 'Alt' || e.key === 'AltGraph' || e.code === 'AltLeft' || e.code === 'AltRight';
    };

    const canDeleteSelection = () => {
      const multiSelectedIds = getResolvedPrimarySelection().selectedIds;
      if (multiSelectedIds.length > 0) return true;

      const category = getSelectedCategory();
      const id = getSelectedId();
      if (!id || !category) return false;
      if (category === 'joint' || category === 'trunk' || category === 'leaf' || category === 'branch' || category === 'twig' || category === 'stick' || category === 'brace') return true;

      if (category === 'knot') {
        const leaves = getLeaves();
        if (leaves.some(l => l.parentKnotId === id)) return true;

        const branches = getBranches();
        if (branches.some(b => b.parentKnotId === id)) return true;

        const braces = getBraces();
        if (braces.some(br => br.startKnotId === id || br.endKnotId === id)) return true;

        const kickstands = Object.values(getKickstandSnapshot().kickstands);
        if (kickstands.some((ks) => ks.hostKnotId === id)) return true;

        return false;
      }

      if (category === 'segment') {
        return resolveSupportOwnerFromSegmentId(id) !== null;
      }

      return false;
    };

    const performDeleteSelection = () => {
      const multiSelectedIds = Array.from(new Set(getResolvedPrimarySelection().selectedIds));
      if (multiSelectedIds.length > 0) {
        const beforeSupportSnapshot = structuredClone(getSnapshot());
        const beforeKickstandSnapshot = structuredClone(getKickstandSnapshot());
        let anyDeleted = false;
        for (const supportId of multiSelectedIds) {
          const category = resolveSupportCategoryFromSnapshot(supportId);
          if (!category) continue;
          const deleted = deleteSelectionByCategoryAndId(category, supportId, false);
          if (deleted) anyDeleted = true;
        }

        if (anyDeleted) {
          const afterSupportSnapshot = structuredClone(getSnapshot());
          const afterKickstandSnapshot = structuredClone(getKickstandSnapshot());

          pushHistory({
            type: SUPPORT_AUTO_BRACE_REPLACE,
            description: `Delete ${multiSelectedIds.length} supports`,
            payload: {
              before: beforeSupportSnapshot,
              after: afterSupportSnapshot,
              kickstandBefore: beforeKickstandSnapshot,
              kickstandAfter: afterKickstandSnapshot,
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
    };

    const onKeyDown = (e: KeyboardEvent) => {
      if (isEditableTarget(e.target)) return;

      if (!e.metaKey && !e.ctrlKey && (e.key === 'Delete' || e.key === 'Backspace')) {
        if (!canDeleteSelection()) return;
        e.preventDefault();
        e.stopPropagation();
        performDeleteSelection();
        return;
      }

      if (e.key === 'Escape') {
        if (getSelectedId() || getResolvedPrimarySelection().selectedIds.length > 0) {
          e.preventDefault();
          e.stopPropagation();
          clearSupportSelection();
          setHoveredState('none', null);
        }
        return;
      }

      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'a') {
        e.preventDefault();
        e.stopPropagation();
        const allSupportIds = collectAllSupportIds();
        selectSupportIds(allSupportIds);
        return;
      }

      if (!isAltEvent(e)) return;
      if (e.repeat) return;
      if (altDownRef.current) return;
      altDownRef.current = true;
      console.log('[AltKey]', 'down', { key: e.key, code: e.code, time: performance.now() });
    };

    const onKeyUp = (e: KeyboardEvent) => {
      if (!isAltEvent(e)) return;
      if (!altDownRef.current) return;
      altDownRef.current = false;
      console.log('[AltKey]', 'up', { key: e.key, code: e.code, time: performance.now() });
    };

    window.addEventListener('keydown', onKeyDown, true);
    window.addEventListener('keyup', onKeyUp, true);
    document.addEventListener('keydown', onKeyDown, true);
    document.addEventListener('keyup', onKeyUp, true);

    const unregister = registerDeleteHandler(
      () => mode === 'support' && canDeleteSelection(),
      performDeleteSelection,
      100,
    );

    return () => {
      window.removeEventListener('keydown', onKeyDown, true);
      window.removeEventListener('keyup', onKeyUp, true);
      document.removeEventListener('keydown', onKeyDown, true);
      document.removeEventListener('keyup', onKeyUp, true);
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
    trunkPreview: trunkPlacementV2.previewData,
    branchPreview: branchPlacement.previewData,
    leafPreview: leafPlacement.previewData,
    bracePreview: bracePlacement.preview,
    kickstandPreview: kickstandPlacement.previewData,
  };
}
