"use client";

import React from 'react';
import ReactDOM from 'react-dom';
import { Settings2 } from 'lucide-react';
import { SupportAnatomyPreviewCanvas } from './SupportAnatomyPreviewCanvas';
import { setAnatomyPreviewShowTuner, subscribeToAnatomyPreviewState, getAnatomyPreviewState } from './previewState';

function PreviewContextMenu({
    position,
    onClose,
}: {
    position: { x: number; y: number } | null;
    onClose: () => void;
}) {
    const previewState = React.useSyncExternalStore(subscribeToAnatomyPreviewState, getAnatomyPreviewState, getAnatomyPreviewState);

    React.useEffect(() => {
        if (!position) return;

        const handlePointerDown = () => onClose();
        const handleKeyDown = (event: CustomEvent) => {
            if (event.detail.key === 'Escape') onClose();
        };

        window.addEventListener('pointerdown', handlePointerDown);
        window.addEventListener('app-hotkey-keydown', handleKeyDown as EventListener);
        return () => {
            window.removeEventListener('pointerdown', handlePointerDown);
            window.removeEventListener('app-hotkey-keydown', handleKeyDown as EventListener);
        };
    }, [onClose, position]);

    if (!position) return null;

    return (
        <div
            className="fixed z-[130] w-48 rounded-lg border p-1.5 shadow-xl backdrop-blur-sm"
            style={{
                left: Math.max(8, position.x),
                top: Math.max(8, position.y),
                borderColor: 'var(--border-subtle)',
                background: 'color-mix(in srgb, var(--surface-0), #000 10%)',
            }}
            role="menu"
            aria-label="Anatomy preview context menu"
            onPointerDown={(event) => event.stopPropagation()}
        >
            <button
                type="button"
                className="flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-[13px] font-medium transition-colors"
                style={{ color: 'var(--text-strong)' }}
                onClick={() => {
                    setAnatomyPreviewShowTuner(!previewState.showTuner);
                    onClose();
                }}
                role="menuitem"
            >
                <span className="inline-flex h-5 w-5 items-center justify-center rounded border" style={{ borderColor: 'var(--border-subtle)', background: 'var(--surface-1)' }}>
                    <Settings2 className="h-3.5 w-3.5" />
                </span>
                <span>{previewState.showTuner ? 'Hide Tuner' : 'Show Tuner'}</span>
            </button>
        </div>
    );
}

export function SupportAnatomyPreviewSlot() {
    const [contextMenuPos, setContextMenuPos] = React.useState<{ x: number; y: number } | null>(null);

    return (
        <div
            data-no-drag="true"
            className="w-full h-full relative rounded-lg overflow-hidden"
            style={{ background: 'var(--surface-1)' }}
            onContextMenuCapture={(event) => {
                event.preventDefault();
                setContextMenuPos({ x: event.clientX, y: event.clientY });
            }}
        >
            <SupportAnatomyPreviewCanvas />
            {typeof document !== 'undefined' && ReactDOM.createPortal(
                <PreviewContextMenu position={contextMenuPos} onClose={() => setContextMenuPos(null)} />,
                document.body,
            )}
        </div>
    );
}
