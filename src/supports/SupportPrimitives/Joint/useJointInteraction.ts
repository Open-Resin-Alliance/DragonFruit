import { resolveSegmentEndpoints, resolveShaftAnchor, type ShaftEntity } from '../Knot/segmentEndpoints';
import { resolveDraggedContacts } from './resolveDraggedContacts';
import { useEffect, useRef, useCallback } from 'react';
import * as THREE from 'three';
import { useThree, useFrame } from '@react-three/fiber';
import { usePicking } from '@/components/picking';
import { findShaftOwnerOfJoint, getSupportEntity, jointPosIn, getSelectedId, resolveDeclaredHosts, setInteractionWarning } from '../../state';
import { getSupportTypeDescriptor, updateSupportEntity, type SupportTypeId } from '../../supportTypeRegistry';
import { Vec3, Trunk, Branch, Roots, Segment, Twig, ContactDisk } from '../../types';
import type { Kickstand } from '../../SupportTypes/Kickstand/types';
import { pushSupportHistory } from '@/supports/history/supportHistory';
import { captureSupportEditSnapshot, pushSupportEditHistory } from '../../history/supportEditHistory';
import { calculateDiskThickness } from '../ContactDisk/contactDiskUtils';
import {
    clearJointDragPositionPreview,
    clearSupportDragPreview,
    emitJointDragPositionPreview,
    emitSupportDragPreview,
    isJointInteractionLocked,
    setJointInteractionLock,
} from './jointDragRuntime';
import { commitJointDragSupport, computeJointDragSupportPreview, JOINT_DRAG_COMMIT_TYPES, JOINT_DRAG_HOSTED_SHAFT_TYPES, publishJointDragSupportPreview, shouldCommitJointDrag } from './jointDragController';
import { subscribeSupportInteractionReset } from '../../interaction/supportInteractionReset';
import { setPickRayFromCamera } from '@/components/scene/camera/pickRay';

/**
 * Hook to handle joint interaction (dragging/moving).
 * Must be used inside a Canvas/R3F context.
 * 
 * Usage: Call this hook once in your main scene component (e.g. SupportRenderer).
 * It monitors the picking state and handles drag operations for any 'joint' object.
 */
export function useJointInteraction(enabled: boolean = true) {
    const MIN_DRAG_DELTA_SQ = 1e-6; // ~0.001mm positional epsilon to drop high-frequency jitter churn
    const MIN_PUBLISHED_CLAMPED_DELTA_SQ = 1e-8;
    const DRAG_SNAP_MM = 0.001;
    const WARNING_DISTANCE_THRESHOLD = 0.05; // mm
    const WARNING_EVAL_INTERVAL_MS = 48; // ~20Hz warning updates during drag
    const JOINT_PARENT_CACHE_MAX_ENTRIES = 12000;

    const { isDragging, hit } = usePicking();
    const { camera, raycaster, pointer, controls } = useThree();

    const activeJointId = useRef<string | null>(null);
    /** The support whose joint is being dragged. One slot, not one ref per type. */
    const activeSupport = useRef<{ typeId: SupportTypeId; id: string } | null>(null);
    const dragPlane = useRef<THREE.Plane>(new THREE.Plane());
    const dragOffset = useRef<THREE.Vector3>(new THREE.Vector3());
    const planeIntersectionRef = useRef<THREE.Vector3>(new THREE.Vector3());
    const lastDragPos = useRef<Vec3 | null>(null);
    /** Where the joint sat when the drag began, to tell a drag from a click. */
    const dragStartJointPos = useRef<Vec3 | null>(null);
    const forceEndDragRef = useRef(false);
    /** The entity as it was before a drag, for a type that owns its history entry. */
    const initialOwnHistorySnapshot = useRef<Trunk | null>(null);
    const initialEditSnapshotRef = useRef<ReturnType<typeof captureSupportEditSnapshot> | null>(null);
    const lastAppliedDragPosRef = useRef<THREE.Vector3 | null>(null);
    // One preview for whichever support is being dragged; `activeSupport` says
    // which type it is.
    const livePreviewRef = useRef<{ typeId: SupportTypeId; support: unknown } | null>(null);
    const livePreviewOf = <T,>(typeId: SupportTypeId): T | null => {
        const live = livePreviewRef.current;
        return live?.typeId === typeId ? live.support as T : null;
    };
    /** Records a preview under the type currently being dragged. */
    const setLivePreview = (support: unknown) => {
        const typeId = activeSupport.current?.typeId;
        if (typeId) livePreviewRef.current = { typeId, support };
    };
    const lastResolvedJointPosRef = useRef<Vec3 | null>(null);
    const lastPublishedClampedJointPosRef = useRef<Vec3 | null>(null);
    const lastWarningRef = useRef<string | null>(null);
    const lastWarningEvalAtRef = useRef(0);
    const jointParentCacheRef = useRef<Map<string, { kind: SupportTypeId; supportId: string }>>(new Map());
    const activeJointBindingRef = useRef<{ jointId: string; segmentIndex: number; jointKey: 'topJoint' | 'bottomJoint' } | null>(null);
    const jointDragUpdatePendingRef = useRef(false);
    const jointDragListenersAttachedRef = useRef(false);
    const activeConstraintRootRef = useRef<Roots | undefined>(undefined);
    const activeConstraintStartRef = useRef<Vec3 | undefined>(undefined);
    const dragGestureSelectionAtStartRef = useRef<string | null>(null);
    const wasDraggingRef = useRef(false);
    const lastEmittedPreviewJointPosRef = useRef<Vec3 | null>(null);

    const savedControlsEnabledRef = useRef<boolean | null>(null);

    const cloneTrunk = (trunk: Trunk): Trunk => JSON.parse(JSON.stringify(trunk));

    const updateSegmentsJointPos = useCallback((segments: any[], jointId: string, pos: Vec3) => {
        return segments.map((seg) => {
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

    const applyInteractionWarning = useCallback((warning: 'SHAFT_ANGLE_TOO_FLAT' | null) => {
        if (lastWarningRef.current === warning) return;
        lastWarningRef.current = warning;
        setInteractionWarning(warning);
    }, []);

    const resolveJointBinding = useCallback((
        segments: Array<{ topJoint?: { id: string; pos: Vec3 }; bottomJoint?: { id: string; pos: Vec3 } }>,
        targetJointId: string,
    ) => {
        for (let index = 0; index < segments.length; index += 1) {
            const segment = segments[index];
            if (segment.topJoint?.id === targetJointId) {
                return { jointId: targetJointId, segmentIndex: index, jointKey: 'topJoint' as const };
            }
            if (segment.bottomJoint?.id === targetJointId) {
                return { jointId: targetJointId, segmentIndex: index, jointKey: 'bottomJoint' as const };
            }
        }
        return null;
    }, []);

    const resolveJointPosById = useCallback((
        segments: Array<{ topJoint?: { id: string; pos: Vec3 }; bottomJoint?: { id: string; pos: Vec3 } }>,
        jointId: string,
    ): Vec3 | null => {
        const binding = activeJointBindingRef.current;
        if (binding && binding.jointId === jointId) {
            const segment = segments[binding.segmentIndex];
            const fastJoint = segment?.[binding.jointKey];
            if (fastJoint?.id === jointId) {
                return fastJoint.pos;
            }
        }

        const nextBinding = resolveJointBinding(segments, jointId);
        if (!nextBinding) {
            activeJointBindingRef.current = null;
            return null;
        }

        activeJointBindingRef.current = nextBinding;
        const segment = segments[nextBinding.segmentIndex];
        return segment?.[nextBinding.jointKey]?.pos ?? null;
    }, [resolveJointBinding]);

    /**
     * Whether the support just computed is the one already on screen, so it need
     * not be published again.
     *
     * Where the answer comes from is declared: a type that seeds and reads a live
     * preview compares against it, and one that does not compares against the
     * committed entity the store still holds.
     */
    const previewAlreadyShown = (typeId: SupportTypeId, id: string, next: unknown): boolean =>
        getSupportTypeDescriptor(typeId).jointDragUsesLivePreview
            ? livePreviewOf(typeId) === next
            : getSupportEntity(typeId, id) === next;

    const shouldPublishForClampedPos = useCallback((clampedPos: Vec3 | null) => {
        if (!clampedPos) return true;
        const prev = lastPublishedClampedJointPosRef.current;
        if (!prev) return true;

        const dx = clampedPos.x - prev.x;
        const dy = clampedPos.y - prev.y;
        const dz = clampedPos.z - prev.z;
        return (dx * dx + dy * dy + dz * dz) >= MIN_PUBLISHED_CLAMPED_DELTA_SQ;
    }, [MIN_PUBLISHED_CLAMPED_DELTA_SQ]);

    const markPublishedClampedPos = useCallback((clampedPos: Vec3 | null) => {
        if (!clampedPos) {
            lastPublishedClampedJointPosRef.current = null;
            return;
        }
        lastPublishedClampedJointPosRef.current = { x: clampedPos.x, y: clampedPos.y, z: clampedPos.z };
    }, []);

    const markJointDragUpdatePending = useCallback(() => {
        if (!activeJointId.current) return;
        jointDragUpdatePendingRef.current = true;
    }, []);

    const applyWarningForDragDelta = useCallback((clampedPos: Vec3 | null, rawPos: Vec3) => {
        if (!clampedPos) return;
        const now = performance.now();
        if (now - lastWarningEvalAtRef.current < WARNING_EVAL_INTERVAL_MS) return;
        lastWarningEvalAtRef.current = now;

        const dx = clampedPos.x - rawPos.x;
        const dy = clampedPos.y - rawPos.y;
        const dz = clampedPos.z - rawPos.z;
        const dist = Math.sqrt(dx * dx + dy * dy + dz * dz);
        if (dist > WARNING_DISTANCE_THRESHOLD) {
            applyInteractionWarning('SHAFT_ANGLE_TOO_FLAT');
        } else {
            applyInteractionWarning(null);
        }
    }, [WARNING_DISTANCE_THRESHOLD, WARNING_EVAL_INTERVAL_MS, applyInteractionWarning]);

    const hardResetInteractionSession = useCallback(() => {
        const activeJointIdAtReset = activeJointId.current;
        if (activeJointIdAtReset) {
            clearJointDragPositionPreview(activeJointIdAtReset);
        }

        if (activeSupport.current) {
            clearSupportDragPreview(activeSupport.current.typeId, activeSupport.current.id);
        }

        activeJointId.current = null;
        activeSupport.current = null;
        initialOwnHistorySnapshot.current = null;
        initialEditSnapshotRef.current = null;
        livePreviewRef.current = null;
        forceEndDragRef.current = false;
        lastAppliedDragPosRef.current = null;
        lastResolvedJointPosRef.current = null;
        lastPublishedClampedJointPosRef.current = null;
        lastWarningEvalAtRef.current = 0;
        activeConstraintRootRef.current = undefined;
        activeConstraintStartRef.current = undefined;
        activeJointBindingRef.current = null;
        lastDragPos.current = null;
        dragStartJointPos.current = null;
        lastEmittedPreviewJointPosRef.current = null;
        applyInteractionWarning(null);

        if (controls && savedControlsEnabledRef.current !== null) {
            const c: any = controls;
            c.enabled = savedControlsEnabledRef.current;
            savedControlsEnabledRef.current = null;
        }

        setJointInteractionLock(false, 0);
    }, [controls, applyInteractionWarning]);

    useEffect(() => {
        if (!enabled) return;
        if (isDragging || activeJointId.current) return;
        if (hit.category !== 'joint' || !hit.objectId) return;

        if (jointParentCacheRef.current.size > JOINT_PARENT_CACHE_MAX_ENTRIES) {
            jointParentCacheRef.current.clear();
        }

        const jointId = hit.objectId;
        if (jointParentCacheRef.current.has(jointId)) return;

        const owner = findShaftOwnerOfJoint(jointId);
        if (owner) jointParentCacheRef.current.set(jointId, { kind: owner.typeId, supportId: owner.id });
    }, [enabled, isDragging, hit.category, hit.objectId, JOINT_PARENT_CACHE_MAX_ENTRIES]);

    useEffect(() => {
        return () => {
            hardResetInteractionSession();
        };
    }, [hardResetInteractionSession]);

    useEffect(() => {
        return subscribeSupportInteractionReset(() => {
            jointParentCacheRef.current.clear();
            hardResetInteractionSession();
        });
    }, [hardResetInteractionSession]);

    useEffect(() => {
        if (typeof window === 'undefined') return;

        const markForceEndDrag = () => {
            if (!activeJointId.current) return;
            forceEndDragRef.current = true;
        };

        const handleVisibilityChange = () => {
            if (document.visibilityState === 'hidden') {
                markForceEndDrag();
            }
        };

        window.addEventListener('pointerup', markForceEndDrag, true);
        window.addEventListener('pointercancel', markForceEndDrag, true);
        window.addEventListener('mouseup', markForceEndDrag, true);
        window.addEventListener('blur', markForceEndDrag);
        document.addEventListener('visibilitychange', handleVisibilityChange);

        return () => {
            window.removeEventListener('pointerup', markForceEndDrag, true);
            window.removeEventListener('pointercancel', markForceEndDrag, true);
            window.removeEventListener('mouseup', markForceEndDrag, true);
            window.removeEventListener('blur', markForceEndDrag);
            document.removeEventListener('visibilitychange', handleVisibilityChange);
        };
    }, []);

    useEffect(() => {
        if (isDragging && !wasDraggingRef.current) {
            // Snapshot selection at pointer-drag gesture start to avoid
            // select-and-drag races starting a joint drag in the same gesture.
            dragGestureSelectionAtStartRef.current = getSelectedId();
        } else if (!isDragging) {
            dragGestureSelectionAtStartRef.current = null;
        }

        wasDraggingRef.current = isDragging;
    }, [isDragging]);

    // Monitor drag state
    useEffect(() => {
        if (!enabled && !activeJointId.current) return;

        // Start Drag
        if (enabled && !isJointInteractionLocked() && isDragging && hit.category === 'joint' && hit.objectId && !activeJointId.current) {
            const jointId = hit.objectId;

            // Find trunk/branch and joint
            // One derived lookup, cache-first. The downstream still needs the
            // entity by type, so it is unpacked into the same locals as before.
            const cached = jointParentCacheRef.current.get(jointId);
            let owner = cached
                ? (() => {
                    const entity = getSupportEntity(cached.kind, cached.supportId) as { segments?: Segment[] } | null;
                    const pos = entity ? jointPosIn(entity.segments ?? [], jointId) : null;
                    if (entity && pos) return { typeId: cached.kind, id: cached.supportId, pos };
                    jointParentCacheRef.current.delete(jointId);
                    return null;
                })()
                : null;

            if (!owner) {
                owner = findShaftOwnerOfJoint(jointId);
                if (owner) jointParentCacheRef.current.set(jointId, { kind: owner.typeId, supportId: owner.id });
            }

            // Only shafted types reach here: findShaftOwnerOfJoint searches
            // segments, and the owner names its own type.
            const foundParent = owner
                ? getSupportEntity(owner.typeId, owner.id) as { id: string; segments: Segment[] } | null
                : null;
            const foundJointPos = owner?.pos ?? null;

            if (owner && foundParent && foundJointPos) {
                // Check if interaction is allowed: parent or joint itself must be selected
                const selectedId = getSelectedId();
                const isAllowed = selectedId === foundParent.id || selectedId === jointId;

                if (!isAllowed) return;

                // If this gesture began before the parent/joint was selected,
                // skip drag activation and require the next gesture.
                const selectionAtDragStart = dragGestureSelectionAtStartRef.current;
                const hadEligibleSelectionAtGestureStart = selectionAtDragStart === foundParent.id || selectionAtDragStart === jointId;
                if (!hadEligibleSelectionAtGestureStart) return;

                activeJointId.current = jointId;
                setJointInteractionLock(true);
                jointDragUpdatePendingRef.current = true;
                if (!jointDragListenersAttachedRef.current) {
                    window.addEventListener('pointermove', markJointDragUpdatePending, true);
                    jointDragListenersAttachedRef.current = true;
                }
                lastAppliedDragPosRef.current = null;
                lastResolvedJointPosRef.current = null;
                lastPublishedClampedJointPosRef.current = null;
                lastWarningRef.current = null;
                lastWarningEvalAtRef.current = 0;
                activeJointBindingRef.current = resolveJointBinding((foundParent as { segments: Array<{ topJoint?: { id: string; pos: Vec3 }; bottomJoint?: { id: string; pos: Vec3 } }> }).segments, jointId);

                // While dragging a joint, disable OrbitControls so camera movement cannot
                // influence drag math (which is computed from the camera ray).
                if (controls && savedControlsEnabledRef.current === null) {
                    const c: any = controls;
                    savedControlsEnabledRef.current = !!c.enabled;
                    c.enabled = false;
                }

                activeSupport.current = { typeId: owner.typeId, id: owner.id };

                const descriptor = getSupportTypeDescriptor(owner.typeId);
                // The pair the declared lower endpoint resolves from: the root a
                // plate-rooted shaft owns, or the knot a knot-lowered one hangs
                // from. Read off the declared edges, so the field each lives in is
                // not restated here.
                const declaredHosts = resolveDeclaredHosts(owner.typeId, foundParent as Record<string, unknown>);
                const hostRoot = descriptor.ownsRoot ? declaredHosts.root : undefined;
                const hostKnot = descriptor.lower.kind === 'knot' ? declaredHosts.hostKnot : undefined;

                activeConstraintRootRef.current = hostRoot;
                activeConstraintStartRef.current = resolveShaftAnchor(owner.typeId, {
                    root: hostRoot,
                    hostKnot,
                }) ?? undefined;

                // A multi-segment shaft clamps against the dragged segment's own
                // start, not the shaft anchor: on segment N>0 that is the
                // previous segment's top joint. Only segment 0 is the anchor.
                const draggedSegIndex = (foundParent as { segments: Segment[] }).segments
                    .findIndex((s) => s.topJoint?.id === jointId);
                if (hostRoot && draggedSegIndex > 0) {
                    const endpoints = resolveSegmentEndpoints(
                        foundParent as ShaftEntity,
                        (foundParent as { segments: Segment[] }).segments[draggedSegIndex],
                        draggedSegIndex,
                        { root: hostRoot, hostKnot },
                    );
                    activeConstraintStartRef.current = endpoints?.start;
                }

                // Trunk pushes its own typed history entry, so it keeps a direct
                // immutable reference instead of the shared edit snapshot.
                if (descriptor.ownsEditHistoryEntry) {
                    initialOwnHistorySnapshot.current = foundParent as Trunk;
                } else {
                    initialEditSnapshotRef.current = captureSupportEditSnapshot();
                }

                if (descriptor.jointDragUsesLivePreview) setLivePreview(foundParent);

                emitJointDragPositionPreview(jointId, foundJointPos);
                lastResolvedJointPosRef.current = { x: foundJointPos.x, y: foundJointPos.y, z: foundJointPos.z };
                dragStartJointPos.current = { x: foundJointPos.x, y: foundJointPos.y, z: foundJointPos.z };

                const jointVec = new THREE.Vector3(foundJointPos.x, foundJointPos.y, foundJointPos.z);

                // Setup drag plane parallel to camera, passing through joint
                const normal = new THREE.Vector3();
                camera.getWorldDirection(normal).negate(); // Face camera
                dragPlane.current.setFromNormalAndCoplanarPoint(normal, jointVec);

                // Calculate offset (where we clicked relative to joint center)
                setPickRayFromCamera(raycaster, pointer, camera);
                const intersection = new THREE.Vector3();
                const intersected = raycaster.ray.intersectPlane(dragPlane.current, intersection);

                if (intersected) {
                    dragOffset.current.subVectors(jointVec, intersection);
                } else {
                    dragOffset.current.set(0, 0, 0);
                }

                // Drag started
            }
        }

        // End Drag
        const activeJointIdAtEnd = activeJointId.current;
        const shouldEndDrag = (!isDragging || forceEndDragRef.current)
            && activeJointIdAtEnd
            && activeSupport.current;

        if (shouldEndDrag) {
            // Drag ended

            // On drag end, do one collision-aware recompute so diskLengthOverride only reflects
            // the final settled joint position (avoids latching max standoff mid-drag).
            //
            // Gated on real movement: this recompute re-solves the contact cone, which the
            // drag preview skips, so a click would otherwise move a tip it never dragged.
            const committedDragPos = lastDragPos.current;
            if (committedDragPos && shouldCommitJointDrag(dragStartJointPos.current, committedDragPos)) {
                if (JOINT_DRAG_HOSTED_SHAFT_TYPES.has(activeSupport.current?.typeId as SupportTypeId)) {
                    // A hosted shaft recomputes identically; the arms differed
                    // only in where the angle clamp measures from, which the
                    // declared lower endpoint gives.
                    const { typeId, id } = activeSupport.current!;
                    const support = getSupportEntity(typeId, id) as Record<string, unknown> | null;

                    if (support) {
                        const declared = resolveDeclaredHosts(typeId, support);
                        const root = activeConstraintRootRef.current ?? declared.root;
                        const contextStart = activeConstraintStartRef.current
                            ?? resolveShaftAnchor(typeId, declared) ?? undefined;

                        const resolved = computeJointDragSupportPreview({
                            kind: typeId as never,
                            support: support as never,
                            jointId: activeJointIdAtEnd,
                            newPos: committedDragPos,
                            isCurveMode: false,
                            root,
                            contextStart,
                        });

                        commitJointDragSupport(typeId as never, resolved, { stripDiskLengthOverride: true });
                    }
                } else if (activeSupport.current) {
                    // A type contacting the model at both ends re-solves those
                    // contacts against the moved joint; the fields and their
                    // kinds come from the declared endpoints.
                    const { typeId, id } = activeSupport.current;
                    const entity = getSupportEntity(typeId, id) as { segments: Segment[] } | null;
                    if (entity) {
                        const moved = updateSegmentsJointPos(entity.segments as any[], activeJointIdAtEnd, committedDragPos) as Segment[];
                        updateSupportEntity(typeId, resolveDraggedContacts(typeId, entity, activeJointIdAtEnd, moved) as never);
                    }
                }
            }

            // A type that owns its history entry pushes a TYPED action; the
            // payload map is keyed per action, so the push stays narrow and the
            // action comes off the descriptor rather than the type's name.
            // `shouldEndDrag` is only truthy when a support is being dragged, so
            // the ref is set here; the assertion states that rather than leaving
            // the narrowing to inference.
            const endedSupport = activeSupport.current!;
            const endDescriptor = getSupportTypeDescriptor(endedSupport.typeId);
            if (initialOwnHistorySnapshot.current && endDescriptor.ownsEditHistoryEntry && endDescriptor.historyUpdate) {
                const currentSupport = getSupportEntity(endedSupport.typeId, endedSupport.id);
                if (currentSupport) {
                    pushSupportHistory({
                        type: endDescriptor.historyUpdate,
                        description: `Move ${endDescriptor.singular} joint`,
                        payload: {
                            before: initialOwnHistorySnapshot.current,
                            after: cloneTrunk(currentSupport as Trunk),
                        },
                    });
                }
            }

            // A type that owns its entry pushed it above; the rest share one.
            if (initialEditSnapshotRef.current && activeSupport.current
                && !getSupportTypeDescriptor(activeSupport.current.typeId).ownsEditHistoryEntry) {
                pushSupportEditHistory(
                    `Move ${getSupportTypeDescriptor(activeSupport.current.typeId).singular} joint`,
                    initialEditSnapshotRef.current,
                    captureSupportEditSnapshot(),
                );
            }

            // A type that did not commit through the controller still has its
            // preview up, so clear it here.
            if (activeSupport.current && !JOINT_DRAG_COMMIT_TYPES.has(activeSupport.current.typeId)) {
                clearSupportDragPreview(activeSupport.current.typeId, activeSupport.current.id);
            }


            activeJointId.current = null;
            activeSupport.current = null;
            initialOwnHistorySnapshot.current = null;
            initialEditSnapshotRef.current = null;
            livePreviewRef.current = null;
            forceEndDragRef.current = false;
            lastAppliedDragPosRef.current = null;
            lastResolvedJointPosRef.current = null;
            lastPublishedClampedJointPosRef.current = null;
            lastEmittedPreviewJointPosRef.current = null;
            lastWarningEvalAtRef.current = 0;
            activeConstraintRootRef.current = undefined;
            activeConstraintStartRef.current = undefined;
            activeJointBindingRef.current = null;
            jointDragUpdatePendingRef.current = false;
            if (jointDragListenersAttachedRef.current) {
                window.removeEventListener('pointermove', markJointDragUpdatePending, true);
                jointDragListenersAttachedRef.current = false;
            }
            applyInteractionWarning(null); // Clear warning on release
            lastDragPos.current = null;
            dragStartJointPos.current = null;
            clearJointDragPositionPreview(activeJointIdAtEnd);

            // Restore OrbitControls enabled state
            if (controls && savedControlsEnabledRef.current !== null) {
                const c: any = controls;
                c.enabled = savedControlsEnabledRef.current;
                savedControlsEnabledRef.current = null;
            }

            setJointInteractionLock(false);
        }
    }, [isDragging, hit, camera, pointer, raycaster, controls, applyInteractionWarning, resolveJointBinding, markJointDragUpdatePending]);

    const emitPreviewJointPos = (clampedPos: Vec3 | null, rawPos: Vec3) => {
        const stablePos = clampedPos ?? lastResolvedJointPosRef.current ?? rawPos;
        const prev = lastEmittedPreviewJointPosRef.current;
        if (prev
            && Math.abs(prev.x - stablePos.x) < MIN_DRAG_DELTA_SQ
            && Math.abs(prev.y - stablePos.y) < MIN_DRAG_DELTA_SQ
            && Math.abs(prev.z - stablePos.z) < MIN_DRAG_DELTA_SQ) {
            return;
        }

        lastResolvedJointPosRef.current = { x: stablePos.x, y: stablePos.y, z: stablePos.z };
        lastEmittedPreviewJointPosRef.current = { x: stablePos.x, y: stablePos.y, z: stablePos.z };
        emitJointDragPositionPreview(activeJointId.current!, stablePos);
    };

    const snapDragPos = (pos: THREE.Vector3) => {
        pos.x = Math.round(pos.x / DRAG_SNAP_MM) * DRAG_SNAP_MM;
        pos.y = Math.round(pos.y / DRAG_SNAP_MM) * DRAG_SNAP_MM;
        pos.z = Math.round(pos.z / DRAG_SNAP_MM) * DRAG_SNAP_MM;
        return pos;
    };

    // Update loop
    useFrame(() => {
        if (!jointDragUpdatePendingRef.current) return;
        if (!(activeJointId.current && activeSupport.current)) return;

        jointDragUpdatePendingRef.current = false;

        if (activeJointId.current && activeSupport.current) {
            setPickRayFromCamera(raycaster, pointer, camera);
            const intersection = planeIntersectionRef.current;
            const intersected = raycaster.ray.intersectPlane(dragPlane.current, intersection);

            if (intersected) {
                // Apply offset
                const newPos = snapDragPos(intersection.add(dragOffset.current));
                const hasLastAppliedPos = !!lastAppliedDragPosRef.current;
                const deltaSq = hasLastAppliedPos
                    ? lastAppliedDragPosRef.current!.distanceToSquared(newPos)
                    : 0;

                if (hasLastAppliedPos && deltaSq < MIN_DRAG_DELTA_SQ) {
                    return;
                }
                const newPosVec3 = { x: newPos.x, y: newPos.y, z: newPos.z };
                lastDragPos.current = newPosVec3;
                // Emit once after clamped preview is calculated further below
                if (!lastAppliedDragPosRef.current) {
                    lastAppliedDragPosRef.current = newPos.clone();
                } else {
                    lastAppliedDragPosRef.current.copy(newPos);
                }

                const { typeId, id } = activeSupport.current;
                const entity = getSupportEntity(typeId, id) as
                    | (Record<string, unknown> & { id: string; segments: Segment[] })
                    | null;

                if (entity && JOINT_DRAG_HOSTED_SHAFT_TYPES.has(typeId)) {
                    // A hosted shaft clamps against a host, so the root, the angle
                    // clamp's origin and the preview all come off the entity's
                    // declared endpoints -- no arm per type.
                    const declared = resolveDeclaredHosts(typeId, entity);
                    const root = activeConstraintRootRef.current ?? declared.root;
                    // The fallback measures from the same root the clamp gets, which
                    // may be the one captured at drag start rather than the declared.
                    const contextStart = activeConstraintStartRef.current
                        ?? resolveShaftAnchor(typeId, { root, hostKnot: declared.hostKnot }) ?? undefined;

                    const next = computeJointDragSupportPreview({
                        kind: typeId as never,
                        support: entity as never,
                        jointId: activeJointId.current!,
                        newPos: newPosVec3,
                        isCurveMode: false,
                        root,
                        contextStart,
                    }) as { id: string; segments: Segment[] };

                    const clamped = resolveJointPosById(next.segments, activeJointId.current!);
                    if (shouldPublishForClampedPos(clamped) && !previewAlreadyShown(typeId, id, next)) {
                        if (getSupportTypeDescriptor(typeId).jointDragUsesLivePreview) setLivePreview(next);
                        publishJointDragSupportPreview(typeId as never, next as never);
                        markPublishedClampedPos(clamped);
                    }

                    emitPreviewJointPos(clamped, newPosVec3);
                    applyWarningForDragDelta(clamped, newPosVec3);
                } else if (entity) {
                    // A type contacting the model at both ends re-solves those
                    // contacts against the moved joint instead of clamping to a host.
                    const moved = updateSegmentsJointPos(entity.segments as any[], activeJointId.current!, newPosVec3) as Segment[];
                    const next = resolveDraggedContacts(typeId, entity as never, activeJointId.current!, moved) as
                        { id: string; segments: Segment[] };

                    const clamped = resolveJointPosById(next.segments, activeJointId.current!);
                    if (shouldPublishForClampedPos(clamped) && !previewAlreadyShown(typeId, id, next)) {
                        if (getSupportTypeDescriptor(typeId).jointDragUsesLivePreview) setLivePreview(next);
                        emitSupportDragPreview(typeId, next.id, next);
                        markPublishedClampedPos(clamped);
                    }

                    emitPreviewJointPos(clamped, newPosVec3);
                }
            }
        }
    });
}
