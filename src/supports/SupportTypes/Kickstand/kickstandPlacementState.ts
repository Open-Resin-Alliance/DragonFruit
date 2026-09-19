import { createPlacementStore, usePlacementStoreState } from '../../interaction/shared/placement/placementStore';
import { vecEq } from '../../interaction/shared/placement/placementComparators';
import type { SupportData } from '../../rendering/SupportBuilder';
import type { Vec3 } from '../../types';
import type { KickstandBuildResult } from './types';
import type { KickstandHostTypeId } from '../../supportTypeRegistry';

export interface KickstandPlacementTarget {
    segmentId: string;
    supportKind: KickstandHostTypeId;
    modelId: string;
    t: number;
    pos: Vec3;
    diameterMm: number;
    minT: number;
    rootPos: Vec3;
}

interface KickstandPlacementState {
    hotkeyActive: boolean;
    snapTarget: KickstandPlacementTarget | null;
    previewData: SupportData | null;
    previewBuild: KickstandBuildResult | null;
}

const initialState: KickstandPlacementState = {
    hotkeyActive: false,
    snapTarget: null,
    previewData: null,
    previewBuild: null,
};

const store = createPlacementStore(initialState);

function targetEq(a: KickstandPlacementTarget | null, b: KickstandPlacementTarget | null): boolean {
    if (a === b) return true;
    if (!a || !b) return false;

    return (
        a.segmentId === b.segmentId
        && a.supportKind === b.supportKind
        && a.modelId === b.modelId
        && a.t === b.t
        && a.diameterMm === b.diameterMm
        && a.minT === b.minT
        && vecEq(a.pos, b.pos)
        && vecEq(a.rootPos, b.rootPos)
    );
}

export const kickstandPlacementStore = {
    subscribe: store.subscribe,
    getSnapshot: store.getSnapshot,

    setHotkeyActive(active: boolean) {
        const state = store.read();
        if (state.hotkeyActive === active && (active || (!state.snapTarget && !state.previewData && !state.previewBuild))) {
            return;
        }

        if (!active) {
            store.write({ ...state, hotkeyActive: false, snapTarget: null, previewData: null, previewBuild: null });
            return;
        }

        store.write({ ...state, hotkeyActive: true });
    },

    setPreview(target: KickstandPlacementTarget, build: KickstandBuildResult, previewData: SupportData) {
        const state = store.read();
        if (targetEq(state.snapTarget, target)) return;

        store.write({ ...state, snapTarget: target, previewBuild: build, previewData });
    },

    clearPreview() {
        const state = store.read();
        if (!state.snapTarget && !state.previewBuild && !state.previewData) return;
        store.write({
            ...state,
            snapTarget: null,
            previewBuild: null,
            previewData: null,
        });
    },

    // The hotkey survives a placement, so releasing a preview must not also
    // release the mode.
    reset() {
        store.resetPreserving('hotkeyActive');
    },
};

export function useKickstandPlacementState() {
    const snapshot = usePlacementStoreState(kickstandPlacementStore);

    return {
        ...snapshot,
        isActive: snapshot.hotkeyActive,
    };
}
