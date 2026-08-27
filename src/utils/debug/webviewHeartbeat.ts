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
 */

/** Comfortably below the native grace period, so a missed tick is harmless. */
const PING_INTERVAL_MS = 5_000;

export function startWebviewHeartbeat(): () => void {
    if (typeof window === 'undefined') return () => { };
    if (!('__TAURI_INTERNALS__' in window)) return () => { };

    let stopped = false;
    let intervalId: number | undefined;

    void import('@tauri-apps/api/core')
        .then(({ invoke }) => {
            if (stopped) return;

            const ping = () => {
                // A rejected ping is not worth reporting: it means the native
                // side is gone, in which case nothing here matters either.
                void invoke('webview_heartbeat').catch(() => { });
            };

            ping();
            intervalId = window.setInterval(ping, PING_INTERVAL_MS);
        })
        .catch(() => { /* not a Tauri context after all */ });

    return () => {
        stopped = true;
        if (intervalId !== undefined) window.clearInterval(intervalId);
    };
}
