/** True when running inside the Tauri desktop shell. False during SSR. */
import { hasWindow } from '@/utils/dom';
export function isTauriRuntime(): boolean {
    if (!hasWindow()) return false;
    return '__TAURI_INTERNALS__' in window;
}
