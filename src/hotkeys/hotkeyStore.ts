import { createStore } from 'zustand';
import { HotkeyConfig, DEFAULT_KEYBINDINGS } from './hotkeyConfig';

export interface HotkeyState {
    activeKeys: Set<string>;
    config: HotkeyConfig;
    
    // Actions
    pressKey: (key: string) => void;
    releaseKey: (key: string) => void;
    clearKeys: () => void;
    updateBinding: (category: string, action: string, key: string, modifier?: string) => void;
}

export const hotkeyStore = createStore<HotkeyState>((set) => ({
    activeKeys: new Set<string>(),
    config: DEFAULT_KEYBINDINGS,

    pressKey: (key) => set((state) => {
        const next = new Set(state.activeKeys);
        next.add(key.toLowerCase());
        return { activeKeys: next };
    }),

    releaseKey: (key) => set((state) => {
        const next = new Set(state.activeKeys);
        next.delete(key.toLowerCase());
        return { activeKeys: next };
    }),

    clearKeys: () => set({ activeKeys: new Set() }),

    updateBinding: (category, action, key, modifier) => set((state) => ({
        config: {
            ...state.config,
            [category]: {
                ...state.config[category],
                [action]: { ...state.config[category]?.[action], key, modifier }
            }
        }
    }))
}));

// Sync lookups (high frequency loops)
export function isKeyPressedSync(key: string): boolean {
    return hotkeyStore.getState().activeKeys.has(key.toLowerCase());
}
