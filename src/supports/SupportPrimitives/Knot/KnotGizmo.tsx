import React, { useSyncExternalStore, useCallback, useRef, useEffect } from 'react';
import * as THREE from 'three';
import { useThree, useFrame } from '@react-three/fiber';
import { ScreenSpaceGizmo } from '@/components/gizmo/ScreenSpaceGizmo';
import { isKeyPressedSync } from '@/hotkeys/hotkeyStore';
import {
    subscribe,
    getSnapshot,
    getKnotById,
    getTrunks,
    getBranches,
    getTwigs,
    getSticks,
    getRootById,
    updateKnot,
    updateBranch,
    getBranchById,
    getTrunkById,
    getTwigById,
    getStickById,
} from '../../state';
import { Branch, Knot } from '../../types';
import { getTrunkSegmentEndpoints, getBranchSegmentEndpoints, projectOntoSegment } from './knotUtils';
import { ElasticChainInitialState, solveElasticChain } from '../../PlacementLogic/ElasticChainSolver';
import { getSettings } from '../../Settings';
import { getSocketPosition } from '../ContactCone';
import { captureSupportEditSnapshot, pushSupportEditHistory } from '../../history/supportEditHistory';
import { clearKnotDragPreview, emitKnotDragPreview, useActiveKnotDragPreview } from '../../interaction/knotDragPreview';

type KnotGizmoWindowState = Window & {
    __knotGizmoDragging?: boolean;
    __knotGizmoGuardUntil?: number;
    __gizmoDragEndedThisFrame?: boolean;
};

const getKnotGizmoWindowState = () => window as unknown as KnotGizmoWindowState;

/**
 * KnotGizmo redesigned to match JointGizmo architecture:
 * - Screen-space transform gizmo visuals
 * - constrained single-axis motion along parent shaft
 * - existing knot + elastic chain constraint solver retained
 */
export function KnotGizmo() {
    const state = useSyncExternalStore(subscribe, getSnapshot);
    const selectedId = state.selectedId;
    const selectedCategory = state.selectedCategory;
    const { camera, raycaster, pointer } = useThree();
    const activeKnotDragPreview = useActiveKnotDragPreview();

    const isDraggingRef = useRef(false);
    const shaftAxisRef = useRef<THREE.Vector3>(new THREE.Vector3(0, 0, 1));
    const shaftStartRef = useRef<THREE.Vector3>(new THREE.Vector3());
    const shaftEndRef = useRef<THREE.Vector3>(new THREE.Vector3());
    const selectedKnotParentRef = useRef<{
        selectedId: string;
        parentShaftId: string;
        kind: 'trunk' | 'branch' | 'twig' | 'stick';
        supportId: string;
        segmentIndex: number;
    } | null>(null);
    const beforeHistoryRef = useRef<ReturnType<typeof captureSupportEditSnapshot> | null>(null);
    const dragEndedResetTimeoutRef = useRef<number | null>(null);
    const gizmoTargetRef = useRef<THREE.Group>(null);
    const dragProjectionOffsetTRef = useRef(0);
    const selectionCooldownUntilRef = useRef(0);

    // Elastic chain state - captured at drag start
    const elasticStateRef = useRef<Record<string, ElasticChainInitialState>>({});
    const previewBranchSegmentsByIdRef = useRef<Record<string, Branch['segments']>>({});
    const previewKnotRef = useRef<Knot | null>(null);
    const activePreviewKnotIdRef = useRef<string | null>(null);
    const previewCoincidentKnotsRef = useRef<Knot[]>([]);

    const selectedPreviewKnot = selectedId && activeKnotDragPreview?.knotId === selectedId
        ? activeKnotDragPreview.knot
        : null;

    const setKnotGizmoInteractionFlags = useCallback((isDragging: boolean, postGuardMs = 180) => {
        const w = getKnotGizmoWindowState();
        w.__knotGizmoDragging = isDragging;
        w.__knotGizmoGuardUntil = isDragging ? 0 : (Date.now() + postGuardMs);

        window.dispatchEvent(new CustomEvent('knot-gizmo-interaction-lock', {
            detail: {
                active: isDragging,
                guardUntil: w.__knotGizmoGuardUntil,
            },
        }));
    }, []);

    const getDominantAxis = useCallback((axis: THREE.Vector3): 'x' | 'y' | 'z' => {
        const absX = Math.abs(axis.x);
        const absY = Math.abs(axis.y);
        const absZ = Math.abs(axis.z);
        if (absX >= absY && absX >= absZ) return 'x';
        if (absY >= absX && absY >= absZ) return 'y';
        return 'z';
    }, []);

    const computeTOnSegment = useCallback((point: THREE.Vector3, start: THREE.Vector3, end: THREE.Vector3) => {
        const lineVec = new THREE.Vector3().subVectors(end, start);
        const lenSq = lineVec.lengthSq();
        if (lenSq <= 0.000001) return 0;
        const knotVec = new THREE.Vector3().subVectors(point, start);
        return THREE.MathUtils.clamp(knotVec.dot(lineVec) / lenSq, 0, 1);
    }, []);

    // Find the selected knot and its parent shaft
    const findKnotAndShaft = useCallback((): {
        knot: Knot,
        start: THREE.Vector3,
        end: THREE.Vector3,
        axis: THREE.Vector3
    } | null => {
        if (!selectedId) return null;

        const knot = selectedPreviewKnot ?? getKnotById(selectedId);
        if (!knot) return null;

        const cached = selectedKnotParentRef.current;
        if (cached && cached.selectedId === selectedId && cached.parentShaftId === knot.parentShaftId) {
            if (cached.kind === 'trunk') {
                const trunk = getTrunkById(cached.supportId);
                const seg = trunk?.segments[cached.segmentIndex];
                const root = trunk ? getRootById(trunk.rootId) : null;
                if (trunk && seg && seg.id === knot.parentShaftId && root) {
                    const endpoints = getTrunkSegmentEndpoints(trunk, seg, cached.segmentIndex, root);
                    if (endpoints) {
                        const start = new THREE.Vector3(endpoints.start.x, endpoints.start.y, endpoints.start.z);
                        const end = new THREE.Vector3(endpoints.end.x, endpoints.end.y, endpoints.end.z);
                        const axis = new THREE.Vector3().subVectors(end, start).normalize();
                        return { knot, start, end, axis };
                    }
                }
            } else if (cached.kind === 'branch') {
                const branch = getBranchById(cached.supportId);
                const seg = branch?.segments[cached.segmentIndex];
                const parentKnot = branch ? getKnotById(branch.parentKnotId) : null;
                if (branch && seg && seg.id === knot.parentShaftId && parentKnot) {
                    const endpoints = getBranchSegmentEndpoints(branch, seg, cached.segmentIndex, parentKnot);
                    if (endpoints) {
                        const start = new THREE.Vector3(endpoints.start.x, endpoints.start.y, endpoints.start.z);
                        const end = new THREE.Vector3(endpoints.end.x, endpoints.end.y, endpoints.end.z);
                        const axis = new THREE.Vector3().subVectors(end, start).normalize();
                        return { knot, start, end, axis };
                    }
                }
            } else if (cached.kind === 'twig') {
                const twig = getTwigById(cached.supportId);
                const seg = twig?.segments[cached.segmentIndex];
                if (twig && seg && seg.id === knot.parentShaftId && seg.bottomJoint && seg.topJoint) {
                    const start = new THREE.Vector3(seg.bottomJoint.pos.x, seg.bottomJoint.pos.y, seg.bottomJoint.pos.z);
                    const end = new THREE.Vector3(seg.topJoint.pos.x, seg.topJoint.pos.y, seg.topJoint.pos.z);
                    const axis = new THREE.Vector3().subVectors(end, start).normalize();
                    return { knot, start, end, axis };
                }
            } else {
                const stick = getStickById(cached.supportId);
                const seg = stick?.segments[cached.segmentIndex];
                if (stick && seg && seg.id === knot.parentShaftId && seg.bottomJoint && seg.topJoint) {
                    const start = new THREE.Vector3(seg.bottomJoint.pos.x, seg.bottomJoint.pos.y, seg.bottomJoint.pos.z);
                    const end = new THREE.Vector3(seg.topJoint.pos.x, seg.topJoint.pos.y, seg.topJoint.pos.z);
                    const axis = new THREE.Vector3().subVectors(end, start).normalize();
                    return { knot, start, end, axis };
                }
            }

            selectedKnotParentRef.current = null;
        }

        // Find parent shaft in trunks
        const trunks = getTrunks();
        for (const trunk of trunks) {
            const idx = trunk.segments.findIndex(s => s.id === knot.parentShaftId);
            if (idx !== -1) {
                const root = getRootById(trunk.rootId);
                if (!root) continue;
                const seg = trunk.segments[idx];
                const endpoints = getTrunkSegmentEndpoints(trunk, seg, idx, root);
                if (endpoints) {
                    const start = new THREE.Vector3(endpoints.start.x, endpoints.start.y, endpoints.start.z);
                    const end = new THREE.Vector3(endpoints.end.x, endpoints.end.y, endpoints.end.z);
                    const axis = new THREE.Vector3().subVectors(end, start).normalize();
                    selectedKnotParentRef.current = {
                        selectedId,
                        parentShaftId: knot.parentShaftId,
                        kind: 'trunk',
                        supportId: trunk.id,
                        segmentIndex: idx,
                    };
                    return { knot, start, end, axis };
                }
            }
        }

        // Find parent shaft in branches
        const branches = getBranches();
        for (const branch of branches) {
            const idx = branch.segments.findIndex(s => s.id === knot.parentShaftId);
            if (idx !== -1) {
                const parentKnot = getKnotById(branch.parentKnotId);
                if (!parentKnot) continue;
                const seg = branch.segments[idx];
                const endpoints = getBranchSegmentEndpoints(branch, seg, idx, parentKnot);
                if (endpoints) {
                    const start = new THREE.Vector3(endpoints.start.x, endpoints.start.y, endpoints.start.z);
                    const end = new THREE.Vector3(endpoints.end.x, endpoints.end.y, endpoints.end.z);
                    const axis = new THREE.Vector3().subVectors(end, start).normalize();
                    selectedKnotParentRef.current = {
                        selectedId,
                        parentShaftId: knot.parentShaftId,
                        kind: 'branch',
                        supportId: branch.id,
                        segmentIndex: idx,
                    };
                    return { knot, start, end, axis };
                }
            }
        }

        // Find parent shaft in twigs
        const twigs = getTwigs();
        for (const twig of twigs) {
            const idx = twig.segments.findIndex(s => s.id === knot.parentShaftId);
            if (idx === -1) continue;
            const seg = twig.segments[idx];
            if (!seg.bottomJoint || !seg.topJoint) continue;
            const start = new THREE.Vector3(seg.bottomJoint.pos.x, seg.bottomJoint.pos.y, seg.bottomJoint.pos.z);
            const end = new THREE.Vector3(seg.topJoint.pos.x, seg.topJoint.pos.y, seg.topJoint.pos.z);
            const axis = new THREE.Vector3().subVectors(end, start).normalize();
            selectedKnotParentRef.current = {
                selectedId,
                parentShaftId: knot.parentShaftId,
                kind: 'twig',
                supportId: twig.id,
                segmentIndex: idx,
            };
            return { knot, start, end, axis };
        }

        // Find parent shaft in sticks
        const sticks = getSticks();
        for (const stick of sticks) {
            const idx = stick.segments.findIndex(s => s.id === knot.parentShaftId);
            if (idx === -1) continue;
            const seg = stick.segments[idx];
            if (!seg.bottomJoint || !seg.topJoint) continue;
            const start = new THREE.Vector3(seg.bottomJoint.pos.x, seg.bottomJoint.pos.y, seg.bottomJoint.pos.z);
            const end = new THREE.Vector3(seg.topJoint.pos.x, seg.topJoint.pos.y, seg.topJoint.pos.z);
            const axis = new THREE.Vector3().subVectors(end, start).normalize();
            selectedKnotParentRef.current = {
                selectedId,
                parentShaftId: knot.parentShaftId,
                kind: 'stick',
                supportId: stick.id,
                segmentIndex: idx,
            };
            return { knot, start, end, axis };
        }

        selectedKnotParentRef.current = null;
        return null;
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [selectedId, selectedPreviewKnot, state]);

    const result = findKnotAndShaft();

    useEffect(() => {
        if (selectedCategory !== 'knot' || !selectedId) {
            selectionCooldownUntilRef.current = 0;
            return;
        }

        selectionCooldownUntilRef.current = Date.now() + 200;
    }, [selectedCategory, selectedId]);

    useFrame(() => {
        // Only show/update gizmo when a knot is selected
        if (selectedCategory !== 'knot') return;
        if (!result) return;

        // Update refs for drag solving
        shaftAxisRef.current.copy(result.axis);
        shaftStartRef.current.copy(result.start);
        shaftEndRef.current.copy(result.end);

        if (gizmoTargetRef.current) {
            gizmoTargetRef.current.position.set(result.knot.pos.x, result.knot.pos.y, result.knot.pos.z);
        }
    });

    // Handle drag with elastic chain constraints
    useFrame(() => {
        if (!isDraggingRef.current || !result) return;

        raycaster.setFromCamera(pointer, camera);
        const projected = projectOntoSegment(
            raycaster.ray,
            shaftStartRef.current,
            shaftEndRef.current
        );

        const projectedTWithOffset = THREE.MathUtils.clamp(projected.t + dragProjectionOffsetTRef.current, 0, 1);
        const shaftLineVec = new THREE.Vector3().subVectors(shaftEndRef.current, shaftStartRef.current);
        const projectedPointWithOffset = shaftStartRef.current.clone().add(shaftLineVec.multiplyScalar(projectedTWithOffset));

        // Apply elastic chain constraints
        const settings = getSettings();
        const maxAngleDeg = settings.shaft.maxAngleDeg ?? 80;

        let finalKnotPos = { x: projectedPointWithOffset.x, y: projectedPointWithOffset.y, z: projectedPointWithOffset.z };
        let wasLocked = false;

        // Run elastic solver for each attached branch
        const branchSegmentsById: Record<string, Branch['segments']> = {};
        for (const branchId in elasticStateRef.current) {
            const initialState = elasticStateRef.current[branchId];
            const res = solveElasticChain(finalKnotPos, initialState, maxAngleDeg);

            // If solver clamped the knot, use the clamped position
            if (res.isLocked && res.knotPos.z < finalKnotPos.z) {
                finalKnotPos = res.knotPos;
                wasLocked = true;
            }

            // Update branch joints
            const branch = getBranchById(branchId);
            if (!branch) continue;

            let branchChanged = false;
            const newSegments = branch.segments.map(seg => {
                let segChanged = false;
                let newTopJoint = seg.topJoint;
                let newBottomJoint = seg.bottomJoint;

                if (seg.topJoint && res.jointPositions[seg.topJoint.id]) {
                    const newPos = res.jointPositions[seg.topJoint.id];
                    if (Math.abs(newPos.z - seg.topJoint.pos.z) > 0.0001) {
                        newTopJoint = { ...seg.topJoint, pos: newPos };
                        segChanged = true;
                    }
                }

                if (seg.bottomJoint && res.jointPositions[seg.bottomJoint.id]) {
                    const newPos = res.jointPositions[seg.bottomJoint.id];
                    if (Math.abs(newPos.z - seg.bottomJoint.pos.z) > 0.0001) {
                        newBottomJoint = { ...seg.bottomJoint, pos: newPos };
                        segChanged = true;
                    }
                }

                if (segChanged) {
                    branchChanged = true;
                    return { ...seg, topJoint: newTopJoint, bottomJoint: newBottomJoint };
                }
                return seg;
            });

            if (branchChanged) {
                branchSegmentsById[branch.id] = newSegments;
            } else if (Object.prototype.hasOwnProperty.call(previewBranchSegmentsByIdRef.current, branch.id)) {
                // Branch returned to committed geometry; mark it for preview-prune below.
                branchSegmentsById[branch.id] = branch.segments;
            }
        }

        // Recalculate t based on final position
        const lineVec = new THREE.Vector3().subVectors(shaftEndRef.current, shaftStartRef.current);
        const lenSq = lineVec.lengthSq();
        let t = projectedTWithOffset;
        if (lenSq > 0.0001 && wasLocked) {
            const knotVec = new THREE.Vector3(finalKnotPos.x, finalKnotPos.y, finalKnotPos.z).sub(shaftStartRef.current);
            t = knotVec.dot(lineVec) / lenSq;
            t = Math.max(0, Math.min(1, t));
        }

        const updated: Knot = {
            ...result.knot,
            pos: finalKnotPos,
            t,
        };

        const updatedBranchIds = Object.keys(branchSegmentsById);
        if (updatedBranchIds.length > 0) {
            const nextPreviewBranchSegmentsById = { ...previewBranchSegmentsByIdRef.current };
            for (const branchId of updatedBranchIds) {
                const nextSegments = branchSegmentsById[branchId];
                const committedBranch = getBranchById(branchId);
                if (committedBranch && committedBranch.segments === nextSegments) {
                    delete nextPreviewBranchSegmentsById[branchId];
                } else {
                    nextPreviewBranchSegmentsById[branchId] = nextSegments;
                }
            }
            previewBranchSegmentsByIdRef.current = nextPreviewBranchSegmentsById;
        }

        const w = getKnotGizmoWindowState() as any;
        const coincidentPreviewList: Knot[] = [];
        if (w.__draggedKnotGroup && w.__draggedKnotGroup.length > 1) {
            for (const kid of w.__draggedKnotGroup) {
                if (kid === updated.id) continue;
                const origKnot = getKnotById(kid);
                if (origKnot) {
                    coincidentPreviewList.push({
                        ...origKnot,
                        pos: finalKnotPos,
                        t,
                    });
                }
            }
        }
        previewCoincidentKnotsRef.current = coincidentPreviewList;

        previewKnotRef.current = updated;
        activePreviewKnotIdRef.current = updated.id;
        emitKnotDragPreview({
            knotId: updated.id,
            knot: updated,
            branchSegmentsById: previewBranchSegmentsByIdRef.current,
            coincidentKnots: coincidentPreviewList,
        });
    });

    const handleMoveStart = useCallback((axis?: 'x' | 'y' | 'z') => {
        if (!result) return false;

        if (selectionCooldownUntilRef.current && Date.now() < selectionCooldownUntilRef.current) {
            return false;
        }

        const dominantAxis = getDominantAxis(result.axis);
        if (axis && axis !== dominantAxis) {
            return false;
        }

        isDraggingRef.current = true;
        setKnotGizmoInteractionFlags(true, 0);
        getKnotGizmoWindowState().__gizmoDragEndedThisFrame = false;
        document.body.style.cursor = 'grabbing';
        beforeHistoryRef.current = captureSupportEditSnapshot();
        previewBranchSegmentsByIdRef.current = {};
        previewKnotRef.current = null;
        activePreviewKnotIdRef.current = result.knot.id;
        clearKnotDragPreview();

        // Preserve click offset so the knot doesn't snap to the raw pointer projection on first drag frame.
        const currentKnotPos = new THREE.Vector3(result.knot.pos.x, result.knot.pos.y, result.knot.pos.z);
        const currentT = computeTOnSegment(currentKnotPos, result.start, result.end);
        raycaster.setFromCamera(pointer, camera);
        const projectedAtStart = projectOntoSegment(raycaster.ray, result.start, result.end);
        dragProjectionOffsetTRef.current = currentT - projectedAtStart.t;

        const shiftHeld = isKeyPressedSync('shift');
        const isGroup = !shiftHeld;

        const w = getKnotGizmoWindowState() as any;
        w.__knotDragIsGroup = isGroup;

        // Find coincident knots (knots on same parentShaftId and same t)
        const allKnots = Object.values(getSnapshot().knots);
        const coincident = allKnots.filter(
            k => k.parentShaftId === result.knot.parentShaftId &&
                 k.t !== undefined && result.knot.t !== undefined &&
                 Math.abs(k.t - result.knot.t) < 0.0001
        );
        w.__draggedKnotGroup = isGroup ? coincident.map(k => k.id) : [result.knot.id];

        // Capture elastic state for attached branches
        const allBranches = getBranches();
        const attached = allBranches.filter(b => w.__draggedKnotGroup.includes(b.parentKnotId));
        const nextState: Record<string, ElasticChainInitialState> = {};

        for (const branch of attached) {
            const joints: { id: string; pos: { x: number, y: number, z: number } }[] = [];

            for (let i = 0; i < branch.segments.length; i++) {
                const seg = branch.segments[i];
                let joint = seg.topJoint;
                if (!joint && i < branch.segments.length - 1) {
                    joint = branch.segments[i + 1].bottomJoint;
                }
                if (joint) {
                    joints.push({ id: joint.id, pos: { ...joint.pos } });
                }
            }

            nextState[branch.id] = {
                branchId: branch.id,
                knotPos: { ...result.knot.pos },
                joints,
                // Use SOCKET position (where shaft connects), not TIP position (where cone touches model)
                contactCone: branch.contactCone ? {
                    pos: getSocketPosition(branch.contactCone.pos, branch.contactCone.normal, branch.contactCone.profile),
                } : undefined,
            };
        }

        elasticStateRef.current = nextState;
        return true;
    }, [camera, computeTOnSegment, getDominantAxis, pointer, raycaster, result, setKnotGizmoInteractionFlags]);

    const handleMove = useCallback(() => {
        // Intentionally no-op:
        // Knot drag is solved per-frame using pointer projection onto host shaft.
        // onMoveStart/onMoveEnd toggle that solver lifecycle.
    }, []);

    const handleMoveEnd = useCallback(() => {
        if (!isDraggingRef.current) return;

        isDraggingRef.current = false;
        setKnotGizmoInteractionFlags(false);
        elasticStateRef.current = {};
        dragProjectionOffsetTRef.current = 0;

        const previewBranchSegmentsById = previewBranchSegmentsByIdRef.current;
        const previewKnot = previewKnotRef.current;

        for (const [branchId, previewSegments] of Object.entries(previewBranchSegmentsById)) {
            const branch = getBranchById(branchId);
            if (!branch) continue;
            updateBranch({ ...branch, segments: previewSegments });
        }

        if (previewKnot) {
            updateKnot(previewKnot);
        }

        for (const coincKnot of previewCoincidentKnotsRef.current) {
            updateKnot(coincKnot);
        }

        const w = getKnotGizmoWindowState() as any;
        w.__knotDragIsGroup = undefined;
        w.__draggedKnotGroup = undefined;

        if (activePreviewKnotIdRef.current) {
            clearKnotDragPreview();
        }
        activePreviewKnotIdRef.current = null;
        previewBranchSegmentsByIdRef.current = {};
        previewKnotRef.current = null;
        previewCoincidentKnotsRef.current = [];

        // Prevent canvas click deselect on drag release
        getKnotGizmoWindowState().__gizmoDragEndedThisFrame = true;
        if (dragEndedResetTimeoutRef.current !== null) {
            window.clearTimeout(dragEndedResetTimeoutRef.current);
            dragEndedResetTimeoutRef.current = null;
        }
        dragEndedResetTimeoutRef.current = window.setTimeout(() => {
            getKnotGizmoWindowState().__gizmoDragEndedThisFrame = false;
            dragEndedResetTimeoutRef.current = null;
        }, 100);

        document.body.style.cursor = '';

        if (beforeHistoryRef.current) {
            const description =
                selectedKnotParentRef.current?.kind === 'branch'
                    ? 'Move branch knot'
                    : selectedKnotParentRef.current?.kind === 'twig'
                        ? 'Move twig knot'
                        : selectedKnotParentRef.current?.kind === 'stick'
                            ? 'Move stick knot'
                            : 'Move support knot';
            pushSupportEditHistory(description, beforeHistoryRef.current, captureSupportEditSnapshot());
        }
        beforeHistoryRef.current = null;
    }, [setKnotGizmoInteractionFlags]);

    useEffect(() => {
        return () => {
            if (dragEndedResetTimeoutRef.current !== null) {
                window.clearTimeout(dragEndedResetTimeoutRef.current);
                dragEndedResetTimeoutRef.current = null;
            }
            dragProjectionOffsetTRef.current = 0;
            clearKnotDragPreview();
            activePreviewKnotIdRef.current = null;
            previewBranchSegmentsByIdRef.current = {};
            previewKnotRef.current = null;
            previewCoincidentKnotsRef.current = [];
            const w = getKnotGizmoWindowState() as any;
            w.__knotDragIsGroup = undefined;
            w.__draggedKnotGroup = undefined;
            setKnotGizmoInteractionFlags(false, 0);
        };
    }, [setKnotGizmoInteractionFlags]);

    // Only show gizmo when a knot is selected
    if (selectedCategory !== 'knot' || !result) return null;

    const { knot, axis } = result;
    const dominantAxis = getDominantAxis(axis);

    return (
        <>
            <group
                ref={gizmoTargetRef as React.MutableRefObject<THREE.Group>}
                position={[knot.pos.x, knot.pos.y, knot.pos.z]}
            />
            <ScreenSpaceGizmo
                meshRef={gizmoTargetRef as React.RefObject<THREE.Group>}
                position={[knot.pos.x, knot.pos.y, knot.pos.z]}
                enableMove={true}
                enableRotate={false}
                enableScale={false}
                showCenter={false}
                axisLock={dominantAxis}
                moveHandleBidirectional={true}
                moveHandleLengthScale={1.0}
                moveHandleThicknessScale={1.0}
                onMoveStart={handleMoveStart}
                onMove={handleMove}
                onMoveEnd={handleMoveEnd}
                scaleFactor={0.02}
                handleScale={3.0}
            />
        </>
    );
}
