import { useCallback, useEffect, useMemo, useSyncExternalStore } from 'react';
import { useFrame } from '@react-three/fiber';
import { useThree } from '@react-three/fiber';
import * as THREE from 'three';
import { subscribe, getSnapshot, addKnot, addBrace } from '../../state';
import { pushHistory } from '@/history/historyStore';
import { useSnapping } from '../../interaction/useSnapping';
import type { SnapTarget } from '../../interaction/SnappingManager';
import type { Brace, Knot, Vec3 } from '../../types';
import { SUPPORT_ADD_BRACE } from '../../history/actionTypes';
import { getSettings } from '../../Settings/state';
import { getBranchSegmentEndpoints, getTrunkSegmentEndpoints } from '../../SupportPrimitives/Knot/knotUtils';
import type { ContactCone } from '../../SupportPrimitives/ContactCone/types';
import { calculateDiskThickness } from '../../SupportPrimitives/ContactDisk/contactDiskUtils';
import { JOINT_DIAMETER_OFFSET_MM } from '../../constants';
import { useSupportBraceStoreState } from '../SupportBrace/supportBraceStore';
import { bracePlacementStore, useBracePlacementState } from './bracePlacementState';
import { branchPlacementStore } from '../Branch/branchPlacementState';
import { generateUuid } from '@/utils/uuid';

interface ShaftHoverDetail {
    segmentId?: string | null;
    point?: Vec3 | null;
}

function vecEq(a: Vec3, b: Vec3) {
    return a.x === b.x && a.y === b.y && a.z === b.z;
}

export function BracePlacementController() {
    const { altActive, stage, start } = useBracePlacementState();
    const supportState = useSyncExternalStore(subscribe, getSnapshot);
    const supportBraceState = useSupportBraceStoreState();

    const { raycaster, camera, pointer } = useThree();
    const hoveredShaftRef = useMemo(() => ({ current: null as ShaftHoverDetail | null }), []);

    const segmentMeta = useMemo(() => {
        const map = new Map<string, { modelId: string; supportKey: string; isBezier: boolean }>();
        for (const trunk of Object.values(supportState.trunks)) {
            for (const seg of trunk.segments) {
                map.set(seg.id, {
                    modelId: trunk.modelId,
                    supportKey: `trunk:${trunk.id}`,
                    isBezier: seg.type === 'bezier',
                });
            }
        }
        for (const branch of Object.values(supportState.branches)) {
            for (const seg of branch.segments) {
                map.set(seg.id, {
                    modelId: branch.modelId,
                    supportKey: `branch:${branch.id}`,
                    isBezier: seg.type === 'bezier',
                });
            }
        }

        for (const supportBrace of Object.values(supportBraceState.supportBraces)) {
            for (const seg of supportBrace.segments) {
                map.set(seg.id, {
                    modelId: supportBrace.modelId,
                    supportKey: `supportBrace:${supportBrace.id}`,
                    isBezier: seg.type === 'bezier',
                });
            }
        }

         for (const twig of Object.values(supportState.twigs)) {
             for (const seg of twig.segments) {
                 map.set(seg.id, {
                     modelId: twig.modelId,
                     supportKey: `twig:${twig.id}`,
                     isBezier: seg.type === 'bezier',
                 });
             }
         }

         for (const stick of Object.values(supportState.sticks)) {
             for (const seg of stick.segments) {
                 map.set(seg.id, {
                     modelId: stick.modelId,
                     supportKey: `stick:${stick.id}`,
                     isBezier: seg.type === 'bezier',
                 });
             }
         }

        for (const brace of Object.values(supportState.braces)) {
            map.set(`braceSegment:${brace.id}`, {
                modelId: brace.modelId,
                supportKey: `brace:${brace.id}`,
                isBezier: brace.curve?.type === 'bezier',
            });
        }
        return map;
    }, [supportState.trunks, supportState.branches, supportState.twigs, supportState.sticks, supportState.braces, supportBraceState.supportBraces]);

    const leafMeta = useMemo(() => {
        const map = new Map<
            string,
            {
                modelId: string;
                cone: ContactCone;
                start: Vec3;
                end: Vec3;
                contactRadiusMm: number;
                bodyRadiusMm: number;
                lengthMm: number;
            }
        >();

        for (const leaf of Object.values(supportState.leaves)) {
            const cone = leaf.contactCone;
            if (!cone) continue;

            const profile = cone.profile;
            const contactRadiusMm = profile.contactDiameterMm / 2;
            const bodyRadiusMm = profile.bodyDiameterMm / 2;
            const lengthMm = profile.lengthMm;

            const coneAxis = new THREE.Vector3(cone.normal.x, cone.normal.y, cone.normal.z).normalize();
            const sn = (cone.surfaceNormal ?? cone.normal);
            const surfNormal = new THREE.Vector3(sn.x, sn.y, sn.z).normalize();

            let offset = 0;
            if (profile.type === 'disk') {
                if (cone.diskLengthOverride !== undefined) {
                    offset = cone.diskLengthOverride;
                } else {
                    offset = calculateDiskThickness(cone.surfaceNormal ?? cone.normal, cone.normal, profile);
                }
            }

            const startPos = {
                x: cone.pos.x + surfNormal.x * offset,
                y: cone.pos.y + surfNormal.y * offset,
                z: cone.pos.z + surfNormal.z * offset,
            };

            const endPos = {
                x: startPos.x + coneAxis.x * lengthMm,
                y: startPos.y + coneAxis.y * lengthMm,
                z: startPos.z + coneAxis.z * lengthMm,
            };

            map.set(leaf.id, {
                modelId: leaf.modelId,
                cone,
                start: startPos,
                end: endPos,
                contactRadiusMm,
                bodyRadiusMm,
                lengthMm,
            });
        }

        return map;
    }, [supportState.leaves]);

    const resolveLeafSurface = useCallback((leafId: string, axisPoint: Vec3, coneT: number) => {
        const meta = leafMeta.get(leafId);
        if (!meta) return null;

        // The endpoint knot should be centered on the cone axis.
        // We still compute local diameter from coneT for sizing.
        const center = new THREE.Vector3(axisPoint.x, axisPoint.y, axisPoint.z);
        const rMm = THREE.MathUtils.lerp(meta.contactRadiusMm, meta.bodyRadiusMm, THREE.MathUtils.clamp(coneT, 0, 1));
        return {
            pos: { x: center.x, y: center.y, z: center.z },
            diameterMm: rMm * 2,
            modelId: meta.modelId,
        };
    }, [leafMeta, camera.position]);

    const isValidEndSegment = useCallback(
        (endSegmentId: string) => {
            if (!start) return false;
            if (start.kind !== 'shaft') return false;
            const startSegId = start.segmentId;
            if (!startSegId) return false;
            if (endSegmentId === startSegId) return false;

            const startInfo = segmentMeta.get(startSegId);
            const endInfo = segmentMeta.get(endSegmentId);

            if (startInfo?.modelId && endInfo?.modelId && startInfo.modelId !== endInfo.modelId) {
                return false;
            }

            if (startInfo?.supportKey && endInfo?.supportKey && startInfo.supportKey === endInfo.supportKey) {
                if (!startInfo.isBezier && !endInfo.isBezier) {
                    return false;
                }
            }

            return true;
        },
        [segmentMeta, start]
    );

    const allTargets = useMemo(() => {
        if (!altActive && stage === 'idle') return [];

        const roots = Object.values(supportState.roots);
        const knots = Object.values(supportState.knots);
        const rootMap = new Map(roots.map((r) => [r.id, r]));
        const knotMap = new Map(knots.map((k) => [k.id, k]));

        const targets: SnapTarget[] = [];

        for (const trunk of Object.values(supportState.trunks)) {
            const root = rootMap.get(trunk.rootId);
            if (!root) continue;

            trunk.segments.forEach((seg, idx) => {
                if (start?.kind === 'shaft' && start.segmentId && seg.id === start.segmentId) return;

                const endpoints = getTrunkSegmentEndpoints(trunk, seg, idx, root);
                if (!endpoints) return;

                targets.push({
                    id: seg.id,
                    type: 'path',
                    pathSegment: {
                        start: endpoints.start,
                        end: endpoints.end,
                        radius: seg.diameter / 2,
                        bezier:
                            seg.type === 'bezier'
                                ? { control1: seg.controlPoint1, control2: seg.controlPoint2 }
                                : undefined,
                    },
                });
            });
        }

        for (const supportBrace of Object.values(supportBraceState.supportBraces)) {
            const supportBraceRoot = supportBraceState.roots[supportBrace.rootId];
            const supportBraceHostKnot = supportBraceState.knots[supportBrace.hostKnotId];
            if (!supportBraceRoot || !supportBraceHostKnot) continue;

            const rootTopZ = supportBraceRoot.transform.pos.z + supportBraceRoot.diskHeight + supportBraceRoot.coneHeight;

            supportBrace.segments.forEach((seg, idx) => {
                if (start?.kind === 'shaft' && start.segmentId && seg.id === start.segmentId) return;

                let startPos: Vec3;
                if (idx === 0) {
                    startPos = {
                        x: supportBraceRoot.transform.pos.x,
                        y: supportBraceRoot.transform.pos.y,
                        z: rootTopZ,
                    };
                } else {
                    const prevSeg = supportBrace.segments[idx - 1];
                    if (!prevSeg.topJoint) return;
                    startPos = prevSeg.topJoint.pos;
                }

                const endPos = seg.topJoint?.pos ?? supportBraceHostKnot.pos;

                targets.push({
                    id: seg.id,
                    type: 'path',
                    pathSegment: {
                        start: startPos,
                        end: endPos,
                        radius: seg.diameter / 2,
                        bezier:
                            seg.type === 'bezier'
                                ? { control1: seg.controlPoint1, control2: seg.controlPoint2 }
                                : undefined,
                    },
                });
            });
        }

        // Add brace shafts as path targets
        for (const brace of Object.values(supportState.braces)) {
            const id = `braceSegment:${brace.id}`;
            if (start?.kind === 'shaft' && start.segmentId && id === start.segmentId) continue;

            const startKnot = knotMap.get(brace.startKnotId);
            const endKnot = knotMap.get(brace.endKnotId);
            if (!startKnot || !endKnot) continue;

            const startDia = Math.max(
                0.001,
                (startKnot.diameter ?? (brace.profile.diameter + JOINT_DIAMETER_OFFSET_MM)) - JOINT_DIAMETER_OFFSET_MM
            );
            const endDia = Math.max(
                0.001,
                (endKnot.diameter ?? (brace.profile.diameter + JOINT_DIAMETER_OFFSET_MM)) - JOINT_DIAMETER_OFFSET_MM
            );
            const radius = Math.max(startDia, endDia) / 2;

            targets.push({
                id,
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

        for (const branch of Object.values(supportState.branches)) {
            const parentKnot = knotMap.get(branch.parentKnotId);
            if (!parentKnot) continue;

            branch.segments.forEach((seg, idx) => {
                if (start?.kind === 'shaft' && start.segmentId && seg.id === start.segmentId) return;

                const endpoints = getBranchSegmentEndpoints(branch, seg, idx, parentKnot);
                if (!endpoints) return;

                targets.push({
                    id: seg.id,
                    type: 'path',
                    pathSegment: {
                        start: endpoints.start,
                        end: endpoints.end,
                        radius: seg.diameter / 2,
                        bezier:
                            seg.type === 'bezier'
                                ? { control1: seg.controlPoint1, control2: seg.controlPoint2 }
                                : undefined,
                    },
                });
            });
        }

        for (const twig of Object.values(supportState.twigs)) {
            twig.segments.forEach((seg) => {
                if (start?.kind === 'shaft' && start.segmentId && seg.id === start.segmentId) return;
                if (!seg.bottomJoint || !seg.topJoint) return;

                targets.push({
                    id: seg.id,
                    type: 'path',
                    pathSegment: {
                        start: seg.bottomJoint.pos,
                        end: seg.topJoint.pos,
                        radius: seg.diameter / 2,
                        bezier:
                            seg.type === 'bezier'
                                ? { control1: seg.controlPoint1, control2: seg.controlPoint2 }
                                : undefined,
                    },
                });
            });
        }

        for (const stick of Object.values(supportState.sticks)) {
            stick.segments.forEach((seg) => {
                if (start?.kind === 'shaft' && start.segmentId && seg.id === start.segmentId) return;
                if (!seg.bottomJoint || !seg.topJoint) return;

                targets.push({
                    id: seg.id,
                    type: 'path',
                    pathSegment: {
                        start: seg.bottomJoint.pos,
                        end: seg.topJoint.pos,
                        radius: seg.diameter / 2,
                        bezier:
                            seg.type === 'bezier'
                                ? { control1: seg.controlPoint1, control2: seg.controlPoint2 }
                                : undefined,
                    },
                });
            });
        }

        // Add leaf cones as path targets along the cone axis.
        for (const leaf of Object.values(supportState.leaves)) {
            const meta = leafMeta.get(leaf.id);
            if (!meta) continue;
            targets.push({
                id: leaf.id,
                type: 'path',
                pathSegment: {
                    start: meta.start,
                    end: meta.end,
                    radius: meta.bodyRadiusMm,
                },
            });
        }

        return targets;
    }, [altActive, stage, start, supportState.trunks, supportState.branches, supportState.twigs, supportState.sticks, supportState.braces, supportState.leaves, supportState.roots, supportState.knots, supportBraceState.supportBraces, supportBraceState.roots, supportBraceState.knots, leafMeta]);

    const targetById = useMemo(() => {
        const map = new Map<string, SnapTarget>();
        for (const t of allTargets) {
            if (!map.has(t.id)) {
                map.set(t.id, t);
            }
        }
        return map;
    }, [allTargets]);

    const targetCandidatesById = useMemo(() => {
        const map = new Map<string, SnapTarget[]>();
        for (const t of allTargets) {
            const existing = map.get(t.id);
            if (existing) {
                existing.push(t);
            } else {
                map.set(t.id, [t]);
            }
        }
        return map;
    }, [allTargets]);

    const getTarget = useCallback(
        (id: string): SnapTarget | null => {
            return targetById.get(id) ?? null;
        },
        [targetById]
    );

    const getTargetCandidates = useCallback(
        (id: string): SnapTarget[] => {
            return targetCandidatesById.get(id) ?? [];
        },
        [targetCandidatesById]
    );

    const getPotentialTargets = useCallback(() => allTargets, [allTargets]);

    const { updateSnapping, resetSnapping } = useSnapping(getTarget, getPotentialTargets);

    useEffect(() => {
        if (altActive) return;

        // If Alt is released, cancel placement and clear any lingering preview/hover visuals.
        // (useFrame may early-return when idle, so we must clear via an effect.)
        bracePlacementStore.reset();
        bracePlacementStore.setPreview(null);
        bracePlacementStore.setSnapTarget(null);
        resetSnapping();
    }, [altActive, resetSnapping]);

    const projectPointToPathTarget = useCallback((target: SnapTarget, point: Vec3) => {
        if (!target.pathSegment) return null;

        const a = new THREE.Vector3(target.pathSegment.start.x, target.pathSegment.start.y, target.pathSegment.start.z);
        const b = new THREE.Vector3(target.pathSegment.end.x, target.pathSegment.end.y, target.pathSegment.end.z);
        const p = new THREE.Vector3(point.x, point.y, point.z);

        let t = 0;
        let snapped = a.clone();

        if (target.pathSegment.bezier) {
            const c1 = new THREE.Vector3(
                target.pathSegment.bezier.control1.x,
                target.pathSegment.bezier.control1.y,
                target.pathSegment.bezier.control1.z
            );
            const c2 = new THREE.Vector3(
                target.pathSegment.bezier.control2.x,
                target.pathSegment.bezier.control2.y,
                target.pathSegment.bezier.control2.z
            );

            let bestT = 0;
            let bestDistSq = Infinity;
            const curve = new THREE.CubicBezierCurve3(a, c1, c2, b);
            const steps = 40;
            for (let i = 0; i <= steps; i++) {
                const tt = i / steps;
                const q = curve.getPoint(tt);
                const d = q.distanceToSquared(p);
                if (d < bestDistSq) {
                    bestDistSq = d;
                    bestT = tt;
                    snapped = q;
                }
            }
            t = bestT;
        } else {
            const ab = b.clone().sub(a);
            const abLenSq = ab.lengthSq();
            if (abLenSq > 0.0000001) {
                t = THREE.MathUtils.clamp(p.clone().sub(a).dot(ab) / abLenSq, 0, 1);
                snapped = a.clone().add(ab.multiplyScalar(t));
            }
        }

        return {
            t,
            snapped,
            distSq: snapped.distanceToSquared(p),
        };
    }, []);

    const resolveNearestPathTarget = useCallback((targetId: string, point: Vec3) => {
        const candidates = getTargetCandidates(targetId).filter((target) => !!target.pathSegment);
        if (candidates.length === 0) return null;
        if (candidates.length === 1) return candidates[0];

        let bestTarget: SnapTarget | null = null;
        let bestDistSq = Infinity;

        for (const candidate of candidates) {
            const projected = projectPointToPathTarget(candidate, point);
            if (!projected) continue;
            if (projected.distSq < bestDistSq) {
                bestDistSq = projected.distSq;
                bestTarget = candidate;
            }
        }

        return bestTarget ?? candidates[0];
    }, [getTargetCandidates, projectPointToPathTarget]);

    const resolveSnapFromClick = useCallback(
        (segmentId: string, point: Vec3) => {
            const target = resolveNearestPathTarget(segmentId, point) ?? getTarget(segmentId);
            if (!target?.pathSegment) return null;

            let hostDiameterMm = target.pathSegment.radius * 2;
            let ownerModelId = segmentMeta.get(segmentId)?.modelId;

            const projected = projectPointToPathTarget(target, point);
            if (!projected) return null;

            const { t, snapped } = projected;

            return {
                kind: 'shaft' as const,
                segmentId,
                snappedPos: { x: snapped.x, y: snapped.y, z: snapped.z },
                t,
                hostDiameterMm,
                ownerModelId,
            };
        },
        [getTarget, projectPointToPathTarget, resolveNearestPathTarget, segmentMeta, supportState.braces, supportState.knots]
    );

    const resolveLeafSnapFromClick = useCallback(
        (leafId: string, point: Vec3) => {
            const meta = leafMeta.get(leafId);
            if (!meta) return null;

            const a = new THREE.Vector3(meta.start.x, meta.start.y, meta.start.z);
            const b = new THREE.Vector3(meta.end.x, meta.end.y, meta.end.z);
            const p = new THREE.Vector3(point.x, point.y, point.z);

            const ab = b.clone().sub(a);
            const abLenSq = ab.lengthSq();
            if (abLenSq < 0.0000001) return null;

            const t = THREE.MathUtils.clamp(p.clone().sub(a).dot(ab) / abLenSq, 0, 1);

            // Do not allow attaching on/inside the contact area at the very tip.
            const minMm = 0.25;
            const minT = THREE.MathUtils.clamp(minMm / Math.max(0.0001, meta.lengthMm), 0, 0.99);
            const coneT = Math.max(t, minT);

            const axisPoint = a.clone().add(ab.multiplyScalar(coneT));
            const resolved = resolveLeafSurface(leafId, { x: axisPoint.x, y: axisPoint.y, z: axisPoint.z }, coneT);
            if (!resolved) return null;

            return {
                kind: 'leaf' as const,
                leafId,
                coneT,
                snappedPos: resolved.pos,
                hostDiameterMm: resolved.diameterMm,
                ownerModelId: resolved.modelId,
            };
        },
        [leafMeta, resolveLeafSurface]
    );

    const resolveHoveredShaftSnap = useCallback(() => {
        const hovered = hoveredShaftRef.current;
        if (!hovered?.segmentId || !hovered.point) return null;
        return resolveSnapFromClick(hovered.segmentId, hovered.point);
    }, [hoveredShaftRef, resolveSnapFromClick]);

    useFrame(() => {
        if (!altActive && stage === 'idle') return;

        const result = updateSnapping();

        // Hover preview (before first click): show a knot-sized sphere on the hovered segment.
        if (stage === 'idle') {
            // If Branch is awaiting a base click, avoid showing brace hover previews.
            if (branchPlacementStore.getSnapshot().stage === 'awaitingBase') {
                bracePlacementStore.setSnapTarget(null);
                bracePlacementStore.setPreview(null);
                return;
            }

            const hoveredSnap = resolveHoveredShaftSnap();
            if (hoveredSnap) {
                const settings = getSettings();
                const fallbackDia = settings.shaft.diameterMm;
                const hostDia = hoveredSnap.hostDiameterMm ?? fallbackDia;
                bracePlacementStore.setPreview({
                    start: hoveredSnap.snappedPos,
                    end: hoveredSnap.snappedPos,
                    startDiameterMm: hostDia,
                    endDiameterMm: hostDia,
                });
                bracePlacementStore.setSnapTarget(null);
                return;
            }

            if (result.state === 'locked' && result.targetId && result.t !== undefined) {
                const settings = getSettings();
                const fallbackDia = settings.shaft.diameterMm;

                if (leafMeta.has(result.targetId)) {
                    const resolved = resolveLeafSurface(result.targetId, result.snappedPos, result.t);
                    if (resolved) {
                        bracePlacementStore.setPreview({
                            start: resolved.pos,
                            end: resolved.pos,
                            startDiameterMm: resolved.diameterMm,
                            endDiameterMm: resolved.diameterMm,
                        });
                    } else {
                        bracePlacementStore.setPreview(null);
                    }
                } else {
                    const target = resolveNearestPathTarget(result.targetId, result.snappedPos) ?? getTarget(result.targetId);
                    let hostDia = target?.pathSegment?.radius !== undefined ? target.pathSegment.radius * 2 : fallbackDia;
                    if (result.targetId.startsWith('braceSegment:')) {
                        const braceId = result.targetId.slice('braceSegment:'.length);
                        const brace = supportState.braces[braceId];
                        const startKnot = brace ? supportState.knots[brace.startKnotId] : undefined;
                        const endKnot = brace ? supportState.knots[brace.endKnotId] : undefined;
                        if (brace && startKnot && endKnot) {
                            const startDia = Math.max(
                                0.001,
                                (startKnot.diameter ?? (brace.profile.diameter + JOINT_DIAMETER_OFFSET_MM)) - JOINT_DIAMETER_OFFSET_MM
                            );
                            const endDia = Math.max(
                                0.001,
                                (endKnot.diameter ?? (brace.profile.diameter + JOINT_DIAMETER_OFFSET_MM)) - JOINT_DIAMETER_OFFSET_MM
                            );
                            hostDia = THREE.MathUtils.lerp(startDia, endDia, result.t);
                        }
                    }
                    // Zero-length preview: renders as a single sphere with green lights.
                    bracePlacementStore.setPreview({
                        start: result.snappedPos,
                        end: result.snappedPos,
                        startDiameterMm: hostDia,
                        endDiameterMm: hostDia,
                    });
                }
            } else {
                bracePlacementStore.setPreview(null);
            }

            bracePlacementStore.setSnapTarget(null);
            return;
        }

        // Only show preview after the first endpoint is placed.
        if (stage !== 'awaitingEnd' || !start) {
            bracePlacementStore.setSnapTarget(null);
            bracePlacementStore.setPreview(null);
            return;
        }

        // Free-space end: follow the mouse at approximately the same depth as the start.
        raycaster.setFromCamera(pointer, camera);
        const ray = raycaster.ray;
        const startVec = new THREE.Vector3(start.snappedPos.x, start.snappedPos.y, start.snappedPos.z);
        const depth = ray.direction.dot(startVec.clone().sub(ray.origin));
        const fallbackDepth = 30;
        const tRay = depth > 0.5 ? depth : fallbackDepth;
        const freeEndVec = ray.at(tRay, new THREE.Vector3());
        const freeEnd: Vec3 = { x: freeEndVec.x, y: freeEndVec.y, z: freeEndVec.z };

        const settings = getSettings();
        const fallbackDia = settings.shaft.diameterMm;
        const startDiam = start.hostDiameterMm ?? fallbackDia;

        // If snapped to a valid target, override free end.
        let endPos: Vec3 = freeEnd;
        let endDiam: number = startDiam;

        const hoveredSnap = resolveHoveredShaftSnap();
        if (hoveredSnap && hoveredSnap.segmentId && hoveredSnap.t !== undefined) {
            const snapTarget = {
                kind: 'shaft' as const,
                segmentId: hoveredSnap.segmentId,
                snappedPos: hoveredSnap.snappedPos,
                t: hoveredSnap.t,
                hostDiameterMm: hoveredSnap.hostDiameterMm,
                ownerModelId: hoveredSnap.ownerModelId,
            };

            if (start.kind === 'leaf') {
                if (start.ownerModelId && snapTarget.ownerModelId && start.ownerModelId !== snapTarget.ownerModelId) {
                    bracePlacementStore.setSnapTarget(null);
                } else {
                    bracePlacementStore.setSnapTarget(snapTarget);
                    endPos = snapTarget.snappedPos;
                    endDiam = snapTarget.hostDiameterMm ?? fallbackDia;
                }
            } else {
                if (snapTarget.segmentId && isValidEndSegment(snapTarget.segmentId)) {
                    bracePlacementStore.setSnapTarget(snapTarget);
                    endPos = snapTarget.snappedPos;
                    endDiam = snapTarget.hostDiameterMm ?? fallbackDia;
                } else {
                    bracePlacementStore.setSnapTarget(null);
                }
            }
        } else if (result.state === 'locked' && result.targetId && result.t !== undefined) {
            if (leafMeta.has(result.targetId)) {
                const startModelId = start.ownerModelId;
                const meta = leafMeta.get(result.targetId);
                if (meta && startModelId && meta.modelId && startModelId !== meta.modelId) {
                    bracePlacementStore.setSnapTarget(null);
                } else {
                    const resolved = resolveLeafSurface(result.targetId, result.snappedPos, result.t);
                    const minMm = 0.25;
                    const minT = meta ? THREE.MathUtils.clamp(minMm / Math.max(0.0001, meta.lengthMm), 0, 0.99) : 0;
                    const coneT = Math.max(result.t, minT);

                    const sameLeaf = start.kind === 'leaf' && start.leafId === result.targetId;

                    if (resolved && !sameLeaf) {
                        const snapTarget = {
                            kind: 'leaf' as const,
                            leafId: result.targetId,
                            coneT,
                            snappedPos: resolved.pos,
                            hostDiameterMm: resolved.diameterMm,
                            ownerModelId: resolved.modelId,
                        };
                        bracePlacementStore.setSnapTarget(snapTarget);
                        endPos = snapTarget.snappedPos;
                        endDiam = snapTarget.hostDiameterMm ?? fallbackDia;
                    } else {
                        bracePlacementStore.setSnapTarget(null);
                    }
                }
            } else {
                const target = resolveNearestPathTarget(result.targetId, result.snappedPos) ?? getTarget(result.targetId);
                let hostDiameterMm = target?.pathSegment?.radius !== undefined ? target.pathSegment.radius * 2 : undefined;
                let ownerModelId = segmentMeta.get(result.targetId)?.modelId;

                if (result.targetId.startsWith('braceSegment:')) {
                    const braceId = result.targetId.slice('braceSegment:'.length);
                    const brace = supportState.braces[braceId];
                    const startKnot = brace ? supportState.knots[brace.startKnotId] : undefined;
                    const endKnot = brace ? supportState.knots[brace.endKnotId] : undefined;
                    if (brace && startKnot && endKnot) {
                        const startDia = Math.max(
                            0.001,
                            (startKnot.diameter ?? (brace.profile.diameter + JOINT_DIAMETER_OFFSET_MM)) - JOINT_DIAMETER_OFFSET_MM
                        );
                        const endDia = Math.max(
                            0.001,
                            (endKnot.diameter ?? (brace.profile.diameter + JOINT_DIAMETER_OFFSET_MM)) - JOINT_DIAMETER_OFFSET_MM
                        );
                        hostDiameterMm = THREE.MathUtils.lerp(startDia, endDia, result.t);
                        ownerModelId = brace.modelId;
                    }
                }

                const snapTarget = {
                    kind: 'shaft' as const,
                    segmentId: result.targetId,
                    snappedPos: result.snappedPos,
                    t: result.t,
                    hostDiameterMm,
                    ownerModelId,
                };

                if (start.kind === 'leaf') {
                    if (start.ownerModelId && ownerModelId && start.ownerModelId !== ownerModelId) {
                        bracePlacementStore.setSnapTarget(null);
                    } else {
                        bracePlacementStore.setSnapTarget(snapTarget);
                        endPos = snapTarget.snappedPos;
                        endDiam = snapTarget.hostDiameterMm ?? fallbackDia;
                    }
                } else {
                    // If snapping is locked onto the same segment as the start, treat it as "free".
                    if (snapTarget.segmentId && isValidEndSegment(snapTarget.segmentId)) {
                        bracePlacementStore.setSnapTarget(snapTarget);
                        endPos = snapTarget.snappedPos;
                        endDiam = snapTarget.hostDiameterMm ?? fallbackDia;
                    } else {
                        bracePlacementStore.setSnapTarget(null);
                    }
                }
            }
        } else {
            bracePlacementStore.setSnapTarget(null);
        }

        bracePlacementStore.setPreview({
            start: start.snappedPos,
            end: endPos,
            startDiameterMm: startDiam,
            endDiameterMm: endDiam,
        });
    });

    useEffect(() => {
        const handleShaftHover = (evt: Event) => {
            const detail = (evt as CustomEvent<ShaftHoverDetail>).detail;
            if (!detail?.segmentId || !detail.point) return;
            hoveredShaftRef.current = {
                segmentId: detail.segmentId,
                point: detail.point,
            };
        };

        const handleShaftLeave = (evt: Event) => {
            const detail = (evt as CustomEvent<{ segmentId?: string | null }>).detail;
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
    }, [hoveredShaftRef]);

    useEffect(() => {
        if (!altActive && stage === 'idle') {
            resetSnapping();
        }
    }, [altActive, stage, resetSnapping]);

    useEffect(() => {
        const handleShaftClick = (evt: any) => {
            const detail = evt?.detail;
            const altDown =
                !!altActive ||
                !!detail?.intersection?.altKey ||
                !!detail?.intersection?.nativeEvent?.altKey;
            if (!altDown) return;

            // If Branch placement is awaiting a base click, do not steal the segment click.
            // (Branch uses Alt+click model first, then click on a segment to place the base.)
            if (branchPlacementStore.getSnapshot().stage === 'awaitingBase') {
                return;
            }

            const segmentId: string | undefined = detail?.segmentId;
            const point: Vec3 | null = detail?.point ?? null;
            if (!segmentId || !point) return;

            if (stage === 'idle') {
                const snap = resolveSnapFromClick(segmentId, point);
                if (!snap) return;
                bracePlacementStore.setStart(snap);
                const settings = getSettings();
                const fallbackDia = settings.shaft.diameterMm;
                const startDiam = snap.hostDiameterMm ?? fallbackDia;
                bracePlacementStore.setPreview({
                    start: snap.snappedPos,
                    end: snap.snappedPos,
                    startDiameterMm: startDiam,
                    endDiameterMm: startDiam,
                });
                return;
            }

            if (stage !== 'awaitingEnd') return;
            if (!start) return;

            if (start.kind === 'leaf') {
                const endSnap = resolveSnapFromClick(segmentId, point);
                if (!endSnap || endSnap.t === undefined || !endSnap.segmentId) return;

                if (start.ownerModelId && endSnap.ownerModelId && start.ownerModelId !== endSnap.ownerModelId) return;
                if (!start.leafId || start.coneT === undefined) return;

                const settings = getSettings();
                const fallback = settings.shaft.diameterMm;
                const startDiam = start.hostDiameterMm ?? fallback;
                const endDiam = endSnap.hostDiameterMm ?? fallback;

                const braceId = generateUuid();
                const startKnotId = generateUuid();
                const endKnotId = generateUuid();

                const startKnot: Knot = {
                    id: startKnotId,
                    parentShaftId: `leafCone:${start.leafId}`,
                    t: start.coneT,
                    pos: start.snappedPos,
                    diameter: startDiam + 0.1,
                };

                const endKnot: Knot = {
                    id: endKnotId,
                    parentShaftId: endSnap.segmentId,
                    t: endSnap.t,
                    pos: endSnap.snappedPos,
                    diameter: endDiam + 0.1,
                };

                const modelId = start.ownerModelId ?? endSnap.ownerModelId ?? 'unknown';

                const brace: Brace = {
                    id: braceId,
                    modelId,
                    startKnotId,
                    endKnotId,
                    profile: {
                        diameter: Math.min(startDiam, endDiam),
                    },
                };

                addKnot(startKnot);
                addKnot(endKnot);
                addBrace(brace);

                pushHistory({
                    type: SUPPORT_ADD_BRACE,
                    payload: {
                        brace,
                        startKnot,
                        endKnot,
                    },
                });

                bracePlacementStore.finalize();
                bracePlacementStore.reset();
                return;
            }

            if (start.kind !== 'shaft' || start.t === undefined || !start.segmentId) return;

            const endSnap = resolveSnapFromClick(segmentId, point);
            if (!endSnap || endSnap.t === undefined) return;
            if (!endSnap.segmentId || !isValidEndSegment(endSnap.segmentId)) return;

            const startInfo = segmentMeta.get(start.segmentId);
            const endInfo = endSnap.segmentId ? segmentMeta.get(endSnap.segmentId) : undefined;
            const startModelId = startInfo?.modelId ?? start.ownerModelId;
            const endModelId = endInfo?.modelId ?? endSnap.ownerModelId;
            if (startModelId && endModelId && startModelId !== endModelId) return;

            const settings = getSettings();
            const fallback = settings.shaft.diameterMm;
            const startDiam = start.hostDiameterMm ?? fallback;
            const endDiam = endSnap.hostDiameterMm ?? fallback;

            const braceId = generateUuid();
            const startKnotId = generateUuid();
            const endKnotId = generateUuid();

            const startKnot: Knot = {
                id: startKnotId,
                parentShaftId: start.segmentId,
                t: start.t,
                pos: start.snappedPos,
                diameter: startDiam + 0.1,
            };

            const endKnot: Knot = {
                id: endKnotId,
                parentShaftId: endSnap.segmentId,
                t: endSnap.t,
                pos: endSnap.snappedPos,
                diameter: endDiam + 0.1,
            };

            const modelId = startModelId ?? endModelId ?? 'unknown';

            const brace: Brace = {
                id: braceId,
                modelId,
                startKnotId,
                endKnotId,
                profile: {
                    diameter: Math.min(startDiam, endDiam),
                },
            };

            addKnot(startKnot);
            addKnot(endKnot);
            addBrace(brace);

            pushHistory({
                type: SUPPORT_ADD_BRACE,
                payload: {
                    brace,
                    startKnot,
                    endKnot,
                },
            });

            bracePlacementStore.finalize();
            bracePlacementStore.reset();
        };

        window.addEventListener('shaft-click', handleShaftClick as any, true);
        return () => window.removeEventListener('shaft-click', handleShaftClick as any, true);
    }, [altActive, stage, start, resolveSnapFromClick, isValidEndSegment, segmentMeta]);

    useEffect(() => {
        const handleLeafClick = (evt: any) => {
            const detail = evt?.detail;
            const altDown = !!altActive || !!detail?.intersection?.altKey || !!detail?.intersection?.nativeEvent?.altKey;
            if (!altDown) return;

            if (branchPlacementStore.getSnapshot().stage === 'awaitingBase') {
                return;
            }

            const leafId: string | undefined = detail?.leafId;
            const point: Vec3 | null = detail?.point ?? null;
            if (!leafId || !point) return;

            if (stage === 'idle') {
                const snap = resolveLeafSnapFromClick(leafId, point);
                if (!snap) return;
                bracePlacementStore.setStart(snap);
                const settings = getSettings();
                const fallbackDia = settings.shaft.diameterMm;
                const startDiam = snap.hostDiameterMm ?? fallbackDia;
                bracePlacementStore.setPreview({
                    start: snap.snappedPos,
                    end: snap.snappedPos,
                    startDiameterMm: startDiam,
                    endDiameterMm: startDiam,
                });
                return;
            }

            if (stage !== 'awaitingEnd' || !start) return;
            if (start.kind === 'leaf') {
                if (start.leafId === leafId) return;

                const endSnap = resolveLeafSnapFromClick(leafId, point);
                if (!endSnap || endSnap.coneT === undefined) return;

                const startModelId = start.ownerModelId;
                const endModelId = endSnap.ownerModelId;
                if (startModelId && endModelId && startModelId !== endModelId) return;
                if (!start.leafId || start.coneT === undefined) return;

                const settings = getSettings();
                const fallback = settings.shaft.diameterMm;
                const startDiam = start.hostDiameterMm ?? fallback;
                const endDiam = endSnap.hostDiameterMm ?? fallback;

                const braceId = generateUuid();
                const startKnotId = generateUuid();
                const endKnotId = generateUuid();

                const startKnot: Knot = {
                    id: startKnotId,
                    parentShaftId: `leafCone:${start.leafId}`,
                    t: start.coneT,
                    pos: start.snappedPos,
                    diameter: startDiam + 0.1,
                };

                const endKnot: Knot = {
                    id: endKnotId,
                    parentShaftId: `leafCone:${leafId}`,
                    t: endSnap.coneT,
                    pos: endSnap.snappedPos,
                    diameter: endDiam + 0.1,
                };

                const modelId = startModelId ?? endModelId ?? 'unknown';
                const brace: Brace = {
                    id: braceId,
                    modelId,
                    startKnotId,
                    endKnotId,
                    profile: {
                        diameter: Math.min(startDiam, endDiam),
                    },
                };

                addKnot(startKnot);
                addKnot(endKnot);
                addBrace(brace);

                pushHistory({
                    type: SUPPORT_ADD_BRACE,
                    payload: {
                        brace,
                        startKnot,
                        endKnot,
                    },
                });

                bracePlacementStore.finalize();
                bracePlacementStore.reset();
                return;
            }

            if (start.kind !== 'shaft' || !start.segmentId || start.t === undefined) return;

            const endSnap = resolveLeafSnapFromClick(leafId, point);
            if (!endSnap || endSnap.coneT === undefined) return;

            const startModelId = start.ownerModelId;
            const endModelId = endSnap.ownerModelId;
            if (startModelId && endModelId && startModelId !== endModelId) return;

            const settings = getSettings();
            const fallback = settings.shaft.diameterMm;
            const startDiam = start.hostDiameterMm ?? fallback;
            const endDiam = endSnap.hostDiameterMm ?? fallback;

            const braceId = generateUuid();
            const startKnotId = generateUuid();
            const endKnotId = generateUuid();

            const startKnot: Knot = {
                id: startKnotId,
                parentShaftId: start.segmentId,
                t: start.t,
                pos: start.snappedPos,
                diameter: startDiam + 0.1,
            };

            const endKnot: Knot = {
                id: endKnotId,
                parentShaftId: `leafCone:${leafId}`,
                t: endSnap.coneT,
                pos: endSnap.snappedPos,
                diameter: endDiam + 0.1,
            };

            const modelId = startModelId ?? endModelId ?? 'unknown';
            const brace: Brace = {
                id: braceId,
                modelId,
                startKnotId,
                endKnotId,
                profile: {
                    diameter: Math.min(startDiam, endDiam),
                },
            };

            addKnot(startKnot);
            addKnot(endKnot);
            addBrace(brace);

            pushHistory({
                type: SUPPORT_ADD_BRACE,
                payload: {
                    brace,
                    startKnot,
                    endKnot,
                },
            });

            bracePlacementStore.finalize();
            bracePlacementStore.reset();
        };

        window.addEventListener('brace-leaf-click', handleLeafClick as any, true);
        return () => window.removeEventListener('brace-leaf-click', handleLeafClick as any, true);
    }, [altActive, stage, start, resolveLeafSnapFromClick, resolveSnapFromClick]);

    return null;
}
