import { useEffect, useCallback, useMemo, useSyncExternalStore } from 'react';
import { useFrame, useThree } from '@react-three/fiber';
import * as THREE from 'three';
import { subscribe, getSnapshot, addKnot, addLeaf } from '../../state';
import { pushHistory } from '@/history/historyStore';
import { useSnapping } from '../../interaction/useSnapping';
import type { SnapTarget } from '../../interaction/SnappingManager';
import type { Vec3, Knot } from '../../types';
import { getSocketPosition } from '../../SupportPrimitives/ContactCone';
import { leafPlacementStore, useLeafPlacementState } from './leafPlacementState';
import { buildLeafData } from './leafBuilder';
import { getSettings } from '../../Settings';
import type { SupportData } from '../../rendering/SupportBuilder';
import { SUPPORT_ADD_LEAF } from '../../history/actionTypes';
import { JOINT_DIAMETER_OFFSET_MM } from '../../constants';

export function LeafPlacementController() {
    const { isActive, stage, tipPosition, surfaceNormal, modelId } = useLeafPlacementState();
    const supportState = useSyncExternalStore(subscribe, getSnapshot);

    const { raycaster, camera, pointer, scene } = useThree();
    const modelMeshesRef = useMemo(() => ({ current: [] as THREE.Object3D[] }), []);

    useEffect(() => {
        if (!isActive && stage === 'idle') {
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
    }, [scene, modelId, isActive, stage, modelMeshesRef]);

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
                            control2: seg.controlPoint2,
                        } : undefined,
                    },
                });

                currentStart = endPoint;
            }
        }

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
                    },
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

    useFrame(() => {
        if (isActive && stage === 'idle') {
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

        if (!isActive || stage !== 'awaitingBase' || !tipPosition || !surfaceNormal) {
            return;
        }

        raycaster.setFromCamera(pointer, camera);

        const result = updateSnapping();

        let knotPos: Vec3 | null = null;
        let segmentId = 'free';
        let hostDiameterMm: number | undefined = undefined;
        let t: number | undefined = undefined;

        if (result.state === 'locked' && result.targetId && result.snappedPos && result.t !== undefined) {
            knotPos = result.snappedPos;
            t = result.t;

            segmentId = result.targetId;

            const target = getTarget(result.targetId);
            if (target?.pathSegment?.radius !== undefined) {
                hostDiameterMm = target.pathSegment.radius * 2;
            }

            // If snapped to a brace, compute local tapered host diameter.
            if (result.targetId.startsWith('braceSegment:') && result.t !== undefined) {
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

            leafPlacementStore.setSnapTarget({
                targetId: result.targetId,
                snappedPos: result.snappedPos,
                t,
                hostDiameterMm,
                hostSegmentId: segmentId,
            });
        } else {
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
            const snapTarget = leafPlacementStore.getSnapTarget();
            if (!snapTarget || !tipPosition || !surfaceNormal) return;

            if (snapTarget.t === undefined) return;

            const knotId = crypto.randomUUID();
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

            e.stopPropagation();
            e.preventDefault();
        };

        window.addEventListener('click', handleClick, true);
        return () => window.removeEventListener('click', handleClick, true);
    }, [isActive, stage, tipPosition, surfaceNormal, modelId]);

    useEffect(() => {
        if (!isActive) {
            resetSnapping();
        }
    }, [isActive, resetSnapping]);

    return null;
}
