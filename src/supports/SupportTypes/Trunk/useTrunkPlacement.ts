import { useCallback, useState, useEffect, useRef } from 'react';
import * as THREE from 'three';
import { addAnchor, addBranch, addKnot, addLeaf, addRoot, addStick, addTrunk, addTwig, getSnapshot, setSnapshot, updateKnot, updateTrunk } from '../../state';
import { pushHistory } from '@/history/historyStore';
import { SUPPORT_ADD_ANCHOR, SUPPORT_ADD_BRANCH, SUPPORT_ADD_LEAF, SUPPORT_ADD_STICK, SUPPORT_ADD_TRUNK, SUPPORT_ADD_TWIG } from '../../history/actionTypes';
import { useInteractionStatus } from '../../interaction/useInteractionStatus';
import { buildTrunkData } from './trunkBuilder';
import { applyTrunkReplacement, computeAndApplyTrunkDiameterProfile, planTrunkReplacement } from './TrunkReplacement';
import type { SupportData } from '../../rendering/SupportBuilder';
import type { Anchor, Branch, ContactDisk, Leaf, LimitationCode, Stick, Twig, WarningCode } from '../../types';
import type { ContactCone } from '../../SupportPrimitives/ContactCone/types';
import { calculateSmoothedNormal } from '../../PlacementLogic/PlacementUtils';
import { getSettings } from '../../Settings';
import { decideGridPlacement } from '../../PlacementLogic/Grid';
import { clearSupportSelection } from '../../interaction/shared/selection/selectionController';
import { isContactDiskHudInteractionActive, shouldSuppressContactDiskHudPlacementCommit } from '../../SupportPrimitives/ContactDisk/contactDiskHudInteraction';
import { perfMark, perfMeasureWithSpike, perfEndFrame } from '../../PlacementLogic/Pathfinding/pathfindingPerf';
import { buildStick } from '../Stick/stickBuilder';
import { buildTwig } from '../Twig/twigBuilder';
import { useActionActive } from '@/hotkeys/hotkeyStore';
import { getSupportPathfindingDebugEnabled, setSupportPathfindingDebugSnapshot } from '../../PlacementLogic/Pathfinding/pathfindingDebugState';

// ---------------------------------------------------------------------------
// Cavity stick helpers
// ---------------------------------------------------------------------------

const _cavityRaycaster = new THREE.Raycaster();
const _downDir = new THREE.Vector3(0, 0, -1);
const CAVITY_PREVIEW_CACHE_POS_EPSILON_MM = 1.0;
const CAVITY_PREVIEW_CACHE_NORMAL_DOT_MIN = 0.99;
const CAVITY_PREVIEW_CACHE_MISS_MAX_AGE_MS = 220;

type PlacementSurface = 'interior' | 'exterior';

function getPlacementSurfaceFromHit(hit: THREE.Intersection | null): PlacementSurface | undefined {
    return hit?.object?.userData?.supportPlacementSurface === 'interior' ? 'interior' : undefined;
}

function markContactConePlacementSurface<T extends ContactCone | undefined>(cone: T, surface?: PlacementSurface): T {
    if (!cone || !surface) return cone;
    return {
        ...cone,
        placementSurface: surface,
    } as T;
}

function markContactDiskPlacementSurface<T extends ContactDisk | undefined>(disk: T, surface?: PlacementSurface): T {
    if (!disk || !surface) return disk;
    return {
        ...disk,
        placementSurface: surface,
    } as T;
}

function markSupportDataPlacementSurface(data: SupportData, surface?: PlacementSurface): SupportData {
    if (!surface) return data;
    return {
        ...data,
        contactCone: markContactConePlacementSurface(data.contactCone, surface),
        contactCones: data.contactCones?.map((cone) => markContactConePlacementSurface(cone, surface)),
        contactDisks: data.contactDisks?.map((disk) => markContactDiskPlacementSurface(disk, surface)),
    };
}

function markTrunkBuildPlacementSurface<T extends ReturnType<typeof buildTrunkData>>(build: T, surface?: PlacementSurface): T {
    if (!surface) return build;
    return {
        ...build,
        trunk: {
            ...build.trunk,
            contactCone: markContactConePlacementSurface(build.trunk.contactCone, surface),
        },
        supportData: markSupportDataPlacementSurface(build.supportData, surface),
    } as T;
}

function markBranchPlacementSurface(branch: Branch, surface?: PlacementSurface): Branch {
    if (!surface) return branch;
    return {
        ...branch,
        contactCone: markContactConePlacementSurface(branch.contactCone, surface),
    };
}

function markLeafPlacementSurface(leaf: Leaf, surface?: PlacementSurface): Leaf {
    if (!surface) return leaf;
    return {
        ...leaf,
        contactCone: markContactConePlacementSurface(leaf.contactCone, surface),
    };
}

function markAnchorPlacementSurface(anchor: Anchor, surface?: PlacementSurface): Anchor {
    if (!surface) return anchor;
    return {
        ...anchor,
        contactCone: markContactConePlacementSurface(anchor.contactCone, surface),
    };
}

function markStickPlacementSurface(stick: Stick, surface?: PlacementSurface): Stick {
    if (!surface) return stick;
    return {
        ...stick,
        contactConeA: markContactConePlacementSurface(stick.contactConeA, surface),
        contactConeB: markContactConePlacementSurface(stick.contactConeB, surface),
    };
}

function markTwigPlacementSurface(twig: Twig, surface?: PlacementSurface): Twig {
    if (!surface) return twig;
    return {
        ...twig,
        contactDiskA: markContactDiskPlacementSurface(twig.contactDiskA, surface),
        contactDiskB: markContactDiskPlacementSurface(twig.contactDiskB, surface),
    };
}

/**
 * When A* stagnates (tip is inside a closed cavity), attempt to find the
 * cavity floor by raycasting straight down.  Returns a buildStick result +
 * a SupportData preview object, or null if no lower surface is found.
 */
function buildCavityStick(
    tipPos: { x: number; y: number; z: number },
    tipNormal: { x: number; y: number; z: number },
    modelId: string,
    mesh: THREE.Mesh,
): (
    | { kind: 'stick'; supportData: SupportData; stick: ReturnType<typeof buildStick>['stick'] }
    | { kind: 'twig'; supportData: SupportData; twig: ReturnType<typeof buildTwig>['twig'] }
) | null {
    _cavityRaycaster.set(
        new THREE.Vector3(tipPos.x, tipPos.y, tipPos.z),
        _downDir,
    );
    // Offset origin slightly inward along tip normal so we don't self-hit the
    // surface we just clicked.
    const OFFSET_MM = 0.5;
    _cavityRaycaster.ray.origin.addScaledVector(
        new THREE.Vector3(tipNormal.x, tipNormal.y, tipNormal.z),
        OFFSET_MM,
    );
    _cavityRaycaster.ray.origin.z -= OFFSET_MM * 0.1; // nudge down past origin surface

    const hits = _cavityRaycaster.intersectObject(mesh, false);
    if (hits.length === 0) return null;

    // Prefer a true "floor" hit (normal has meaningful +Z) so the bottom
    // endpoint clings vertically down when possible. Only fall back to any
    // below-tip hit (e.g. sidewall) if no floor-like surface is found.
    const BELOW_EPS_MM = 0.1;
    const FLOOR_Z_MIN = 0.35;
    const normalMatrix = new THREE.Matrix3().getNormalMatrix(mesh.matrixWorld);

    type Candidate = { hit: THREE.Intersection; normal: THREE.Vector3 };
    const MAX_HIT_SCAN = 64;
    let scanned = 0;
    let firstBelowCandidate: Candidate | null = null;
    let floorCandidate: Candidate | null = null;

    for (const h of hits) {
        scanned += 1;
        if (scanned > MAX_HIT_SCAN) break;
        if (h.point.z >= tipPos.z - BELOW_EPS_MM) continue;
        if (!h.face) continue;
        const n = h.face.normal.clone().applyNormalMatrix(normalMatrix).normalize();
        const candidate = { hit: h, normal: n };
        if (!firstBelowCandidate) firstBelowCandidate = candidate;
        if (n.z >= FLOOR_Z_MIN) {
            floorCandidate = candidate;
            break;
        }
    }

    const chosen = floorCandidate ?? firstBelowCandidate;
    if (!chosen) return null;

    const bPos = { x: chosen.hit.point.x, y: chosen.hit.point.y, z: chosen.hit.point.z };
    const bNormal = { x: chosen.normal.x, y: chosen.normal.y, z: chosen.normal.z };

    const settings = getSettings();
    const cutoff = settings.meshToMesh?.stickVsTwigCutoffMm ?? 5;
    const dx = tipPos.x - bPos.x;
    const dy = tipPos.y - bPos.y;
    const dz = tipPos.z - bPos.z;
    const dist = Math.sqrt(dx * dx + dy * dy + dz * dz);
    const kind: 'twig' | 'stick' = dist > cutoff ? 'stick' : 'twig';

    if (kind === 'twig') {
        const { twig } = buildTwig({ modelId, aPos: tipPos, aNormal: tipNormal, bPos, bNormal });
        const supportData: SupportData = {
            id: twig.id,
            segments: twig.segments,
            contactDisks: [twig.contactDiskA, twig.contactDiskB],
        };
        return { kind, twig, supportData };
    }

    const { stick } = buildStick({ modelId, aPos: tipPos, aNormal: tipNormal, bPos, bNormal });

    const supportData: SupportData = {
        id: stick.id,
        segments: stick.segments,
        contactCones: [stick.contactConeA, stick.contactConeB],
    };

    return { kind: 'stick', stick, supportData };
}

type CavityStickBuildResult = NonNullable<ReturnType<typeof buildCavityStick>>;

export function useTrunkPlacementV2() {
    // Debounce tuned for human hand drift (~1-2mm) and 60fps target.
    // Values tight enough to feel responsive, loose enough to skip micro-jitter.
    const HOVER_MIN_INTERVAL_MS = 12;
    const HOVER_POS_EPSILON_MM = 0.5;
    const HOVER_NORMAL_DOT_MIN = 0.995;
    const forcePlaceActive = useActionActive('SUPPORTS', 'FORCE_PLACE_SUPPORT');

    const [previewData, setPreviewData] = useState<SupportData | null>(null);
    const [previewError, setPreviewError] = useState<LimitationCode | null>(null);
    const [previewWarning, setPreviewWarning] = useState<WarningCode | null>(null);
    const { isPlacementHardDisabled } = useInteractionStatus();
    const hoverFrameRef = useRef<number | null>(null);
    const latestHoverRef = useRef<THREE.Intersection | null>(null);
    const forcePlaceOverrideRef = useRef(false);
    const hoverNormalRef = useRef(new THREE.Vector3());
    const cavityPreviewCacheNormalRef = useRef(new THREE.Vector3());
    const cavityPreviewCacheRef = useRef<{
        objectUuid: string;
        modelId: string;
        point: THREE.Vector3;
        normal: THREE.Vector3;
        atMs: number;
        result: CavityStickBuildResult | null;
    } | null>(null);
    const lastProcessedHoverRef = useRef<{
        objectUuid: string;
        modelId: string;
        point: THREE.Vector3;
        normal: THREE.Vector3;
        atMs: number;
    } | null>(null);

    const clearPreview = useCallback(() => {
        setPreviewData((prev) => (prev === null ? prev : null));
        setPreviewError((prev) => (prev === null ? prev : null));
        setPreviewWarning((prev) => (prev === null ? prev : null));
        cavityPreviewCacheRef.current = null;
        if (getSupportPathfindingDebugEnabled()) {
            setSupportPathfindingDebugSnapshot(null);
        }
    }, []);

    const commitTrunkBuild = useCallback((trunkBuild: ReturnType<typeof buildTrunkData>, placementSurface?: PlacementSurface) => {
        const markedBuild = markTrunkBuildPlacementSurface(trunkBuild, placementSurface);
        addRoot(markedBuild.root);
        addTrunk(markedBuild.trunk);
        pushHistory({
            type: SUPPORT_ADD_TRUNK,
            payload: {
                trunk: markedBuild.trunk,
                root: markedBuild.root,
            },
        });
        clearSupportSelection();
    }, []);

    const resolveCavityStickPreview = useCallback((
        hit: THREE.Intersection,
        tipPos: { x: number; y: number; z: number },
        tipNormal: { x: number; y: number; z: number },
        modelId: string,
        mesh: THREE.Mesh,
    ): CavityStickBuildResult | null => {
        const now = performance.now();
        const cached = cavityPreviewCacheRef.current;
        if (cached && cached.objectUuid === hit.object.uuid && cached.modelId === modelId && cached.result === null) {
            if ((now - cached.atMs) <= CAVITY_PREVIEW_CACHE_MISS_MAX_AGE_MS) {
                const posEpsSq = CAVITY_PREVIEW_CACHE_POS_EPSILON_MM * CAVITY_PREVIEW_CACHE_POS_EPSILON_MM;
                if (cached.point.distanceToSquared(hit.point) <= posEpsSq) {
                    cavityPreviewCacheNormalRef.current.set(tipNormal.x, tipNormal.y, tipNormal.z);
                    if (cached.normal.dot(cavityPreviewCacheNormalRef.current) >= CAVITY_PREVIEW_CACHE_NORMAL_DOT_MIN) {
                        return cached.result;
                    }
                }
            }
        }

        const computed = buildCavityStick(tipPos, tipNormal, modelId, mesh);

        // Cache only misses; successful stick previews should track pointer motion
        // continuously and must not reuse stale geometry.
        if (!computed) {
            cavityPreviewCacheRef.current = {
                objectUuid: hit.object.uuid,
                modelId,
                point: hit.point.clone(),
                normal: new THREE.Vector3(tipNormal.x, tipNormal.y, tipNormal.z),
                atMs: now,
                result: null,
            };
        } else {
            cavityPreviewCacheRef.current = null;
        }

        return computed;
    }, []);

    // Auto-clear preview when placement is disabled (e.g. hovering another object)
    useEffect(() => {
        if (isPlacementHardDisabled) {
            const frame = requestAnimationFrame(() => {
                clearPreview();
            });
            return () => cancelAnimationFrame(frame);
        }
    }, [clearPreview, isPlacementHardDisabled]);

    useEffect(() => {
        return () => {
            if (hoverFrameRef.current !== null) {
                cancelAnimationFrame(hoverFrameRef.current);
                hoverFrameRef.current = null;
            }
        };
    }, []);

    const processSupportHover = useCallback((hit: THREE.Intersection | null) => {
        if (isContactDiskHudInteractionActive()) {
            clearPreview();
            lastProcessedHoverRef.current = null;
            return;
        }

        if (isPlacementHardDisabled) {
            clearPreview();
            lastProcessedHoverRef.current = null;
            return;
        }

        if (!hit) {
            clearPreview();
            lastProcessedHoverRef.current = null;
            return;
        }

        const modelId = hit.object.userData.modelId || 'unknown';
        const objectUuid = hit.object.uuid;

        // Keep hover preview on the same normal basis as click placement to
        // avoid preview-only false collision reports near tolerance boundaries.
        const tipNormal = calculateSmoothedNormal(hit);

        const now = performance.now();
        hoverNormalRef.current.set(tipNormal.x, tipNormal.y, tipNormal.z);
        const prev = lastProcessedHoverRef.current;
        if (prev && prev.objectUuid === objectUuid && prev.modelId === modelId) {
            const dt = now - prev.atMs;
            const posDeltaSq = prev.point.distanceToSquared(hit.point);
            const normalDot = prev.normal.dot(hoverNormalRef.current);
            const posEpsSq = HOVER_POS_EPSILON_MM * HOVER_POS_EPSILON_MM;

            if (dt < HOVER_MIN_INTERVAL_MS && posDeltaSq <= posEpsSq && normalDot >= HOVER_NORMAL_DOT_MIN) {
                return;
            }
        }

        if (prev) {
            prev.objectUuid = objectUuid;
            prev.modelId = modelId;
            prev.point.copy(hit.point);
            prev.normal.copy(hoverNormalRef.current);
            prev.atMs = now;
        } else {
            lastProcessedHoverRef.current = {
                objectUuid,
                modelId,
                point: hit.point.clone(),
                normal: hoverNormalRef.current.clone(),
                atMs: now,
            };
        }

        const tipPos = { x: hit.point.x, y: hit.point.y, z: hit.point.z };

        perfMark('hover:total');
        const settings = getSettings();
        const isGridMode = Boolean(settings.grid?.enabled && settings.grid.spacingMm > 0);

        // Grid mode is intentionally grid-native: build a cheap straight
        // candidate, then let the fixed-grid resolver snap/merge/reject it.
        // Feeding the mesh here starts the flexible A* router, which is the
        // wrong cost model for hover on a fixed lattice.
        const mesh = hit.object instanceof THREE.Mesh ? hit.object : undefined;

        perfMark('hover:trunk-build');
        const result = buildTrunkData({ tipPos, tipNormal, modelId, mesh: isGridMode ? undefined : mesh, isPreview: true });
        perfMeasureWithSpike('hover:trunk-build', 'trunk:build');

        // Fast-path for cavity hover when the trunk can't route to the build
        // plate: try a stick/twig bridge to the nearest surface below the tip.
        // This covers stagnation, budget exhaustion, AND general collision errors
        // (e.g. tip inside a "mouth" cavity where the straight path is blocked).
        //
        // IMPORTANT: ANGLE_TOO_STEEP (shallow angle / upward face) is a hard
        // surface rejection that prevents ALL support types — do NOT fall back
        // to a stick or twig for this error.
        const cavityStickEligible = result.stagnated || result.exhaustedBudget
            || (result.error && result.error !== 'ANGLE_TOO_STEEP');
        if (cavityStickEligible) {
            if (mesh) {
                perfMark('hover:cavity-stick');
                const cavityStick = resolveCavityStickPreview(hit, tipPos, tipNormal, modelId, mesh);
                perfMeasureWithSpike('hover:cavity-stick', 'branch:cavity-stick');
                if (cavityStick) {
                    setPreviewData(cavityStick.supportData);
                    setPreviewError(null);
                    setPreviewWarning(null);
                    perfEndFrame();
                    return;
                }
            }
            // No cavity floor found — show the trunk error as fallback.
            if (result.stagnated || result.exhaustedBudget) {
                setPreviewData(result.supportData);
                setPreviewError(forcePlaceOverrideRef.current ? null : (result.error || null));
                setPreviewWarning(null);
                perfEndFrame();
                return;
            }
            // For non-stagnation errors, fall through to grid placement decision
            // (which may still place a branch or reject).
        }

        // When grid is disabled, the trunk candidate is already final — skip
        // the grid snapping/branch logic entirely.
        if (!isGridMode) {
            setPreviewData(result.supportData);
            setPreviewError(forcePlaceOverrideRef.current ? null : (result.error || null));
            setPreviewWarning(result.warning || null);
            perfEndFrame();
            return;
        }

        // ANGLE_TOO_STEEP is a hard surface rejection (shallow angle / upward
        // face) that prevents ALL support types — trunk, branch, leaf, and
        // stick alike.  Reject immediately instead of deferring to grid
        // placement which would offer branches as a fallback.
        if (result.error === 'ANGLE_TOO_STEEP') {
            setPreviewData(result.supportData);
            setPreviewError(forcePlaceOverrideRef.current ? null : result.error);
            setPreviewWarning(null);
            perfEndFrame();
            return;
        }

        perfMark('hover:grid-decision');
        const decision = decideGridPlacement({
            settings,
            snapshot: getSnapshot(),
            candidate: result,
            tipPos,
            tipNormal,
            modelId,
            mesh,
            isPreview: true,
        });
        perfMeasureWithSpike('hover:grid-decision', 'grid:decision');

        if (decision.kind === 'place_trunk') {
            setPreviewData(decision.trunkBuild.supportData);
            setPreviewError(forcePlaceOverrideRef.current ? null : (decision.trunkBuild.error || null));
            setPreviewWarning(decision.trunkBuild.warning || null);
            perfEndFrame();
            return;
        }

        if (decision.kind === 'replace_trunk') {
            setPreviewData(decision.trunkBuild.supportData);
            setPreviewError(forcePlaceOverrideRef.current ? null : (decision.trunkBuild.error || null));
            setPreviewWarning(decision.trunkBuild.warning || null);
            perfEndFrame();
            return;
        }

        if (decision.kind === 'place_branch') {
            setPreviewData(decision.supportData);
            setPreviewError(null);
            setPreviewWarning(null);
            perfEndFrame();
            return;
        }

        if (decision.kind === 'place_leaf') {
            setPreviewData(decision.supportData);
            setPreviewError(null);
            setPreviewWarning(null);
            perfEndFrame();
            return;
        }

        if (decision.kind === 'place_anchor') {
            setPreviewData(decision.supportData);
            setPreviewError(null);
            setPreviewWarning(null);
            perfEndFrame();
            return;
        }

        // reject
        if (decision.kind === 'reject' && decision.reason === 'COLLISION_WITH_MODEL' && mesh) {
            perfMark('hover:cavity-stick');
            const cavityStick = resolveCavityStickPreview(hit, tipPos, tipNormal, modelId, mesh);
            perfMeasureWithSpike('hover:cavity-stick', 'branch:cavity-stick');
            if (cavityStick) {
                setPreviewData(cavityStick.supportData);
                setPreviewError(null);
                setPreviewWarning(null);
                perfEndFrame();
                return;
            }
        }

        if (decision.trunkBuild) {
            setPreviewData(decision.trunkBuild.supportData);
            setPreviewError(forcePlaceOverrideRef.current ? null : (decision.trunkBuild.error || null));
            setPreviewWarning(decision.trunkBuild.warning || null);
            perfEndFrame();
            return;
        }

        setPreviewData((prev) => (prev === null ? prev : null));
        setPreviewError(forcePlaceOverrideRef.current
            ? null
            : decision.reason === 'KNOT_ABOVE_TIP'
                ? 'KNOT_ABOVE_TIP'
                : decision.reason === 'COLLISION_WITH_MODEL'
                    ? 'COLLISION_WITH_MODEL'
                    : null
        );
        setPreviewWarning((prev) => (prev === null ? prev : null));
        perfEndFrame();
    }, [HOVER_MIN_INTERVAL_MS, HOVER_NORMAL_DOT_MIN, HOVER_POS_EPSILON_MM, clearPreview, isPlacementHardDisabled, resolveCavityStickPreview]);

    useEffect(() => {
        forcePlaceOverrideRef.current = forcePlaceActive;
        if (hoverFrameRef.current === null) {
            hoverFrameRef.current = requestAnimationFrame(() => {
                hoverFrameRef.current = null;
                processSupportHover(latestHoverRef.current);
            });
        }
    }, [forcePlaceActive, processSupportHover]);

    const onSupportHover = useCallback((hit: THREE.Intersection | null) => {
        latestHoverRef.current = hit;

        if (hoverFrameRef.current !== null) return;

        hoverFrameRef.current = requestAnimationFrame(() => {
            hoverFrameRef.current = null;
            processSupportHover(latestHoverRef.current);
        });
    }, [processSupportHover]);

    const onSupportClick = useCallback((hit: THREE.Intersection) => {
        if (isPlacementHardDisabled || !hit) return;
        // Suppress placement if a contact-disk HUD drag just ended; the
        // mouseup that ends the drag would otherwise propagate to the canvas
        // and be interpreted as a trunk placement click.
        if (shouldSuppressContactDiskHudPlacementCommit()) return;

        // Re-calculate smoothed normal for click
        const tipNormal = calculateSmoothedNormal(hit);
        const tipPos = { x: hit.point.x, y: hit.point.y, z: hit.point.z };
        const modelId = hit.object.userData.modelId || 'unknown';
        const placementSurface = getPlacementSurfaceFromHit(hit);
        
        const settings = getSettings();
        const isGridMode = Boolean(settings.grid?.enabled && settings.grid.spacingMm > 0);

        // In grid mode, avoid the flexible A* route search entirely. The grid
        // resolver owns snapping and same-node merge behavior.
        const mesh = hit.object instanceof THREE.Mesh ? hit.object : undefined;
        const result = buildTrunkData({ tipPos, tipNormal, modelId, mesh: isGridMode ? undefined : mesh });

        // When the trunk can't route to the build plate (stagnation, budget
        // exhaustion, or general collision), fall back to a cavity stick/twig
        // that spans from the tip down to the nearest surface below.
        //
        // IMPORTANT: ANGLE_TOO_STEEP (shallow angle / upward face) is a hard
        // surface rejection that prevents ALL support types — do NOT fall back
        // to a stick or twig for this error.
        const cavityStickEligible = result.stagnated || result.exhaustedBudget
            || (result.error && result.error !== 'ANGLE_TOO_STEEP');
        if (cavityStickEligible) {
            if (mesh) {
                const cavityStick = buildCavityStick(tipPos, tipNormal, modelId, mesh);
                if (cavityStick) {
                    if (cavityStick.kind === 'twig') {
                        const twig = markTwigPlacementSurface(cavityStick.twig, placementSurface);
                        addTwig(twig);
                        pushHistory({
                            type: SUPPORT_ADD_TWIG,
                            payload: { twig },
                        });
                    } else {
                        const stick = markStickPlacementSurface(cavityStick.stick, placementSurface);
                        addStick(stick);
                        pushHistory({
                            type: SUPPORT_ADD_STICK,
                            payload: { stick },
                        });
                    }
                    clearSupportSelection();
                    return;
                }
            }
            // No cavity floor found — for stagnation/budget, bail silently.
            // For other errors (collision), let the user force-place if desired.
            if (forcePlaceOverrideRef.current && (result.stagnated || result.exhaustedBudget || result.error)) {
                commitTrunkBuild(result, placementSurface);
            }
            return;
        }

        // ANGLE_TOO_STEEP is a hard surface rejection (shallow angle / upward
        // face) that prevents ALL support types — trunk, branch, leaf, and
        // stick alike.  Reject immediately instead of deferring to grid
        // placement which would offer branches as a fallback.
        if (result.error === 'ANGLE_TOO_STEEP') {
            if (forcePlaceOverrideRef.current) {
                commitTrunkBuild(result, placementSurface);
            }
            return;
        }

        // In grid mode, decideGridPlacement may override a trunk error into a place_branch decision.
        // Only bail on trunk errors when grid is disabled (direct placement path).
        if (result.error && !settings.grid?.enabled) {
            if (forcePlaceOverrideRef.current) {
                commitTrunkBuild(result, placementSurface);
            }
            // Stick/twig is now strict last resort: do not fallback here unless
            // the solver reported true stagnation (handled above).
            return;
        }

        const decision = decideGridPlacement({
            settings,
            snapshot: getSnapshot(),
            candidate: result,
            tipPos,
            tipNormal,
            modelId,
            mesh,
        });

        if (decision.kind === 'place_anchor') {
            const anchor = markAnchorPlacementSurface(decision.anchor, placementSurface);
            addAnchor(anchor);
            pushHistory({
                type: SUPPORT_ADD_ANCHOR,
                payload: { anchor },
            });
            clearSupportSelection();
            return;
        }

        if (decision.kind === 'place_branch') {
            const branch = markBranchPlacementSurface(decision.branch, placementSurface);
            addKnot(decision.knot);
            addBranch(branch);

            const snapshotAfterAdd = getSnapshot();
            const hostTrunk = snapshotAfterAdd.trunks[decision.hostTrunkId];
            const trunkUpdate = hostTrunk
                ? (() => {
                    const applied = computeAndApplyTrunkDiameterProfile(snapshotAfterAdd, decision.hostTrunkId);
                    if (!applied) return null;

                    for (const u of applied.knotUpdates) {
                        updateKnot(u.after);
                    }

                    updateTrunk(applied.trunk);
                    return { before: hostTrunk, after: applied.trunk, knotUpdates: applied.knotUpdates };
                })()
                : null;

            pushHistory({
                type: SUPPORT_ADD_BRANCH,
                payload: {
                    branch,
                    knot: decision.knot,
                    trunkUpdate: trunkUpdate ? { before: trunkUpdate.before, after: trunkUpdate.after } : undefined,
                    knotUpdates: trunkUpdate?.knotUpdates ?? undefined,
                },
            });
            clearSupportSelection();
            return;
        }

        if (decision.kind === 'place_leaf') {
            const leaf = markLeafPlacementSurface(decision.leaf, placementSurface);
            addKnot(decision.knot);
            addLeaf(leaf);

            pushHistory({
                type: SUPPORT_ADD_LEAF,
                payload: {
                    leaf,
                    knot: decision.knot,
                },
            });
            clearSupportSelection();
            return;
        }

        if (decision.kind === 'replace_trunk') {
            const before = structuredClone(getSnapshot());
            const promoteBranch = markBranchPlacementSurface(decision.promoteBranch, placementSurface);
            const trunkBuild = markTrunkBuildPlacementSurface(decision.trunkBuild, placementSurface);

            // Materialize the promoted branch (and its knot) into state so the planner can reference it.
            addKnot(decision.promoteKnot);
            addBranch(promoteBranch);

            const planned = planTrunkReplacement({
                snapshot: getSnapshot(),
                trunkIdToRemove: decision.hostTrunkId,
                mode: 'grid_promote_candidate_to_trunk',
                nodeKey: decision.nodeKey,
                promoteBranchId: decision.promoteBranch.id,
            });

            const plan = planned?.plan;
            if (!plan) {
                setSnapshot(before);
                return;
            }

            const planWithBuild = {
                ...plan,
                trunkToAdd: trunkBuild.trunk,
                rootToAdd: trunkBuild.root,
            };

            const ok = applyTrunkReplacement(planWithBuild, before);
            if (!ok) {
                setSnapshot(before);
            } else {
                clearSupportSelection();
            }

            return;
        }

        if (decision.kind === 'reject') {
            if (decision.reason === 'COLLISION_WITH_MODEL' && mesh) {
                const cavityStick = buildCavityStick(tipPos, tipNormal, modelId, mesh);
                if (cavityStick) {
                    if (cavityStick.kind === 'twig') {
                        const twig = markTwigPlacementSurface(cavityStick.twig, placementSurface);
                        addTwig(twig);
                        pushHistory({
                            type: SUPPORT_ADD_TWIG,
                            payload: { twig },
                        });
                    } else {
                        const stick = markStickPlacementSurface(cavityStick.stick, placementSurface);
                        addStick(stick);
                        pushHistory({
                            type: SUPPORT_ADD_STICK,
                            payload: { stick },
                        });
                    }
                    clearSupportSelection();
                    return;
                }
            }
            if (forcePlaceOverrideRef.current && decision.trunkBuild) {
                commitTrunkBuild(decision.trunkBuild, placementSurface);
            }
            // Stick/twig is now strict last resort: keep reject behavior here.
            return;
        }

        // decision.kind === 'place_trunk'
        const trunkBuild = decision.trunkBuild;
        
        commitTrunkBuild(trunkBuild, placementSurface);
        console.log('[V2] Added trunk:', trunkBuild.trunk.id, 'to model:', modelId);
    }, [commitTrunkBuild, isPlacementHardDisabled]);

    return {
        onSupportHover,
        onSupportClick,
        previewData,
        previewError,
        previewWarning
    };
}
