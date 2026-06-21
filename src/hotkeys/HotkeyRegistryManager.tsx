'use client';

import { useEffect } from 'react';
import { hotkeyStore } from './hotkeyStore';

function isTextInput(element: EventTarget | null): boolean {
    if (!element) return false;
    if (typeof HTMLElement !== 'undefined' && !(element instanceof HTMLElement)) return false;
    
    // cast to any to safely access DOM properties in various environments
    const htmlEl = element as any;
    const tag = (htmlEl.tagName || '').toLowerCase();
    if (tag === 'input' || tag === 'textarea' || tag === 'select') return true;
    if (htmlEl.isContentEditable) return true;
    if (typeof htmlEl.closest === 'function') {
        return Boolean(htmlEl.closest('[contenteditable="true"]'));
    }
    return false;
}

export function setupHotkeyListeners() {
    const handleKeyDown = (e: KeyboardEvent) => {
        if (isTextInput(e.target)) return;
        hotkeyStore.getState().pressKey(e.key);
    };

    const handleKeyUp = (e: KeyboardEvent) => {
        hotkeyStore.getState().releaseKey(e.key);
    };

    const handleBlur = () => {
        hotkeyStore.getState().clearKeys();
    };

    if (typeof window !== 'undefined') {
        window.addEventListener('keydown', handleKeyDown, { capture: true });
        window.addEventListener('keyup', handleKeyUp, { capture: true });
        window.addEventListener('blur', handleBlur);
    }

    return () => {
        if (typeof window !== 'undefined') {
            window.removeEventListener('keydown', handleKeyDown, { capture: true });
            window.removeEventListener('keyup', handleKeyUp, { capture: true });
            window.removeEventListener('blur', handleBlur);
        }
    };
}

export function HotkeyRegistryManager() {
    useEffect(() => {
        return setupHotkeyListeners();
    }, []);
    return null;
}
