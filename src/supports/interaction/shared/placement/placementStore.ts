import { useSyncExternalStore } from 'react';

/**
 * The subscribe/notify half of a placement store.
 *
 * Each placeable type keeps its own state shape and its own setters -- those
 * genuinely differ, and a brace's two-click flow has nothing to say about a
 * kickstand's snap target. What every one of them had written out was this:
 * a state slot, a listener set, a notify, and the two methods
 * `useSyncExternalStore` needs.
 */
export interface PlacementStore<T> {
    subscribe(listener: () => void): () => void;
    getSnapshot(): T;
    /** The current state, for a setter to read before deciding to write. */
    read(): T;
    /**
     * Replaces the state and notifies. Pass a function to derive the next
     * state from the current one.
     *
     * Unconditional: a setter wanting a no-op guard writes it, using `read()`.
     */
    write(next: T | ((current: T) => T)): void;
    /**
     * Restores the initial state, keeping the named fields' current values.
     *
     * Every adopter's reset preserves its mode flag: releasing a placement must
     * not release the mode. A store already holding those values notifies nobody,
     * on an idle store cannot churn every subscriber.
     */
    resetPreserving<K extends keyof T>(...preserved: K[]): void;
}

function shallowEqual<T extends object>(a: T, b: T): boolean {
    const keys = Object.keys(a) as (keyof T)[];
    if (keys.length !== Object.keys(b).length) return false;
    return keys.every((key) => a[key] === b[key]);
}

export function createPlacementStore<T extends object>(initialState: T): PlacementStore<T> {
    let state: T = { ...initialState };
    const listeners = new Set<() => void>();

    const notify = () => listeners.forEach((listener) => listener());

    return {
        subscribe(listener: () => void) {
            listeners.add(listener);
            return () => listeners.delete(listener);
        },

        getSnapshot: () => state,
        read: () => state,

        write(next: T | ((current: T) => T)) {
            state = typeof next === 'function' ? (next as (current: T) => T)(state) : next;
            notify();
        },

        resetPreserving<K extends keyof T>(...preserved: K[]) {
            const next = { ...initialState };
            for (const key of preserved) next[key] = state[key];
            if (shallowEqual(next, state)) return;

            state = next;
            notify();
        },
    };
}

/**
 * The React half of the primitive.
 *
 * All four placement stores wrapped `useSyncExternalStore` with the same three
 * arguments in the same order, including `getSnapshot` as its own server
 * snapshot. A store's hook spreads this result and adds whatever `isActive`
 * means for that type.
 */
export function usePlacementStoreState<T>(store: PlacementStore<T> | {
    subscribe: (listener: () => void) => () => void;
    getSnapshot: () => T;
}): T {
    return useSyncExternalStore(store.subscribe, store.getSnapshot, store.getSnapshot);
}
