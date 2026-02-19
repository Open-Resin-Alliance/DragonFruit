import type { SupportKind } from '../supportKindState';
import type { CameraFocusState } from './AnatomyPreviewCameraTypes';
import { getSupportTargetFocusState, SUPPORT_HOME_FOCUS_STATE, TRUNK_HOME_FOCUS_STATE } from './PreviewTypes/Trunk/camera';
import { getRaftTargetFocusState, RAFT_HOME_FOCUS_STATE } from './PreviewTypes/Raft/camera';
import { getGridTargetFocusState } from './PreviewTypes/Grid/camera';

export type { CameraFocusState };

export const HOME_FOCUS_STATE: CameraFocusState = SUPPORT_HOME_FOCUS_STATE;
export { RAFT_HOME_FOCUS_STATE };

export function getTargetFocusState(kind: SupportKind, key: string | null): CameraFocusState {
    if (kind === 'raft') return getRaftTargetFocusState(key);
    if (kind === 'grid') return getGridTargetFocusState(key);
    if (kind === 'trunk' && !key) return TRUNK_HOME_FOCUS_STATE;
    return getSupportTargetFocusState(key);
}
