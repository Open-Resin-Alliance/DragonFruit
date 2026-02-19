import { useCallback, useEffect, useMemo, useRef, useSyncExternalStore } from 'react';
import { useFrame, useThree } from '@react-three/fiber';
import * as THREE from 'three';
import { pushHistory } from '@/history/historyStore';
import { SUPPORT_ADD_SUPPORT_BRACE } from '@/supports/history/actionTypes';
import { getBezierPointAtT } from '../../Curves/BezierUtils';
import { addKnot, addRoot, subscribe, getSnapshot, setSelectedId } from '../../state';
import { getBranchSegmentEndpoints, getTrunkSegmentEndpoints } from '../../SupportPrimitives/Knot/knotUtils';
import type { SnapTarget } from '../../interaction/SnappingManager';
import { useSnapping } from '../../interaction/useSnapping';
import { addSupportBrace } from './supportBraceStore';
import { clampSupportBraceHostT } from './supportBraceRules';
import { buildSupportBraceData, toSupportBracePreviewData } from './supportBraceBuilder';
import { getSupportBracePlacementOffsetMm } from './supportBraceSettings';
import { supportBracePlacementStore, useSupportBracePlacementState, type SupportBracePlacementTarget } from './supportBracePlacementState';
import type { SupportBraceHostKind } from './types';
import type { Vec3 } from '../../types';

interface SupportBraceTargetMeta {
    segmentId: string;
    supportKind: SupportBraceHostKind;
    modelId: string;
    diameterMm: number;
    minT: number;
    target: SnapTarget;
}

interface ShaftClickDetail {
    segmentId?: string;
    point?: Vec3 | null;
    intersection?: unknown;
}

interface IntersectionWithCtrl {
    ctrlKey?: boolean;
    nativeEvent?: {
        ctrlKey?: boolean;
    };
}

function toVector3(v: Vec3): THREE.Vector3 {
    return new THREE.Vector3(v.x, v.y, v.z);
}

function getPathPointAtT(path: NonNullable<SnapTarget['pathSegment']>, t: number): Vec3 {
    const clampedT = THREE.MathUtils.clamp(t, 0, 1);

    if (path.bezier) {
        return getBezierPointAtT(path.start, path.bezier.control1, path.bezier.control2, path.end, clampedT);
    }

    const start = toVector3(path.start);
    const end = toVector3(path.end);
    const point = start.lerp(end, clampedT);

    return { x: point.x, y: point.y, z: point.z };
}

function projectPointToPath(point: Vec3, path: NonNullable<SnapTarget['pathSegment']>): { t: number; pos: Vec3 } {
    const p = toVector3(point);

    if (path.bezier) {
        let bestT = 0;
        let bestDistSq = Number.POSITIVE_INFINITY;
        const steps = 60;

        for (let i = 0; i <= steps; i += 1) {
            const t = i / steps;
            const sample = getBezierPointAtT(path.start, path.bezier.control1, path.bezier.control2, path.end, t);
            const sampleVec = toVector3(sample);
            const distSq = sampleVec.distanceToSquared(p);
            if (distSq < bestDistSq) {
                bestDistSq = distSq;
                bestT = t;
            }
        }

        return {
            t: bestT,
            pos: getPathPointAtT(path, bestT),
        };
    }

    const start = toVector3(path.start);
    const end = toVector3(path.end);
    const segment = end.clone().sub(start);
    const segmentLenSq = segment.lengthSq();

    if (segmentLenSq < 1e-8) {
        return {
            t: 0,
            pos: path.start,
        };
    }

    const projectedT = THREE.MathUtils.clamp(p.clone().sub(start).dot(segment) / segmentLenSq, 0, 1);
    const projectedPoint = start.clone().add(segment.multiplyScalar(projectedT));

    return {
        t: projectedT,
        pos: { x: projectedPoint.x, y: projectedPoint.y, z: projectedPoint.z },
    };
}

function perpendicularDirection(
    path: NonNullable<SnapTarget['pathSegment']>,
    axisPoint: Vec3,
    cameraPos: THREE.Vector3,
    preferredPoint?: Vec3 | null,
): THREE.Vector3 {
    const start = toVector3(path.start);
    const end = toVector3(path.end);
    const axis = end.clone().sub(start);

    if (axis.lengthSq() < 1e-8) {
        axis.set(0, 0, 1);
    } else {
        axis.normalize();
    }

    const axisPointVec = toVector3(axisPoint);

    let dir = preferredPoint ? toVector3(preferredPoint).sub(axisPointVec) : cameraPos.clone().sub(axisPointVec);
    dir.sub(axis.clone().multiplyScalar(dir.dot(axis)));

    if (dir.lengthSq() < 1e-8) {
        dir = cameraPos.clone().sub(axisPointVec);
        dir.sub(axis.clone().multiplyScalar(dir.dot(axis)));
    }

    if (dir.lengthSq() < 1e-8) {
        dir = axis.clone().cross(new THREE.Vector3(0, 0, 1));
    }

    if (dir.lengthSq() < 1e-8) {
        dir = axis.clone().cross(new THREE.Vector3(1, 0, 0));
    }

    return dir.normalize();
}

function computeRootPos(
    path: NonNullable<SnapTarget['pathSegment']>,
    axisPoint: Vec3,
    cameraPos: THREE.Vector3,
    preferredPoint?: Vec3 | null,
): Vec3 {
    const offsetDir = perpendicularDirection(path, axisPoint, cameraPos, preferredPoint);
    const offsetMm = getSupportBracePlacementOffsetMm();
    const root = toVector3(axisPoint).add(offsetDir.multiplyScalar(offsetMm));

    return {
        x: root.x,
        y: root.y,
        z: 0,
    };
}

function hasCtrlModifier(intersection: unknown): boolean {
    if (!intersection || typeof intersection !== 'object') return false;
    const candidate = intersection as IntersectionWithCtrl;
    return Boolean(candidate.ctrlKey ?? candidate.nativeEvent?.ctrlKey);
}

export function SupportBracePlacementController() {
    const { hotkeyActive } = useSupportBracePlacementState();
    const supportState = useSyncExternalStore(subscribe, getSnapshot);
    const { camera, gl } = useThree();
    const hoverPointBySegmentRef = useRef<Map<string, Vec3>>(new Map());

    const targetMetaById = useMemo(() => {
        const map = new Map<string, SupportBraceTargetMeta>();
        const rootsById = new Map(Object.values(supportState.roots).map((root) => [root.id, root]));
        const knotsById = new Map(Object.values(supportState.knots).map((knot) => [knot.id, knot]));

        for (const trunk of Object.values(supportState.trunks)) {
            const root = rootsById.get(trunk.rootId);
            if (!root) continue;

            trunk.segments.forEach((segment, index) => {
                const endpoints = getTrunkSegmentEndpoints(trunk, segment, index, root);
                if (!endpoints) return;

                map.set(segment.id, {
                    segmentId: segment.id,
                    supportKind: 'trunk',
                    modelId: trunk.modelId,
                    diameterMm: segment.diameter,
                    minT: 0,
                    target: {
                        id: segment.id,
                        type: 'path',
                        pathSegment: {
                            start: endpoints.start,
                            end: endpoints.end,
                            radius: segment.diameter / 2,
                            bezier: segment.type === 'bezier'
                                ? { control1: segment.controlPoint1, control2: segment.controlPoint2 }
                                : undefined,
                        },
                    },
                });
            });
        }

        for (const branch of Object.values(supportState.branches)) {
            const parentKnot = knotsById.get(branch.parentKnotId);
            if (!parentKnot) continue;

            branch.segments.forEach((segment, index) => {
                const endpoints = getBranchSegmentEndpoints(branch, segment, index, parentKnot);
                if (!endpoints) return;

                map.set(segment.id, {
                    segmentId: segment.id,
                    supportKind: 'branch',
                    modelId: branch.modelId,
                    diameterMm: segment.diameter,
                    minT: 0,
                    target: {
                        id: segment.id,
                        type: 'path',
                        pathSegment: {
                            start: endpoints.start,
                            end: endpoints.end,
                            radius: segment.diameter / 2,
                            bezier: segment.type === 'bezier'
                                ? { control1: segment.controlPoint1, control2: segment.controlPoint2 }
                                : undefined,
                        },
                    },
                });
            });
        }

        return map;
    }, [supportState.branches, supportState.knots, supportState.roots, supportState.trunks]);

    const snapTargets = useMemo(() => {
        return Array.from(targetMetaById.values()).map((meta) => meta.target);
    }, [targetMetaById]);

    const getTarget = useCallback((id: string): SnapTarget | null => {
        const meta = targetMetaById.get(id);
        return meta ? meta.target : null;
    }, [targetMetaById]);

    const getPotentialTargets = useCallback(() => snapTargets, [snapTargets]);

    const { updateSnapping, resetSnapping } = useSnapping(getTarget, getPotentialTargets);

    const buildPlacementFromSnap = useCallback((meta: SupportBraceTargetMeta, t: number, snappedPos: Vec3, rootPos: Vec3): {
        target: SupportBracePlacementTarget;
        build: ReturnType<typeof buildSupportBraceData>;
    } => {
        const clampedT = clampSupportBraceHostT(t, meta.minT);

        const build = buildSupportBraceData({
            modelId: meta.modelId,
            rootPos,
            host: {
                segmentId: meta.segmentId,
                supportKind: meta.supportKind,
                t: clampedT,
                pos: snappedPos,
                diameterMm: meta.diameterMm,
                minT: meta.minT,
            },
        });

        return {
            target: {
                segmentId: meta.segmentId,
                supportKind: meta.supportKind,
                modelId: meta.modelId,
                t: clampedT,
                pos: snappedPos,
                diameterMm: meta.diameterMm,
                minT: meta.minT,
                rootPos,
            },
            build,
        };
    }, []);

    useEffect(() => {
        const el = gl.domElement;

        const cancelIfCtrlReleased = (event: PointerEvent) => {
            if (event.ctrlKey) return;

            const snapshot = supportBracePlacementStore.getSnapshot();
            if (snapshot.hotkeyActive) {
                supportBracePlacementStore.setHotkeyActive(false);
                resetSnapping();
            }
        };

        el.addEventListener('pointermove', cancelIfCtrlReleased, true);
        el.addEventListener('pointerdown', cancelIfCtrlReleased, true);
        el.addEventListener('pointerup', cancelIfCtrlReleased, true);

        return () => {
            el.removeEventListener('pointermove', cancelIfCtrlReleased, true);
            el.removeEventListener('pointerdown', cancelIfCtrlReleased, true);
            el.removeEventListener('pointerup', cancelIfCtrlReleased, true);
        };
    }, [gl, resetSnapping]);

    useEffect(() => {
        const hoverPoints = hoverPointBySegmentRef.current;

        const handleShaftHover = (event: Event) => {
            const detail = (event as CustomEvent<ShaftClickDetail>).detail;
            if (!detail?.segmentId) return;
            if (!detail.point) {
                hoverPoints.delete(detail.segmentId);
                return;
            }
            hoverPoints.set(detail.segmentId, detail.point);
        };

        const handleShaftLeave = (event: Event) => {
            const detail = (event as CustomEvent<{ segmentId?: string }>).detail;
            if (!detail?.segmentId) return;
            hoverPoints.delete(detail.segmentId);
        };

        window.addEventListener('shaft-hover', handleShaftHover);
        window.addEventListener('shaft-leave', handleShaftLeave);

        return () => {
            window.removeEventListener('shaft-hover', handleShaftHover);
            window.removeEventListener('shaft-leave', handleShaftLeave);
            hoverPoints.clear();
        };
    }, []);

    useFrame(() => {
        if (!hotkeyActive) {
            supportBracePlacementStore.clearPreview();
            return;
        }

        const result = updateSnapping();

        if (result.state !== 'locked' || !result.targetId || result.t === undefined) {
            supportBracePlacementStore.clearPreview();
            return;
        }

        const meta = targetMetaById.get(result.targetId);
        const path = meta?.target.pathSegment;
        if (!meta || !path) {
            supportBracePlacementStore.clearPreview();
            return;
        }

        const clampedT = clampSupportBraceHostT(result.t, meta.minT);
        const snappedPos = clampedT === result.t ? result.snappedPos : getPathPointAtT(path, clampedT);
        const preferredPoint = hoverPointBySegmentRef.current.get(meta.segmentId) ?? null;
        const rootPos = computeRootPos(path, snappedPos, camera.position, preferredPoint);

        const { target, build } = buildPlacementFromSnap(meta, clampedT, snappedPos, rootPos);
        const previewData = toSupportBracePreviewData(build);
        supportBracePlacementStore.setPreview(target, build, previewData);
    });

    useEffect(() => {
        if (!hotkeyActive) {
            supportBracePlacementStore.clearPreview();
            resetSnapping();
        }
    }, [hotkeyActive, resetSnapping]);

    useEffect(() => {
        const handleShaftClick = (event: Event) => {
            const detail = (event as CustomEvent<ShaftClickDetail>).detail;
            if (!detail?.segmentId) return;

            const ctrlDown = hasCtrlModifier(detail.intersection) || supportBracePlacementStore.getSnapshot().hotkeyActive;
            if (!ctrlDown) return;

            const meta = targetMetaById.get(detail.segmentId);
            const path = meta?.target.pathSegment;
            if (!meta || !path) return;

            let projectedT: number;
            let projectedPos: Vec3;

            if (detail.point) {
                const projected = projectPointToPath(detail.point, path);
                projectedT = projected.t;
                projectedPos = projected.pos;
            } else {
                const snapshotTarget = supportBracePlacementStore.getSnapshot().snapTarget;
                if (!snapshotTarget || snapshotTarget.segmentId !== detail.segmentId) return;
                projectedT = snapshotTarget.t;
                projectedPos = snapshotTarget.pos;
            }

            const clampedT = clampSupportBraceHostT(projectedT, meta.minT);
            if (clampedT !== projectedT) {
                projectedPos = getPathPointAtT(path, clampedT);
            }

            const rootPos = computeRootPos(path, projectedPos, camera.position, detail.point ?? null);
            const { build } = buildPlacementFromSnap(meta, clampedT, projectedPos, rootPos);

            addSupportBrace(build);
            addRoot(build.root);
            addKnot(build.hostKnot);
            pushHistory({
                type: SUPPORT_ADD_SUPPORT_BRACE,
                payload: { build },
            });
            setSelectedId(build.supportBrace.id);
            supportBracePlacementStore.clearPreview();
        };

        window.addEventListener('shaft-click', handleShaftClick);
        return () => {
            window.removeEventListener('shaft-click', handleShaftClick);
        };
    }, [buildPlacementFromSnap, camera.position, targetMetaById]);

    return null;
}
