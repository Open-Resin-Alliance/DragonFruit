import {
    applySupportSelectionClick,
    clearSupportSelection,
    getResolvedPrimarySelection,
    selectJointById,
    selectPrimitiveById,
    selectSupportById,
    selectSupportIds,
} from './shared/selection/selectionController';
import { useResolvedSelectionState } from './shared/selection/resolvedSelectionStore';

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
    applySupportSelectionClick({
        id,
        shiftKey: false,
        isInteractable: true,
    });
}

export function selectSupportWithToggle(id: string) {
    selectSupportById(id, true);
}

export function selectAllSupports(ids: string[]) {
    selectSupportIds(ids);
}

export function getMultiSelectedSupportIds() {
    return getResolvedPrimarySelection().selectedIds;
}

/**
 * Select a joint by ID.
 * Infers the category 'joint'.
 */
export function selectJoint(id: string) {
    selectJointById(id);
}

export function selectContactDisk(id: string) {
    selectPrimitiveById(id);
}

export function selectContactDisk(id: string) {
    setSelectedId(id);
}

/**
 * Clear any current selection (support or joint).
 */
export function clearSelection() {
    clearSupportSelection();
    if (typeof window !== 'undefined') {
        window.dispatchEvent(new CustomEvent('support-selection-cleared'));
    }
}

/**
 * Hook to consume support selection state.
 * Returns selection details and helper booleans.
 */
export function useSupportSelection() {
    const resolvedSelection = useResolvedSelectionState();
    const selectedSupportIds = resolvedSelection.selectedIds;

    return {
        selectedId: resolvedSelection.selectedId,
        selectedCategory: resolvedSelection.selectedCategory,
        selectedSupportIds,
        
        // Helpers
        isSelected: (id: string) => resolvedSelection.selectedId === id || selectedSupportIds.includes(id),
        hasSelection: resolvedSelection.selectedId !== null || selectedSupportIds.length > 0,
        isJointSelected: resolvedSelection.selectedCategory === 'joint',
        isSupportSelected: ['trunk', 'branch', 'leaf', 'twig', 'stick', 'root', 'brace', 'knot'].includes(resolvedSelection.selectedCategory || '')
    };
}
