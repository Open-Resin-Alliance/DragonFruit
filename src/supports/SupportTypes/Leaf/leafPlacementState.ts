import { useSyncExternalStore } from 'react';
import type { SupportData } from '../../rendering/SupportBuilder';
import type { Vec3 } from '../../types';

type Stage = 'idle' | 'awaitingBase';

interface LeafPlacementState {
    hotkeyActive: boolean;
    stage: Stage;
    tipPosition: Vec3 | null;
    surfaceNormal: Vec3 | null;
    modelId: string;
    previewData: SupportData | null;
    snapTarget: {
        targetId: string;
        snappedPos: Vec3;
        t?: number;
        hostDiameterMm?: number;
        hostSegmentId?: string;
    } | null;
    justFinalized: boolean;
    hoverPosition: Vec3 | null;
}

const initialState: LeafPlacementState = {
    hotkeyActive: false,
    stage: 'idle',
    tipPosition: null,
    surfaceNormal: null,
    modelId: 'unknown',
    previewData: null,
    snapTarget: null,
    justFinalized: false,
    hoverPosition: null,
};

let state = { ...initialState };
const listeners = new Set<() => void>();

function notify() {
    listeners.forEach(l => l());
}

function snapTargetEq(a: LeafPlacementState['snapTarget'], b: LeafPlacementState['snapTarget']) {
    if (a === b) return true;
    if (!a || !b) return false;
    return (
        a.targetId === b.targetId &&
        a.t === b.t &&
        a.hostDiameterMm === b.hostDiameterMm &&
        a.hostSegmentId === b.hostSegmentId &&
        a.snappedPos.x === b.snappedPos.x &&
        a.snappedPos.y === b.snappedPos.y &&
        a.snappedPos.z === b.snappedPos.z
    );
}

export const leafPlacementStore = {
    subscribe(listener: () => void) {
        listeners.add(listener);
        return () => listeners.delete(listener);
    },

    getSnapshot(): LeafPlacementState {
        return state;
    },

    setHotkeyActive(active: boolean) {
        if (active) {
            if (state.hotkeyActive) return;
            state = { ...initialState, hotkeyActive: true };
            notify();
            return;
        }

        if (!state.hotkeyActive && state.stage === 'idle' && state.previewData === null && state.snapTarget === null && state.hoverPosition === null) {
            return;
        }

        state = {
            ...initialState,
            hotkeyActive: false,
        };
        notify();
    },

    setTip(tipPosition: Vec3, surfaceNormal: Vec3, modelId: string) {
        state = {
            ...state,
            tipPosition,
            surfaceNormal,
            modelId,
            stage: 'awaitingBase',
            justFinalized: false,
        };
        notify();
    },

    setPreviewData(previewData: SupportData | null) {
        if (state.justFinalized && previewData !== null) {
            return;
        }

        if (state.previewData !== previewData) {
            state = { ...state, previewData };
            notify();
        }
    },

    setSnapTarget(snapTarget: LeafPlacementState['snapTarget']) {
        if (snapTargetEq(state.snapTarget, snapTarget)) return;
        state = { ...state, snapTarget };
        notify();
    },

    setHoverPosition(hoverPosition: Vec3 | null) {
        if (state.hoverPosition?.x !== hoverPosition?.x ||
            state.hoverPosition?.y !== hoverPosition?.y ||
            state.hoverPosition?.z !== hoverPosition?.z) {
            state = { ...state, hoverPosition };
            notify();
        }
    },

    getSnapTarget() {
        return state.snapTarget;
    },

    finalize() {
        state = {
            ...state,
            previewData: null,
            snapTarget: null,
            justFinalized: true,
        };
        notify();
    },

    reset() {
        const nextState = { ...initialState, hotkeyActive: state.hotkeyActive };
        if (
            state.stage === nextState.stage
            && state.tipPosition === nextState.tipPosition
            && state.surfaceNormal === nextState.surfaceNormal
            && state.modelId === nextState.modelId
            && state.previewData === nextState.previewData
            && state.hoverPosition === nextState.hoverPosition
            && state.snapTarget === nextState.snapTarget
            && state.justFinalized === nextState.justFinalized
        ) {
            return;
        }

        state = nextState;
        notify();
    },

    isActive(): boolean {
        return state.hotkeyActive || state.stage === 'awaitingBase';
    },
};

export function useLeafPlacementState() {
    const snapshot = useSyncExternalStore(
        leafPlacementStore.subscribe,
        leafPlacementStore.getSnapshot,
        leafPlacementStore.getSnapshot
    );

    return {
        ...snapshot,
        isActive: snapshot.hotkeyActive || snapshot.stage === 'awaitingBase',
    };
}
