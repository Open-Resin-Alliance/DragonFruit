import { useCallback } from 'react';
import { useSnapping } from '../../../useSnapping';
import type { SnapTarget, SnapResult } from '../../../SnappingManager';
import type { ResolvedSnapState } from './snappingTypes';
import { snappingSessionStore } from './snappingSession';

export function usePlacementSnappingSession(
    getTargetCallback: (id: string) => SnapTarget | null,
    getPotentialTargets: () => SnapTarget[]
) {
    const { updateSnapping, resetSnapping } = useSnapping(getTargetCallback, getPotentialTargets);

    const updateAndGetResolvedSnap = useCallback((): ResolvedSnapState => {
        updateSnapping();
        return snappingSessionStore.getSnapshot();
    }, [updateSnapping]);

    const getResolvedSnap = useCallback((): ResolvedSnapState => {
        return snappingSessionStore.getSnapshot();
    }, []);

    return {
        updateSnapping,
        updateAndGetResolvedSnap,
        getResolvedSnap,
        resetSnapping,
    } as {
        updateSnapping: () => SnapResult;
        updateAndGetResolvedSnap: () => ResolvedSnapState;
        getResolvedSnap: () => ResolvedSnapState;
        resetSnapping: () => void;
    };
}
