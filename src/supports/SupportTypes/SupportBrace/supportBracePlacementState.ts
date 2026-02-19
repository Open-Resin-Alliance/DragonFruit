import { useSyncExternalStore } from 'react';
import type { SupportData } from '../../rendering/SupportBuilder';
import type { Vec3 } from '../../types';
import type { SupportBraceBuildResult, SupportBraceHostKind } from './types';

export interface SupportBracePlacementTarget {
    segmentId: string;
    supportKind: SupportBraceHostKind;
    modelId: string;
    t: number;
    pos: Vec3;
    diameterMm: number;
    minT: number;
    rootPos: Vec3;
}

interface SupportBracePlacementState {
    hotkeyActive: boolean;
    snapTarget: SupportBracePlacementTarget | null;
    previewData: SupportData | null;
    previewBuild: SupportBraceBuildResult | null;
}

const initialState: SupportBracePlacementState = {
    hotkeyActive: false,
    snapTarget: null,
    previewData: null,
    previewBuild: null,
};

let state: SupportBracePlacementState = { ...initialState };
const listeners = new Set<() => void>();

function notify() {
    listeners.forEach((listener) => listener());
}

function vecEq(a: Vec3, b: Vec3): boolean {
    return a.x === b.x && a.y === b.y && a.z === b.z;
}

function targetEq(a: SupportBracePlacementTarget | null, b: SupportBracePlacementTarget | null): boolean {
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

export const supportBracePlacementStore = {
    subscribe(listener: () => void) {
        listeners.add(listener);
        return () => listeners.delete(listener);
    },

    getSnapshot(): SupportBracePlacementState {
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

    setPreview(target: SupportBracePlacementTarget, build: SupportBraceBuildResult, previewData: SupportData) {
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

export function useSupportBracePlacementState() {
    const snapshot = useSyncExternalStore(
        supportBracePlacementStore.subscribe,
        supportBracePlacementStore.getSnapshot,
        supportBracePlacementStore.getSnapshot,
    );

    return {
        ...snapshot,
        isActive: snapshot.hotkeyActive,
    };
}
