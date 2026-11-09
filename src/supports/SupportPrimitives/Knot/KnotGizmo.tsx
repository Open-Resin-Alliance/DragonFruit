import React, { useSyncExternalStore, useCallback, useRef, useEffect } from 'react';
import * as THREE from 'three';
import { useThree, useFrame } from '@react-three/fiber';
import { ScreenSpaceGizmo } from '@/components/gizmo/ScreenSpaceGizmo';
import { isKeyPressedSync } from '@/hotkeys/hotkeyStore';
import { findShaftOwnerOfSegment, getSupportEntity, subscribe, getSnapshot, getKnotById, getRootById, updateKnot } from '../../state';
import { Branch, Knot, Segment } from '../../types';
import { getSupportTypeDescriptor, updateSupportEntity, type SupportEdge, type SupportTypeId } from '../../supportTypeRegistry';
import { resolveSegmentEndpoints, type ShaftEntity } from './segmentEndpoints';
import { captureFlexingShafts, collectSolvedShaft, getFlexingShaft } from './elasticShaftPreview';
import { knotMoveDescription, projectOntoSegment } from './knotUtils';
import { ElasticChainInitialState, solveElasticChain } from '../../PlacementLogic/ElasticChainSolver';
import { getSettings } from '../../Settings/state';
import { captureSupportEditSnapshot, pushSupportEditHistory } from '../../history/supportEditHistory';
import { clearKnotDragPreview, emitKnotDragPreview, useActiveKnotDragPreview } from '../../interaction/knotDragPreview';
import { setPickRayFromCamera } from '@/components/scene/camera/pickRay';

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
    const beforeHistoryRef = useRef<ReturnType<typeof captureSupportEditSnapshot> | null>(null);
    const dragEndedResetTimeoutRef = useRef<number | null>(null);
    const gizmoTargetRef = useRef<THREE.Group>(null);
    const dragProjectionOffsetTRef = useRef(0);
    const selectionCooldownUntilRef = useRef(0);

    // Elastic chain state - captured at drag start
    const elasticStateRef = useRef<Record<string, ElasticChainInitialState>>({});
    const previewShaftSegmentsByIdRef = useRef<Record<string, Branch['segments']>>({});
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

        // One lookup for every shafted type, then the shared endpoint walker.
        // The chain here covered four types and ended in a bare else for stick.
        const owner = findShaftOwnerOfSegment(knot.parentShaftId);
        if (!owner) return null;

        const entity = getSupportEntity(owner.typeId, owner.id) as
            | (Record<string, unknown> & { id: string; typeId?: SupportTypeId; segments?: Segment[]; rootId?: string })
            | null;
        if (!entity) return null;

        const segments = entity.segments ?? [];
        const index = segments.findIndex((seg) => seg.id === knot.parentShaftId);
        if (index === -1) return null;

        const knotField = getSupportTypeDescriptor(owner.typeId).edges.find(
            (edge: SupportEdge) => edge.to === 'knots' && edge.ownership === 'hostedBy',
        )?.field;

        const endpoints = resolveSegmentEndpoints(
            entity as ShaftEntity,
            segments[index],
            index,
            {
                root: entity.rootId ? getRootById(entity.rootId) : undefined,
                hostKnot: knotField && typeof entity[knotField] === 'string'
                    ? getKnotById(entity[knotField] as string)
                    : undefined,
            },
        );
        if (!endpoints) return null;

        const start = new THREE.Vector3(endpoints.start.x, endpoints.start.y, endpoints.start.z);
        const end = new THREE.Vector3(endpoints.end.x, endpoints.end.y, endpoints.end.z);
        return { knot, start, end, axis: new THREE.Vector3().subVectors(end, start).normalize() };
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

        setPickRayFromCamera(raycaster, pointer, camera);
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
        const shaftSegmentsById: Record<string, Branch['segments']> = {};
        for (const shaftId in elasticStateRef.current) {
            const initialState = elasticStateRef.current[shaftId];
            const res = solveElasticChain(finalKnotPos, initialState, maxAngleDeg);

            // If solver clamped the knot, use the clamped position
            if (res.isLocked && res.knotPos.z < finalKnotPos.z) {
                finalKnotPos = res.knotPos;
                wasLocked = true;
            }

            // A shaft back at its committed geometry keeps an entry only if it
            // already had a preview override, so the prune below can see it.
            collectSolvedShaft(shaftSegmentsById, shaftId, res, (id) =>
                Object.prototype.hasOwnProperty.call(previewShaftSegmentsByIdRef.current, id));
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

        const updatedShaftIds = Object.keys(shaftSegmentsById);
        if (updatedShaftIds.length > 0) {
            const nextPreviewBranchSegmentsById = { ...previewShaftSegmentsByIdRef.current };
            for (const shaftId of updatedShaftIds) {
                const nextSegments = shaftSegmentsById[shaftId];
                // By id alone: this map is keyed by flexing shafts, and the
                // store already knows what type each one is.
                const committedShaft = getFlexingShaft(shaftId);
                if (committedShaft && committedShaft.segments === nextSegments) {
                    delete nextPreviewBranchSegmentsById[shaftId];
                } else {
                    nextPreviewBranchSegmentsById[shaftId] = nextSegments;
                }
            }
            previewShaftSegmentsByIdRef.current = nextPreviewBranchSegmentsById;
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
            shaftSegmentsById: previewShaftSegmentsByIdRef.current,
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
        previewShaftSegmentsByIdRef.current = {};
        previewKnotRef.current = null;
        activePreviewKnotIdRef.current = result.knot.id;
        clearKnotDragPreview();

        // Preserve click offset so the knot doesn't snap to the raw pointer projection on first drag frame.
        const currentKnotPos = new THREE.Vector3(result.knot.pos.x, result.knot.pos.y, result.knot.pos.z);
        const currentT = computeTOnSegment(currentKnotPos, result.start, result.end);
        setPickRayFromCamera(raycaster, pointer, camera);
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

        // Capture the initial state of every shaft that flexes off the dragged
        // knots. Which types those are, the field naming their knot, and the
        // field holding their contact all come from the registry.
        const nextState = captureFlexingShafts(w.__draggedKnotGroup, result.knot.pos);

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

        const previewShaftSegmentsById = previewShaftSegmentsByIdRef.current;
        const previewKnot = previewKnotRef.current;

        for (const [shaftId, previewSegments] of Object.entries(previewShaftSegmentsById)) {
            // By id alone: the store holds the type this shaft is.
            const shaft = getSupportEntity(shaftId);
            if (!shaft) continue;
            updateSupportEntity({ ...shaft, segments: previewSegments });
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
        previewShaftSegmentsByIdRef.current = {};
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
            const parentShaftId = selectedId ? getKnotById(selectedId)?.parentShaftId : undefined;
            const movedFrom = parentShaftId ? findShaftOwnerOfSegment(parentShaftId) : null;
            const description = knotMoveDescription(movedFrom?.typeId);
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
            previewShaftSegmentsByIdRef.current = {};
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
