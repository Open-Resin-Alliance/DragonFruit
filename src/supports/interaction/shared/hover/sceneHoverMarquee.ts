import { useSyncExternalStore } from 'react';
import { emitSupportModelPointerHover } from '../../clickHandlers';

const EMPTY_SUPPORT_ID_LIST: readonly string[] = Object.freeze([]);

export interface SupportMarqueeHoverState {
    supportId: string | null;
    supportIds: readonly string[];
    modelId: string | null;
}

export const EMPTY_SUPPORT_MARQUEE_HOVER_STATE: SupportMarqueeHoverState = {
    supportId: null,
    supportIds: EMPTY_SUPPORT_ID_LIST,
    modelId: null,
};

const listeners = new Set<() => void>();

let initialized = false;
let supportMarqueeHoverBlocked = false;
let supportMarqueeHoverSnapshot: SupportMarqueeHoverState = EMPTY_SUPPORT_MARQUEE_HOVER_STATE;

const handleSupportMarqueeHoverEvent = (event: Event) => {
    const customEvent = event as CustomEvent<{ supportId?: string | null; supportIds?: string[]; modelId?: string | null }>;

    if (supportMarqueeHoverBlocked) {
        clearSupportMarqueeHover();
        return;
    }

    publishSupportMarqueeHover(
        Array.isArray(customEvent.detail?.supportIds) && customEvent.detail.supportIds.length > 0
            ? customEvent.detail.supportIds
            : [customEvent.detail?.supportId ?? null],
        customEvent.detail?.modelId ?? null,
    );
};

function supportIdListsEqual(a: readonly string[], b: readonly string[]) {
    if (a === b) return true;
    if (a.length !== b.length) return false;
    for (let i = 0; i < a.length; i += 1) {
        if (a[i] !== b[i]) return false;
    }
    return true;
}

export function normalizeMarqueeHoveredSupportIds(ids: readonly (string | null | undefined)[]) {
    const normalized: string[] = [];
    const seen = new Set<string>();
    for (const id of ids) {
        if (!id || seen.has(id)) continue;
        seen.add(id);
        normalized.push(id);
    }
    return normalized.length > 0 ? normalized : EMPTY_SUPPORT_ID_LIST;
}

function notify() {
    listeners.forEach((listener) => listener());
}

function ensureInitialized() {
    if (initialized || typeof window === 'undefined') return;
    initialized = true;
    window.addEventListener('support-marquee-hover', handleSupportMarqueeHoverEvent as EventListener);
}

function teardownInitializedResources() {
    if (typeof window !== 'undefined') {
        window.removeEventListener('support-marquee-hover', handleSupportMarqueeHoverEvent as EventListener);
    }
    initialized = false;
    supportMarqueeHoverBlocked = false;
    supportMarqueeHoverSnapshot = EMPTY_SUPPORT_MARQUEE_HOVER_STATE;
}

function areSupportMarqueeHoverStatesEqual(a: SupportMarqueeHoverState, b: SupportMarqueeHoverState) {
    return a.supportId === b.supportId
        && a.modelId === b.modelId
        && supportIdListsEqual(a.supportIds, b.supportIds);
}

function setSupportMarqueeHoverSnapshot(next: SupportMarqueeHoverState) {
    if (areSupportMarqueeHoverStatesEqual(supportMarqueeHoverSnapshot, next)) return;
    supportMarqueeHoverSnapshot = next;
    notify();
}

export function publishSupportMarqueeHover(
    ids: readonly (string | null | undefined)[],
    modelId: string | null,
) {
    ensureInitialized();
    const supportIds = normalizeMarqueeHoveredSupportIds(ids);
    setSupportMarqueeHoverSnapshot({
        supportId: supportIds[0] ?? null,
        supportIds,
        modelId,
    });
    emitSupportModelPointerHover(modelId);
}

export function clearSupportMarqueeHover() {
    ensureInitialized();
    setSupportMarqueeHoverSnapshot(EMPTY_SUPPORT_MARQUEE_HOVER_STATE);
    emitSupportModelPointerHover(null);
}

export function setSupportMarqueeHoverBlocked(blocked: boolean) {
    ensureInitialized();
    if (supportMarqueeHoverBlocked === blocked) return;
    supportMarqueeHoverBlocked = blocked;
    if (blocked) clearSupportMarqueeHover();
}

export function getSupportMarqueeHoverSnapshot() {
    ensureInitialized();
    return supportMarqueeHoverSnapshot;
}

export function subscribeSupportMarqueeHover(listener: () => void) {
    ensureInitialized();
    listeners.add(listener);
    return () => {
        listeners.delete(listener);
        if (listeners.size > 0) return;
        teardownInitializedResources();
    };
}

export function useSupportMarqueeHoverState() {
    return useSyncExternalStore(
        subscribeSupportMarqueeHover,
        getSupportMarqueeHoverSnapshot,
        () => EMPTY_SUPPORT_MARQUEE_HOVER_STATE,
    );
}
