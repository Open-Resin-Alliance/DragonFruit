/**
 * Tells the native side that this webview is still alive.
 *
 * The counterpart of `webview_watchdog.rs`. When WebKit kills the content
 * process for exceeding its memory ceiling, the window stays open and empty
 * with nothing to tell the user what happened — these pings stopping is the
 * only signal the app process gets.
 *
 * The ping deliberately rides on a plain timer: if the main thread is blocked
 * it does not fire, which is exactly the condition worth noticing. The native
 * side waits far longer than any plausible stall before concluding anything,
 * and asks before reloading.
 *
 * A timer is also what the OS throttles when the window is hidden, so a quiet
 * webview is not necessarily a dead one. Before alarming, the native side sends
 * a probe event; it arrives as a message, not a timer, and is answered with a
 * ping straight away.
 */

/** Mirrored in `webview_watchdog.rs`. */
const PROBE_EVENT = 'webview-watchdog:probe';

/** Comfortably below the native grace period, so a missed tick is harmless. */
const PING_INTERVAL_MS = 5_000;

export function startWebviewHeartbeat(): () => void {
    if (typeof window === 'undefined') return () => { };
    if (!('__TAURI_INTERNALS__' in window)) return () => { };

    let stopped = false;
    let intervalId: number | undefined;
    let unlistenProbe: (() => void) | undefined;

    void Promise.all([import('@tauri-apps/api/core'), import('@tauri-apps/api/event')])
        .then(async ([{ invoke }, { listen }]) => {
            if (stopped) return;

            const ping = (answeringProbe: boolean) => {
                // A rejected ping is not worth reporting: it means the native
                // side is gone, in which case nothing here matters either.
                void invoke('webview_heartbeat', { answeringProbe }).catch(() => { });
            };

            ping(false);
            intervalId = window.setInterval(() => ping(false), PING_INTERVAL_MS);

            const unlisten = await listen(PROBE_EVENT, () => ping(true));
            if (stopped) unlisten();
            else unlistenProbe = unlisten;
        })
        .catch(() => { /* not a Tauri context after all */ });

    return () => {
        stopped = true;
        if (intervalId !== undefined) window.clearInterval(intervalId);
        unlistenProbe?.();
    };
}
