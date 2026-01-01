import { useSyncExternalStore } from 'react';
import type { Vec3 } from '../../types';

type Stage = 'idle' | 'awaitingEnd';

export interface BraceSnapTarget {
    kind: 'shaft' | 'leaf';
    snappedPos: Vec3;
    hostDiameterMm?: number;
    ownerModelId?: string;

    // Shaft endpoint
    segmentId?: string;
    t?: number;

    // Leaf cone endpoint
    leafId?: string;
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

let state: BracePlacementState = { ...initialState };
const listeners = new Set<() => void>();

function notify() {
    listeners.forEach((l) => l());
}

function snapTargetEq(a: BraceSnapTarget | null, b: BraceSnapTarget | null) {
    if (a === b) return true;
    if (!a || !b) return false;
    return (
        a.kind === b.kind &&
        a.hostDiameterMm === b.hostDiameterMm &&
        a.ownerModelId === b.ownerModelId &&
        a.segmentId === b.segmentId &&
        a.t === b.t &&
        a.leafId === b.leafId &&
        a.coneT === b.coneT &&
        a.snappedPos.x === b.snappedPos.x &&
        a.snappedPos.y === b.snappedPos.y &&
        a.snappedPos.z === b.snappedPos.z
    );
}

function previewEq(a: BracePreviewData | null, b: BracePreviewData | null) {
    if (a === b) return true;
    if (!a || !b) return false;
    return (
        a.startDiameterMm === b.startDiameterMm &&
        a.endDiameterMm === b.endDiameterMm &&
        a.start.x === b.start.x &&
        a.start.y === b.start.y &&
        a.start.z === b.start.z &&
        a.end.x === b.end.x &&
        a.end.y === b.end.y &&
        a.end.z === b.end.z
    );
}

export const bracePlacementStore = {
    subscribe(listener: () => void) {
        listeners.add(listener);
        return () => listeners.delete(listener);
    },

    getSnapshot(): BracePlacementState {
        return state;
    },

    setAltActive(active: boolean) {
        if (state.altActive !== active) {
            state = { ...state, altActive: active };
            notify();
        }
    },

    setStart(start: BraceSnapTarget) {
        state = {
            ...state,
            start,
            stage: 'awaitingEnd',
            preview: null,
            justFinalized: false,
        };
        notify();
    },

    setSnapTarget(snapTarget: BraceSnapTarget | null) {
        if (snapTargetEq(state.snapTarget, snapTarget)) return;
        state = { ...state, snapTarget };
        notify();
    },

    getSnapTarget() {
        return state.snapTarget;
    },

    setPreview(preview: BracePreviewData | null) {
        if (state.justFinalized && preview !== null) {
            return;
        }

        if (previewEq(state.preview, preview)) return;
        state = { ...state, preview };
        notify();
    },

    finalize() {
        state = {
            ...state,
            preview: null,
            snapTarget: null,
            start: null,
            stage: 'idle',
            justFinalized: true,
        };
        notify();
    },

    reset() {
        state = { ...initialState, altActive: state.altActive };
        notify();
    },
};

export function useBracePlacementState() {
    const snapshot = useSyncExternalStore(
        bracePlacementStore.subscribe,
        bracePlacementStore.getSnapshot,
        bracePlacementStore.getSnapshot
    );

    return {
        ...snapshot,
        /** Only "active" once the first endpoint has been placed */
        isPlacing: snapshot.stage === 'awaitingEnd',
        /** For now, brace placement is considered active only while placing (not merely holding Alt) */
        isActive: snapshot.stage === 'awaitingEnd',
    };
}
