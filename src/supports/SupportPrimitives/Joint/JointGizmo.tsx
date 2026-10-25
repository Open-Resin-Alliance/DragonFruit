import React, { useSyncExternalStore, useCallback, useRef, useEffect, useLayoutEffect } from 'react';
import { ScreenSpaceGizmo } from '@/components/gizmo/ScreenSpaceGizmo';
import { subscribe, getSnapshot, findShaftOwnerOfJoint, getSupportEntity, resolveDeclaredHosts } from '../../state';
import { getSupportTypeDescriptor, updateSupportEntity, type SupportTypeId } from '../../supportTypeRegistry';
import * as THREE from 'three';
import { pushSupportHistory } from '@/supports/history/supportHistory';
import { captureSupportEditSnapshot, pushSupportEditHistory } from '../../history/supportEditHistory';
import { useCurveInteractionState } from '../../Curves/curveInteractionState';
import { calculateDiskThickness } from '../ContactDisk/contactDiskUtils';
import { Trunk, Twig, Joint, Segment } from '../../types';
import type { Kickstand } from '../../SupportTypes/Kickstand/types';
import { useJointDragPosition } from '../../interaction/jointDragPosition';
import { clearSupportDragPreview, emitSupportDragPreview, setJointInteractionLock } from './jointDragRuntime';
import { commitJointDragSupport, computeJointDragSupportPreview, publishJointDragSupportPreview, type JointDragSupport } from './jointDragController';
import { resolveShaftAnchor } from '../Knot/segmentEndpoints';
import { resolveDraggedContacts } from './resolveDraggedContacts';
import { moveJointLabel } from '@/supports/history/supportHistoryLabels';
import { useFrame } from '@react-three/fiber';
import { SUPPORT_INSTANCED_DRAG } from '../../instanced/flags';
import { findJointDragBinding } from '../../instanced/dragSlots';
import {
    beginJointDrag,
    clearJointDragSession,
    clearJointDragSessionAfterFrame,
    endJointDrag,
    getJointDragSession,
    getLastJointDragPreview,
    writeJointDragFrame,
    type JointDragSceneContext,
    type JointDragSlotEntity,
} from '../../instanced/instanceDragWriter';
import { suppressPrimitivesForJointDrag } from '../../instanced/dragSuppression';

export function JointGizmo({
    sceneRef,
}: {
    /** The scene values a joint drag needs; see `JointDragSceneContext`. */
    sceneRef?: React.MutableRefObject<JointDragSceneContext | null>;
} = {}) {
    const MOVE_DELTA_EPS_SQ = 1e-12;
    const state = useSyncExternalStore(subscribe, getSnapshot);
    const selectedId = state.selectedId;
    /** The entity before a drag, for a type that owns its own history entry. */
    const initialOwnHistoryRef = useRef<Trunk | null>(null);
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
    /** Whether this gizmo gesture draws through the instanced drag batch. */
    const instancedDragRef = useRef(false);

    const cloneObj = <T,>(obj: T | null | undefined): T | null => obj ? JSON.parse(JSON.stringify(obj)) : null;

    useEffect(() => {
        return () => {
            if (typeof window === 'undefined') return;
            if (moveRafRef.current !== null) {
                window.cancelAnimationFrame(moveRafRef.current);
                moveRafRef.current = null;
            }
            // A gizmo unmounting mid-gesture is a dead gesture: no instance and
            // no hidden primitive may survive it.
            if (instancedDragRef.current) {
                instancedDragRef.current = false;
                endJointDrag();
                clearJointDragSession();
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
        instancedDragRef.current = false;

        // A bezier (curve mode) or a type whose contacts are disks returns null
        // here and keeps the legacy preview: `isInstanceableJointDrag` decides.
        if (SUPPORT_INSTANCED_DRAG && owner && descriptor && result) {
            const segments = (result.entity as { segments?: Segment[] }).segments ?? [];
            const binding = findJointDragBinding(segments, joint.id);
            const scene = sceneRef?.current ?? null;
            if (binding) {
                const entityRecord = result.entity as unknown as Record<string, unknown>;
                const declaredHosts = resolveDeclaredHosts(owner.typeId, entityRecord);
                const modelId = typeof entityRecord.modelId === 'string' ? entityRecord.modelId : undefined;
                const slotMap = beginJointDrag({
                    entity: result.entity as unknown as JointDragSlotEntity,
                    binding,
                    hosts: {
                        root: descriptor.ownsRoot ? declaredHosts.root : undefined,
                        hostKnot: descriptor.lower.kind === 'knot' ? declaredHosts.hostKnot : undefined,
                    },
                    hostKnots: scene?.hostKnots ?? [],
                    sharedJointSlotById: scene?.sharedJointSlotById ?? null,
                    dropOffsetZ: scene?.dropOffsetZFor?.(modelId) ?? 0,
                });
                if (slotMap) {
                    suppressPrimitivesForJointDrag(slotMap);
                    instancedDragRef.current = true;
                }
            }
        }

        // Trunk records its own typed history entry instead.
        if (descriptor && !descriptor.ownsEditHistoryEntry) {
            initialEditSnapshotRef.current = captureSupportEditSnapshot();
        }
    };

    /**
     * One instanced frame, or a clean drop back to the detail path when a reset
     * or a cancel released the session between moves.
     */
    const writeInstancedFrame = (entity: unknown) => {
        const session = getJointDragSession();
        if (!session || session.ended) {
            instancedDragRef.current = false;
            return;
        }
        writeJointDragFrame(entity as JointDragSlotEntity);
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
            // A type that owns its history entry keeps its own before-snapshot.
            if (descriptor.ownsEditHistoryEntry && !initialOwnHistoryRef.current) {
                initialOwnHistoryRef.current = cloneObj(result!.entity as Trunk);
            }

            // The pair the declared lower endpoint resolves from, so the field
            // each host lives in is not restated here.
            const declaredHosts = resolveDeclaredHosts(owner.typeId, result!.entity as unknown as Record<string, unknown>);
            const root = descriptor.ownsRoot ? declaredHosts.root : undefined;

            const next = computeJointDragSupportPreview({
                kind: owner.typeId,
                support: result!.entity as never,
                jointId: joint.id,
                newPos,
                // Only a type with a curve-capable shaft reads the curve mode.
                isCurveMode: descriptor.jointDragCanCurveShaft && isCurveMode,
                root,
                contextStart: resolveShaftAnchor(owner.typeId, { root, hostKnot: declaredHosts.hostKnot }) ?? undefined,
            });

            if (instancedDragRef.current) {
                // The batch draws it; no preview event, no React commit. The
                // gizmo's own position stays imperative below.
                writeInstancedFrame(next);
            } else if (livePreviewOf<typeof next>(owner.typeId) !== next) {
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

            if (instancedDragRef.current) {
                writeInstancedFrame(next);
            } else {
                setLivePreview(owner.typeId, next);
                emitSupportDragPreview(owner.typeId, next.id, next);
            }

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

        /**
         * What this release commits. The fast path never published a preview, so
         * the last frame the batch drew IS the entity to commit — reading the
         * live preview ref would commit the pre-drag entity.
         */
        const instancedPreview = instancedDragRef.current
            ? getLastJointDragPreview<JointDragSupport>()
            : null;
        if (instancedDragRef.current) {
            // The final frame is the one `flushPendingMove` just wrote; end the
            // gesture, then write the store in this same handler.
            endJointDrag();
            instancedDragRef.current = false;
        }

        // A type that owns its history entry records a TYPED before/after entry.
        // The action's payload type is per-action, so this one stays typed rather
        // than dispatched; the action comes off the descriptor that declares it.
        if (initialOwnHistoryRef.current && owner
            && descriptor!.ownsEditHistoryEntry && descriptor!.historyUpdate) {
            const committed = instancedPreview
                ?? livePreviewOf<JointDragSupport>(owner.typeId)
                ?? getSupportEntity(owner.typeId, owner.id) as JointDragSupport | null;
            if (committed) {
                const applied = cloneObj(commitJointDragSupport(owner.typeId, committed as never));
                if (applied) {
                    pushSupportHistory({
                        type: descriptor!.historyUpdate,
                        description: moveJointLabel(descriptor!.id),
                        // The payload cast keeps the per-action payload map the
                        // single source of truth, as the delete path does: the
                        // action is the type's own, chosen at runtime.
                        payload: { before: initialOwnHistoryRef.current, after: applied } as never,
                    });
                }
            }
            initialOwnHistoryRef.current = null;
        }

        // Trunk pushed its own typed entry above; the rest share one. The
        // commit writes the entity back and clears its preview, which is what
        // the twig and stick arms did with two calls of their own.
        if (initialEditSnapshotRef.current && owner) {
            const committed = instancedPreview
                ?? livePreviewOf<JointDragSupport>(owner.typeId)
                ?? getSupportEntity(owner.typeId, owner.id) as JointDragSupport | null;
            if (committed) commitJointDragSupport(owner.typeId, committed as never);

            pushSupportEditHistory(
                moveJointLabel(owner.typeId),
                initialEditSnapshotRef.current,
                captureSupportEditSnapshot(),
            );
            initialEditSnapshotRef.current = null;
        }

        livePreviewRef.current = null;
        // The suppression clear and the store write above are one commit; the
        // session itself goes one frame later, after that commit has painted.
        if (instancedPreview) clearJointDragSessionAfterFrame();
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

    /**
     * A joint-ball drag no longer publishes a position event in the fast path, so
     * the gizmo follows the batch's own last frame instead: one imperative write
     * per frame, no React state. The gizmo's own gesture is excluded — it sets
     * the position directly in `applyMoveDelta`.
     */
    useFrame(() => {
        if (!SUPPORT_INSTANCED_DRAG) return;
        if (dragPosRef.current !== null) return;
        if (!gizmoTargetRef.current) return;
        const session = getJointDragSession();
        if (!session || session.ended) return;
        const preview = getLastJointDragPreview<{ segments: Segment[] }>();
        if (!preview) return;
        const pos = getJointPosInSegments(preview.segments, session.slotMap.jointId);
        if (pos) gizmoTargetRef.current.position.set(pos.x, pos.y, pos.z);
    });

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
