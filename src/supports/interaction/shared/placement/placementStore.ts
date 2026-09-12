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
     */
    write(next: T | ((current: T) => T)): void;
    /** Restores the initial state, notifying only if something changed. */
    reset(): void;
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

        reset() {
            // A store already at its initial values notifies nobody, so a
            // reset on an idle store cannot churn every subscriber.
            const unchanged = (Object.keys(initialState) as (keyof T)[])
                .every((key) => state[key] === initialState[key]);
            if (unchanged) return;

            state = { ...initialState };
            notify();
        },
    };
}
