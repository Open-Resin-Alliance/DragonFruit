/** True when running inside the Tauri desktop shell. False during SSR. */
export function isTauriRuntime(): boolean {
    if (typeof window === 'undefined') return false;
    return '__TAURI_INTERNALS__' in window;
}
