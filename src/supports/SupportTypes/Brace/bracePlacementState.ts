import { createPlacementStore, usePlacementStoreState } from '../../interaction/shared/placement/placementStore';
import { vecEq } from '../../interaction/shared/placement/placementComparators';
import type { Vec3 } from '../../types';
import type { SupportTypeId } from '../../supportTypeRegistry';

type Stage = 'idle' | 'awaitingEnd';

export interface BraceSnapTarget {
    kind: 'shaft' | SupportTypeId;
    snappedPos: Vec3;
    hostDiameterMm?: number;
    ownerModelId?: string;

    // Shaft endpoint
    segmentId?: string;
    t?: number;

    // Cone-primitive endpoint (the type whose `hostsBraceSnapCone` is true)
    entityId?: string;
    coneT?: number;
}

export interface BracePreviewData {
    start: Vec3;
    end: Vec3;
    startDiameterMm: number;
    endDiameterMm: number;
}

interface BracePlacementState {
    altActive: boolean;
    stage: Stage;
    start: BraceSnapTarget | null;
    snapTarget: BraceSnapTarget | null;
    preview: BracePreviewData | null;
    /** Flag to prevent preview from being set immediately after brace creation */
    justFinalized: boolean;
}

const initialState: BracePlacementState = {
    altActive: false,
    stage: 'idle',
    start: null,
    snapTarget: null,
    preview: null,
    justFinalized: false,
};

const store = createPlacementStore(initialState);

function snapTargetEq(a: BraceSnapTarget | null, b: BraceSnapTarget | null): boolean {
    if (a === b) return true;
    if (!a || !b) return false;

    return (
        a.kind === b.kind
        && a.hostDiameterMm === b.hostDiameterMm
        && a.ownerModelId === b.ownerModelId
        && a.segmentId === b.segmentId
        && a.t === b.t
        && a.entityId === b.entityId
        && a.coneT === b.coneT
        && vecEq(a.snappedPos, b.snappedPos)
    );
}

/**
 * A brace is the one type that compares its preview structurally rather than by
 * reference: the two endpoints are re-derived every frame while dragging, so a
 * fresh-but-identical pair would re-render the preview shaft each time.
 */
function previewEq(a: BracePreviewData | null, b: BracePreviewData | null): boolean {
    if (a === b) return true;
    if (!a || !b) return false;

    return (
        a.startDiameterMm === b.startDiameterMm
        && a.endDiameterMm === b.endDiameterMm
        && vecEq(a.start, b.start)
        && vecEq(a.end, b.end)
    );
}

export const bracePlacementStore = {
    subscribe: store.subscribe,
    getSnapshot: store.getSnapshot,

    setAltActive(active: boolean) {
        const state = store.read();
        if (state.altActive === active) return;

        // Only the flag: a brace's first endpoint survives the Alt key, unlike
        // branch and leaf, whose press/release clears the whole flow.
        store.write({ ...state, altActive: active });
    },

    setStart(start: BraceSnapTarget) {
        store.write({
            ...store.read(),
            start,
            stage: 'awaitingEnd',
            preview: null,
            justFinalized: false,
        });
    },

    setSnapTarget(snapTarget: BraceSnapTarget | null) {
        const state = store.read();
        if (snapTargetEq(state.snapTarget, snapTarget)) return;

        store.write({ ...state, snapTarget });
    },

    getSnapTarget() {
        return store.read().snapTarget;
    },

    setPreview(preview: BracePreviewData | null) {
        const state = store.read();
        if (state.justFinalized && preview !== null) return;
        if (previewEq(state.preview, preview)) return;

        store.write({ ...state, preview });
    },

    finalize() {
        const state = store.read();
        store.write({ ...state, preview: null, snapTarget: null, start: null, stage: 'idle', justFinalized: true });
    },

    reset() {
        store.resetPreserving('altActive');
    },
};

export function useBracePlacementState() {
    const snapshot = usePlacementStoreState(bracePlacementStore);

    return {
        ...snapshot,
        /** Only "active" once the first endpoint has been placed */
        isPlacing: snapshot.stage === 'awaitingEnd',
        /** For now, brace placement is considered active only while placing (not merely holding Alt) */
        isActive: snapshot.stage === 'awaitingEnd',
    };
}
