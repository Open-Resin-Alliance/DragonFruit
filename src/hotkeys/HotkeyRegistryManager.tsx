'use client';

import { useEffect } from 'react';
import { hotkeyStore, isActionActiveSync } from './hotkeyStore';

// Monkey-patch EventTarget.prototype.addEventListener to block/warn keydown/keyup listeners from forbidden paths
if (typeof EventTarget !== 'undefined') {
    const originalAddEventListener = EventTarget.prototype.addEventListener;
    EventTarget.prototype.addEventListener = function (
        this: EventTarget,
        type: string,
        listener: any,
        options?: any
    ) {
        const isWindowOrDocument =
            (typeof window !== 'undefined' && this === window) ||
            (typeof document !== 'undefined' && this === document);

        if ((type === 'keydown' || type === 'keyup') && isWindowOrDocument) {
            const stack = new Error().stack || '';
            const frames = stack.split('\n').map(f => f.trim()).filter(Boolean);
            const startIdx = frames[0]?.startsWith('Error') ? 1 : 0;
            let callerFrame = '';
            for (let i = startIdx; i < frames.length; i++) {
                const frame = frames[i];
                if (
                    frame.includes('HotkeyRegistryManager.tsx') ||
                    frame.includes('hotkeyStore.ts') ||
                    frame.includes('addEventListener')
                ) {
                    continue;
                }
                callerFrame = frame;
                break;
            }
            const isAllowedFrame = (frame: string) => {
                const normalized = frame.replace(/\\/g, '/');
                return (
                    normalized.includes('hotkeyStore.ts') ||
                    normalized.includes('HotkeyRegistryManager.tsx') ||
                    normalized.includes('/__tests__/') ||
                    normalized.includes('.test.ts') ||
                    normalized.includes('.test.tsx') ||
                    normalized.includes('.spec.ts') ||
                    normalized.includes('.spec.tsx') ||
                    normalized.includes('/node_modules/') ||
                    normalized.includes('node:internal') ||
                    normalized.includes('async_hooks') ||
                    normalized.includes('chrome-extension://') ||
                    normalized.includes('moz-extension://') ||
                    normalized.includes('safari-extension://')
                );
            };

            if (callerFrame && !isAllowedFrame(callerFrame)) {
                console.error(
                    `Forbidden keydown/keyup event listener registered on ${
                        (typeof window !== 'undefined' && this === window) ? 'window' : 'document'
                    } from "${callerFrame}". Please use HotkeyRegistryManager or hotkeyStore. See /DragonFruit/docs/hotkeys/README.md`
                );
            }
        }
        return originalAddEventListener.apply(this, [type, listener, options]);
    };
}


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
