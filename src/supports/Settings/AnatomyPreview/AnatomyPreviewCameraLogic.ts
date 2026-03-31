import type { SupportKind } from '../supportKindState';
import type { CameraFocusState } from './AnatomyPreviewCameraTypes';
import {
    BRANCH_HOME_FOCUS_STATE,
    LEAF_HOME_FOCUS_STATE,
    getBranchTargetFocusState,
    getLeafTargetFocusState,
    getStickTargetFocusState,
    getSupportTargetFocusState,
    getTwigTargetFocusState,
    SUPPORT_HOME_FOCUS_STATE,
    TRUNK_HOME_FOCUS_STATE,
} from './PreviewTypes/Trunk/camera';
import { getRaftTargetFocusState, RAFT_HOME_FOCUS_STATE } from './PreviewTypes/Raft/camera';
import { getGridTargetFocusState } from './PreviewTypes/Grid/camera';

export type { CameraFocusState };

export const HOME_FOCUS_STATE: CameraFocusState = SUPPORT_HOME_FOCUS_STATE;
export { RAFT_HOME_FOCUS_STATE };

export function getTargetFocusState(kind: SupportKind, key: string | null): CameraFocusState {
    if (kind === 'raft') return getRaftTargetFocusState(key);
    if (kind === 'grid') return getGridTargetFocusState(key);
    if (kind === 'stick') return getStickTargetFocusState(key);
    if (kind === 'twig') return getTwigTargetFocusState(key);
    if (kind === 'branch' && !key) return BRANCH_HOME_FOCUS_STATE;
    if (kind === 'leaf' && !key) return LEAF_HOME_FOCUS_STATE;
    if (kind === 'trunk' && !key) return TRUNK_HOME_FOCUS_STATE;
    if (kind === 'branch') return getBranchTargetFocusState(key);
    if (kind === 'leaf') return getLeafTargetFocusState(key);
    return getSupportTargetFocusState(key);
}
