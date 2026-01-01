import { setSelectedId, getSelectedId, getSelectedCategory, subscribe } from '../state';
import { useSyncExternalStore } from 'react';

/**
 * Interaction module for V2 support selection.
 * Centralizes selection logic and decouples components from the raw state store.
 * 
 * Usage:
 * - Import { selectSupport, selectJoint, clearSelection } to change selection.
 * - Import { useSupportSelection } to consume selection state in React components.
 */

/**
 * Select a support (trunk, branch, root, etc.) by ID.
 * Infers the category based on the ID.
 */
export function selectSupport(id: string) {
    setSelectedId(id);
}

/**
 * Select a joint by ID.
 * Infers the category 'joint'.
 */
export function selectJoint(id: string) {
    setSelectedId(id);
}

/**
 * Clear any current selection (support or joint).
 */
export function clearSelection() {
    setSelectedId(null);
}

/**
 * Hook to consume support selection state.
 * Returns selection details and helper booleans.
 */
export function useSupportSelection() {
    const state = useSyncExternalStore(
        subscribe,
        () => ({
            selectedId: getSelectedId(),
            selectedCategory: getSelectedCategory(),
        }),
        () => ({ selectedId: null, selectedCategory: null }) // Server snapshot
    );

    return {
        selectedId: state.selectedId,
        selectedCategory: state.selectedCategory,
        
        // Helpers
        isSelected: (id: string) => state.selectedId === id,
        hasSelection: state.selectedId !== null,
        isJointSelected: state.selectedCategory === 'joint',
        isSupportSelected: ['trunk', 'branch', 'leaf', 'root', 'brace', 'knot'].includes(state.selectedCategory || '')
    };
}
