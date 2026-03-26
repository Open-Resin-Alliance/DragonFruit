import type { SnapResult } from '@/supports/interaction/SnappingManager';
import type { ResolvedSnapState } from './snappingTypes';
import { EMPTY_RESOLVED_SNAP_STATE } from './snappingTypes';

export function resolveSnapState(result: SnapResult | null | undefined): ResolvedSnapState {
    if (!result || !result.targetId || result.state !== 'locked') {
        return EMPTY_RESOLVED_SNAP_STATE;
    }

    return {
        state: 'locked',
        targetId: result.targetId,
        snappedPos: result.snappedPos,
        t: result.t ?? null,
        metadata: result.targetType ? { targetType: result.targetType } : null,
    };
}
