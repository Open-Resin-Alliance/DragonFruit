import { useSyncExternalStore } from 'react';
import type { SupportData } from '../../rendering/SupportBuilder';
import type { Vec3 } from '../../types';

type Stage = 'idle' | 'awaitingBase' | 'awaitingSproutTip';
type PlacementSurface = 'interior' | 'exterior';

interface LeafPlacementState {
    hotkeyActive: boolean;
    stage: Stage;
    tipPosition: Vec3 | null;
    surfaceNormal: Vec3 | null;
    modelId: string;
    placementSurface?: PlacementSurface;
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
    sproutParentingLockHeld: boolean;
    junctionHubId: string | null;
    junctionHubIsNew: boolean | null;
}

const initialState: LeafPlacementState = {
    hotkeyActive: false,
    stage: 'idle',
    tipPosition: null,
    surfaceNormal: null,
    modelId: 'unknown',
    placementSurface: undefined,
    previewData: null,
    snapTarget: null,
    justFinalized: false,
    hoverPosition: null,
    sproutParentingLockHeld: false,
    junctionHubId: null,
    junctionHubIsNew: null,
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

    setSproutParentingLockHeld(held: boolean) {
        if (state.sproutParentingLockHeld !== held) {
            state = { ...state, sproutParentingLockHeld: held };
            notify();
        }
    },

    setJunctionHub(junctionHubId: string | null, junctionHubIsNew: boolean | null) {
        if (state.junctionHubId !== junctionHubId || state.junctionHubIsNew !== junctionHubIsNew) {
            state = { ...state, junctionHubId, junctionHubIsNew };
            notify();
        }
    },

    setStage(stage: Stage) {
        if (state.stage !== stage) {
            state = { ...state, stage };
            notify();
        }
    },

    clearJunctionHubIsNew() {
        if (state.junctionHubIsNew !== null) {
            state = { ...state, junctionHubIsNew: null };
            notify();
        }
    },

    updateFanningTip(tipPosition: Vec3 | null, surfaceNormal: Vec3 | null, modelId?: string) {
        const nextState = { ...state };
        if (tipPosition !== null) {
            nextState.tipPosition = tipPosition;
        }
        if (surfaceNormal !== null) {
            nextState.surfaceNormal = surfaceNormal;
        }
        if (modelId !== undefined && modelId !== null) {
            nextState.modelId = modelId;
        }
        state = nextState;
        notify();
    },

    setTip(tipPosition: Vec3, surfaceNormal: Vec3, modelId: string, placementSurface?: PlacementSurface) {
        state = {
            ...state,
            tipPosition,
            surfaceNormal,
            modelId,
            placementSurface,
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
            && state.placementSurface === nextState.placementSurface
            && state.previewData === nextState.previewData
            && state.hoverPosition === nextState.hoverPosition
            && state.snapTarget === nextState.snapTarget
            && state.justFinalized === nextState.justFinalized
            && state.sproutParentingLockHeld === nextState.sproutParentingLockHeld
            && state.junctionHubId === nextState.junctionHubId
            && state.junctionHubIsNew === nextState.junctionHubIsNew
        ) {
            return;
        }

        state = nextState;
        notify();
    },

    isActive(): boolean {
        return state.hotkeyActive || state.stage === 'awaitingBase' || state.stage === 'awaitingSproutTip' || state.sproutParentingLockHeld;
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
        isActive: snapshot.hotkeyActive || snapshot.stage === 'awaitingBase' || snapshot.stage === 'awaitingSproutTip' || snapshot.sproutParentingLockHeld,
    };
}
