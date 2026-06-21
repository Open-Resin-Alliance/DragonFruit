import { useSyncExternalStore } from 'react';
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

function normalizeKey(key: string): string {
    const normalized = key.trim().toLowerCase();
    if (normalized === 'control') return 'ctrl';
    if (normalized === 'altgraph') return 'alt';
    if (normalized === 'command' || normalized === 'meta') return 'meta';
    return normalized;
}

function getRequiredKeys(binding: { key: string; modifier?: string }): Set<string> {
    const keys = new Set<string>();
    const baseKey = normalizeKey(binding.key);
    if (baseKey) {
        keys.add(baseKey);
    }
    if (binding.modifier) {
        binding.modifier.split('+').forEach(m => {
            const normalizedM = normalizeKey(m);
            if (normalizedM) {
                keys.add(normalizedM);
            }
        });
    }
    return keys;
}

function isBindingMatched(requiredKeys: Set<string>, normalizedActiveKeys: Set<string>): boolean {
    if (requiredKeys.size === 0) return false;
    for (const key of requiredKeys) {
        if (!normalizedActiveKeys.has(key)) {
            return false;
        }
    }
    return true;
}

export function isActionActiveSync(category: string, action: string): boolean {
    const state = hotkeyStore.getState();
    const config = state.config;
    const targetBinding = config[category]?.[action];
    if (!targetBinding) return false;

    const normalizedActiveKeys = new Set<string>();
    for (const key of state.activeKeys) {
        normalizedActiveKeys.add(normalizeKey(key));
    }

    const targetRequiredKeys = getRequiredKeys(targetBinding);
    if (!isBindingMatched(targetRequiredKeys, normalizedActiveKeys)) {
        return false;
    }

    // Overlap resolution / Specificity ranking
    // Check if there is another matching binding in the config with a more specific key requirement
    for (const cat of Object.keys(config)) {
        for (const act of Object.keys(config[cat])) {
            if (cat === category && act === action) {
                continue;
            }
            const otherBinding = config[cat][act];
            const otherRequiredKeys = getRequiredKeys(otherBinding);

            if (isBindingMatched(otherRequiredKeys, normalizedActiveKeys)) {
                // If other binding has more keys and contains all of our keys, it's a strict superset (more specific)
                let isSuperset = otherRequiredKeys.size > targetRequiredKeys.size;
                if (isSuperset) {
                    for (const tk of targetRequiredKeys) {
                        if (!otherRequiredKeys.has(tk)) {
                            isSuperset = false;
                            break;
                        }
                    }
                }
                if (isSuperset) {
                    return false; // suppressed by more specific overlapping hotkey
                }
            }
        }
    }

    return true;
}

export function useActionActive(category: string, action: string): boolean {
    return useSyncExternalStore(
        hotkeyStore.subscribe,
        () => isActionActiveSync(category, action),
        () => false
    );
}

export function useKeyPressed(key: string): boolean {
    return useSyncExternalStore(
        hotkeyStore.subscribe,
        () => isKeyPressedSync(key),
        () => false
    );
}


