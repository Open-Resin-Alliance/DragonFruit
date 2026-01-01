import { useSyncExternalStore } from 'react';

interface CurveInteractionState {
    isActive: boolean;
    isDraggingHandle: boolean;
}

let state: CurveInteractionState = {
    isActive: false,
    isDraggingHandle: false
};

const listeners = new Set<() => void>();

function emitChange() {
    for (const listener of listeners) {
        listener();
    }
}

export const curveInteractionStore = {
    getState: () => state,
    
    setIsActive: (isActive: boolean) => {
        if (state.isActive !== isActive) {
            state = { ...state, isActive };
            emitChange();
        }
    },

    setIsDraggingHandle: (isDragging: boolean) => {
        if (state.isDraggingHandle !== isDragging) {
            state = { ...state, isDraggingHandle: isDragging };
            emitChange();
        }
    },

    subscribe: (listener: () => void) => {
        listeners.add(listener);
        return () => listeners.delete(listener);
    },
    
    getSnapshot: () => state
};

const serverSnapshot: CurveInteractionState = {
    isActive: false,
    isDraggingHandle: false
};

export function useCurveInteractionState() {
    return useSyncExternalStore(
        curveInteractionStore.subscribe,
        curveInteractionStore.getSnapshot,
        () => serverSnapshot
    );
}
