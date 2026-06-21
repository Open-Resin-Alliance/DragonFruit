import { useCallback, useEffect } from 'react';
import * as THREE from 'three';
import { useInteractionStatus } from '../../interaction/useInteractionStatus';
import { calculateSmoothedNormal } from '../../PlacementLogic/PlacementUtils';
import { branchPlacementStore, useBranchPlacementState } from './branchPlacementState';
import { useActionActive } from '@/hotkeys/hotkeyStore';

/**
 * Branch Placement Hook
 * 
 * This hook handles:
 * - Alt key tracking (configurable via hotkeyConfig)
 * - Model clicks to set the tip
 * - Escape to cancel
 * 
 * The actual snapping and preview is handled by BranchPlacementController
 * which runs inside the Canvas.
 */
export function useBranchPlacement() {
    const { isPlacementHardDisabled } = useInteractionStatus();
    const state = useBranchPlacementState();

    const branchHotkeyActive = useActionActive('SUPPORTS', 'BRANCH_PLACEMENT');
    const braceHotkeyActive = useActionActive('SUPPORTS', 'BRANCH_PLACEMENT');

    // Sync branch placement hotkey state to store
    useEffect(() => {
        branchPlacementStore.setAltActive(branchHotkeyActive);
    }, [branchHotkeyActive]);

    // Escape to cancel
    useEffect(() => {
        const handleEscape = (e: CustomEvent) => {
            if (e.detail.key === 'Escape' && state.stage === 'awaitingBase') {
                console.log('[BranchPlacement] Cancelled via Escape');
                branchPlacementStore.reset();
            }
        };
        window.addEventListener('app-hotkey-keydown', handleEscape as EventListener);
        return () => window.removeEventListener('app-hotkey-keydown', handleEscape as EventListener);
    }, [state.stage]);

    // Hover over model - track position for preview dot when Alt is held
    const onModelHover = useCallback((hit: THREE.Intersection | null) => {
        const snapshot = branchPlacementStore.getSnapshot();

        if (snapshot.altActive && snapshot.stage === 'idle' && hit) {
            const pos = { x: hit.point.x, y: hit.point.y, z: hit.point.z };
            branchPlacementStore.setHoverPosition(pos);
        } else if (!snapshot.altActive || snapshot.stage !== 'idle') {
            // Clear hover position when Alt released or after first click
            branchPlacementStore.setHoverPosition(null);
        }
    }, []);

    // Click on model to set tip
    const onModelClick = useCallback((hit: THREE.Intersection | null) => {
        if (isPlacementHardDisabled || !hit) return;

        const snapshot = branchPlacementStore.getSnapshot();
        if (!snapshot.altActive) return;

        // When awaiting the second action (support click or mesh click), do not reset the tip.
        // The controller will handle committing Branch vs Twig/Stick based on the second target.
        if (snapshot.stage !== 'idle') return;

        const normal = calculateSmoothedNormal(hit);
        const pos = { x: hit.point.x, y: hit.point.y, z: hit.point.z };
        const modelId = hit.object.userData?.modelId || 'unknown';
        const placementSurface = hit.object.userData?.supportPlacementSurface === 'interior' ? 'interior' : undefined;

        branchPlacementStore.setTip(pos, normal, modelId, placementSurface);

        console.log('[BranchPlacement] Tip set at', pos, 'awaiting base click on support');
    }, [isPlacementHardDisabled]);

    // These are no-ops - snapping is handled by BranchPlacementController
    const onSupportHover = useCallback((hit: THREE.Intersection | null) => { void hit; }, []);
    const onSupportClick = useCallback((hit: THREE.Intersection | null) => { void hit; }, []);

    // Clear if placement disabled and idle
    useEffect(() => {
        if (isPlacementHardDisabled && state.stage === 'idle') {
            branchPlacementStore.reset();
        }
    }, [isPlacementHardDisabled, state.stage]);

    return {
        branchHotkeyActive,
        braceHotkeyActive,
        altActive: branchHotkeyActive || braceHotkeyActive,
        isActive: state.isActive,
        stage: state.stage,
        previewData: state.previewData,
        previewError: null,
        previewWarning: null,
        tipPosition: state.tipPosition,
        tipNormal: state.tipNormal,
        hoverPosition: state.hoverPosition,
        onModelHover,
        onModelClick,
        onSupportHover,
        onSupportClick,
    };
}
