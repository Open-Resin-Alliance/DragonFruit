import type { ResolvedSnapState } from './snappingTypes';
import { EMPTY_RESOLVED_SNAP_STATE } from './snappingTypes';

let state: ResolvedSnapState = EMPTY_RESOLVED_SNAP_STATE;
const listeners = new Set<() => void>();

function notify() {
    listeners.forEach((listener) => listener());
}

function isEqual(a: ResolvedSnapState, b: ResolvedSnapState) {
    return (
        a.state === b.state
        && a.targetId === b.targetId
        && a.t === b.t
        && a.snappedPos?.x === b.snappedPos?.x
        && a.snappedPos?.y === b.snappedPos?.y
        && a.snappedPos?.z === b.snappedPos?.z
        && a.metadata === b.metadata
    );
}

export const snappingSessionStore = {
    subscribe(listener: () => void) {
        listeners.add(listener);
        return () => listeners.delete(listener);
    },

    getSnapshot() {
        return state;
    },

    setState(next: ResolvedSnapState) {
        if (isEqual(state, next)) return;
        state = next;
        notify();
    },

    reset() {
        if (state === EMPTY_RESOLVED_SNAP_STATE) return;
        state = EMPTY_RESOLVED_SNAP_STATE;
        notify();
    },
};
