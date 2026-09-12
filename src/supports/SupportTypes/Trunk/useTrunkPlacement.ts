import { useCallback, useState, useEffect, useRef } from 'react';
import * as THREE from 'three';
import { cloneSupportState, addAnchor, addBranch, addKnot, addLeaf, addRoot, addSupportEntityWithHistory, addTrunk, getSnapshot, setSnapshot, updateKnot } from '../../state';
import { pushSupportHistory } from '@/supports/history/supportHistory';
import { addAction } from '../../history/actionTypes';
import { useInteractionStatus } from '../../interaction/useInteractionStatus';
import { buildTrunkData } from './trunkBuilder';
import { applyTrunkReplacement, computeAndApplyTrunkDiameterProfile, planTrunkReplacement } from './TrunkReplacement';
import { supportDataForEntity, type SupportData } from '../../rendering/SupportBuilder';
import { markPlacementSurface, markSupportDataPlacementSurface, type PlacementSurface } from '../../PlacementLogic/placementSurface';
import type { Anchor, Branch, ContactDisk, Leaf, LimitationCode, Segment, Stick, Twig, WarningCode } from '../../types';
import type { ContactCone } from '../../SupportPrimitives/ContactCone/types';
import { calculateSmoothedNormal } from '../../PlacementLogic/PlacementUtils';
import { getSettings } from '../../Settings/state';
import { decideGridPlacement } from '../../PlacementLogic/Grid';
import { buildContactBridge, selectTypeForPlacement, type SupportTypeId, updateSupportEntity } from '../../supportTypeRegistry';
import { shaftVerticalCos } from '../Stick/stickVerticality';
import { clearSupportSelection } from '../../interaction/shared/selection/selectionController';
import { isContactDiskHudInteractionActive, shouldSuppressContactDiskHudPlacementCommit } from '../../SupportPrimitives/ContactDisk/contactDiskHudInteraction';
import { perfMark, perfMeasureWithSpike, perfEndFrame } from '../../PlacementLogic/Pathfinding/pathfindingPerf';

import { isShaftBlocked } from '../../PlacementLogic/CollisionAvoidance';
import { checkShortBridgeCollision } from '../../PlacementLogic/CollisionUtils';
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

function getPlacementSurfaceFromHit(hit: THREE.Intersection | null): PlacementSurface | undefined {
    return hit?.object?.userData?.supportPlacementSurface === 'interior' ? 'interior' : undefined;
}

function markTrunkBuildPlacementSurface<T extends ReturnType<typeof buildTrunkData>>(build: T, surface?: PlacementSurface): T {
    if (!surface) return build;
    return {
        ...build,
        trunk: markPlacementSurface('trunk', build.trunk, surface),
        supportData: markSupportDataPlacementSurface(build.supportData, surface),
    } as T;
}

/** A bridge always has a shaft; which contacts hang off it is declared. */
type BridgingEntity = { id: string; segments: Segment[] };

/**
 * When A* stagnates (tip is inside a closed cavity), attempt to find the
 * cavity floor by raycasting straight down and bridge the two contacts.
 *
 * Which type bridges them is the registry's call, by contact span -- the
 * result carries whichever it chose, plus a SupportData preview. Null when
 * no lower surface is found, or the bridge is not worth placing.
 */
export function buildCavityBridge(
    tipPos: { x: number; y: number; z: number },
    tipNormal: { x: number; y: number; z: number },
    modelId: string,
    mesh: THREE.Mesh,
    sizing?: { tipContactDiameterMm: number; shaftDiameterMm: number },
): { kind: SupportTypeId; supportData: SupportData; entity: BridgingEntity } | null {
    // Offset origin slightly inward along tip normal so we don't self-hit the
    // surface we just clicked.
    const OFFSET_MM = 0.5;
    const baseOrigin = new THREE.Vector3(tipPos.x, tipPos.y, tipPos.z)
        .addScaledVector(new THREE.Vector3(tipNormal.x, tipNormal.y, tipNormal.z), OFFSET_MM);
    baseOrigin.z -= OFFSET_MM * 0.1; // nudge down past origin surface

    // Prefer a true "floor" hit (normal has meaningful +Z) so the bottom
    // endpoint clings vertically down when possible. Only fall back to any
    // below-tip hit (e.g. sidewall) if no floor-like surface is found.
    const BELOW_EPS_MM = 0.1;
    const FLOOR_Z_MIN = 0.35;
    const normalMatrix = new THREE.Matrix3().getNormalMatrix(mesh.matrixWorld);

    type Candidate = { hit: THREE.Intersection; normal: THREE.Vector3 };
    const MAX_HIT_SCAN = 64;

    const scanDown = (ox: number, oy: number): { floor: Candidate | null; first: Candidate | null } => {
        _cavityRaycaster.set(new THREE.Vector3(ox, oy, baseOrigin.z), _downDir);
        const hits = _cavityRaycaster.intersectObject(mesh, false);

        let floor: Candidate | null = null;
        let first: Candidate | null = null;
        let scanned = 0;
        for (const h of hits) {
            scanned += 1;
            if (scanned > MAX_HIT_SCAN) break;
            if (h.point.z >= tipPos.z - BELOW_EPS_MM) continue;
            if (!h.face) continue;
            const n = h.face.normal.clone().applyNormalMatrix(normalMatrix).normalize();
            const candidate = { hit: h, normal: n };
            if (!first) first = candidate;
            if (n.z >= FLOOR_Z_MIN) {
                floor = candidate;
                break;
            }
        }
        return { floor, first };
    };

    // Straight down first, then a small disc around it: when the surface
    // directly below is missing — a punched drain hole, a gap between
    // features — the vertical ray escapes and the tip used to end up with no
    // support at all, even though the floor a couple of mm to the side is
    // right there. Nearest radius wins; the 20° verticality gate below (and
    // the shaft-blocked check after the build) bound how far the cant may go.
    const settings = getSettings();
    const cutoff = settings.meshToMesh?.stickVsTwigCutoffMm ?? 5;
    const NEAR_RADII_MM = [0, 0.75, 1.5, 2.25] as const;
    // A twig's own reach: it is a short bridge, so a lateral offset up to its
    // maximum length is still a twig.
    const twigReachRadii = Array.from(
        { length: Math.max(0, Math.floor(cutoff / 0.75)) },
        (_, i) => 0.75 * (i + 1),
    ).filter((r) => r > NEAR_RADII_MM[NEAR_RADII_MM.length - 1]);
    const runSearch = (radii: readonly number[]): { hit: Candidate | null; usedExtendedReach: boolean } => {
        let firstBelow: Candidate | null = null;
        for (const radiusMm of radii) {
            const steps = radiusMm === 0 ? 1 : 8;
            for (let i = 0; i < steps; i++) {
                const angle = (i / steps) * Math.PI * 2;
                const { floor, first } = scanDown(
                    baseOrigin.x + Math.cos(angle) * radiusMm,
                    baseOrigin.y + Math.sin(angle) * radiusMm,
                );
                if (floor) return { hit: floor, usedExtendedReach: radiusMm > NEAR_RADII_MM[NEAR_RADII_MM.length - 1] };
                if (first && !firstBelow) firstBelow = first;
            }
        }
        return { hit: firstBelow, usedExtendedReach: false };
    };

    const near = runSearch(NEAR_RADII_MM);
    let chosen = near.hit;
    let reachedSideways = near.usedExtendedReach;
    if (!chosen) {
        // Nothing straight down: a TWIG may still prop the contact off a
        // neighbouring surface (the underside of a pointed tip, a ledge beside
        // it). Twigs are short (<= stickVsTwigCutoffMm), so the search may
        // reach that far sideways; a stick still may not — it has to stay near
        // vertical, so it keeps the near search it always had.
        const wide = runSearch(twigReachRadii);
        chosen = wide.hit;
        reachedSideways = wide.usedExtendedReach;
    }
    if (!chosen) return null;

    const bPos = { x: chosen.hit.point.x, y: chosen.hit.point.y, z: chosen.hit.point.z };
    const bNormal = { x: chosen.normal.x, y: chosen.normal.y, z: chosen.normal.z };

    const dx = tipPos.x - bPos.x;
    const dy = tipPos.y - bPos.y;
    const dz = tipPos.z - bPos.z;
    const dist = Math.sqrt(dx * dx + dy * dy + dz * dz);
    const kind = selectTypeForPlacement('contactSpan', dist);
    if (kind === null) return null;

    if (kind === 'stick' && reachedSideways && dist > cutoff) return null;

    const built = buildContactBridge(kind, {
        modelId,
        aPos: tipPos,
        aNormal: tipNormal,
        bPos,
        bNormal,
        shaftDiameterMm: sizing?.shaftDiameterMm,
        tipContactDiameterMm: sizing?.tipContactDiameterMm,
    });
    if (!built) return null;
    const entity = built.entity as BridgingEntity;

    // Twigs are short bridges, not lateral props: the visible shaft
    // (socket to socket — a sidewall landing's standoff is what shoves a
    // grazing twig sideways) must stay somewhat vertical, like sticks. A
    // twig much past 45° hangs its island off a whisker that cannot carry
    // peel, and it renders as the near-horizontal struts in the preview.
    // Looser than the 20° stick gate — which the stick's registered builder
    // enforces — because a 1–2 mm strut tolerates cant a 12 mm column cannot;
    // pointed tips propped off a nearby wall with a real drop underneath
    // still pass.
    if (kind === 'twig' && shaftVerticalCos(entity) < Math.cos((CAVITY_TWIG_MAX_SHAFT_ANGLE_DEG * Math.PI) / 180)) {
        return null;
    }

    // The shaft must not pierce the model. Matches the trunk post-cull
    // clearance (radius + 0.15mm) and catches the bridges that shot straight
    // through geometry in auto supports.
    const seg = entity.segments[0];
    const start = seg?.bottomJoint?.pos ?? bPos;
    const end = seg?.topJoint?.pos ?? tipPos;
    const radius = (seg?.diameter ?? sizing?.shaftDiameterMm ?? 1) / 2 + 0.15;
    // Ray-based for a twig, like buildTwig: the SDF reads the thin gap a twig
    // spans as material, so a signed-distance gate would refuse it.
    const blocked = kind === 'twig'
        ? checkShortBridgeCollision(start, end, radius, mesh).hit
        : isShaftBlocked(start, end, radius, mesh);
    if (blocked) return null;

    return { kind, entity, supportData: supportDataForEntity(kind, entity) };
}

type CavityBridgeBuildResult = NonNullable<ReturnType<typeof buildCavityBridge>>;

// A cavity twig bridges down, not sideways: a shaft canted much past this
// from vertical is a lateral whisker to a sidewall, not a bridge. Looser than
// the 20° stick gate — measured thin-gap and floor twigs build at ≤17°,
// pointed-tip props off a nearby wall with a real drop land 23–43°, the
// grazers at 48° and up (calibration knob).
export const CAVITY_TWIG_MAX_SHAFT_ANGLE_DEG = 45;

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
        result: CavityBridgeBuildResult | null;
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
        pushSupportHistory({
            type: addAction('trunk'),
            payload: {
                trunk: markedBuild.trunk,
                roots: [markedBuild.root],
            },
        });
        clearSupportSelection();
    }, []);

    const resolveCavityBridgePreview = useCallback((
        hit: THREE.Intersection,
        tipPos: { x: number; y: number; z: number },
        tipNormal: { x: number; y: number; z: number },
        modelId: string,
        mesh: THREE.Mesh,
    ): CavityBridgeBuildResult | null => {
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

        const computed = buildCavityBridge(tipPos, tipNormal, modelId, mesh);

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
        const cavityBridgeEligible = result.stagnated || result.exhaustedBudget
            || (result.error && result.error !== 'ANGLE_TOO_STEEP');
        if (cavityBridgeEligible) {
            if (mesh) {
                perfMark('hover:cavity-stick');
                const cavityBridge = resolveCavityBridgePreview(hit, tipPos, tipNormal, modelId, mesh);
                perfMeasureWithSpike('hover:cavity-stick', 'branch:cavity-stick');
                if (cavityBridge) {
                    setPreviewData(cavityBridge.supportData);
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
        // the grid snapping/branch logic entirely. Near-plate tips are the
        // exception: decideGridPlacement owns the anchor decision in BOTH
        // modes (its validation also previews the rejection ghost), so they
        // must not take this early out.
        // Only a tip the anchor rule claims takes the grid path.
        const isNearPlateTip = selectTypeForPlacement('tipHeight', tipPos.z) === 'anchor';
        if (!isGridMode && !isNearPlateTip) {
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
            const cavityBridge = resolveCavityBridgePreview(hit, tipPos, tipNormal, modelId, mesh);
            perfMeasureWithSpike('hover:cavity-stick', 'branch:cavity-stick');
            if (cavityBridge) {
                setPreviewData(cavityBridge.supportData);
                setPreviewError(null);
                setPreviewWarning(null);
                perfEndFrame();
                return;
            }
        }

        // Rejections that already built geometry (anchor validation) preview
        // the invalid support as a red ghost; the `error` on the SupportData
        // drives the "Cannot Place Support" tooltip.
        if (decision.kind === 'reject' && decision.supportData) {
            setPreviewData(decision.supportData);
            setPreviewError(forcePlaceOverrideRef.current ? null : (decision.supportData.error ?? null));
            setPreviewWarning(null);
            perfEndFrame();
            return;
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
                : decision.reason === 'ANCHOR_BELOW_ROOT'
                    ? 'ANCHOR_BELOW_ROOT'
                    : decision.reason === 'COLLISION_WITH_MODEL'
                        ? 'COLLISION_WITH_MODEL'
                        : null
        );
        setPreviewWarning((prev) => (prev === null ? prev : null));
        perfEndFrame();
    }, [HOVER_MIN_INTERVAL_MS, HOVER_NORMAL_DOT_MIN, HOVER_POS_EPSILON_MM, clearPreview, isPlacementHardDisabled, resolveCavityBridgePreview]);

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
        const cavityBridgeEligible = result.stagnated || result.exhaustedBudget
            || (result.error && result.error !== 'ANGLE_TOO_STEEP');
        if (cavityBridgeEligible) {
            if (mesh) {
                const cavityBridge = buildCavityBridge(tipPos, tipNormal, modelId, mesh);
                if (cavityBridge) {
                    // The registry chose the type; committing it needs no
                    // second choice here.
                    addSupportEntityWithHistory(
                        cavityBridge.kind,
                        markPlacementSurface(cavityBridge.kind, cavityBridge.entity, placementSurface),
                    );
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
            const anchor = markPlacementSurface('anchor', decision.anchor, placementSurface);
            addAnchor(anchor);
            pushSupportHistory({
                type: addAction('anchor'),
                payload: { anchor },
            });
            clearSupportSelection();
            return;
        }

        if (decision.kind === 'place_branch') {
            const branch = markPlacementSurface('branch', decision.branch, placementSurface);
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

                    updateSupportEntity('trunk', applied.trunk);
                    return { before: hostTrunk, after: applied.trunk, knotUpdates: applied.knotUpdates };
                })()
                : null;

            pushSupportHistory({
                type: addAction('branch'),
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
            const leaf = markPlacementSurface('leaf', decision.leaf, placementSurface);
            addKnot(decision.knot);
            addLeaf(leaf);

            pushSupportHistory({
                type: addAction('leaf'),
                payload: {
                    leaf,
                    knot: decision.knot,
                },
            });
            clearSupportSelection();
            return;
        }

        if (decision.kind === 'replace_trunk') {
            const before = cloneSupportState(getSnapshot());
            const promoteBranch = markPlacementSurface('branch', decision.promoteBranch, placementSurface);
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
                const cavityBridge = buildCavityBridge(tipPos, tipNormal, modelId, mesh);
                if (cavityBridge) {
                    // The registry chose the type; committing it needs no
                    // second choice here.
                    addSupportEntityWithHistory(
                        cavityBridge.kind,
                        markPlacementSurface(cavityBridge.kind, cavityBridge.entity, placementSurface),
                    );
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
