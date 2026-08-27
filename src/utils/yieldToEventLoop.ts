/**
 * Hands the thread back to the event loop, without the background penalty.
 *
 * The obvious `setTimeout(resolve, 0)` is a timer, and WebKit throttles timers
 * to roughly 1 Hz in a hidden or occluded window. A pass that yields eighty
 * times then takes eighty seconds instead of a fraction of one, purely because
 * the user switched to another app — which is exactly when they are most likely
 * to leave a long scan running.
 *
 * A MessageChannel message is not a timer and is not throttled, while still
 * being a macrotask: rendering and input get their turn between chunks, which
 * is the entire point of yielding.
 */

let channel: MessageChannel | null = null;
let pending: Array<() => void> = [];

export function yieldToEventLoop(): Promise<void> {
    if (typeof MessageChannel === 'undefined') {
        // Non-browser contexts (tests, SSR): the timer is fine, nothing is hidden.
        return new Promise((resolve) => { setTimeout(resolve, 0); });
    }

    if (!channel) {
        channel = new MessageChannel();
        channel.port1.onmessage = () => {
            // Drain by swapping, so a resolver that yields again queues into a
            // fresh batch rather than extending the one being drained.
            const batch = pending;
            pending = [];
            for (const resolve of batch) resolve();
        };
        channel.port1.start();
    }

    return new Promise<void>((resolve) => {
        pending.push(resolve);
        channel!.port2.postMessage(null);
    });
}

/**
 * Rate limiter for progress callbacks.
 *
 * Yielding is cheap; telling React about it is not. A progress report is a
 * state update, and a state update re-renders a tree with a 3D scene in it, so
 * reporting on every yield turned a 38-second scan into well over a minute.
 * Chunks still yield as often as they like — the UI just hears about it at a
 * human rate.
 */
export function createProgressThrottle(minIntervalMs = 250) {
    let lastReportMs = 0;
    return function report(emit: () => void, force = false): void {
        const now = performance.now();
        if (!force && now - lastReportMs < minIntervalMs) return;
        lastReportMs = now;
        emit();
    };
}
