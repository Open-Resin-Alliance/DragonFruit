import { useSyncExternalStore } from 'react';
import { subscribe, getSelectedCategory } from '../state';
import { useResolvedHoverState } from './shared/hover/resolvedHoverStore';
import { useImmediateModelHoverId as useSharedImmediateModelHoverId } from './shared/hover/modelHoverResolver';

export function useImmediateModelHoverId() {
    return useSharedImmediateModelHoverId();
}

/**
 * Hook to determine the global interaction status.
 * Centralizes logic for when placement tools should be disabled (e.g. when editing/gizmo is active).
 */
export function useInteractionStatus() {
    const selectedCategory = useSyncExternalStore(
        subscribe, 
        getSelectedCategory,
        () => null // Server snapshot
    );
    const resolvedHover = useResolvedHoverState();
    
    // If a Joint is selected, the Gizmo is active -> Disable placement
    const isGizmoActive = selectedCategory === 'joint' || resolvedHover.activeSource === 'gizmo';
    const isHoveringElement = resolvedHover.activeSource !== 'none'
        && resolvedHover.activeSource !== 'model';
    
    return {
        isGizmoActive,
        isHoveringElement,
        isPlacementDisabled: isGizmoActive || isHoveringElement,
        isPlacementHardDisabled: isGizmoActive
    };
}
