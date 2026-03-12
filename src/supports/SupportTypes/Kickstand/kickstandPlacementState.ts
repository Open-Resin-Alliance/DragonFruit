import { useSyncExternalStore } from 'react';
import type { SupportData } from '../../rendering/SupportBuilder';
import type { Vec3 } from '../../types';
import type { KickstandBuildResult, KickstandHostKind } from './types';

export interface KickstandPlacementTarget {
    segmentId: string;
    supportKind: KickstandHostKind;
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

let state: KickstandPlacementState = { ...initialState };
const listeners = new Set<() => void>();

function notify() {
    listeners.forEach((listener) => listener());
}

function vecEq(a: Vec3, b: Vec3): boolean {
    return a.x === b.x && a.y === b.y && a.z === b.z;
}

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
    subscribe(listener: () => void) {
        listeners.add(listener);
        return () => listeners.delete(listener);
    },

    getSnapshot(): KickstandPlacementState {
        return state;
    },

    setHotkeyActive(active: boolean) {
        if (state.hotkeyActive === active && (active || (!state.snapTarget && !state.previewData && !state.previewBuild))) {
            return;
        }

        if (!active) {
            state = {
                ...state,
                hotkeyActive: false,
                snapTarget: null,
                previewData: null,
                previewBuild: null,
            };
            notify();
            return;
        }

        state = {
            ...state,
            hotkeyActive: true,
        };
        notify();
    },

    setPreview(target: KickstandPlacementTarget, build: KickstandBuildResult, previewData: SupportData) {
        if (targetEq(state.snapTarget, target)) return;

        state = {
            ...state,
            snapTarget: target,
            previewBuild: build,
            previewData,
        };
        notify();
    },

    clearPreview() {
        if (!state.snapTarget && !state.previewBuild && !state.previewData) return;
        state = {
            ...state,
            snapTarget: null,
            previewBuild: null,
            previewData: null,
        };
        notify();
    },

    reset() {
        state = {
            ...initialState,
            hotkeyActive: state.hotkeyActive,
        };
        notify();
    },
};

export function useKickstandPlacementState() {
    const snapshot = useSyncExternalStore(
        kickstandPlacementStore.subscribe,
        kickstandPlacementStore.getSnapshot,
        kickstandPlacementStore.getSnapshot,
    );

    return {
        ...snapshot,
        isActive: snapshot.hotkeyActive,
    };
}
