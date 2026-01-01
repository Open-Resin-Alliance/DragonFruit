import { useState, useEffect, useCallback, useRef, useMemo, useSyncExternalStore } from 'react';
import { useFrame, useThree } from '@react-three/fiber';
import * as THREE from 'three';
import { subscribe, getSnapshot, updateTrunk, updateBranch, updateTwig, updateStick } from '../../state';
import { splitShaft, splitBranchShaft, splitTwigShaft, splitStickShaft } from './jointUtils';
import { useSnapping } from '../../interaction/useSnapping';
import { SnapTarget } from '../../interaction/SnappingManager';
import { Vec3 } from '../../types';
import { jointCreationStore, useJointCreationState } from './jointCreationState';
import { getSocketPosition } from '../ContactCone';
import { getJointDiameter } from '../../constants';

export function useJointCreation() {
    // Consume global state driven by page.tsx
    const { isActive } = useJointCreationState();
    // Consume support data store
    const supportState = useSyncExternalStore(subscribe, getSnapshot);
    
    const [preview, setPreview] = useState<{ pos: Vec3, diameter: number, normal?: Vec3 } | null>(null);
    const [target, setTarget] = useState<{ trunkId: string, segmentId: string, t?: number } | null>(null);
    
    useEffect(() => {
        console.log('[useJointCreation] Mounted. Active:', isActive);
    }, []);

    useEffect(() => {
        console.log('[useJointCreation] Active state changed to:', isActive);
        if (!isActive) {
             setPreview(null);
             setTarget(null);
        }
    }, [isActive]);

    // Pre-calculate all snap targets (memoized) - includes trunks/branches/twigs/sticks
    const allTargets = useMemo(() => {
        const trunks = Object.values(supportState.trunks);
        const branches = Object.values(supportState.branches);
        const twigs = Object.values(supportState.twigs);
        const sticks = Object.values(supportState.sticks);
        const roots = Object.values(supportState.roots);
        const knots = Object.values(supportState.knots);
        const rootMap = new Map(roots.map(r => [r.id, r]));
        const knotMap = new Map(knots.map(k => [k.id, k]));
        const targets: SnapTarget[] = [];

        // Add trunk segments
        for (const trunk of trunks) {
            const root = rootMap.get(trunk.rootId);
            if (!root || trunk.segments.length === 0) continue;

            // Start from root base top (Match TrunkRenderer logic)
            const diskHeight = 0.5;
            const coneHeight = root.height || 1.5;
            const startZOffset = diskHeight + coneHeight;
            
            const rootPos = new THREE.Vector3(root.transform.pos.x, root.transform.pos.y, root.transform.pos.z);
            let currentStart = rootPos.clone().add(new THREE.Vector3(0, 0, startZOffset));

            // Iterate segments to build path targets
            for (const seg of trunk.segments) {
                let endPoint: THREE.Vector3;

                if (seg.topJoint) {
                    endPoint = new THREE.Vector3(seg.topJoint.pos.x, seg.topJoint.pos.y, seg.topJoint.pos.z);
                } else if (trunk.contactCone) {
                    // Shaft ends at the cone's socket position
                    const socketPos = getSocketPosition(
                        trunk.contactCone.pos,
                        trunk.contactCone.normal,
                        trunk.contactCone.profile
                    );
                    endPoint = new THREE.Vector3(socketPos.x, socketPos.y, socketPos.z);
                } else {
                    // Fallback for incomplete data
                    endPoint = currentStart.clone().add(new THREE.Vector3(0, 0, 10));
                }

                targets.push({
                    // Use the segment id directly so GPU picking (which reports segmentId) can resolve it.
                    id: seg.id,
                    type: 'path',
                    pathSegment: {
                        start: { x: currentStart.x, y: currentStart.y, z: currentStart.z },
                        end: { x: endPoint.x, y: endPoint.y, z: endPoint.z },
                        radius: seg.diameter / 2,
                        bezier: seg.type === 'bezier' ? {
                            control1: seg.controlPoint1,
                            control2: seg.controlPoint2
                        } : undefined
                    }
                });

                currentStart = endPoint;
            }
        }

        // Add branch segments (branches are just like trunks but start at a knot)
        for (const branch of branches) {
            const parentKnot = knotMap.get(branch.parentKnotId);
            if (!parentKnot || branch.segments.length === 0) continue;

            let currentStart = new THREE.Vector3(parentKnot.pos.x, parentKnot.pos.y, parentKnot.pos.z);

            for (const seg of branch.segments) {
                let endPoint: THREE.Vector3;

                if (seg.topJoint) {
                    endPoint = new THREE.Vector3(seg.topJoint.pos.x, seg.topJoint.pos.y, seg.topJoint.pos.z);
                } else if (branch.contactCone) {
                    const socketPos = getSocketPosition(
                        branch.contactCone.pos,
                        branch.contactCone.normal,
                        branch.contactCone.profile
                    );
                    endPoint = new THREE.Vector3(socketPos.x, socketPos.y, socketPos.z);
                } else {
                    endPoint = currentStart.clone().add(new THREE.Vector3(0, 0, 5));
                }

                targets.push({
                    // Use the segment id directly so GPU picking can resolve it.
                    id: seg.id,
                    type: 'path',
                    pathSegment: {
                        start: { x: currentStart.x, y: currentStart.y, z: currentStart.z },
                        end: { x: endPoint.x, y: endPoint.y, z: endPoint.z },
                        radius: seg.diameter / 2,
                        bezier: seg.type === 'bezier' ? {
                            control1: seg.controlPoint1,
                            control2: seg.controlPoint2
                        } : undefined
                    }
                });

                currentStart = endPoint;
            }
        }

        // Add twig segments (twig segments always have both joints)
        for (const twig of twigs) {
            if (twig.segments.length === 0) continue;
            for (const seg of twig.segments) {
                if (!seg.bottomJoint || !seg.topJoint) continue;
                const start = new THREE.Vector3(seg.bottomJoint.pos.x, seg.bottomJoint.pos.y, seg.bottomJoint.pos.z);
                const end = new THREE.Vector3(seg.topJoint.pos.x, seg.topJoint.pos.y, seg.topJoint.pos.z);
                targets.push({
                    id: seg.id,
                    type: 'path',
                    pathSegment: {
                        start: { x: start.x, y: start.y, z: start.z },
                        end: { x: end.x, y: end.y, z: end.z },
                        radius: seg.diameter / 2,
                        bezier: seg.type === 'bezier' ? { control1: seg.controlPoint1, control2: seg.controlPoint2 } : undefined,
                    }
                });
            }
        }

        // Add stick segments (stick segments always have both joints)
        for (const stick of sticks) {
            if (stick.segments.length === 0) continue;
            for (const seg of stick.segments) {
                if (!seg.bottomJoint || !seg.topJoint) continue;
                const start = new THREE.Vector3(seg.bottomJoint.pos.x, seg.bottomJoint.pos.y, seg.bottomJoint.pos.z);
                const end = new THREE.Vector3(seg.topJoint.pos.x, seg.topJoint.pos.y, seg.topJoint.pos.z);
                targets.push({
                    id: seg.id,
                    type: 'path',
                    pathSegment: {
                        start: { x: start.x, y: start.y, z: start.z },
                        end: { x: end.x, y: end.y, z: end.z },
                        radius: seg.diameter / 2,
                        bezier: seg.type === 'bezier' ? { control1: seg.controlPoint1, control2: seg.controlPoint2 } : undefined,
                    }
                });
            }
        }

        return targets;
    }, [isActive, supportState.trunks, supportState.branches, supportState.twigs, supportState.sticks, supportState.roots, supportState.knots]);

    // Helper to resolve targets for snapping manager
    const getTarget = useCallback((id: string): SnapTarget | null => {
        return allTargets.find(t => t.id === id) || null;
    }, [allTargets]);

    const getPotentialTargets = useCallback(() => allTargets, [allTargets]);

    const { updateSnapping, resetSnapping } = useSnapping(getTarget, getPotentialTargets);

    // Continuous update loop
    useFrame(() => {
        if (!isActive) return;

        const result = updateSnapping();
        
        if (result.state === 'locked' && result.targetId) {
             const target = getTarget(result.targetId);
             const diameter = (target?.pathSegment?.radius ? target.pathSegment.radius * 2 : 1.0);

             // Calculate segment direction (normal)
             let normal = new THREE.Vector3(0, 0, 1);
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
            if (target && preview) {
                const state = getSnapshot();
                
                // Try to find in trunks first
                const trunks = Object.values(state.trunks);
                const trunk = trunks.find(t => t.id === target.trunkId);
                if (trunk) {
                    const root = state.roots[trunk.rootId];
                    const newTrunk = splitShaft(trunk, target.segmentId, preview.pos, target.t, root);
                    updateTrunk(newTrunk);
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
                    const newBranch = splitBranchShaft(branch, target.segmentId, preview.pos, target.t, parentKnot);
                    updateBranch(newBranch);
                    console.log('[V2] Joint created on branch:', branch.id);
                    
                    e.stopPropagation(); 
                    e.preventDefault();
                    return;
                }

                // If not a branch, try twigs
                const twigs = Object.values(state.twigs);
                const twig = twigs.find(tg => tg.id === target.trunkId);
                if (twig) {
                    const newTwig = splitTwigShaft(twig, target.segmentId, preview.pos, target.t);
                    updateTwig(newTwig);
                    console.log('[V2] Joint created on twig:', twig.id);

                    e.stopPropagation();
                    e.preventDefault();
                    return;
                }

                // If not a twig, try sticks
                const sticks = Object.values(state.sticks);
                const stick = sticks.find(st => st.id === target.trunkId);
                if (stick) {
                    const newStick = splitStickShaft(stick, target.segmentId, preview.pos, target.t);
                    updateStick(newStick);
                    console.log('[V2] Joint created on stick:', stick.id);

                    e.stopPropagation();
                    e.preventDefault();
                }
            }
        };

        window.addEventListener('click', handleClick, true);
        return () => window.removeEventListener('click', handleClick, true);

    }, [isActive, target, preview]);

    return {
        isActive,
        preview
    };
}
