import { useCallback, useEffect, useMemo, useRef, useSyncExternalStore } from 'react';
import { useFrame } from '@react-three/fiber';
import { useThree } from '@react-three/fiber';
import * as THREE from 'three';
import { useHotkeyConfig } from '@/hotkeys/HotkeyContext';
import { subscribe, getSnapshot, addKnot, addBrace } from '../../state';
import { pushHistory } from '@/history/historyStore';
import type { SnapTarget } from '../../interaction/SnappingManager';
import type { Brace, Knot, Vec3 } from '../../types';
import { SUPPORT_ADD_BRACE } from '../../history/actionTypes';
import { getSettings, getAutoBracingSettings } from '../../Settings/state';
import { useKickstandStoreState } from '../Kickstand/kickstandStore';
import { bracePlacementStore, useBracePlacementState } from './bracePlacementState';
import { branchPlacementStore } from '../Branch/branchPlacementState';
import { generateUuid } from '@/utils/uuid';
import { clearSupportSelection } from '../../interaction/shared/selection/selectionController';
import { usePlacementSnappingSession } from '../../interaction/shared/placement/snapping/usePlacementSnappingSession';
import {
    buildKickstandPathSnapTargets,
    buildLeafConePathSnapTargets,
    buildLeafConeSnapMeta,
    buildPrimarySnapTargetIndex,
    buildSnapTargetCandidateIndex,
    buildSupportPathSnapTargets,
    resolveBracePathDiameterAtT,
} from '../../interaction/shared/placement/snapping/supportPathTargets';
import { getSupportPlacementModifierState, isSupportPlacementBindingSatisfiedByModifierState } from '../../interaction/shared/placement/hotkeys/supportPlacementHotkeyResolver';
import { projectPointToSnapTargetPath, selectNearestPathTarget } from '../../interaction/shared/placement/snapping/pathProjection';
import { isSupportEditInteractionActive } from '../../interaction/gizmoInteractionLock';
import { previewVecKey, quantizePreviewValue } from '../shared/previewSignature';
import type { BracePreviewData } from './bracePlacementState';
import { resolveTwigDiameterAtSegmentT, twigJointDiameterForLocalDiameter } from '../Twig/twigTaper';

interface ShaftHoverDetail {
    segmentId?: string | null;
    point?: Vec3 | null;
}

interface ModifierAwareIntersection {
    altKey?: boolean;
    nativeEvent?: {
        altKey?: boolean;
    };
}

interface ShaftClickDetail extends ShaftHoverDetail {
    segmentId?: string;
    point?: Vec3 | null;
    intersection?: ModifierAwareIntersection;
}

interface LeafClickDetail {
    leafId?: string;
    point?: Vec3 | null;
    intersection?: ModifierAwareIntersection;
}

interface LeafHoverDetail {
    leafId?: string | null;
    point?: Vec3 | null;
}

export function BracePlacementController() {
    const { altActive, stage, start } = useBracePlacementState();
    const supportState = useSyncExternalStore(subscribe, getSnapshot);
    const kickstandState = useKickstandStoreState();
    const { getHotkey } = useHotkeyConfig();
    const branchFamilyBinding = getHotkey('SUPPORTS', 'BRANCH_PLACEMENT');

    const { raycaster, camera, pointer } = useThree();
    const hoveredShaftRef = useMemo(() => ({ current: null as ShaftHoverDetail | null }), []);
    const hoveredLeafRef = useMemo(() => ({ current: null as LeafHoverDetail | null }), []);
    const supportEditSuppressedRef = useRef(false);
    const lastPreviewSignatureRef = useRef<string | null>(null);

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

        for (const kickstand of Object.values(kickstandState.kickstands)) {
            for (const seg of kickstand.segments) {
                map.set(seg.id, {
                    modelId: kickstand.modelId,
                    supportKey: `kickstand:${kickstand.id}`,
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
    }, [supportState.trunks, supportState.branches, supportState.twigs, supportState.sticks, supportState.braces, kickstandState.kickstands]);

    const leafMeta = useMemo(() => {
        return buildLeafConeSnapMeta(supportState.leaves);
    }, [supportState.leaves]);

    const segmentPlacementSurfaceById = useMemo(() => {
        const map = new Map<string, 'interior' | 'exterior' | undefined>();
        for (const trunk of Object.values(supportState.trunks)) {
            for (const seg of trunk.segments) {
                map.set(seg.id, trunk.contactCone?.placementSurface);
            }
        }
        for (const branch of Object.values(supportState.branches)) {
            for (const seg of branch.segments) {
                map.set(seg.id, branch.contactCone?.placementSurface);
            }
        }
        for (const twig of Object.values(supportState.twigs)) {
            const placementSurface = twig.contactDiskA?.placementSurface ?? twig.contactDiskB?.placementSurface;
            for (const seg of twig.segments) {
                map.set(seg.id, placementSurface);
            }
        }
        for (const stick of Object.values(supportState.sticks)) {
            const placementSurface = stick.contactConeA?.placementSurface ?? stick.contactConeB?.placementSurface;
            for (const seg of stick.segments) {
                map.set(seg.id, placementSurface);
            }
        }
        for (const brace of Object.values(supportState.braces)) {
            map.set(`braceSegment:${brace.id}`, brace.placementSurface);
        }
        return map;
    }, [supportState.trunks, supportState.branches, supportState.twigs, supportState.sticks, supportState.braces]);

    const leafPlacementSurfaceById = useMemo(() => {
        const map = new Map<string, 'interior' | 'exterior' | undefined>();
        for (const leaf of Object.values(supportState.leaves)) {
            map.set(leaf.id, leaf.contactCone?.placementSurface);
        }
        return map;
    }, [supportState.leaves]);

    const resolveBracePlacementSurface = useCallback((
        startSurface?: 'interior' | 'exterior',
        endSurface?: 'interior' | 'exterior',
    ): 'interior' | 'exterior' | undefined => {
        if (startSurface === 'interior' || endSurface === 'interior') return 'interior';
        if (startSurface === 'exterior' || endSurface === 'exterior') return 'exterior';
        return startSurface ?? endSurface;
    }, []);

    const activePlacementSurface = useMemo(() => {
        if (!start) return undefined;
        if (start.kind === 'shaft') {
            return start.segmentId ? segmentPlacementSurfaceById.get(start.segmentId) : undefined;
        }
        return start.leafId ? leafPlacementSurfaceById.get(start.leafId) : undefined;
    }, [start, segmentPlacementSurfaceById, leafPlacementSurfaceById]);

    // Reverse lookup: twig segment id → owning twig. Lets the placement
    // controller resolve the live twig taper diameter at the snap point so
    // brace endpoint knots on twigs match the leaf-on-twig rule (1.10× of
    // the local twig diameter, not the legacy +0.1mm offset).
    const twigBySegmentId = useMemo(() => {
        const map = new Map<string, typeof supportState.twigs[string]>();
        for (const twig of Object.values(supportState.twigs)) {
            for (const seg of twig.segments) {
                map.set(seg.id, twig);
            }
        }
        return map;
    }, [supportState.twigs]);

    // For brace placement on a tapered twig, the snap's `hostDiameterMm`
    // initially carries the twig's placeholder shaft diameter (settings.tip
    // contact diameter), not the local taper. Override here so downstream
    // preview + knot sizing reflect the real local diameter.
    const overrideHostDiameterForTwig = useCallback(
        (segmentId: string | undefined | null, t: number | undefined | null, fallback: number | undefined): number | undefined => {
            if (!segmentId || t === undefined || t === null) return fallback;
            const twig = twigBySegmentId.get(segmentId);
            if (!twig) return fallback;
            const localDia = resolveTwigDiameterAtSegmentT(twig, segmentId, t);
            return localDia ?? fallback;
        },
        [twigBySegmentId]
    );

    // For a brace endpoint knot, pick the diameter so it visually matches the
    // host's joint sizing: twigs use 1.10× the local twig diameter (matching
    // disk-end joints and leaf bases); every other host uses the legacy
    // +0.1mm offset.
    const resolveBraceEndpointKnotDiameter = useCallback(
        (segmentId: string | undefined | null, hostDiameterMm: number): number => {
            if (segmentId && twigBySegmentId.has(segmentId)) {
                return twigJointDiameterForLocalDiameter(hostDiameterMm);
            }
            return hostDiameterMm + 0.1;
        },
        [twigBySegmentId]
    );

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

        const excludedSegmentIds = new Set<string>();
        if (start?.kind === 'shaft' && start.segmentId) {
            excludedSegmentIds.add(start.segmentId);
        }

        const targets: SnapTarget[] = buildSupportPathSnapTargets(supportState, {
            includeTrunks: true,
            includeBranches: true,
            includeBraces: true,
            includeTwigs: true,
            includeSticks: true,
            placementSurface: activePlacementSurface,
            excludeSegmentIds: excludedSegmentIds,
        });

        targets.push(...buildKickstandPathSnapTargets(kickstandState, { excludeSegmentIds: excludedSegmentIds }));
        targets.push(...buildLeafConePathSnapTargets(leafMeta, { placementSurface: activePlacementSurface }));

        return targets;
    }, [
        altActive,
        stage,
        start,
        activePlacementSurface,
        supportState.trunks,
        supportState.branches,
        supportState.braces,
        supportState.twigs,
        supportState.sticks,
        kickstandState.kickstands,
        leafMeta,
    ]);

    const targetById = useMemo(() => {
        return buildPrimarySnapTargetIndex(allTargets);
    }, [allTargets]);

    const targetCandidatesById = useMemo(() => {
        return buildSnapTargetCandidateIndex(allTargets);
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

    const { updateAndGetResolvedSnap, resetSnapping } = usePlacementSnappingSession(getTarget, getPotentialTargets);

    const publishPreview = useCallback((signature: string, preview: BracePreviewData | null) => {
        if (lastPreviewSignatureRef.current === signature) return;
        lastPreviewSignatureRef.current = signature;
        bracePlacementStore.setPreview(preview);
    }, []);

    useEffect(() => {
        if (!altActive || stage === 'idle') {
            lastPreviewSignatureRef.current = null;
        }
    }, [altActive, stage]);

    useEffect(() => {
        if (altActive) return;

        // If Alt is released, cancel placement and clear any lingering preview/hover visuals.
        // (useFrame may early-return when idle, so we must clear via an effect.)
        bracePlacementStore.reset();
        bracePlacementStore.setPreview(null);
        bracePlacementStore.setSnapTarget(null);
        resetSnapping();
    }, [altActive, resetSnapping]);

    const resolveNearestPathTarget = useCallback((targetId: string, point: Vec3) => {
        const candidates = getTargetCandidates(targetId).filter((target) => !!target.pathSegment);
        if (candidates.length === 0) return null;
        if (candidates.length === 1) return candidates[0];

        return selectNearestPathTarget(point, candidates) ?? candidates[0];
    }, [getTargetCandidates]);

    const resolveSnapFromClick = useCallback(
        (segmentId: string, point: Vec3) => {
            const target = resolveNearestPathTarget(segmentId, point) ?? getTarget(segmentId);
            if (!target?.pathSegment) return null;

            let hostDiameterMm: number | undefined = target.pathSegment.radius * 2;
            const ownerModelId = segmentMeta.get(segmentId)?.modelId;

            const projected = projectPointToSnapTargetPath(target, point);
            if (!projected) return null;

            const { t, pos } = projected;

            // On tapered twigs the segment's diameter is a placeholder; use
            // the live local taper diameter so the resulting knot ball and
            // brace endpoint shaft match the twig at this slide position.
            hostDiameterMm = overrideHostDiameterForTwig(segmentId, t, hostDiameterMm) ?? hostDiameterMm;

            return {
                kind: 'shaft' as const,
                segmentId,
                snappedPos: pos,
                t,
                hostDiameterMm,
                ownerModelId,
            };
        },
        [getTarget, resolveNearestPathTarget, segmentMeta, overrideHostDiameterForTwig]
    );

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
    }, [leafMeta]);

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

    // Leaf counterpart to resolveHoveredShaftSnap. The brace-leaf-hover event
    // (LeafRenderer) gives us {leafId, point} directly, so we can resolve a leaf
    // snap without the strict GPU-picker id match the global path requires (the
    // picker reports the cone's contactDiskId on a leaf, never the leaf id).
    const resolveHoveredLeafSnap = useCallback(() => {
        const hovered = hoveredLeafRef.current;
        if (!hovered?.leafId || !hovered.point) return null;
        return resolveLeafSnapFromClick(hovered.leafId, hovered.point);
    }, [hoveredLeafRef, resolveLeafSnapFromClick]);

    useFrame(() => {
        if (isSupportEditInteractionActive()) {
            if (!supportEditSuppressedRef.current) {
                supportEditSuppressedRef.current = true;
                bracePlacementStore.setSnapTarget(null);
                publishPreview('blocked:support-edit', null);
                resetSnapping();
            }
            return;
        }

        supportEditSuppressedRef.current = false;

        if (!altActive && stage === 'idle') return;

        // Fast path: when shaft-hover OR leaf-hover already provides a concrete
        // target+point, skip the heavier global snapping pass for this frame.
        // Leaves MUST use this path: the strict global snapper keys on the GPU
        // pick id, but hovering a leaf reports the cone's contactDiskId, which
        // never matches the leaf-keyed snap target — so the global path can't
        // lock a leaf. The brace-leaf-hover event gives us {leafId, point} directly.
        const hasHoveredShaftFastPath = !!(hoveredShaftRef.current?.segmentId && hoveredShaftRef.current?.point);
        const hasHoveredLeafFastPath = !!(hoveredLeafRef.current?.leafId && hoveredLeafRef.current?.point);
        const resolvedSnap = (hasHoveredShaftFastPath || hasHoveredLeafFastPath)
            ? { state: 'none' as const, targetId: null, snappedPos: null, t: null, metadata: null }
            : updateAndGetResolvedSnap();

        // Hover preview (before first click): show a knot-sized sphere on the hovered segment.
        if (stage === 'idle') {
            // If Branch is awaiting a base click, avoid showing brace hover previews.
            if (branchPlacementStore.getSnapshot().stage === 'awaitingBase') {
                bracePlacementStore.setSnapTarget(null);
                publishPreview('idle:branch-awaiting-base', null);
                return;
            }

            const hoveredSnap = resolveHoveredShaftSnap();
            if (hoveredSnap) {
                const settings = getSettings();
                const fallbackDia = settings.shaft.diameterMm;
                const hostDia = hoveredSnap.hostDiameterMm ?? fallbackDia;
                const preview = {
                    start: hoveredSnap.snappedPos,
                    end: hoveredSnap.snappedPos,
                    startDiameterMm: hostDia,
                    endDiameterMm: hostDia,
                };
                const signature = [
                    'brace:hovered-snap',
                    hoveredSnap.segmentId ?? 'none',
                    previewVecKey(hoveredSnap.snappedPos),
                    quantizePreviewValue(hostDia),
                ].join('|');
                publishPreview(signature, preview);
                bracePlacementStore.setSnapTarget(null);
                return;
            }

            // Leaf hover fast-path preview (counterpart to the shaft hover above).
            const hoveredLeafSnap = resolveHoveredLeafSnap();
            if (hoveredLeafSnap) {
                const settings = getSettings();
                const fallbackDia = settings.shaft.diameterMm;
                const hostDia = hoveredLeafSnap.hostDiameterMm ?? fallbackDia;
                const preview = {
                    start: hoveredLeafSnap.snappedPos,
                    end: hoveredLeafSnap.snappedPos,
                    startDiameterMm: hostDia,
                    endDiameterMm: hostDia,
                };
                const signature = [
                    'brace:hovered-leaf-snap',
                    hoveredLeafSnap.leafId ?? 'none',
                    previewVecKey(hoveredLeafSnap.snappedPos),
                    quantizePreviewValue(hostDia),
                ].join('|');
                publishPreview(signature, preview);
                bracePlacementStore.setSnapTarget(null);
                return;
            }

            if (resolvedSnap.state === 'locked' && resolvedSnap.targetId && resolvedSnap.snappedPos && resolvedSnap.t !== null) {
                const settings = getSettings();
                const fallbackDia = settings.shaft.diameterMm;

                if (leafMeta.has(resolvedSnap.targetId)) {
                    const resolved = resolveLeafSurface(resolvedSnap.targetId, resolvedSnap.snappedPos, resolvedSnap.t);
                    if (resolved) {
                        const preview = {
                            start: resolved.pos,
                            end: resolved.pos,
                            startDiameterMm: resolved.diameterMm,
                            endDiameterMm: resolved.diameterMm,
                        };
                        const signature = [
                            'brace:leaf-snap',
                            resolvedSnap.targetId,
                            previewVecKey(resolved.pos),
                            quantizePreviewValue(resolved.diameterMm),
                        ].join('|');
                        publishPreview(signature, preview);
                    } else {
                        publishPreview('brace:leaf-snap-invalid', null);
                    }
                } else {
                    const target = resolveNearestPathTarget(resolvedSnap.targetId, resolvedSnap.snappedPos) ?? getTarget(resolvedSnap.targetId);
                    let hostDia = target?.pathSegment?.radius !== undefined ? target.pathSegment.radius * 2 : fallbackDia;
                    if (resolvedSnap.targetId.startsWith('braceSegment:')) {
                        const braceId = resolvedSnap.targetId.slice('braceSegment:'.length);
                        const brace = supportState.braces[braceId];
                        if (brace) {
                            const resolvedDiameter = resolveBracePathDiameterAtT(brace, supportState.knots, resolvedSnap.t);
                            if (resolvedDiameter !== null) {
                                hostDia = resolvedDiameter;
                            }
                        }
                    }
                    hostDia = overrideHostDiameterForTwig(resolvedSnap.targetId, resolvedSnap.t, hostDia) ?? hostDia;
                    const preview = {
                        start: resolvedSnap.snappedPos,
                        end: resolvedSnap.snappedPos,
                        startDiameterMm: hostDia,
                        endDiameterMm: hostDia,
                    };
                    const signature = [
                        'brace:locked-snap',
                        resolvedSnap.targetId,
                        previewVecKey(resolvedSnap.snappedPos),
                        quantizePreviewValue(resolvedSnap.t),
                        quantizePreviewValue(hostDia),
                    ].join('|');
                    publishPreview(signature, preview);
                }
            } else {
                publishPreview('brace:idle-clear', null);
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
        const hoveredLeafSnapEnd = resolveHoveredLeafSnap();
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
        } else if (hoveredLeafSnapEnd) {
            // Leaf hover fast-path end target (counterpart to the shaft branch
            // above). resolveLeafSnapFromClick already clamps coneT off the tip.
            const leafSnap = hoveredLeafSnapEnd;
            const sameLeaf = start.kind === 'leaf' && start.leafId === leafSnap.leafId;
            const crossModel = !!(start.ownerModelId && leafSnap.ownerModelId && start.ownerModelId !== leafSnap.ownerModelId);

            if (sameLeaf || crossModel) {
                bracePlacementStore.setSnapTarget(null);
            } else {
                const snapTarget = {
                    kind: 'leaf' as const,
                    leafId: leafSnap.leafId,
                    coneT: leafSnap.coneT,
                    snappedPos: leafSnap.snappedPos,
                    hostDiameterMm: leafSnap.hostDiameterMm,
                    ownerModelId: leafSnap.ownerModelId,
                };
                bracePlacementStore.setSnapTarget(snapTarget);
                endPos = snapTarget.snappedPos;
                endDiam = snapTarget.hostDiameterMm ?? fallbackDia;
            }
        } else if (resolvedSnap.state === 'locked' && resolvedSnap.targetId && resolvedSnap.snappedPos && resolvedSnap.t !== null) {
            if (leafMeta.has(resolvedSnap.targetId)) {
                const startModelId = start.ownerModelId;
                const meta = leafMeta.get(resolvedSnap.targetId);
                if (meta && startModelId && meta.modelId && startModelId !== meta.modelId) {
                    bracePlacementStore.setSnapTarget(null);
                } else {
                    const resolved = resolveLeafSurface(resolvedSnap.targetId, resolvedSnap.snappedPos, resolvedSnap.t);
                    const minMm = 0.25;
                    const minT = meta ? THREE.MathUtils.clamp(minMm / Math.max(0.0001, meta.lengthMm), 0, 0.99) : 0;
                    const coneT = Math.max(resolvedSnap.t, minT);

                    const sameLeaf = start.kind === 'leaf' && start.leafId === resolvedSnap.targetId;

                    if (resolved && !sameLeaf) {
                        const snapTarget = {
                            kind: 'leaf' as const,
                            leafId: resolvedSnap.targetId,
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
                const target = resolveNearestPathTarget(resolvedSnap.targetId, resolvedSnap.snappedPos) ?? getTarget(resolvedSnap.targetId);
                let hostDiameterMm = target?.pathSegment?.radius !== undefined ? target.pathSegment.radius * 2 : undefined;
                let ownerModelId = segmentMeta.get(resolvedSnap.targetId)?.modelId;

                if (resolvedSnap.targetId.startsWith('braceSegment:')) {
                    const braceId = resolvedSnap.targetId.slice('braceSegment:'.length);
                    const brace = supportState.braces[braceId];
                    if (brace) {
                        const resolvedDiameter = resolveBracePathDiameterAtT(brace, supportState.knots, resolvedSnap.t);
                        if (resolvedDiameter !== null) {
                            hostDiameterMm = resolvedDiameter;
                        }
                        ownerModelId = brace.modelId;
                    }
                }

                hostDiameterMm = overrideHostDiameterForTwig(resolvedSnap.targetId, resolvedSnap.t, hostDiameterMm) ?? hostDiameterMm;

                const snapTarget = {
                    kind: 'shaft' as const,
                    segmentId: resolvedSnap.targetId,
                    snappedPos: resolvedSnap.snappedPos,
                    t: resolvedSnap.t,
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
                } else if (snapTarget.segmentId && isValidEndSegment(snapTarget.segmentId)) {
                    bracePlacementStore.setSnapTarget(snapTarget);
                    endPos = snapTarget.snappedPos;
                    endDiam = snapTarget.hostDiameterMm ?? fallbackDia;
                } else {
                    bracePlacementStore.setSnapTarget(null);
                }
            }
        } else {
            bracePlacementStore.setSnapTarget(null);
        }

        const preview = {
            start: start.snappedPos,
            end: endPos,
            startDiameterMm: startDiam,
            endDiameterMm: endDiam,
        };
        const previewSignature = [
            'brace:active',
            start.kind,
            start.segmentId ?? start.leafId ?? 'none',
            previewVecKey(start.snappedPos),
            previewVecKey(endPos),
            quantizePreviewValue(startDiam),
            quantizePreviewValue(endDiam),
            previewVecKey(resolvedSnap.state === 'locked' ? resolvedSnap.snappedPos ?? null : null),
        ].join('|');
        publishPreview(previewSignature, preview);
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

    // Leaf hover plumbing — counterpart to the shaft-hover effect above.
    // Lets the brace tool show a snap preview on a leaf and feed the click
    // handlers a resolved leaf snap, without depending on the strict picker.
    useEffect(() => {
        const handleLeafHover = (evt: Event) => {
            const detail = (evt as CustomEvent<LeafHoverDetail>).detail;
            if (!detail?.leafId || !detail.point) return;
            hoveredLeafRef.current = {
                leafId: detail.leafId,
                point: detail.point,
            };
        };

        const handleLeafLeave = (evt: Event) => {
            const detail = (evt as CustomEvent<{ leafId?: string | null }>).detail;
            if (!detail?.leafId) {
                hoveredLeafRef.current = null;
                return;
            }

            if (hoveredLeafRef.current?.leafId === detail.leafId) {
                hoveredLeafRef.current = null;
            }
        };

        window.addEventListener('brace-leaf-hover', handleLeafHover as EventListener);
        window.addEventListener('brace-leaf-leave', handleLeafLeave as EventListener);

        return () => {
            window.removeEventListener('brace-leaf-hover', handleLeafHover as EventListener);
            window.removeEventListener('brace-leaf-leave', handleLeafLeave as EventListener);
            hoveredLeafRef.current = null;
        };
    }, [hoveredLeafRef]);

    useEffect(() => {
        if (!altActive && stage === 'idle') {
            resetSnapping();
        }
    }, [altActive, stage, resetSnapping]);

    useEffect(() => {
        const handleShaftClick = (evt: Event) => {
            const detail = (evt as CustomEvent<ShaftClickDetail>).detail;
            const branchFamilyHeld = !!altActive
                || isSupportPlacementBindingSatisfiedByModifierState(branchFamilyBinding, getSupportPlacementModifierState(detail?.intersection));
            if (!branchFamilyHeld) return;

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
                const braceDia = getAutoBracingSettings().braceDiameterMm;
                const fallbackDia = settings.shaft.diameterMm;
                const startDiam = Math.min(snap.hostDiameterMm ?? fallbackDia, braceDia);
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
                const braceDia = getAutoBracingSettings().braceDiameterMm;
                const fallback = settings.shaft.diameterMm;
                const startDiam = Math.min(start.hostDiameterMm ?? fallback, braceDia);
                const endDiam = Math.min(endSnap.hostDiameterMm ?? fallback, braceDia);

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
                    diameter: resolveBraceEndpointKnotDiameter(endSnap.segmentId, endDiam),
                };

                const modelId = start.ownerModelId ?? endSnap.ownerModelId ?? 'unknown';
                const placementSurface = resolveBracePlacementSurface(
                    leafPlacementSurfaceById.get(start.leafId),
                    endSnap.segmentId ? segmentPlacementSurfaceById.get(endSnap.segmentId) : undefined,
                );

                const brace: Brace = {
                    id: braceId,
                    modelId,
                    startKnotId,
                    endKnotId,
                    placementSurface,
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
                clearSupportSelection();
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
            const braceDia = getAutoBracingSettings().braceDiameterMm;
            const fallback = settings.shaft.diameterMm;
            const startDiam = Math.min(start.hostDiameterMm ?? fallback, braceDia);
            const endDiam = Math.min(endSnap.hostDiameterMm ?? fallback, braceDia);

            const braceId = generateUuid();
            const startKnotId = generateUuid();
            const endKnotId = generateUuid();

            const startKnot: Knot = {
                id: startKnotId,
                parentShaftId: start.segmentId,
                t: start.t,
                pos: start.snappedPos,
                diameter: resolveBraceEndpointKnotDiameter(start.segmentId, startDiam),
            };

            const endKnot: Knot = {
                id: endKnotId,
                parentShaftId: endSnap.segmentId,
                t: endSnap.t,
                pos: endSnap.snappedPos,
                diameter: resolveBraceEndpointKnotDiameter(endSnap.segmentId, endDiam),
            };

            const modelId = startModelId ?? endModelId ?? 'unknown';
            const placementSurface = resolveBracePlacementSurface(
                segmentPlacementSurfaceById.get(start.segmentId),
                endSnap.segmentId ? segmentPlacementSurfaceById.get(endSnap.segmentId) : undefined,
            );

            const brace: Brace = {
                id: braceId,
                modelId,
                startKnotId,
                endKnotId,
                placementSurface,
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
            clearSupportSelection();
        };

        window.addEventListener('shaft-click', handleShaftClick as EventListener, true);
        return () => window.removeEventListener('shaft-click', handleShaftClick as EventListener, true);
    }, [altActive, stage, start, branchFamilyBinding, resolveSnapFromClick, isValidEndSegment, segmentMeta, leafPlacementSurfaceById, segmentPlacementSurfaceById, resolveBracePlacementSurface]);

    useEffect(() => {
        const handleLeafClick = (evt: Event) => {
            const detail = (evt as CustomEvent<LeafClickDetail>).detail;
            const branchFamilyHeld = !!altActive
                || isSupportPlacementBindingSatisfiedByModifierState(branchFamilyBinding, getSupportPlacementModifierState(detail?.intersection));
            if (!branchFamilyHeld) return;

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
                const braceDia = getAutoBracingSettings().braceDiameterMm;
                const fallbackDia = settings.shaft.diameterMm;
                const startDiam = Math.min(snap.hostDiameterMm ?? fallbackDia, braceDia);
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
                const braceDia = getAutoBracingSettings().braceDiameterMm;
                const fallback = settings.shaft.diameterMm;
                const startDiam = Math.min(start.hostDiameterMm ?? fallback, braceDia);
                const endDiam = Math.min(endSnap.hostDiameterMm ?? fallback, braceDia);

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
                const placementSurface = resolveBracePlacementSurface(
                    leafPlacementSurfaceById.get(start.leafId),
                    leafPlacementSurfaceById.get(leafId),
                );
                const brace: Brace = {
                    id: braceId,
                    modelId,
                    startKnotId,
                    endKnotId,
                    placementSurface,
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
                diameter: resolveBraceEndpointKnotDiameter(start.segmentId, startDiam),
            };

            const endKnot: Knot = {
                id: endKnotId,
                parentShaftId: `leafCone:${leafId}`,
                t: endSnap.coneT,
                pos: endSnap.snappedPos,
                diameter: endDiam + 0.1,
            };

            const modelId = startModelId ?? endModelId ?? 'unknown';
            const placementSurface = resolveBracePlacementSurface(
                segmentPlacementSurfaceById.get(start.segmentId),
                leafPlacementSurfaceById.get(leafId),
            );
            const brace: Brace = {
                id: braceId,
                modelId,
                startKnotId,
                endKnotId,
                placementSurface,
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

        window.addEventListener('brace-leaf-click', handleLeafClick as EventListener, true);
        return () => window.removeEventListener('brace-leaf-click', handleLeafClick as EventListener, true);
    }, [altActive, stage, start, branchFamilyBinding, resolveLeafSnapFromClick, resolveSnapFromClick, leafPlacementSurfaceById, segmentPlacementSurfaceById, resolveBracePlacementSurface]);

    return null;
}
