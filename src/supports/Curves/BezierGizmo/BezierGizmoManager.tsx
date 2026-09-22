import React, { useSyncExternalStore, useCallback, useMemo, useState, useRef, useEffect } from 'react';
import * as THREE from 'three';
import { subscribe, getSnapshot, getSupportEntity } from '../../state';
import { Trunk, Branch, Twig, Brace, Segment, BezierSegment } from '../../types';
import { BezierHandle } from './BezierHandle';
import { buildGizmoContextIndex, type HandleContext } from './bezierContextIndex';
import { calculateControlPoint } from './utils';
import { useCurveInteractionState, curveInteractionStore } from '../../Curves/curveInteractionState';
import { pushSupportHistory } from '@/supports/history/supportHistory';
import { SUPPORT_UPDATE_TRUNK } from '../../history/actionTypes';
import { captureSupportEditSnapshot, pushSupportEditHistory } from '../../history/supportEditHistory';
import { clearSupportDragPreview, emitSupportDragPreview } from '../../SupportPrimitives/Joint/jointDragRuntime';
import { clearTwigDragPreview, computeTwigDragAttachmentUpdates, emitTwigDragPreview } from '../../SupportTypes/Twig/twigDragPreview';
import { getSupportTypeBySelectionCategory, getSupportTypeDescriptor, parsePrefixedSegmentId, updateSupportEntity, type SupportTypeId } from '../../supportTypeRegistry';

/**
 * Whether the type carries its curve on the entity rather than on segments. A
 * span type has no real segments and selects its span as a segment, so the
 * descriptor answers without naming the type.
 */
function carriesCurveOnEntity(typeId: SupportTypeId | null | undefined): boolean {
    if (!typeId) return false;
    const descriptor = getSupportTypeDescriptor(typeId);
    return !descriptor.hasSegments && descriptor.segmentSelectionPrefix !== undefined;
}

export function BezierGizmoManager() {
    const MIN_CONTROL_POINT_DELTA_SQ = 1e-10;
    const state = useSyncExternalStore(subscribe, getSnapshot);
    const selectedId = state.selectedId;
    const selectedCategory = state.selectedCategory;
    useCurveInteractionState();
    const initialTrunkRef = useRef<Trunk | null>(null);
    const initialEditSnapshotRef = useRef<ReturnType<typeof captureSupportEditSnapshot> | null>(null);

    /** One preview, for whichever support is being reshaped. */
    const livePreviewRef = useRef<{ typeId: SupportTypeId; support: { id: string } } | null>(null);

    const setBezierGizmoInteractionFlags = useCallback((isDragging: boolean, postGuardMs = 180) => {
        if (typeof window === 'undefined') return;

        const w = window as any;
        w.__bezierGizmoDragging = isDragging;
        w.__bezierGizmoGuardUntil = isDragging ? 0 : (Date.now() + postGuardMs);

        window.dispatchEvent(new CustomEvent('bezier-gizmo-interaction-lock', {
            detail: {
                active: isDragging,
                guardUntil: w.__bezierGizmoGuardUntil,
            },
        }));
    }, []);

    const clearLiveSupportPreviews = useCallback(() => {
        const live = livePreviewRef.current;
        if (!live) return;

        clearSupportDragPreview(live.typeId, live.support.id);
        if (getSupportTypeDescriptor(live.typeId).broadcastsAttachmentsWhileDragging) {
            clearTwigDragPreview();
        }
        livePreviewRef.current = null;
    }, []);

    useEffect(() => {
        return () => {
            clearLiveSupportPreviews();
            setBezierGizmoInteractionFlags(false, 0);
        };
    }, [setBezierGizmoInteractionFlags, clearLiveSupportPreviews]);

    const gizmoContextIndex = useMemo(() => buildGizmoContextIndex(state), [state]);

    const contexts = useMemo(() => {
        if (!selectedId) return [] as HandleContext[];

        if (selectedCategory === 'joint') {
            return gizmoContextIndex.jointContextsById.get(selectedId) ?? [];
        }

        // A prefixed segment id names its owning entity, whatever the category
        // says -- the category can lag a selection change.
        const prefixed = parsePrefixedSegmentId(selectedId);
        if (prefixed) {
            return gizmoContextIndex.braceContextsById.get(prefixed.entityId) ?? [];
        }

        if (selectedCategory === 'segment') {
            return gizmoContextIndex.segmentContextsById.get(selectedId) ?? [];
        }

        const selectedDescriptor = getSupportTypeBySelectionCategory(selectedCategory);
        if (selectedDescriptor && carriesCurveOnEntity(selectedDescriptor.id)) {
            return gizmoContextIndex.braceContextsById.get(selectedId) ?? [];
        }

        return [] as HandleContext[];
    }, [selectedId, selectedCategory, gizmoContextIndex]);
    if (contexts.length === 0) return null;

    /**
     * Update Logic
     */
    const handleDragStart = (ctx: HandleContext) => {
        clearLiveSupportPreviews();
        curveInteractionStore.setIsDraggingHandle(true);
        setBezierGizmoInteractionFlags(true);
        // Snapshot for history
        // Trunks keep their own before/after history entry; every other type is
        // covered by the whole-store edit snapshot below.
        if (ctx.typeId && getSupportTypeDescriptor(ctx.typeId).ownsEditHistoryEntry) {
            initialTrunkRef.current = JSON.parse(JSON.stringify(ctx.entity));
        } else if (ctx.typeId) {
            initialEditSnapshotRef.current = captureSupportEditSnapshot();
        }
    };

    const handleDragEnd = (ctx: HandleContext) => {
        curveInteractionStore.setIsDraggingHandle(false);
        setBezierGizmoInteractionFlags(false);
        // Prevent canvas click (deselect)
        (window as any).__gizmoDragEndedThisFrame = true;

        // A type recording its own before/after entry. The action's payload type
        // is per-action, so this stays typed rather than dispatched.
        if (initialTrunkRef.current && ctx.entity && ctx.typeId
            && getSupportTypeDescriptor(ctx.typeId).ownsEditHistoryEntry) {
            // The type is the handle's own, asked of the registry: which type
            // records its own entry, what it is called and which collection it
            // lives in are all declared there.
            const ownEntryDescriptor = getSupportTypeDescriptor(ctx.typeId);
            const latestTrunk = (livePreviewRef.current?.support as Trunk | undefined)
                ?? getSupportEntity(ctx.entity.id);
            if (latestTrunk) {
                // Final exact reconciliation after drag-time fast-path updates.
                updateSupportEntity(latestTrunk);
                pushSupportHistory({
                    type: SUPPORT_UPDATE_TRUNK,
                    description: `Edit ${ownEntryDescriptor.singular} curve`,
                    payload: {
                        before: initialTrunkRef.current,
                        after: JSON.parse(JSON.stringify(latestTrunk)),
                    },
                });
            }
            clearSupportDragPreview(ctx.typeId, ctx.entity.id);
            livePreviewRef.current = null;
            initialTrunkRef.current = null;
        }

        // One path for every type that does not record its own history: commit the
        // preview, clear it, record one entry. A type that writes its own entry
        // above would otherwise get two.
        if (initialEditSnapshotRef.current && ctx.typeId
            && !getSupportTypeDescriptor(ctx.typeId).ownsEditHistoryEntry) {
            const typeId = ctx.typeId;
            const descriptor = getSupportTypeDescriptor(typeId);
            const draggedId = ctx.entity?.id;
            const preview = livePreviewRef.current?.typeId === typeId
                ? livePreviewRef.current.support
                : null;

            if (preview) {
                updateSupportEntity(typeId, preview);
            } else if (draggedId && descriptor.curveDragReconcilesFromStore) {
                // The segments another interaction updated mid-drag (the
                // elastic chain on a knot drag) are re-read from the store.
                const latest = getSupportEntity(typeId, draggedId);
                if (latest) updateSupportEntity(typeId, latest);
            }

            if (draggedId) clearSupportDragPreview(typeId, draggedId);
            if (descriptor.broadcastsAttachmentsWhileDragging) clearTwigDragPreview();
            livePreviewRef.current = null;

            pushSupportEditHistory(
                `Edit ${descriptor.singular} curve`,
                initialEditSnapshotRef.current,
                captureSupportEditSnapshot(),
            );
            initialEditSnapshotRef.current = null;
        }

        clearLiveSupportPreviews();
    };

    const handleDrag = (ctx: HandleContext, newPos: THREE.Vector3) => {
        const { entity, typeId, joint, incomingIndex, outgoingIndex, activeHandle } = ctx;
        const descriptor = typeId ? getSupportTypeDescriptor(typeId) : null;
        const jointPos = new THREE.Vector3(joint.pos.x, joint.pos.y, joint.pos.z);

        const controlPointUnchanged = (
            cp: { x: number; y: number; z: number } | undefined,
            point: THREE.Vector3,
        ) => {
            if (!cp) return false;
            const dx = cp.x - point.x;
            const dy = cp.y - point.y;
            const dz = cp.z - point.z;
            return (dx * dx + dy * dy + dz * dz) <= MIN_CONTROL_POINT_DELTA_SQ;
        };

        if (carriesCurveOnEntity(typeId)) {
            const brace = entity as unknown as Brace | undefined;
            if (!brace?.curve || brace.curve.type !== 'bezier') return;
            const newBrace = JSON.parse(JSON.stringify(brace)) as Brace;

            const curve = newBrace.curve;
            if (!curve || curve.type !== 'bezier') return;

            // Calculate Vector from Joint -> New Handle Pos
            const handleVec = newPos.clone().sub(jointPos);
            const length = handleVec.length();
            if (length < 0.001) return;
            const direction = handleVec.clone().normalize();

            if (activeHandle === 'outgoing') {
                curve.startTangent = { x: direction.x, y: direction.y, z: direction.z };
                curve.controlPoint1 = { x: newPos.x, y: newPos.y, z: newPos.z };
            } else {
                const tangent = direction.clone().negate();
                curve.endTangent = { x: tangent.x, y: tangent.y, z: tangent.z };
                curve.controlPoint2 = { x: newPos.x, y: newPos.y, z: newPos.z };
            }

            updateSupportEntity(typeId!, newBrace);
            return;
        }

        // Every shafted type reshapes the same way; brace returned above.
        const parent = entity;
        if (!parent) return;

        // Clone to mutate
        const newParent = JSON.parse(JSON.stringify(parent));
        const newSegments = newParent.segments;

        // Calculate Vector from Joint -> New Handle Pos
        const handleVec = newPos.clone().sub(jointPos);
        const length = handleVec.length();
        if (length < 0.001) return;

        const direction = handleVec.clone().normalize();

        if (activeHandle === 'outgoing') {
             // Outgoing Segment (Above Joint) -> Controls startTangent
             const targetSeg = newSegments[outgoingIndex] as BezierSegment;
             if (!targetSeg || targetSeg.type !== 'bezier') return;

               if (controlPointUnchanged(targetSeg.controlPoint1, newPos)) return;

             targetSeg.startTangent = { x: direction.x, y: direction.y, z: direction.z };
             targetSeg.controlPoint1 = { x: newPos.x, y: newPos.y, z: newPos.z };

             // Seesaw Logic (Update Incoming)
             if (newSegments[incomingIndex]?.type === 'bezier') {
                 const otherSeg = newSegments[incomingIndex] as BezierSegment;
                 const otherDir = direction.clone().negate();
                 
                 otherSeg.endTangent = { x: otherDir.x, y: otherDir.y, z: otherDir.z };
                 if (otherSeg.controlPoint2) {
                     const otherCP = new THREE.Vector3(otherSeg.controlPoint2.x, otherSeg.controlPoint2.y, otherSeg.controlPoint2.z);
                     const otherLen = otherCP.distanceTo(jointPos);
                     const newOtherCP = jointPos.clone().add(otherDir.multiplyScalar(otherLen));
                     otherSeg.controlPoint2 = { x: newOtherCP.x, y: newOtherCP.y, z: newOtherCP.z };
                 }
             }

        } else {
             // Incoming Segment (Below Joint) -> Controls endTangent
             // Tangent = -HandleVector
             const targetSeg = newSegments[incomingIndex] as BezierSegment;
             if (!targetSeg || targetSeg.type !== 'bezier') return;

               if (controlPointUnchanged(targetSeg.controlPoint2, newPos)) return;
             
             const tangent = direction.clone().negate();
             targetSeg.endTangent = { x: tangent.x, y: tangent.y, z: tangent.z };
             targetSeg.controlPoint2 = { x: newPos.x, y: newPos.y, z: newPos.z };

             // Seesaw Logic (Update Outgoing)
             if (newSegments[outgoingIndex]?.type === 'bezier') {
                 const otherSeg = newSegments[outgoingIndex] as BezierSegment;
                 const otherDir = direction.clone().negate(); 
                 
                 otherSeg.startTangent = { x: otherDir.x, y: otherDir.y, z: otherDir.z };
                 if (otherSeg.controlPoint1) {
                     const otherCP = new THREE.Vector3(otherSeg.controlPoint1.x, otherSeg.controlPoint1.y, otherSeg.controlPoint1.z);
                     const otherLen = otherCP.distanceTo(jointPos);
                     const newOtherCP = jointPos.clone().add(otherDir.multiplyScalar(otherLen));
                     otherSeg.controlPoint1 = { x: newOtherCP.x, y: newOtherCP.y, z: newOtherCP.z };
                 }
             }
        }

        if (!typeId || !descriptor) return;

        const preview = newParent as { id: string; segments: Segment[] };
        livePreviewRef.current = { typeId, support: preview };
        emitSupportDragPreview(typeId, preview.id, preview);

        // Knots ride this shaft and leaves hang off those, so they follow the
        // curve live rather than jumping to it on release.
        if (descriptor.broadcastsAttachmentsWhileDragging) {
            const previewTwig = newParent as Twig;
            const snap = getSnapshot();
            const segmentIdSet = new Set<string>(previewTwig.segments.map(s => s.id));
            const attachedKnots = Object.values(snap.knots).filter(k => segmentIdSet.has(k.parentShaftId));
            const leavesByParentKnotId = new Map<string, typeof snap.leaves[string][]>();
            for (const leaf of Object.values(snap.leaves)) {
                const list = leavesByParentKnotId.get(leaf.parentKnotId);
                if (list) list.push(leaf);
                else leavesByParentKnotId.set(leaf.parentKnotId, [leaf]);
            }
            const { knotsById, leavesById } = computeTwigDragAttachmentUpdates(
                previewTwig,
                attachedKnots,
                leavesByParentKnotId,
            );
            emitTwigDragPreview({
                twigId: previewTwig.id,
                twig: previewTwig,
                knotsById,
                leavesById,
            });
        }
    };

    // Render each context handle
    return (
        <group>
            {contexts.map(ctx => {
                const jointPos = new THREE.Vector3(ctx.joint.pos.x, ctx.joint.pos.y, ctx.joint.pos.z);
                let cpPos: THREE.Vector3 | null = null;
                // A type with no segments carries its curve on the entity.
                const entityCurve = carriesCurveOnEntity(ctx.typeId)
                    ? (ctx.entity as unknown as Brace | undefined)?.curve
                    : undefined;

                if (ctx.activeHandle === 'outgoing') {
                    if (entityCurve?.type === 'bezier') {
                        cpPos = new THREE.Vector3(entityCurve.controlPoint1.x, entityCurve.controlPoint1.y, entityCurve.controlPoint1.z);
                    } else if (ctx.outgoingSegment?.type === 'bezier') {
                        const seg = ctx.outgoingSegment as BezierSegment;
                        if (seg.controlPoint1) {
                            cpPos = new THREE.Vector3(seg.controlPoint1.x, seg.controlPoint1.y, seg.controlPoint1.z);
                        } else {
                            const t = new THREE.Vector3(seg.startTangent.x, seg.startTangent.y, seg.startTangent.z);
                            cpPos = jointPos.clone().add(t.multiplyScalar(7));
                        }
                    }
                } else {
                    if (entityCurve?.type === 'bezier') {
                        cpPos = new THREE.Vector3(entityCurve.controlPoint2.x, entityCurve.controlPoint2.y, entityCurve.controlPoint2.z);
                    } else if (ctx.incomingSegment?.type === 'bezier') {
                        const seg = ctx.incomingSegment as BezierSegment;
                        if (seg.controlPoint2) {
                            cpPos = new THREE.Vector3(seg.controlPoint2.x, seg.controlPoint2.y, seg.controlPoint2.z);
                        } else {
                            const t = new THREE.Vector3(seg.endTangent.x, seg.endTangent.y, seg.endTangent.z);
                            cpPos = jointPos.clone().sub(t.multiplyScalar(7));
                        }
                    }
                }

                if (!cpPos) return null;

                return (
                    <BezierHandle
                        key={ctx.id}
                        position={cpPos}
                        jointPosition={jointPos}
                        onDragStart={() => handleDragStart(ctx)}
                        onDrag={(newPos) => handleDrag(ctx, newPos)}
                        onDragEnd={() => handleDragEnd(ctx)}
                    />
                );
            })}
        </group>
    );
}
