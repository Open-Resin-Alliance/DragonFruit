import React, { useSyncExternalStore, useCallback, useRef } from 'react';
import { ScreenSpaceGizmo } from '@/components/gizmo/ScreenSpaceGizmo';
import { subscribe, getSnapshot, updateTrunk, updateBranch, updateTwig, updateStick, getTrunkById, getBranchById } from '../../state';
import { moveJoint } from './jointUtils';
import * as THREE from 'three';
import { pushHistory } from '@/history/historyStore';
import { SUPPORT_UPDATE_TRUNK } from '../../history/actionTypes';
import { useCurveInteractionState } from '../../Curves/curveInteractionState';
import { calculateDiskThickness } from '../ContactDisk/contactDiskUtils';
import { Trunk, Branch, Twig, Stick, Joint } from '../../types';

export function JointGizmo() {
    const state = useSyncExternalStore(subscribe, getSnapshot);
    const selectedId = state.selectedId;
    const initialTrunkRef = useRef<Trunk | null>(null);
    const initialBranchRef = useRef<Branch | null>(null);
    const dragPosRef = useRef<THREE.Vector3 | null>(null);
    const { isActive: isCurveMode } = useCurveInteractionState();

    const cloneObj = <T,>(obj: T | null | undefined): T | null => obj ? JSON.parse(JSON.stringify(obj)) : null;

     const updateSegmentsJointPos = useCallback((segments: any[], jointId: string, pos: { x: number; y: number; z: number }) => {
         return segments.map(seg => {
             let changed = false;
             let topJoint = seg.topJoint;
             let bottomJoint = seg.bottomJoint;

             if (topJoint?.id === jointId) {
                 topJoint = { ...topJoint, pos };
                 changed = true;
             }
             if (bottomJoint?.id === jointId) {
                 bottomJoint = { ...bottomJoint, pos };
                 changed = true;
             }

             return changed ? { ...seg, topJoint, bottomJoint } : seg;
         });
     }, []);

     const recomputeConeForSocket = useCallback((cone: any, socketPos: { x: number; y: number; z: number }) => {
         const effectiveSurfaceNormal = cone.surfaceNormal || cone.normal;
         let axis = new THREE.Vector3(cone.normal.x, cone.normal.y, cone.normal.z);
         if (axis.lengthSq() < 0.000001) axis.set(0, 0, 1);
         axis.normalize();

         let offset = 0;
         if (cone.profile?.type === 'disk') {
             if (cone.diskLengthOverride !== undefined) {
                 offset = cone.diskLengthOverride;
             } else {
                 offset = calculateDiskThickness(effectiveSurfaceNormal, { x: axis.x, y: axis.y, z: axis.z }, cone.profile);
             }
         }

         const contactPos = new THREE.Vector3(cone.pos.x, cone.pos.y, cone.pos.z);
         const sn = new THREE.Vector3(effectiveSurfaceNormal.x, effectiveSurfaceNormal.y, effectiveSurfaceNormal.z);
         const socket = new THREE.Vector3(socketPos.x, socketPos.y, socketPos.z);

         let startPos = contactPos.clone().add(sn.clone().multiplyScalar(offset));
         for (let i = 0; i < 3; i++) {
             const v = socket.clone().sub(startPos);
             const len = v.length();
             if (len > 0.0001) {
                 axis = v.clone().normalize();
             }
             if (cone.profile?.type === 'disk' && cone.diskLengthOverride === undefined) {
                 offset = calculateDiskThickness(effectiveSurfaceNormal, { x: axis.x, y: axis.y, z: axis.z }, cone.profile);
                 startPos = contactPos.clone().add(sn.clone().multiplyScalar(offset));
             }
         }

         const finalStart = contactPos.clone().add(sn.clone().multiplyScalar(offset));
         const lengthMm = Math.max(0.1, socket.distanceTo(finalStart));

         return {
             ...cone,
             normal: { x: axis.x, y: axis.y, z: axis.z },
             profile: {
                 ...cone.profile,
                 lengthMm,
             },
         };
     }, []);

    // Helper to find joint and parent
    const findJointAndParent = useCallback((): { joint: Joint, trunk?: Trunk, branch?: Branch, twig?: Twig, stick?: Stick } | null => {
        if (!selectedId) return null;
        
        // Search trunks first
        const trunks = Object.values(state.trunks);
        for (const trunk of trunks) {
            for (const seg of trunk.segments) {
                if (seg.topJoint?.id === selectedId) {
                    return { joint: seg.topJoint, trunk };
                }
                if (seg.bottomJoint?.id === selectedId) {
                    return { joint: seg.bottomJoint, trunk };
                }
            }
        }
        
        // Search branches
        const branches = Object.values(state.branches);
        for (const branch of branches) {
            for (const seg of branch.segments) {
                if (seg.topJoint?.id === selectedId) {
                    return { joint: seg.topJoint, branch };
                }
                if (seg.bottomJoint?.id === selectedId) {
                    return { joint: seg.bottomJoint, branch };
                }
            }
        }

        // Search twigs
        const twigs = Object.values(state.twigs);
        for (const twig of twigs) {
            for (const seg of twig.segments) {
                if (seg.topJoint?.id === selectedId) {
                    return { joint: seg.topJoint, twig };
                }
                if (seg.bottomJoint?.id === selectedId) {
                    return { joint: seg.bottomJoint, twig };
                }
            }
        }

        // Search sticks
        const sticks = Object.values(state.sticks);
        for (const stick of sticks) {
            for (const seg of stick.segments) {
                if (seg.topJoint?.id === selectedId) {
                    return { joint: seg.topJoint, stick };
                }
                if (seg.bottomJoint?.id === selectedId) {
                    return { joint: seg.bottomJoint, stick };
                }
            }
        }
        
        return null;
    }, [selectedId, state.trunks, state.branches, state.twigs, state.sticks]);

    const result = findJointAndParent();
    if (!result) return null;
    const { joint, trunk, branch, twig, stick } = result;

    const handleMoveStart = () => {
        if (joint) {
            dragPosRef.current = new THREE.Vector3(joint.pos.x, joint.pos.y, joint.pos.z);
        }
    };

    const handleMove = (delta: THREE.Vector3) => {
        if (!dragPosRef.current) {
            // Fallback if move start missed (shouldn't happen)
            dragPosRef.current = new THREE.Vector3(joint.pos.x, joint.pos.y, joint.pos.z);
        }

        // Update local truth
        dragPosRef.current.add(delta);

        const newPos = { 
            x: dragPosRef.current.x, 
            y: dragPosRef.current.y, 
            z: dragPosRef.current.z 
        };

        if (trunk) {
            if (!initialTrunkRef.current) {
                initialTrunkRef.current = cloneObj(trunk);
            }
            const newTrunk = moveJoint(trunk, joint.id, newPos, undefined, isCurveMode, state.roots[trunk.rootId]);
            updateTrunk(newTrunk);
        } else if (branch) {
            if (!initialBranchRef.current) {
                initialBranchRef.current = cloneObj(branch);
            }
            // moveJoint works on any object with segments array
            const newBranch = moveJoint(branch as any, joint.id, newPos, undefined, false) as unknown as Branch;
            updateBranch(newBranch);
        } else if (twig) {
            const newTwig: Twig = {
                ...twig,
                segments: updateSegmentsJointPos(twig.segments as any[], joint.id, newPos) as any,
            };
            updateTwig(newTwig);
        } else if (stick) {
            const nextSegments = updateSegmentsJointPos(stick.segments as any[], joint.id, newPos) as any;
            const nextConeA = stick.contactConeA?.socketJointId === joint.id
                ? recomputeConeForSocket(stick.contactConeA as any, newPos)
                : stick.contactConeA;
            const nextConeB = stick.contactConeB?.socketJointId === joint.id
                ? recomputeConeForSocket(stick.contactConeB as any, newPos)
                : stick.contactConeB;

            const newStick: Stick = {
                ...stick,
                segments: nextSegments,
                contactConeA: nextConeA,
                contactConeB: nextConeB,
            };
            updateStick(newStick);
        }
    };

    const handleMoveEnd = () => {
        // Prevent the canvas click handler from deselecting the joint
        window.__gizmoDragEndedThisFrame = true;
        dragPosRef.current = null;

        if (initialTrunkRef.current && trunk) {
            const latestTrunk = selectedId ? getTrunkById(trunk.id) : null;
            if (latestTrunk) {
                pushHistory({
                    type: SUPPORT_UPDATE_TRUNK,
                    payload: {
                        before: initialTrunkRef.current,
                        after: cloneObj(latestTrunk),
                    },
                });
            }
            initialTrunkRef.current = null;
        }
        // Note: Branch history not implemented yet
        initialBranchRef.current = null;
    };

    return (
        <ScreenSpaceGizmo
            position={[joint.pos.x, joint.pos.y, joint.pos.z]}
            enableMove={true}
            enableRotate={false}
            enableScale={false}
            onMoveStart={handleMoveStart}
            onMove={handleMove}
            onMoveEnd={handleMoveEnd}
            scaleFactor={0.02} // Half the default size for joint gizmo
            handleScale={3.0} // Double handle size for visibility
            showCenter={false} // Prefer axis movement
        />
    );
}
