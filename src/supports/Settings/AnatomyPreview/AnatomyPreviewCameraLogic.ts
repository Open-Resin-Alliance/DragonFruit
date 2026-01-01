import type { SupportKind } from '../supportKindState';
import type { CameraFocusState } from './AnatomyPreviewCameraTypes';
import { getSupportTargetFocusState, SUPPORT_HOME_FOCUS_STATE } from './PreviewTypes/Trunk/camera';
import { getRaftTargetFocusState, RAFT_HOME_FOCUS_STATE } from './PreviewTypes/Raft/camera';

export type { CameraFocusState };

export const HOME_FOCUS_STATE: CameraFocusState = SUPPORT_HOME_FOCUS_STATE;
export { RAFT_HOME_FOCUS_STATE };

export function getTargetFocusState(kind: SupportKind, key: string | null): CameraFocusState {
    if (kind === 'raft') return getRaftTargetFocusState(key);
    return getSupportTargetFocusState(key);
}
