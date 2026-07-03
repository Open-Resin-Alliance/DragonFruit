'use client';

import { useEffect } from 'react';
import { hotkeyStore, isActionActiveSync } from './hotkeyStore';
import { useHotkeyConfig } from './HotkeyContext';

// Monkey-patch EventTarget.prototype.addEventListener to block/warn keydown/keyup listeners from forbidden paths
let selfChunkName = '';
try {
    const stack = new Error().stack || '';
    const lines = stack.split('\n');
    for (const line of lines) {
        const match = line.match(/([^/\\]+\.(?:_\.)?js|HotkeyRegistryManager\.tsx)/);
        if (match && !match[0].includes('node_modules') && !match[0].includes('next-devtools')) {
            selfChunkName = match[1];
            break;
        }
    }
} catch (e) {}

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
            if (listener && (listener as any).__isHotkeySystemInternal) {
                return originalAddEventListener.apply(this, [type, listener, options]);
            }
            const stack = new Error().stack || '';
            const frames = stack.split('\n').map(f => f.trim()).filter(Boolean);
            
            // Extract the chunk filename from the addEventListener frame to prevent self-warnings
            let hijackChunk = '';
            const hijackFrame = frames.find(f => f.includes('addEventListener'));
            if (hijackFrame) {
                const match = hijackFrame.match(/([^/\\]+\._\.js|HotkeyRegistryManager\.tsx)/);
                if (match) {
                    hijackChunk = match[0];
                }
            }

            const startIdx = frames[0]?.startsWith('Error') ? 1 : 0;
            let callerFrame = '';
            for (let i = startIdx; i < frames.length; i++) {
                const frame = frames[i];
                if (
                    frame.includes('HotkeyRegistryManager.tsx') ||
                    frame.includes('hotkeyStore.ts') ||
                    frame.includes('addEventListener') ||
                    (hijackChunk && frame.includes(hijackChunk)) ||
                    (selfChunkName && frame.includes(selfChunkName))
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
                    (selfChunkName && normalized.includes(selfChunkName)) ||
                    normalized.includes('/__tests__/') ||
                    normalized.includes('.test.ts') ||
                    normalized.includes('.test.tsx') ||
                    normalized.includes('.spec.ts') ||
                    normalized.includes('.spec.tsx') ||
                    normalized.includes('node_modules') ||
                    normalized.includes('node:internal') ||
                    normalized.includes('async_hooks') ||
                    normalized.includes('chrome-extension://') ||
                    normalized.includes('moz-extension://') ||
                    normalized.includes('safari-extension://') ||
                    normalized.includes('next-devtools') ||
                    normalized.includes('webpack') ||
                    normalized.includes('hot-dev-client')
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

        const isCtrlOrMeta = e.ctrlKey || e.metaKey;
        const key = e.key.toLowerCase();
        
        // Prevent browser default behaviors
        if (
            (isCtrlOrMeta && ['s', 'a', 'c', 'v', 'z', 'y'].includes(key)) ||
            ['delete', 'backspace', 'arrowup', 'arrowdown'].includes(key) ||
            (e.shiftKey && isCtrlOrMeta && ['d', 'c', 'x', 'a', 'n', 'm', 'k'].includes(key))
        ) {
            e.preventDefault();
        }

        hotkeyStore.getState().pressKey(e.key);

        if (typeof window !== 'undefined' && typeof window.dispatchEvent === 'function') {
            window.dispatchEvent(new CustomEvent('app-hotkey-keydown', {
                detail: {
                    key: e.key,
                    code: e.code,
                    repeat: e.repeat,
                    ctrlKey: e.ctrlKey,
                    metaKey: e.metaKey,
                    shiftKey: e.shiftKey,
                    altKey: e.altKey
                }
            }));
        }
    };

    const handleKeyUp = (e: KeyboardEvent) => {
        hotkeyStore.getState().releaseKey(e.key);

        if (typeof window !== 'undefined' && typeof window.dispatchEvent === 'function') {
            window.dispatchEvent(new CustomEvent('app-hotkey-keyup', {
                detail: {
                    key: e.key,
                    code: e.code,
                    ctrlKey: e.ctrlKey,
                    metaKey: e.metaKey,
                    shiftKey: e.shiftKey,
                    altKey: e.altKey
                }
            }));
        }
    };

    const handleBlur = () => {
        hotkeyStore.getState().clearKeys();
    };

    (handleKeyDown as any).__isHotkeySystemInternal = true;
    (handleKeyUp as any).__isHotkeySystemInternal = true;
    (handleBlur as any).__isHotkeySystemInternal = true;

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
    const { config } = useHotkeyConfig();

    useEffect(() => {
        hotkeyStore.setState({ config });
    }, [config]);

    useEffect(() => {
        return setupHotkeyListeners();
    }, []);
    return null;
}
