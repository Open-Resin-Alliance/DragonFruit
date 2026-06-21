import { useEffect, useState } from 'react';

const activeKeys = new Set<string>();
const listeners = new Set<() => void>();

function normalizeKeyName(key?: string): string {
    const normalized = (key ?? '').trim().toLowerCase();
    if (normalized === 'control') return 'ctrl';
    if (normalized === 'altgraph') return 'alt';
    return normalized;
}

function isTextInput(element: EventTarget | null): boolean {
    if (!element || !(element instanceof HTMLElement)) return false;
    const tag = element.tagName.toLowerCase();
    if (tag === 'input' || tag === 'textarea') return true;
    if (element.isContentEditable) return true;
    return false;
}

function notifyListeners() {
    listeners.forEach(fn => fn());
}

if (typeof window !== 'undefined') {
    // Capture-phase key state manager
    window.addEventListener('keydown', (e) => {
        if (isTextInput(e.target)) return;
        const normalized = normalizeKeyName(e.key);
        if (!activeKeys.has(normalized)) {
            activeKeys.add(normalized);
            notifyListeners();
        }
    }, { capture: true });

    window.addEventListener('keyup', (e) => {
        const normalized = normalizeKeyName(e.key);
        if (activeKeys.has(normalized)) {
            activeKeys.delete(normalized);
            notifyListeners();
        }
    }, { capture: true });

    window.addEventListener('blur', () => {
        if (activeKeys.size > 0) {
            activeKeys.clear();
            notifyListeners();
        }
    });
}

/**
 * Checks if a key is currently pressed, bypassing input/textarea/contenteditable targets.
 */
export function isKeyPressed(key: string): boolean {
    return activeKeys.has(normalizeKeyName(key));
}

/**
 * Returns a copy of the currently active keys.
 */
export function getActiveKeys(): Set<string> {
    return new Set(activeKeys);
}

/**
 * React hook that returns whether a key is currently pressed.
 * Re-renders the component when the target key state changes.
 */
export function useKeyPressed(key: string): boolean {
    const normalizedKey = normalizeKeyName(key);
    const [pressed, setPressed] = useState(() => activeKeys.has(normalizedKey));

    useEffect(() => {
        const handler = () => {
            setPressed(activeKeys.has(normalizedKey));
        };
        listeners.add(handler);
        setPressed(activeKeys.has(normalizedKey));
        return () => {
            listeners.delete(handler);
        };
    }, [normalizedKey]);

    return pressed;
}
