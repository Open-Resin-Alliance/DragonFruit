import type { PlacementSessionState } from './placementSessionTypes';

export interface PlacementCleanupTargets {
    clearPreview: () => void;
    clearHover: () => void;
    clearSnap: () => void;
    clearSelectionCandidates: () => void;
    clearTemporaryTip: () => void;
}

export function runPlacementCleanup(targets: PlacementCleanupTargets) {
    targets.clearPreview();
    targets.clearHover();
    targets.clearSnap();
    targets.clearSelectionCandidates();
    targets.clearTemporaryTip();
}

export function clearSessionVisualState(session: PlacementSessionState): PlacementSessionState {
    return {
        ...session,
        previewVisible: false,
        hoverPoint: null,
    };
}
