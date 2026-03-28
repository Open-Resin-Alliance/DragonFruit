import { useSyncExternalStore } from 'react';
import type { ResolvedModelHoverHit } from './hoverTypes';

const immediateModelHoverListeners = new Set<() => void>();
let immediateModelHoverId: string | null = null;
let immediateModelHoverStoreInitialized = false;

function notifyImmediateModelHoverListeners() {
    immediateModelHoverListeners.forEach((listener) => listener());
}

function setImmediateModelHoverId(nextModelId: string | null) {
    if (immediateModelHoverId === nextModelId) return;
    immediateModelHoverId = nextModelId;
    notifyImmediateModelHoverListeners();
}

function clearImmediateModelHover() {
    setImmediateModelHoverId(null);
}

function initializeImmediateModelHoverStore() {
    if (immediateModelHoverStoreInitialized || typeof window === 'undefined') return;
    immediateModelHoverStoreInitialized = true;

    const handleModelHover = (event: Event) => {
        const customEvent = event as CustomEvent<{ modelId?: string | null }>;
        setImmediateModelHoverId(customEvent.detail?.modelId ?? null);
    };

    window.addEventListener('model-pointer-hover-immediate', handleModelHover as EventListener);
    window.addEventListener('blur', clearImmediateModelHover);
    document.addEventListener('visibilitychange', clearImmediateModelHover);
}

export function subscribeImmediateModelHover(listener: () => void) {
    initializeImmediateModelHoverStore();
    immediateModelHoverListeners.add(listener);
    return () => {
        immediateModelHoverListeners.delete(listener);
    };
}

export function getImmediateModelHoverIdSnapshot() {
    initializeImmediateModelHoverStore();
    return immediateModelHoverId;
}

export function useImmediateModelHoverId() {
    return useSyncExternalStore(
        subscribeImmediateModelHover,
        getImmediateModelHoverIdSnapshot,
        () => null
    );
}

export function resolveModelHover(modelId: string | null): ResolvedModelHoverHit | null {
    if (!modelId) return null;
    return { modelId };
}
