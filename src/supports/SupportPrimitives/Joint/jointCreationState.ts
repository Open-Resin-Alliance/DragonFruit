import { useSyncExternalStore } from 'react';

interface JointCreationState {
    isActive: boolean;
}

let state: JointCreationState = {
    isActive: false
};

const listeners = new Set<() => void>();

function emitChange() {
    for (const listener of listeners) {
        listener();
    }
}

export const jointCreationStore = {
    getState: () => state,
    
    setIsActive: (isActive: boolean) => {
        if (state.isActive !== isActive) {
            state = { ...state, isActive };
            emitChange();
        }
    },

    subscribe: (listener: () => void) => {
        listeners.add(listener);
        return () => listeners.delete(listener);
    },
    
    getSnapshot: () => state
};

const serverSnapshot: JointCreationState = {
    isActive: false
};

export function useJointCreationState() {
    return useSyncExternalStore(
        jointCreationStore.subscribe,
        jointCreationStore.getSnapshot,
        () => serverSnapshot
    );
}
