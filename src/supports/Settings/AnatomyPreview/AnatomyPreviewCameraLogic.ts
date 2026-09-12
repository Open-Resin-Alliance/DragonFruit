import type { SupportKind } from '../supportKindState';
import type { CameraFocusState } from './AnatomyPreviewCameraTypes';
import {
    BRANCH_HOME_FOCUS_STATE,
    LEAF_HOME_FOCUS_STATE,
    getBranchTargetFocusState,
    getLeafTargetFocusState,
    getSupportTargetFocusState,
    getTwigTargetFocusState,
    SUPPORT_HOME_FOCUS_STATE,
    TRUNK_HOME_FOCUS_STATE,
} from './PreviewTypes/Trunk/camera';
import { getRaftTargetFocusState, RAFT_HOME_FOCUS_STATE } from './PreviewTypes/Raft/camera';
import { getGridTargetFocusState } from './PreviewTypes/Grid/camera';
import { getBraceTargetFocusState, BRACE_HOME_FOCUS_STATE } from './PreviewTypes/Brace/camera';

export type { CameraFocusState };

export const HOME_FOCUS_STATE: CameraFocusState = SUPPORT_HOME_FOCUS_STATE;
export { RAFT_HOME_FOCUS_STATE };
export { BRACE_HOME_FOCUS_STATE };

/**
 * Where the preview camera sits for each sidebar kind.
 *
 * `target` frames a named setting; `home` is where the camera rests when no
 * setting is focused, for the kinds that declare one. A kind with no entry
 * falls back to the shared support framing.
 */
const CAMERA_BY_KIND: Partial<Record<SupportKind, {
    target: (key: string | null) => CameraFocusState;
    home?: CameraFocusState;
}>> = {
    raft: { target: getRaftTargetFocusState },
    grid: { target: getGridTargetFocusState },
    stick: { target: getBraceTargetFocusState },
    twig: { target: getTwigTargetFocusState },
    branch: { target: getBranchTargetFocusState, home: BRANCH_HOME_FOCUS_STATE },
    leaf: { target: getLeafTargetFocusState, home: LEAF_HOME_FOCUS_STATE },
    trunk: { target: getSupportTargetFocusState, home: TRUNK_HOME_FOCUS_STATE },
};

export function getTargetFocusState(kind: SupportKind, key: string | null): CameraFocusState {
    const entry = CAMERA_BY_KIND[kind];
    if (!entry) return getSupportTargetFocusState(key);
    if (!key && entry.home) return entry.home;
    return entry.target(key);
}
