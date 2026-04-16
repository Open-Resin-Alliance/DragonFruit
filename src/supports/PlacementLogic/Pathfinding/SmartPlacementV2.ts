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
const ROOTS_DISK_SAFETY_MM = 0.1;

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
const ROUTED_DETOUR_ANGLE_SLACK_DEG = 10;

// A* lattice resolution.
// Fine pass: high-precision routing to avoid multiple supports collapsing
// into a shared quantized root position when grid mode is disabled.
// Wide pass: coarser rescue search for large detours, but still much finer
// than legacy 6mm to keep roots tight.
const FINE_ASTAR_STEP_MM = 0.25;
const WIDE_ASTAR_STEP_MM = 0.6;
const LEGACY_BASE_STEP_MM = 2.0;

function scaleExpansionsForStep(baseExpansionsAt2mm: number, stepMm: number): number {
    // Keep approximate travel reach comparable to historical 2mm tuning by
    // scaling expansion budget with inverse step size.
    return Math.max(1, Math.round((baseExpansionsAt2mm * LEGACY_BASE_STEP_MM) / stepMm));
}

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
const warmStartByModel = new Map<string, WarmStartState>(); // full / click-time runs
/**
 * Separate warm-start map for hover-preview A* runs (600- or 1200-expansion,
 * endpointOnly collision checks). Preview warm states can traverse cells that
 * full segmentBlocked would reject — keeping them separate prevents parity
 * re-runs from starting at a biased search frontier.
 */
const previewWarmStartByModel = new Map<string, WarmStartState>(); // hover preview runs

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
// True-stagnation radius: positions within 1.5mm of a confirmed cavity are
// also treated as cavities (saves A* re-run for tiny hover jitter).
const STAGNATION_RADIUS_MM = 1.5;
const STAGNATION_RADIUS_SQ = STAGNATION_RADIUS_MM * STAGNATION_RADIUS_MM;
// Preview-exhausted radius: smaller than stagnation because exhausted-budget
// is NOT a confirmed dead-end — the full-budget solver may still succeed.
// 1mm avoids re-running preview A* on identical pixel, but doesn't block
// valid positions 1-2mm away from an exhausted query.
const PREVIEW_EXHAUSTED_RADIUS_MM = 1.0;
const PREVIEW_EXHAUSTED_RADIUS_SQ = PREVIEW_EXHAUSTED_RADIUS_MM * PREVIEW_EXHAUSTED_RADIUS_MM;
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

function isNearSpatialPoint(cache: Map<string, Vec3[]>, meshUuid: string, pos: Vec3, radiusSq: number): boolean {
    const points = cache.get(meshUuid);
    if (!points || points.length === 0) return false;
    for (let i = 0; i < points.length; i++) {
        const p = points[i];
        const dx = pos.x - p.x;
        const dy = pos.y - p.y;
        const dz = pos.z - p.z;
        if (dx * dx + dy * dy + dz * dz < radiusSq) return true;
    }
    return false;
}

function recordSpatialPoint(cache: Map<string, Vec3[]>, meshUuid: string, pos: Vec3, radiusSq: number): void {
    let points = cache.get(meshUuid);
    if (!points) {
        points = [];
        cache.set(meshUuid, points);
    }
    if (isNearSpatialPoint(cache, meshUuid, pos, radiusSq)) return;
    if (points.length >= MAX_STAGNATION_ENTRIES) {
        points.splice(0, points.length - MAX_STAGNATION_ENTRIES + 1);
    }
    points.push({ x: pos.x, y: pos.y, z: pos.z });
}

function isNearStagnationPoint(meshUuid: string, pos: Vec3): boolean {
    return isNearSpatialPoint(stagnationCache, meshUuid, pos, STAGNATION_RADIUS_SQ);
}

function recordStagnation(meshUuid: string, pos: Vec3): void {
    recordSpatialPoint(stagnationCache, meshUuid, pos, STAGNATION_RADIUS_SQ);
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
    // maxSegmentAngleFromVerticalDeg is used for FINAL path validation — it enforces
    // the configured trunk angle on the resolved route.  A* exploration uses a
    // separate, more generous angle so the pathfinder can route around overhangs
    // without being artificially constrained by the same value.
    const maxSegmentAngleFromVerticalDeg = Math.min(88, (90 - minRoutedTrunkAngleDeg) + ROUTED_DETOUR_ANGLE_SLACK_DEG);
    // ROUTING_ANGLE_FROM_VERTICAL_DEG: generous A* budget (80°) so the pathfinder
    // can take lateral steps to navigate around overhangs. Final trunk angle is
    // validated via maxSegmentAngleFromVerticalDeg after the path is resolved.
    const ROUTING_ANGLE_FROM_VERTICAL_DEG = 80;
    const maxTotalLateralMm = Math.max(60, settings.grid.spacingMm * 15);

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
    // Uses a tighter radius (PREVIEW_EXHAUSTED_RADIUS_SQ) than true stagnation so
    // we don't block valid positions 1-2mm away from an exhausted query.
    if (context?.isPreview && isNearSpatialPoint(previewExhaustedCache, mesh.uuid, socketPos, PREVIEW_EXHAUSTED_RADIUS_SQ)) {
        return { ...standard, error: 'COLLISION_WITH_MODEL', exhaustedBudget: true };
    }

    // 3c. (Removed) — The vertical solvability pre-check was a false optimisation.
    //     On overhang geometry the entire model body is directly below the socket,
    //     so all straight-down spine samples are inside the mesh (deeply negative SDF)
    //     AND the narrow (3–9mm) lateral probes can also be blocked by the wide
    //     overhang, causing instant stagnation before A* even runs. V1 had no such
    //     pre-check — it always passed the position to the search. True cavities are
    //     correctly detected by A*'s own STAGNATION_LIMIT (250 expansions with no Z
    //     progress) and cached in the stagnationCache afterwards.

    // 4. Run grid A* from socket down to rootTopZ.
    //    The goalValidator integrates roots collision into the search:
    //    when A* reaches a cell at rootTopZ, it checks that the full roots
    //    volume below that XY is clear. If not, the search continues laterally
    //    to find a valid position — proper 3D pathfinding for the whole support.
    // Preview runs borrow from the full warm-start map when their own map is cold,
    // giving 600-expansion preview A* a good starting frontier without polluting
    // the full map with endpoint-only states. Parity re-runs pass warmStart:null
    // explicitly via context so they always start clean.
    const warmStart = context?.warmStart !== undefined
        ? context.warmStart
        : isPreview
            ? (previewWarmStartByModel.get(modelId) ?? warmStartByModel.get(modelId) ?? null)
            : (warmStartByModel.get(modelId) ?? null);

    // For preview: use the quick (reduced-sample) roots check in the goal validator.
    // The full-resolution check is reserved for click-time placement.
    const goalValidator = (wx: number, wy: number, wz: number) => {
        void wz;
        return isPreview
            ? !quickRootsDiskBlocked(sdf, wx, wy, diskHeight, coneHeight, rootsRadius, shaftRadius)
            : !rootsDiskBlocked(sdf, wx, wy, diskHeight, coneHeight, rootsRadius, shaftRadius);
    };

    const result = gridAStar(sdf, socketPos, rootTopZ, {
        clearanceMm: clearance,
        maxLateralMm: maxTotalLateralMm,
        minAngleFromVerticalDeg: ROUTING_ANGLE_FROM_VERTICAL_DEG,
        occupancy: context?.occupancy,
        ignoreSupportId: context?.placingSupportId,
        maxExpansions: scaleExpansionsForStep(context?.maxExpansions ?? 2000, FINE_ASTAR_STEP_MM),
        stepMm: FINE_ASTAR_STEP_MM,
        goalValidator,
        // For hover preview, use endpoint-only SDF checks in the A* neighbor loop.
        // The default segmentBlocked samples at 0.5mm intervals on a 2mm grid — all
        // intermediate sub-grid points are permanent cold BVH cache misses, causing
        // ~30k–60k uncacheable BVH queries per hover frame on interior surfaces.
        // Endpoint-only checks hit grid-aligned cells that ARE cached after first
        // visit, dropping first-frame cold cost from ~30k to ~600 BVH calls.
        endpointOnlyCollisionCheck: isPreview,
    }, warmStart);

    // ---------- Wide-step fallback (V1 parity for large-detour overhangs) ----------
    //
    // V1 (SmartPlacement) used macro-jump candidates at radii 2–40mm × 16 directions,
    // letting it traverse a 40mm lateral detour in a SINGLE expansion. V2's 2mm grid
    // needs ~20 steps for the same distance, exhausting its 2000-expansion budget on
    // complex overhangs before finding the clear corridor.
    //
    // When the fine-step search fails (exhausted budget, stagnated, or simply hit
    // a pathfinding ceiling), retry with a 6mm grid and 600 expansions. The coarser
    // grid gives V1-equivalent reach (10 cells × 6mm = 60mm per axis), while keeping
    // SDF-backed precision for each edge validation. Any directed path that V1 would
    // find in macro-jumps, V2 at 6mm step will find in similar expansion counts.
    // Only retry if we didn't already reach a goal — don't double-process successes.
    if (!result.reached) {
        const wideResult = gridAStar(sdf, socketPos, rootTopZ, {
            clearanceMm: clearance,
            maxLateralMm: maxTotalLateralMm,
            minAngleFromVerticalDeg: ROUTING_ANGLE_FROM_VERTICAL_DEG,
            occupancy: context?.occupancy,
            ignoreSupportId: context?.placingSupportId,
            maxExpansions: scaleExpansionsForStep(600, WIDE_ASTAR_STEP_MM),
            stepMm: WIDE_ASTAR_STEP_MM,
            goalValidator,
            endpointOnlyCollisionCheck: isPreview,
        }, null); // always cold-start wide search (different grid quantisation)
        if (wideResult.reached) {
            // Wide-step succeeded — use its result. Don't write to warm-start maps
            // since the 6mm grid state is incompatible with the normal 2mm warm-start.
            const widePathJoints = wideResult.path.slice(1, -1);
            const widePathEnd = wideResult.path[wideResult.path.length - 1];
            // Grid-snap the base and validate angle using the routing angle (looser than final)
            const _wpc = new Map<string, string[]>();
            const _bncCached = (pk: string, mr: number) => {
                const k2 = `${pk}|${mr}`;
                const cv = _wpc.get(k2);
                if (cv) return cv;
                const c2 = buildNearestCandidateNodeKeys(pk, mr);
                _wpc.set(k2, c2);
                return c2;
            };
            const _ge = settings.grid.enabled;
            const _sp = settings.grid.spacingMm;
            const _ubp: Vec3 = { x: widePathEnd.x, y: widePathEnd.y, z: 0 };
            const _cnk = _ge
                ? _bncCached(gridNodeKeyFromXY(_ubp.x, _ubp.y, _sp), MAX_NEAREST_NODE_SEARCH_RINGS)
                : ['disabled'];
            let _best: { basePos: Vec3; snapDistance: number; nodeKey: string | null } | null = null;
            const _wideSubGridOffset = !_ge ? {
                x: input.tipPos.x - Math.round(input.tipPos.x / WIDE_ASTAR_STEP_MM) * WIDE_ASTAR_STEP_MM,
                y: input.tipPos.y - Math.round(input.tipPos.y / WIDE_ASTAR_STEP_MM) * WIDE_ASTAR_STEP_MM,
            } : null;
            for (const nk of _cnk) {
                let sxy = _ge ? gridSnappedXYFromKey(nk, _sp) : { x: _ubp.x, y: _ubp.y };
                if (!_ge && _wideSubGridOffset) {
                    sxy = {
                        x: sxy.x + _wideSubGridOffset.x,
                        y: sxy.y + _wideSubGridOffset.y,
                    };
                }
                const bp: Vec3 = { x: sxy.x, y: sxy.y, z: 0 };
                if (rootsDiskBlocked(sdf, bp.x, bp.y, diskHeight, coneHeight, rootsRadius, shaftRadius)) continue;
                const sd = distanceXY(bp, _ubp);
                if (!_best || sd < _best.snapDistance) _best = { basePos: bp, snapDistance: sd, nodeKey: nk };
            }
            if (!_best) {
                _best = {
                    basePos: { x: _ubp.x, y: _ubp.y, z: 0 },
                    snapDistance: 0,
                    nodeKey: null,
                };
            }
            const _joints = widePathJoints.map((j: Vec3) => ({ x: j.x, y: j.y, z: j.z }));
            const _warning = standard.warning;
            // During exploration, use loose angle constraint for routing
            const _explorationMaxAngleDeg = 88;
            const _angleCheck = segmentSatisfiesLengthAwareMaxAngleFromVertical;
            const _allSegs = [socketPos, ..._joints, { x: _best.basePos.x, y: _best.basePos.y, z: rootTopZ }];
            let _angleOk = true;
            for (let _si = 0; _si < _allSegs.length - 1; _si++) {
                const _sa = _allSegs[_si];
                const _sb = _allSegs[_si + 1];
                if (!_angleCheck(_sa, _sb, _explorationMaxAngleDeg)) { _angleOk = false; break; }
            }
            if (_angleOk) {
                return {
                    ...standard,
                    joints: _joints,
                    basePos: _best.basePos,
                    unsnappedBottomPos: _ubp,
                    snappedNodeKey: _best.nodeKey ?? null,
                    warning: _warning,
                    error: undefined,
                };
            }
        }
    }
    // Record preview-exhaustion ONLY if both passes failed, not after just fine-step.
    if (!result.reached && isPreview && (result.hitExpansionLimit || result.stagnated)) {
        recordSpatialPoint(previewExhaustedCache, mesh.uuid, socketPos, PREVIEW_EXHAUSTED_RADIUS_SQ);
    }

    // Store warm-start for next frame — write to the correct map based on mode.
    if (result.warmState) {
        if (isPreview) {
            previewWarmStartByModel.set(modelId, result.warmState);
        } else {
            warmStartByModel.set(modelId, result.warmState);
        }
    }
    if (result.stagnated) {
        if (isPreview) {
            previewWarmStartByModel.delete(modelId);
        } else {
            warmStartByModel.delete(modelId);
        }
        if (!isPreview) {
            recordStagnation(mesh.uuid, socketPos);
        }
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
    //    When grid is disabled, preserve the sub-grid offset from socketPos
    //    so that nearby placements don't all converge to the same 2mm grid cell.
    const gridEnabled = settings.grid.enabled;
    const spacingMm = settings.grid.spacingMm;
    const nearestCandidateNodeKeysCache = new Map<string, string[]>();
    const buildNearestCandidateNodeKeysCached = (preferredKey: string, maxRings: number) => {
        const key = `${preferredKey}|${maxRings}`;
        const cached = nearestCandidateNodeKeysCache.get(key);
        if (cached) return cached;
        const computed = buildNearestCandidateNodeKeys(preferredKey, maxRings);
        nearestCandidateNodeKeysCache.set(key, computed);
        return computed;
    };

    const unsnappedBottomPos: Vec3 = {
        x: pathEnd.x,
        y: pathEnd.y,
        z: 0,
    };

    // Pre-compute sub-grid offset when grid is disabled. This carries the
    // user-clicked position's fractional offset through the path to ensure
    // unique base positions even when underlying pathfinder quantizes to 2mm.
    const subGridOffset = !gridEnabled ? {
        x: input.tipPos.x - Math.round(input.tipPos.x / FINE_ASTAR_STEP_MM) * FINE_ASTAR_STEP_MM,
        y: input.tipPos.y - Math.round(input.tipPos.y / FINE_ASTAR_STEP_MM) * FINE_ASTAR_STEP_MM,
    } : null;

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
        let snappedXY = gridEnabled
            ? gridSnappedXYFromKey(nodeKey, spacingMm)
            : { x: unsnappedBottomPos.x, y: unsnappedBottomPos.y };

        // When grid is disabled, apply the sub-grid offset to preserve uniqueness
        if (!gridEnabled && subGridOffset) {
            snappedXY = {
                x: snappedXY.x + subGridOffset.x,
                y: snappedXY.y + subGridOffset.y,
            };
        }

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
        maxSegmentAngleFromVerticalDeg,
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

        if (!segmentSatisfiesLengthAwareMaxAngleFromVertical(a, b, maxSegmentAngleFromVerticalDeg)) {
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
