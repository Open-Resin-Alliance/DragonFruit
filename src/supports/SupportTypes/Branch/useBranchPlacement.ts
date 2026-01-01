import { useCallback, useEffect } from 'react';
import * as THREE from 'three';
import { useInteractionStatus } from '../../interaction/useInteractionStatus';
import { calculateSmoothedNormal } from '../../PlacementLogic/PlacementUtils';
import { branchPlacementStore, useBranchPlacementState } from './branchPlacementState';
import { DEFAULT_KEYBINDINGS, matchesConfiguredHotkeyDown, matchesConfiguredHotkeyUp } from '@/hotkeys/hotkeyConfig';

// Get the configured hotkey for branch placement
const BRANCH_KEY = DEFAULT_KEYBINDINGS.SUPPORTS.BRANCH_PLACEMENT.key;

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
    const { isPlacementDisabled } = useInteractionStatus();
    const state = useBranchPlacementState();

    // Track branch placement hotkey globally
    useEffect(() => {
        const down = (e: KeyboardEvent) => {
            const matches = matchesConfiguredHotkeyDown(e, { key: BRANCH_KEY }) || e.key === BRANCH_KEY || (BRANCH_KEY === 'Alt' && e.key === 'AltGraph');
            if (matches) {
                e.preventDefault();
                branchPlacementStore.setAltActive(true);
            }
        };
        const up = (e: KeyboardEvent) => {
            const releasedAlt = e.key === 'Alt' || e.key === 'AltGraph' || e.code === 'AltLeft' || e.code === 'AltRight';
            const matches = matchesConfiguredHotkeyUp(e, { key: BRANCH_KEY }) || e.key === BRANCH_KEY || (BRANCH_KEY === 'Alt' && e.key === 'AltGraph');
            if (matches || (BRANCH_KEY === 'Alt' && releasedAlt)) {
                e.preventDefault();
                // Releasing the key cancels branch mode entirely and returns to trunk mode
                branchPlacementStore.setAltActive(false);
                branchPlacementStore.reset();
            }
        };

        const blur = () => {
            // Losing focus can prevent keyup from firing. Treat it as a cancel.
            branchPlacementStore.setAltActive(false);
            branchPlacementStore.reset();
        };

        const pointerMove = (e: PointerEvent) => {
            // Some browser/OS combos can miss Alt keyup. Pointer events still report modifier state.
            const snapshot = branchPlacementStore.getSnapshot();
            if ((snapshot.altActive || snapshot.stage === 'awaitingBase') && !e.altKey) {
                branchPlacementStore.setAltActive(false);
                branchPlacementStore.reset();
            }
        };

        // Capture phase so canvas-level handlers can't swallow these
        window.addEventListener('keydown', down, true);
        window.addEventListener('keyup', up, true);
        document.addEventListener('keyup', up, true);
        window.addEventListener('blur', blur);
        window.addEventListener('pointermove', pointerMove, true);
        return () => {
            window.removeEventListener('keydown', down, true);
            window.removeEventListener('keyup', up, true);
            document.removeEventListener('keyup', up, true);
            window.removeEventListener('blur', blur);
            window.removeEventListener('pointermove', pointerMove, true);
        };
    }, []);

    // Escape to cancel
    useEffect(() => {
        const handleEscape = (e: KeyboardEvent) => {
            if (e.key === 'Escape' && state.stage === 'awaitingBase') {
                console.log('[BranchPlacement] Cancelled via Escape');
                branchPlacementStore.reset();
            }
        };
        window.addEventListener('keydown', handleEscape);
        return () => window.removeEventListener('keydown', handleEscape);
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
    }, [state.altActive, state.stage]);

    // Click on model to set tip
    const onModelClick = useCallback((hit: THREE.Intersection | null) => {
        if (isPlacementDisabled || !hit) return;

        const nativeEvent = (hit as any)?.nativeEvent;
        const altDown = !!(nativeEvent?.altKey ?? (hit as any)?.altKey);
        if (!altDown) return;

        const snapshot = branchPlacementStore.getSnapshot();
        if (!snapshot.altActive) {
            branchPlacementStore.setAltActive(true);
        }

        // When awaiting the second action (support click or mesh click), do not reset the tip.
        // The controller will handle committing Branch vs Twig/Stick based on the second target.
        if (snapshot.stage !== 'idle') return;

        const normal = calculateSmoothedNormal(hit);
        const pos = { x: hit.point.x, y: hit.point.y, z: hit.point.z };
        const modelId = hit.object.userData?.modelId || 'unknown';

        branchPlacementStore.setTip(pos, normal, modelId);

        console.log('[BranchPlacement] Tip set at', pos, 'awaiting base click on support');
    }, [isPlacementDisabled]);

    // These are no-ops - snapping is handled by BranchPlacementController
    const onSupportHover = useCallback((hit: THREE.Intersection | null) => { }, []);
    const onSupportClick = useCallback((hit: THREE.Intersection | null) => { }, []);

    // Clear if placement disabled and idle
    useEffect(() => {
        if (isPlacementDisabled && state.stage === 'idle') {
            branchPlacementStore.reset();
        }
    }, [isPlacementDisabled, state.stage]);

    return {
        altActive: state.altActive,
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
