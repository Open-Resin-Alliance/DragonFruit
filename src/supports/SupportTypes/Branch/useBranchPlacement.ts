import { useCallback, useEffect, useRef } from 'react';
import * as THREE from 'three';
import { useInteractionStatus } from '../../interaction/useInteractionStatus';
import { calculateSmoothedNormal } from '../../PlacementLogic/PlacementUtils';
import { branchPlacementStore, useBranchPlacementState } from './branchPlacementState';
import { useHotkeyConfig } from '@/hotkeys/HotkeyContext';
import { matchesConfiguredHotkeyDown, matchesConfiguredHotkeyUp } from '@/hotkeys/hotkeyConfig';
import { canResolveSupportPlacementBindingFromModifierState, getSupportPlacementModifierState, isSupportPlacementBindingSatisfiedByModifierState } from '../../interaction/shared/placement/hotkeys/supportPlacementHotkeyResolver';

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
    const { getHotkey } = useHotkeyConfig();
    const binding = getHotkey('SUPPORTS', 'BRANCH_PLACEMENT');
    const pointerFreshSinceIdleActivationRef = useRef(false);

    const { isPlacementHardDisabled } = useInteractionStatus();
    const state = useBranchPlacementState();

    // Track branch placement hotkey globally
    useEffect(() => {
        const modifierResolvable = canResolveSupportPlacementBindingFromModifierState(binding);

        const cancelBranchMode = () => {
            pointerFreshSinceIdleActivationRef.current = false;
            branchPlacementStore.setAltActive(false);
            branchPlacementStore.reset();
        };

        const down = (e: KeyboardEvent) => {
            const matches = matchesConfiguredHotkeyDown(e, binding);
            if (matches) {
                e.preventDefault();
                pointerFreshSinceIdleActivationRef.current = false;
                branchPlacementStore.setAltActive(true);
            }
        };
        const up = (e: KeyboardEvent) => {
            const matches = matchesConfiguredHotkeyUp(e, binding);
            if (matches) {
                e.preventDefault();
                cancelBranchMode();
            }
        };

        const blur = () => {
            cancelBranchMode();
        };

        const pointerMove = (e: PointerEvent) => {
            const snapshot = branchPlacementStore.getSnapshot();
            const bindingHeld = isSupportPlacementBindingSatisfiedByModifierState(binding, getSupportPlacementModifierState(e));

            if (modifierResolvable && (snapshot.altActive || snapshot.stage === 'awaitingBase') && !bindingHeld) {
                cancelBranchMode();
                return;
            }

            if (snapshot.altActive && snapshot.stage === 'idle' && (!modifierResolvable || bindingHeld)) {
                pointerFreshSinceIdleActivationRef.current = true;
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
    }, [binding]);

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
        if (snapshot.altActive && snapshot.stage === 'idle' && !pointerFreshSinceIdleActivationRef.current) {
            branchPlacementStore.setHoverPosition(null);
            return;
        }

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
        const bindingHeld = isSupportPlacementBindingSatisfiedByModifierState(binding, getSupportPlacementModifierState(hit));
        if (!snapshot.altActive && !bindingHeld) return;

        if (!snapshot.altActive) {
            branchPlacementStore.setAltActive(true);
        }

        // When awaiting the second action (support click or mesh click), do not reset the tip.
        // The controller will handle committing Branch vs Twig/Stick based on the second target.
        if (snapshot.stage !== 'idle') return;

        const normal = calculateSmoothedNormal(hit);
        const pos = { x: hit.point.x, y: hit.point.y, z: hit.point.z };
        const modelId = hit.object.userData?.modelId || 'unknown';
        const placementSurface = hit.object.userData?.supportPlacementSurface === 'interior' ? 'interior' : undefined;

        branchPlacementStore.setTip(pos, normal, modelId, placementSurface);

        console.log('[BranchPlacement] Tip set at', pos, 'awaiting base click on support');
    }, [binding, isPlacementHardDisabled]);

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
