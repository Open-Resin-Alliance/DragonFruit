import { useSyncExternalStore } from 'react';

const listeners = new Set<() => void>();

let sceneHoveredSupportId: string | null = null;

function notify() {
    listeners.forEach((listener) => listener());
}

export function setSceneHoveredSupportId(
    next: string | null | ((prev: string | null) => string | null),
) {
    const nextValue = typeof next === 'function'
        ? next(sceneHoveredSupportId)
        : next;

    if (sceneHoveredSupportId === nextValue) return;
    sceneHoveredSupportId = nextValue;
    notify();
}

export function getSceneHoveredSupportIdSnapshot() {
    return sceneHoveredSupportId;
}

export function subscribeSceneHoveredSupportId(listener: () => void) {
    listeners.add(listener);
    return () => {
        listeners.delete(listener);
    };
}

export function useSceneHoveredSupportId() {
    return useSyncExternalStore(
        subscribeSceneHoveredSupportId,
        getSceneHoveredSupportIdSnapshot,
        () => null,
    );
}
