/**
 * BranchPlacementController
 * 
 * This component runs INSIDE the Canvas and handles:
 * 1. Snapping to shaft segments using SnappingManager
 * 2. Continuous preview updates via useFrame
 * 3. Click handling for branch creation
 * 
 * The preview shows the branch with:
 * - TIP fixed at the model click point
 * - KNOT following the mouse (or snapped to shaft when nearby)
 * 
 * It reads state from branchPlacementStore and updates preview data.
 */

import { useEffect, useCallback, useMemo, useRef, useSyncExternalStore } from 'react';
import { useFrame, useThree } from '@react-three/fiber';
import * as THREE from 'three';
import { useHotkeyConfig } from '@/hotkeys/HotkeyContext';
import { matchesConfiguredHotkeyUp } from '@/hotkeys/hotkeyConfig';
import { subscribe, getSnapshot, addBranch, addKnot, addTwig, addStick } from '../../state';
import { pushHistory } from '@/history/historyStore';
import { SUPPORT_ADD_BRANCH, SUPPORT_ADD_TWIG, SUPPORT_ADD_STICK } from '../../history/actionTypes';
import { SnapTarget } from '../../interaction/SnappingManager';
import { Vec3, Knot } from '../../types';
import { getSettings } from '../../Settings/state';
import { JOINT_DIAMETER_OFFSET_MM } from '../../constants';
import { buildBranchData } from './branchBuilder';
import { branchPlacementStore, useBranchPlacementState } from './branchPlacementState';
import { calculateSmoothedNormal } from '../../PlacementLogic/PlacementUtils';
import { buildTwig } from '../Twig/twigBuilder';
import { buildStick } from '../Stick/stickBuilder';
import type { SupportData } from '../../rendering/SupportBuilder';
import { generateUuid } from '@/utils/uuid';
import { isContactDiskHudInteractionActive, shouldSuppressContactDiskHudPlacementCommit } from '../../SupportPrimitives/ContactDisk/contactDiskHudInteraction';
import { clearSupportSelection } from '../../interaction/shared/selection/selectionController';
import { useImmediateModelHoverId } from '../../interaction/useInteractionStatus';
import { canResolveSupportPlacementBindingFromModifierState, getSupportPlacementModifierState, isSupportPlacementBindingSatisfiedByModifierState } from '../../interaction/shared/placement/hotkeys/supportPlacementHotkeyResolver';
import { isSupportTargetHoverCategory } from '../../interaction/shared/hover/supportHoverResolver';
import { usePlacementSnappingSession } from '../../interaction/shared/placement/snapping/usePlacementSnappingSession';
import { buildPrimarySnapTargetIndex, buildSupportPathSnapTargets } from '../../interaction/shared/placement/snapping/supportPathTargets';
import { projectPointToSnapTargetPath, selectNearestPathTarget } from '../../interaction/shared/placement/snapping/pathProjection';

interface ShaftHoverDetail {
    segmentId?: string | null;
    point?: Vec3 | null;
}

export function BranchPlacementController() {
    const { isActive, altActive, stage, tipPosition, tipNormal, modelId } = useBranchPlacementState();
    const supportState = useSyncExternalStore(subscribe, getSnapshot);
    const immediateModelHoverId = useImmediateModelHoverId();
    const { getHotkey } = useHotkeyConfig();
    const branchFamilyBinding = getHotkey('SUPPORTS', 'BRANCH_PLACEMENT');
    const rawHoveringSupportTarget = isSupportTargetHoverCategory(supportState.hoveredCategory);
    const isHoveringSupportTarget = rawHoveringSupportTarget && immediateModelHoverId === null;

    const meshHoverRef = useRef<{ pos: Vec3; normal: Vec3; modelId: string } | null>(null);
    const meshKindRef = useRef<'twig' | 'stick' | null>(null);
    const hoveredShaftRef = useRef<ShaftHoverDetail | null>(null);
    const pointerFreshSinceIdleActivationRef = useRef(false);

    const modelMeshesRef = useRef<THREE.Object3D[]>([]);

    const { raycaster, camera, pointer, gl, scene } = useThree();

    useEffect(() => {
        if (!altActive) return;
        const el = gl.domElement;
        if (typeof el.focus === 'function') {
            el.focus();
        }
    }, [altActive, gl]);

    useEffect(() => {
        if (!altActive) {
            pointerFreshSinceIdleActivationRef.current = false;
            hoveredShaftRef.current = null;
            meshHoverRef.current = null;
            meshKindRef.current = null;
            return;
        }

        if (stage === 'idle') {
            pointerFreshSinceIdleActivationRef.current = false;
            hoveredShaftRef.current = null;
            meshHoverRef.current = null;
            meshKindRef.current = null;
        }
    }, [altActive, stage]);

    useEffect(() => {
        const el = gl.domElement;

        const markFreshPointer = () => {
            if (!altActive || stage !== 'idle') return;
            pointerFreshSinceIdleActivationRef.current = true;
        };

        el.addEventListener('pointermove', markFreshPointer, true);
        el.addEventListener('pointerdown', markFreshPointer, true);

        return () => {
            el.removeEventListener('pointermove', markFreshPointer, true);
            el.removeEventListener('pointerdown', markFreshPointer, true);
        };
    }, [gl, altActive, stage]);

    useEffect(() => {
        if (!altActive && stage === 'idle') {
            modelMeshesRef.current = [];
            return;
        }

        const meshes: THREE.Object3D[] = [];
        scene.traverse((obj) => {
            const objModelId = obj.userData?.modelId;
            if (!objModelId) return;
            if (modelId === 'unknown' || objModelId === modelId) meshes.push(obj);
        });
        modelMeshesRef.current = meshes;
    }, [scene, modelId, altActive, stage]);

    // Pre-calculate all snap targets from trunk and branch segments
    const allTargets = useMemo(() => {
        if (stage !== 'awaitingBase') return [];

        return buildSupportPathSnapTargets(supportState, {
            includeTrunks: true,
            includeBranches: true,
            includeBraces: true,
        });
    }, [stage, supportState]);

    const targetById = useMemo(() => {
        return buildPrimarySnapTargetIndex(allTargets);
    }, [allTargets]);

    const getTarget = useCallback((id: string): SnapTarget | null => {
        return targetById.get(id) ?? null;
    }, [targetById]);

    const getPotentialTargets = useCallback(() => allTargets, [allTargets]);

    const { updateAndGetResolvedSnap, resetSnapping } = usePlacementSnappingSession(getTarget, getPotentialTargets);

    // Fallback: pointer events inside the canvas may not reach window listeners.
    // If Alt is released but keyup is missed, pointer events still report modifier state.
    useEffect(() => {
        const el = gl.domElement;
        const modifierResolvable = canResolveSupportPlacementBindingFromModifierState(branchFamilyBinding);

        const checkAlt = (e: PointerEvent) => {
            if (!modifierResolvable) return;
            if (isSupportPlacementBindingSatisfiedByModifierState(branchFamilyBinding, getSupportPlacementModifierState(e))) return;

            const snapshot = branchPlacementStore.getSnapshot();
            if (snapshot.altActive || snapshot.stage === 'awaitingBase') {
                branchPlacementStore.setAltActive(false);
                branchPlacementStore.setPreviewData(null);
                branchPlacementStore.setSnapTarget(null);
                branchPlacementStore.reset();
                resetSnapping();
            }
        };

        const keyUp = (e: KeyboardEvent) => {
            if (!matchesConfiguredHotkeyUp(e, branchFamilyBinding)) return;

            const snapshot = branchPlacementStore.getSnapshot();
            if (snapshot.altActive || snapshot.stage === 'awaitingBase') {
                branchPlacementStore.setAltActive(false);
                branchPlacementStore.setPreviewData(null);
                branchPlacementStore.setSnapTarget(null);
                branchPlacementStore.setHoverPosition(null);
                branchPlacementStore.reset();
                resetSnapping();
            }
        };

        el.addEventListener('pointermove', checkAlt, true);
        el.addEventListener('pointerdown', checkAlt, true);
        el.addEventListener('pointerup', checkAlt, true);
        el.addEventListener('keyup', keyUp, true);
        return () => {
            el.removeEventListener('pointermove', checkAlt, true);
            el.removeEventListener('pointerdown', checkAlt, true);
            el.removeEventListener('pointerup', checkAlt, true);
            el.removeEventListener('keyup', keyUp, true);
        };
    }, [gl, branchFamilyBinding, resetSnapping]);

    // Fallback: some environments can miss Alt keyup while hovering interactive canvas content.
    // Ensure we cancel immediately on any observed Alt release.
    useEffect(() => {
        const handleKeyUp = (e: KeyboardEvent) => {
            if (!matchesConfiguredHotkeyUp(e, branchFamilyBinding)) return;

            const snapshot = branchPlacementStore.getSnapshot();
            if (snapshot.altActive || snapshot.stage === 'awaitingBase') {
                branchPlacementStore.setAltActive(false);
                branchPlacementStore.setPreviewData(null);
                branchPlacementStore.setSnapTarget(null);
                branchPlacementStore.reset();
                resetSnapping();
            }
        };

        window.addEventListener('keyup', handleKeyUp, true);
        return () => window.removeEventListener('keyup', handleKeyUp, true);
    }, [branchFamilyBinding, resetSnapping]);

    useEffect(() => {
        const handleShaftHover = (event: Event) => {
            const detail = (event as CustomEvent<ShaftHoverDetail>).detail;
            if (!detail?.segmentId || !detail.point) return;
            hoveredShaftRef.current = {
                segmentId: detail.segmentId,
                point: detail.point,
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

    // Continuous update loop - show preview when mouse is over something valid
    useFrame(() => {
        if (isContactDiskHudInteractionActive() || shouldSuppressContactDiskHudPlacementCommit()) {
            branchPlacementStore.setHoverPosition(null);
            branchPlacementStore.setPreviewData(null);
            branchPlacementStore.setSnapTarget(null);
            meshHoverRef.current = null;
            meshKindRef.current = null;
            return;
        }

        if (altActive && stage === 'idle') {
            if (!pointerFreshSinceIdleActivationRef.current) {
                branchPlacementStore.setHoverPosition(null);
                return;
            }

            if (isHoveringSupportTarget) {
                branchPlacementStore.setHoverPosition(null);
                return;
            }

            raycaster.setFromCamera(pointer, camera);
            const modelMeshes = modelMeshesRef.current;
            if (modelMeshes.length > 0) {
                const intersects = raycaster.intersectObjects(modelMeshes, true);
                if (intersects.length > 0) {
                    const hit = intersects[0];
                    branchPlacementStore.setHoverPosition({ x: hit.point.x, y: hit.point.y, z: hit.point.z });
                } else {
                    branchPlacementStore.setHoverPosition(null);
                }
            } else {
                branchPlacementStore.setHoverPosition(null);
            }
            return;
        }

        if (!isActive || stage !== 'awaitingBase' || !tipPosition || !tipNormal) {
            return;
        }

        // Update raycaster for mouse position
        raycaster.setFromCamera(pointer, camera);

        // Try to snap to a shaft first
        const resolvedSnap = updateAndGetResolvedSnap();

        const settings = getSettings();
        const fallbackHostDiameterMm = settings.shaft.diameterMm;

        let knotPos: Vec3 | null = null;
        let segmentId = 'free';
        let hostDiameterMm: number | undefined = undefined;
        let t: number | undefined = undefined;

        if (resolvedSnap.state === 'locked' && resolvedSnap.targetId && resolvedSnap.snappedPos && resolvedSnap.t !== null) {
            meshHoverRef.current = null;
            meshKindRef.current = null;
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

            branchPlacementStore.setSnapTarget({
                targetId: resolvedSnap.targetId,
                snappedPos: resolvedSnap.snappedPos,
                t: resolvedSnap.t,
                hostDiameterMm,
                hostSegmentId: segmentId,
            });
        } else {
            let hoveredSnapResolved = false;
            const hoveredShaft = hoveredShaftRef.current;

            if (hoveredShaft?.segmentId && hoveredShaft.point) {
                const pathCandidates = allTargets.filter((target) => target.id === hoveredShaft.segmentId && !!target.pathSegment);
                const hoveredTarget = pathCandidates.length > 1
                    ? selectNearestPathTarget(hoveredShaft.point, pathCandidates) ?? pathCandidates[0]
                    : pathCandidates[0] ?? getTarget(hoveredShaft.segmentId);

                const projected = hoveredTarget ? projectPointToSnapTargetPath(hoveredTarget, hoveredShaft.point) : null;

                if (hoveredTarget?.pathSegment && projected) {
                    hoveredSnapResolved = true;
                    meshHoverRef.current = null;
                    meshKindRef.current = null;

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

                    branchPlacementStore.setSnapTarget({
                        targetId: segmentId,
                        snappedPos: knotPos,
                        t,
                        hostDiameterMm,
                        hostSegmentId: segmentId,
                    });
                }
            }

            if (!hoveredSnapResolved) {
                branchPlacementStore.setSnapTarget(null);

                // Raycast the model mesh under the cursor so the second action can be mesh-to-mesh.
                const modelMeshes = modelMeshesRef.current;

                let meshHit: THREE.Intersection | null = null;
                if (modelMeshes.length > 0) {
                    const intersects = raycaster.intersectObjects(modelMeshes, true);
                    if (intersects.length > 0) {
                        meshHit = intersects[0];
                    }
                }

                if (meshHit && !isHoveringSupportTarget) {
                    const bPos: Vec3 = { x: meshHit.point.x, y: meshHit.point.y, z: meshHit.point.z };
                    const bNormal = calculateSmoothedNormal(meshHit);
                    const bModelId = meshHit.object.userData?.modelId || 'unknown';

                    // Disallow cross-model mesh-to-mesh links.
                    if (bModelId === modelId) {
                        meshHoverRef.current = { pos: bPos, normal: bNormal, modelId: bModelId };

                        const a = new THREE.Vector3(tipPosition.x, tipPosition.y, tipPosition.z);
                        const b = new THREE.Vector3(bPos.x, bPos.y, bPos.z);
                        const dist = a.distanceTo(b);
                        const cutoff = settings.meshToMesh?.stickVsTwigCutoffMm ?? 5;
                        const kind: 'twig' | 'stick' = dist > cutoff ? 'stick' : 'twig';
                        meshKindRef.current = kind;

                        if (kind === 'twig') {
                            const { twig } = buildTwig({ modelId, aPos: tipPosition, aNormal: tipNormal, bPos, bNormal });
                            const startPos = twig.segments[0]?.bottomJoint?.pos ?? tipPosition;
                            const supportData: SupportData = {
                                id: 'preview-meshlink',
                                startPos,
                                segments: twig.segments,
                                contactDisks: [twig.contactDiskA, twig.contactDiskB],
                            };
                            branchPlacementStore.setPreviewData(supportData);
                        } else {
                            const { stick } = buildStick({ modelId, aPos: tipPosition, aNormal: tipNormal, bPos, bNormal });
                            const startPos = stick.segments[0]?.bottomJoint?.pos ?? tipPosition;
                            const supportData: SupportData = {
                                id: 'preview-meshlink',
                                startPos,
                                segments: stick.segments,
                                contactCones: [stick.contactConeA, stick.contactConeB],
                            };
                            branchPlacementStore.setPreviewData(supportData);
                        }
                        return;
                    }
                }

                meshHoverRef.current = null;
                meshKindRef.current = null;
                branchPlacementStore.setPreviewData(null);
                return;
            }
        }

        if (!knotPos) {
            branchPlacementStore.setPreviewData(null);
            return;
        }

        const resolvedHostDiameter = hostDiameterMm ?? fallbackHostDiameterMm;

        const parentKnot: Knot = {
            id: 'preview-knot',
            parentShaftId: segmentId,
            t,
            pos: knotPos,
            diameter: resolvedHostDiameter + 0.1,
        };

        const buildResult = buildBranchData({
            tipPos: tipPosition,
            tipNormal: tipNormal,
            modelId: modelId,
            parentKnot,
        });

        branchPlacementStore.setPreviewData({
            ...buildResult.supportData,
            startPos: parentKnot.pos,
        });
    });

    // Handle clicks for branch creation
    useEffect(() => {
        if (!isActive || stage !== 'awaitingBase') return;

        const handleClick = (e: MouseEvent) => {
            if (shouldSuppressContactDiskHudPlacementCommit()) {
                e.stopPropagation();
                e.preventDefault();
                return;
            }
            const snapTarget = branchPlacementStore.getSnapTarget();
            if (!tipPosition || !tipNormal) return;

            // Always swallow clicks while awaiting the second action so the tip can't be reset.
            e.stopPropagation();
            e.preventDefault();

            if (!snapTarget) {
                const meshHover = meshHoverRef.current;
                const kind = meshKindRef.current;
                if (!meshHover || !kind) return;
                if (meshHover.modelId !== modelId) return;

                if (kind === 'twig') {
                    const { twig } = buildTwig({
                        modelId,
                        aPos: tipPosition,
                        aNormal: tipNormal,
                        bPos: meshHover.pos,
                        bNormal: meshHover.normal,
                    });
                    addTwig(twig);
                    pushHistory({
                        type: SUPPORT_ADD_TWIG,
                        payload: { twig },
                    });
                } else {
                    const { stick } = buildStick({
                        modelId,
                        aPos: tipPosition,
                        aNormal: tipNormal,
                        bPos: meshHover.pos,
                        bNormal: meshHover.normal,
                    });
                    addStick(stick);
                    pushHistory({
                        type: SUPPORT_ADD_STICK,
                        payload: { stick },
                    });
                }

                branchPlacementStore.finalize();
                branchPlacementStore.reset();
                meshHoverRef.current = null;
                meshKindRef.current = null;
                resetSnapping();
                clearSupportSelection();
                return;
            }

            const settings = getSettings();
            const fallbackHostDiameterMm = settings.shaft.diameterMm;
            const hostDiameterMm = snapTarget.hostDiameterMm ?? fallbackHostDiameterMm;
            if (snapTarget.t === undefined) return;

            const knotId = generateUuid();
            const segmentId = snapTarget.targetId;

            const parentKnot: Knot = {
                id: knotId,
                parentShaftId: segmentId,
                t: snapTarget.t,
                pos: snapTarget.snappedPos,
                diameter: hostDiameterMm + 0.1,
            };

            const { branch } = buildBranchData({
                tipPos: tipPosition,
                tipNormal: tipNormal,
                modelId: modelId,
                parentKnot,
            });

            console.log('[BranchPlacement] Creating branch via snap click', branch);

            addKnot(parentKnot);
            addBranch(branch);

            pushHistory({
                type: SUPPORT_ADD_BRANCH,
                payload: {
                    branch,
                    knot: parentKnot,
                },
            });

            // Use finalize() to set justFinalized flag and clear preview
            // This prevents useFrame from re-setting preview before React re-renders
            branchPlacementStore.finalize();
            branchPlacementStore.reset();
            clearSupportSelection();
        };

        window.addEventListener('click', handleClick, true);
        return () => window.removeEventListener('click', handleClick, true);
    }, [isActive, stage, tipPosition, tipNormal, modelId, resetSnapping]);

    // Reset snapping when deactivated
    useEffect(() => {
        if (!isActive) {
            resetSnapping();
        }
    }, [isActive, resetSnapping]);

    // Alt release should immediately cancel placement and clear preview/snap state
    useEffect(() => {
        if (!altActive && stage !== 'idle') {
            branchPlacementStore.setPreviewData(null);
            branchPlacementStore.setSnapTarget(null);
            branchPlacementStore.reset();
            resetSnapping();
        }
    }, [altActive, stage, resetSnapping]);

    return null; // This is a logic-only component
}
