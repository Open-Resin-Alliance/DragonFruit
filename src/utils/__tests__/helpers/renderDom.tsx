/**
 * Mounts a tree for a DOM test (`npm run test:dom`). Only usable under the
 * `scripts/test-dom/register.mjs` preload, which provides the DOM; see
 * `docs/dev/dom-tests.md`.
 *
 * The tree is wrapped the way `src/app/layout.tsx` wraps the page — the i18n
 * and hotkey providers — and in `StrictMode`, as `next dev` runs it, so
 * effects that misbehave when run twice show up here too.
 */
import { act, StrictMode, type ReactNode } from 'react';
import { createRoot } from 'react-dom/client';
import { I18nClientProvider } from '@/components/I18nClientProvider';
import { HotkeyProvider } from '@/hotkeys/HotkeyContext';

export type MountedTree = {
    container: HTMLElement;
    unmount: () => Promise<void>;
};

/** `ui` inside the providers the app mounts it in. */
export function withProviders(ui: ReactNode): ReactNode {
    return (
        <StrictMode>
            <I18nClientProvider>
                <HotkeyProvider>{ui}</HotkeyProvider>
            </I18nClientProvider>
        </StrictMode>
    );
}

export async function renderWithProviders(ui: ReactNode): Promise<MountedTree> {
    const container = document.createElement('div');
    document.body.appendChild(container);
    const root = createRoot(container);
    await act(async () => {
        root.render(withProviders(ui));
    });
    return {
        container,
        unmount: async () => {
            await act(async () => root.unmount());
            container.remove();
        },
    };
}

/** Lets timers and effects scheduled by the tree run for `ms`, inside `act`. */
export async function settle(ms: number): Promise<void> {
    await act(async () => {
        await new Promise((resolve) => setTimeout(resolve, ms));
    });
}
