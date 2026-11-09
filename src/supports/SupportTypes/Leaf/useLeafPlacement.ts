import { useCallback, useEffect } from 'react';
import * as THREE from 'three';
import { useInteractionStatus } from '../../interaction/useInteractionStatus';
import { calculateSmoothedNormal } from '../../PlacementLogic/PlacementUtils';
import { leafPlacementStore, useLeafPlacementState } from './leafPlacementState';
import { useActionActive } from '@/hotkeys/hotkeyStore';
import { useEscapeToClose } from '@/hotkeys/useEscapeToClose';
import { getSnapshot, removeKnotById } from '../../state';
import { subscribeHistoryChanges } from '@/history/historyStore';

/** Drops the junction hub knot when the fan ends without a leaf on it. */
function discardUnclaimedJunctionHub(): void {
    const snap = leafPlacementStore.getSnapshot();
    if (!snap.junctionHubId) return;

    if (snap.junctionHubIsNew) {
        const claimed = Object.values(getSnapshot().leaves)
            .some((leaf) => leaf.parentKnotId === snap.junctionHubId);
        if (!claimed) removeKnotById(snap.junctionHubId);
    }
    leafPlacementStore.setJunctionHub(null, null);
}

export const LEAF_HOTKEY_REARM_EVENT = 'support-leaf-hotkey-rearm';

export function useLeafPlacement() {
    const { isPlacementDisabled } = useInteractionStatus();
    const state = useLeafPlacementState();
    const hotkeyActive = useActionActive('SUPPORTS', 'LEAF_PLACEMENT');

    // Sync hotkey state to leaf placement store
    useEffect(() => {
        leafPlacementStore.setHotkeyActive(hotkeyActive);
    }, [hotkeyActive]);

    const sproutedLockActive = useActionActive('SUPPORTS', 'SPROUTED_PARENTING_LOCK');

    // Sync sprouted parenting lock key state to store
    useEffect(() => {
        leafPlacementStore.setSproutParentingLockHeld(sproutedLockActive);
        if (!sproutedLockActive && leafPlacementStore.getSnapshot().junctionHubId) {
            discardUnclaimedJunctionHub();
            leafPlacementStore.reset();
        }
    }, [sproutedLockActive]);

    // An undo can take the leaf that staged the hub, leaving a knot nothing
    // claims; the entry cannot restore it because it was written after.
    useEffect(() => {
        const unsubscribe = subscribeHistoryChanges((change) => {
            if (change.kind === 'push') return;
            discardUnclaimedJunctionHub();
        });
        return () => { unsubscribe(); };
    }, []);

    // Escape to cancel
    useEscapeToClose(
        state.stage === 'awaitingBase' || state.stage === 'awaitingSproutTip',
        () => {
            discardUnclaimedJunctionHub();
            leafPlacementStore.reset();
        },
    );

    const onModelHover = useCallback((hit: THREE.Intersection | null) => {
        const leafReady = state.hotkeyActive;
        if (leafReady && state.stage === 'idle' && hit) {
            const pos = { x: hit.point.x, y: hit.point.y, z: hit.point.z };
            leafPlacementStore.setHoverPosition(pos);
        } else if (!leafReady || state.stage !== 'idle') {
            leafPlacementStore.setHoverPosition(null);
        }
    }, [state.hotkeyActive, state.stage]);

    const onModelClick = useCallback((hit: THREE.Intersection | null) => {
        if (!state.hotkeyActive || isPlacementDisabled || !hit) return;

        const surfaceNormal = calculateSmoothedNormal(hit);
        const pos = { x: hit.point.x, y: hit.point.y, z: hit.point.z };
        const modelId = hit.object.userData?.modelId || 'unknown';
        const placementSurface = hit.object.userData?.supportPlacementSurface === 'interior' ? 'interior' : undefined;

        leafPlacementStore.setTip(pos, surfaceNormal, modelId, placementSurface);
    }, [state.hotkeyActive, isPlacementDisabled]);

    useEffect(() => {
        if (isPlacementDisabled && state.stage === 'idle') {
            leafPlacementStore.reset();
        }
    }, [isPlacementDisabled, state.stage]);

    return {
        hotkeyActive: state.hotkeyActive,
        isActive: state.isActive,
        stage: state.stage,
        previewData: state.previewData,
        tipPosition: state.tipPosition,
        surfaceNormal: state.surfaceNormal,
        hoverPosition: state.hoverPosition,
        sproutParentingLockHeld: state.sproutParentingLockHeld,
        onModelHover,
        onModelClick,
    };
}
