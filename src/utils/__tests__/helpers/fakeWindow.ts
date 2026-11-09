/**
 * A fake browser realm for tests that install `window`.
 *
 * `hasWindow()` (`src/utils/dom.ts`) probes `window.document` deliberately: the
 * dev server's worker realm defines `window` but traps property reads, so a realm
 * without a `document` is one the app must not touch. A test that installs a fake
 * window therefore has to supply one, or every `hasWindow()` caller — the Tauri
 * bridges and the experiments store among them — behaves as if it were headless
 * and reports its feature as desktop-only or unavailable.
 *
 * `overrides` merge onto the window, so a test can add its Tauri boundary
 * (`__TAURI_INTERNALS__`), `localStorage`, or event stubs. The returned function
 * restores the previous property, so call it in a `finally`.
 */
export function installFakeWindow(overrides: Record<string, unknown> = {}): () => void {
    const previous = Object.getOwnPropertyDescriptor(globalThis, 'window');
    Object.defineProperty(globalThis, 'window', {
        configurable: true,
        writable: true,
        value: { document: {}, ...overrides },
    });
    return () => {
        if (previous) Object.defineProperty(globalThis, 'window', previous);
        else Reflect.deleteProperty(globalThis, 'window');
    };
}
