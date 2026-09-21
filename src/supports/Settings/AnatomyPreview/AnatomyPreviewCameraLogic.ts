import type { SidebarPanel } from '../sidebarPanels';
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
import {
    getSupportTypeDescriptor,
    SIDEBAR_PANEL_TYPE_IDS,
    type SupportTypeDescriptor,
} from '../../supportTypeRegistry';

export type { CameraFocusState };

export const HOME_FOCUS_STATE: CameraFocusState = SUPPORT_HOME_FOCUS_STATE;
export { RAFT_HOME_FOCUS_STATE };
export { BRACE_HOME_FOCUS_STATE };

/**
 * Where the preview camera sits for a kind.
 *
 * `target` frames a named setting; `home` is where the camera rests when no
 * setting is focused, for the kinds that declare one. A kind with no entry
 * falls back to the shared support framing.
 */
type CameraEntry = {
    target: (key: string | null) => CameraFocusState;
    home?: CameraFocusState;
};

/**
 * The framing for one type's panel, chosen by the preview shape its descriptor
 * declares. A shape with no entry keeps the shared support framing.
 */
function cameraEntryFor(descriptor: SupportTypeDescriptor): CameraEntry | undefined {
    const { lower, upper } = descriptor;
    const spansTwoContacts =
        (lower.kind === 'cone' || lower.kind === 'disk')
        && (upper.kind === 'cone' || upper.kind === 'disk');

    if (spansTwoContacts) {
        return lower.kind === 'cone'
            ? { target: getBraceTargetFocusState }
            : { target: getTwigTargetFocusState };
    }

    if (lower.kind === 'knot') {
        return descriptor.hasSegments
            ? { target: getBranchTargetFocusState, home: BRANCH_HOME_FOCUS_STATE }
            : { target: getLeafTargetFocusState, home: LEAF_HOME_FOCUS_STATE };
    }

    if (lower.kind === 'plateRoot') {
        return { target: getSupportTargetFocusState, home: TRUNK_HOME_FOCUS_STATE };
    }

    return undefined;
}

/** The type panels, framed by their own preview's shape. */
const TYPE_CAMERA_ENTRIES: Partial<Record<SidebarPanel, CameraEntry>> = Object.fromEntries(
    SIDEBAR_PANEL_TYPE_IDS.flatMap((typeId) => {
        const entry = cameraEntryFor(getSupportTypeDescriptor(typeId));
        return entry ? [[typeId, entry] as const] : [];
    }),
);

const CAMERA_BY_KIND: Partial<Record<SidebarPanel, CameraEntry>> = {
    raft: { target: getRaftTargetFocusState },
    grid: { target: getGridTargetFocusState },
    ...TYPE_CAMERA_ENTRIES,
};

export function getTargetFocusState(kind: SidebarPanel, key: string | null): CameraFocusState {
    const entry = CAMERA_BY_KIND[kind];
    if (!entry) return getSupportTargetFocusState(key);
    if (!key && entry.home) return entry.home;
    return entry.target(key);
}
