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
import { subscribe, getSnapshot, addBranch, addKnot, addTwig, addStick } from '../../state';
import { pushHistory } from '@/history/historyStore';
import { SUPPORT_ADD_BRANCH, SUPPORT_ADD_TWIG, SUPPORT_ADD_STICK } from '../../history/actionTypes';
import { useSnapping } from '../../interaction/useSnapping';
import { SnapTarget } from '../../interaction/SnappingManager';
import { Vec3, Knot } from '../../types';
import { getSocketPosition } from '../../SupportPrimitives/ContactCone';
import { getSettings } from '../../Settings/state';
import { JOINT_DIAMETER_OFFSET_MM } from '../../constants';
import { buildBranchData } from './branchBuilder';
import { branchPlacementStore, useBranchPlacementState } from './branchPlacementState';
import { calculateSmoothedNormal } from '../../PlacementLogic/PlacementUtils';
import { buildTwig } from '../Twig/twigBuilder';
import { buildStick } from '../Stick/stickBuilder';
import type { SupportData } from '../../rendering/SupportBuilder';
import { generateUuid } from '@/utils/uuid';

export function BranchPlacementController() {
    const { isActive, altActive, stage, tipPosition, tipNormal, modelId } = useBranchPlacementState();
    const supportState = useSyncExternalStore(subscribe, getSnapshot);
    const isHoveringSupportTarget = supportState.hoveredCategory === 'support'
        || supportState.hoveredCategory === 'segment'
        || supportState.hoveredCategory === 'joint'
        || supportState.hoveredCategory === 'knot';

    const meshHoverRef = useRef<{ pos: Vec3; normal: Vec3; modelId: string } | null>(null);
    const meshKindRef = useRef<'twig' | 'stick' | null>(null);

    const modelMeshesRef = useRef<THREE.Object3D[]>([]);

    const { raycaster, camera, pointer, gl, scene } = useThree();

    useEffect(() => {
        if (!altActive) return;
        const el = gl.domElement as any;
        if (typeof el.tabIndex !== 'number') {
            el.tabIndex = -1;
        }
        if (typeof el.focus === 'function') {
            el.focus();
        }
    }, [altActive, gl]);

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

        const trunks = Object.values(supportState.trunks);
        const branches = Object.values(supportState.branches);
        const braces = Object.values(supportState.braces);
        const roots = Object.values(supportState.roots);
        const knots = Object.values(supportState.knots);
        const rootMap = new Map(roots.map(r => [r.id, r]));
        const knotMap = new Map(knots.map(k => [k.id, k]));
        const targets: SnapTarget[] = [];

        // Add trunk segments
        for (const trunk of trunks) {
            const root = rootMap.get(trunk.rootId);
            if (!root || trunk.segments.length === 0) continue;

            const diskHeight = 0.5;
            const coneHeight = root.height || 1.5;
            const startZOffset = diskHeight + coneHeight;

            const rootPos = new THREE.Vector3(root.transform.pos.x, root.transform.pos.y, root.transform.pos.z);
            let currentStart = rootPos.clone().add(new THREE.Vector3(0, 0, startZOffset));

            for (const seg of trunk.segments) {
                let endPoint: THREE.Vector3;

                if (seg.topJoint) {
                    endPoint = new THREE.Vector3(seg.topJoint.pos.x, seg.topJoint.pos.y, seg.topJoint.pos.z);
                } else if (trunk.contactCone) {
                    const socketPos = getSocketPosition(
                        trunk.contactCone.pos,
                        trunk.contactCone.normal,
                        trunk.contactCone.profile
                    );
                    endPoint = new THREE.Vector3(socketPos.x, socketPos.y, socketPos.z);
                } else {
                    endPoint = currentStart.clone().add(new THREE.Vector3(0, 0, 10));
                }

                targets.push({
                    id: seg.id,
                    type: 'path',
                    pathSegment: {
                        start: { x: currentStart.x, y: currentStart.y, z: currentStart.z },
                        end: { x: endPoint.x, y: endPoint.y, z: endPoint.z },
                        radius: seg.diameter / 2,
                        bezier: seg.type === 'bezier' ? {
                            control1: seg.controlPoint1,
                            control2: seg.controlPoint2
                        } : undefined
                    }
                });

                currentStart = endPoint;
            }
        }

        // Add branch segments
        for (const branch of branches) {
            const parentKnot = knotMap.get(branch.parentKnotId);
            if (!parentKnot || branch.segments.length === 0) continue;

            let currentStart = new THREE.Vector3(parentKnot.pos.x, parentKnot.pos.y, parentKnot.pos.z);

            for (const seg of branch.segments) {
                let endPoint: THREE.Vector3;

                if (seg.topJoint) {
                    endPoint = new THREE.Vector3(seg.topJoint.pos.x, seg.topJoint.pos.y, seg.topJoint.pos.z);
                } else if (branch.contactCone) {
                    const socketPos = getSocketPosition(
                        branch.contactCone.pos,
                        branch.contactCone.normal,
                        branch.contactCone.profile
                    );
                    endPoint = new THREE.Vector3(socketPos.x, socketPos.y, socketPos.z);
                } else {
                    endPoint = currentStart.clone().add(new THREE.Vector3(0, 0, 5));
                }

                targets.push({
                    id: seg.id,
                    type: 'path',
                    pathSegment: {
                        start: { x: currentStart.x, y: currentStart.y, z: currentStart.z },
                        end: { x: endPoint.x, y: endPoint.y, z: endPoint.z },
                        radius: seg.diameter / 2,
                        bezier: seg.type === 'bezier' ? {
                            control1: seg.controlPoint1,
                            control2: seg.controlPoint2
                        } : undefined
                    }
                });

                currentStart = endPoint;
            }
        }

        // Add brace shafts (tapered)
        for (const brace of braces) {
            const startKnot = knotMap.get(brace.startKnotId);
            const endKnot = knotMap.get(brace.endKnotId);
            if (!startKnot || !endKnot) continue;

            const startHostDia = Math.max(
                0.001,
                (startKnot.diameter ?? brace.profile.diameter) - JOINT_DIAMETER_OFFSET_MM
            );
            const endHostDia = Math.max(
                0.001,
                (endKnot.diameter ?? brace.profile.diameter) - JOINT_DIAMETER_OFFSET_MM
            );
            const radius = Math.max(startHostDia, endHostDia) / 2;

            targets.push({
                id: `braceSegment:${brace.id}`,
                type: 'path',
                pathSegment: {
                    start: startKnot.pos,
                    end: endKnot.pos,
                    radius,
                    bezier: brace.curve?.type === 'bezier' ? {
                        control1: brace.curve.controlPoint1,
                        control2: brace.curve.controlPoint2,
                    } : undefined,
                },
            });
        }

        return targets;
    }, [stage, supportState.trunks, supportState.branches, supportState.braces, supportState.roots, supportState.knots]);

    const targetById = useMemo(() => {
        const map = new Map<string, SnapTarget>();
        for (const t of allTargets) map.set(t.id, t);
        return map;
    }, [allTargets]);

    const getTarget = useCallback((id: string): SnapTarget | null => {
        return targetById.get(id) ?? null;
    }, [targetById]);

    const getPotentialTargets = useCallback(() => allTargets, [allTargets]);

    const { updateSnapping, resetSnapping } = useSnapping(getTarget, getPotentialTargets);

    // Fallback: pointer events inside the canvas may not reach window listeners.
    // If Alt is released but keyup is missed, pointer events still report modifier state.
    useEffect(() => {
        const el = gl.domElement;

        const checkAlt = (e: PointerEvent) => {
            if (e.altKey) return;

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
            const releasedAlt = e.key === 'Alt' || e.key === 'AltGraph' || e.code === 'AltLeft' || e.code === 'AltRight';
            if (!releasedAlt) return;

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
    }, [gl, resetSnapping]);

    // Fallback: some environments can miss Alt keyup while hovering interactive canvas content.
    // Ensure we cancel immediately on any observed Alt release.
    useEffect(() => {
        const handleKeyUp = (e: KeyboardEvent) => {
            const releasedAlt = e.key === 'Alt' || e.key === 'AltGraph' || e.code === 'AltLeft' || e.code === 'AltRight';
            if (!releasedAlt) return;

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
    }, [resetSnapping]);

    // Continuous update loop - show preview when mouse is over something valid
    useFrame(() => {
        if (altActive && stage === 'idle') {
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
        const result = updateSnapping();

        const settings = getSettings();
        const fallbackHostDiameterMm = settings.shaft.diameterMm;

        let knotPos: Vec3;
        let segmentId = 'free';
        let hostDiameterMm: number | undefined = undefined;
        let t: number | undefined = undefined;

        if (result.state === 'locked' && result.targetId && result.snappedPos && result.t !== undefined) {
            meshHoverRef.current = null;
            meshKindRef.current = null;
            knotPos = result.snappedPos;
            t = result.t;

            segmentId = result.targetId;

            const target = getTarget(result.targetId);
            if (target?.pathSegment?.radius !== undefined) {
                hostDiameterMm = target.pathSegment.radius * 2;
            }

            // If snapped to a brace, compute local tapered host diameter.
            if (result.targetId.startsWith('braceSegment:')) {
                const braceId = result.targetId.slice('braceSegment:'.length);
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
                    hostDiameterMm = THREE.MathUtils.lerp(startDia, endDia, result.t);
                }
            }

            branchPlacementStore.setSnapTarget({
                targetId: result.targetId,
                snappedPos: result.snappedPos,
                t: result.t,
                hostDiameterMm,
                hostSegmentId: segmentId,
            });
        } else {
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
