import React from 'react';

import {
    startContactDiskDragSession,
    type ContactDiskDragSession,
    type ContactDiskDragHit,
} from '../SupportPrimitives/ContactDisk/contactDiskDragController';
import type { ContactCone } from '../SupportPrimitives/ContactCone/types';
import {
    captureSupportEditSnapshot,
    pushSupportEditHistory,
    type SupportEditHistorySnapshot,
} from '../history/supportEditHistory';
import { setSupportPlacementGuideZ } from '@/components/scene/SceneCanvas/supportPlacementGuideStore';
import { getSupportTypeDescriptor, type SupportTypeId } from '../supportTypeRegistry';
import { moveTipLabel } from '@/supports/history/supportHistoryLabels';
import {
    beginConeDrag,
    clearConeDragSession,
    clearConeDragSessionAfterFrame,
    endConeDrag,
    writeConeDragFrame,
} from '../instanced/coneDragWriter';
import { SUPPORT_INSTANCED_CONE_DRAG } from '../instanced/flags';

/**
 * The lifecycle around dragging a support's contact tip.
 *
 * What each type does on a hit and on commit differs -- a branch rebuilds its
 * whole geometry, a stick merges two cones, a twig cascades to attached knots.
 * Everything around that is the same: hold the live preview, capture history
 * before the first move, stop the session on unmount, push one entry after.
 *
 * A type whose descriptor says the drag mutates exactly one declared cone
 * (`tipDragRebuildsGeometry: false`, trunk/leaf/stump/stick) can additionally
 * draw that cone through a private instanced batch: it declares `contact` and
 * `coneFromPreview`, and the hook then writes the cone per hit instead of
 * re-rendering the support. A branch and a twig declare neither, so their
 * gesture is byte for byte the legacy one.
 */

/** The committed cone a pointer-down grabbed, and where it lives. */
export interface ContactDiskDragContact {
    /** The declared contact field the cone is stored in (`contactCone`, `contactConeA`, ...). */
    field: string;
    /** The committed cone at pointer-down. */
    cone: ContactCone;
    /** The dragged support's id, recorded on the private slot. */
    supportId?: string;
}

export interface ContactDiskDragHandlers<TPreview> {
    /** Rebuild the preview from where the pointer landed; null cancels. */
    onHit: (hit: ContactDiskDragHit) => TPreview | null;
    /** Write the finished preview to the store. */
    onCommit: (preview: TPreview) => void;
    /** Runs after every drag, committed or not, for previews broadcast elsewhere. */
    onSettled?: () => void;
    /**
     * The contact cone a preview carries. Required for the instanced fast path:
     * a type whose preview IS one cone returns it, and a type that rebuilds its
     * geometry declares no `contact` at all and never needs this.
     */
    coneFromPreview?: (preview: TPreview) => ContactCone | null;
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
        /**
         * The cone this gesture may draw as instances. Omitted by types whose
         * tip drag rebuilds geometry, which keeps them on the detail path.
         */
        contact?: ContactDiskDragContact;
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
    const beforeRef = React.useRef<SupportEditHistorySnapshot | null>(null);
    /** True while this hook owns the live cone session, so teardown clears only its own. */
    const coneDragRef = React.useRef(false);
    const [, setTick] = React.useState(0);

    const handlersRef = React.useRef(handlers);
    handlersRef.current = handlers;

    React.useEffect(() => () => {
        sessionRef.current?.stop();
        sessionRef.current = null;
        previewRef.current = null;
        beforeRef.current = null;
        // The controller's stop already ran `onEnd`; this is the hard teardown
        // for the case where it did not (no pointer ever released): a tip drag
        // must never leave instances or a hidden cone behind.
        if (coneDragRef.current) {
            coneDragRef.current = false;
            endConeDrag();
            clearConeDragSession();
        }
    }, []);

    const stop = React.useCallback(() => {
        sessionRef.current?.stop();
        sessionRef.current = null;
    }, []);

    const start = React.useCallback<ContactDiskDragSessionApi<TPreview>['start']>((options) => {
        beforeRef.current = captureSupportEditSnapshot();
        sessionRef.current?.stop();

        const contact = options.contact;
        const coneFast = SUPPORT_INSTANCED_CONE_DRAG
            && contact !== undefined
            && handlersRef.current.coneFromPreview !== undefined
            // The predicate lives in the slot builder: an undeclared type/field
            // pair or a degenerate normal returns null and the gesture stays on
            // the detail path byte for byte.
            && beginConeDrag({
                typeId,
                field: contact.field,
                cone: contact.cone,
                supportId: contact.supportId ?? '',
                modelId: options.modelId,
            }) !== null;
        coneDragRef.current = coneFast;

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
                // The guide line follows the tip: it is the height the contact
                // is being dragged to, and the line at that height is what tips
                // get levelled against. It is a module write, not a render.
                setSupportPlacementGuideZ(hit.point.z);
                if (coneFast) {
                    const cone = handlersRef.current.coneFromPreview?.(next) ?? null;
                    if (cone) writeConeDragFrame(cone);
                    return;
                }
                setTick((t) => t + 1);
            },
            onEnd: () => {
                const preview = previewRef.current;
                // Before the commit: the release paint shows the committed cone
                // through its detail renderer, with the batch emptied.
                if (coneFast) {
                    coneDragRef.current = false;
                    endConeDrag();
                }
                if (preview) {
                    handlersRef.current.onCommit(preview);
                    if (beforeRef.current) {
                        pushSupportEditHistory(
                            moveTipLabel(typeId),
                            beforeRef.current,
                            captureSupportEditSnapshot(),
                        );
                    }
                }
                handlersRef.current.onSettled?.();
                previewRef.current = null;
                sessionRef.current = null;
                beforeRef.current = null;
                setSupportPlacementGuideZ(null);
                if (coneFast) {
                    // One frame after the commit render: releasing it here would
                    // leave the batch nothing to read for that commit.
                    clearConeDragSessionAfterFrame();
                    return;
                }
                setTick((t) => t + 1);
            },
        });
    }, [typeId]);

    return { preview: previewRef.current, start, stop };
}
