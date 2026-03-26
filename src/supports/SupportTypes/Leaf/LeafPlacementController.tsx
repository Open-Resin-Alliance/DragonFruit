import { useEffect, useCallback, useMemo, useRef, useSyncExternalStore } from 'react';
import { useFrame, useThree } from '@react-three/fiber';
import * as THREE from 'three';
import { useHotkeyConfig } from '@/hotkeys/HotkeyContext';
import { subscribe, getSnapshot, addKnot, addLeaf } from '../../state';
import { pushHistory } from '@/history/historyStore';
import type { SnapTarget } from '../../interaction/SnappingManager';
import type { Vec3, Knot } from '../../types';
import { leafPlacementStore, useLeafPlacementState } from './leafPlacementState';
import { LEAF_HOTKEY_REARM_EVENT } from './useLeafPlacement';
import { buildLeafData } from './leafBuilder';
import { getSettings } from '../../Settings';
import type { SupportData } from '../../rendering/SupportBuilder';
import { SUPPORT_ADD_LEAF } from '../../history/actionTypes';
import { JOINT_DIAMETER_OFFSET_MM } from '../../constants';
import { generateUuid } from '@/utils/uuid';
import { isContactDiskHudInteractionActive, shouldSuppressContactDiskHudPlacementCommit } from '../../SupportPrimitives/ContactDisk/contactDiskHudInteraction';
import { clearSupportSelection } from '../../interaction/shared/selection/selectionController';
import { canResolveSupportPlacementBindingFromModifierState, getSupportPlacementModifierState, isSupportPlacementBindingSatisfiedByModifierState } from '../../interaction/shared/placement/hotkeys/supportPlacementHotkeyResolver';
import { usePlacementSnappingSession } from '../../interaction/shared/placement/snapping/usePlacementSnappingSession';
import { buildKickstandPathSnapTargets, buildPrimarySnapTargetIndex, buildSupportPathSnapTargets } from '../../interaction/shared/placement/snapping/supportPathTargets';
import { useKickstandStoreState } from '../Kickstand/kickstandStore';
import { projectPointToSnapTargetPath, projectRayToSnapTargetPath, selectNearestPathTarget } from '../../interaction/shared/placement/snapping/pathProjection';

interface ShaftHoverDetail {
    segmentId?: string | null;
    point?: Vec3 | null;
}

export function LeafPlacementController() {
    const { isActive, stage, tipPosition, surfaceNormal, modelId } = useLeafPlacementState();
    const supportState = useSyncExternalStore(subscribe, getSnapshot);
    const kickstandState = useKickstandStoreState();
    const { getHotkey } = useHotkeyConfig();
    const leafBinding = getHotkey('SUPPORTS', 'LEAF_PLACEMENT');

    const { raycaster, camera, pointer, scene } = useThree();
    const modelMeshesRef = useRef<THREE.Object3D[]>([]);
    const hoveredShaftRef = useRef<ShaftHoverDetail | null>(null);
    const rearmFrameRef = useRef<number | null>(null);

    useEffect(() => {
        const meshes: THREE.Object3D[] = [];
        scene.traverse((obj) => {
            const objModelId = obj.userData?.modelId;
            if (!objModelId) return;
            if (modelId === 'unknown' || objModelId === modelId) meshes.push(obj);
        });
        modelMeshesRef.current = meshes;
        return () => {
            modelMeshesRef.current = [];
        };
    }, [scene, modelId]);

    const allTargets = useMemo(() => {
        if (stage !== 'awaitingBase') return [];

        return [
            ...buildSupportPathSnapTargets(supportState, {
                includeTrunks: true,
                includeBranches: true,
                includeBraces: true,
            }),
            ...buildKickstandPathSnapTargets(kickstandState),
        ];
    }, [stage, supportState, kickstandState]);

    const targetById = useMemo(() => {
        return buildPrimarySnapTargetIndex(allTargets);
    }, [allTargets]);

    const getTarget = useCallback((id: string): SnapTarget | null => {
        return targetById.get(id) ?? null;
    }, [targetById]);

    const getPotentialTargets = useCallback(() => allTargets, [allTargets]);

    const { updateAndGetResolvedSnap, resetSnapping } = usePlacementSnappingSession(getTarget, getPotentialTargets);

    useEffect(() => {
        const handleShaftHover = (event: Event) => {
            const detail = (event as CustomEvent<ShaftHoverDetail>).detail;
            if (!detail?.segmentId) return;
            hoveredShaftRef.current = {
                segmentId: detail.segmentId,
                point: detail.point ?? null,
            };
        };

        const handleShaftLeave = (event: Event) => {
            const detail = (event as CustomEvent<{ segmentId?: string | null }>).detail;
            if (!detail?.segmentId) {
                hoveredShaftRef.current = null;
                return;
            }

            if (hoveredShaftRef.current?.segmentId === detail.segmentId) {
                hoveredShaftRef.current = null;
            }
        };

        window.addEventListener('shaft-hover', handleShaftHover as EventListener);
        window.addEventListener('shaft-leave', handleShaftLeave as EventListener);

        return () => {
            window.removeEventListener('shaft-hover', handleShaftHover as EventListener);
            window.removeEventListener('shaft-leave', handleShaftLeave as EventListener);
            hoveredShaftRef.current = null;
        };
    }, []);

    useEffect(() => {
        return () => {
            if (rearmFrameRef.current !== null) {
                cancelAnimationFrame(rearmFrameRef.current);
                rearmFrameRef.current = null;
            }
        };
    }, []);

    useFrame(() => {
        if (isContactDiskHudInteractionActive() || shouldSuppressContactDiskHudPlacementCommit()) {
            leafPlacementStore.setHoverPosition(null);
            leafPlacementStore.setPreviewData(null);
            leafPlacementStore.setSnapTarget(null);
            return;
        }

        // Read directly from the store to avoid stale closure during rearm.
        const snap = leafPlacementStore.getSnapshot();
        const liveActive = snap.hotkeyActive || snap.stage === 'awaitingBase';
        const liveStage = snap.stage;

        if (liveActive && liveStage === 'idle') {
            raycaster.setFromCamera(pointer, camera);
            const modelMeshes = modelMeshesRef.current;
            if (modelMeshes.length > 0) {
                const intersects = raycaster.intersectObjects(modelMeshes, true);
                if (intersects.length > 0) {
                    const hit = intersects[0];
                    leafPlacementStore.setHoverPosition({ x: hit.point.x, y: hit.point.y, z: hit.point.z });
                } else {
                    leafPlacementStore.setHoverPosition(null);
                }
            } else {
                leafPlacementStore.setHoverPosition(null);
            }
            return;
        }

        if (!liveActive || liveStage !== 'awaitingBase' || !tipPosition || !surfaceNormal) {
            return;
        }

        raycaster.setFromCamera(pointer, camera);

        const resolvedSnap = updateAndGetResolvedSnap();

        let knotPos: Vec3 | null = null;
        let segmentId = 'free';
        let hostDiameterMm: number | undefined = undefined;
        let t: number | undefined = undefined;

        if (resolvedSnap.state === 'locked' && resolvedSnap.targetId && resolvedSnap.snappedPos && resolvedSnap.t !== null) {
            knotPos = resolvedSnap.snappedPos;
            t = resolvedSnap.t;

            segmentId = resolvedSnap.targetId;

            const target = getTarget(resolvedSnap.targetId);
            if (target?.pathSegment?.radius !== undefined) {
                hostDiameterMm = target.pathSegment.radius * 2;
            }

            // If snapped to a brace, compute local tapered host diameter.
            if (resolvedSnap.targetId.startsWith('braceSegment:')) {
                const braceId = resolvedSnap.targetId.slice('braceSegment:'.length);
                const brace = supportState.braces[braceId];
                const startKnot = brace ? supportState.knots[brace.startKnotId] : undefined;
                const endKnot = brace ? supportState.knots[brace.endKnotId] : undefined;

                if (brace && startKnot && endKnot) {
                    const startDia = Math.max(
                        0.001,
                        (startKnot.diameter ?? brace.profile.diameter) - JOINT_DIAMETER_OFFSET_MM
                    );
                    const endDia = Math.max(
                        0.001,
                        (endKnot.diameter ?? brace.profile.diameter) - JOINT_DIAMETER_OFFSET_MM
                    );
                    hostDiameterMm = THREE.MathUtils.lerp(startDia, endDia, resolvedSnap.t);
                }
            }

            leafPlacementStore.setSnapTarget({
                targetId: resolvedSnap.targetId,
                snappedPos: resolvedSnap.snappedPos,
                t,
                hostDiameterMm,
                hostSegmentId: segmentId,
            });
        } else {
            let hoveredSnapResolved = false;
            const hoveredShaft = hoveredShaftRef.current;

            if (hoveredShaft?.segmentId) {
                const pathCandidates = allTargets.filter((target) => target.id === hoveredShaft.segmentId && !!target.pathSegment);
                const hoveredTarget = (hoveredShaft.point && pathCandidates.length > 1)
                    ? selectNearestPathTarget(hoveredShaft.point, pathCandidates) ?? pathCandidates[0]
                    : pathCandidates[0] ?? getTarget(hoveredShaft.segmentId);

                const projected = hoveredTarget
                    ? (hoveredShaft.point
                        ? projectPointToSnapTargetPath(hoveredTarget, hoveredShaft.point)
                        : projectRayToSnapTargetPath(raycaster.ray, hoveredTarget))
                    : null;

                if (hoveredTarget?.pathSegment && projected) {
                    hoveredSnapResolved = true;
                    segmentId = hoveredShaft.segmentId;
                    knotPos = projected.pos;
                    t = projected.t;
                    hostDiameterMm = hoveredTarget.pathSegment.radius * 2;

                    if (segmentId.startsWith('braceSegment:')) {
                        const braceId = segmentId.slice('braceSegment:'.length);
                        const brace = supportState.braces[braceId];
                        const startKnot = brace ? supportState.knots[brace.startKnotId] : undefined;
                        const endKnot = brace ? supportState.knots[brace.endKnotId] : undefined;

                        if (brace && startKnot && endKnot) {
                            const startDia = Math.max(
                                0.001,
                                (startKnot.diameter ?? brace.profile.diameter) - JOINT_DIAMETER_OFFSET_MM
                            );
                            const endDia = Math.max(
                                0.001,
                                (endKnot.diameter ?? brace.profile.diameter) - JOINT_DIAMETER_OFFSET_MM
                            );
                            hostDiameterMm = THREE.MathUtils.lerp(startDia, endDia, projected.t);
                        }
                    }

                    leafPlacementStore.setSnapTarget({
                        targetId: segmentId,
                        snappedPos: knotPos,
                        t,
                        hostDiameterMm,
                        hostSegmentId: segmentId,
                    });
                }
            }

            if (!hoveredSnapResolved) {
                const modelMeshes = modelMeshesRef.current;

                if (modelMeshes.length > 0) {
                    const intersects = raycaster.intersectObjects(modelMeshes, true);
                    if (intersects.length > 0) {
                        const hit = intersects[0];
                        knotPos = { x: hit.point.x, y: hit.point.y, z: hit.point.z };
                    }
                }

                if (!knotPos) {
                    const buildPlate = new THREE.Plane(new THREE.Vector3(0, 0, 1), 0);
                    const intersection = new THREE.Vector3();
                    if (raycaster.ray.intersectPlane(buildPlate, intersection)) {
                        const dist = Math.sqrt(
                            Math.pow(intersection.x - tipPosition.x, 2) +
                            Math.pow(intersection.y - tipPosition.y, 2)
                        );
                        if (dist < 100) {
                            knotPos = { x: intersection.x, y: intersection.y, z: 0 };
                        }
                    }
                }

                leafPlacementStore.setSnapTarget(null);
            }
        }

        if (knotPos) {
            const settings = getSettings();
            const fallbackHostDiameterMm = settings.shaft.diameterMm;
            const resolvedHostDiameter = hostDiameterMm ?? fallbackHostDiameterMm;

            const parentKnot: Knot = {
                id: 'preview-knot',
                parentShaftId: segmentId,
                t,
                pos: knotPos,
                diameter: resolvedHostDiameter + 0.1,
            };

            const buildResult = buildLeafData({
                tipPos: tipPosition,
                surfaceNormal,
                modelId,
                parentKnot,
                hostDiameterMm: resolvedHostDiameter,
            });

            const maxAngleDeg = settings.shaft.maxAngleDeg ?? 80;
            const tip = new THREE.Vector3(tipPosition.x, tipPosition.y, tipPosition.z);
            const knot = new THREE.Vector3(knotPos.x, knotPos.y, knotPos.z);
            const v = new THREE.Vector3().subVectors(tip, knot);
            const lenSq = v.lengthSq();
            const angleFromUpDeg = lenSq < 0.000001 ? 0 : THREE.MathUtils.radToDeg(v.angleTo(new THREE.Vector3(0, 0, 1)));

            const epsilonZ = 0.0001;
            const knotAboveTip = knotPos.z > tipPosition.z + epsilonZ;
            const tooFlat = angleFromUpDeg > maxAngleDeg;

            const previewData: SupportData = {
                ...buildResult.supportData,
                angle: angleFromUpDeg,
                error: knotAboveTip ? 'KNOT_ABOVE_TIP' : undefined,
                warning: !knotAboveTip && tooFlat ? 'SHAFT_ANGLE_TOO_FLAT' : undefined,
            };

            leafPlacementStore.setPreviewData(previewData);
        } else {
            leafPlacementStore.setPreviewData(null);
        }
    });

    useEffect(() => {
        if (!isActive || stage !== 'awaitingBase') return;

        const handleClick = (e: MouseEvent) => {
            if (shouldSuppressContactDiskHudPlacementCommit()) {
                e.stopPropagation();
                e.preventDefault();
                return;
            }
            const snapTarget = leafPlacementStore.getSnapTarget();
            if (!snapTarget || !tipPosition || !surfaceNormal) return;

            if (snapTarget.t === undefined) return;

            const knotId = generateUuid();
            const segmentId = snapTarget.targetId;
            const hostDiameterMm = snapTarget.hostDiameterMm;

            if (!hostDiameterMm) return;

            const parentKnot: Knot = {
                id: knotId,
                parentShaftId: segmentId,
                t: snapTarget.t,
                pos: snapTarget.snappedPos,
                diameter: hostDiameterMm + 0.1,
            };

            const settings = getSettings();
            const maxAngleDeg = settings.shaft.maxAngleDeg ?? 80;
            const v = new THREE.Vector3(
                tipPosition.x - parentKnot.pos.x,
                tipPosition.y - parentKnot.pos.y,
                tipPosition.z - parentKnot.pos.z
            );
            const angleFromUpDeg = v.lengthSq() < 0.000001 ? 0 : THREE.MathUtils.radToDeg(v.angleTo(new THREE.Vector3(0, 0, 1)));

            const epsilonZ = 0.0001;
            if (parentKnot.pos.z > tipPosition.z + epsilonZ) return;
            if (angleFromUpDeg > maxAngleDeg) return;

            const { leaf } = buildLeafData({
                tipPos: tipPosition,
                surfaceNormal,
                modelId,
                parentKnot,
                hostDiameterMm,
            });

            addKnot(parentKnot);
            addLeaf(leaf);

            pushHistory({
                type: SUPPORT_ADD_LEAF,
                payload: {
                    leaf,
                    knot: parentKnot,
                },
            });

            leafPlacementStore.finalize();
            leafPlacementStore.reset();
            if (
                canResolveSupportPlacementBindingFromModifierState(leafBinding)
                && isSupportPlacementBindingSatisfiedByModifierState(leafBinding, getSupportPlacementModifierState(e))
            ) {
                leafPlacementStore.setHotkeyActive(false);
                if (rearmFrameRef.current !== null) {
                    cancelAnimationFrame(rearmFrameRef.current);
                }
                rearmFrameRef.current = requestAnimationFrame(() => {
                    rearmFrameRef.current = null;
                    window.dispatchEvent(new Event(LEAF_HOTKEY_REARM_EVENT));
                });
            }
            clearSupportSelection();

            e.stopPropagation();
            e.preventDefault();
        };

        window.addEventListener('click', handleClick, true);
        return () => window.removeEventListener('click', handleClick, true);
    }, [isActive, stage, tipPosition, surfaceNormal, modelId, leafBinding]);

    useEffect(() => {
        if (!isActive) {
            hoveredShaftRef.current = null;
            leafPlacementStore.setHoverPosition(null);
            leafPlacementStore.setPreviewData(null);
            leafPlacementStore.setSnapTarget(null);
            resetSnapping();
        }
    }, [isActive, resetSnapping]);

    return null;
}
