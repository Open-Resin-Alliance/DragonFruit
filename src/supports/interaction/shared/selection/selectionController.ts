import { getSelectedCategory, getSelectedId, setSelectedId } from '@/supports/state';
import {
    clearSelectedSupportIds,
    getSelectedSupportIds,
    setSelectedSupportIds,
    toggleSelectedSupportId,
} from '@/supports/interaction/supportMultiSelection';
import type { SupportSelectionClickInput } from './selectionTypes';

const SUPPORT_SELECTION_CATEGORIES = new Set([
    'trunk',
    'branch',
    'leaf',
    'twig',
    'stick',
    'brace',
    'root',
]);

function isSupportCategory(category: string | null | undefined) {
    if (!category) return false;
    return SUPPORT_SELECTION_CATEGORIES.has(category);
}

export function selectPrimitiveById(id: string) {
    if (!id) return;
    setSelectedId(id);
}

export function selectJointById(id: string) {
    selectPrimitiveById(id);
}

export function clearSupportSelection() {
    clearSelectedSupportIds();
    setSelectedId(null);
}

export function selectSupportIds(ids: Iterable<string>) {
    const normalized = Array.from(new Set(Array.from(ids).filter(Boolean)));
    clearSelectedSupportIds();
    setSelectedSupportIds(normalized);
    setSelectedId(normalized.length > 0 ? normalized[0] : null);
}

export function selectSupportById(id: string, toggle: boolean) {
    if (!id) return;

    if (!toggle) {
        selectSupportIds([id]);
        return;
    }

    const existing = getSelectedSupportIds();
    const wasSelected = existing.includes(id);

    toggleSelectedSupportId(id);
    const next = getSelectedSupportIds();

    if (wasSelected) {
        setSelectedId(next.length > 0 ? next[next.length - 1] : null);
        return;
    }

    if (next.length > 1) {
        setSelectedId(null);
        return;
    }

    setSelectedId(id);
}

export function applySupportSelectionClick(input: SupportSelectionClickInput) {
    if (!input.isInteractable || !input.id) return;
    selectSupportById(input.id, input.shiftKey);
}

export function getResolvedPrimarySelection() {
    const selectedId = getSelectedId();
    const selectedCategory = getSelectedCategory() ?? null;

    if (!selectedId || !isSupportCategory(selectedCategory)) {
        return {
            selectedId,
            selectedCategory,
            selectedIds: getSelectedSupportIds(),
        };
    }

    const selectedIds = getSelectedSupportIds();
    if (selectedIds.length === 0) {
        return {
            selectedId,
            selectedCategory,
            selectedIds: [selectedId],
        };
    }

    return {
        selectedId,
        selectedCategory,
        selectedIds,
    };
}
