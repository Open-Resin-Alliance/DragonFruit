import React from 'react';

import {
    startContactDiskDragSession,
    type ContactDiskDragSession,
    type ContactDiskDragHit,
} from '../SupportPrimitives/ContactDisk/contactDiskDragController';
import { captureSupportEditSnapshot, pushSupportEditHistory } from '../history/supportEditHistory';
import { getSupportTypeDescriptor, type SupportTypeId } from '../supportTypeRegistry';

/**
 * The lifecycle around dragging a support's contact tip.
 *
 * What each type does on a hit and on commit differs -- a branch rebuilds its
 * whole geometry, a stick merges two cones, a twig cascades to attached knots.
 * Everything around that is the same: hold the live preview, capture history
 * before the first move, stop the session on unmount, push one entry after.
 */

export interface ContactDiskDragHandlers<TPreview> {
    /** Rebuild the preview from where the pointer landed; null cancels. */
    onHit: (hit: ContactDiskDragHit) => TPreview | null;
    /** Write the finished preview to the store. */
    onCommit: (preview: TPreview) => void;
    /** Runs after every drag, committed or not, for previews broadcast elsewhere. */
    onSettled?: () => void;
}

export interface ContactDiskDragSessionApi<TPreview> {
    /** The in-flight preview, or null when no drag is running. */
    preview: TPreview | null;
    /** Starts a session from a pointer-down on the tip HUD. */
    start: (options: {
        event: unknown;
        camera: unknown;
        domElement: HTMLElement;
        scene: unknown;
        modelId: string;
        placementSurface?: 'interior' | 'exterior';
    }) => void;
    /** Stops without committing, for a pointer-up that never dragged. */
    stop: () => void;
}

export function useContactDiskDragSession<TPreview>(
    typeId: SupportTypeId,
    handlers: ContactDiskDragHandlers<TPreview>,
): ContactDiskDragSessionApi<TPreview> {
    const sessionRef = React.useRef<ContactDiskDragSession | null>(null);
    const previewRef = React.useRef<TPreview | null>(null);
    const beforeRef = React.useRef<ReturnType<typeof captureSupportEditSnapshot> | null>(null);
    const [, setTick] = React.useState(0);

    const handlersRef = React.useRef(handlers);
    handlersRef.current = handlers;

    React.useEffect(() => () => {
        sessionRef.current?.stop();
        sessionRef.current = null;
        previewRef.current = null;
        beforeRef.current = null;
    }, []);

    const stop = React.useCallback(() => {
        sessionRef.current?.stop();
        sessionRef.current = null;
    }, []);

    const start = React.useCallback<ContactDiskDragSessionApi<TPreview>['start']>((options) => {
        beforeRef.current = captureSupportEditSnapshot();
        sessionRef.current?.stop();

        sessionRef.current = startContactDiskDragSession({
            camera: options.camera as never,
            domElement: options.domElement,
            scene: options.scene as never,
            initialEvent: options.event as never,
            modelId: options.modelId,
            placementSurface: options.placementSurface,
            onHit: (hit: ContactDiskDragHit) => {
                const next = handlersRef.current.onHit(hit);
                if (next === null) return;
                previewRef.current = next;
                setTick((t) => t + 1);
            },
            onEnd: () => {
                if (previewRef.current) {
                    handlersRef.current.onCommit(previewRef.current);
                    if (beforeRef.current) {
                        pushSupportEditHistory(
                            `Move ${getSupportTypeDescriptor(typeId).singular} tip`,
                            beforeRef.current,
                            captureSupportEditSnapshot(),
                        );
                    }
                }
                handlersRef.current.onSettled?.();
                previewRef.current = null;
                sessionRef.current = null;
                beforeRef.current = null;
                setTick((t) => t + 1);
            },
        });
    }, [typeId]);

    return { preview: previewRef.current, start, stop };
}
