import type { SupportData } from '../../rendering/SupportBuilder';
import { createPlacementStore, usePlacementStoreState } from '../../interaction/shared/placement/placementStore';
import { hostSnapTargetEq, hoverPositionEq, type HostSnapTarget } from '../../interaction/shared/placement/placementComparators';
import type { Vec3 } from '../../types';

type Stage = 'idle' | 'awaitingBase';
type PlacementSurface = 'interior' | 'exterior';

interface BranchPlacementState {
    altActive: boolean;
    stage: Stage;
    tipPosition: Vec3 | null;
    tipNormal: Vec3 | null;
    modelId: string;
    placementSurface?: PlacementSurface;
    previewData: SupportData | null;
    snapTarget: HostSnapTarget | null;
    /** Flag to prevent preview from being set immediately after branch creation */
    justFinalized: boolean;
    /** Hover position on model while Alt is held (for preview dot before first click) */
    hoverPosition: Vec3 | null;
}

const initialState: BranchPlacementState = {
    altActive: false,
    stage: 'idle',
    tipPosition: null,
    tipNormal: null,
    modelId: 'unknown',
    placementSurface: undefined,
    previewData: null,
    snapTarget: null,
    justFinalized: false,
    hoverPosition: null,
};

const store = createPlacementStore(initialState);

export const branchPlacementStore = {
    subscribe: store.subscribe,
    getSnapshot: store.getSnapshot,

    setAltActive(active: boolean) {
        const state = store.read();
        if (state.altActive === active) return;

        // Either way this is a full reset: releasing Alt cancels branch
        // placement entirely, and pressing it starts a fresh one. Doing it here
        // means no other code path can leave a stale preview behind.
        store.write({ ...initialState, altActive: active });
    },

    setTip(tipPosition: Vec3, tipNormal: Vec3, modelId: string, placementSurface?: PlacementSurface) {
        store.write({
            ...store.read(),
            tipPosition,
            tipNormal,
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

    /** Call this when a branch is successfully created to prevent ghost preview */
    finalize() {
        store.write({ ...initialState, altActive: store.read().altActive, justFinalized: true });
    },

    reset() {
        store.resetPreserving('altActive');
    },

    isActive(): boolean {
        const state = store.read();
        return state.altActive || state.stage === 'awaitingBase';
    },
};

export function useBranchPlacementState() {
    const snapshot = usePlacementStoreState(branchPlacementStore);

    return {
        ...snapshot,
        isActive: snapshot.altActive || snapshot.stage === 'awaitingBase',
    };
}
