import React, { useSyncExternalStore, useCallback, useRef, useEffect, useLayoutEffect } from 'react';
import { ScreenSpaceGizmo } from '@/components/gizmo/ScreenSpaceGizmo';
import { subscribe, getSnapshot, findShaftOwnerOfJoint, getSupportEntity } from '../../state';
import { getSupportTypeDescriptor, updateSupportEntity, type SupportTypeId } from '../../supportTypeRegistry';
import * as THREE from 'three';
import { pushSupportHistory } from '@/supports/history/supportHistory';
import { SUPPORT_UPDATE_TRUNK } from '../../history/actionTypes';
import { captureSupportEditSnapshot, pushSupportEditHistory } from '../../history/supportEditHistory';
import { useCurveInteractionState } from '../../Curves/curveInteractionState';
import { calculateDiskThickness } from '../ContactDisk/contactDiskUtils';
import { Trunk, Branch, Twig, Stick, Joint, Segment } from '../../types';
import type { Kickstand } from '../../SupportTypes/Kickstand/types';
import { useJointDragPosition } from '../../interaction/jointDragPosition';
import { clearSupportDragPreview, emitSupportDragPreview, setJointInteractionLock } from './jointDragRuntime';
import { commitJointDragSupport, computeJointDragSupportPreview, publishJointDragSupportPreview, type JointDragSupport } from './jointDragController';
import { resolveShaftAnchor } from '../Knot/segmentEndpoints';
import { resolveDraggedContacts } from './resolveDraggedContacts';

export function JointGizmo() {
    const MOVE_DELTA_EPS_SQ = 1e-12;
    const state = useSyncExternalStore(subscribe, getSnapshot);
    const selectedId = state.selectedId;
    const initialTrunkRef = useRef<Trunk | null>(null);
    const initialBranchRef = useRef<Branch | null>(null);
    const initialEditSnapshotRef = useRef<ReturnType<typeof captureSupportEditSnapshot> | null>(null);
    const dragPosRef = useRef<THREE.Vector3 | null>(null);
    const { isActive: isCurveMode } = useCurveInteractionState();
    // One preview for whichever support is being dragged.
    const livePreviewRef = useRef<{ typeId: SupportTypeId; support: unknown } | null>(null);
    const livePreviewOf = <T,>(typeId: SupportTypeId): T | null => {
        const live = livePreviewRef.current;
        return live?.typeId === typeId ? live.support as T : null;
    };
    const setLivePreview = (typeId: SupportTypeId, support: unknown) => {
        livePreviewRef.current = { typeId, support };
    };
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

    /** The dragged joint and the support that owns it, over every shafted type. */
    const findJointAndParent = useCallback((): {
        joint: Joint;
        typeId: SupportTypeId;
        id: string;
        entity: JointDragSupport;
    } | null => {
        if (!selectedId) return null;

        const owner = findShaftOwnerOfJoint(selectedId);
        if (!owner) return null;

        const entity = getSupportEntity(owner.typeId, owner.id) as { segments?: Segment[] } | null;
        if (!entity) return null;

        let joint: Joint | null = null;
        for (const seg of entity.segments ?? []) {
            if (seg.topJoint?.id === selectedId) { joint = seg.topJoint; break; }
            if (seg.bottomJoint?.id === selectedId) { joint = seg.bottomJoint; break; }
        }
        if (!joint) return null;

        return { joint, typeId: owner.typeId, id: owner.id, entity: entity as JointDragSupport };
        // `findShaftOwnerOfJoint` and `getSupportEntity` read the store directly, so
        // `state` invalidates this even though the body never names it. ESLint cannot
        // see through those calls.
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [selectedId, state]);

    useEffect(() => {
        if (!jointDragPosition) return;
        if (gizmoTargetRef.current) {
            gizmoTargetRef.current.position.set(jointDragPosition.x, jointDragPosition.y, jointDragPosition.z);
        }
    }, [jointDragPosition]);

    const result = findJointAndParent();
    const joint = result?.joint ?? null;
    const owner = result ? { typeId: result.typeId, id: result.id } : null;
    const descriptor = result ? getSupportTypeDescriptor(result.typeId) : null;

    const handleMoveStart = () => {
        if (!joint) return;
        setJointInteractionLock(true);
        dragPosRef.current = new THREE.Vector3(joint.pos.x, joint.pos.y, joint.pos.z);

        // Trunk records its own typed history entry instead.
        if (descriptor && !descriptor.ownsEditHistoryEntry) {
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

        if (owner && descriptor && !descriptor.jointDragMovesContacts) {
            // Trunk keeps a before-snapshot for its own history entry.
            if (descriptor.ownsEditHistoryEntry && !initialTrunkRef.current) {
                initialTrunkRef.current = cloneObj(result!.entity as Trunk);
            }

            const root = descriptor.ownsRoot
                ? state.roots[(result!.entity as { rootId?: string }).rootId ?? '']
                : undefined;

            const next = computeJointDragSupportPreview({
                kind: owner.typeId,
                support: result!.entity as never,
                jointId: joint.id,
                newPos,
                // Only a type with a curve-capable shaft reads the curve mode.
                isCurveMode: descriptor.jointDragCanCurveShaft && isCurveMode,
                root,
                contextStart: resolveShaftAnchor(owner.typeId, { root }) ?? undefined,
            });

            if (livePreviewOf<typeof next>(owner.typeId) !== next) {
                setLivePreview(owner.typeId, next);
                publishJointDragSupportPreview(owner.typeId, next);
            }

            const clamped = getJointPosInSegments((next as { segments: Segment[] }).segments as any[], joint.id);
            if (clamped) gizmoPos = clamped;
        } else if (owner && descriptor?.jointDragMovesContacts) {
            // The contacts follow whichever end moved, and a disk snaps the
            // joint back onto its tip -- which is what moves the gizmo.
            const entity = result!.entity as unknown as { id: string; segments: Segment[] };
            const moved = updateSegmentsJointPos(entity.segments as any[], joint.id, newPos) as Segment[];
            const next = resolveDraggedContacts(owner.typeId, entity, joint.id, moved);

            setLivePreview(owner.typeId, next);
            emitSupportDragPreview(owner.typeId, next.id, next);

            const snapped = getJointPosInSegments(next.segments as any[], joint.id);
            if (snapped) gizmoPos = snapped;
        }

        if (gizmoTargetRef.current) {
            const effectivePos = gizmoPos ?? newPos;
            gizmoTargetRef.current.position.set(effectivePos.x, effectivePos.y, effectivePos.z);
        }
    }, [
        owner?.typeId,
        owner?.id,
        descriptor,
        result,
        isCurveMode,
        joint?.id,
        joint?.pos.x,
        joint?.pos.y,
        joint?.pos.z,
        state.roots,
        updateSegmentsJointPos,
    ]);

    const flushPendingMove = useCallback(() => {
        if (pendingDeltaRef.current.lengthSq() <= MOVE_DELTA_EPS_SQ) return;
        const delta = pendingDeltaRef.current.clone();
        pendingDeltaRef.current.set(0, 0, 0);
        applyMoveDelta(delta);
    }, [applyMoveDelta]);

    const handleMove = (delta: THREE.Vector3) => {
        if (!joint) return;
        // Apply immediately so support geometry stays in lockstep with gizmo.
        // rAF-batching introduces a persistent one-frame lag where the cone
        // appears pseudo-detached from the dragged socket joint.
        pendingDeltaRef.current.add(delta);
        flushPendingMove();
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

        // Trunk records its own typed before/after entry. The action's payload
        // type is per-action, so this one stays typed rather than dispatched:
        // widening `type` would lose the payload check that keeps it honest.
        if (initialTrunkRef.current && owner?.typeId === 'trunk') {
            const committedTrunk = livePreviewOf<Trunk>('trunk')
                ?? getSupportEntity('trunk', owner.id) as Trunk | null;
            if (committedTrunk) {
                const applied = cloneObj(commitJointDragSupport('trunk', committedTrunk));
                if (applied) {
                    pushSupportHistory({
                        type: SUPPORT_UPDATE_TRUNK,
                        description: `Move ${descriptor!.singular} joint`,
                        payload: { before: initialTrunkRef.current, after: applied },
                    });
                }
            }
            initialTrunkRef.current = null;
        }

        // Trunk pushed its own typed entry above; the rest share one. The
        // commit writes the entity back and clears its preview, which is what
        // the twig and stick arms did with two calls of their own.
        if (initialEditSnapshotRef.current && owner) {
            const committed = livePreviewOf<JointDragSupport>(owner.typeId)
                ?? getSupportEntity(owner.typeId, owner.id) as JointDragSupport | null;
            if (committed) commitJointDragSupport(owner.typeId, committed as never);

            pushSupportEditHistory(
                `Move ${getSupportTypeDescriptor(owner.typeId).singular} joint`,
                initialEditSnapshotRef.current,
                captureSupportEditSnapshot(),
            );
            initialEditSnapshotRef.current = null;
        }

        initialBranchRef.current = null;
        livePreviewRef.current = null;
    };

    // Sync gizmo group position to joint.pos, but only when not dragging.
    // Do NOT use a declarative R3F `position` prop on the group — on every React re-render
    // (caused by the deferred useActiveJointDragPreview state update), R3F would re-apply
    // the committed (old) joint position to the Three.js group, overwriting the imperative
    // position.set() from applyMoveDelta and creating a persistent 1-frame cone/ball desync.
    useLayoutEffect(() => {
        if (!gizmoTargetRef.current || !joint) return;
        if (dragPosRef.current !== null) return; // skip during active drag
        gizmoTargetRef.current.position.set(joint.pos.x, joint.pos.y, joint.pos.z);
    }, [joint?.pos.x, joint?.pos.y, joint?.pos.z]);

    if (!joint) return null;

    return (
        <>
            <group ref={gizmoTargetRef as React.MutableRefObject<THREE.Group>} />
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
