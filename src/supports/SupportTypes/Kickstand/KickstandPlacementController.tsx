import { useCallback, useEffect, useMemo, useRef, useSyncExternalStore } from 'react';
import { useFrame, useThree } from '@react-three/fiber';
import * as THREE from 'three';
import { pushHistory } from '@/history/historyStore';
import { SUPPORT_ADD_KICKSTAND } from '@/supports/history/actionTypes';
import { getBezierPointAtT } from '../../Curves/BezierUtils';
import { addKnot, addRoot, subscribe, getSnapshot, setSelectedId } from '../../state';
import { getBranchSegmentEndpoints, getTrunkSegmentEndpoints } from '../../SupportPrimitives/Knot/knotUtils';
import type { SnapTarget } from '../../interaction/SnappingManager';
import { useSnapping } from '../../interaction/useSnapping';
import { getGridSettings } from '../../Settings';
import { snapToGridIndex } from '../../PlacementLogic/Grid/gridMath';
import { addKickstand, getKickstandSnapshot } from './kickstandStore';
import { clampKickstandHostT } from './kickstandRules';
import { buildKickstandData, toKickstandPreviewData } from './kickstandBuilder';
import { getKickstandPlacementOffsetMm } from './kickstandSettings';
import { kickstandPlacementStore, useKickstandPlacementState, type KickstandPlacementTarget } from './kickstandPlacementState';
import type { KickstandHostKind } from './types';
import type { Vec3 } from '../../types';
import { clearSelection } from '../../interaction/SupportSelection';

type DesiredBand = 'left' | 'right' | 'front';

interface KickstandTargetMeta {
    segmentId: string;
    supportKind: KickstandHostKind;
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
    const offsetMm = getKickstandPlacementOffsetMm();
    const root = toVector3(axisPoint).add(offsetDir.multiplyScalar(offsetMm));

    return {
        x: root.x,
        y: root.y,
        z: 0,
    };
}

function getPreferredPointFromPointerRay(
    axisPoint: Vec3,
    camera: THREE.Camera,
    pointer: THREE.Vector2,
    raycaster: THREE.Raycaster,
): Vec3 {
    raycaster.setFromCamera(pointer, camera);
    const ray = raycaster.ray;
    const axisPointVec = toVector3(axisPoint);
    const toAxis = axisPointVec.clone().sub(ray.origin);
    const t = Math.max(0, toAxis.dot(ray.direction));
    const projected = ray.origin.clone().add(ray.direction.clone().multiplyScalar(t));
    return {
        x: projected.x,
        y: projected.y,
        z: projected.z,
    };
}

function normalizeVec2(vec: THREE.Vector2): THREE.Vector2 | null {
    const lenSq = vec.lengthSq();
    if (lenSq < 1e-8) return null;
    return vec.clone().multiplyScalar(1 / Math.sqrt(lenSq));
}

function pickDesiredBand(
    axisPoint: Vec3,
    camera: THREE.Camera,
    pointer: THREE.Vector2,
    previousBand: DesiredBand,
    diameterMm: number,
    isOnShaftSurface: boolean,
): DesiredBand {
    if (isOnShaftSurface) return 'front';

    const axisNdc = toVector3(axisPoint).project(camera);
    const horizontalDelta = pointer.x - axisNdc.x;

    const cameraRight = new THREE.Vector3().setFromMatrixColumn(camera.matrixWorld, 0).normalize();
    const shaftRadiusMm = Math.max(0.1, diameterMm * 0.5);
    const shaftEdgeNdc = toVector3(axisPoint)
        .add(cameraRight.multiplyScalar(shaftRadiusMm))
        .project(camera);
    const shaftHalfWidthNdc = Math.max(0.008, Math.abs(shaftEdgeNdc.x - axisNdc.x));

    // Side zones start outside the visible shaft edge.
    const enterSideBoundaryNdc = shaftHalfWidthNdc + 0.006;
    const exitSideBoundaryNdc = shaftHalfWidthNdc + 0.002;

    if (previousBand === 'left' && horizontalDelta <= -exitSideBoundaryNdc) return 'left';
    if (previousBand === 'right' && horizontalDelta >= exitSideBoundaryNdc) return 'right';

    if (horizontalDelta <= -enterSideBoundaryNdc) return 'left';
    if (horizontalDelta >= enterSideBoundaryNdc) return 'right';

    return 'front';
}

function snapRootPosToGrid(
    rootPos: Vec3,
    axisPoint: Vec3,
    camera: THREE.Camera,
    pointer: THREE.Vector2,
    previousBand: DesiredBand,
    diameterMm?: number,
    isOnShaftSurface = false,
): { rootPos: Vec3; band: DesiredBand } {
    const grid = getGridSettings();
    if (!grid.enabled || grid.spacingMm <= 0) return { rootPos, band: previousBand };

    const hostGx = snapToGridIndex(axisPoint.x, grid.spacingMm);
    const hostGy = snapToGridIndex(axisPoint.y, grid.spacingMm);
    const hostX = hostGx * grid.spacingMm;
    const hostY = hostGy * grid.spacingMm;

    const towardCamera = normalizeVec2(new THREE.Vector2(camera.position.x - axisPoint.x, camera.position.y - axisPoint.y));
    const forward = new THREE.Vector3();
    camera.getWorldDirection(forward);
    const right3 = new THREE.Vector3().crossVectors(forward, camera.up);
    const right = normalizeVec2(new THREE.Vector2(right3.x, right3.y))
        ?? (towardCamera ? normalizeVec2(new THREE.Vector2(towardCamera.y, -towardCamera.x)) : null);

    const desiredBand = pickDesiredBand(
        axisPoint,
        camera,
        pointer,
        previousBand,
        diameterMm ?? grid.spacingMm,
        isOnShaftSurface,
    );

    if (!towardCamera || !right) {
        const gx = snapToGridIndex(rootPos.x, grid.spacingMm);
        const gy = snapToGridIndex(rootPos.y, grid.spacingMm);
        return {
            rootPos: { x: gx * grid.spacingMm, y: gy * grid.spacingMm, z: 0 },
            band: desiredBand,
        };
    }

    const candidates = [
        { gx: hostGx + 1, gy: hostGy },
        { gx: hostGx - 1, gy: hostGy },
        { gx: hostGx, gy: hostGy + 1 },
        { gx: hostGx, gy: hostGy - 1 },
    ];

    let best: { x: number; y: number; score: number } | null = null;
    for (const candidate of candidates) {
        const worldX = candidate.gx * grid.spacingMm;
        const worldY = candidate.gy * grid.spacingMm;
        const dir = normalizeVec2(new THREE.Vector2(worldX - hostX, worldY - hostY));
        if (!dir) continue;

        // Exclude only strongly away-facing nodes; keep side nodes available in diagonal camera views.
        if (towardCamera && dir.dot(towardCamera) < -0.55) continue;

        const frontScore = dir.dot(towardCamera);
        const rightScore = dir.dot(right);
        const score = desiredBand === 'left'
            ? -rightScore
            : desiredBand === 'right'
                ? rightScore
                : frontScore;

        if (!best || score > best.score) {
            best = { x: worldX, y: worldY, score };
        }
    }

    if (best) {
        return {
            rootPos: {
                x: best.x,
                y: best.y,
                z: 0,
            },
            band: desiredBand,
        };
    }

    const gx = snapToGridIndex(rootPos.x, grid.spacingMm);
    const gy = snapToGridIndex(rootPos.y, grid.spacingMm);
    return {
        rootPos: {
            x: gx * grid.spacingMm,
            y: gy * grid.spacingMm,
            z: 0,
        },
        band: desiredBand,
    };
}

function isGridRootOccupied(rootPos: Vec3, modelId: string): boolean {
    const grid = getGridSettings();
    if (!grid.enabled || grid.spacingMm <= 0) return false;

    const gx = snapToGridIndex(rootPos.x, grid.spacingMm);
    const gy = snapToGridIndex(rootPos.y, grid.spacingMm);

    const supportSnapshot = getSnapshot();
    for (const root of Object.values(supportSnapshot.roots)) {
        if (root.modelId !== modelId) continue;
        const rootGx = snapToGridIndex(root.transform.pos.x, grid.spacingMm);
        const rootGy = snapToGridIndex(root.transform.pos.y, grid.spacingMm);
        if (rootGx === gx && rootGy === gy) return true;
    }

    const kickstandSnapshot = getKickstandSnapshot();
    for (const root of Object.values(kickstandSnapshot.roots)) {
        if (root.modelId !== modelId) continue;
        const rootGx = snapToGridIndex(root.transform.pos.x, grid.spacingMm);
        const rootGy = snapToGridIndex(root.transform.pos.y, grid.spacingMm);
        if (rootGx === gx && rootGy === gy) return true;
    }

    return false;
}

function hasCtrlModifier(intersection: unknown): boolean {
    if (!intersection || typeof intersection !== 'object') return false;
    const candidate = intersection as IntersectionWithCtrl;
    return Boolean(candidate.ctrlKey ?? candidate.nativeEvent?.ctrlKey);
}

export function KickstandPlacementController() {
    const { hotkeyActive } = useKickstandPlacementState();
    const supportState = useSyncExternalStore(subscribe, getSnapshot);
    const { camera, gl, pointer, raycaster } = useThree();
    const hoverPointBySegmentRef = useRef<Map<string, Vec3>>(new Map());
    const desiredBandRef = useRef<DesiredBand>('front');
    const lastPreviewSegmentIdRef = useRef<string | null>(null);

    const targetMetaById = useMemo(() => {
        const map = new Map<string, KickstandTargetMeta>();
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

    const buildPlacementFromSnap = useCallback((meta: KickstandTargetMeta, t: number, snappedPos: Vec3, rootPos: Vec3): {
        target: KickstandPlacementTarget;
        build: ReturnType<typeof buildKickstandData>;
    } => {
        const clampedT = clampKickstandHostT(t, meta.minT);

        const build = buildKickstandData({
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

            const snapshot = kickstandPlacementStore.getSnapshot();
            if (snapshot.hotkeyActive) {
                kickstandPlacementStore.setHotkeyActive(false);
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
            kickstandPlacementStore.clearPreview();
            desiredBandRef.current = 'front';
            lastPreviewSegmentIdRef.current = null;
            return;
        }

        const result = updateSnapping();

        if (result.state !== 'locked' || !result.targetId || result.t === undefined) {
            kickstandPlacementStore.clearPreview();
            desiredBandRef.current = 'front';
            lastPreviewSegmentIdRef.current = null;
            return;
        }

        const meta = targetMetaById.get(result.targetId);
        const path = meta?.target.pathSegment;
        if (!meta || !path) {
            kickstandPlacementStore.clearPreview();
            desiredBandRef.current = 'front';
            lastPreviewSegmentIdRef.current = null;
            return;
        }

        if (lastPreviewSegmentIdRef.current !== meta.segmentId) {
            desiredBandRef.current = 'front';
            lastPreviewSegmentIdRef.current = meta.segmentId;
        }

        const clampedT = clampKickstandHostT(result.t, meta.minT);
        const snappedPos = clampedT === result.t ? result.snappedPos : getPathPointAtT(path, clampedT);
        const hoveredPoint = hoverPointBySegmentRef.current.get(meta.segmentId);
        const preferredPoint = hoveredPoint
            ?? getPreferredPointFromPointerRay(snappedPos, camera, pointer, raycaster);
        const rawRootPos = computeRootPos(path, snappedPos, camera.position, preferredPoint);
        const snapDecision = snapRootPosToGrid(
            rawRootPos,
            snappedPos,
            camera,
            pointer,
            desiredBandRef.current,
            meta.diameterMm,
            Boolean(hoveredPoint),
        );
        desiredBandRef.current = snapDecision.band;
        const rootPos = snapDecision.rootPos;
        const nodeOccupied = isGridRootOccupied(rootPos, meta.modelId);

        const { target, build } = buildPlacementFromSnap(meta, clampedT, snappedPos, rootPos);
        const previewData = toKickstandPreviewData(build);
        previewData.error = nodeOccupied ? 'TOO_CLOSE_TO_EXISTING' : undefined;
        kickstandPlacementStore.setPreview(target, build, previewData);
    });

    useEffect(() => {
        if (!hotkeyActive) {
            kickstandPlacementStore.clearPreview();
            resetSnapping();
            desiredBandRef.current = 'front';
            lastPreviewSegmentIdRef.current = null;
        }
    }, [hotkeyActive, resetSnapping]);

    useEffect(() => {
        const handleShaftClick = (event: Event) => {
            const detail = (event as CustomEvent<ShaftClickDetail>).detail;
            if (!detail?.segmentId) return;

            const ctrlDown = hasCtrlModifier(detail.intersection) || kickstandPlacementStore.getSnapshot().hotkeyActive;
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
                const snapshotTarget = kickstandPlacementStore.getSnapshot().snapTarget;
                if (!snapshotTarget || snapshotTarget.segmentId !== detail.segmentId) return;
                projectedT = snapshotTarget.t;
                projectedPos = snapshotTarget.pos;
            }

            const clampedT = clampKickstandHostT(projectedT, meta.minT);
            if (clampedT !== projectedT) {
                projectedPos = getPathPointAtT(path, clampedT);
            }

            const preferredPoint = detail.point
                ?? getPreferredPointFromPointerRay(projectedPos, camera, pointer, raycaster);
            const rawRootPos = computeRootPos(path, projectedPos, camera.position, preferredPoint);
            const snapDecision = snapRootPosToGrid(
                rawRootPos,
                projectedPos,
                camera,
                pointer,
                desiredBandRef.current,
                meta.diameterMm,
                Boolean(detail.point),
            );
            desiredBandRef.current = snapDecision.band;
            const rootPos = snapDecision.rootPos;

            if (isGridRootOccupied(rootPos, meta.modelId)) {
                return;
            }

            const { build } = buildPlacementFromSnap(meta, clampedT, projectedPos, rootPos);

            addKickstand(build);
            addRoot(build.root);
            addKnot(build.hostKnot);

            pushHistory({
                type: SUPPORT_ADD_KICKSTAND,
                payload: { build },
            });

            clearSelection();
            kickstandPlacementStore.clearPreview();
            desiredBandRef.current = 'front';
            lastPreviewSegmentIdRef.current = null;
            resetSnapping();
        };

        window.addEventListener('shaft-click', handleShaftClick);

        return () => {
            window.removeEventListener('shaft-click', handleShaftClick);
        };
    }, [buildPlacementFromSnap, hotkeyActive, resetSnapping, camera, pointer, raycaster, targetMetaById]);

    return null;
}
