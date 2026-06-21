import { useCallback, useEffect } from 'react';
import * as THREE from 'three';
import { useInteractionStatus } from '../../interaction/useInteractionStatus';
import { calculateSmoothedNormal } from '../../PlacementLogic/PlacementUtils';
import { leafPlacementStore, useLeafPlacementState } from './leafPlacementState';
import { useActionActive } from '@/hotkeys/hotkeyStore';
import { getSnapshot, removeKnotById } from '../../state';

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
        if (!sproutedLockActive) {
            const snap = leafPlacementStore.getSnapshot();
            if (snap.junctionHubId) {
                if (snap.junctionHubIsNew) {
                    const leaves = Object.values(getSnapshot().leaves);
                    const hasLeaves = leaves.some(leaf => leaf.parentKnotId === snap.junctionHubId);
                    if (!hasLeaves) {
                        removeKnotById(snap.junctionHubId);
                    }
                }
                leafPlacementStore.setJunctionHub(null, null);
                leafPlacementStore.reset();
            }
        }
    }, [sproutedLockActive]);

    // Escape to cancel
    useEffect(() => {
        const handleEscape = (e: CustomEvent) => {
            if (e.detail.key === 'Escape' && (state.stage === 'awaitingBase' || state.stage === 'awaitingSproutTip')) {
                const snap = leafPlacementStore.getSnapshot();
                if (snap.junctionHubId) {
                    if (snap.junctionHubIsNew) {
                        const leaves = Object.values(getSnapshot().leaves);
                        const hasLeaves = leaves.some(leaf => leaf.parentKnotId === snap.junctionHubId);
                        if (!hasLeaves) {
                            removeKnotById(snap.junctionHubId);
                        }
                    }
                    leafPlacementStore.setJunctionHub(null, null);
                }
                leafPlacementStore.reset();
            }
        };
        window.addEventListener('app-hotkey-keydown', handleEscape as EventListener);
        return () => window.removeEventListener('app-hotkey-keydown', handleEscape as EventListener);
    }, [state.stage]);

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

    const onSupportHover = useCallback((hit: THREE.Intersection | null) => { void hit; }, []);
    const onSupportClick = useCallback((hit: THREE.Intersection | null) => { void hit; }, []);

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
        onSupportHover,
        onSupportClick,
    };
}
