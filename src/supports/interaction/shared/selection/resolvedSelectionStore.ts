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

const EMPTY_SERVER_RESOLVED_SELECTION_STATE: ResolvedSelectionState = {
    ...EMPTY_RESOLVED_SELECTION_STATE,
    selectedIds: getEmptySelectedSupportIdsSnapshot() as string[],
};

let initialized = false;
let unsubscribeState: (() => void) | null = null;
let unsubscribeMultiSelection: (() => void) | null = null;

let marqueeActive = false;
let marqueeCandidateIds: string[] = [];

let resolvedSelectionSnapshot: ResolvedSelectionState = EMPTY_RESOLVED_SELECTION_STATE;

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

function areStringArraysEqual(a: string[], b: string[]) {
    if (a === b) return true;
    if (a.length !== b.length) return false;
    for (let index = 0; index < a.length; index += 1) {
        if (a[index] !== b[index]) return false;
    }
    return true;
}

function areResolvedSelectionStatesEqual(a: ResolvedSelectionState, b: ResolvedSelectionState) {
    return (
        a.mode === b.mode
        && a.selectedId === b.selectedId
        && a.selectedCategory === b.selectedCategory
        && a.blockedReason === b.blockedReason
        && areStringArraysEqual(a.selectedIds, b.selectedIds)
        && areStringArraysEqual(a.marqueeCandidateIds, b.marqueeCandidateIds)
    );
}

export function getResolvedSelectionSnapshot(): ResolvedSelectionState {
    ensureInitialized();

    const selectedId = getSelectedId();
    const selectedCategory = getSelectedCategory() ?? null;
    const selectedIds = Array.from(getSelectedSupportIds());

    const nextSnapshot: ResolvedSelectionState = {
        mode: resolveSelectionMode(selectedIds, selectedId, marqueeActive),
        selectedId,
        selectedIds,
        selectedCategory,
        marqueeCandidateIds,
        blockedReason: null,
    };

    if (areResolvedSelectionStatesEqual(resolvedSelectionSnapshot, nextSnapshot)) {
        return resolvedSelectionSnapshot;
    }

    resolvedSelectionSnapshot = nextSnapshot;
    return resolvedSelectionSnapshot;
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
        marqueeActive = false;
        marqueeCandidateIds = [];
        resolvedSelectionSnapshot = EMPTY_RESOLVED_SELECTION_STATE;
        initialized = false;
    };
}

export function useResolvedSelectionState() {
    return useSyncExternalStore(
        subscribeResolvedSelection,
        getResolvedSelectionSnapshot,
        () => EMPTY_SERVER_RESOLVED_SELECTION_STATE,
    );
}
