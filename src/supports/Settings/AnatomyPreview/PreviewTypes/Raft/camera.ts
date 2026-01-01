import { CameraFocusState } from '../../AnatomyPreviewCameraTypes';

export const RAFT_HOME_FOCUS_STATE: CameraFocusState = {
    position: [31.28, -32.23, 9.95],
    target: [0.07, -0.09, 1.48],
    zoom: 15.5,
};

export const RAFT_THICKNESS_FOCUS_STATE: CameraFocusState = {
    position: [4.63, -45.61, 0],
    target: [5.39, -0.03, 0.65],
    zoom: 79.89,
};

export const RAFT_CHAMFER_FOCUS_STATE: CameraFocusState = {
    position: [37.22, -27.22, 0],
    target: [4.94, 4.96, 0.61],
    zoom: 80.04,
};

export const RAFT_LINE_WIDTH_FOCUS_STATE: CameraFocusState = {
    position: [4.63, -45.61, 0],
    target: [5.39, -0.03, 0.65],
    zoom: 79.89,
};

export const RAFT_LINE_HEIGHT_FOCUS_STATE: CameraFocusState = {
    position: [4.63, -45.61, 0],
    target: [5.39, -0.03, 0.65],
    zoom: 79.89,
};

export const RAFT_LINE_CHAMFER_FOCUS_STATE: CameraFocusState = {
    position: [37.22, -27.22, 0],
    target: [4.94, 4.96, 0.61],
    zoom: 80.04,
};

export const RAFT_WALL_HEIGHT_FOCUS_STATE: CameraFocusState = {
    position: [27.11, -34.24, 15.49],
    target: [-3.87, -3.24, 0.74],
    zoom: 38.96,
};

export const RAFT_WALL_THICKNESS_FOCUS_STATE: CameraFocusState = {
    position: [9.41, -9.35, 45.41],
    target: [3.07, -3.24, 0.67],
    zoom: 20.64,
};

export const RAFT_GAP_WIDTH_FOCUS_STATE: CameraFocusState = {
    position: [33.07, -29.45, 13.39],
    target: [-2.11, -2.75, 2.05],
    zoom: 58.73,
};

export const RAFT_CAMERA_FOCUS_MAP: Record<string, CameraFocusState> = {
    'raft.thickness': RAFT_THICKNESS_FOCUS_STATE,
    'raft.chamferAngle': RAFT_CHAMFER_FOCUS_STATE,
    'raft.lineWidthMm': RAFT_LINE_WIDTH_FOCUS_STATE,
    'raft.lineHeightMm': RAFT_LINE_HEIGHT_FOCUS_STATE,
    'raft.wallHeight': RAFT_WALL_HEIGHT_FOCUS_STATE,
    'raft.wallThickness': RAFT_WALL_THICKNESS_FOCUS_STATE,
    'raft.crenulationGapWidth': RAFT_GAP_WIDTH_FOCUS_STATE,
};

export function getRaftTargetFocusState(key: string | null): CameraFocusState {
    if (!key) return RAFT_HOME_FOCUS_STATE;
    return RAFT_CAMERA_FOCUS_MAP[key] || RAFT_HOME_FOCUS_STATE;
}
