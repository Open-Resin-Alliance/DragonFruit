import { useSyncExternalStore } from 'react';
import { createStore } from 'zustand';
import { detectPlatform } from '../hooks/usePlatform';
import { HotkeyConfig, DEFAULT_KEYBINDINGS } from './hotkeyConfig';

export interface HotkeyModifierFlags {
    ctrlKey?: boolean;
    metaKey?: boolean;
    shiftKey?: boolean;
    altKey?: boolean;
}

export interface HotkeyState {
    activeKeys: Set<string>;
    /**
     * Keys that were pressed as part of a modified combination and are therefore
     * owned by that combination until released. See `isActionActiveSync`.
     */
    comboKeys: Set<string>;
    config: HotkeyConfig;
    
    // Actions
    pressKey: (key: string, modifiers?: HotkeyModifierFlags) => void;
    releaseKey: (key: string) => void;
    clearKeys: () => void;
    updateBinding: (category: string, action: string, key: string, modifier?: string) => void;
}

export const hotkeyStore = createStore<HotkeyState>((set) => ({
    activeKeys: new Set<string>(),
    comboKeys: new Set<string>(),
    config: DEFAULT_KEYBINDINGS,

    pressKey: (key, modifiers) => set((state) => {
        const normalized = key.toLowerCase();
        const next = new Set(state.activeKeys);
        next.add(normalized);

        const claimed = normalizeKey(normalized);
        const nextCombo = new Set(state.comboKeys);
        if (modifiers && otherModifierHeld(normalized, modifiers)) {
            nextCombo.add(claimed);
        } else {
            nextCombo.delete(claimed);
        }

        return { activeKeys: next, comboKeys: nextCombo };
    }),

    releaseKey: (key) => set((state) => {
        const normalized = key.toLowerCase();
        const next = new Set(state.activeKeys);
        next.delete(normalized);

        const nextCombo = new Set(state.comboKeys);
        nextCombo.delete(normalizeKey(normalized));

        return { activeKeys: next, comboKeys: nextCombo };
    }),

    clearKeys: () => set({ activeKeys: new Set(), comboKeys: new Set() }),

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

export function getPrimaryModifierKey(): 'ctrl' | 'meta' {
    return detectPlatform() === 'mac' ? 'meta' : 'ctrl';
}

/**
 * Which modifier flag a key *is*, so that pressing Shift does not count as
 * "a modifier was held" for Shift itself. Bare modifier keys are bindings of
 * their own (Alt places branches, Ctrl+Alt places leaves).
 */
const SELF_MODIFIER_FLAG: Record<string, keyof HotkeyModifierFlags> = {
    ctrl: 'ctrlKey',
    control: 'ctrlKey',
    shift: 'shiftKey',
    alt: 'altKey',
    altgraph: 'altKey',
    meta: 'metaKey',
    command: 'metaKey',
    os: 'metaKey',
};

function otherModifierHeld(key: string, flags: HotkeyModifierFlags): boolean {
    const self = SELF_MODIFIER_FLAG[key];
    return (!!flags.ctrlKey && self !== 'ctrlKey')
        || (!!flags.metaKey && self !== 'metaKey')
        || (!!flags.shiftKey && self !== 'shiftKey')
        || (!!flags.altKey && self !== 'altKey');
}

export function isPrimaryModifierPressed(activeKeys: ReadonlySet<string>): boolean {
    const primaryModifier = getPrimaryModifierKey();
    for (const key of activeKeys) {
        if (normalizeKey(key) === primaryModifier) {
            return true;
        }
    }
    return false;
}

function getRequiredKeys(binding: { key: string; modifier?: string }): Set<string> {
    const keys = new Set<string>();
    const baseKey = normalizeKey(binding.key);
    if (baseKey) {
        keys.add(baseKey);
    }
    if (binding.modifier) {
        binding.modifier.split('+').forEach(m => {
            const configuredModifier = normalizeKey(m);
            const normalizedM = configuredModifier === 'ctrl'
                ? getPrimaryModifierKey()
                : configuredModifier;
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

    // A key pressed as part of a modified combination stays owned by it until it
    // is released. Without this, releasing Control before the A of Ctrl+A dropped
    // the overlap suppression above and made the bare A binding (CANVAS.TOOL_ARRANGE)
    // match, so a select-all opened Arrange.
    if (!targetBinding.modifier && state.comboKeys.has(normalizeKey(targetBinding.key))) {
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

