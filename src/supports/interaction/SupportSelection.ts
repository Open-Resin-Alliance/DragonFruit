import { setSelectedId, getSelectedId, getSelectedCategory, subscribe } from '../state';
import { useSyncExternalStore } from 'react';
import {
    clearSelectedSupportIds,
    getEmptySelectedSupportIdsSnapshot,
    getSelectedSupportIds,
    setSelectedSupportIds,
    subscribeSupportMultiSelection,
    toggleSelectedSupportId,
} from './supportMultiSelection';

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
    clearSelectedSupportIds();
    setSelectedSupportIds([id]);
    setSelectedId(id);
}

export function selectSupportWithToggle(id: string) {
    if (!id) return;

    const existing = getSelectedSupportIds();
    const isAlreadySelected = existing.includes(id);

    toggleSelectedSupportId(id);

    const updated = getSelectedSupportIds();

    if (isAlreadySelected) {
        setSelectedId(updated.length > 0 ? updated[updated.length - 1] : null);
        return;
    }

    // Once a second support is added, transition out of single-support edit mode
    // into bulk multi-select mode (same UX intent as Ctrl+A behavior).
    if (updated.length > 1) {
        setSelectedId(null);
        return;
    }

    setSelectedId(id);
}

export function selectAllSupports(ids: string[]) {
    const normalized = ids.filter(Boolean);
    clearSelectedSupportIds();
    setSelectedSupportIds(normalized);
    setSelectedId(normalized.length > 0 ? normalized[0] : null);
}

export function getMultiSelectedSupportIds() {
    return getSelectedSupportIds();
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
    clearSelectedSupportIds();
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

    const selectedSupportIds = useSyncExternalStore(
        subscribeSupportMultiSelection,
        getSelectedSupportIds,
        getEmptySelectedSupportIdsSnapshot,
    );

    return {
        selectedId: state.selectedId,
        selectedCategory: state.selectedCategory,
        selectedSupportIds,
        
        // Helpers
        isSelected: (id: string) => state.selectedId === id || selectedSupportIds.includes(id),
        hasSelection: state.selectedId !== null,
        isJointSelected: state.selectedCategory === 'joint',
        isSupportSelected: ['trunk', 'branch', 'leaf', 'twig', 'stick', 'root', 'brace', 'knot'].includes(state.selectedCategory || '')
    };
}
