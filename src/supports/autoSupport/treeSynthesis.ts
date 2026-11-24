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
const CLUSTER_MAX_BRANCH_RISE_MM = 14.0;
/** Minimum vertical rise (mm) required for a member to attach to a trunk shaft below it. */
const CLUSTER_MIN_RISE_MM = 0.4;

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

export interface TreeClusterPlan {
    /** Near-plate (< ANCHOR_HEIGHT_THRESHOLD_MM) and interior cavity candidates placed first. */
    nearPlate: CandidatePoint[];
    /** Well-spaced plate-reachable cluster anchor candidates placed first as the trunk skeleton. */
    trunkAnchors: CandidatePoint[];
    /** Non-anchor candidates assigned to cluster trunks, placed after the trunk skeleton exists. */
    clusteredMembers: ClusteredMemberAssignment[];
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

/**
 * Check whether `member` lies inside the legal downward-cone attachment envelope
 * of a vertical trunk anchored at `anchor`.
 */
function canAnchorCoverMember(
    anchor: CandidatePoint,
    member: CandidatePoint,
    maxReachSq: number,
    invTanMaxAngle: number,
): boolean {
    const dx = member.tipPos.x - anchor.tipPos.x;
    const dy = member.tipPos.y - anchor.tipPos.y;
    const hDistSq = dx * dx + dy * dy;
    if (hDistSq > maxReachSq) return false;

    const hDist = Math.sqrt(hDistSq);
    const minRise = Math.max(CLUSTER_MIN_RISE_MM, hDist * invTanMaxAngle);
    // Knot sits on anchor's vertical shaft [0.5, anchor.z - 0.4] and at least
    // `minRise` below the member's tip.
    const maxKnotZ = Math.min(anchor.tipPos.z - CLUSTER_MIN_RISE_MM, member.tipPos.z - minRise);
    if (maxKnotZ < 0.5) return false;
    const actualRise = member.tipPos.z - maxKnotZ;
    return actualRise <= CLUSTER_MAX_BRANCH_RISE_MM;
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
        return { nearPlate, trunkAnchors: [], clusteredMembers: [], occludedQueue: [] };
    }

    const plateClear = computePlateReachability(elevated, options.mesh);
    const maxAngleRad = (Math.max(5, Math.min(85, options.maxAngleFromVerticalDeg)) * Math.PI) / 180;
    const invTanMaxAngle = 1 / Math.tan(maxAngleRad);
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
                    if (canAnchorCoverMember(a, elevated[j], maxReachSq, invTanMaxAngle)) {
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

    // Greedy downward-cone set cover: pick well-spaced plate-clear anchors that
    // cover the most unassigned contacts first.
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
            const score = cover.length * 10.0 + discreteBonus + lowZBonus + a.priority;

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

        assigned[bestIdx] = 1;
        chosenAnchorIndices.push(bestIdx);
        chosenAnchorRoots.push({ x: elevated[bestIdx].tipPos.x, y: elevated[bestIdx].tipPos.y });
        anchorAttachmentCounts.set(bestIdx, bestCover.length);

        const anchorId = elevated[bestIdx].id;
        for (const j of bestCover) {
            assigned[j] = 1;
            clusteredMembers.push({ candidate: elevated[j], preferredAnchorId: anchorId });
        }
    }

    // Any remaining unassigned candidates:
    // - If a chosen anchor sits nearby within maxReachMm (e.g., skipped because
    //   the candidate was < minTrunkSpacingMm from an anchor), assign as a
    //   clustered member of the nearest chosen anchor with headroom.
    // - Otherwise, occluded candidates go to Phase 3 `occludedQueue`, and
    //   isolated plate-clear candidates that didn't violate spacing already
    //   became anchors above; any remaining plate-clear candidate within
    //   spacing goes into `clusteredMembers` (or `occludedQueue` if no anchor
    //   can cover it legally).
    const occludedQueue: CandidatePoint[] = [];
    for (let i = 0; i < elevated.length; i++) {
        if (assigned[i]) continue;
        const c = elevated[i];
        let bestAnchorIdx = -1;
        let bestDistSq = Infinity;
        for (const ai of chosenAnchorIndices) {
            const count = anchorAttachmentCounts.get(ai) ?? 0;
            if (count >= maxAttachments) continue;
            if (!canAnchorCoverMember(elevated[ai], c, maxReachSq, invTanMaxAngle)) continue;
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
            occludedQueue.push(c);
        } else {
            // Plate-clear contact that was < minTrunkSpacingMm from an anchor
            // whose height/cone couldn't reach it (e.g. slightly higher tip
            // right beside an anchor) — attach/place via clustered pass so it
            // merges onto the full skeleton or stands if needed.
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
                occludedQueue.push(c);
            }
        }
    }

    const trunkAnchors = chosenAnchorIndices
        .map((i) => elevated[i])
        .sort(deterministicCompare);
    clusteredMembers.sort((a, b) => deterministicCompare(a.candidate, b.candidate));
    occludedQueue.sort(deterministicCompare);

    return { nearPlate, trunkAnchors, clusteredMembers, occludedQueue };
}

export interface SilhouetteEscapeRoute {
    basePos: Vec3;
    bendJoint: Vec3;
}

/**
 * Phase 3 Tier-2 Rescue: find a collision-free 2-segment dogleg trunk route
 * from the build plate around an obstructing lower mesh up to `socketPos`.
 *
 * Samples 8 azimuths × 3 radial offsets (`2.5, 4.0, 5.5 mm`), checks SDF
 * clearance along both the vertical riser and angled upper segment, and
 * respects minimum trunk spacing / grid alignment.
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
    const maxAngleRad = (Math.max(5, Math.min(80, maxAngleFromVerticalDeg)) * Math.PI) / 180;
    const invTan = 1 / Math.tan(maxAngleRad);
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

    const radii = [2.5, 4.0, 5.5];
    const azimuthCount = 8;

    for (const radius of radii) {
        const minRise = radius * invTan;
        const bendZ = socketPos.z - Math.max(1.0, minRise);
        if (bendZ < 1.8) continue;

        for (let ai = 0; ai < azimuthCount; ai++) {
            const angle = (ai / azimuthCount) * Math.PI * 2;
            let rx = socketPos.x + Math.cos(angle) * radius;
            let ry = socketPos.y + Math.sin(angle) * radius;
            if (grid?.enabled && grid.spacingMm > 0) {
                rx = snapToGridIndex(rx, grid.spacingMm) * grid.spacingMm;
                ry = snapToGridIndex(ry, grid.spacingMm) * grid.spacingMm;
            }
            const actualH = Math.hypot(socketPos.x - rx, socketPos.y - ry);
            if (actualH < 1.5 || actualH > 8.0) continue;
            const actualBendZ = socketPos.z - Math.max(1.0, actualH * invTan);
            if (actualBendZ < 1.8 || actualBendZ >= socketPos.z - 0.5) continue;

            if (isTooCloseToExistingTrunk(rx, ry, existingRoots, minTrunkSpacingMm, grid)) {
                continue;
            }

            const baseTop: Vec3 = { x: rx, y: ry, z: 0.8 };
            const bendJoint: Vec3 = { x: rx, y: ry, z: actualBendZ };
            // Both vertical riser and upper angled leg must clear the model SDF.
            if (!isSegmentClear(baseTop, bendJoint, 0)) continue;
            if (!isSegmentClear(bendJoint, socketPos, 0.04)) continue;

            return {
                basePos: { x: rx, y: ry, z: 0 },
                bendJoint,
            };
        }
    }

    return null;
}
