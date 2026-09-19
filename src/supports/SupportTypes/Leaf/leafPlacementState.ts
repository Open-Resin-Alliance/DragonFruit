import { createPlacementStore, usePlacementStoreState } from '../../interaction/shared/placement/placementStore';
import { hostSnapTargetEq, hoverPositionEq, type HostSnapTarget } from '../../interaction/shared/placement/placementComparators';
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
    snapTarget: HostSnapTarget | null;
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

const store = createPlacementStore(initialState);

export const leafPlacementStore = {
    subscribe: store.subscribe,
    getSnapshot: store.getSnapshot,

    setHotkeyActive(active: boolean) {
        const state = store.read();

        if (active) {
            if (state.hotkeyActive) return;
            store.write({ ...initialState, hotkeyActive: true });
            return;
        }

        // Releasing the hotkey on an already-clean store is a no-op; otherwise
        // the whole placement state goes with it.
        if (!state.hotkeyActive
            && state.stage === 'idle'
            && state.previewData === null
            && state.snapTarget === null
            && state.hoverPosition === null) {
            return;
        }

        store.write({ ...initialState, hotkeyActive: false });
    },

    setSproutParentingLockHeld(held: boolean) {
        const state = store.read();
        if (state.sproutParentingLockHeld === held) return;

        store.write({ ...state, sproutParentingLockHeld: held });
    },

    setJunctionHub(junctionHubId: string | null, junctionHubIsNew: boolean | null) {
        const state = store.read();
        if (state.junctionHubId === junctionHubId && state.junctionHubIsNew === junctionHubIsNew) return;

        store.write({ ...state, junctionHubId, junctionHubIsNew });
    },

    setStage(stage: Stage) {
        const state = store.read();
        if (state.stage === stage) return;

        store.write({ ...state, stage });
    },

    clearJunctionHubIsNew() {
        const state = store.read();
        if (state.junctionHubIsNew === null) return;

        store.write({ ...state, junctionHubIsNew: null });
    },

    /** Partial update where a null argument means "leave this field alone". */
    updateFanningTip(tipPosition: Vec3 | null, surfaceNormal: Vec3 | null, modelId?: string) {
        const state = store.read();
        const next = { ...state };
        if (tipPosition !== null) next.tipPosition = tipPosition;
        if (surfaceNormal !== null) next.surfaceNormal = surfaceNormal;
        if (modelId !== undefined && modelId !== null) next.modelId = modelId;

        store.write(next);
    },

    setTip(tipPosition: Vec3, surfaceNormal: Vec3, modelId: string, placementSurface?: PlacementSurface) {
        store.write({
            ...store.read(),
            tipPosition,
            surfaceNormal,
            modelId,
            placementSurface,
            stage: 'awaitingBase',
            justFinalized: false, // Clear the flag when starting new placement
        });
    },

    setPreviewData(previewData: SupportData | null) {
        const state = store.read();
        // If just finalized, ignore any attempts to set preview data
        // This prevents the useFrame loop from re-setting the preview
        if (state.justFinalized && previewData !== null) return;
        if (state.previewData === previewData) return;

        store.write({ ...state, previewData });
    },

    setSnapTarget(snapTarget: HostSnapTarget | null) {
        const state = store.read();
        if (hostSnapTargetEq(state.snapTarget, snapTarget)) return;

        store.write({ ...state, snapTarget });
    },

    setHoverPosition(hoverPosition: Vec3 | null) {
        // Only update if position actually changed (avoid unnecessary re-renders)
        const state = store.read();
        if (hoverPositionEq(state.hoverPosition, hoverPosition)) return;

        store.write({ ...state, hoverPosition });
    },

    getSnapTarget() {
        return store.read().snapTarget;
    },

    finalize() {
        const state = store.read();
        store.write({ ...state, previewData: null, snapTarget: null, justFinalized: true });
    },

    reset() {
        store.resetPreserving('hotkeyActive');
    },

    isActive(): boolean {
        const state = store.read();
        return state.hotkeyActive
            || state.stage === 'awaitingBase'
            || state.stage === 'awaitingSproutTip'
            || state.sproutParentingLockHeld;
    },
};

export function useLeafPlacementState() {
    const snapshot = usePlacementStoreState(leafPlacementStore);

    return {
        ...snapshot,
        isActive: snapshot.hotkeyActive
            || snapshot.stage === 'awaitingBase'
            || snapshot.stage === 'awaitingSproutTip'
            || snapshot.sproutParentingLockHeld,
    };
}
