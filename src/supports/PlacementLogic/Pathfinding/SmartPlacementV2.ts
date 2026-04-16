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
    segmentSatisfiesMaxAngleFromVertical,
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

// Minimum vertical span (mm) that routing joints must cover.
// If 2+ joints are all crammed into a small Z band at the tip (< this value),
// the path is squeezing through a model crack and should be rejected rather
// than placed as an embedded/mangled support.
const MIN_ROUTING_Z_SPAN_MM = 5.0;

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

    if (!isPreview) {
        console.log(`[SmartPlacementV2] called — socket=(${socketPos.x.toFixed(2)},${socketPos.y.toFixed(2)},${socketPos.z.toFixed(2)}) rootTopZ=${rootTopZ.toFixed(2)} straightClear=${straightClear} rootsFit=${rootsFitStandard}`);
    }

    if (straightClear && rootsFitStandard) {
        if (!isPreview) console.log(`[SmartPlacementV2] STRAIGHT path — no routing needed`);
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
            // Preview should remain responsive; use a smaller wide-step budget.
            maxExpansions: scaleExpansionsForStep(isPreview ? 250 : 600, WIDE_ASTAR_STEP_MM),
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
                const _rootsBlocked = isPreview
                    ? quickRootsDiskBlocked(sdf, bp.x, bp.y, diskHeight, coneHeight, rootsRadius, shaftRadius)
                    : rootsDiskBlocked(sdf, bp.x, bp.y, diskHeight, coneHeight, rootsRadius, shaftRadius);
                if (_rootsBlocked) continue;
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
            // Z-monotonicity filter (wide A* also allows limited upward moves)
            const _rawJoints = widePathJoints.map((j: Vec3) => ({ x: j.x, y: j.y, z: j.z }));
            const _zJoints: Vec3[] = [];
            let _prevZ = socketPos.z;
            for (const _wj of _rawJoints) {
                if (_wj.z < _prevZ) { _zJoints.push(_wj); _prevZ = _wj.z; }
            }

            const _wideRootTop: Vec3 = { x: _best.basePos.x, y: _best.basePos.y, z: rootTopZ };
            const _warning = standard.warning;

            // Preview fast-path: skip expensive simplification/straightening passes.
            // Click-time placement still runs the full quality pipeline.
            if (isPreview) {
                return {
                    ...standard,
                    joints: _zJoints,
                    basePos: _best.basePos,
                    unsnappedBottomPos: _ubp,
                    snappedNodeKey: _best.nodeKey ?? null,
                    warning: _warning,
                    error: undefined,
                };
            }

            // Run the same simplification pipeline as the fine-step path.
            // simplifyJointsSDF collapses unnecessary bends; the zero-joint sweep
            // then checks if a completely straight line is possible.
            const _simplifiedJoints = simplifyJointsSDF(
                _zJoints,
                socketPos,
                _wideRootTop,
                sdf,
                clearance,
                maxSegmentAngleFromVerticalDeg,
            );

            // Zero-joint sweep: try a straight line to the current base, below
            // the socket, and at small radial offsets.
            let _finalJoints = _simplifiedJoints;
            let _finalBase = _best;
            let _finalRootTop = _wideRootTop;
            let _oneJointStats: string | null = null;

            if (_finalJoints.length > 0) {
                // Zero-joint sweep: try straight lines from socket to candidate bases,
                // expanding outward ring-by-ring with early termination once no ring
                // can improve the best distance found so far.
                const _distSA = distanceXY(socketPos, _best.basePos);

                const _tryZeroCandidate = (sc: { x: number; y: number }): boolean => {
                    const _crt: Vec3 = { x: sc.x, y: sc.y, z: rootTopZ };
                    if (!segmentSatisfiesMaxAngleFromVertical(socketPos, _crt, ROUTING_ANGLE_FROM_VERTICAL_DEG)) return false;
                    if (rootsDiskBlocked(sdf, sc.x, sc.y, diskHeight, coneHeight, rootsRadius, shaftRadius)) return false;
                    if (sdf.segmentBlocked(socketPos.x, socketPos.y, socketPos.z, _crt.x, _crt.y, _crt.z, clearance)) return false;
                    if (!segmentSatisfiesLengthAwareMaxAngleFromVertical(socketPos, _crt, maxSegmentAngleFromVerticalDeg)) return false;
                    const _dxy0 = distanceXY(socketPos, _crt);
                    if (_dxy0 < _bestZeroDxy) {
                        _bestZeroDxy = _dxy0;
                        _finalJoints = [];
                        _finalBase = { basePos: { x: sc.x, y: sc.y, z: 0 }, snapDistance: 0, nodeKey: null };
                        _finalRootTop = _crt;
                    }
                    return true;
                };

                let _bestZeroDxy = Infinity;

                // Try seed candidates first (socket XY = dist 0, A* base).
                _tryZeroCandidate({ x: socketPos.x, y: socketPos.y });
                _tryZeroCandidate({ x: _best.basePos.x, y: _best.basePos.y });

                // Expand rings outward; terminate when no candidate in this ring
                // or any larger ring can beat the current best.
                const _sr = [1, 2, 3, 4, 6, 8, 10, 14, 18, 24, 30];
                for (const _r of _sr) {
                    if (_r > maxTotalLateralMm) break;
                    // Socket-centered candidates at this ring have distance _r from socket.
                    // A*-base-centered candidates have minimum distance max(0, _distSA - _r).
                    const _minPossible = Math.min(_r, Math.max(0, _distSA - _r));
                    if (_minPossible >= _bestZeroDxy) break;
                    for (let _d = 0; _d < 16; _d++) {
                        const _a = (_d / 16) * Math.PI * 2;
                        _tryZeroCandidate({ x: socketPos.x + Math.cos(_a) * _r, y: socketPos.y + Math.sin(_a) * _r });
                        _tryZeroCandidate({ x: _best.basePos.x + Math.cos(_a) * _r, y: _best.basePos.y + Math.sin(_a) * _r });
                    }
                }

                // ---------- One-joint minimization fallback ----------
                // Run when: (a) zero-joint sweep failed and we still have 2+ joints, OR
                // (b) zero-joint sweep found a path but the base is laterally far from
                // the socket — a one-joint path with a closer base may be better.
                const _zeroLateral = distanceXY(socketPos, { x: _finalBase.basePos.x, y: _finalBase.basePos.y, z: socketPos.z });
                const _needOneJointSearch = _finalJoints.length >= 2 || (_finalJoints.length === 0 && _zeroLateral > 1.5);
                if (!isPreview && _needOneJointSearch) {
                    const _baseCandidates: Array<{ x: number; y: number }> = [];
                    _baseCandidates.push({ x: _finalBase.basePos.x, y: _finalBase.basePos.y });
                    _baseCandidates.push({ x: socketPos.x, y: socketPos.y });
                    for (const _j of _finalJoints) _baseCandidates.push({ x: _j.x, y: _j.y });

                    // Radial base sweep around current base and socket.
                    const _baseRadii = [0.5, 1, 1.5, 2, 3, 4, 6];
                    for (const _r of _baseRadii) {
                        for (let _d = 0; _d < 12; _d++) {
                            const _a = (_d / 12) * Math.PI * 2;
                            _baseCandidates.push({
                                x: _finalBase.basePos.x + Math.cos(_a) * _r,
                                y: _finalBase.basePos.y + Math.sin(_a) * _r,
                            });
                            _baseCandidates.push({
                                x: socketPos.x + Math.cos(_a) * _r,
                                y: socketPos.y + Math.sin(_a) * _r,
                            });
                        }
                    }

                    const _jointCandidates: Vec3[] = [];
                    for (const _j of _finalJoints) _jointCandidates.push(_j);

                    // Synthesize candidate bends across Z and around the interpolated centerline.
                    const _jointRadii = [0, 0.6, 1.2];
                    const _zStep = 2.0;
                    for (let _zz = socketPos.z - _zStep; _zz > rootTopZ + _zStep; _zz -= _zStep) {
                        const _t = (socketPos.z - _zz) / (socketPos.z - rootTopZ);
                        const _cx = socketPos.x + (_finalBase.basePos.x - socketPos.x) * _t;
                        const _cy = socketPos.y + (_finalBase.basePos.y - socketPos.y) * _t;
                        for (const _jr of _jointRadii) {
                            if (_jr === 0) {
                                _jointCandidates.push({ x: _cx, y: _cy, z: _zz });
                                continue;
                            }
                            for (let _d = 0; _d < 12; _d++) {
                                const _a = (_d / 12) * Math.PI * 2;
                                _jointCandidates.push({
                                    x: _cx + Math.cos(_a) * _jr,
                                    y: _cy + Math.sin(_a) * _jr,
                                    z: _zz,
                                });
                            }
                        }
                    }

                    let _bestOneJoint:
                        | { joint: Vec3; baseXY: { x: number; y: number }; score: number }
                        | null = null;

                    // Stats for debug visibility.
                    let _testedPairs = 0;
                    let _skipRoots = 0;
                    let _skipSeg1 = 0;
                    let _skipSeg2 = 0;
                    let _skipAngle = 0;
                    const _oneJointMinFirstDropMm = 4.0;
                    const _oneJointEarlyBendPenaltyPerMm = 12.0;

                    const _rootsFitCache = new Map<string, boolean>();
                    const _rootsFitAt = (x: number, y: number): boolean => {
                        const _k = `${x.toFixed(3)},${y.toFixed(3)}`;
                        const _c = _rootsFitCache.get(_k);
                        if (_c !== undefined) return _c;
                        const _ok = !rootsDiskBlocked(sdf, x, y, diskHeight, coneHeight, rootsRadius, shaftRadius);
                        _rootsFitCache.set(_k, _ok);
                        return _ok;
                    };

                    // Pre-filter bases upfront: rootsFitAt is cached so no extra SDF cost,
                    // but building this list avoids re-evaluating it in the inner loop.
                    const _validBases: Array<{ x: number; y: number; crt: Vec3 }> = [];
                    for (const _bxy of _baseCandidates) {
                        if (!_rootsFitAt(_bxy.x, _bxy.y)) { _skipRoots++; continue; }
                        _validBases.push({ x: _bxy.x, y: _bxy.y, crt: { x: _bxy.x, y: _bxy.y, z: rootTopZ } });
                    }

                    // Outer loop: joints. Check seg1 (socket→joint) ONCE per joint instead of
                    // once per base×joint — it's base-independent, so inverting the loops
                    // reduces seg1 SDF calls by a factor of ~|_validBases| (~170×).
                    for (const _j of _jointCandidates) {
                        // Joint must remain strictly between socket and rootTop in Z.
                        if (_j.z >= socketPos.z - 0.001 || _j.z <= rootTopZ + 0.001) { _skipAngle++; continue; }

                        // Cheap angle gate before expensive SDF (seg1).
                        if (!segmentSatisfiesLengthAwareMaxAngleFromVertical(socketPos, _j, maxSegmentAngleFromVerticalDeg)) { _skipAngle++; continue; }

                        // socket → joint: evaluated once per joint, not once per base×joint.
                        if (sdf.segmentBlocked(socketPos.x, socketPos.y, socketPos.z, _j.x, _j.y, _j.z, clearance)) { _skipSeg1++; continue; }

                        for (const _vb of _validBases) {
                            _testedPairs++;
                            const _crt = _vb.crt;

                            // Cheap angle gate before expensive SDF (seg2).
                            if (!segmentSatisfiesLengthAwareMaxAngleFromVertical(_j, _crt, maxSegmentAngleFromVerticalDeg)) { _skipAngle++; continue; }

                            // joint → rootTop
                            if (sdf.segmentBlocked(_j.x, _j.y, _j.z, _crt.x, _crt.y, _crt.z, clearance)) { _skipSeg2++; continue; }

                            // Score: prefer straighter + shorter-lateral supports.
                            // Include seg2Lateral (joint→base XY distance) so joints that
                            // force a highly angled bottom segment are penalised relative to
                            // deeper joints whose base can sit nearly directly below them.
                            const _v1x = _j.x - socketPos.x;
                            const _v1y = _j.y - socketPos.y;
                            const _v1z = _j.z - socketPos.z;
                            const _v2x = _crt.x - _j.x;
                            const _v2y = _crt.y - _j.y;
                            const _v2z = _crt.z - _j.z;
                            const _n1 = Math.sqrt(_v1x * _v1x + _v1y * _v1y + _v1z * _v1z);
                            const _n2 = Math.sqrt(_v2x * _v2x + _v2y * _v2y + _v2z * _v2z);
                            const _cos = _n1 > 1e-6 && _n2 > 1e-6
                                ? ((_v1x * _v2x + _v1y * _v2y + _v1z * _v2z) / (_n1 * _n2))
                                : 1;
                            const _bendPenalty = 1 - Math.max(-1, Math.min(1, _cos));
                            const _lateralPenalty = distanceXY({ x: socketPos.x, y: socketPos.y, z: 0 }, { x: _crt.x, y: _crt.y, z: 0 });
                            const _seg2LateralPenalty = Math.sqrt(_v2x * _v2x + _v2y * _v2y);
                            const _firstDropMm = socketPos.z - _j.z;
                            const _earlyBendPenalty = Math.max(0, _oneJointMinFirstDropMm - _firstDropMm) * _oneJointEarlyBendPenaltyPerMm;
                            const _score = _bendPenalty * 100 + _lateralPenalty + _seg2LateralPenalty * 2 + _earlyBendPenalty;

                            if (!_bestOneJoint || _score < _bestOneJoint.score) {
                                _bestOneJoint = { joint: { x: _j.x, y: _j.y, z: _j.z }, baseXY: { x: _vb.x, y: _vb.y }, score: _score };
                            }
                        }
                    }

                    const _bestSeg2Lateral = _bestOneJoint
                        ? distanceXY(
                            { x: _bestOneJoint.joint.x, y: _bestOneJoint.joint.y, z: 0 },
                            { x: _bestOneJoint.baseXY.x, y: _bestOneJoint.baseXY.y, z: 0 },
                        )
                        : NaN;
                    const _bestFirstDrop = _bestOneJoint ? (socketPos.z - _bestOneJoint.joint.z) : NaN;
                    _oneJointStats = `pairs=${_testedPairs} rootsSkip=${_skipRoots} seg1Block=${_skipSeg1} seg2Block=${_skipSeg2} angleSkip=${_skipAngle} found=${_bestOneJoint ? 'yes' : 'no'}${_bestOneJoint ? ` bestSeg2Dxy=${_bestSeg2Lateral.toFixed(2)} bestFirstDrop=${_bestFirstDrop.toFixed(2)}` : ''}`;

                    let _twoJointTried = false;
                    let _twoJointFound = false;
                    if (_bestOneJoint) {
                        // When upgrading from a valid zero-joint, only accept the one-joint
                        // result if it actually brings the base closer to the socket.
                        const _oneJointBaseDxy = distanceXY(
                            socketPos,
                            { x: _bestOneJoint.baseXY.x, y: _bestOneJoint.baseXY.y, z: socketPos.z },
                        );
                        const _skipOneJoint = _finalJoints.length === 0 && _oneJointBaseDxy >= _zeroLateral;
                        if (!_skipOneJoint) {
                        // Base pull: the search found the best joint position for clearing the
                        // obstacle, but the base was chosen from A*-discovered candidates that
                        // can be far from the joint.  Now that we've fixed the joint, sweep
                        // candidates centred on the joint XY so seg2 is as close to
                        // straight-down as possible.
                        const _jFixed = _bestOneJoint.joint;
                        const _pullCandidates: Array<{ x: number; y: number }> = [
                            { x: _jFixed.x, y: _jFixed.y }, // directly below
                        ];
                        if (_ge && _sp > 0) {
                            // Include nearby grid nodes around directly-below.
                            const _nkNear = _bncCached(gridNodeKeyFromXY(_jFixed.x, _jFixed.y, _sp), 2);
                            for (const _nkp of _nkNear) {
                                const _sxy = gridSnappedXYFromKey(_nkp, _sp);
                                _pullCandidates.push({ x: _sxy.x, y: _sxy.y });
                            }
                        }
                        let _bestPullDxy = distanceXY(
                            { x: _bestOneJoint.baseXY.x, y: _bestOneJoint.baseXY.y, z: 0 },
                            { x: _jFixed.x, y: _jFixed.y, z: 0 },
                        );
                        for (const _pb of _pullCandidates) {
                            if (!_rootsFitAt(_pb.x, _pb.y)) continue;
                            const _pcrt: Vec3 = { x: _pb.x, y: _pb.y, z: rootTopZ };
                            if (sdf.segmentBlocked(_jFixed.x, _jFixed.y, _jFixed.z, _pcrt.x, _pcrt.y, _pcrt.z, clearance)) continue;
                            if (!segmentSatisfiesLengthAwareMaxAngleFromVertical(_jFixed, _pcrt, maxSegmentAngleFromVerticalDeg)) continue;
                            const _pdxy = distanceXY({ x: _pb.x, y: _pb.y, z: 0 }, { x: _jFixed.x, y: _jFixed.y, z: 0 });
                            if (_pdxy < _bestPullDxy) {
                                _bestPullDxy = _pdxy;
                                _bestOneJoint = { ..._bestOneJoint, baseXY: { x: _pb.x, y: _pb.y } };
                            }
                        }

                        _finalJoints = [_bestOneJoint.joint];
                        _finalBase = {
                            basePos: { x: _bestOneJoint.baseXY.x, y: _bestOneJoint.baseXY.y, z: 0 },
                            snapDistance: 0,
                            nodeKey: null,
                        };
                        _finalRootTop = { x: _bestOneJoint.baseXY.x, y: _bestOneJoint.baseXY.y, z: rootTopZ };

                        // Two-joint upgrade: if seg2 is still significantly angled after base
                        // pull, try inserting joint2 below the obstacle so the final leg drops
                        // nearly straight.  Strategy: walk down the Z axis at joint1's XY (and
                        // a small neighbourhood), find the first Z where both j1→j2 and
                        // j2→base(directly-below) are clear.
                        const _seg2Lateral = distanceXY(
                            { x: _bestOneJoint.joint.x, y: _bestOneJoint.joint.y, z: 0 },
                            { x: _bestOneJoint.baseXY.x, y: _bestOneJoint.baseXY.y, z: 0 },
                        );
                        const _firstDropMm = socketPos.z - _bestOneJoint.joint.z;
                        if (_seg2Lateral > 1.5 || _firstDropMm < _oneJointMinFirstDropMm) {
                            _twoJointTried = true;
                            const _j1u = _bestOneJoint.joint;
                            const _bXY = _bestOneJoint.baseXY;
                            // XY candidates for j2:
                            // (a) directly below j1, + 8 cardinal offsets — handles cases
                            //     where a nearby path exists below j1
                            // (b) interpolated along j1→base + base XY itself — handles the
                            //     common case where the model body is below j1 but a
                            //     kink halfway along the diagonal opens a clear straight-down
                            //     final leg from the interpolated point.
                            const _j2XYCandidates: Array<{ x: number; y: number }> = [
                                { x: _j1u.x, y: _j1u.y },
                            ];
                            const _j2Off = 0.6; // mm
                            for (const [dx, dy] of [[1,0],[-1,0],[0,1],[0,-1],[1,1],[-1,-1],[1,-1],[-1,1]]) {
                                _j2XYCandidates.push({ x: _j1u.x + dx * _j2Off, y: _j1u.y + dy * _j2Off });
                            }
                            // Also probe around current base XY so the upgrade can pick a
                            // cleaner drop column near the already-valid one-joint base.
                            for (const [dx, dy] of [[0,0],[1,0],[-1,0],[0,1],[0,-1],[1,1],[-1,-1],[1,-1],[-1,1]]) {
                                _j2XYCandidates.push({ x: _bXY.x + dx * _j2Off, y: _bXY.y + dy * _j2Off });
                            }
                            // Interpolate toward the base XY at 25%, 50%, 75%, 100%.
                            for (const _t of [0.25, 0.5, 0.75, 1.0]) {
                                _j2XYCandidates.push({
                                    x: _j1u.x + (_bXY.x - _j1u.x) * _t,
                                    y: _j1u.y + (_bXY.y - _j1u.y) * _t,
                                });
                            }
                            if (_ge && _sp > 0) {
                                const _near2 = _bncCached(gridNodeKeyFromXY(_j1u.x, _j1u.y, _sp), 1);
                                for (const _nkp of _near2) {
                                    const _s = gridSnappedXYFromKey(_nkp, _sp);
                                    _j2XYCandidates.push({ x: _s.x, y: _s.y });
                                }
                                const _nearBase = _bncCached(gridNodeKeyFromXY(_bXY.x, _bXY.y, _sp), 1);
                                for (const _nkp of _nearBase) {
                                    const _s = gridSnappedXYFromKey(_nkp, _sp);
                                    _j2XYCandidates.push({ x: _s.x, y: _s.y });
                                }
                            }

                            interface _TwoJointCandidate { j2: Vec3; baseXY: { x: number; y: number }; dxy: number }
                            let _bestTJ: _TwoJointCandidate | null = null;
                            const _j2ZStep = 0.5;
                            for (const _j2xy of _j2XYCandidates) {
                                if (!_rootsFitAt(_j2xy.x, _j2xy.y)) continue;
                                const _crt2: Vec3 = { x: _j2xy.x, y: _j2xy.y, z: rootTopZ };
                                for (let _z2 = _j1u.z - _j2ZStep; _z2 > rootTopZ + _j2ZStep; _z2 -= _j2ZStep) {
                                    const _j2c: Vec3 = { x: _j2xy.x, y: _j2xy.y, z: _z2 };
                                    // seg1b: j1 → j2
                                    if (sdf.segmentBlocked(_j1u.x, _j1u.y, _j1u.z, _j2c.x, _j2c.y, _j2c.z, clearance)) continue;
                                    // IMPORTANT: for fixed XY, lowering z2 increases vertical
                                    // drop on seg1b, so an angle failure at a higher z2 can
                                    // become valid at a lower z2. Keep scanning downward.
                                    if (!segmentSatisfiesLengthAwareMaxAngleFromVertical(_j1u, _j2c, maxSegmentAngleFromVerticalDeg)) continue;
                                    // seg2: j2 → base (straight down)
                                    if (sdf.segmentBlocked(_j2c.x, _j2c.y, _j2c.z, _crt2.x, _crt2.y, _crt2.z, clearance)) continue;
                                    if (!segmentSatisfiesLengthAwareMaxAngleFromVertical(_j2c, _crt2, maxSegmentAngleFromVerticalDeg)) break;
                                    const _dxy2 = distanceXY({ x: _j2xy.x, y: _j2xy.y, z: 0 }, { x: _j1u.x, y: _j1u.y, z: 0 });
                                    if (!_bestTJ || _dxy2 < _bestTJ.dxy || (_dxy2 === _bestTJ.dxy && _z2 > _bestTJ.j2.z)) {
                                        _bestTJ = { j2: _j2c, baseXY: { x: _j2xy.x, y: _j2xy.y }, dxy: _dxy2 };
                                    }
                                    break; // highest valid Z for this XY found, don't go lower
                                }
                            }

                            if (_bestTJ) {
                                _twoJointFound = true;
                                _finalJoints = [_j1u, _bestTJ.j2];
                                _finalBase = {
                                    basePos: { x: _bestTJ.baseXY.x, y: _bestTJ.baseXY.y, z: 0 },
                                    snapDistance: 0,
                                    nodeKey: null,
                                };
                                _finalRootTop = { x: _bestTJ.baseXY.x, y: _bestTJ.baseXY.y, z: rootTopZ };
                            }
                        }
                        } // !_skipOneJoint
                        if (_oneJointStats) {
                            _oneJointStats += ` twoJointTried=${_twoJointTried ? 'yes' : 'no'} twoJointFound=${_twoJointFound ? 'yes' : 'no'}`;
                        }
                    }
                }
            }

            // Quality gate: if still 2+ joints and they're all crammed into a
            // tight Z band (< MIN_ROUTING_Z_SPAN_MM), the path is squeezing
            // through a model crack — reject it rather than embed the support.
            if (_finalJoints.length >= 2) {
                const _routingSpan = socketPos.z - _finalJoints[_finalJoints.length - 1].z;
                if (_routingSpan < MIN_ROUTING_Z_SPAN_MM) {
                    if (!isPreview) {
                        console.log(
                            `[SmartPlacementV2] WIDE-STEP rejected — tight crack (routingSpan=${_routingSpan.toFixed(2)}mm < ${MIN_ROUTING_Z_SPAN_MM}mm with ${_finalJoints.length} joints)`,
                        );
                    }
                    // No usable path — fall through to COLLISION_WITH_MODEL.
                    return {
                        ...standard,
                        error: 'COLLISION_WITH_MODEL',
                    };
                }
            }

            // Angle check on final chain
            const _allSegs = [socketPos, ..._finalJoints, _finalRootTop];
            let _angleOk = true;
            for (let _si = 0; _si < _allSegs.length - 1; _si++) {
                if (!segmentSatisfiesLengthAwareMaxAngleFromVertical(_allSegs[_si], _allSegs[_si + 1], maxSegmentAngleFromVerticalDeg)) {
                    _angleOk = false; break;
                }
            }
            if (_angleOk) {
                if (!isPreview) {
                    const _wideChain = [socketPos, ..._finalJoints, _finalRootTop];
                    const _wideSegs = _wideChain.slice(0,-1).map((p,i) => {
                        const q = _wideChain[i+1];
                        const dz = q.z-p.z; const dxy = Math.sqrt((q.x-p.x)**2+(q.y-p.y)**2);
                        const dir = dz>0.001?'⬆️UP':dz<-0.001?'⬇️dn':'➡️hz';
                        return `  seg${i}: (${p.x.toFixed(2)},${p.y.toFixed(2)},${p.z.toFixed(2)})→(${q.x.toFixed(2)},${q.y.toFixed(2)},${q.z.toFixed(2)}) dz=${dz.toFixed(2)} dxy=${dxy.toFixed(2)} ${dir}`;
                    });
                    const _wideHasRise = _wideChain.slice(0,-1).some((p,i)=>_wideChain[i+1].z>p.z+0.001);
                    console.log(
                        `[SmartPlacementV2] WIDE-STEP result — ${_finalJoints.length} joint(s) (raw=${_rawJoints.length} simplified=${_simplifiedJoints.length})${_wideHasRise?' ⚠️ HAS UPWARD SEGMENTS':' ✅ monotonic'}\n` +
                        `  socket: (${socketPos.x.toFixed(2)},${socketPos.y.toFixed(2)},${socketPos.z.toFixed(2)})\n` +
                        `  finalJoints: [${_finalJoints.map((p: Vec3)=>`(${p.x.toFixed(1)},${p.y.toFixed(1)},${p.z.toFixed(1)})`).join(' ')}]\n` +
                        `  base: (${_finalBase.basePos.x.toFixed(2)},${_finalBase.basePos.y.toFixed(2)}) rootTopZ=${rootTopZ.toFixed(2)}\n` +
                        (_oneJointStats ? `  oneJointSearch: ${_oneJointStats}\n` : '') +
                        _wideSegs.join('\n'),
                    );
                }
                return {
                    ...standard,
                    joints: _finalJoints,
                    basePos: _finalBase.basePos,
                    unsnappedBottomPos: _ubp,
                    snappedNodeKey: _finalBase.nodeKey ?? null,
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
    //    Safety: enforce Z-monotonicity on the joints (the A* allows limited
    //    upward moves to route around protrusions — strip any that survived
    //    simplification so the final support never rises).
    const rawPathJoints = result.path.slice(1, -1);
    const pathJoints: Vec3[] = [];
    let prevJointZ = socketPos.z;
    for (let ji = 0; ji < rawPathJoints.length; ji++) {
        if (rawPathJoints[ji].z < prevJointZ) {
            pathJoints.push(rawPathJoints[ji]);
            prevJointZ = rawPathJoints[ji].z;
        }
    }
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
        const rootsBlockedAtBase = isPreview
            ? quickRootsDiskBlocked(sdf, basePos.x, basePos.y, diskHeight, coneHeight, rootsRadius, shaftRadius)
            : rootsDiskBlocked(sdf, basePos.x, basePos.y, diskHeight, coneHeight, rootsRadius, shaftRadius);
        if (rootsBlockedAtBase) continue;

        // Check that the last shaft segment (lowest joint → rootTopTarget) is also clear
        const lastJoint = pathJoints.length > 0 ? pathJoints[pathJoints.length - 1] : pathEnd;
        const lastSegClear = isPreview
            ? !segmentBlockedCoarse(
                sdf,
                lastJoint.x, lastJoint.y, lastJoint.z,
                rootTopTarget.x, rootTopTarget.y, rootTopTarget.z,
                clearance,
                PREVIEW_SEGMENT_STEP_MM,
            )
            : !sdf.segmentBlocked(
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

    // Preview fast-path: avoid expensive SDF simplification, straightening and
    // full-chain validation on every hover frame. Click-time placement (isPreview=false)
    // still executes the full quality pipeline below.
    if (isPreview) {
        return {
            socketPos,
            joints: pathJoints,
            constructionJoints: [],
            basePos: bestBase.basePos,
            unsnappedBottomPos,
            snappedNodeKey: bestBase.nodeKey,
            warning: standard.warning,
            angle: standard.angle,
            coneAxis: standard.coneAxis,
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

    // 7b. Path straightening — eliminate zigzag by finding a base position
    //     where a straight (zero-joint) or single-bend (one-joint) path
    //     clears all geometry.  The A* at 0.25mm steps creates fine-grained
    //     detours that survive simplification; this pass searches for a
    //     more direct alternative before accepting the zigzag.
    let finalJoints = simplifiedJoints;
    let finalBase = bestBase;

    if (finalJoints.length > 0) {
        // ---------- Zero-joint radial sweep ----------
        // Search for ANY base position where a straight socket→rootTop line
        // is collision-free and angle-valid.  Start with the obvious candidates
        // (original base, below socket, below lowest joint) then sweep radially
        // around the socket XY projection at increasing radii.  The first hit
        // wins — it produces the straightest possible support.
        const zeroJointBaseXYCandidates: Array<{ x: number; y: number }> = [];

        // Priority candidates first
        zeroJointBaseXYCandidates.push({ x: bestBase.basePos.x, y: bestBase.basePos.y });
        zeroJointBaseXYCandidates.push({ x: socketPos.x, y: socketPos.y });
        if (finalJoints.length > 0) {
            const lowest = finalJoints[finalJoints.length - 1];
            zeroJointBaseXYCandidates.push({ x: lowest.x, y: lowest.y });
        }

        // Radial sweep around BOTH socket XY and A*-found base XY.
        // The model body is directly below the socket (hence straightClear=false),
        // so sweeping only around socket XY wastes most candidates. Sweeping
        // around the A*-found base (which is already clear) finds viable
        // straight-line positions much faster.
        //
        // Use the flat routing angle (80°) as a generous pre-filter so the
        // search isn't limited to ~9mm radius by length-aware tightening
        // on 22mm-tall supports. The tightened angle is enforced at commit time.
        const sweepDirs = 16;
        const sweepRadii = [1, 2, 3, 4, 6, 8, 10, 14, 18, 24, 30];
        for (const r of sweepRadii) {
            if (r > maxTotalLateralMm) break;
            for (let d = 0; d < sweepDirs; d++) {
                const a = (d / sweepDirs) * Math.PI * 2;
                // Around socket XY
                zeroJointBaseXYCandidates.push({
                    x: socketPos.x + Math.cos(a) * r,
                    y: socketPos.y + Math.sin(a) * r,
                });
                // Around A*-found base XY (often on the other side of the obstacle)
                zeroJointBaseXYCandidates.push({
                    x: bestBase.basePos.x + Math.cos(a) * r,
                    y: bestBase.basePos.y + Math.sin(a) * r,
                });
            }
        }

        let foundStraight = false;
        for (const bxy of zeroJointBaseXYCandidates) {
            const candRootTop: Vec3 = { x: bxy.x, y: bxy.y, z: rootTopZ };

            // Pre-filter with flat routing angle (80°) — avoids discarding candidates
            // that would be reachable by A* but fail the length-aware tightening.
            // The tightened check below gates final commit.
            if (!segmentSatisfiesMaxAngleFromVertical(socketPos, candRootTop, ROUTING_ANGLE_FROM_VERTICAL_DEG)) continue;

            // Roots must fit
            if (rootsDiskBlocked(sdf, bxy.x, bxy.y, diskHeight, coneHeight, rootsRadius, shaftRadius)) continue;

            // Straight shaft must be clear
            if (sdf.segmentBlocked(socketPos.x, socketPos.y, socketPos.z, candRootTop.x, candRootTop.y, candRootTop.z, clearance)) continue;

            // Final angle gate: enforce length-aware tightened constraint before commit
            // so we never return a geometrically invalid support.
            if (!segmentSatisfiesLengthAwareMaxAngleFromVertical(socketPos, candRootTop, maxSegmentAngleFromVerticalDeg)) continue;

            // Winner — zero joints, straight support
            finalJoints = [];
            finalBase = {
                basePos: { x: bxy.x, y: bxy.y, z: 0 },
                rootTopTarget: candRootTop,
                snapDistance: distanceXY({ x: bxy.x, y: bxy.y, z: 0 }, unsnappedBottomPos),
                nodeKey: null,
            };
            foundStraight = true;
            break;
        }

        // ---------- One-joint fallback ----------
        // If no zero-joint path exists, try reducing to a single joint.
        if (!foundStraight && finalJoints.length >= 2) {
            const oneJointCandidates: Array<{ joint: Vec3; baseXY: { x: number; y: number } }> = [];

            // Keep first or last joint with original base
            oneJointCandidates.push({ joint: finalJoints[0], baseXY: { x: bestBase.basePos.x, y: bestBase.basePos.y } });
            oneJointCandidates.push({ joint: finalJoints[finalJoints.length - 1], baseXY: { x: bestBase.basePos.x, y: bestBase.basePos.y } });

            // Each joint with base below it
            for (const j of finalJoints) {
                oneJointCandidates.push({ joint: j, baseXY: { x: j.x, y: j.y } });
            }

            for (const oc of oneJointCandidates) {
                const candRootTop: Vec3 = { x: oc.baseXY.x, y: oc.baseXY.y, z: rootTopZ };

                if (rootsDiskBlocked(sdf, oc.baseXY.x, oc.baseXY.y, diskHeight, coneHeight, rootsRadius, shaftRadius)) continue;

                // Check both segments: socket→joint and joint→rootTop
                const seg1Ok = !sdf.segmentBlocked(socketPos.x, socketPos.y, socketPos.z, oc.joint.x, oc.joint.y, oc.joint.z, clearance)
                    && segmentSatisfiesLengthAwareMaxAngleFromVertical(socketPos, oc.joint, maxSegmentAngleFromVerticalDeg);
                if (!seg1Ok) continue;

                const seg2Ok = !sdf.segmentBlocked(oc.joint.x, oc.joint.y, oc.joint.z, candRootTop.x, candRootTop.y, candRootTop.z, clearance)
                    && segmentSatisfiesLengthAwareMaxAngleFromVertical(oc.joint, candRootTop, maxSegmentAngleFromVerticalDeg);
                if (!seg2Ok) continue;

                finalJoints = [oc.joint];
                finalBase = {
                    basePos: { x: oc.baseXY.x, y: oc.baseXY.y, z: 0 },
                    rootTopTarget: candRootTop,
                    snapDistance: distanceXY({ x: oc.baseXY.x, y: oc.baseXY.y, z: 0 }, unsnappedBottomPos),
                    nodeKey: null,
                };
                break;
            }
        }
    }

    // 8. Quality gate: reject paths where routing joints are compressed into a
    //    tight Z band near the socket — signature of squeezing through a crack.
    if (finalJoints.length >= 2) {
        const routingZSpan = socketPos.z - finalJoints[finalJoints.length - 1].z;
        if (routingZSpan < MIN_ROUTING_Z_SPAN_MM) {
            return {
                ...standard,
                error: 'COLLISION_WITH_MODEL',
            };
        }
    }

    // 8b. Final SDF validation of the complete chain.
    //    Even after simplification + straightening, verify every segment is clear.
    //    This is the last line of defense against any clipping.
    //    Chain runs high-Z (socketPos) → low-Z (rootTopTarget) so each
    //    segment descends and the angle helper sees positive vertical drop.
    const finalChainPoints: Vec3[] = [
        socketPos,
        ...finalJoints,
        finalBase.rootTopTarget,
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
        joints: finalJoints,
        constructionJoints: [],
        basePos: finalBase.basePos,
        unsnappedBottomPos,
        snappedNodeKey: finalBase.nodeKey,
        warning: standard.warning,
        angle: standard.angle,
        coneAxis: standard.coneAxis,
    };

    if (!isPreview) {
        // Build the full chain for logging: socket → joints → rootTop
        const logChain = [socketPos, ...finalJoints, finalBase.rootTopTarget];
        const segmentLog = logChain.slice(0, -1).map((pt, i) => {
            const next = logChain[i + 1];
            const dz = next.z - pt.z;
            const dxy = Math.sqrt((next.x - pt.x) ** 2 + (next.y - pt.y) ** 2);
            const dir = dz > 0.001 ? '⬆️UP' : dz < -0.001 ? '⬇️dn' : '➡️hz';
            return `  seg${i}: (${pt.x.toFixed(2)},${pt.y.toFixed(2)},${pt.z.toFixed(2)}) → (${next.x.toFixed(2)},${next.y.toFixed(2)},${next.z.toFixed(2)}) dz=${dz.toFixed(2)} dxy=${dxy.toFixed(2)} ${dir}`;
        });
        const hasRise = logChain.slice(0, -1).some((pt, i) => logChain[i + 1].z > pt.z + 0.001);
        console.log(
            `[SmartPlacementV2] PLACED support — ${finalJoints.length} joint(s)${hasRise ? ' ⚠️ HAS UPWARD SEGMENTS' : ' ✅ monotonic'}\n` +
            `  socket:  (${socketPos.x.toFixed(2)},${socketPos.y.toFixed(2)},${socketPos.z.toFixed(2)})\n` +
            `  rawJoints(pre-filter): [${result.path.slice(1,-1).map(p=>`(${p.x.toFixed(1)},${p.y.toFixed(1)},${p.z.toFixed(1)})`).join(' ')}]\n` +
            `  simplifiedJoints: [${simplifiedJoints.map(p=>`(${p.x.toFixed(1)},${p.y.toFixed(1)},${p.z.toFixed(1)})`).join(' ')}]\n` +
            `  finalJoints: [${finalJoints.map(p=>`(${p.x.toFixed(1)},${p.y.toFixed(1)},${p.z.toFixed(1)})`).join(' ')}]\n` +
            `  base/rootTop: (${finalBase.basePos.x.toFixed(2)},${finalBase.basePos.y.toFixed(2)}) rootTopZ=${finalBase.rootTopTarget.z.toFixed(2)}\n` +
            segmentLog.join('\n'),
        );
    }

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
            // Chain runs high-Z (socketPos) → low-Z (rootTopTarget) so each
            // segment descends and the angle helper sees positive vertical drop.
            const prev = i === 0 ? socketPos : simplified[i - 1];
            const next = i === simplified.length - 1 ? rootTopTarget : simplified[i + 1];

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
