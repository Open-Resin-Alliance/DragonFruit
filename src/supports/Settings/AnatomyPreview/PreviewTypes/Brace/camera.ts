import type { CameraFocusState } from '../../AnatomyPreviewCameraTypes';

/**
 * Home focus state for the Brace anatomy preview.
 * Framed to show two vertical trunks with braces between them.
 */
export const BRACE_HOME_FOCUS_STATE: CameraFocusState = {
    position: [27.3, -33.7, 32.4],
    target: [1.33, 0.53, 7.72],
    zoom: 8.16,
};

export function getBraceTargetFocusState(_key: string | null): CameraFocusState {
    // Brace preview maintains a fixed camera; no parameter-specific zoom jumps.
    return BRACE_HOME_FOCUS_STATE;
}
