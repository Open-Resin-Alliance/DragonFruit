/**
 * "What were we doing?" — the context a stall report is worthless without.
 *
 * Deliberately minimal: two passive listeners on signals the app already emits,
 * and no wiring at any call site. A stall says the UI froze; this says what the
 * user had just done, which is what turns a report into a reproduction.
 *
 * {@link noteActivity} exists so slow subsystems can name themselves without
 * this module having to know about them.
 */

const MAX_LABEL_LENGTH = 80;

interface ContextEntry {
    label: string;
    atMs: number;
}

let lastHotkey: ContextEntry | null = null;
let lastPointerTarget: ContextEntry | null = null;
let lastActivity: ContextEntry | null = null;

function truncate(value: string): string {
    const trimmed = value.trim().replace(/\s+/g, ' ');
    return trimmed.length > MAX_LABEL_LENGTH
        ? `${trimmed.slice(0, MAX_LABEL_LENGTH - 1)}…`
        : trimmed;
}

/**
 * Best-effort human label for a clicked element. Reads only attributes the app
 * already sets for testing and accessibility — never text content, which can
 * carry a user's model or file names into the log.
 */
function describeTarget(target: EventTarget | null): string {
    if (!(target instanceof Element)) return 'unknown';

    const labelled = target.closest('[data-testid], [aria-label], [title], button, canvas');
    if (!labelled) return target.tagName.toLowerCase();

    const attribute = labelled.getAttribute('data-testid')
        ?? labelled.getAttribute('aria-label')
        ?? labelled.getAttribute('title');

    return attribute
        ? `${labelled.tagName.toLowerCase()}[${truncate(attribute)}]`
        : labelled.tagName.toLowerCase();
}

/**
 * Records a named activity as the most recent thing the app was doing.
 * Call it right before something known to be expensive.
 */
export function noteActivity(label: string): void {
    lastActivity = { label: truncate(label), atMs: performance.now() };
}

/** Installs the listeners. Returns a detach function. */
export function attachHeartbeatContext(): () => void {
    if (typeof window === 'undefined') return () => { };

    const handleHotkey = (event: Event) => {
        const key = (event as CustomEvent<{ key?: string }>).detail?.key;
        if (!key) return;
        lastHotkey = { label: truncate(key), atMs: performance.now() };
    };

    const handlePointerDown = (event: PointerEvent) => {
        lastPointerTarget = { label: describeTarget(event.target), atMs: performance.now() };
    };

    window.addEventListener('app-hotkey-keydown', handleHotkey as EventListener);
    window.addEventListener('pointerdown', handlePointerDown, { capture: true, passive: true });

    return () => {
        window.removeEventListener('app-hotkey-keydown', handleHotkey as EventListener);
        window.removeEventListener('pointerdown', handlePointerDown, { capture: true });
    };
}

function formatEntry(name: string, entry: ContextEntry | null, nowMs: number): string | null {
    if (!entry) return null;
    return `${name}: ${entry.label} (${Math.round(nowMs - entry.atMs)} ms ago)`;
}

/** One-line summary of the most recent user activity, for the stall report. */
export function describeHeartbeatContext(): string {
    const nowMs = performance.now();
    const parts = [
        formatEntry('activity', lastActivity, nowMs),
        formatEntry('pointer', lastPointerTarget, nowMs),
        formatEntry('hotkey', lastHotkey, nowMs),
    ].filter((part): part is string => part !== null);

    return parts.length > 0 ? parts.join(', ') : 'no recorded activity';
}
