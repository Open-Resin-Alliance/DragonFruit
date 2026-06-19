'use client';

import React, { createContext, useContext, useEffect, useState, useCallback } from 'react';
import { DEFAULT_KEYBINDINGS, HotkeyBinding, HotkeyConfig } from './hotkeyConfig';

const HOTKEY_STORAGE_KEY = 'app-hotkeys-config';

interface HotkeyContextType {
    config: HotkeyConfig;
    updateHotkey: (category: string, action: string, newBinding: HotkeyBinding) => void;
    resetToDefaults: () => void;
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
                setConfig(prev => deepMerge(prev, cleaned));
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

    const resetToDefaults = useCallback(() => {
        setConfig(DEFAULT_KEYBINDINGS);
    }, []);

    const getHotkey = useCallback((category: string, action: string): HotkeyBinding => {
        return config[category]?.[action] || (DEFAULT_KEYBINDINGS as any)[category]?.[action] || { key: '', description: '' };
    }, [config]);

    return (
        <HotkeyContext.Provider value={{ config, updateHotkey, resetToDefaults, getHotkey }}>
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

// Strip any stored category entries whose actions don't exist in the current defaults.
// This automatically cleans up old hotkeys (e.g. APPLY_DETAIL) that have been removed.
function stripStaleActions(defaults: HotkeyConfig, stored: any): any {
    const result: any = {};
    for (const category in stored) {
        if (!stored.hasOwnProperty(category)) continue;
        if (!defaults[category]) {
            // Entire category no longer exists — drop it
            continue;
        }
        const categoryDefaults = defaults[category];
        const categoryStored = stored[category];
        const cleanedCategory: any = {};
        for (const action in categoryStored) {
            if (!categoryStored.hasOwnProperty(action)) continue;
            if (!categoryDefaults[action]) {
                // Action no longer exists in defaults — drop it
                continue;
            }
            cleanedCategory[action] = categoryStored[action];
        }
        result[category] = cleanedCategory;
    }
    return result;
}

// Helper to merge stored config with defaults (to pick up new default keys and keep user overrides)
function deepMerge(defaults: any, stored: any): any {
    const result = { ...defaults };
    for (const key in stored) {
        if (stored.hasOwnProperty(key)) {
            if (typeof stored[key] === 'object' && stored[key] !== null && !Array.isArray(stored[key])) {
                result[key] = deepMerge(result[key] || {}, stored[key]);
            } else {
                result[key] = stored[key];
            }
        }
    }
    return result;
}
