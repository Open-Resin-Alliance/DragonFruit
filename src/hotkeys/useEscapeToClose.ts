'use client';

import { useEffect, useRef } from 'react';

/**
 * The default dismissal behaviour for modals: Escape closes the top-most open
 * one. Dialogs register while they are open instead of each wiring its own
 * `app-hotkey-keydown` listener, so a nested dialog closes before its parent
 * and a single press never closes two of them.
 *
 * A registration without a handler swallows Escape instead of closing — that is
 * how a deliberately non-dismissible modal keeps the key from reaching whatever
 * is behind it.
 */
type EscapeHandler = (() => void) | undefined;

type EscapeEntry = { handler: EscapeHandler };

const openDialogs: EscapeEntry[] = [];
let listening = false;

function handleHotkeyKeydown(event: Event) {
    if ((event as CustomEvent).detail?.key !== 'Escape') return;

    const top = openDialogs[openDialogs.length - 1];
    if (!top) return;

    // The top-most dialog consumes the press so nothing behind it — another
    // dialog, a canvas tool — acts on the same Escape.
    event.stopImmediatePropagation?.();
    top.handler?.();
}

function startListening() {
    if (listening || typeof window === 'undefined') return;
    window.addEventListener('app-hotkey-keydown', handleHotkeyKeydown, true);
    listening = true;
}

function stopListening() {
    if (!listening || typeof window === 'undefined') return;
    window.removeEventListener('app-hotkey-keydown', handleHotkeyKeydown, true);
    listening = false;
}

/**
 * Registers an open dialog as the current Escape target. Returns the
 * unregister function; call it when the dialog closes or unmounts.
 */
export function registerEscapeHandler(handler: EscapeHandler): () => void {
    const entry: EscapeEntry = { handler };
    openDialogs.push(entry);
    startListening();

    return () => {
        const index = openDialogs.lastIndexOf(entry);
        if (index !== -1) openDialogs.splice(index, 1);
        if (openDialogs.length === 0) stopListening();
    };
}

/**
 * React binding for {@link registerEscapeHandler}. Pass the dialog's open flag
 * and its close callback; omit the callback for a modal that must not be
 * dismissed by Escape.
 */
export function useEscapeToClose(open: boolean, onClose?: () => void) {
    const onCloseRef = useRef<EscapeHandler>(onClose);

    useEffect(() => {
        onCloseRef.current = onClose;
    });

    useEffect(() => {
        if (!open) return;
        return registerEscapeHandler(onCloseRef.current ? () => onCloseRef.current?.() : undefined);
    }, [open]);
}
