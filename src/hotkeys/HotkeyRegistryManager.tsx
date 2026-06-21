'use client';

import { useEffect } from 'react';
import { hotkeyStore, isActionActiveSync } from './hotkeyStore';

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

function isCanvasElement(element: EventTarget | null): boolean {
    if (!element) return false;
    const htmlEl = element as any;
    const tag = (htmlEl.tagName || '').toLowerCase();
    return tag === 'canvas';
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

    const handlePointerOrMouseDown = (e: MouseEvent | PointerEvent) => {
        const isPlacementModeActive =
            isActionActiveSync('SUPPORTS', 'LEAF_PLACEMENT') ||
            isActionActiveSync('SUPPORTS', 'BRANCH_PLACEMENT') ||
            isActionActiveSync('SUPPORTS', 'KICKSTAND_PLACEMENT') ||
            isActionActiveSync('SUPPORTS', 'SPROUTED_PARENTING_LOCK');

        if (isPlacementModeActive && isCanvasElement(e.target)) {
            e.stopPropagation();
        }
    };

    if (typeof window !== 'undefined') {
        window.addEventListener('keydown', handleKeyDown, { capture: true });
        window.addEventListener('keyup', handleKeyUp, { capture: true });
        window.addEventListener('blur', handleBlur);
        window.addEventListener('pointerdown', handlePointerOrMouseDown, { capture: true });
        window.addEventListener('mousedown', handlePointerOrMouseDown, { capture: true });
    }

    return () => {
        if (typeof window !== 'undefined') {
            window.removeEventListener('keydown', handleKeyDown, { capture: true });
            window.removeEventListener('keyup', handleKeyUp, { capture: true });
            window.removeEventListener('blur', handleBlur);
            window.removeEventListener('pointerdown', handlePointerOrMouseDown, { capture: true });
            window.removeEventListener('mousedown', handlePointerOrMouseDown, { capture: true });
        }
    };
}

export function HotkeyRegistryManager() {
    useEffect(() => {
        return setupHotkeyListeners();
    }, []);
    return null;
}
