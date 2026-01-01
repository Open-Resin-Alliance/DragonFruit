import { useSyncExternalStore } from 'react';
import { subscribe, getSelectedCategory, getHoveredId, getHoveredCategory } from '../state';

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

    const hoveredCategory = useSyncExternalStore(
        subscribe,
        getHoveredCategory,
        () => 'none' // Server snapshot
    );
    
    // If a Joint is selected, the Gizmo is active -> Disable placement
    const isGizmoActive = selectedCategory === 'joint';

    // If hovering over any interactive element (support, joint, raft, gizmo), disable placement.
    // 'model' and 'none' are safe for placement.
    const isHoveringElement = hoveredCategory !== 'none' && hoveredCategory !== 'model';
    
    return {
        isGizmoActive,
        isHoveringElement,
        isPlacementDisabled: isGizmoActive || isHoveringElement
    };
}
