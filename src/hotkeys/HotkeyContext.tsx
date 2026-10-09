'use client';

import React, { createContext, useContext, useEffect, useState, useCallback } from 'react';
import { DEFAULT_KEYBINDINGS, HotkeyBinding, HotkeyCategory, HotkeyConfig } from './hotkeyConfig';

const HOTKEY_STORAGE_KEY = 'app-hotkeys-config';

interface HotkeyContextType {
    config: HotkeyConfig;
    updateHotkey: (category: string, action: string, newBinding: HotkeyBinding) => void;
    resetCategories: (categories: string[]) => void;
    getHotkey: (category: string, action: string) => HotkeyBinding;
}

const HotkeyContext = createContext<HotkeyContextType | null>(null);

export function HotkeyProvider({ children }: { children: React.ReactNode }) {
    const [config, setConfig] = useState<HotkeyConfig>(DEFAULT_KEYBINDINGS);
    const [loaded, setLoaded] = useState(false);

    // Load from localStorage on mount
    useEffect(() => {
        try {
            const stored = localStorage.getItem(HOTKEY_STORAGE_KEY);
            if (stored) {
                const parsed = JSON.parse(stored);
                // Merge with defaults to ensure any new keys added to the app are present,
                // and strip any stored entries whose actions no longer exist in the defaults
                const cleaned = stripStaleActions(DEFAULT_KEYBINDINGS, parsed);
                setConfig(prev => mergeBindings(prev, cleaned));
            }
        } catch (e) {
            console.error('Failed to load hotkeys', e);
        }
        setLoaded(true);
    }, []);

    // Save to localStorage whenever config changes (but only after initial load)
    useEffect(() => {
        if (!loaded) return;
        try {
            localStorage.setItem(HOTKEY_STORAGE_KEY, JSON.stringify(config));
        } catch (e) {
            console.error('Failed to save hotkeys', e);
        }
    }, [config, loaded]);

    const updateHotkey = useCallback((category: string, action: string, newBinding: HotkeyBinding) => {
        setConfig(prev => ({
            ...prev,
            [category]: {
                ...prev[category],
                [action]: newBinding
            }
        }));
    }, []);

    // Restores every action of the given categories — a Settings card resets all the
    // categories it displays (e.g. the "Global" card covers GLOBAL, CAMERA, ROTATION).
    const resetCategories = useCallback((categories: string[]) => {
        setConfig(prev => {
            const next = { ...prev };
            for (const category of categories) {
                const categoryDefaults = DEFAULT_KEYBINDINGS[category];
                if (!categoryDefaults) continue;
                next[category] = Object.fromEntries(
                    Object.entries(categoryDefaults).map(([action, binding]) => [action, { ...binding }])
                );
            }
            return next;
        });
    }, []);

    const getHotkey = useCallback((category: string, action: string): HotkeyBinding => {
        return config[category]?.[action] || DEFAULT_KEYBINDINGS[category]?.[action] || { key: '', description: '' };
    }, [config]);

    return (
        <HotkeyContext.Provider value={{ config, updateHotkey, resetCategories, getHotkey }}>
            {children}
        </HotkeyContext.Provider>
    );
}

export function useHotkeyConfig() {
    const context = useContext(HotkeyContext);
    if (!context) {
        throw new Error('useHotkeyConfig must be used within a HotkeyProvider');
    }
    return context;
}

/** A stored binding, as it comes out of localStorage: it may predate today's shape. */
type StoredBinding = Partial<HotkeyBinding>;
type StoredConfig = Record<string, Record<string, StoredBinding>>;

// Strip any stored category entries whose actions don't exist in the current defaults.
// This automatically cleans up old hotkeys (e.g. APPLY_DETAIL) that have been removed.
export function stripStaleActions(defaults: HotkeyConfig, stored: unknown): StoredConfig {
    // The stored tree is what this provider itself wrote (`JSON.stringify(config)`,
    // where config is a HotkeyConfig), so it has this shape or is absent.
    const storedConfig = (stored ?? {}) as StoredConfig;
    const result: StoredConfig = {};
    for (const [category, categoryStored] of Object.entries(storedConfig)) {
        const categoryDefaults = defaults[category];
        if (!categoryDefaults) {
            // Entire category no longer exists — drop it
            continue;
        }
        const cleanedCategory: Record<string, StoredBinding> = {};
        for (const [action, bindingStored] of Object.entries(categoryStored ?? {})) {
            const bindingDefaults = categoryDefaults[action];
            if (!bindingDefaults) {
                // Action no longer exists in defaults — drop it
                continue;
            }
            // The key and modifier are the user's; the description is the app's own
            // wording for that action, and it is never editable in the UI. Taking it
            // from the defaults means renaming a tool reaches profiles that already
            // have a stored config, instead of leaving the old name in Settings →
            // Hotkeys for the life of the install.
            cleanedCategory[action] = {
                ...(typeof bindingStored?.key === 'string' ? { key: bindingStored.key } : {}),
                ...(typeof bindingStored?.modifier === 'string' ? { modifier: bindingStored.modifier } : {}),
                description: bindingDefaults.description,
            };
        }
        result[category] = cleanedCategory;
    }
    return result;
}

// Merge the stored bindings over the defaults: a binding the user rebound wins,
// an action only the defaults know about stands, and because the stored pass has
// already refreshed every description, an old tool name cannot come back here.
function mergeBindings(defaults: HotkeyConfig, stored: StoredConfig): HotkeyConfig {
    const result: HotkeyConfig = { ...defaults };
    for (const [category, storedActions] of Object.entries(stored)) {
        const actionDefaults = defaults[category] ?? {};
        const mergedActions: HotkeyCategory = {};
        for (const [action, bindingDefaults] of Object.entries(actionDefaults)) {
            mergedActions[action] = { ...bindingDefaults, ...storedActions[action] };
        }
        result[category] = mergedActions;
    }
    return result;
}
