"use client";

import React from 'react';
import { useLingui } from '@lingui/react';
import { msg } from '@lingui/core/macro';
import { Settings2 } from 'lucide-react';
import { ContextMenu } from '@/components/ui/ContextMenu';
import { SupportAnatomyPreviewCanvas } from './SupportAnatomyPreviewCanvas';
import { setAnatomyPreviewShowTuner, subscribeToAnatomyPreviewState, getAnatomyPreviewState } from './previewState';

function PreviewContextMenu({
    position,
    onClose,
}: {
    position: { x: number; y: number } | null;
    onClose: () => void;
}) {
    const { _ } = useLingui();
    const previewState = React.useSyncExternalStore(subscribeToAnatomyPreviewState, getAnatomyPreviewState, getAnatomyPreviewState);

    return (
        <ContextMenu
            position={position}
            entries={[
                {
                    id: 'toggle-tuner',
                    label: previewState.showTuner ? _(msg`Hide Tuner`) : _(msg`Show Tuner`),
                    icon: Settings2,
                },
            ]}
            onSelect={() => setAnatomyPreviewShowTuner(!previewState.showTuner)}
            onClose={onClose}
            title={_(msg({ message: 'Preview', comment: 'Heading of the right-click menu on the support anatomy preview card in the Support Studio.' }))}
            ariaLabel={_(msg`Anatomy preview context menu`)}
        />
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
                // Own the right-click: the floating panel underneath would
                // otherwise open its own "Window" menu at the same point.
                event.stopPropagation();
                setContextMenuPos({ x: event.clientX, y: event.clientY });
            }}
        >
            <SupportAnatomyPreviewCanvas />
            <PreviewContextMenu position={contextMenuPos} onClose={() => setContextMenuPos(null)} />
        </div>
    );
}
