import { useState, useEffect, useCallback, useMemo, useSyncExternalStore } from 'react';
import { useFrame, useThree } from '@react-three/fiber';
import * as THREE from 'three';
import { subscribe, getSnapshot, findShaftOwnerOfSegment, getSupportEntity, updateKnot } from '../../state';
import { splitSupportShaft } from './jointUtils';
import { getSupportTypeDescriptor, updateSupportEntity, type SupportEdge } from '../../supportTypeRegistry';
import type { KnotSplitRemap } from '../Knot/knotUtils';
import { SnapTarget } from '../../interaction/SnappingManager';
import { Segment, Vec3 } from '../../types';
import { useJointCreationState } from './jointCreationState';
import { getJointDiameter } from '../../constants';
import { usePlacementSnappingSession } from '../../interaction/shared/placement/snapping/usePlacementSnappingSession';
import { buildPrimarySnapTargetIndex, SHAFTED_SNAP_TYPES, buildSupportPathSnapTargets } from '../../interaction/shared/placement/snapping/supportPathTargets';
import { captureSupportEditSnapshot, pushSupportEditHistory } from '../../history/supportEditHistory';

/**
 * Apply knot re-anchor patches from a segment split BEFORE the host update runs.
 * The host update re-derives every attached knot's world position from its `t`
 * against the new, shorter segment span, so the corrected `t` /
 * `parentShaftId` must already be in the store when it runs. Otherwise
 * attached branches/leaves slide down below the inserted joint (#204).
 */
function applyKnotSplitRemaps(remaps: KnotSplitRemap[]) {
    if (remaps.length === 0) return;
    const knots = getSnapshot().knots;
    for (const remap of remaps) {
        const knot = knots[remap.knotId];
        if (!knot) continue;
        updateKnot({ ...knot, parentShaftId: remap.parentShaftId, t: remap.t });
    }
}

export function useJointCreation() {
    const { gl } = useThree();
    // Consume global state driven by page.tsx
    const { isActive } = useJointCreationState();
    // Consume support data store
    const supportState = useSyncExternalStore(subscribe, getSnapshot);
    
    const [preview, setPreview] = useState<{ pos: Vec3, diameter: number, normal?: Vec3 } | null>(null);
    const [target, setTarget] = useState<{ trunkId: string, segmentId: string, t?: number } | null>(null);
    
    // Pre-calculate all snap targets (memoized) - includes trunks/branches/twigs/sticks
    const allTargets = useMemo(() => {
        return buildSupportPathSnapTargets(supportState, { snapTypes: SHAFTED_SNAP_TYPES });
    }, [supportState]);

    const targetById = useMemo(() => {
        return buildPrimarySnapTargetIndex(allTargets);
    }, [allTargets]);

    // Helper to resolve targets for snapping manager
    const getTarget = useCallback((id: string): SnapTarget | null => {
        return targetById.get(id) ?? null;
    }, [targetById]);

    const getPotentialTargets = useCallback(() => allTargets, [allTargets]);

    const { updateSnapping } = usePlacementSnappingSession(getTarget, getPotentialTargets);

    // Continuous update loop
    useFrame(() => {
        if (!isActive) {
            if (preview !== null) setPreview(null);
            if (target !== null) setTarget(null);
            return;
        }

        const result = updateSnapping();
        
        if (result.state === 'locked' && result.targetId) {
             const target = getTarget(result.targetId);
             const diameter = (target?.pathSegment?.radius ? target.pathSegment.radius * 2 : 1.0);

             // Calculate segment direction (normal)
             const normal = new THREE.Vector3(0, 0, 1);
             if (target && target.pathSegment) {
                 const start = new THREE.Vector3(target.pathSegment.start.x, target.pathSegment.start.y, target.pathSegment.start.z);
                 const end = new THREE.Vector3(target.pathSegment.end.x, target.pathSegment.end.y, target.pathSegment.end.z);
                 normal.subVectors(end, start).normalize();
             }

             setPreview({
                 pos: result.snappedPos,
                 diameter: getJointDiameter(diameter),
                 normal: { x: normal.x, y: normal.y, z: normal.z }
             });
             
             // Which support owns this segment, across every shafted type.
             // The target shape keeps the owner's id in `trunkId`.
             const segmentId = result.targetId;
             if (segmentId) {
                 const owner = findShaftOwnerOfSegment(segmentId);
                 setTarget(owner ? { trunkId: owner.id, segmentId, t: result.t } : null);
             }
        } else {
            if (preview !== null) setPreview(null);
            if (target !== null) setTarget(null);
        }
    });

    // Handle clicks internally when active
    useEffect(() => {
        if (!isActive) return;

        const handleClick = (e: MouseEvent) => {
            if (e.target !== gl.domElement) return;
            if (target && preview) {
                const beforeSnapshot = captureSupportEditSnapshot();
                const state = getSnapshot();
                
                // Which support owns the target segment, then split it.
                const owner = findShaftOwnerOfSegment(target.segmentId);
                const entity = owner ? getSupportEntity(owner.typeId, owner.id) : null;
                if (owner && entity) {
                    const descriptor = getSupportTypeDescriptor(owner.typeId);
                    const linked = entity as { rootId?: string; parentKnotId?: string; hostKnotId?: string };
                    const knotField = descriptor.edges.find(
                        (edge: SupportEdge) => edge.to === 'knots' && edge.ownership === 'hostedBy',
                    )?.field as keyof typeof linked | undefined;

                    const { entity: split, knotRemaps } = splitSupportShaft(
                        owner.typeId,
                        entity as { segments: Segment[] },
                        target.segmentId,
                        preview.pos,
                        target.t,
                        {
                            root: linked.rootId ? state.roots[linked.rootId] : undefined,
                            hostKnot: knotField && typeof linked[knotField] === 'string'
                                ? state.knots[linked[knotField] as string]
                                : undefined,
                        },
                        state.knots,
                    );

                    applyKnotSplitRemaps(knotRemaps);
                    updateSupportEntity(owner.typeId, split);
                    pushSupportEditHistory(`Create ${owner.typeId} joint`, beforeSnapshot, captureSupportEditSnapshot());

                    e.stopPropagation();
                    e.preventDefault();
                }
            }
        };

        window.addEventListener('click', handleClick, true);
        return () => window.removeEventListener('click', handleClick, true);

    }, [isActive, target, preview, gl]);

    return {
        isActive,
        preview
    };
}
