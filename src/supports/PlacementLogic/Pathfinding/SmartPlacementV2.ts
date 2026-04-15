/**
 * SmartPlacement V2 — Grid A* pathfinding with lazy SDF
 *
 * Drop-in replacement for calculateSmartPlacement that uses:
 * - SDFCache for O(1) collision queries (vs 9-ray bundles)
 * - Grid A* for route search (vs angular/radial candidate expansion)
 * - SupportOccupancy for support-to-support avoidance
 * - Frame-coherent warm-start for preview continuity
 *
 * Same input/output interface as SmartPlacement so trunkBuilder
 * doesn't need changes.
 */

import * as THREE from 'three';
import { Vec3 } from '../../types';
import {
    calculateStandardPlacement,
    type TrunkPlacementInput,
    type TrunkPlacementResult,
} from '../StandardPlacement';
import { getSettings } from '../../Settings';
import { gridNodeKeyFromXY, gridSnappedXYFromKey } from '../Grid/gridMath';
import { buildNearestCandidateNodeKeys } from '../Grid/nearestCandidateNodeKeys';
import { SDFCache } from './SDFCache';
import { gridAStar, type WarmStartState } from './GridAStar';
import type { SupportOccupancy } from './SupportOccupancy';
import {
    distanceXY,
    segmentSatisfiesLengthAwareMaxAngleFromVertical,
} from '../smartPlacementSearchUtils';

// ---------- Types ----------

export interface SmartPlacementV2Input extends TrunkPlacementInput {
    mesh: THREE.Mesh;
    modelId: string;
}

export interface SmartPlacementV2Context {
    /** Cached SDF for the model mesh. Reuse across placements for same model. */
    sdfCache?: SDFCache;
    /** Tracks placed support geometry. Optional — omit to skip support-to-support avoidance. */
    occupancy?: SupportOccupancy;
    /** Warm-start state from previous frame's search. Pass null for first frame. */
    warmStart?: WarmStartState | null;
    /** Support ID being placed (to ignore self in occupancy). */
    placingSupportId?: string;
    /** Override the A* expansion budget (default 2000). Pass a lower value for
     *  hover preview to reduce first-frame cost at transition-zone positions. */
    maxExpansions?: number;
    /** When true, enables the preview-exhausted spatial cache so positions where A*
     *  exhausts its reduced preview budget are fast-failed on subsequent hover frames.
     *  Must NOT be set for click-time placement — only for hover preview. */
    isPreview?: boolean;
}

// ---------- Constants ----------

const MAX_NEAREST_NODE_SEARCH_RINGS = 4;

/** Number of XY perimeter samples around the roots cone at each height slice. */
const ROOTS_DISK_PERIMETER_SAMPLES = 16;
/** Safety margin in mm added to all roots volume checks. */
const ROOTS_DISK_SAFETY_MM = 0.5;

/**
 * Preview-mode coarse sampling constants.
 *
 * The SDF cache cell size is 0.5mm; segmentBlocked samples at that interval,
 * so a 50mm straight-down shaft triggers ~100 BVH closestPointToPoint calls
 * on first hover (cold cache). rootsDiskBlocked compounds it with up to 170
 * more per check. On cold cache every call is a full BVH traversal (~0.1ms
 * on complex meshes), causing a visible hitch on the very first hover over
 * any new area of the model.
 *
 * For hover preview we use 2mm steps (matching A* step size) for segment
 * checks and a 3-slice/6-point roots sweep. This reduces first-hover BVH
 * queries from ~270 to ~50 — a 5× reduction — while keeping accuracy
 * sufficient for preview (click-time always uses full resolution).
 */
const PREVIEW_SEGMENT_STEP_MM = 2.0;   // matches A* step size
const ROOTS_DISK_QUICK_Z_SLICES = 3;   // vs max(4, ceil(rootTopZ/0.5)) ≈ 10
const ROOTS_DISK_QUICK_PERIMETER_SAMPLES = 6;  // vs 16

/**
 * Coarse segment-blocked check for hover preview.
 * Samples at `stepMm` intervals instead of the SDF cell size (0.5mm),
 * trading the ability to detect very thin (< 2mm) geometry for ~4× fewer
 * BVH queries. Acceptable for preview; click-time uses the full sdf method.
 */
function segmentBlockedCoarse(
    sdf: SDFCache,
    ax: number, ay: number, az: number,
    bx: number, by: number, bz: number,
    clearance: number,
    stepMm: number,
): boolean {
    const dx = bx - ax, dy = by - ay, dz = bz - az;
    const len = Math.sqrt(dx * dx + dy * dy + dz * dz);
    if (len < 0.01) return sdf.isBlocked(ax, ay, az, clearance);
    const steps = Math.max(1, Math.ceil(len / stepMm));
    const inv = 1 / steps;
    for (let i = 0; i <= steps; i++) {
        const t = i * inv;
        if (sdf.isBlocked(ax + dx * t, ay + dy * t, az + dz * t, clearance)) return true;
    }
    return false;
}

/**
 * Quick (reduced-sample) roots-disk blocked check for hover preview.
 * Uses 3 Z slices and 6 perimeter points vs the full sweep (~10 slices × 17
 * points). Reduces first-hover BVH calls from ~170 to ~28 for this check.
 */
function quickRootsDiskBlocked(
    sdf: SDFCache,
    centerX: number,
    centerY: number,
    diskHeight: number,
    coneHeight: number,
    rootsRadius: number,
    shaftRadius: number,
): boolean {
    const safety = ROOTS_DISK_SAFETY_MM;
    const rootTopZ = diskHeight + coneHeight;
    for (let zi = 0; zi <= ROOTS_DISK_QUICK_Z_SLICES; zi++) {
        const z = (zi / ROOTS_DISK_QUICK_Z_SLICES) * rootTopZ;
        let radiusAtZ: number;
        if (z <= diskHeight) {
            radiusAtZ = rootsRadius;
        } else {
            const t = coneHeight > 0 ? (z - diskHeight) / coneHeight : 1;
            radiusAtZ = rootsRadius + t * (shaftRadius - rootsRadius);
        }
        if (sdf.isBlocked(centerX, centerY, z, safety)) return true;
        for (let i = 0; i < ROOTS_DISK_QUICK_PERIMETER_SAMPLES; i++) {
            const angle = (i / ROOTS_DISK_QUICK_PERIMETER_SAMPLES) * Math.PI * 2;
            if (sdf.isBlocked(centerX + Math.cos(angle) * radiusAtZ, centerY + Math.sin(angle) * radiusAtZ, z, safety)) return true;
        }
    }
    return false;
}

// ---------- Roots cone volume check ----------

/**
 * Returns true if the roots structure at (centerX, centerY) would physically
 * intersect the mesh geometry.
 *
 * Sweeps the full roots volume — disk (Z=0 to diskHeight, full rootsRadius)
 * and cone (diskHeight to rootTopZ, tapering from rootsRadius to shaftRadius)
 * — sampling center + 16 perimeter points at each Z slice using the actual
 * cross-section radius at that height. This correctly catches protrusions at
 * any Z level and any angle, unlike the previous Z=0-only perimeter check.
 */
function rootsDiskBlocked(
    sdf: SDFCache,
    centerX: number,
    centerY: number,
    diskHeight: number,
    coneHeight: number,
    rootsRadius: number,
    shaftRadius: number,
): boolean {
    const safety = ROOTS_DISK_SAFETY_MM;
    const rootTopZ = diskHeight + coneHeight;
    const zSlices = Math.max(4, Math.ceil(rootTopZ / sdf.cellSize));

    for (let zi = 0; zi <= zSlices; zi++) {
        const z = (zi / zSlices) * rootTopZ;

        // Compute the actual cross-section radius at this Z height.
        // Disk section (Z <= diskHeight): full rootsRadius.
        // Cone section (diskHeight < Z <= rootTopZ): linearly tapers.
        let radiusAtZ: number;
        if (z <= diskHeight) {
            radiusAtZ = rootsRadius;
        } else {
            const t = coneHeight > 0 ? (z - diskHeight) / coneHeight : 1;
            radiusAtZ = rootsRadius + t * (shaftRadius - rootsRadius);
        }

        // Center at this height — catches surfaces near the axis
        if (sdf.isBlocked(centerX, centerY, z, safety)) return true;

        // Perimeter at actual cone radius at this height
        for (let i = 0; i < ROOTS_DISK_PERIMETER_SAMPLES; i++) {
            const angle = (i / ROOTS_DISK_PERIMETER_SAMPLES) * Math.PI * 2;
            const px = centerX + Math.cos(angle) * radiusAtZ;
            const py = centerY + Math.sin(angle) * radiusAtZ;
            if (sdf.isBlocked(px, py, z, safety)) return true;
        }
    }

    return false;
}

// ---------- SDF Cache Pool ----------

/**
 * Per-mesh SDF cache pool. Keyed by mesh uuid so we build at most one
 * SDFCache per model geometry. The BVH is already present; this just
 * gives us the caching wrapper.
 */
const sdfCachePool = new Map<string, SDFCache>();

export function getOrCreateSDFCache(mesh: THREE.Mesh, cellSize?: number): SDFCache {
    const key = mesh.uuid;
    const existing = sdfCachePool.get(key);
    if (existing) return existing;

    const cache = new SDFCache(mesh, { cellSize: cellSize ?? 0.5 });
    sdfCachePool.set(key, cache);
    return cache;
}

export function clearSDFCacheForMesh(meshUuid: string): void {
    const cache = sdfCachePool.get(meshUuid);
    if (cache) {
        cache.clear();
        sdfCachePool.delete(meshUuid);
    }
    stagnationCache.delete(meshUuid);
    previewExhaustedCache.delete(meshUuid);
}

export function clearAllSDFCaches(): void {
    for (const cache of sdfCachePool.values()) cache.clear();
    sdfCachePool.clear();
    stagnationCache.clear();
    previewExhaustedCache.clear();
}

// ---------- Main API ----------

/** Warm-start storage keyed by modelId for frame-coherent preview. */
const warmStartByModel = new Map<string, WarmStartState>();

/**
 * Spatial stagnation cache — records socketPos positions where the A*
 * search stagnated (trapped in a cavity). On subsequent hover frames,
 * if the socketPos is within STAGNATION_RADIUS_MM of a cached point,
 * the search is skipped entirely, turning cavity hover from ~150
 * A* expansions to a single distance check.
 *
 * Keyed by mesh uuid so it auto-invalidates when the model changes.
 * Entries are cleared when the model matrix changes (SDF refresh),
 * when SDF caches are cleared, or when warm-starts are cleared.
 */
const STAGNATION_RADIUS_MM = 3;
const STAGNATION_RADIUS_SQ = STAGNATION_RADIUS_MM * STAGNATION_RADIUS_MM;
const MAX_STAGNATION_ENTRIES = 512;
const stagnationCache = new Map<string, Vec3[]>();

/**
 * Preview-exhausted cache — records socketPos positions where the A* exhausted
 * its REDUCED preview budget (≠ true stagnation) so that subsequent hover frames
 * at similar positions skip the 600-expansion A* run entirely.
 *
 * Separate from stagnationCache so click-time placement (full 2000-expansion
 * budget) is never affected — only hover preview fast-paths through this cache.
 * Keyed by mesh uuid; cleared alongside stagnationCache.
 */
const previewExhaustedCache = new Map<string, Vec3[]>();

function isNearSpatialPoint(cache: Map<string, Vec3[]>, meshUuid: string, pos: Vec3): boolean {
    const points = cache.get(meshUuid);
    if (!points || points.length === 0) return false;
    for (let i = 0; i < points.length; i++) {
        const p = points[i];
        const dx = pos.x - p.x;
        const dy = pos.y - p.y;
        const dz = pos.z - p.z;
        if (dx * dx + dy * dy + dz * dz < STAGNATION_RADIUS_SQ) return true;
    }
    return false;
}

function recordSpatialPoint(cache: Map<string, Vec3[]>, meshUuid: string, pos: Vec3): void {
    let points = cache.get(meshUuid);
    if (!points) {
        points = [];
        cache.set(meshUuid, points);
    }
    if (isNearSpatialPoint(cache, meshUuid, pos)) return;
    if (points.length >= MAX_STAGNATION_ENTRIES) {
        points.splice(0, points.length - MAX_STAGNATION_ENTRIES + 1);
    }
    points.push({ x: pos.x, y: pos.y, z: pos.z });
}

function isNearStagnationPoint(meshUuid: string, pos: Vec3): boolean {
    return isNearSpatialPoint(stagnationCache, meshUuid, pos);
}

function recordStagnation(meshUuid: string, pos: Vec3): void {
    recordSpatialPoint(stagnationCache, meshUuid, pos);
}

/**
 * Calculates smart placement using grid A* pathfinding.
 *
 * Signature matches calculateSmartPlacement for drop-in replacement.
 * Optionally accepts a context object for SDF/occupancy reuse.
 */
export function calculateSmartPlacementV2(
    input: SmartPlacementV2Input,
    context?: SmartPlacementV2Context,
): TrunkPlacementResult {
    const { mesh, modelId } = input;
    const settings = getSettings();
    const shaftRadius = settings.shaft.diameterMm / 2;
    const clearance = shaftRadius + 0.25;
    const rootsRadius = settings.roots.diameterMm / 2;
    const diskHeight = settings.roots.diskHeightMm;
    const coneHeight = settings.roots.coneHeightMm;
    const minRoutedTrunkAngleDeg = settings.grid.minRoutedTrunkAngleDeg;
    const maxTotalLateralMm = Math.max(30, settings.grid.spacingMm * 8);

    // 1. Standard placement (baseline — no collision check)
    const standard = calculateStandardPlacement(input);
    if (standard.error === 'ANGLE_TOO_STEEP') {
        return standard;
    }

    // 2. Get or create SDF cache; refresh matrix so stale cache from a previous
    //    model position does not produce wrong distances.
    const sdf = context?.sdfCache ?? getOrCreateSDFCache(mesh);
    sdf.refreshMatrix();

    // 3. Quick check: is the straight-down path clear AND do the roots fit at the base?
    const rootTopZ = input.rootsTopZ;
    const socketPos = standard.socketPos;
    const isPreview = context?.isPreview ?? false;

    // For hover preview, use coarse sampling (2mm steps) to cut first-hover
    // BVH cache-miss queries from ~100 to ~25 for the shaft check, and from
    // ~170 to ~28 for the roots check.  Click-time always uses full resolution.
    const straightClear = isPreview
        ? !segmentBlockedCoarse(sdf, socketPos.x, socketPos.y, socketPos.z, socketPos.x, socketPos.y, rootTopZ, clearance, PREVIEW_SEGMENT_STEP_MM)
        : !sdf.segmentBlocked(socketPos.x, socketPos.y, socketPos.z, socketPos.x, socketPos.y, rootTopZ, clearance);

    // Volumetric roots check at the standard base position.
    const baseXY = standard.basePos;
    const rootsFitStandard = isPreview
        ? !quickRootsDiskBlocked(sdf, baseXY.x, baseXY.y, diskHeight, coneHeight, rootsRadius, shaftRadius)
        : !rootsDiskBlocked(sdf, baseXY.x, baseXY.y, diskHeight, coneHeight, rootsRadius, shaftRadius);

    if (straightClear && rootsFitStandard) {
        return standard; // Shaft is clear and roots fit — no routing needed
    }

    // 3b. Spatial caches: skip A* if a previous search from a nearby socketPos
    //     already stagnated (cavity) or exhausted the preview budget.
    //     This turns repeated probes at similar positions from ~600 A* expansions
    //     to a single distance check — the primary performance win for interior hovers.
    if (isNearStagnationPoint(mesh.uuid, socketPos)) {
        return { ...standard, error: 'COLLISION_WITH_MODEL', stagnated: true };
    }
    // Preview-exhausted fast-fail: if this is a preview call and a nearby position
    // already exhausted the reduced budget, skip A* for this frame too.
    if (context?.isPreview && isNearSpatialPoint(previewExhaustedCache, mesh.uuid, socketPos)) {
        return { ...standard, error: 'COLLISION_WITH_MODEL', exhaustedBudget: true };
    }

    // 3c. Quick vertical solvability check: sample points along the
    //     straight-down axis AND at lateral offsets.  Only bail if the
    //     obstruction is thick AND there's no lateral escape route.
    const vertSpan = socketPos.z - rootTopZ;
    if (vertSpan > 1) {
        const VERT_SAMPLES = 7;
        const deepThreshold = -clearance * 3;
        let deeplyBlockedCount = 0;
        for (let i = 1; i <= VERT_SAMPLES; i++) {
            const t = i / (VERT_SAMPLES + 1);
            const sz = socketPos.z - t * vertSpan;
            if (sdf.distanceAt(socketPos.x, socketPos.y, sz) < deepThreshold) {
                deeplyBlockedCount++;
            }
        }
        // Only bail if almost ALL samples are deeply blocked — meaning true
        // cavity with no thin-wall escape.  Also probe a few lateral offsets
        // to confirm there's no nearby gap the A* could exploit.
        if (deeplyBlockedCount >= 6) {
            const PROBE_OFFSETS = [clearance * 4, -clearance * 4];
            let anyLateralClear = false;
            const probeZ = socketPos.z - vertSpan * 0.5;
            for (const off of PROBE_OFFSETS) {
                if (sdf.distanceAt(socketPos.x + off, socketPos.y, probeZ) > clearance ||
                    sdf.distanceAt(socketPos.x, socketPos.y + off, probeZ) > clearance) {
                    anyLateralClear = true;
                    break;
                }
            }
            if (!anyLateralClear) {
                recordStagnation(mesh.uuid, socketPos);
                return { ...standard, error: 'COLLISION_WITH_MODEL', stagnated: true };
            }
        }
    }

    // 4. Run grid A* from socket down to rootTopZ.
    //    The goalValidator integrates roots collision into the search:
    //    when A* reaches a cell at rootTopZ, it checks that the full roots
    //    volume below that XY is clear. If not, the search continues laterally
    //    to find a valid position — proper 3D pathfinding for the whole support.
    const warmStart = context?.warmStart ?? warmStartByModel.get(modelId) ?? null;

    // For preview: use the quick (reduced-sample) roots check in the goal validator.
    // The full-resolution check is reserved for click-time placement.
    const goalValidator = (wx: number, wy: number, _wz: number) => {
        return isPreview
            ? !quickRootsDiskBlocked(sdf, wx, wy, diskHeight, coneHeight, rootsRadius, shaftRadius)
            : !rootsDiskBlocked(sdf, wx, wy, diskHeight, coneHeight, rootsRadius, shaftRadius);
    };

    const result = gridAStar(sdf, socketPos, rootTopZ, {
        clearanceMm: clearance,
        maxLateralMm: maxTotalLateralMm,
        minAngleFromVerticalDeg: 90 - minRoutedTrunkAngleDeg,
        occupancy: context?.occupancy,
        ignoreSupportId: context?.placingSupportId,
        maxExpansions: context?.maxExpansions ?? 2000,
        stepMm: 2.0, // Coarse grid for pathfinding; fine SDF checking at cellSize
        goalValidator,
        // For hover preview, use endpoint-only SDF checks in the A* neighbor loop.
        // The default segmentBlocked samples at 0.5mm intervals on a 2mm grid — all
        // intermediate sub-grid points are permanent cold BVH cache misses, causing
        // ~30k–60k uncacheable BVH queries per hover frame on interior surfaces.
        // Endpoint-only checks hit grid-aligned cells that ARE cached after first
        // visit, dropping first-frame cold cost from ~30k to ~600 BVH calls.
        endpointOnlyCollisionCheck: isPreview,
    }, warmStart);

    // Store warm-start for next frame (don't save stagnated searches)
    if (result.warmState) {
        warmStartByModel.set(modelId, result.warmState);
    }
    if (result.stagnated) {
        // Clear warm-start so the next nearby search starts fresh
        warmStartByModel.delete(modelId);
        // Record this position so future hovers skip the A* entirely
        recordStagnation(mesh.uuid, socketPos);
    }
    // Preview-exhausted: record budget-exhausted positions so subsequent preview
    // hover frames at similar positions skip the A* instead of re-running it.
    // Only recorded for isPreview calls — doesn't affect click-time placement.
    if (result.hitExpansionLimit && context?.isPreview) {
        recordSpatialPoint(previewExhaustedCache, mesh.uuid, socketPos);
    }

    if (!result.reached || result.path.length < 2) {
        return {
            ...standard,
            error: 'COLLISION_WITH_MODEL',
            stagnated: result.stagnated,
            exhaustedBudget: result.hitExpansionLimit,
        };
    }

    // 5. Convert A* path to joints + resolve grid snapping
    //    Path goes [socketPos, joint1, joint2, ..., baseRegion]
    //    We need to extract joints and find the best grid-snapped base.
    const pathJoints = result.path.slice(1, -1); // Exclude start (socket) and end (base region)
    const pathEnd = result.path[result.path.length - 1];

    // 6. Grid snap the base position
    const nearestCandidateNodeKeysCache = new Map<string, string[]>();
    const buildNearestCandidateNodeKeysCached = (preferredKey: string, maxRings: number) => {
        const key = `${preferredKey}|${maxRings}`;
        const cached = nearestCandidateNodeKeysCache.get(key);
        if (cached) return cached;
        const computed = buildNearestCandidateNodeKeys(preferredKey, maxRings);
        nearestCandidateNodeKeysCache.set(key, computed);
        return computed;
    };

    const gridEnabled = settings.grid.enabled;
    const spacingMm = settings.grid.spacingMm;
    const unsnappedBottomPos: Vec3 = {
        x: pathEnd.x,
        y: pathEnd.y,
        z: 0,
    };

    // Find best grid node for the base
    let bestBase: {
        basePos: Vec3;
        rootTopTarget: Vec3;
        snapDistance: number;
        nodeKey: string | null;
    } | null = null;

    const candidateNodeKeys = gridEnabled
        ? buildNearestCandidateNodeKeysCached(
            gridNodeKeyFromXY(unsnappedBottomPos.x, unsnappedBottomPos.y, spacingMm),
            MAX_NEAREST_NODE_SEARCH_RINGS,
        )
        : ['disabled'];

    for (const nodeKey of candidateNodeKeys) {
        const snappedXY = gridEnabled
            ? gridSnappedXYFromKey(nodeKey, spacingMm)
            : { x: unsnappedBottomPos.x, y: unsnappedBottomPos.y };

        const basePos: Vec3 = { x: snappedXY.x, y: snappedXY.y, z: 0 };
        const rootTopTarget: Vec3 = { x: snappedXY.x, y: snappedXY.y, z: rootTopZ };
        const snapDistance = distanceXY(basePos, unsnappedBottomPos);

        // Volumetric roots check at this grid-snapped base position.
        // Grid snapping shifts XY, so a position the A* validated may not
        // hold after snapping — recheck the full cone/disk volume.
        if (rootsDiskBlocked(sdf, basePos.x, basePos.y, diskHeight, coneHeight, rootsRadius, shaftRadius)) continue;

        // Check that the last shaft segment (lowest joint → rootTopTarget) is also clear
        const lastJoint = pathJoints.length > 0 ? pathJoints[pathJoints.length - 1] : pathEnd;
        const lastSegClear = !sdf.segmentBlocked(
            lastJoint.x, lastJoint.y, lastJoint.z,
            rootTopTarget.x, rootTopTarget.y, rootTopTarget.z,
            clearance,
        );
        if (!lastSegClear) continue;

        if (!bestBase || snapDistance < bestBase.snapDistance) {
            bestBase = { basePos, rootTopTarget, snapDistance, nodeKey: gridEnabled ? nodeKey : null };
        }
    }

    if (!bestBase) {
        // No valid grid-snapped base found
        return {
            ...standard,
            error: 'COLLISION_WITH_MODEL',
        };
    }

    // 7. Simplify joints using SDF-based collision checks (NOT raycasting).
    //    Raycaster-based simplification (simplifyRouteJoints) has blind spots
    //    between its 9-ray bundle, allowing joints to be removed even when
    //    the direct segment clips geometry. SDF checks at 0.5mm intervals
    //    along every candidate segment, catching all collisions.
    const simplifiedJoints = simplifyJointsSDF(
        pathJoints,
        socketPos,
        bestBase.rootTopTarget,
        sdf,
        clearance,
        90 - minRoutedTrunkAngleDeg,
    );

    // 8. Final SDF validation of the complete chain.
    //    Even after simplification, verify every segment is clear.
    //    This is the last line of defense against any clipping.
    const finalChainPoints: Vec3[] = [
        bestBase.rootTopTarget,
        ...simplifiedJoints,
        socketPos,
    ];

    for (let i = 0; i < finalChainPoints.length - 1; i++) {
        const a = finalChainPoints[i];
        const b = finalChainPoints[i + 1];

        if (sdf.segmentBlocked(a.x, a.y, a.z, b.x, b.y, b.z, clearance)) {
            return {
                ...standard,
                error: 'COLLISION_WITH_MODEL',
            };
        }

        if (!segmentSatisfiesLengthAwareMaxAngleFromVertical(a, b, 90 - minRoutedTrunkAngleDeg)) {
            return {
                ...standard,
                error: 'COLLISION_WITH_MODEL',
            };
        }
    }

    // 9. Build the result
    const finalResult: TrunkPlacementResult = {
        socketPos,
        joints: simplifiedJoints,
        constructionJoints: [],
        basePos: bestBase.basePos,
        unsnappedBottomPos,
        snappedNodeKey: bestBase.nodeKey,
        warning: standard.warning,
        angle: standard.angle,
        coneAxis: standard.coneAxis,
    };

    return finalResult;
}

// ---------- SDF-based joint simplification ----------

/**
 * Removes unnecessary joints from the route using SDF collision checks.
 *
 * Unlike `simplifyRouteJoints` (which uses 9-ray bundles), this validates
 * each candidate removal by checking the direct segment with
 * `sdf.segmentBlocked` at cellSize intervals — no gaps possible.
 *
 * Iteratively removes joints whose removal still produces a collision-free
 * and angle-valid chain.
 */
function simplifyJointsSDF(
    routeJoints: Vec3[],
    socketPos: Vec3,
    rootTopTarget: Vec3,
    sdf: SDFCache,
    clearance: number,
    maxAngleFromVerticalDeg: number,
): Vec3[] {
    if (routeJoints.length < 2) return routeJoints;

    let simplified = [...routeJoints];
    let changed = true;

    while (changed) {
        changed = false;

        for (let i = 0; i < simplified.length; i++) {
            const prev = i === 0 ? rootTopTarget : simplified[i - 1];
            const next = i === simplified.length - 1 ? socketPos : simplified[i + 1];

            // Check if the direct segment (skipping this joint) is clear
            if (sdf.segmentBlocked(prev.x, prev.y, prev.z, next.x, next.y, next.z, clearance)) {
                continue; // Can't remove — direct path clips geometry
            }

            // Check angle constraint on the direct segment
            if (!segmentSatisfiesLengthAwareMaxAngleFromVertical(prev, next, maxAngleFromVerticalDeg)) {
                continue; // Can't remove — angle too steep
            }

            // Safe to remove this joint
            simplified = simplified.filter((_, idx) => idx !== i);
            changed = true;
            break; // Restart from beginning
        }
    }

    return simplified;
}

/**
 * Clears warm-start state for a model (call when model is removed or
 * support mode is exited).
 */
export function clearWarmStart(modelId: string): void {
    warmStartByModel.delete(modelId);
}

export function clearAllWarmStarts(): void {
    warmStartByModel.clear();
    stagnationCache.clear();
}

export function clearStagnationCache(meshUuid?: string): void {
    if (meshUuid) {
        stagnationCache.delete(meshUuid);
    } else {
        stagnationCache.clear();
    }
}
