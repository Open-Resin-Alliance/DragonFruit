import { useSyncExternalStore } from 'react';
import { getSelectedCategory, getSelectedId, subscribe } from '@/supports/state';
import {
    getEmptySelectedSupportIdsSnapshot,
    getSelectedSupportIds,
    subscribeSupportMultiSelection,
} from '@/supports/interaction/supportMultiSelection';
import {
    EMPTY_RESOLVED_SELECTION_STATE,
    type ResolvedSelectionMode,
    type ResolvedSelectionState,
} from './selectionTypes';

const listeners = new Set<() => void>();

let initialized = false;
let unsubscribeState: (() => void) | null = null;
let unsubscribeMultiSelection: (() => void) | null = null;

let marqueeActive = false;
let marqueeCandidateIds: string[] = [];

function notify() {
    listeners.forEach((listener) => listener());
}

function ensureInitialized() {
    if (initialized) return;
    initialized = true;
    unsubscribeState = subscribe(notify);
    unsubscribeMultiSelection = subscribeSupportMultiSelection(notify);
}

export function setMarqueeSelectionActive(active: boolean) {
    if (marqueeActive === active) return;
    marqueeActive = active;
    notify();
}

export function setMarqueeSelectionCandidateIds(ids: string[]) {
    const normalized = Array.from(new Set(ids.filter(Boolean)));
    if (
        marqueeCandidateIds.length === normalized.length
        && marqueeCandidateIds.every((id, index) => id === normalized[index])
    ) {
        return;
    }

    marqueeCandidateIds = normalized;
    notify();
}

function resolveSelectionMode(selectedIds: string[], selectedId: string | null, marquee: boolean): ResolvedSelectionMode {
    if (marquee) return 'marquee';
    if (selectedIds.length > 1) return 'multi';
    if (selectedId) return 'single';
    return 'none';
}

export function getResolvedSelectionSnapshot(): ResolvedSelectionState {
    ensureInitialized();

    const selectedId = getSelectedId();
    const selectedCategory = getSelectedCategory() ?? null;
    const selectedIds = Array.from(getSelectedSupportIds());

    return {
        mode: resolveSelectionMode(selectedIds, selectedId, marqueeActive),
        selectedId,
        selectedIds,
        selectedCategory,
        marqueeCandidateIds,
        blockedReason: null,
    };
}

export function subscribeResolvedSelection(listener: () => void) {
    ensureInitialized();
    listeners.add(listener);
    return () => {
        listeners.delete(listener);
        if (listeners.size > 0) return;
        unsubscribeState?.();
        unsubscribeState = null;
        unsubscribeMultiSelection?.();
        unsubscribeMultiSelection = null;
        initialized = false;
    };
}

export function useResolvedSelectionState() {
    return useSyncExternalStore(
        subscribeResolvedSelection,
        getResolvedSelectionSnapshot,
        () => ({
            ...EMPTY_RESOLVED_SELECTION_STATE,
            selectedIds: getEmptySelectedSupportIdsSnapshot() as string[],
        }),
    );
}
