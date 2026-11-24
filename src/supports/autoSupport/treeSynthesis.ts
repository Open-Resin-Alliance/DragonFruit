import * as THREE from 'three';
import type { CandidatePoint } from './types';
import type { Vec3 } from '../types';
import {
    ANCHOR_HEIGHT_THRESHOLD_MM,
    MIN_TRUNK_SPACING_MM,
} from './constants';
import { getOrCreateSDFCache } from '../PlacementLogic/Pathfinding/SDFCachePool';
import { snapToGridIndex } from '../PlacementLogic/Grid/gridMath';

const DOUBLE_SIDED_SURFACE_MATERIAL = new THREE.MeshBasicMaterial({ side: THREE.DoubleSide });
const _raycaster = new THREE.Raycaster();
const _origin = new THREE.Vector3();
const _downDir = new THREE.Vector3(0, 0, -1);

/** Max vertical drop (mm) from a contact down to its cluster trunk's knot during clustering. */
const CLUSTER_MAX_BRANCH_RISE_MM = 10.5;
/** Minimum vertical rise (mm) required for a member to attach to a trunk shaft below it. */
const CLUSTER_MIN_RISE_MM = 0.4;
/** Contact-cone inset (mm) below a trunk's tip where its shaft topJoint actually ends. */
const CLUSTER_TOP_KNOT_INSET_MM = 2.5;
/** Max lateral plan reach (mm) for a 2-level angled Branch arm carrying an elevated upper cluster. */
export const TWO_LEVEL_BRANCH_REACH_MM = 8.0;

// ---------------------------------------------------------------------------
// Green-state photopolymer beam & buckling constants (SI: N, mm, MPa = N/mm²)
// ---------------------------------------------------------------------------
/** Young's modulus E_green (MPa) of green-state cured UV photopolymer resin. */
const GREEN_RESIN_MODULUS_MPA = 850;
/** Nominal single-support peel traction load F_tip (N) (~15 kPa nFEP × 10 mm²). */
const NOMINAL_TIP_PEEL_LOAD_N = 0.15;
/** Guided-cantilever lateral tip deflection limit δ_max (mm) (~2.8 × 50 µm layers). */
const MAX_TIP_DEFLECTION_MM = 0.14;
/** Factored axial compressive squeeze load SF·F_return (N) on vat Z-return. */
const BUCKLING_DESIGN_LOAD_N = 2.5;
/** Effective column length factor K_eff for a branch cantilevered off a trunk knot. */
const EULER_EFFECTIVE_LENGTH_FACTOR = 1.1;
/** Absolute upper ceiling (mm) on any unbraced branch regardless of shaft thickness. */
const MAX_UNBRACED_BRANCH_CEILING_MM = 14.5;

/**
 * Euler column buckling ceiling `L_buckle(d)` (mm) for an unbraced cylindrical
 * green-state photopolymer shaft of diameter `shaftDiameterMm`:
 *   P_cr = π² E I / (K L)² >= SF·F_return,  I = π d⁴ / 64
 *   => L_max(d) = (d² / K) * sqrt(π³ E / (64 · SF · F_return)).
 *
 * At `d = 1.0 mm` this yields `~11.6 mm` (blocking 18–20 mm unbraced rods off
 * low foot stubs); at `d = 0.8 mm` it tightens to `~7.5 mm`; at `d = 1.2 mm` it
 * scales up to `~14.5 mm` (capped).
 */
export function maxEulerBucklingSpanMm(shaftDiameterMm: number = 1.0): number {
    const d = Math.max(0.4, shaftDiameterMm);
    const coeff = Math.sqrt((Math.PI ** 3 * GREEN_RESIN_MODULUS_MPA) / (64 * BUCKLING_DESIGN_LOAD_N))
        / EULER_EFFECTIVE_LENGTH_FACTOR;
    return Math.min(MAX_UNBRACED_BRANCH_CEILING_MM, d * d * coeff);
}

/** Nominal `Ø1.0 mm` Euler buckling span ceiling (mm) for unbraced Branches/Leaves. */
export const MAX_UNBRACED_BRANCH_SPAN_MM = maxEulerBucklingSpanMm(1.0);
/**
 * Nominal `Ø1.0 mm` diagonal length ceiling (mm) for an auto-placed routed Trunk's
 * upper angled leg before Phase 3 rescue tries a tighter dogleg, branch, or bridge.
 */
export const MAX_ROUTED_TRUNK_DIAGONAL_SPAN_MM = 10.5;

/**
 * Maximum structurally stable lean from vertical (deg) for an unbraced angled
 * member of 3D length `spanMm` and diameter `shaftDiameterMm`, from guided-
 * cantilever Euler-Bernoulli deflection:
 *   δ = (F_tip · sin θ · L³) / (12 E I) <= δ_max,   I = π d⁴ / 64
 *   => sin θ_max(L, d) = (12 π E δ_max d⁴) / (64 F_tip L³).
 *
 * Short spans (`≤ 8.7 mm` at `Ø1.0 mm`) keep the full `baseMaxAngleDeg` (`45°`
 * organic, `30°` grid); longer spans steepen as `arcsin(K · d⁴ / L³)` so long
 * 45° sideways booms are physically disallowed while thicker shafts (`d⁴`) gain
 * proportional reach.
 */
export function maxStableAngleForSpanDeg(
    spanMm: number,
    baseMaxAngleDeg: number,
    shaftDiameterMm: number = 1.0,
): number {
    const L = Math.max(0.5, spanMm);
    const d = Math.max(0.4, shaftDiameterMm);
    const sinMax = (12 * Math.PI * GREEN_RESIN_MODULUS_MPA * MAX_TIP_DEFLECTION_MM * (d ** 4))
        / (64 * NOMINAL_TIP_PEEL_LOAD_N * (L ** 3));
    if (sinMax >= 1.0) return baseMaxAngleDeg;
    const beamAngleDeg = (Math.asin(Math.max(0, sinMax)) * 180) / Math.PI;
    return Math.min(baseMaxAngleDeg, beamAngleDeg);
}

/**
 * Minimum vertical rise (mm) for an angled segment of horizontal run `lateralMm`
 * to satisfy both Euler-Bernoulli deflection (`maxStableAngleForSpanDeg`) and
 * `maxSpanMm` (Euler buckling). Returns `null` when `lateralMm` cannot satisfy
 * both equations at any legal rise.
 */
export function minStableRiseForLateralMm(
    lateralMm: number,
    baseMaxAngleDeg: number,
    maxSpanMm: number,
    shaftDiameterMm: number = 1.0,
): number | null {
    if (lateralMm <= 1e-4) return CLUSTER_MIN_RISE_MM;
    if (lateralMm >= maxSpanMm) return null;
    const baseRad = (Math.max(5, Math.min(85, baseMaxAngleDeg)) * Math.PI) / 180;
    const minRise = Math.max(CLUSTER_MIN_RISE_MM, lateralMm / Math.tan(baseRad));
    // Under guided-cantilever Euler-Bernoulli bending, δ ∝ lateral·(lateral² + rise²)
    // increases monotonically with rise, so the minimum legal rise always has the
    // lowest deflection. Verify that `minRise` itself clears both buckling and bending.
    const span = Math.hypot(lateralMm, minRise);
    if (span > maxSpanMm + 1e-6) return null;
    const angle = (Math.atan2(lateralMm, minRise) * 180) / Math.PI;
    if (angle > maxStableAngleForSpanDeg(span, baseMaxAngleDeg, shaftDiameterMm) + 1e-6) {
        return null;
    }
    return minRise;
}
/** Min tip height (mm) where sparse solo trunks incur a flagpole penalty in favor of 2-level branch crowns. */
export const UPPER_CLUSTER_MIN_Z_MM = 18.0;
/** Max 3D radius (mm) for grouping sibling contacts into one 2-level branch crown. */
export const UPPER_CLUSTER_SIBLING_RADIUS_MM = 4.5;
/** Max sibling leaves grouped onto one 2-level branch crown. */
const UPPER_CLUSTER_MAX_SIBLINGS = 5;

export interface TreeSynthesisGridConfig {
    enabled: boolean;
    spacingMm: number;
}

export interface TreeSynthesisOptions {
    /** Max member angle from vertical (deg): 45° organic, or 90 - minBranchAngleDeg in grid mode. */
    maxAngleFromVerticalDeg: number;
    /** Max horizontal plan reach (mm) from a cluster trunk shaft to its attached members. */
    maxReachMm: number;
    /** Max combined branches + leaves per host trunk. */
    maxAttachmentsPerTrunk: number;
    /** Minimum XY spacing (mm) between cluster trunk roots in organic mode. */
    minTrunkSpacingMm?: number;
    /** Active branch/trunk shaft diameter (mm) for Euler-Bernoulli bending & buckling limits. */
    shaftDiameterMm?: number;
    /** Active grid settings; when enabled, cluster trunks occupy distinct grid nodes. */
    grid?: TreeSynthesisGridConfig;
    /** World-frame model mesh for fast vertical plate-reachability raycasts. */
    mesh?: THREE.Mesh;
}

export interface ClusteredMemberAssignment {
    candidate: CandidatePoint;
    /** ID of the preferred cluster anchor candidate selected as this member's host trunk. */
    preferredAnchorId: string;
}

/**
 * An elevated/occluded local cluster of contacts targeted by a single angled
 * 2-level Branch off a nearby trunk (`anchor`), with nearby `siblings` fanning
 * as slim 2nd-level Leaves off that branch's upper shaft.
 */
export interface UpperClusterGroup {
    /** Lowest / central contact that the primary angled Branch targets. */
    anchor: CandidatePoint;
    /** Close sibling contacts (`<= 4.5 mm`) fanned as 2nd-level Leaves off the Branch. */
    siblings: CandidatePoint[];
    /** Preferred host trunk anchor ID within `TWO_LEVEL_BRANCH_REACH_MM`. */
    preferredTrunkAnchorId: string;
}

export interface TreeClusterPlan {
    /** Near-plate (< ANCHOR_HEIGHT_THRESHOLD_MM) and interior cavity candidates placed first. */
    nearPlate: CandidatePoint[];
    /** Well-spaced plate-reachable cluster anchor candidates placed first as the trunk skeleton. */
    trunkAnchors: CandidatePoint[];
    /** Non-anchor candidates assigned to cluster trunks, placed after the trunk skeleton exists. */
    clusteredMembers: ClusteredMemberAssignment[];
    /** Elevated/occluded clusters routed via Pass 2c 2-level `Trunk -> Branch -> Leaf` crowns. */
    upperClusters: UpperClusterGroup[];
    /** Vertically occluded candidates with no cluster trunk in reach, routed via Phase 3 rescue. */
    occludedQueue: CandidatePoint[];
}

function deterministicCompare(a: CandidatePoint, b: CandidatePoint): number {
    return (
        b.priority - a.priority
        || a.tipPos.z - b.tipPos.z
        || a.tipPos.x - b.tipPos.x
        || a.tipPos.y - b.tipPos.y
        || a.id.localeCompare(b.id)
    );
}

/**
 * Batch vertical plate-reachability check for elevated candidates.
 * Casts one downward double-sided ray per candidate from just below `tipPos.z`
 * to just above the build plate (`z = 0.05`). Returns a boolean array aligned
 * with `candidates`.
 */
export function computePlateReachability(
    candidates: readonly CandidatePoint[],
    mesh?: THREE.Mesh,
): boolean[] {
    if (!mesh || candidates.length === 0) {
        return candidates.map(() => true);
    }

    const out = new Array<boolean>(candidates.length);
    const originalMaterial = mesh.material;
    mesh.material = DOUBLE_SIDED_SURFACE_MATERIAL;
    try {
        for (let i = 0; i < candidates.length; i++) {
            const p = candidates[i].tipPos;
            const startZ = p.z - 0.15;
            if (startZ <= 0.1) {
                out[i] = true;
                continue;
            }
            _origin.set(p.x, p.y, startZ);
            _raycaster.near = 0;
            _raycaster.far = startZ - 0.05;
            _raycaster.set(_origin, _downDir);
            const hits = _raycaster.intersectObject(mesh, false);
            out[i] = hits.length === 0;
        }
    } finally {
        mesh.material = originalMaterial;
    }
    return out;
}

/**
 * Whether a candidate XY root position violates minimum trunk spacing against
 * existing trunk roots (distinct grid node when grid is enabled, or radial
 * `minSpacingMm` in organic mode).
 */
export function isTooCloseToExistingTrunk(
    x: number,
    y: number,
    existingRoots: ReadonlyArray<{ x: number; y: number }>,
    minSpacingMm: number = MIN_TRUNK_SPACING_MM,
    grid?: TreeSynthesisGridConfig,
): boolean {
    if (existingRoots.length === 0) return false;
    if (grid?.enabled && grid.spacingMm > 0) {
        const gx = snapToGridIndex(x, grid.spacingMm);
        const gy = snapToGridIndex(y, grid.spacingMm);
        for (const r of existingRoots) {
            if (snapToGridIndex(r.x, grid.spacingMm) === gx && snapToGridIndex(r.y, grid.spacingMm) === gy) {
                return true;
            }
        }
        return false;
    }
    const minSq = minSpacingMm * minSpacingMm;
    for (const r of existingRoots) {
        const dx = x - r.x;
        const dy = y - r.y;
        if (dx * dx + dy * dy < minSq) return true;
    }
    return false;
}

/** Max 3D span (mm) for 1-level direct trunk coverage in Pass 2b (longer elevated clusters promote to 2-level Pass 2c crowns). */
const CLUSTER_1LEVEL_MAX_SPAN_MM = 8.0;

/**
 * Check whether `member` lies inside the legal downward-cone attachment envelope
 * of a vertical trunk anchored at `anchor`.
 */
function canAnchorCoverMember(
    anchor: CandidatePoint,
    member: CandidatePoint,
    maxReachSq: number,
    baseMaxAngleDeg: number,
    shaftDiameterMm: number = 1.0,
): boolean {
    const dx = member.tipPos.x - anchor.tipPos.x;
    const dy = member.tipPos.y - anchor.tipPos.y;
    const hDistSq = dx * dx + dy * dy;
    if (hDistSq > maxReachSq) return false;

    const hDist = Math.sqrt(hDistSq);
    const max1LevelSpan = Math.min(CLUSTER_1LEVEL_MAX_SPAN_MM, maxEulerBucklingSpanMm(shaftDiameterMm));
    const minRise = minStableRiseForLateralMm(hDist, baseMaxAngleDeg, max1LevelSpan, shaftDiameterMm);
    if (minRise === null) return false;
    // Knot sits on anchor's vertical shaft [0.5, anchor.z - tipLengthMm] and at least
    // `minRise` below the member's tip.
    const maxKnotZ = Math.min(anchor.tipPos.z - CLUSTER_TOP_KNOT_INSET_MM, member.tipPos.z - minRise);
    if (maxKnotZ < 0.5) return false;
    const actualRise = member.tipPos.z - maxKnotZ;
    if (actualRise > CLUSTER_MAX_BRANCH_RISE_MM) return false;
    const span = Math.hypot(hDist, actualRise);
    if (span > max1LevelSpan) return false;
    const angleDeg = (Math.atan2(hDist, actualRise) * 180) / Math.PI;
    return angleDeg <= maxStableAngleForSpanDeg(span, baseMaxAngleDeg, shaftDiameterMm) + 1e-6;
}

/**
 * Phase 2: Cluster-First Tree Synthesis.
 *
 * Partitions candidates into near-plate/interior points vs. elevated contacts,
 * identifies vertically plate-clear contacts, and runs a deterministic greedy
 * downward-cone set cover to choose a sparse, well-spaced (`>= minTrunkSpacingMm`
 * or distinct grid nodes) skeleton of trunk anchors BEFORE any shafts are built.
 * Remaining contacts are assigned to their covering anchor (up to
 * `maxAttachmentsPerTrunk`) or routed to the Phase 3 occluded rescue queue.
 */
export function synthesizeTreeClusters(
    candidates: readonly CandidatePoint[],
    options: TreeSynthesisOptions,
): TreeClusterPlan {
    const nearPlate: CandidatePoint[] = [];
    const elevated: CandidatePoint[] = [];

    for (const c of candidates) {
        if (c.interior || c.tipPos.z < ANCHOR_HEIGHT_THRESHOLD_MM) {
            nearPlate.push(c);
        } else {
            elevated.push(c);
        }
    }

    if (elevated.length === 0) {
        return { nearPlate, trunkAnchors: [], clusteredMembers: [], upperClusters: [], occludedQueue: [] };
    }

    const plateClear = computePlateReachability(elevated, options.mesh);
    const baseMaxAngleDeg = Math.max(5, Math.min(85, options.maxAngleFromVerticalDeg));
    const shaftDiaMm = Math.max(0.4, options.shaftDiameterMm ?? 1.0);
    const maxBranchSpanMm = maxEulerBucklingSpanMm(shaftDiaMm);
    const maxReachMm = Math.max(1.0, options.maxReachMm);
    const maxReachSq = maxReachMm * maxReachMm;
    const minTrunkSpacingMm = options.minTrunkSpacingMm ?? MIN_TRUNK_SPACING_MM;
    const maxAttachments = Math.max(1, options.maxAttachmentsPerTrunk);

    // Spatial bucket over elevated candidates for fast O(N·k) cone coverage queries.
    const cellSize = Math.max(1.0, maxReachMm);
    const cellKey2D = (cx: number, cy: number) => (cx + 0x8000) * 0x10000 + (cy + 0x8000);
    const buckets = new Map<number, number[]>();
    let maxZ = 1;
    for (let i = 0; i < elevated.length; i++) {
        const p = elevated[i].tipPos;
        if (p.z > maxZ) maxZ = p.z;
        const key = cellKey2D(Math.floor(p.x / cellSize), Math.floor(p.y / cellSize));
        const list = buckets.get(key);
        if (list) list.push(i);
        else buckets.set(key, [i]);
    }

    // Precompute downward-cone neighbor lists for every plate-clear candidate.
    const coneNeighbors: number[][] = new Array(elevated.length);
    for (let i = 0; i < elevated.length; i++) {
        if (!plateClear[i]) {
            coneNeighbors[i] = [];
            continue;
        }
        const a = elevated[i];
        const cx = Math.floor(a.tipPos.x / cellSize);
        const cy = Math.floor(a.tipPos.y / cellSize);
        const neighbors: number[] = [];
        for (let dx = -1; dx <= 1; dx++) {
            for (let dy = -1; dy <= 1; dy++) {
                const list = buckets.get(cellKey2D(cx + dx, cy + dy));
                if (!list) continue;
                for (const j of list) {
                    if (j === i) continue;
                    if (canAnchorCoverMember(a, elevated[j], maxReachSq, baseMaxAngleDeg, shaftDiaMm)) {
                        neighbors.push(j);
                    }
                }
            }
        }
        // Prefer closest neighbors first when capping at maxAttachmentsPerTrunk.
        neighbors.sort((ia, ib) => {
            const pa = elevated[ia].tipPos;
            const pb = elevated[ib].tipPos;
            const da = (pa.x - a.tipPos.x) ** 2 + (pa.y - a.tipPos.y) ** 2;
            const db = (pb.x - a.tipPos.x) ** 2 + (pb.y - a.tipPos.y) ** 2;
            return da - db || deterministicCompare(elevated[ia], elevated[ib]);
        });
        coneNeighbors[i] = neighbors;
    }

    const assigned = new Uint8Array(elevated.length);
    const chosenAnchorIndices: number[] = [];
    const chosenAnchorRoots: Array<{ x: number; y: number }> = [];
    const anchorAttachmentCounts = new Map<number, number>();
    const clusteredMembers: ClusteredMemberAssignment[] = [];

    const twoLevelReachSq = TWO_LEVEL_BRANCH_REACH_MM * TWO_LEVEL_BRANCH_REACH_MM;
    const siblingRadiusSq = UPPER_CLUSTER_SIBLING_RADIUS_MM * UPPER_CLUSTER_SIBLING_RADIUS_MM;
    const gridOn = Boolean(options.grid?.enabled);

    /**
     * Find the nearest already-chosen trunk anchor within `TWO_LEVEL_BRANCH_REACH_MM`
     * that can legally climb to `target` within the cantilever stability envelope
     * (`MAX_UNBRACED_BRANCH_SPAN_MM`, `maxStableAngleForSpanDeg`) with capacity headroom.
     */
    const findTwoLevelHostTrunk = (target: CandidatePoint): number => {
        let bestAi = -1;
        let bestSpanSq = Infinity;
        for (const ai of chosenAnchorIndices) {
            const count = anchorAttachmentCounts.get(ai) ?? 0;
            if (count >= maxAttachments) continue;
            const host = elevated[ai];
            const dx = target.tipPos.x - host.tipPos.x;
            const dy = target.tipPos.y - host.tipPos.y;
            const hDistSq = dx * dx + dy * dy;
            if (hDistSq > twoLevelReachSq) continue;
            const hDist = Math.sqrt(hDistSq);
            const minRise = minStableRiseForLateralMm(hDist, baseMaxAngleDeg, maxBranchSpanMm, shaftDiaMm);
            if (minRise === null) continue;
            // Branch knot sits on host's shaft [1.0, host.z - tipLengthMm] and at least `minRise` below target.
            const maxKnotZ = Math.min(host.tipPos.z - CLUSTER_TOP_KNOT_INSET_MM, target.tipPos.z - minRise);
            if (maxKnotZ < 1.0) continue;
            const actualRise = target.tipPos.z - maxKnotZ;
            if (actualRise > Math.min(CLUSTER_MAX_BRANCH_RISE_MM, maxBranchSpanMm)) continue;
            const spanSq = hDistSq + actualRise * actualRise;
            const span = Math.sqrt(spanSq);
            if (span > maxBranchSpanMm) continue;
            const angleDeg = (Math.atan2(hDist, actualRise) * 180) / Math.PI;
            if (angleDeg > maxStableAngleForSpanDeg(span, baseMaxAngleDeg, shaftDiaMm) + 1e-6) continue;
            if (spanSq < bestSpanSq) {
                bestSpanSq = spanSq;
                bestAi = ai;
            }
        }
        return bestAi;
    };

    const deferredFlagpoles: number[] = [];

    // Greedy downward-cone set cover: pick well-spaced plate-clear anchors that
    // cover the most unassigned contacts first. In organic mode, tall sparse
    // candidates (`Z >= UPPER_CLUSTER_MIN_Z_MM`, covering <= 2 neighbors) that
    // sit within 2-level branch reach of an existing trunk are penalized and
    // deferred to Pass 2c (`upperClusters`) instead of planting parallel front flagpoles.
    while (true) {
        let bestIdx = -1;
        let bestScore = -1;
        let bestCover: number[] = [];

        for (let i = 0; i < elevated.length; i++) {
            if (!plateClear[i] || assigned[i]) continue;
            const a = elevated[i];
            if (isTooCloseToExistingTrunk(a.tipPos.x, a.tipPos.y, chosenAnchorRoots, minTrunkSpacingMm, options.grid)) {
                continue;
            }
            const cover: number[] = [];
            for (const j of coneNeighbors[i]) {
                if (!assigned[j]) {
                    cover.push(j);
                    if (cover.length >= maxAttachments) break;
                }
            }
            // Prefer anchors that carry more neighbors, primary discrete contacts
            // (voxel/minima/intersection), and lower-Z leading edges (which print
            // first and let upper contacts on slopes branch cleanly up-and-out
            // underneath the ceiling without colliding with the mesh).
            const discreteBonus = a.source !== 'overhang' ? 3.0 : 0.0;
            const lowZBonus = (1 - a.tipPos.z / maxZ) * 1.5;
            // Tall sparse candidates incur a flagpole penalty ONLY when an
            // already-chosen trunk sits within 2-level branch reach so primary
            // discrete islands still beat overhangs when choosing initial trunks.
            const hasTwoLevelHost = !gridOn
                && a.tipPos.z >= UPPER_CLUSTER_MIN_Z_MM
                && cover.length <= 2
                && (findTwoLevelHostTrunk(a) >= 0 || cover.some((j) => findTwoLevelHostTrunk(elevated[j]) >= 0));
            const flagpolePenalty = hasTwoLevelHost ? 4.0 : 0.0;
            const score = cover.length * 10.0 + discreteBonus + lowZBonus + a.priority - flagpolePenalty;

            if (
                score > bestScore + 1e-9
                || (Math.abs(score - bestScore) <= 1e-9 && bestIdx >= 0 && deterministicCompare(a, elevated[bestIdx]) < 0)
            ) {
                bestScore = score;
                bestIdx = i;
                bestCover = cover;
            }
        }

        if (bestIdx < 0) break;

        // Before planting a tall sparse solo flagpole in organic mode, check if
        // an existing trunk within `TWO_LEVEL_BRANCH_REACH_MM` can legally carry
        // the cluster via a 2-level branch crown in Pass 2c. Check both `chosen`
        // and its covered neighbors so an outer sibling does not plant a flagpole
        // when its lower/inner neighbor can host the branch arm off an existing trunk.
        const chosen = elevated[bestIdx];
        if (!gridOn && chosen.tipPos.z >= UPPER_CLUSTER_MIN_Z_MM && bestCover.length <= 2) {
            const groupIndices = [bestIdx, ...bestCover];
            let deferAnchorIdx = -1;
            let deferAnchorZ = Infinity;
            for (const k of groupIndices) {
                if (findTwoLevelHostTrunk(elevated[k]) >= 0 && elevated[k].tipPos.z < deferAnchorZ) {
                    deferAnchorZ = elevated[k].tipPos.z;
                    deferAnchorIdx = k;
                }
            }
            if (deferAnchorIdx >= 0) {
                const deferAnchor = elevated[deferAnchorIdx];
                assigned[deferAnchorIdx] = 1;
                deferredFlagpoles.push(deferAnchorIdx);
                for (const j of groupIndices) {
                    if (j === deferAnchorIdx) continue;
                    const sib = elevated[j];
                    const d2 = (sib.tipPos.x - deferAnchor.tipPos.x) ** 2
                        + (sib.tipPos.y - deferAnchor.tipPos.y) ** 2
                        + (sib.tipPos.z - deferAnchor.tipPos.z) ** 2;
                    if (d2 <= siblingRadiusSq) {
                        assigned[j] = 1;
                        deferredFlagpoles.push(j);
                    }
                }
                continue;
            }
        }

        assigned[bestIdx] = 1;
        chosenAnchorIndices.push(bestIdx);
        chosenAnchorRoots.push({ x: chosen.tipPos.x, y: chosen.tipPos.y });
        anchorAttachmentCounts.set(bestIdx, bestCover.length);

        const anchorId = chosen.id;
        for (const j of bestCover) {
            assigned[j] = 1;
            clusteredMembers.push({ candidate: elevated[j], preferredAnchorId: anchorId });
        }
    }

    // Any remaining unassigned candidates:
    // - If a chosen anchor sits nearby within maxReachMm (e.g., skipped because
    //   the candidate was < minTrunkSpacingMm from an anchor), assign as a
    //   clustered member of the nearest chosen anchor with headroom.
    // - Otherwise, occluded candidates go to `rawOccluded` (where elevated
    //   clusters near a trunk can still promote into Pass 2c 2-level crowns
    //   before Phase 3 rescue).
    const rawOccludedIndices: number[] = [];
    for (let i = 0; i < elevated.length; i++) {
        if (assigned[i]) continue;
        const c = elevated[i];
        let bestAnchorIdx = -1;
        let bestDistSq = Infinity;
        for (const ai of chosenAnchorIndices) {
            const count = anchorAttachmentCounts.get(ai) ?? 0;
            if (count >= maxAttachments) continue;
            if (!canAnchorCoverMember(elevated[ai], c, maxReachSq, baseMaxAngleDeg, shaftDiaMm)) continue;
            const dx = c.tipPos.x - elevated[ai].tipPos.x;
            const dy = c.tipPos.y - elevated[ai].tipPos.y;
            const d2 = dx * dx + dy * dy;
            if (d2 < bestDistSq) {
                bestDistSq = d2;
                bestAnchorIdx = ai;
            }
        }
        if (bestAnchorIdx >= 0) {
            assigned[i] = 1;
            anchorAttachmentCounts.set(bestAnchorIdx, (anchorAttachmentCounts.get(bestAnchorIdx) ?? 0) + 1);
            clusteredMembers.push({ candidate: c, preferredAnchorId: elevated[bestAnchorIdx].id });
        } else if (!plateClear[i]) {
            rawOccludedIndices.push(i);
        } else {
            let nearestIdx = -1;
            let nearestD2 = Infinity;
            for (const ai of chosenAnchorIndices) {
                const dx = c.tipPos.x - elevated[ai].tipPos.x;
                const dy = c.tipPos.y - elevated[ai].tipPos.y;
                const d2 = dx * dx + dy * dy;
                if (d2 < nearestD2) {
                    nearestD2 = d2;
                    nearestIdx = ai;
                }
            }
            if (nearestIdx >= 0) {
                clusteredMembers.push({ candidate: c, preferredAnchorId: elevated[nearestIdx].id });
            } else {
                rawOccludedIndices.push(i);
            }
        }
    }

    // Group deferred tall-sparse flagpoles and elevated occluded contacts near
    // a trunk into Pass 2c 2-level `Trunk -> Branch -> Leaf` crown groups.
    const upperClusters: UpperClusterGroup[] = [];
    const occludedQueue: CandidatePoint[] = [];

    const crownAnchors = [
        ...deferredFlagpoles,
        ...rawOccludedIndices.filter((i) => !gridOn && elevated[i].tipPos.z >= 12.0 && findTwoLevelHostTrunk(elevated[i]) >= 0),
    ];
    // Siblings only need to sit within `UPPER_CLUSTER_SIBLING_RADIUS_MM` of a valid
    // 2-level branch anchor — they fan as 2nd-level Leaves off that Branch's upper shaft,
    // so they do NOT need to reach the parent Trunk directly.
    const siblingCandidates = [
        ...deferredFlagpoles,
        ...rawOccludedIndices.filter((i) => !gridOn && elevated[i].tipPos.z >= 12.0),
    ];
    // Sort lowest-Z first so the primary angled branch lands on the lowest
    // contact in each local crown and sibling leaves fan upward off its shaft.
    crownAnchors.sort((ia, ib) => elevated[ia].tipPos.z - elevated[ib].tipPos.z || deterministicCompare(elevated[ia], elevated[ib]));
    const consumedInCrown = new Set<number>();

    for (const anchorIdx of crownAnchors) {
        if (consumedInCrown.has(anchorIdx)) continue;
        const anchor = elevated[anchorIdx];
        const hostAi = findTwoLevelHostTrunk(anchor);
        if (hostAi < 0) {
            occludedQueue.push(anchor);
            consumedInCrown.add(anchorIdx);
            continue;
        }
        consumedInCrown.add(anchorIdx);
        const siblings: CandidatePoint[] = [];
        for (const otherIdx of siblingCandidates) {
            if (consumedInCrown.has(otherIdx)) continue;
            if (siblings.length >= UPPER_CLUSTER_MAX_SIBLINGS) break;
            const other = elevated[otherIdx];
            const dx = other.tipPos.x - anchor.tipPos.x;
            const dy = other.tipPos.y - anchor.tipPos.y;
            const dz = other.tipPos.z - anchor.tipPos.z;
            if (dz < -0.5) continue;
            if (dx * dx + dy * dy + dz * dz <= siblingRadiusSq) {
                consumedInCrown.add(otherIdx);
                siblings.push(other);
            }
        }
        anchorAttachmentCounts.set(hostAi, (anchorAttachmentCounts.get(hostAi) ?? 0) + 1);
        upperClusters.push({
            anchor,
            siblings,
            preferredTrunkAnchorId: elevated[hostAi].id,
        });
    }

    for (const i of rawOccludedIndices) {
        if (!consumedInCrown.has(i)) {
            occludedQueue.push(elevated[i]);
        }
    }

    const trunkAnchors = chosenAnchorIndices
        .map((i) => elevated[i])
        .sort(deterministicCompare);
    clusteredMembers.sort((a, b) => deterministicCompare(a.candidate, b.candidate));
    upperClusters.sort((a, b) => deterministicCompare(a.anchor, b.anchor));
    occludedQueue.sort(deterministicCompare);

    return { nearPlate, trunkAnchors, clusteredMembers, upperClusters, occludedQueue };
}

export interface SilhouetteEscapeRoute {
    basePos: Vec3;
    bendJoint: Vec3;
}

/**
 * Phase 3 Tier-2 Rescue: find a collision-free 2-segment dogleg trunk route
 * from the build plate around an obstructing lower mesh up to `socketPos`.
 *
 * Samples 8 azimuths × 3 tight radial offsets (`2.5, 4.0, 5.5 mm`), checks SDF
 * clearance along both the vertical riser and angled upper segment, respects
 * minimum trunk spacing / grid alignment, and picks the clear route closest to
 * existing trunks at the smallest clearing radius so doglegs tuck compactly for bracing.
 */
export function findOffsetSilhouetteRoute(
    socketPos: Vec3,
    mesh: THREE.Mesh,
    shaftRadiusMm: number,
    maxAngleFromVerticalDeg: number,
    existingRoots: ReadonlyArray<{ x: number; y: number }>,
    grid?: TreeSynthesisGridConfig,
    minTrunkSpacingMm: number = MIN_TRUNK_SPACING_MM,
): SilhouetteEscapeRoute | null {
    if (socketPos.z < 3.5) return null;

    const sdf = getOrCreateSDFCache(mesh);
    const baseMaxAngleDeg = Math.max(5, Math.min(80, maxAngleFromVerticalDeg));
    const shaftDiaMm = Math.max(0.4, shaftRadiusMm * 2);
    const maxDoglegSpanMm = Math.min(MAX_ROUTED_TRUNK_DIAGONAL_SPAN_MM, maxEulerBucklingSpanMm(shaftDiaMm));
    const clearanceMm = Math.max(0.25, shaftRadiusMm + 0.15);

    const isSegmentClear = (a: Vec3, b: Vec3, skipEndFraction = 0): boolean => {
        const dx = b.x - a.x;
        const dy = b.y - a.y;
        const dz = b.z - a.z;
        const len = Math.hypot(dx, dy, dz);
        if (len < 1e-4) return true;
        const steps = Math.max(4, Math.ceil(len / 0.75));
        const maxStep = Math.max(1, Math.floor(steps * (1 - skipEndFraction)));
        for (let s = 1; s <= maxStep; s++) {
            const t = s / steps;
            const d = sdf.exactSignedDistanceAt(a.x + dx * t, a.y + dy * t, a.z + dz * t);
            if (d < clearanceMm) return false;
        }
        return true;
    };

    const nearestRootDistSq = (rx: number, ry: number): number => {
        if (existingRoots.length === 0) return 0;
        let best = Infinity;
        for (const r of existingRoots) {
            const dx = rx - r.x;
            const dy = ry - r.y;
            const d2 = dx * dx + dy * dy;
            if (d2 < best) best = d2;
        }
        return best;
    };

    const radii = [2.5, 4.0, 5.0];
    const azimuthCount = 8;

    for (const radius of radii) {
        const nominalRise = minStableRiseForLateralMm(radius, baseMaxAngleDeg, maxDoglegSpanMm, shaftDiaMm);
        if (nominalRise === null) continue;
        const bendZ = socketPos.z - Math.max(1.0, nominalRise);
        if (bendZ < 1.8) continue;

        let bestRoute: SilhouetteEscapeRoute | null = null;
        let bestTuckScore = Infinity;

        for (let ai = 0; ai < azimuthCount; ai++) {
            const angle = (ai / azimuthCount) * Math.PI * 2;
            let rx = socketPos.x + Math.cos(angle) * radius;
            let ry = socketPos.y + Math.sin(angle) * radius;
            if (grid?.enabled && grid.spacingMm > 0) {
                rx = snapToGridIndex(rx, grid.spacingMm) * grid.spacingMm;
                ry = snapToGridIndex(ry, grid.spacingMm) * grid.spacingMm;
            }
            const actualH = Math.hypot(socketPos.x - rx, socketPos.y - ry);
            if (actualH < 1.5 || actualH > 5.5) continue;
            const actualMinRise = minStableRiseForLateralMm(actualH, baseMaxAngleDeg, maxDoglegSpanMm, shaftDiaMm);
            if (actualMinRise === null) continue;
            const actualBendZ = socketPos.z - Math.max(1.0, actualMinRise);
            if (actualBendZ < 1.8 || actualBendZ >= socketPos.z - 0.5) continue;

            if (isTooCloseToExistingTrunk(rx, ry, existingRoots, minTrunkSpacingMm, grid)) {
                continue;
            }

            const baseTop: Vec3 = { x: rx, y: ry, z: 0.8 };
            const bendJoint: Vec3 = { x: rx, y: ry, z: actualBendZ };
            // Both vertical riser and upper angled leg must clear the model SDF.
            if (!isSegmentClear(baseTop, bendJoint, 0)) continue;
            if (!isSegmentClear(bendJoint, socketPos, 0.04)) continue;

            // Prefer tucking near an existing trunk group (compact bracing, low visual footprint).
            const tuckScore = actualH * 2.0 + Math.sqrt(nearestRootDistSq(rx, ry));
            if (tuckScore < bestTuckScore) {
                bestTuckScore = tuckScore;
                bestRoute = {
                    basePos: { x: rx, y: ry, z: 0 },
                    bendJoint,
                };
            }
        }

        if (bestRoute) return bestRoute;
    }

    return null;
}
