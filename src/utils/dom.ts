/**
 * Realm probes that are safe to call anywhere, including a worker thread.
 *
 * The dev server's worker realm **defines** `window`: it is an object whose
 * property access throws `ReferenceError: window is not defined` (a trap that
 * exists to catch DOM use in a worker). That makes the two obvious guards wrong
 * in opposite directions:
 *
 *   typeof window === 'undefined'   // false there, so the guard lets you through
 *   window.document                 // throws there, which is what you must not do
 *
 * So the probe has to *read a property* and catch. Reading is what the realm
 * traps, and in a real DOM it is cheap and total.
 *
 * This is not academic: `installPerfConsoleAPI` at module scope and
 * `emitSupportInteractionReset` inside a plan both got past `typeof window` and
 * died on the next line, killing the auto-support worker (silently at first,
 * then as a fallback).
 */

/** Whether this realm has a usable DOM `window`. False in a worker, an SSR pass, or under the dev worker trap. */
export function hasWindow(): boolean {
    try {
        return typeof window !== 'undefined' && window.document !== undefined;
    } catch {
        return false;
    }
}
