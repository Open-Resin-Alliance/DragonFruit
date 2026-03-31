import React, { useSyncExternalStore, useCallback, useRef, useEffect } from 'react';
import { ScreenSpaceGizmo } from '@/components/gizmo/ScreenSpaceGizmo';
import { subscribe, getSnapshot, updateTrunk, updateBranch, updateTwig, updateStick, getTrunkById, getBranchById, getTwigById, getStickById } from '../../state';
import * as THREE from 'three';
import { pushHistory } from '@/history/historyStore';
import { SUPPORT_UPDATE_TRUNK } from '../../history/actionTypes';
import { captureSupportEditSnapshot, pushSupportEditHistory } from '../../history/supportEditHistory';
import { useCurveInteractionState } from '../../Curves/curveInteractionState';
import { calculateDiskThickness } from '../ContactDisk/contactDiskUtils';
import { Trunk, Branch, Twig, Stick, Joint } from '../../types';
import { getKickstandSnapshot, useKickstandStoreState, updateKickstand } from '../../SupportTypes/Kickstand/kickstandStore';
import type { Kickstand } from '../../SupportTypes/Kickstand/types';
import { useJointDragPosition } from '../../interaction/jointDragPosition';
import { clearSupportDragPreview, emitSupportDragPreview, setJointInteractionLock } from './jointDragRuntime';
import { commitJointDragSupport, computeJointDragSupportPreview, publishJointDragSupportPreview } from './jointDragController';

export function JointGizmo() {
    const MOVE_DELTA_EPS_SQ = 1e-12;
    const state = useSyncExternalStore(subscribe, getSnapshot);
    const kickstandState = useKickstandStoreState();
    const selectedId = state.selectedId;
    const initialTrunkRef = useRef<Trunk | null>(null);
    const initialBranchRef = useRef<Branch | null>(null);
    const initialEditSnapshotRef = useRef<ReturnType<typeof captureSupportEditSnapshot> | null>(null);
    const dragPosRef = useRef<THREE.Vector3 | null>(null);
    const selectedJointParentRef = useRef<{ selectedId: string; kind: 'trunk' | 'branch' | 'twig' | 'stick' | 'kickstand'; supportId: string } | null>(null);
    const { isActive: isCurveMode } = useCurveInteractionState();
    const liveTrunkPreviewRef = useRef<Trunk | null>(null);
    const liveBranchPreviewRef = useRef<Branch | null>(null);
    const liveTwigPreviewRef = useRef<Twig | null>(null);
    const liveStickPreviewRef = useRef<Stick | null>(null);
    const liveKickstandPreviewRef = useRef<Kickstand | null>(null);
    const pendingDeltaRef = useRef<THREE.Vector3>(new THREE.Vector3());
    const moveRafRef = useRef<number | null>(null);
    const gizmoTargetRef = useRef<THREE.Group>(null);
    const jointDragPosition = useJointDragPosition(selectedId ?? '');

    const cloneObj = <T,>(obj: T | null | undefined): T | null => obj ? JSON.parse(JSON.stringify(obj)) : null;

    useEffect(() => {
        return () => {
            if (typeof window === 'undefined') return;
            if (moveRafRef.current !== null) {
                window.cancelAnimationFrame(moveRafRef.current);
                moveRafRef.current = null;
            }
            setJointInteractionLock(false, 0);
        };
    }, []);

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

    const getJointPosInSegments = useCallback((segments: any[], jointId: string): { x: number; y: number; z: number } | null => {
        for (const seg of segments) {
            if (seg.topJoint?.id === jointId) return seg.topJoint.pos;
            if (seg.bottomJoint?.id === jointId) return seg.bottomJoint.pos;
        }
        return null;
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
    const findJointAndParent = useCallback((): { joint: Joint, trunk?: Trunk, branch?: Branch, twig?: Twig, stick?: Stick, kickstand?: Kickstand } | null => {
        if (!selectedId) return null;

        const findJointInSegments = (segments: Array<{ topJoint?: Joint; bottomJoint?: Joint }>) => {
            for (const seg of segments) {
                if (seg.topJoint?.id === selectedId) return seg.topJoint;
                if (seg.bottomJoint?.id === selectedId) return seg.bottomJoint;
            }
            return null;
        };

        const cached = selectedJointParentRef.current;
        if (cached && cached.selectedId === selectedId) {
            if (cached.kind === 'trunk') {
                const trunk = getTrunkById(cached.supportId);
                if (trunk) {
                    const joint = findJointInSegments(trunk.segments as any[]);
                    if (joint) return { joint, trunk };
                }
            } else if (cached.kind === 'branch') {
                const branch = getBranchById(cached.supportId);
                if (branch) {
                    const joint = findJointInSegments(branch.segments as any[]);
                    if (joint) return { joint, branch };
                }
            } else if (cached.kind === 'twig') {
                const twig = getTwigById(cached.supportId);
                if (twig) {
                    const joint = findJointInSegments(twig.segments as any[]);
                    if (joint) return { joint, twig };
                }
            } else if (cached.kind === 'stick') {
                const stick = getStickById(cached.supportId);
                if (stick) {
                    const joint = findJointInSegments(stick.segments as any[]);
                    if (joint) return { joint, stick };
                }
            } else {
                const kickstand = kickstandState.kickstands[cached.supportId];
                if (kickstand) {
                    const joint = findJointInSegments(kickstand.segments as any[]);
                    if (joint) return { joint, kickstand };
                }
            }

            selectedJointParentRef.current = null;
        }
        
        // Search trunks first
        const trunks = Object.values(state.trunks);
        for (const trunk of trunks) {
            for (const seg of trunk.segments) {
                if (seg.topJoint?.id === selectedId) {
                    selectedJointParentRef.current = { selectedId, kind: 'trunk', supportId: trunk.id };
                    return { joint: seg.topJoint, trunk };
                }
                if (seg.bottomJoint?.id === selectedId) {
                    selectedJointParentRef.current = { selectedId, kind: 'trunk', supportId: trunk.id };
                    return { joint: seg.bottomJoint, trunk };
                }
            }
        }
        
        // Search branches
        const branches = Object.values(state.branches);
        for (const branch of branches) {
            for (const seg of branch.segments) {
                if (seg.topJoint?.id === selectedId) {
                    selectedJointParentRef.current = { selectedId, kind: 'branch', supportId: branch.id };
                    return { joint: seg.topJoint, branch };
                }
                if (seg.bottomJoint?.id === selectedId) {
                    selectedJointParentRef.current = { selectedId, kind: 'branch', supportId: branch.id };
                    return { joint: seg.bottomJoint, branch };
                }
            }
        }

        // Search twigs
        const twigs = Object.values(state.twigs);
        for (const twig of twigs) {
            for (const seg of twig.segments) {
                if (seg.topJoint?.id === selectedId) {
                    selectedJointParentRef.current = { selectedId, kind: 'twig', supportId: twig.id };
                    return { joint: seg.topJoint, twig };
                }
                if (seg.bottomJoint?.id === selectedId) {
                    selectedJointParentRef.current = { selectedId, kind: 'twig', supportId: twig.id };
                    return { joint: seg.bottomJoint, twig };
                }
            }
        }

        // Search sticks
        const sticks = Object.values(state.sticks);
        for (const stick of sticks) {
            for (const seg of stick.segments) {
                if (seg.topJoint?.id === selectedId) {
                    selectedJointParentRef.current = { selectedId, kind: 'stick', supportId: stick.id };
                    return { joint: seg.topJoint, stick };
                }
                if (seg.bottomJoint?.id === selectedId) {
                    selectedJointParentRef.current = { selectedId, kind: 'stick', supportId: stick.id };
                    return { joint: seg.bottomJoint, stick };
                }
            }
        }

        // Search kickstands
        const kickstands = Object.values(kickstandState.kickstands);
        for (const kickstand of kickstands) {
            for (const seg of kickstand.segments) {
                if (seg.topJoint?.id === selectedId) {
                    selectedJointParentRef.current = { selectedId, kind: 'kickstand', supportId: kickstand.id };
                    return { joint: seg.topJoint, kickstand };
                }
                if (seg.bottomJoint?.id === selectedId) {
                    selectedJointParentRef.current = { selectedId, kind: 'kickstand', supportId: kickstand.id };
                    return { joint: seg.bottomJoint, kickstand };
                }
            }
        }

        selectedJointParentRef.current = null;
        
        return null;
    }, [selectedId, state.trunks, state.branches, state.twigs, state.sticks, kickstandState.kickstands]);

    useEffect(() => {
        if (!jointDragPosition) return;
        if (gizmoTargetRef.current) {
            gizmoTargetRef.current.position.set(jointDragPosition.x, jointDragPosition.y, jointDragPosition.z);
        }
    }, [jointDragPosition]);

    const result = findJointAndParent();
    const joint = result?.joint ?? null;
    const trunk = result?.trunk;
    const branch = result?.branch;
    const twig = result?.twig;
    const stick = result?.stick;
    const kickstand = result?.kickstand;

    const handleMoveStart = () => {
        if (!joint) return;
        setJointInteractionLock(true);
        dragPosRef.current = new THREE.Vector3(joint.pos.x, joint.pos.y, joint.pos.z);

        if (branch || twig || stick || kickstand) {
            initialEditSnapshotRef.current = captureSupportEditSnapshot();
        }

        if (branch || twig || stick || kickstand) {
            initialEditSnapshotRef.current = captureSupportEditSnapshot();
        }
    };

    const applyMoveDelta = useCallback((delta: THREE.Vector3) => {
        if (!joint) return;
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

        let gizmoPos = newPos;

        if (trunk) {
            if (!initialTrunkRef.current) {
                initialTrunkRef.current = cloneObj(trunk);
            }
            const newTrunk = computeJointDragSupportPreview({
                kind: 'trunk',
                support: trunk,
                jointId: joint.id,
                newPos,
                isCurveMode,
                root: state.roots[trunk.rootId],
            });
            if (liveTrunkPreviewRef.current !== newTrunk) {
                liveTrunkPreviewRef.current = newTrunk;
                publishJointDragSupportPreview('trunk', newTrunk);
            }
            const clamped = getJointPosInSegments(newTrunk.segments as any[], joint.id);
            if (clamped) gizmoPos = clamped;
        } else if (branch) {
            if (!initialBranchRef.current) {
                initialBranchRef.current = cloneObj(branch);
            }
            const newBranch = computeJointDragSupportPreview({
                kind: 'branch',
                support: branch,
                jointId: joint.id,
                newPos,
                isCurveMode: false,
            }) as Branch;
            if (liveBranchPreviewRef.current !== newBranch) {
                liveBranchPreviewRef.current = newBranch;
                publishJointDragSupportPreview('branch', newBranch);
            }
            const clamped = getJointPosInSegments(newBranch.segments as any[], joint.id);
            if (clamped) gizmoPos = clamped;
        } else if (twig) {
            if (!initialBranchRef.current) {
                initialBranchRef.current = cloneObj(branch);
            }
            const newBranch = computeJointDragSupportPreview({
                kind: 'branch',
                support: branch,
                jointId: joint.id,
                newPos,
                isCurveMode: false,
            }) as Branch;
            if (liveBranchPreviewRef.current !== newBranch) {
                liveBranchPreviewRef.current = newBranch;
                publishJointDragSupportPreview('branch', newBranch);
            }
        } else if (twig) {
            const newTwig: Twig = {
                ...twig,
                segments: updateSegmentsJointPos(twig.segments as any[], joint.id, newPos) as any,
            };
            liveTwigPreviewRef.current = newTwig;
            emitSupportDragPreview('twig', newTwig.id, newTwig);
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
            liveStickPreviewRef.current = newStick;
            emitSupportDragPreview('stick', newStick.id, newStick);
        } else if (kickstand) {
            const root = state.roots[kickstand.rootId];
            const contextStart = root
                ? {
                    x: root.transform.pos.x,
                    y: root.transform.pos.y,
                    z: root.transform.pos.z + root.diskHeight + root.coneHeight,
                }
                : undefined;

            const newKickstand = computeJointDragSupportPreview({
                kind: 'kickstand',
                support: kickstand,
                jointId: joint.id,
                newPos,
                isCurveMode,
                root,
                contextStart,
            });
            if (liveKickstandPreviewRef.current !== newKickstand) {
                liveKickstandPreviewRef.current = newKickstand;
                publishJointDragSupportPreview('kickstand', newKickstand);
            }
        }

        if (gizmoTargetRef.current) {
            const effectivePos = gizmoPos ?? newPos;
            gizmoTargetRef.current.position.set(effectivePos.x, effectivePos.y, effectivePos.z);
        }
    }, [
        branch,
        isCurveMode,
        joint?.id,
        joint?.pos.x,
        joint?.pos.y,
        joint?.pos.z,
        kickstand,
        state.roots,
        stick,
        trunk,
        twig,
        updateSegmentsJointPos,
        recomputeConeForSocket,
    ]);

    const flushPendingMove = useCallback(() => {
        if (pendingDeltaRef.current.lengthSq() <= MOVE_DELTA_EPS_SQ) return;
        const delta = pendingDeltaRef.current.clone();
        pendingDeltaRef.current.set(0, 0, 0);
        applyMoveDelta(delta);
    }, [applyMoveDelta]);

    const scheduleMoveFlush = useCallback(() => {
        if (typeof window === 'undefined') return;
        if (moveRafRef.current !== null) return;

        moveRafRef.current = window.requestAnimationFrame(() => {
            moveRafRef.current = null;
            flushPendingMove();

            if (pendingDeltaRef.current.lengthSq() > MOVE_DELTA_EPS_SQ) {
                scheduleMoveFlush();
            }
        });
    }, [flushPendingMove]);

    const handleMove = (delta: THREE.Vector3) => {
        if (!joint) return;
        pendingDeltaRef.current.add(delta);
        scheduleMoveFlush();
    };

    const handleMoveEnd = () => {
        if (!joint) return;
        if (typeof window !== 'undefined' && moveRafRef.current !== null) {
            window.cancelAnimationFrame(moveRafRef.current);
            moveRafRef.current = null;
        }
        flushPendingMove();

        setJointInteractionLock(false);
        // Prevent the canvas click handler from deselecting the joint
        window.__gizmoDragEndedThisFrame = true;
        dragPosRef.current = null;
        pendingDeltaRef.current.set(0, 0, 0);

        if (initialTrunkRef.current && trunk) {
            const committedTrunk = liveTrunkPreviewRef.current ?? getTrunkById(trunk.id);
            if (committedTrunk) {
                const appliedTrunk = commitJointDragSupport('trunk', committedTrunk);
                pushHistory({
                    type: SUPPORT_UPDATE_TRUNK,
                    description: 'Move trunk joint',
                    payload: {
                        before: initialTrunkRef.current,
                        after: cloneObj(appliedTrunk),
                    },
                });
            }
            initialTrunkRef.current = null;
        }

        if (initialEditSnapshotRef.current) {
            if (branch) {
                const committedBranch = liveBranchPreviewRef.current ?? getBranchById(branch.id);
                if (committedBranch) {
                    commitJointDragSupport('branch', committedBranch as Branch);
                }
                pushSupportEditHistory('Move branch joint', initialEditSnapshotRef.current, captureSupportEditSnapshot());
            } else if (twig) {
                const committedTwig = liveTwigPreviewRef.current ?? getTwigById(twig.id);
                if (committedTwig) {
                    updateTwig(committedTwig);
                }
                clearSupportDragPreview('twig', twig.id);
                pushSupportEditHistory('Move twig joint', initialEditSnapshotRef.current, captureSupportEditSnapshot());
            } else if (stick) {
                const committedStick = liveStickPreviewRef.current ?? getStickById(stick.id);
                if (committedStick) {
                    updateStick(committedStick);
                }
                clearSupportDragPreview('stick', stick.id);
                pushSupportEditHistory('Move stick joint', initialEditSnapshotRef.current, captureSupportEditSnapshot());
            } else if (kickstand) {
                const committedKickstand = liveKickstandPreviewRef.current ?? getKickstandSnapshot().kickstands[kickstand.id];
                if (committedKickstand) {
                    commitJointDragSupport('kickstand', committedKickstand);
                }
                pushSupportEditHistory('Move kickstand joint', initialEditSnapshotRef.current, captureSupportEditSnapshot());
            }
            initialEditSnapshotRef.current = null;
        }

        initialBranchRef.current = null;
        liveTrunkPreviewRef.current = null;
        liveBranchPreviewRef.current = null;
        liveTwigPreviewRef.current = null;
        liveStickPreviewRef.current = null;
        liveKickstandPreviewRef.current = null;
    };

    if (!joint) return null;

    return (
        <>
            <group ref={gizmoTargetRef as React.MutableRefObject<THREE.Group>} position={[joint.pos.x, joint.pos.y, joint.pos.z]} />
            <ScreenSpaceGizmo
                meshRef={gizmoTargetRef as React.RefObject<THREE.Group>}
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
        </>
    );
}
