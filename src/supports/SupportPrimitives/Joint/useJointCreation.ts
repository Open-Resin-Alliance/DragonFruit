import { useState, useEffect, useCallback, useMemo, useSyncExternalStore } from 'react';
import { useFrame, useThree } from '@react-three/fiber';
import * as THREE from 'three';
import { subscribe, getSnapshot, updateTrunk, updateBranch, updateTwig, updateStick, updateKnot } from '../../state';
import { splitShaft, splitBranchShaft, splitTwigShaft, splitStickShaft } from './jointUtils';
import type { KnotSplitRemap } from '../Knot/knotUtils';
import { SnapTarget } from '../../interaction/SnappingManager';
import { Vec3 } from '../../types';
import { useJointCreationState } from './jointCreationState';
import { getJointDiameter } from '../../constants';
import { usePlacementSnappingSession } from '../../interaction/shared/placement/snapping/usePlacementSnappingSession';
import { buildPrimarySnapTargetIndex, buildSupportPathSnapTargets } from '../../interaction/shared/placement/snapping/supportPathTargets';
import { captureSupportEditSnapshot, pushSupportEditHistory } from '../../history/supportEditHistory';

/**
 * Apply knot re-anchor patches from a segment split BEFORE the host update runs.
 * The host update (updateTrunk/updateBranch/etc.) re-derives every attached
 * knot's world position from its `t` against the new, shorter segment span, so
 * the corrected `t` / `parentShaftId` must already be in the store when it runs.
 * Otherwise attached branches/leaves slide down below the inserted joint (#204).
 */
function applyKnotSplitRemaps(remaps: KnotSplitRemap[]) {
    if (remaps.length === 0) return;
    const knots = getSnapshot().knots;
    for (const remap of remaps) {
        const knot = knots[remap.knotId];
        if (!knot) continue;
        // pos is intentionally left as-is; the host update recomputes it from the
        // corrected t on the correct segment in the same click handler.
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
        return buildSupportPathSnapTargets(supportState, {
            includeTrunks: true,
            includeBranches: true,
            includeBraces: false,
            includeTwigs: true,
            includeSticks: true,
        });
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
             
             // Resolve which parent (trunk/branch/twig/stick) owns this segment.
             // We keep the existing target shape by storing the parent id in `trunkId`.
             const segmentId = result.targetId;
             if (segmentId) {
                 const trunks = Object.values(supportState.trunks);
                 const trunk = trunks.find(t => t.segments.some(s => s.id === segmentId));
                 if (trunk) {
                     setTarget({ trunkId: trunk.id, segmentId, t: result.t });
                 } else {
                     const branches = Object.values(supportState.branches);
                     const branch = branches.find(b => b.segments.some(s => s.id === segmentId));
                     if (branch) {
                         setTarget({ trunkId: branch.id, segmentId, t: result.t });
                     } else {
                         const twigs = Object.values(supportState.twigs);
                         const twig = twigs.find(tg => tg.segments.some(s => s.id === segmentId));
                         if (twig) {
                             setTarget({ trunkId: twig.id, segmentId, t: result.t });
                         } else {
                             const sticks = Object.values(supportState.sticks);
                             const stick = sticks.find(st => st.segments.some(s => s.id === segmentId));
                             if (stick) {
                                 setTarget({ trunkId: stick.id, segmentId, t: result.t });
                             } else {
                                 setTarget(null);
                             }
                         }
                     }
                 }
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
                
                // Try to find in trunks first
                const trunks = Object.values(state.trunks);
                const trunk = trunks.find(t => t.id === target.trunkId);
                if (trunk) {
                    const root = state.roots[trunk.rootId];
                    const { trunk: newTrunk, knotRemaps } = splitShaft(trunk, target.segmentId, preview.pos, target.t, root, state.knots);
                    applyKnotSplitRemaps(knotRemaps);
                    updateTrunk(newTrunk);
                    pushSupportEditHistory('Create trunk joint', beforeSnapshot, captureSupportEditSnapshot());
                    console.log('[V2] Joint created on trunk:', trunk.id);
                    
                    e.stopPropagation(); 
                    e.preventDefault();
                    return;
                }

                // If not a trunk, try branches
                const branches = Object.values(state.branches);
                const branch = branches.find(b => b.id === target.trunkId);
                if (branch) {
                    const knots = Object.values(state.knots);
                    const parentKnot = knots.find(k => k.id === branch.parentKnotId);
                    const { branch: newBranch, knotRemaps } = splitBranchShaft(branch, target.segmentId, preview.pos, target.t, parentKnot, state.knots);
                    applyKnotSplitRemaps(knotRemaps);
                    updateBranch(newBranch);
                    pushSupportEditHistory('Create branch joint', beforeSnapshot, captureSupportEditSnapshot());
                    console.log('[V2] Joint created on branch:', branch.id);
                    
                    e.stopPropagation(); 
                    e.preventDefault();
                    return;
                }

                // If not a branch, try twigs
                const twigs = Object.values(state.twigs);
                const twig = twigs.find(tg => tg.id === target.trunkId);
                if (twig) {
                    const { twig: newTwig, knotRemaps } = splitTwigShaft(twig, target.segmentId, preview.pos, target.t, state.knots);
                    applyKnotSplitRemaps(knotRemaps);
                    updateTwig(newTwig);
                    pushSupportEditHistory('Create twig joint', beforeSnapshot, captureSupportEditSnapshot());
                    console.log('[V2] Joint created on twig:', twig.id);

                    e.stopPropagation();
                    e.preventDefault();
                    return;
                }

                // If not a twig, try sticks
                const sticks = Object.values(state.sticks);
                const stick = sticks.find(st => st.id === target.trunkId);
                if (stick) {
                    const { stick: newStick, knotRemaps } = splitStickShaft(stick, target.segmentId, preview.pos, target.t, state.knots);
                    applyKnotSplitRemaps(knotRemaps);
                    updateStick(newStick);
                    pushSupportEditHistory('Create stick joint', beforeSnapshot, captureSupportEditSnapshot());
                    console.log('[V2] Joint created on stick:', stick.id);

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
