import { getSelectedCategory, getSelectedId, subscribe } from '../state';

const listeners = new Set<() => void>();
const selectedSupportIds = new Set<string>();
const EMPTY_SELECTION: readonly string[] = Object.freeze([]);

const SUPPORT_SELECTION_CATEGORIES = new Set(['trunk', 'branch', 'leaf', 'twig', 'stick', 'brace', 'anchor', 'root']);

let syncedPrimarySelection = false;
let lastPrimarySelectedId: string | null = null;
let lastPrimarySelectedCategory: string | null = null;
let selectedSupportIdsSnapshot: readonly string[] = EMPTY_SELECTION;

function notify() {
    listeners.forEach((listener) => listener());
}

function setsEqual(a: Set<string>, b: Set<string>) {
    if (a.size !== b.size) return false;
    for (const value of a) {
        if (!b.has(value)) return false;
    }
    return true;
}

function isSupportCategory(category: string | null) {
    if (!category) return false;
    return SUPPORT_SELECTION_CATEGORIES.has(category);
}

function applySelectedIds(nextIds: Iterable<string>) {
    const sanitized = new Set<string>();
    for (const id of nextIds) {
        if (!id) continue;
        sanitized.add(id);
    }

    if (setsEqual(selectedSupportIds, sanitized)) return;

    selectedSupportIds.clear();
    for (const id of sanitized) {
        selectedSupportIds.add(id);
    }
    selectedSupportIdsSnapshot = selectedSupportIds.size > 0
        ? Object.freeze(Array.from(selectedSupportIds))
        : EMPTY_SELECTION;
    notify();
}

function ensureSyncedWithPrimarySelection() {
    if (syncedPrimarySelection) return;
    syncedPrimarySelection = true;

    const syncFromPrimarySelection = () => {
        const selectedId = getSelectedId();
        const selectedCategory = getSelectedCategory() ?? null;

        if (selectedId === lastPrimarySelectedId && selectedCategory === lastPrimarySelectedCategory) {
            return;
        }

        lastPrimarySelectedId = selectedId;
        lastPrimarySelectedCategory = selectedCategory;

        if (!selectedId) {
            if (selectedSupportIds.size > 1) {
                return;
            }

            if (selectedSupportIds.size > 0) {
                selectedSupportIds.clear();
                selectedSupportIdsSnapshot = EMPTY_SELECTION;
                notify();
            }
            return;
        }

        if (!isSupportCategory(selectedCategory)) {
            if (selectedSupportIds.size > 0) {
                selectedSupportIds.clear();
                selectedSupportIdsSnapshot = EMPTY_SELECTION;
                notify();
            }
            return;
        }

        if (selectedSupportIds.size <= 1 && selectedSupportIds.has(selectedId)) {
            return;
        }

        if (selectedSupportIds.size <= 1) {
            selectedSupportIds.clear();
            selectedSupportIds.add(selectedId);
            selectedSupportIdsSnapshot = Object.freeze([selectedId]);
            notify();
        }
    };

    syncFromPrimarySelection();
    subscribe(syncFromPrimarySelection);
}

export function subscribeSupportMultiSelection(listener: () => void) {
    ensureSyncedWithPrimarySelection();
    listeners.add(listener);
    return () => {
        listeners.delete(listener);
    };
}

export function getSelectedSupportIds() {
    ensureSyncedWithPrimarySelection();
    return selectedSupportIdsSnapshot;
}

export function getEmptySelectedSupportIdsSnapshot() {
    return EMPTY_SELECTION;
}

export function isSupportMultiSelected(id: string) {
    ensureSyncedWithPrimarySelection();
    return selectedSupportIds.has(id);
}

export function setSelectedSupportIds(ids: Iterable<string>) {
    ensureSyncedWithPrimarySelection();
    applySelectedIds(ids);
}

export function clearSelectedSupportIds() {
    ensureSyncedWithPrimarySelection();
    if (selectedSupportIds.size === 0) return;
    selectedSupportIds.clear();
    selectedSupportIdsSnapshot = EMPTY_SELECTION;
    notify();
}

export function toggleSelectedSupportId(id: string) {
    ensureSyncedWithPrimarySelection();
    if (!id) return;

    if (selectedSupportIds.has(id)) {
        selectedSupportIds.delete(id);
    } else {
        selectedSupportIds.add(id);
    }

    selectedSupportIdsSnapshot = selectedSupportIds.size > 0
        ? Object.freeze(Array.from(selectedSupportIds))
        : EMPTY_SELECTION;
    notify();
}
