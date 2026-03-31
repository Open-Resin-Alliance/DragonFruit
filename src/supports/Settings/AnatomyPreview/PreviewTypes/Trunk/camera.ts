import { ANATOMY_CONFIG } from '../../AnatomyPreviewConfig';
import { CameraFocusState } from '../../AnatomyPreviewCameraTypes';

export const SUPPORT_HOME_FOCUS_STATE: CameraFocusState = {
    position: ANATOMY_CONFIG.camera.initialPosition as [number, number, number],
    target: ANATOMY_CONFIG.camera.initialTarget as [number, number, number],
    zoom: ANATOMY_CONFIG.camera.orthographicZoom,
};

export const TRUNK_HOME_FOCUS_STATE: CameraFocusState = {
    position: [0, -49.53, 10],
    target: [0, 0, 8],
    zoom: 27.00,
};

export const STICK_HOME_FOCUS_STATE: CameraFocusState = {
    position: [0, -49.53, 10],
    target: [0, 0, 9.2],
    zoom: 23,
};

export const TWIG_HOME_FOCUS_STATE: CameraFocusState = {
    position: [0, -49.53, 10],
    target: [0, 0, 9.2],
    zoom: 23,
};

export const BRANCH_HOME_FOCUS_STATE: CameraFocusState = {
    position: [2.2, -49.53, 10],
    target: [1.0, 0, 10.5],
    zoom: 24,
};

export const LEAF_HOME_FOCUS_STATE: CameraFocusState = {
    position: [2.05, -49.53, 10],
    target: [1.0, 0, 10.5],
    zoom: 25,
};

export const TIP_FOCUS_STATE: CameraFocusState = {
    position: [1.66, -49.25, 10],
    target: [1.66, 0.28, 14.9],
    zoom: 50.35,
};

export const TIP_CONE_FOCUS_STATE: CameraFocusState = {
    position: [0.53, -49.31, 10],
    target: [0.53, 0.28, 14.9],
    zoom: 41.01,
};

export const TRUNK_FOCUS_STATE: CameraFocusState = {
    position: [10.89, -47.91, 10],
    target: [0.08, -0.05, 7.51],
    zoom: 28.64,
};

export const ROOTS_FOCUS_STATE: CameraFocusState = {
    position: [0, -49.53, 10],
    target: [0, 0, 2],
    zoom: 32,
};

export const BRANCH_TIP_FOCUS_STATE: CameraFocusState = {
    position: [2.34, -49.25, 10],
    target: [2.34, 0.28, 14.8],
    zoom: 47,
};

export const BRANCH_TIP_CONE_FOCUS_STATE: CameraFocusState = {
    position: [2.12, -49.31, 10],
    target: [2.12, 0.28, 14.8],
    zoom: 39,
};

export const BRANCH_SHAFT_FOCUS_STATE: CameraFocusState = {
    position: [1.25, -48.95, 10],
    target: [1.05, 0, 10.7],
    zoom: 30,
};

export const LEAF_TIP_FOCUS_STATE: CameraFocusState = {
    position: [2.08, -49.2, 10],
    target: [2.08, 0.28, 14.6],
    zoom: 46,
};

export const LEAF_TIP_CONE_FOCUS_STATE: CameraFocusState = {
    position: [1.9, -49.28, 10],
    target: [1.9, 0.28, 14.6],
    zoom: 37,
};

export const SUPPORT_CAMERA_FOCUS_MAP: Record<string, CameraFocusState> = {
    'tip.contactDiameterMm': TIP_FOCUS_STATE,
    'tip.lengthMm': TIP_CONE_FOCUS_STATE,
    'tip.coneAngleMode': TIP_CONE_FOCUS_STATE,
    'tip.adaptiveConeAngleOffsetDeg': TIP_CONE_FOCUS_STATE,

    'shaft.diameterMm': TRUNK_FOCUS_STATE,

    'roots.diameterMm': ROOTS_FOCUS_STATE,
    'roots.diskHeightMm': ROOTS_FOCUS_STATE,
    'roots.coneHeightMm': ROOTS_FOCUS_STATE,
};

export const BRANCH_CAMERA_FOCUS_MAP: Record<string, CameraFocusState> = {
    'tip.contactDiameterMm': BRANCH_TIP_FOCUS_STATE,
    'tip.lengthMm': BRANCH_TIP_CONE_FOCUS_STATE,
    'tip.coneAngleMode': BRANCH_TIP_CONE_FOCUS_STATE,
    'tip.adaptiveConeAngleOffsetDeg': BRANCH_TIP_CONE_FOCUS_STATE,
    'shaft.diameterMm': BRANCH_SHAFT_FOCUS_STATE,
};

export const LEAF_CAMERA_FOCUS_MAP: Record<string, CameraFocusState> = {
    'tip.contactDiameterMm': LEAF_TIP_FOCUS_STATE,
    'tip.lengthMm': LEAF_TIP_CONE_FOCUS_STATE,
    'tip.coneAngleMode': LEAF_TIP_CONE_FOCUS_STATE,
    'tip.adaptiveConeAngleOffsetDeg': LEAF_TIP_CONE_FOCUS_STATE,
};

export function getSupportTargetFocusState(key: string | null): CameraFocusState {
    if (!key) return SUPPORT_HOME_FOCUS_STATE;
    return SUPPORT_CAMERA_FOCUS_MAP[key] || SUPPORT_HOME_FOCUS_STATE;
}

export function getBranchTargetFocusState(key: string | null): CameraFocusState {
    if (!key) return BRANCH_HOME_FOCUS_STATE;
    return BRANCH_CAMERA_FOCUS_MAP[key] || BRANCH_HOME_FOCUS_STATE;
}

export function getLeafTargetFocusState(key: string | null): CameraFocusState {
    if (!key) return LEAF_HOME_FOCUS_STATE;
    return LEAF_CAMERA_FOCUS_MAP[key] || LEAF_HOME_FOCUS_STATE;
}

export function getStickTargetFocusState(_key: string | null): CameraFocusState {
    // Stick preview has dual contact points and should avoid aggressive parameter-specific zoom jumps.
    return STICK_HOME_FOCUS_STATE;
}

export function getTwigTargetFocusState(_key: string | null): CameraFocusState {
    return TWIG_HOME_FOCUS_STATE;
}
