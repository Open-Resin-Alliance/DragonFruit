import { useState, useRef, useCallback } from 'react';
import { useThree } from '@react-three/fiber';
import { usePicking } from '@/components/picking';
import { SnappingManager, SnapResult, SnapTarget } from './SnappingManager';

export function useSnapping(
    getTargetCallback: (id: string) => SnapTarget | null,
    getPotentialTargets?: () => SnapTarget[]
) {
    const manager = useRef(new SnappingManager());
    const { hit } = usePicking();
    const { raycaster, camera, pointer } = useThree();
    
    const [snapResult, setSnapResult] = useState<SnapResult>({
        state: 'idle',
        snappedPos: { x: 0, y: 0, z: 0 },
        targetId: null,
        targetType: null
    });

    const lastPublishedRef = useRef<{ state: string; targetId: string | null; targetType: string | null; t?: number }>(
        { state: 'idle', targetId: null, targetType: null }
    );

    const updateSnapping = useCallback(() => {
        // Update raycaster with current pointer
        raycaster.setFromCamera(pointer, camera);
        
        const potential = getPotentialTargets ? getPotentialTargets() : [];
        const result = manager.current.update(raycaster.ray, hit, getTargetCallback, potential);

        // Do NOT publish snapping results to React state every frame.
        // Publishing every mouse move/frame can cause visible input lag.
        // We only publish when the snap state or target identity changes.
        const last = lastPublishedRef.current;
        const nextKey = {
            state: result.state,
            targetId: result.targetId,
            targetType: result.targetType,
            t: result.t,
        };
        if (
            last.state !== nextKey.state ||
            last.targetId !== nextKey.targetId ||
            last.targetType !== nextKey.targetType ||
            last.t !== nextKey.t
        ) {
            lastPublishedRef.current = nextKey;
            setSnapResult(result);
        }
        return result;
    }, [hit, getTargetCallback, getPotentialTargets, camera, pointer, raycaster]);

    const resetSnapping = useCallback(() => {
        manager.current.reset();
        setSnapResult({
            state: 'idle',
            snappedPos: { x: 0, y: 0, z: 0 },
            targetId: null,
            targetType: null
        });
    }, []);

    return {
        snapResult,
        updateSnapping,
        resetSnapping
    };
}
