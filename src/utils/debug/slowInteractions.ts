/**
 * Clicks and hotkeys that take a noticeable time to show their result.
 *
 * Measures from the input event to the first frame painted after it: the
 * handler, the React render it triggers and the layout all happen in between.
 * Safari 15 has no Event Timing API, so the paint is approximated the usual
 * way: an animation frame callback runs just before the paint, and a message
 * posted from it is delivered just after.
 *
 * The stall detector covers freezes from 500 ms up; this covers the 100–500 ms
 * band users describe as "not snappy", and names what was clicked. Labels come
 * from {@link describeTarget}, which reads only test ids and accessibility
 * attributes, never text, and hotkeys come from the app's own hotkey event, so
 * nothing typed into a field reaches the log. Camera drags on the canvas are
 * left to the camera probe.
 */

import { describeTarget } from './heartbeatContext';
import { ms, type PerfLogger } from './perfLog';

const SLOW_INTERACTION_MS = 100;

/** Calls `callback` with the time of the first paint after now. */
function afterNextPaint(callback: (paintedAt: number) => void): void {
    window.requestAnimationFrame(() => {
        const channel = new MessageChannel();
        channel.port1.onmessage = () => {
            channel.port1.close();
            callback(performance.now());
        };
        channel.port2.postMessage(null);
    });
}

export function startSlowInteractionLog(logger: PerfLogger): () => void {
    if (typeof window === 'undefined') return () => { };

    // One measurement at a time: a second click before the first one painted
    // would only measure the same frame again.
    let pending = false;

    const measure = (kind: string, label: string, startedAt: number) => {
        if (pending) return;
        pending = true;
        afterNextPaint((paintedAt) => {
            pending = false;
            const durationMs = paintedAt - startedAt;
            if (durationMs < SLOW_INTERACTION_MS || document.hidden) return;
            logger.info(`[perf:interaction] ${kind} ${label} took ${ms(durationMs)} to paint`);
        });
    };

    const onClick = (event: MouseEvent) => {
        if (event.target instanceof HTMLCanvasElement) return;
        // event.timeStamp is on the performance.now() clock in every engine we ship.
        measure('click', describeTarget(event.target), event.timeStamp);
    };
    const onHotkey = (event: Event) => {
        const key = (event as CustomEvent<{ key?: string }>).detail?.key;
        if (!key) return;
        measure('hotkey', key, performance.now());
    };

    window.addEventListener('click', onClick, { capture: true, passive: true });
    window.addEventListener('app-hotkey-keydown', onHotkey as EventListener);
    return () => {
        window.removeEventListener('click', onClick, { capture: true });
        window.removeEventListener('app-hotkey-keydown', onHotkey as EventListener);
    };
}
