import { useSyncExternalStore } from 'react';
import { subscribe, getSelectedCategory, getHoveredCategory } from '../state';

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

function initializeImmediateModelHoverStore() {
    if (immediateModelHoverStoreInitialized || typeof window === 'undefined') return;
    immediateModelHoverStoreInitialized = true;

    const handleModelHover = (event: Event) => {
        const customEvent = event as CustomEvent<{ modelId?: string | null }>;
        setImmediateModelHoverId(customEvent.detail?.modelId ?? null);
    };

    const clearModelHover = () => {
        setImmediateModelHoverId(null);
    };

    window.addEventListener('model-pointer-hover-immediate', handleModelHover as EventListener);
    window.addEventListener('sat-hover-model-changed', handleModelHover as EventListener);
    window.addEventListener('blur', clearModelHover);
    document.addEventListener('visibilitychange', clearModelHover);
}

function subscribeImmediateModelHover(listener: () => void) {
    initializeImmediateModelHoverStore();
    immediateModelHoverListeners.add(listener);
    return () => {
        immediateModelHoverListeners.delete(listener);
    };
}

function getImmediateModelHoverId() {
    initializeImmediateModelHoverStore();
    return immediateModelHoverId;
}

export function useImmediateModelHoverId() {
    return useSyncExternalStore(
        subscribeImmediateModelHover,
        getImmediateModelHoverId,
        () => null
    );
}

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

    const rawHoveredModelId = useImmediateModelHoverId();
    
    // If a Joint is selected, the Gizmo is active -> Disable placement
    const isGizmoActive = selectedCategory === 'joint';

    const isSupportLikeHover =
        hoveredCategory === 'support'
        || hoveredCategory === 'segment'
        || hoveredCategory === 'joint'
        || hoveredCategory === 'knot'
        || hoveredCategory === 'raft';

    const allowPlacementFromModelHoverOverride = isSupportLikeHover && rawHoveredModelId !== null;
    const isHoveringElement = hoveredCategory !== 'none'
        && hoveredCategory !== 'model'
        && !allowPlacementFromModelHoverOverride;
    
    return {
        isGizmoActive,
        isHoveringElement,
        isPlacementDisabled: isGizmoActive || isHoveringElement,
        isPlacementHardDisabled: isGizmoActive
    };
}
