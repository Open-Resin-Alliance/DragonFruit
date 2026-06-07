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
import { resolveTwigDiameterAtSegmentT, twigJointDiameterForLocalDiameter } from '../Twig/twigTaper';
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
import { isSupportEditInteractionActive } from '../../interaction/gizmoInteractionLock';
import { previewVecKey, previewNormalKey, quantizePreviewValue } from '../shared/previewSignature';
import { getClipBounds } from '@/components/scene/SceneCanvas/clipBoundsStore';
import { findClosestMeshToPoint } from '../../PlacementLogic/PlacementUtils';

interface ShaftHoverDetail {
    segmentId?: string | null;
    point?: Vec3 | null;
}

// Pooled scratch objects — reused each frame to avoid per-frame GC pressure.
const _buildPlate = new THREE.Plane();
const _upVec = new THREE.Vector3();
const _planeHit = new THREE.Vector3();

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
    const supportEditSuppressedRef = useRef(false);
    const lastPreviewSignatureRef = useRef<string | null>(null);

    useEffect(() => {
        const meshes: THREE.Object3D[] = [];
        scene.traverse((obj) => {
            const objModelId = obj.userData?.modelId;
            if (!objModelId) return;
            if (modelId !== 'unknown' && objModelId !== modelId) return;
            const mesh = obj as THREE.Mesh;
            if (!mesh.isMesh || !mesh.geometry) return;
            meshes.push(mesh);
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
                includeTwigs: true,
            }),
            ...buildKickstandPathSnapTargets(kickstandState),
        ];
    }, [
        stage,
        supportState.trunks,
        supportState.branches,
        supportState.braces,
        supportState.twigs,
        kickstandState.kickstands,
    ]);

    const targetById = useMemo(() => {
        return buildPrimarySnapTargetIndex(allTargets);
    }, [allTargets]);

    // Reverse lookup: twig segment id → owning twig. Used to resolve a Leaf's
    // base diameter against the twig's continuous taper as the knot slides.
    const twigBySegmentId = useMemo(() => {
        const map = new Map<string, typeof supportState.twigs[string]>();
        for (const twig of Object.values(supportState.twigs)) {
            for (const seg of twig.segments) {
                map.set(seg.id, twig);
            }
        }
        return map;
    }, [supportState.twigs]);

    const getTarget = useCallback((id: string): SnapTarget | null => {
        return targetById.get(id) ?? null;
    }, [targetById]);

    const getPotentialTargets = useCallback(() => allTargets, [allTargets]);

    const { updateAndGetResolvedSnap, resetSnapping } = usePlacementSnappingSession(getTarget, getPotentialTargets);

    const resolveTipMesh = useCallback(() => {
        if (!tipPosition) return undefined;
        return findClosestMeshToPoint(tipPosition, modelMeshesRef.current);
    }, [tipPosition]);

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

        if (isSupportEditInteractionActive()) {
            if (!supportEditSuppressedRef.current) {
                supportEditSuppressedRef.current = true;
                leafPlacementStore.setHoverPosition(null);
                leafPlacementStore.setPreviewData(null);
                leafPlacementStore.setSnapTarget(null);
                resetSnapping();
            }
            return;
        }

        supportEditSuppressedRef.current = false;

        // Read directly from the store to avoid stale closure during rearm.
        const snap = leafPlacementStore.getSnapshot();
        const liveActive = snap.hotkeyActive || snap.stage === 'awaitingBase';
        const liveStage = snap.stage;

        if (liveActive && liveStage === 'idle') {
            // Hover dot is updated immediately by useLeafPlacement.onModelHover.
            // Skip redundant per-frame mesh raycasts to reduce cursor trailing.
            return;
        }

        if (!liveActive || liveStage !== 'awaitingBase' || !tipPosition || !surfaceNormal) {
            lastPreviewSignatureRef.current = null;
            return;
        }

        raycaster.setFromCamera(pointer, camera);

        // Fast path: when shaft-hover already provides segment+point, skip
        // the heavier global snapping pass for this frame.
        const hasHoveredShaftFastPath = !!(hoveredShaftRef.current?.segmentId && hoveredShaftRef.current?.point);
        const resolvedSnap = hasHoveredShaftFastPath
            ? { state: 'none' as const, targetId: null, snappedPos: null, t: null, metadata: null }
            : updateAndGetResolvedSnap();

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

            // If snapped to a twig segment, resolve the twig's continuous
            // disk-A→disk-B taper at this exact slide position.
            const snappedTwig = twigBySegmentId.get(resolvedSnap.targetId);
            if (snappedTwig) {
                const twigDia = resolveTwigDiameterAtSegmentT(snappedTwig, resolvedSnap.targetId, resolvedSnap.t);
                if (twigDia !== null) hostDiameterMm = twigDia;
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

                    const hoveredTwig = twigBySegmentId.get(segmentId);
                    if (hoveredTwig) {
                        const twigDia = resolveTwigDiameterAtSegmentT(hoveredTwig, segmentId, projected.t);
                        if (twigDia !== null) hostDiameterMm = twigDia;
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
                    const intersects = raycaster.intersectObjects(modelMeshes, false);
                    if (intersects.length > 0) {
                        let hit = intersects[0];

                        // Skip hits in the clipped (hidden) zone to find the
                        // visible inner wall in cross-section view.
                        const { clipLower: cl, clipUpper: cu } = getClipBounds();
                        const isClipped =
                          (cu != null && hit.point.z > cu) ||
                          (cl != null && hit.point.z < cl);
                        if (isClipped) {
                            let fallback: THREE.Intersection | null = null;
                            for (let i = 1; i < intersects.length; i++) {
                                const h = intersects[i];
                                if (cu != null && h.point.z > cu) continue;
                                if (cl != null && h.point.z < cl) continue;
                                fallback = h;
                                break;
                            }
                            if (fallback) hit = fallback;
                            else hit = null as any;
                        }

                        if (hit) {
                            knotPos = { x: hit.point.x, y: hit.point.y, z: hit.point.z };
                        }
                    }
                }

                if (!knotPos) {
                    _buildPlate.set(_upVec.set(0, 0, 1), 0);
                    if (raycaster.ray.intersectPlane(_buildPlate, _planeHit)) {
                        const dx = _planeHit.x - tipPosition.x;
                        const dy = _planeHit.y - tipPosition.y;
                        const dist = Math.sqrt(dx * dx + dy * dy);
                        if (dist < 100) {
                            knotPos = { x: _planeHit.x, y: _planeHit.y, z: 0 };
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

            const previewSignature = [
                'leaf',
                modelId,
                segmentId,
                previewVecKey(knotPos),
                quantizePreviewValue(t ?? 0),
                quantizePreviewValue(resolvedHostDiameter),
                previewVecKey(tipPosition),
                previewNormalKey(surfaceNormal),
            ].join('|');

            if (lastPreviewSignatureRef.current !== previewSignature) {
                lastPreviewSignatureRef.current = previewSignature;

                // On a twig, the parent knot is 10% larger than the local
                // tapered diameter (matching the disk-end joint rule). On
                // other hosts, the legacy +0.1mm offset is used. For the
                // placement preview specifically, take whichever yields the
                // larger ball so the visual feedback is consistently visible
                // even on thin twig ends where 10% adds barely a fraction.
                const previewKnotIsOnTwig = !!twigBySegmentId.get(segmentId);
                const previewKnotDiameter = previewKnotIsOnTwig
                    ? Math.max(
                        twigJointDiameterForLocalDiameter(resolvedHostDiameter),
                        resolvedHostDiameter + 0.1,
                    )
                    : resolvedHostDiameter + 0.1;

                const parentKnot: Knot = {
                    id: 'preview-knot',
                    parentShaftId: segmentId,
                    t,
                    pos: knotPos,
                    diameter: previewKnotDiameter,
                };

                const buildResult = buildLeafData({
                    tipPos: tipPosition,
                    surfaceNormal,
                    modelId,
                    parentKnot,
                    hostDiameterMm: resolvedHostDiameter,
                    mesh: resolveTipMesh(),
                });

                const maxAngleDeg = settings.shaft.maxAngleDeg ?? 80;
                const vx = tipPosition.x - knotPos.x;
                const vy = tipPosition.y - knotPos.y;
                const vz = tipPosition.z - knotPos.z;
                const lenSq = vx * vx + vy * vy + vz * vz;
                const angleFromUpDeg = lenSq < 0.000001
                    ? 0
                    : THREE.MathUtils.radToDeg(Math.acos(Math.min(1, Math.max(-1, vz / Math.sqrt(lenSq)))));

                const epsilonZ = 0.0001;
                const knotAboveTip = knotPos.z > tipPosition.z + epsilonZ;
                const tooFlat = angleFromUpDeg > maxAngleDeg;

                // Don't pass `angle` here: it triggers the orange→yellow→green
                // surface-steepness gradient (calibrated for trunks). For leaves,
                // the angle is already validated via tooFlat→warning, so the
                // preview should fall through to the standard green / yellow /
                // red error states like other knot placements.
                leafPlacementStore.setPreviewData({
                    ...buildResult.supportData,
                    error: knotAboveTip ? 'KNOT_ABOVE_TIP' : undefined,
                    warning: !knotAboveTip && tooFlat ? 'SHAFT_ANGLE_TOO_FLAT' : undefined,
                });
            }
        } else {
            if (lastPreviewSignatureRef.current !== 'leaf:clear') {
                lastPreviewSignatureRef.current = 'leaf:clear';
                leafPlacementStore.setPreviewData(null);
            }
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

            const committedKnotIsOnTwig = !!twigBySegmentId.get(segmentId);
            const committedKnotDiameter = committedKnotIsOnTwig
                ? twigJointDiameterForLocalDiameter(hostDiameterMm)
                : hostDiameterMm + 0.1;

            const parentKnot: Knot = {
                id: knotId,
                parentShaftId: segmentId,
                t: snapTarget.t,
                pos: snapTarget.snappedPos,
                diameter: committedKnotDiameter,
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
                mesh: resolveTipMesh(),
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
    }, [isActive, stage, tipPosition, surfaceNormal, modelId, leafBinding, resolveTipMesh]);

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
