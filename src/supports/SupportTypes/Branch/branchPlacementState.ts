/**
 * Branch Placement State Store
 * 
 * Global state for branch placement, similar to jointCreationState.
 * This allows the placement logic to be shared between:
 * - useBranchPlacement (page-level hook for Alt key and model clicks)
 * - BranchPlacementController (canvas-level component for snapping)
 */

import { useSyncExternalStore } from 'react';
import type { SupportData } from '../../rendering/SupportBuilder';
import type { Vec3 } from '../../types';

type Stage = 'idle' | 'awaitingBase';

interface BranchPlacementState {
    altActive: boolean;
    stage: Stage;
    tipPosition: Vec3 | null;
    tipNormal: Vec3 | null;
    modelId: string;
    previewData: SupportData | null;
    snapTarget: {
        targetId: string;
        snappedPos: Vec3;
        t?: number;
        hostDiameterMm?: number;
        hostSegmentId?: string;
    } | null;
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

function snapTargetEq(a: BranchPlacementState['snapTarget'], b: BranchPlacementState['snapTarget']) {
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

export const branchPlacementStore = {
    subscribe(listener: () => void) {
        listeners.add(listener);
        return () => listeners.delete(listener);
    },

    getSnapshot(): BranchPlacementState {
        return state;
    },

    setAltActive(active: boolean) {
        if (state.altActive === active) return;

        // Releasing Alt should cancel branch placement entirely.
        // Do the full reset here so no other code path can leave a stale preview behind.
        if (!active) {
            state = { ...initialState, altActive: false };
            notify();
            return;
        }

        state = { ...initialState, altActive: true };
        notify();
    },

    setTip(tipPosition: Vec3, tipNormal: Vec3, modelId: string) {
        state = {
            ...state,
            tipPosition,
            tipNormal,
            modelId,
            stage: 'awaitingBase',
            justFinalized: false, // Clear the flag when starting new placement
        };
        notify();
    },

    setPreviewData(previewData: SupportData | null) {
        // If just finalized, ignore any attempts to set preview data
        // This prevents the useFrame loop from re-setting the preview
        if (state.justFinalized && previewData !== null) {
            console.log('[BranchPlacement] Ignoring setPreviewData - justFinalized is true');
            return;
        }

        if (state.previewData !== previewData) {
            state = { ...state, previewData };
            notify();
        }
    },

    setSnapTarget(snapTarget: BranchPlacementState['snapTarget']) {
        if (snapTargetEq(state.snapTarget, snapTarget)) return;
        state = { ...state, snapTarget };
        notify();
    },

    setHoverPosition(hoverPosition: Vec3 | null) {
        // Only update if position actually changed (avoid unnecessary re-renders)
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

    /** Call this when a branch is successfully created to prevent ghost preview */
    finalize() {
        state = {
            ...state,
            previewData: null,
            snapTarget: null,
            justFinalized: true
        };
        notify();
    },

    reset() {
        // Reset to initial state, preserving altActive
        state = { ...initialState, altActive: state.altActive };
        notify();
    },

    isActive(): boolean {
        return state.altActive || state.stage === 'awaitingBase';
    }
};

export function useBranchPlacementState() {
    const snapshot = useSyncExternalStore(
        branchPlacementStore.subscribe,
        branchPlacementStore.getSnapshot,
        branchPlacementStore.getSnapshot
    );

    return {
        ...snapshot,
        isActive: snapshot.altActive || snapshot.stage === 'awaitingBase',
    };
}
