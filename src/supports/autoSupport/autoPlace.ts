import { footprintX, footprintY } from '@/volumeAnalysis/Islands/voxelFootprint';
import * as THREE from 'three';
import { quantizeToScale } from '@/utils/math';

/**
 * Diagnostics are reported to 2dp. `quantizeToScale` is the shared form of the
 * `Math.round(v * 100) / 100` this file used to define locally, so the numbers
 * are unchanged. Note it is NOT interchangeable with `round(v, 2)` from the same
 * module: that rounds the decimal representation and the two disagree on values
 * that land exactly halfway, which authored 0.001-grid dimensions often do.
 */
const round2Mm = (v: number): number => quantizeToScale(v, 100);
import type { ContactCone } from '../SupportPrimitives/ContactCone/types';
import type { CandidatePoint, AutoPlaceResult, AutoPlaceAnalytics, RejectReason, AutoSupportPlan, PlacementDiagnostics, FanLeafRefusal, ForestLedgerEntry, ForestReport, ForestTree, OrphanInfo } from './types';
import type { SupportState, SupportOrigin } from '../types';
import type { AutoSupportSettings } from './settings';
import { normalizeAutoSupportSettings } from './settings';
import { activeSizingBand } from './parameterSizing';
import { generateCandidates, deduplicateCandidates } from './candidateGeneration';
import { generateGridCandidates } from './gridPlacement';
import {
    MAX_GAP_FILL_PASSES,
    buildGapFillCandidates,
    collectSupportTips,
    computeRegionCoverage,
} from './coverage';
import { sizeParameters, presetForArea, ANCHOR_SHAFT_MULTIPLIER, type SizingPreset } from './parameterSizing';
import type { ModelSizingContext } from './parameterSizing';
import { getSettings } from '../Settings/state';
import { getSnapshot, setSnapshot } from '../state';
import {
    draftAddRoot, draftAddTrunk, draftAddBranch, draftAddLeaf,
    draftAddKnot, draftAddAnchor, draftAddStick, draftAddTwig,
} from './supportDraft';
import type { DetectedIsland } from '../../volumeAnalysis/Islands/types';
import { buildTrunkData } from '../SupportTypes/Trunk/trunkBuilder';
import { buildCavityStick } from '../SupportTypes/Trunk/useTrunkPlacement';
import { applyTrunkReplacement, planTrunkReplacement } from '../SupportTypes/Trunk/TrunkReplacement';
import { computeForestDiameterProfile } from '../SupportTypes/Trunk/TrunkReplacement/maxConnectedDiameter';
import { buildBranchData } from '../SupportTypes/Branch/branchBuilder';
import { buildLeafData } from '../SupportTypes/Leaf/leafBuilder';
import { decideGridPlacement } from '../PlacementLogic/Grid/gridPlacement';
import { calculateSmoothedNormal } from '../PlacementLogic/PlacementUtils';
import { isShaftBlocked } from '../PlacementLogic/CollisionAvoidance';
import { buildAutoBracedSnapshot } from '../autoBracing/autoBrace';
import { pushSupportHistory } from '../history/supportHistory';
import { SUPPORT_AUTO_PLACE } from '../history/actionTypes';
import { getKickstandSnapshot, setKickstandSnapshot } from '../SupportTypes/Kickstand/kickstandStore';
import type { KickstandState } from '../SupportTypes/Kickstand/types';
import { getModelMesh } from './meshStore';
import {
    ALREADY_SUPPORTED_RADIUS_MM,
    GRIDLESS_MERGE_RADIUS_MM,
    LEAF_FAN_RADIUS_MM,
    GRID_HOST_FAN_RADIUS_MM,
    LEAF_FAN_MAX_ANGLE_DEG,
} from './constants';

const LOG_PREFIX = '[AutoSupport]';

// Per-entity placement logging (Trunk/Leaf/Merge lines) is OFF by default —
// the Forest Report at the end of each run replaces the per-support spam.
// Re-enable via setAutoSupportVerboseLogging(true) for debugging.
let verboseLogging = false;

export function setAutoSupportVerboseLogging(enabled: boolean): void {
    verboseLogging = enabled;
}

function logPlacement(message: string): void {
    if (verboseLogging) console.log(LOG_PREFIX, message);
}


// ---------------------------------------------------------------------------
// Mesh volume helper
// ---------------------------------------------------------------------------

/**
 * Exact volume (mm³) of a closed mesh via the signed tetrahedron sum around
 * the origin. Used for physics-informed sizing — replaces the bounding-box
 * volume, which wildly overestimates non-cubic models.
 */
function computeMeshVolumeMm3(mesh: THREE.Mesh): number {
    const geo = mesh.geometry;
    const pos = geo.getAttribute('position') as THREE.BufferAttribute | undefined;
    if (!pos) return 0;
    const index = geo.index;
    let vol = 0;
    const addTri = (i0: number, i1: number, i2: number) => {
        const ax = pos.getX(i0), ay = pos.getY(i0), az = pos.getZ(i0);
        const bx = pos.getX(i1), by = pos.getY(i1), bz = pos.getZ(i1);
        const cx = pos.getX(i2), cy = pos.getY(i2), cz = pos.getZ(i2);
        vol += (ax * (by * cz - bz * cy) - ay * (bx * cz - bz * cx) + az * (bx * cy - by * cx)) / 6;
    };
    if (index) {
        for (let i = 0; i < index.count; i += 3) addTri(index.getX(i), index.getX(i + 1), index.getX(i + 2));
    } else {
        for (let i = 0; i < pos.count; i += 3) addTri(i, i + 1, i + 2);
    }
    return Math.abs(vol);
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeResult(
    trunks: number,
    anchors: number,
    branches: number,
    leaves: number,
    sticks: number,
    rejected: number,
    changed: boolean,
    message: string,
): AutoPlaceResult {
    return {
        placedTrunks: trunks,
        placedAnchors: anchors,
        placedBranches: branches,
        placedLeaves: leaves,
        placedSticks: sticks,
        rejectedCandidates: rejected,
        changed,
        message,
    };
}

// ---------------------------------------------------------------------------
// Normal resolution
// ---------------------------------------------------------------------------

/**
 * Resolve the real surface normal at a candidate's tip position by
 * raycasting against the model mesh — exactly the same way manual
 * placement obtains a surface normal from a click intersection.
 *
 * Primary ray goes UPWARD from just below the tip: a support contact sits on
 * the underside of an overhang, so the first surface hit is the contact face
 * itself, whose normal (pointing away from the model interior, i.e. downward)
 * is what the support tip must align with. A downward ray from above would hit
 * the model's TOP surface first, which is the wrong face for a support.
 *
 * Falls back to a downward ray (normal flipped) for top-surface contacts, and
 * finally to the candidate's placeholder normal when the mesh is unavailable
 * or both rays miss.
 */
function resolveSurfaceNormal(
    tipPos: CandidatePoint['tipPos'],
    mesh: THREE.Mesh | undefined,
): { point: { x: number; y: number; z: number }; normal: { x: number; y: number; z: number } } {
    if (!mesh) {
        return { point: tipPos, normal: { x: 0, y: 0, z: -1 } };
    }

    const raycaster = new THREE.Raycaster();

    // Primary: upward ray from just below the tip (underside contact).
    raycaster.set(new THREE.Vector3(tipPos.x, tipPos.y, tipPos.z - 2), new THREE.Vector3(0, 0, 1));
    const upHits = raycaster.intersectObject(mesh, false);
    if (upHits.length > 0) {
        const hit = upHits[0];
        const smoothed = calculateSmoothedNormal(hit);
        return {
            point: { x: hit.point.x, y: hit.point.y, z: hit.point.z },
            normal: smoothed,
        };
    }

    // Fallback: downward ray from above (top-surface contact), normal flipped
    // so the support still grows away from the face.
    raycaster.set(new THREE.Vector3(tipPos.x, tipPos.y, tipPos.z + 2), new THREE.Vector3(0, 0, -1));
    const downHits = raycaster.intersectObject(mesh, false);
    if (downHits.length > 0) {
        const hit = downHits[0];
        const smoothed = calculateSmoothedNormal(hit);
        return {
            point: { x: hit.point.x, y: hit.point.y, z: hit.point.z },
            normal: { x: -smoothed.x, y: -smoothed.y, z: -smoothed.z },
        };
    }

    // Fallback: keep the existing normal.
    return { point: tipPos, normal: { x: 0, y: 0, z: -1 } };
}

// ---------------------------------------------------------------------------
// Already-supported filter
// ---------------------------------------------------------------------------

/**
 * Remove candidates whose tip position is already covered by an
 * existing support (any trunk / branch / leaf / anchor contact cone).
 * Prevents stacking duplicate supports on repeated runs.
 */
function filterAlreadySupported(candidates: CandidatePoint[], draft: SupportState): CandidatePoint[] {
    const snapshot = draft;
    const existingTips: Array<{ x: number; y: number; z: number }> = [];

    for (const t of Object.values(snapshot.trunks)) {
        if (t.contactCone?.pos) existingTips.push(t.contactCone.pos);
    }
    for (const b of Object.values(snapshot.branches)) {
        if (b.contactCone?.pos) existingTips.push(b.contactCone.pos);
    }
    for (const l of Object.values(snapshot.leaves)) {
        if (l.contactCone?.pos) existingTips.push(l.contactCone.pos);
    }
    for (const a of Object.values(snapshot.anchors)) {
        if (a.contactCone?.pos) existingTips.push(a.contactCone.pos);
    }

    if (existingTips.length === 0) return candidates;

    const r2 = ALREADY_SUPPORTED_RADIUS_MM * ALREADY_SUPPORTED_RADIUS_MM;
    return candidates.filter(c => {
        for (const tip of existingTips) {
            const dx = c.tipPos.x - tip.x;
            const dy = c.tipPos.y - tip.y;
            const dz = c.tipPos.z - tip.z;
            if (dx * dx + dy * dy + dz * dz <= r2) return false;
        }
        return true;
    });
}

// ---------------------------------------------------------------------------
// Nearby-trunk merge (works even without grid mode)
// ---------------------------------------------------------------------------

export interface MergeHost {
    trunkId: string;
    tipPos: { x: number; y: number; z: number };
}

// ---------------------------------------------------------------------------
// Leaf cone triangle collision
// ---------------------------------------------------------------------------

const _leafRaycaster = new THREE.Raycaster();

/** Check whether a leaf cone from `knotPos` to `cone` intersects the model.
 *  Raycasts from the knot toward a point just before the tip (offset inward
 *  along the surface normal), excluding the tip contact itself.  Returns true
 *  if the ray hits a model triangle before reaching the offset point. */
function leafConeCollides(
    knotPos: { x: number; y: number; z: number },
    cone: { pos: { x: number; y: number; z: number }; surfaceNormal?: { x: number; y: number; z: number }; normal: { x: number; y: number; z: number } },
    mesh: THREE.Mesh,
): boolean {
    // Ray from knot toward tip. The tip is ON the surface — the first
    // hit should be the tip surface at ~totalDist.  If the first hit
    // is significantly closer, there's geometry between shaft and tip.
    const dx = cone.pos.x - knotPos.x;
    const dy = cone.pos.y - knotPos.y;
    const dz = cone.pos.z - knotPos.z;
    const totalDist = Math.sqrt(dx * dx + dy * dy + dz * dz);
    if (totalDist < 0.01) return false;
    const dir = new THREE.Vector3(dx / totalDist, dy / totalDist, dz / totalDist);

    // Cast two offset rays to account for cone thickness (~0.25mm).
    const n = cone.surfaceNormal ?? cone.normal;
    const perpX = dir.y * n.z - dir.z * n.y;
    const perpY = dir.z * n.x - dir.x * n.z;
    const perpZ = dir.x * n.y - dir.y * n.x;
    const perpLen = Math.sqrt(perpX * perpX + perpY * perpY + perpZ * perpZ);
    const offsets = perpLen > 0.001
        ? [0, 0.25, -0.25]
        : [0];

    for (const off of offsets) {
        const sx = knotPos.x + (perpX / perpLen) * off;
        const sy = knotPos.y + (perpY / perpLen) * off;
        const sz = knotPos.z + (perpZ / perpLen) * off;
        _leafRaycaster.set(new THREE.Vector3(sx, sy, sz), dir);
        const hits = _leafRaycaster.intersectObject(mesh, false);
        if (hits.length > 0 && hits[0].distance < totalDist - 0.5) return true;
    }
    return false;
}

// ---------------------------------------------------------------------------
// Post-build collision verification
// ---------------------------------------------------------------------------

/** Check all segments of a built branch against the SDF. */
function branchCollidesWithSDF(
    branch: { segments: Array<{ bottomJoint?: { pos: { x: number; y: number; z: number } } | null; topJoint?: { pos: { x: number; y: number; z: number } } | null; diameter?: number }> },
    mesh: THREE.Mesh,
): boolean {
    for (const seg of branch.segments) {
        const start = seg.bottomJoint?.pos;
        const end = seg.topJoint?.pos;
        if (start && end) {
            const r = (seg.diameter ?? 1.0) / 2;
            if (isShaftBlocked(start, end, r, mesh)) return true;
        }
    }
    return false;
}

// ---------------------------------------------------------------------------
// Attachment capacity
// ---------------------------------------------------------------------------

/**
 * Count how many knots (branches + leaves) are attached to a trunk.
 * Does NOT count brace knots (they use braceSegment: prefix).
 */
function countAttachmentsOnTrunk(trunkId: string, draft: SupportState): number {
    const snapshot = draft;
    const trunk = snapshot.trunks[trunkId];
    if (!trunk) return 0;

    const segmentIds = new Set(trunk.segments.map(s => s.id));
    // Also match legacy knots that reference the trunk ID directly.
    segmentIds.add(trunkId);

    let count = 0;
    for (const knot of Object.values(snapshot.knots)) {
        if (segmentIds.has(knot.parentShaftId)) {
            count++;
        }
    }
    return count;
}

/** Returns true if the trunk has reached its attachment capacity. */
function isTrunkAtAttachmentCapacity(trunkId: string, limit: number, draft: SupportState): boolean {
    if (limit <= 0) return false;
    return countAttachmentsOnTrunk(trunkId, draft) >= limit;
}

// ---------------------------------------------------------------------------
// Nearby-trunk merge
// ---------------------------------------------------------------------------

/** Find the closest existing trunk (shaft or tip) within merge radius.
 *  Anchor-origin trunks never host merges: anchors are load-bearing
 *  standalone pillars, leaves are not. */
export function findMergeHost(
    tipPos: { x: number; y: number; z: number },
    modelId: string,
    draft: SupportState,
): MergeHost | null {
    const snapshot = draft;
    const r2 = GRIDLESS_MERGE_RADIUS_MM * GRIDLESS_MERGE_RADIUS_MM;
    let best: MergeHost | null = null;
    let bestDist2 = Infinity;

    for (const [id, trunk] of Object.entries(snapshot.trunks)) {
        if (trunk.modelId !== modelId) continue;
        if (trunk.origin === 'anchor') continue;

        // Check trunk tip (contact cone).
        const tp = trunk.contactCone?.pos;
        if (tp) {
            const dx = tipPos.x - tp.x;
            const dy = tipPos.y - tp.y;
            const dz = tipPos.z - tp.z;
            const d2 = dx * dx + dy * dy + dz * dz;
            if (d2 <= r2 && d2 < bestDist2) {
                bestDist2 = d2;
                best = { trunkId: id, tipPos: tp };
            }
        }

        // Also check segment joints (shaft body), preferring lower attachment.
        for (const seg of trunk.segments) {
            const jp = seg.bottomJoint?.pos ?? seg.topJoint?.pos;
            if (!jp) continue;
            const dx = tipPos.x - jp.x;
            const dy = tipPos.y - jp.y;
            const dz = tipPos.z - jp.z;
            const d2 = dx * dx + dy * dy + dz * dz;
            // Slight preference for shaft body over tip (multiply by 0.9
            // so a shaft point at the same distance wins).
            const adjustedD2 = d2 * 0.9;
            if (adjustedD2 <= r2 && adjustedD2 < bestDist2) {
                bestDist2 = adjustedD2;
                best = { trunkId: id, tipPos: jp };
            }
        }
    }
    return best;
}

/** Consolidation fallback: when the straight fan leaf is blocked by the
 *  model (or another support), attach the standalone trunk to the steepest
 *  eligible host sample as a ROUTED BRANCH — its shaft and cone
 *  re-placement can go around an obstruction a straight cone cannot. */
export function buildConsolidationBranch(args: {
    tip: { x: number; y: number; z: number };
    tipNormal: { x: number; y: number; z: number };
    modelId: string;
    pool: FanShaftPoint[];
    pruned: SupportState;
    mesh: THREE.Mesh | undefined;
    radiusMm: number;
    maxAttachments: number;
    knotId: string;
}): { draft: SupportState; branchId: string } | null {
    const { tip, tipNormal, modelId, pool, pruned, mesh, radiusMm, maxAttachments, knotId } = args;

    // Steepest eligible host sample (≤ 50° from vertical — the branch
    // steepness rule; the leaf fan's angle cap is looser).
    let best: FanShaftPoint | null = null;
    let bestAngleDeg = Infinity;
    for (const sp of pool) {
        const ddx = sp.pos.x - tip.x;
        const ddy = sp.pos.y - tip.y;
        const ddz = sp.pos.z - tip.z;
        if (ddx * ddx + ddy * ddy + ddz * ddz > radiusMm * radiusMm) continue;
        const vDist = tip.z - sp.pos.z;
        if (vDist < 1.5) continue;
        const angleDeg = (Math.atan2(Math.hypot(ddx, ddy), vDist) * 180) / Math.PI;
        if (angleDeg > 50) continue;
        if (angleDeg < bestAngleDeg) {
            bestAngleDeg = angleDeg;
            best = sp;
        }
    }
    if (!best) return null;
    if (maxAttachments > 0 && isTrunkAtAttachmentCapacity(best.trunkId, maxAttachments, pruned)) return null;

    const parentKnot = {
        id: knotId,
        parentShaftId: best.segmentId ?? best.trunkId,
        t: best.t,
        pos: best.pos,
        diameter: best.diameter + 0.125,
    };

    try {
        const band = activeSizingBand();
        const { branch, supportData: sd } = buildBranchData({
            tipPos: tip,
            tipNormal,
            modelId,
            parentKnot,
            mesh,
            shaftDiameterMm: band.shaftDiameterMm,
            tipContactDiameterMm: band.tipContactDiameterMm,
            rootsDiameterMm: band.rootDiameterMm,
        });
        if (sd.error) return null;
        if (mesh && branchCollidesWithSDF(branch, mesh)) return null;
        if (leafPathCrossesSupports(parentKnot.pos, branch.contactCone?.pos ?? tip, 0.25, pruned, best.trunkId)) return null;

        let d = draftAddKnot(pruned, parentKnot);
        branch.origin = 'overhang';
        d = draftAddBranch(d, branch);
        return { draft: d, branchId: branch.id };
    } catch {
        return null;
    }
}

// ---------------------------------------------------------------------------
// Pipeline helpers
// ---------------------------------------------------------------------------

/**
 * Run a single candidate through the standard placement pipeline:
 * resolve surface normal → buildTrunkData → decideGridPlacement → commit.
 *
 * When grid mode is disabled, we additionally check whether another
 * trunk already sits within {@link GRIDLESS_MERGE_RADIUS_MM} of this
 * candidate's tip.  If so, the candidate is routed as a branch off
 * that host instead of becoming a standalone trunk — preventing
 * clusters of near-identical vertical supports at the same XY.
 *
 * This is the same sequence used by manual placement clicks.
 * Returns the decision kind so the orchestrator can tally.
 */
function placeOneCandidate(
    candidate: CandidatePoint,
    draft: SupportState,
    _settingsOverride: Partial<AutoSupportSettings> | undefined,
    gridTrunkIds?: ReadonlySet<string>,
): { kind: string; draft: SupportState; kickstand?: KickstandState; rejectedReason?: RejectReason; preset?: 'detail' | 'structure' | 'anchor'; entityId?: string; stickCount?: number; fanRefusal?: FanLeafRefusal; mergeRefusal?: 'noHost' | 'rejected'; cavityFanRefusal?: FanLeafRefusal } {
    const supportSettings = getSettings();
    const snapshot = draft;
    let d = draft;
    const mesh = getModelMesh(candidate.modelId) ?? undefined;

    // Grid points carry the region's exact surface position and normal (from
    // the classifier's own triangles, world space). Re-resolving via a
    // whole-mesh raycast hits the wrong face on sloped geometry (side walls
    // below the region face at the same XY), so trust the region data.
    const resolved = candidate.gridPoint && candidate.tipNormal && candidate.tipNormal.z < 0
        ? { point: candidate.tipPos, normal: candidate.tipNormal }
        : resolveSurfaceNormal(candidate.tipPos, mesh);
    const tipPos = resolved.point;
    const tipNormal = resolved.normal;

    // Determine preset band for analytics + empirical sizing.
    const area = candidate.islandAreaMm2;
    const preset = presetForArea(area);

    // ── Gridless merge check ──────────────────────────────────────
    // Density-grid points force standalone trunks (a flat region needs
    // independent supports, not a bush of branches off one shaft).
    let mergeHostFound = false;
    let fanRefusal: FanLeafRefusal | undefined;
    if (!supportSettings.grid?.enabled) {
        // Grid/poisson points fan into ISLAND trunks only (hosts not placed
        // from gridPoint candidates). Only ORGANIC Poisson + coverage-fill
        // points — flat-lattice grid infill and the anchor band stay
        // standalone (peel distribution). A pillar standing next to an island
        // trunk attaches as a leaf instead of duplicating it; grid points
        // never attach to other grid trunks.
        if (candidate.gridPoint && candidate.source === 'overhang' && gridTrunkIds
            && !candidate.id.startsWith('grid-')) {
            const auto = supportSettings.autoSupport ?? {};
            const islandPool = collectFanShaftPoints(draft)
                .filter((sp) => !gridTrunkIds.has(sp.trunkId));
            if (islandPool.length > 0) {
                const fan = fanLeafToTrunk(
                    tipPos,
                    candidate.modelId,
                    islandPool,
                    new Set(),
                    `auto-fan-${candidate.id}`,
                    Math.max(8, auto.leafFanRadiusMm ?? LEAF_FAN_RADIUS_MM),
                    GRID_HOST_FAN_RADIUS_MM,
                    auto.leafFanMaxAngleDeg ?? LEAF_FAN_MAX_ANGLE_DEG,
                    auto.maxAttachmentsPerTrunk ?? 12,
                    draft,
                    mesh,
                    'overhang',
                );
                if (fan.ok) {
                    logPlacement(
                        `Leaf (grid→island) ${candidate.id} → trunk ${fan.trunkId} ` +
                        `dist=${fan.distMm.toFixed(1)}mm angle=${fan.angleDeg.toFixed(0)}°`);
                    return { kind: 'leaf', preset, draft: fan.draft, entityId: fan.leafId };
                }
            }
        }
    }
    if (!supportSettings.grid?.enabled && !candidate.gridPoint) {
        // Overhang-derived candidates (sub-threshold, non-anchor regions)
        // attach via the regular leaf-fanning path — a standalone straight
        // trunk next to fan leaves reads as a misplaced island support. No
        // host in fan range → fall through to the merge/trunk fallbacks.
        if (candidate.source === 'overhang' && gridTrunkIds) {
            const auto = supportSettings.autoSupport ?? {};
            const fan = fanLeafToTrunk(
                tipPos,
                candidate.modelId,
                collectFanShaftPoints(draft),
                gridTrunkIds,
                `auto-fan-${candidate.id}`,
                Math.max(8, auto.leafFanRadiusMm ?? LEAF_FAN_RADIUS_MM),
                GRID_HOST_FAN_RADIUS_MM,
                auto.leafFanMaxAngleDeg ?? LEAF_FAN_MAX_ANGLE_DEG,
                auto.maxAttachmentsPerTrunk ?? 12,
                draft,
                mesh,
                'overhang',
            );
            if (fan.ok) {
                logPlacement(
                    `Leaf (fan merge) ${candidate.id} → trunk ${fan.trunkId} ` +
                    `dist=${fan.distMm.toFixed(1)}mm angle=${fan.angleDeg.toFixed(0)}°`);
                return { kind: 'leaf', preset, draft: fan.draft, entityId: fan.leafId };
            }
            fanRefusal = fan.reason;
        }
        let host = findMergeHost(tipPos, candidate.modelId, draft);
        // Island candidates never merge INTO grid trunks: at a junction the
        // island trunk should HOST the grid (the grid pillars convert to fan
        // leaves on it in the consolidation pass), not the reverse — a pillar
        // with a leaf still reads as a pillar.
        if (host && gridTrunkIds?.has(host.trunkId)) {
            host = null;
        }
        if (host) {
            mergeHostFound = true;
            // Find the best attachment point on the host trunk's shaft,
            // below the candidate's tip.  This matches the W-key sprout
            // behaviour: leaves/branches fan from the shaft body, not
            // from the contact tip.
            const hostTrunk = snapshot.trunks[host.trunkId];
            let bestKnotPos: { x: number; y: number; z: number } | null = null;
            let bestKnotSegmentId = '';
            let bestKnotT = 0;

            // Attachment point: snap the knot DOWN the host shaft only far
            // enough to reach the 45°-above-horizontal steep minimum — the
            // HIGHEST sample whose rise to the tip is ≥ 45°. A deeper knot
            // makes the leaf nearly parallel to the shaft (a second pillar
            // "floating" next to the trunk — the recent defect); a knot at
            // the junction is the original shallow-branch bug. 45° matches
            // the relaxed leafFanMaxAngleDeg default (was 60°).
            const STEEP_MIN_RISE_DEG = 45;
            const MAX_MERGE_ATTACH_SPAN_MM = 12;
            let maxRiseDeg = 0;
            if (hostTrunk) {
                for (const seg of hostTrunk.segments) {
                    const start = seg.bottomJoint?.pos ?? { x: 0, y: 0, z: 1.5 };
                    const end = seg.topJoint?.pos;
                    if (!end) continue;
                    for (let i = 0; i <= 10; i++) {
                        const t = i / 10;
                        const sx = start.x + (end.x - start.x) * t;
                        const sy = start.y + (end.y - start.y) * t;
                        const sz = start.z + (end.z - start.z) * t;
                        const vDist = tipPos.z - sz;
                        if (vDist <= 0) continue;
                        const hDist = Math.hypot(tipPos.x - sx, tipPos.y - sy);
                        if (Math.hypot(hDist, vDist) > MAX_MERGE_ATTACH_SPAN_MM) continue;
                        const riseDeg = (Math.atan2(vDist, hDist) * 180) / Math.PI;
                        if (riseDeg > maxRiseDeg) maxRiseDeg = riseDeg;
                        if (riseDeg < STEEP_MIN_RISE_DEG) continue;
                        if (bestKnotPos === null || sz > bestKnotPos.z) {
                            bestKnotPos = { x: sx, y: sy, z: sz };
                            bestKnotSegmentId = seg.id;
                            bestKnotT = t;
                        }
                    }
                }
            }
            if (!bestKnotPos) {
                logPlacement(
                    `Merge skip ${candidate.id}: no steep attachment on host ${host.trunkId} ` +
                    `(max rise ${maxRiseDeg.toFixed(0)}° < ${STEEP_MIN_RISE_DEG}° above horizontal)`);
            } else {
                const knotPos = bestKnotPos;
                let knotDiameter = 1.0;
                if (hostTrunk && bestKnotSegmentId) {
                    const seg = hostTrunk.segments.find(s => s.id === bestKnotSegmentId);
                    if (seg?.diameter) knotDiameter = seg.diameter;
                }
                const parentKnot = {
                    id: `auto-merge-${candidate.id}`,
                    parentShaftId: bestKnotSegmentId || host.trunkId,
                    t: bestKnotT,
                    pos: knotPos,
                    // The knot renders at exactly the trunk-joint size when
                    // unselected: the KnotRenderer subtracts the full joint
                    // offset (0.1), while the JointRenderer subtracts 0.075
                    // from a shaft+0.1 joint — so shaft + 0.125 renders at
                    // shaft + 0.025, the joint's own rendered diameter.
                    diameter: knotDiameter + 0.125,
                };
                // Leaf decision: use tip-to-tip distance (host contact cone →
                // candidate tip), not shaft-knot distance.  This is the visual
                // span the leaf would bridge.
                const hostTip = hostTrunk?.contactCone?.pos ?? knotPos;
                const tipSpanMm = Math.sqrt(
                    (tipPos.x - hostTip.x) ** 2 +
                    (tipPos.y - hostTip.y) ** 2 +
                    (tipPos.z - hostTip.z) ** 2,
                );
                const MAX_AUTO_LEAF_SPAN_MM = 8.0;
                if (tipSpanMm <= MAX_AUTO_LEAF_SPAN_MM) {
                    // Knot attachment is on the shaft; angle check uses the
                    // actual knot-to-tip geometry for the leaf cone.
                    const hDist = Math.sqrt(
                        (tipPos.x - knotPos.x) ** 2 + (tipPos.y - knotPos.y) ** 2,
                    );
                    const vDist = tipPos.z - knotPos.z;
                    if (vDist <= 0) {
                        logPlacement(
                            `Merge skip ${candidate.id}: knot above tip (kZ=${knotPos.z.toFixed(1)} tZ=${tipPos.z.toFixed(1)})`);
                    } else if (vDist < 1.5) {
                        // Too shallow — fall through to branch.
                        logPlacement(
                            `Leaf (merge) ${candidate.id}: too shallow (vDist=${vDist.toFixed(1)}mm), trying branch...`);
                    } else {
                        try {
                            const { leaf, supportData: sd } = buildLeafData({
                                tipPos,
                                surfaceNormal: tipNormal,
                                modelId: candidate.modelId,
                                parentKnot,
                                // Cone body = the HOST shaft, not the knot —
                                // otherwise the cone's wide base swallows the
                                // junction ball and the knot stays invisible.
                                hostDiameterMm: knotDiameter,
                                tipContactDiameterMm: activeSizingBand().tipContactDiameterMm,
                                mesh,
                            });
                            if (sd.error) {
                                logPlacement(
                                    `Leaf (merge) ${candidate.id}: sd.error, trying branch...`);
                            } else if (mesh && leafConeCollides(parentKnot.pos, leaf.contactCone, mesh)) {
                                logPlacement(
                                    `Leaf (merge) ${candidate.id}: triangle collision, trying branch...`);
                            } else {
                                const cap = supportSettings.autoSupport?.maxAttachmentsPerTrunk ?? 12;
                                if (isTrunkAtAttachmentCapacity(host.trunkId, cap, draft)) {
                                    logPlacement(
                                        `Merge skip ${candidate.id}: host ${host.trunkId} at capacity (${cap} attachments)`);
                                    // fall through to standalone trunk
                                } else {
                                    d = draftAddKnot(d, parentKnot);
                                    leaf.origin = candidate.source === 'overhang' ? 'overhang' : 'island';
                                    d = draftAddLeaf(d, leaf);
                                    const la = (Math.atan2(hDist, vDist) * 180) / Math.PI;
                                    logPlacement(
                                        `Leaf (merge) ${candidate.id} → host ${host.trunkId} ` +
                                        `span=${tipSpanMm.toFixed(1)}mm angle=${la.toFixed(0)}° kZ=${knotPos.z.toFixed(1)}`);
                                    return { kind: 'leaf', preset, draft: d, entityId: leaf.id };
                                }
                            }
                        } catch {}
                    }
                } else if (tipSpanMm > MAX_AUTO_LEAF_SPAN_MM && candidate.source !== 'overhang') {
                    // Branch: requires upward angle from knot to tip. Only ISLAND
                    // candidates branch here — overhang fanning is leaves by rule,
                    // so an overhang single beyond leaf reach falls through and
                    // the consolidation pass attaches it as a leaf where possible.
                    const hDist2 = Math.sqrt(
                        (tipPos.x - knotPos.x) ** 2 + (tipPos.y - knotPos.y) ** 2,
                    );
                    const vDist2 = tipPos.z - knotPos.z;
                    const mergeAngleDeg = (Math.atan2(hDist2, vDist2) * 180) / Math.PI;
                    if (mergeAngleDeg > 50) {
                        logPlacement(
                            `Merge skip ${candidate.id}: angle too shallow (${mergeAngleDeg.toFixed(0)}° from vertical > 50°) span=${tipSpanMm.toFixed(1)}mm`);
                    } else try {
                        const band = activeSizingBand();
                        const { branch, supportData: sd } = buildBranchData({
                            tipPos, tipNormal, modelId: candidate.modelId, parentKnot, mesh,
                            shaftDiameterMm: band.shaftDiameterMm,
                            tipContactDiameterMm: band.tipContactDiameterMm,
                            rootsDiameterMm: band.rootDiameterMm,
                        });
                        const collides = sd.error || (mesh && branchCollidesWithSDF(branch, mesh));
                        if (collides) {
                            logPlacement(`Branch (merge) ${candidate.id}: collision, falling back`);
                        } else {
                            const cap = supportSettings.autoSupport?.maxAttachmentsPerTrunk ?? 12;
                            if (isTrunkAtAttachmentCapacity(host.trunkId, cap, draft)) {
                                logPlacement(
                                    `Merge skip ${candidate.id}: host ${host.trunkId} at capacity (${cap} attachments)`);
                                // fall through to standalone trunk
                            } else {
                                d = draftAddKnot(d, parentKnot);
                                // Branch fallback is island-only (overhang fanning
                                // is leaves) — the origin is always island here.
                                branch.origin = 'island';
                                d = draftAddBranch(d, branch);
                                const ma = (Math.atan2(hDist2, vDist2) * 180) / Math.PI;
                                logPlacement(
                                    `Branch (merge) ${candidate.id} → host ${host.trunkId} ` +
                                    `span=${tipSpanMm.toFixed(1)}mm angle=${ma.toFixed(0)}° kZ=${knotPos.z.toFixed(1)}`);
                                return { kind: 'branch', preset, draft: d, entityId: branch.id };
                            }
                        }
                    } catch (e) {
                        logPlacement(
                            `Merge branch failed for ${candidate.id}, falling back to trunk: ` +
                            `${e instanceof Error ? e.message : String(e)}`);
                    }
                }
            }
        }
    }

    // Empirical sizing: the candidate's own island area drives the tail over
    // the active profile band. No merge-radius cluster summing — dense
    // regions would double-count the same area onto every trunk.
    const overrides = sizeParameters(
        candidate,
        supportSettings.autoSupport?.sizeScale ?? 1,
    );
    const isSmallIsland = (candidate.source !== 'overhang' && (candidate.islandAreaMm2 ?? 0) < 5) || candidate.zHeight < 15;
    const trunkResult = buildTrunkData({
        tipPos,
        tipNormal,
        modelId: candidate.modelId,
        mesh,
        overrides,
        isPreview: false,
        isSmallIsland,
    });
    if (trunkResult.error) {
        // Cavity fallback: if the trunk can't reach the build plate, try
        // bridging to a lower surface with a Stick (model-to-model).
        if (trunkResult.error === 'COLLISION_WITH_MODEL' && mesh) {
            // Before bridging model-to-model, try to carry the tip as a fan
            // leaf on a nearby host. A jaw tip whose straight pillar pierces
            // the chest often has a trunk within 5 mm that can host it — that
            // reads as a regular tree, not a "stick under the jaw". The trunk
            // build's COLLISION_WITH_MODEL means "no plate route found", not
            // "nowhere to attach".
            let cavityFanRefusal: FanLeafRefusal | undefined;
            try {
                const auto = getSettings().autoSupport ?? {};
                const fan = fanLeafToTrunk(
                    tipPos,
                    candidate.modelId,
                    collectFanShaftPoints(draft),
                    gridTrunkIds ?? new Set<string>(),
                    `auto-cavity-fan-${candidate.id}`,
                    Math.max(8, auto.leafFanRadiusMm ?? LEAF_FAN_RADIUS_MM),
                    GRID_HOST_FAN_RADIUS_MM,
                    auto.leafFanMaxAngleDeg ?? LEAF_FAN_MAX_ANGLE_DEG,
                    auto.maxAttachmentsPerTrunk ?? 12,
                    draft,
                    mesh,
                    candidate.source as SupportOrigin | undefined,
                );
                if (fan.ok) {
                    logPlacement(`Leaf (cavity-fan) ${candidate.id} → trunk ${fan.trunkId} dist=${fan.distMm.toFixed(1)}mm angle=${fan.angleDeg.toFixed(0)}°`);
                    return { kind: 'leaf', preset, draft: fan.draft, entityId: fan.leafId };
                }
                cavityFanRefusal = fan.reason;
            } catch {}
            const band = activeSizingBand();
            const cavityResult = buildCavityStick(tipPos, tipNormal, candidate.modelId, mesh, band);
            if (cavityResult) {
                // Long model-to-model bridges under an overhang (jaw → chest)
                // read as "sticks under the jaw" and are rarely printable —
                // the older dev build simply rejected these instead of bridging.
                // Keep short twigs (<5 mm, true cavities) but cap long sticks:
                // require the bridge to be < 12 mm, otherwise fall through to
                // reject. The tip will then be reconsidered via fan/merge in a
                // later pass or left unsupported (coverage still 100% per
                // report).
                if (cavityResult.kind === 'stick') {
                    const lower = cavityResult.stick.contactConeB?.pos ?? cavityResult.stick.contactConeA?.pos;
                    if (lower) {
                        const dx = tipPos.x - lower.x, dy = tipPos.y - lower.y, dz = tipPos.z - lower.z;
                        const bridgeLen = Math.sqrt(dx*dx + dy*dy + dz*dz);
                        if (bridgeLen > 12) {
                            logPlacement(`Cavity stick rejected (bridge ${bridgeLen.toFixed(1)}mm > 12mm) ${candidate.id}`);
                            // fall through to rejected trunk path below
                        } else {
                            d = draftAddStick(d, cavityResult.stick);
                            logPlacement(`Stick (cavity) ${candidate.id} Z=${candidate.zHeight.toFixed(1)}mm`);
                            return { kind: 'stick', preset, draft: d, entityId: cavityResult.stick.id, cavityFanRefusal };
                        }
                    } else {
                        d = draftAddStick(d, cavityResult.stick);
                        logPlacement(`Stick (cavity) ${candidate.id} Z=${candidate.zHeight.toFixed(1)}mm`);
                        return { kind: 'stick', preset, draft: d, entityId: cavityResult.stick.id, cavityFanRefusal };
                    }
                } else {
                    d = draftAddTwig(d, cavityResult.twig);
                    logPlacement(`Twig (cavity) ${candidate.id} Z=${candidate.zHeight.toFixed(1)}mm`);
                    return { kind: 'twig', preset, draft: d, entityId: cavityResult.twig.id, cavityFanRefusal };
                }
            }
        }
        const bbox = mesh ? new THREE.Box3().setFromObject(mesh) : null;
        logPlacement(
            `Rejected ${candidate.id}: trunk build error \"${trunkResult.error}\" ` +
            `tip=(${tipPos.x.toFixed(1)},${tipPos.y.toFixed(1)},${tipPos.z.toFixed(1)}) ` +
            `mesh=${mesh ? 'yes' : 'no'} ` +
            `bbox=${bbox ? `(${bbox.min.x.toFixed(0)},${bbox.min.y.toFixed(0)},${bbox.min.z.toFixed(0)})-(${bbox.max.x.toFixed(0)},${bbox.max.y.toFixed(0)},${bbox.max.z.toFixed(0)})` : 'none'}`);
        return { kind: 'reject', rejectedReason: 'trunk_build_error', preset, draft: d };
    }

    // Side-wall guard at placement time: do not build a trunk whose contact
    // points sideways. Previously this was a post-resize cull that orphaned
    // leaves; rejecting at placement prevents the trunk and its leaves from
    // ever being created. Applies to all sources — even minima side-walls at
    // 80.8° are now kept (threshold 85°) while true 90° horizontal cones are
    // rejected.
    {
        const n = trunkResult.trunk.contactCone?.normal ?? trunkResult.trunk.contactCone?.surfaceNormal;
        if (n) {
            const hz = Math.hypot(n.x, n.y);
            const angleDeg = (Math.atan2(hz, Math.max(0.001, Math.abs(n.z))) * 180) / Math.PI;
            const isMinima = candidate.source === 'minima' || candidate.source === 'intersection';
            const threshold = isMinima ? 85 : 75;
            if (angleDeg > threshold) {
                logPlacement(`Rejected ${candidate.id}: side-wall trunk too shallow ${angleDeg.toFixed(1)}° > ${threshold}°`);
                return { kind: 'reject', rejectedReason: 'trunk_build_error', preset, draft: d };
            }
        }
    }

    // Route through the standard grid placement engine.
    // This handles grid snapping, SDF collision checks, host-trunk
    // attachment (branch/leaf), anchor short-circuit, and rejection.
    const decision = decideGridPlacement({
        settings: supportSettings,
        snapshot,
        candidate: trunkResult,
        tipPos,
        tipNormal,
        modelId: candidate.modelId,
        mesh,
    });

    switch (decision.kind) {
        case 'place_trunk': {
            const trunkId = decision.trunkBuild.trunk.id;
            decision.trunkBuild.trunk.origin = candidate.gridPoint
                ? 'overhang'
                : (candidate.source === 'overhang' ? 'standalone' : 'island');
            d = draftAddRoot(d, decision.trunkBuild.root);
            d = draftAddTrunk(d, decision.trunkBuild.trunk);
            logPlacement(
                `Trunk ${candidate.id} (→ ${trunkId}) @ grid ${decision.nodeKey} ` +
                `area=${candidate.islandAreaMm2.toFixed(2)}mm² Z=${candidate.zHeight.toFixed(1)}mm ${preset}` +
                (fanRefusal ? ` fan:${fanRefusal}` : '') +
                (mergeHostFound ? ' merge:rejected' : ''));
            const mergeChecked = !supportSettings.grid?.enabled && !candidate.gridPoint;
            return {
                kind: 'trunk', preset, entityId: trunkId, draft: d,
                fanRefusal,
                mergeRefusal: mergeChecked ? (mergeHostFound ? 'rejected' : 'noHost') : undefined,
            };
        }

        case 'place_anchor':
            decision.anchor.origin = candidate.gridPoint
                ? 'overhang'
                : (candidate.source === 'overhang' ? 'standalone' : 'island');
            d = draftAddAnchor(d, decision.anchor);
            logPlacement(`Anchor ${candidate.id} Z=${candidate.zHeight.toFixed(1)}mm`);
            return { kind: 'anchor', preset, draft: d, entityId: decision.anchor.id };

        case 'place_branch': {
            const cap = supportSettings.autoSupport?.maxAttachmentsPerTrunk ?? 12;
            if (isTrunkAtAttachmentCapacity(decision.hostTrunkId, cap, draft)) {
                logPlacement(
                    `Grid skip ${candidate.id}: host ${decision.hostTrunkId} at capacity (${cap})`);
                return { kind: 'reject', rejectedReason: 'grid_reject_other', preset, draft: d };
            }
            d = draftAddKnot(d, decision.knot);
            d = draftAddBranch(d, decision.branch);
            logPlacement(
                `Branch ${candidate.id} → host ${decision.hostTrunkId} ` +
                `grid ${decision.nodeKey}`);
            return { kind: 'branch', preset, draft: d, entityId: decision.branch.id };
        }

        case 'place_leaf': {
            const cap = supportSettings.autoSupport?.maxAttachmentsPerTrunk ?? 12;
            if (isTrunkAtAttachmentCapacity(decision.hostTrunkId, cap, draft)) {
                logPlacement(
                    `Grid skip ${candidate.id}: host ${decision.hostTrunkId} at capacity (${cap})`);
                return { kind: 'reject', rejectedReason: 'grid_reject_other', preset, draft: d };
            }
            d = draftAddKnot(d, decision.knot);
            d = draftAddLeaf(d, decision.leaf);
            logPlacement(
                `Leaf ${candidate.id} → host ${decision.hostTrunkId} ` +
                `grid ${decision.nodeKey}`);
            return { kind: 'leaf', preset, draft: d, entityId: decision.leaf.id };
        }

        case 'replace_trunk': {
            // Same promote-to-trunk flow as manual placement: materialize the
            // promoted branch, plan the replacement, then apply it. The old
            // trunk's contact is preserved as a branch on the new trunk and
            // rehostable branches/leaves are re-attached — the old trunk is
            // never left orphaned at the node.
            const promoteKnot = decision.promoteKnot;
            const promoteBranch = decision.promoteBranch;
            if (!promoteKnot || !promoteBranch) {
                logPlacement(
                    `Replace skip ${candidate.id}: no promoted branch from grid engine`);
                return { kind: 'reject', rejectedReason: 'grid_reject_other', preset, draft: d };
            }
            d = draftAddKnot(d, promoteKnot);
            d = draftAddBranch(d, promoteBranch);
            const planned = planTrunkReplacement({
                snapshot: d,
                trunkIdToRemove: decision.hostTrunkId,
                mode: 'grid_promote_candidate_to_trunk',
                nodeKey: decision.nodeKey,
                promoteBranchId: promoteBranch.id,
            });
            const plan = planned?.plan;
            if (!plan) {
                logPlacement(
                    `Replace skip ${candidate.id}: replacement planner failed (host ${decision.hostTrunkId})`);
                return { kind: 'reject', rejectedReason: 'grid_reject_other', preset, draft: d };
            }
            // The replacement machinery (cascading rehosts, diameter profiles)
            // is store-bound and shared with manual promote — the plan phase
            // commits the draft so far, applies the replacement, and re-reads.
            // The run-level rollback guard + single history entry keep this
            // atomic for the user; a later worker pass will make it pure.
            setSnapshot(d);
            const ok = applyTrunkReplacement(
                { ...plan, trunkToAdd: decision.trunkBuild.trunk, rootToAdd: decision.trunkBuild.root },
                undefined,
                { skipHistory: true }, // the whole run is one undoable entry
            );
            d = ok ? getSnapshot() : d;
            if (!ok) {
                logPlacement(
                    `Replace skip ${candidate.id}: applyTrunkReplacement failed (host ${decision.hostTrunkId})`);
                return { kind: 'reject', rejectedReason: 'grid_reject_other', preset, draft: d };
            }
            logPlacement(
                `Replace trunk @ ${decision.nodeKey}: ` +
                `${candidate.id} (Z=${candidate.zHeight.toFixed(1)}) → host ${decision.hostTrunkId}`);
            return {
                kind: 'trunk', preset, entityId: decision.trunkBuild.trunk.id, draft: d,
                // the removal cascade can strip auto kickstands — re-sync the draft
                kickstand: structuredClone(getKickstandSnapshot()),
            };
        }

        case 'reject': {
            const reason: RejectReason =
                decision.reason === 'COLLISION_WITH_MODEL' ? 'grid_reject_collision' :
                decision.reason === 'NO_VALID_ATTACHMENT' || decision.reason === 'KNOT_ABOVE_TIP' ? 'grid_reject_no_attachment' :
                'grid_reject_other';
            logPlacement(`Rejected ${candidate.id}: ${decision.reason} (grid ${decision.nodeKey})`);
            return { kind: 'reject', rejectedReason: reason, preset, draft: d };
        }
    }
}

// ---------------------------------------------------------------------------
// runAutoPlace
// ---------------------------------------------------------------------------

/**
 * Run the complete auto-support pipeline using the standard placement engine.
 *
 * Each candidate is individually routed through
 * {@link decideGridPlacement}, the same function used by manual support
 * placement.  This guarantees that SDF collision checks, grid snapping,
 * host-trunk attachment rules, and anchor/branch/leaf auto-selection are
 * identical to the manual workflow.
 *
 * Candidates are processed in priority order (largest / lowest islands
 * first).  Because the state snapshot is refreshed after every commit,
 * later candidates see the supports placed by earlier ones, enabling
 * organic tree fan-out via grid occupancy — a subsequent candidate whose
 * preferred grid node is already occupied will automatically become a
 * branch or leaf of the existing trunk.
 */
/**
 * Compute the full auto-support pipeline against a LOCAL draft — no store
 * commits, no notify() — and return the plan: before/after state pair plus
 * analytics. This is the atomic-commit seam: the caller applies the plan with
 * one `setSnapshot` + `setKickstandSnapshot` + a single history entry, and a
 * later step can run this same function inside a Web Worker.
 *
 * The base states and mesh default to the live stores/model, but can be passed
 * explicitly (worker deserialization); settings are read from the live store.
 *
 * NOTE: the one store-coupled path is the grid promote (`replace_trunk`), which
 * runs the shared manual-promote machinery via a mid-run swap; the rollback
 * guard below keeps that atomic. Everything else — placement, gap-fill,
 * fanning, overhang coverage, bracing — is draft-only.
 */
export type FanShaftPoint = {
    trunkId: string;
    segmentId?: string;
    t?: number;
    pos: { x: number; y: number; z: number };
    diameter: number;
};

/**
 * Pick the fanning host for an uncovered island.
 *
 * The nearest shaft point wins, but density-grid trunks are hosts only up
 * close (tight grid-host radius) — a long leaf from a grid shaft would sweep
 * across the grid forest and puncture sibling grid shafts. When the nearest
 * host is a grid trunk beyond the tight radius, fall back to the nearest
 * regular trunk (within the regular fan radius).
 */
export function pickFanHost(
    shaftPoints: FanShaftPoint[],
    gridTrunkIds: ReadonlySet<string>,
    target: { x: number; y: number; z: number },
    fanRadiusMm: number,
    gridHostFanRadiusMm: number,
): { sp: FanShaftPoint; dist2: number } | null {
    let best: FanShaftPoint | null = null;
    let bestDist2 = Infinity;
    let bestRegular: FanShaftPoint | null = null;
    let bestRegularDist2 = Infinity;

    for (const sp of shaftPoints) {
        const dx = target.x - sp.pos.x;
        const dy = target.y - sp.pos.y;
        const dz = target.z - sp.pos.z;
        const d2 = dx * dx + dy * dy + dz * dz;
        if (d2 < bestDist2) { bestDist2 = d2; best = sp; }
        if (!gridTrunkIds.has(sp.trunkId) && d2 < bestRegularDist2) {
            bestRegularDist2 = d2;
            bestRegular = sp;
        }
    }

    if (best && gridTrunkIds.has(best.trunkId) && bestDist2 > gridHostFanRadiusMm * gridHostFanRadiusMm) {
        best = bestRegular;
        bestDist2 = bestRegularDist2;
    }

    if (!best || bestDist2 > fanRadiusMm * fanRadiusMm) return null;
    return { sp: best, dist2: bestDist2 };
}

/** Squared distance between two 3D segments (closest points). */
function segmentDistanceSq(
    p1: { x: number; y: number; z: number },
    p2: { x: number; y: number; z: number },
    p3: { x: number; y: number; z: number },
    p4: { x: number; y: number; z: number },
): number {
    const d1x = p2.x - p1.x, d1y = p2.y - p1.y, d1z = p2.z - p1.z;
    const d2x = p4.x - p3.x, d2y = p4.y - p3.y, d2z = p4.z - p3.z;
    const rx = p1.x - p3.x, ry = p1.y - p3.y, rz = p1.z - p3.z;
    const a = d1x * d1x + d1y * d1y + d1z * d1z;
    const e = d2x * d2x + d2y * d2y + d2z * d2z;
    const f = d2x * rx + d2y * ry + d2z * rz;
    const clamp01 = (v: number) => Math.min(1, Math.max(0, v));

    let s = 0;
    let t = 0;
    if (a < 1e-9) {
        if (e < 1e-9) { /* both points */ } else { t = clamp01(f / e); }
    } else {
        const c = d1x * rx + d1y * ry + d1z * rz;
        if (e < 1e-9) {
            s = clamp01(-c / a);
        } else {
            const b = d1x * d2x + d1y * d2y + d1z * d2z;
            const denom = a * e - b * b;
            if (denom !== 0) s = clamp01((b * f - c * e) / denom);
            t = (b * s + f) / e;
            if (t < 0) { t = 0; s = clamp01(-c / a); }
            else if (t > 1) { t = 1; s = clamp01((b - c) / a); }
        }
    }

    const c1x = p1.x + d1x * s, c1y = p1.y + d1y * s, c1z = p1.z + d1z * s;
    const c2x = p3.x + d2x * t, c2y = p3.y + d2y * t, c2z = p3.z + d2z * t;
    const dx = c1x - c2x, dy = c1y - c2y, dz = c1z - c2z;
    return dx * dx + dy * dy + dz * dz;
}

/**
 * True when the straight leaf path (knot → tip) passes within the leaf
 * radius + shaft radius of ANY other trunk's shaft. The guarantee that fans
 * never puncture neighboring supports.
 */
export function leafPathCrossesSupports(
    knotPos: { x: number; y: number; z: number },
    tipPos: { x: number; y: number; z: number },
    leafRadiusMm: number,
    draft: SupportState,
    hostTrunkId: string,
): boolean {
    for (const [tid, trunk] of Object.entries(draft.trunks)) {
        if (tid === hostTrunkId) continue;
        for (const seg of trunk.segments) {
            const start = seg.bottomJoint?.pos;
            const end = seg.topJoint?.pos;
            if (!start || !end) continue;
            const shaftRadius = (seg.diameter ?? 1.0) / 2;
            const clearance = leafRadiusMm + shaftRadius;
            if (segmentDistanceSq(knotPos, tipPos, start, end) < clearance * clearance) return true;
        }
    }
    return false;
}

/** Shaft samples per segment for fanning host picking. */
const SHAFT_SAMPLES_PER_SEGMENT = 10;
/** Max leaf-fanning convergence passes. */
const MAX_FANNING_PASSES = 5;

/** Collect trunk shaft sample points from a snapshot — the fanning host pool.
 *  Anchor-origin trunks are excluded: anchors are load-bearing standalone
 *  pillars and never host fan leaves. */
export function collectFanShaftPoints(draft: SupportState): FanShaftPoint[] {
    const shaftPoints: FanShaftPoint[] = [];
    for (const [tid, trunk] of Object.entries(draft.trunks)) {
        if (trunk.origin === 'anchor') continue;
        for (const seg of trunk.segments) {
            // Both joints must exist: a knot attached to a joint-less segment
            // is culled later as missingHost — never offer such a segment.
            const start = seg.bottomJoint?.pos;
            const end = seg.topJoint?.pos;
            if (!start || !end) continue;
            const diameter = seg.diameter ?? 1.0;
            for (let i = 0; i <= SHAFT_SAMPLES_PER_SEGMENT; i++) {
                const t = i / SHAFT_SAMPLES_PER_SEGMENT;
                shaftPoints.push({
                    trunkId: tid,
                    segmentId: seg.id,
                    t,
                    pos: {
                        x: start.x + (end.x - start.x) * t,
                        y: start.y + (end.y - start.y) * t,
                        z: start.z + (end.z - start.z) * t,
                    },
                    diameter,
                });
            }
        }
    }
    return shaftPoints;
}

export type FanLeafResult =
    | { ok: true; draft: SupportState; trunkId: string; leafId: string; distMm: number; angleDeg: number }
    | { ok: false; reason: FanLeafRefusal };

// ---------------------------------------------------------------------------
// Fanning orphan detection & legacy rehost
// ---------------------------------------------------------------------------

function pointToSegmentDistanceSq(
    p: { x: number; y: number; z: number },
    a: { x: number; y: number; z: number },
    b: { x: number; y: number; z: number },
): number {
    const abx = b.x - a.x, aby = b.y - a.y, abz = b.z - a.z;
    const apx = p.x - a.x, apy = p.y - a.y, apz = p.z - a.z;
    const ab2 = abx * abx + aby * aby + abz * abz;
    if (ab2 < 1e-9) return apx * apx + apy * apy + apz * apz;
    const t = Math.max(0, Math.min(1, (apx * abx + apy * aby + apz * abz) / ab2));
    const cx = a.x + abx * t, cy = a.y + aby * t, cz = a.z + abz * t;
    const dx = p.x - cx, dy = p.y - cy, dz = p.z - cz;
    return dx * dx + dy * dy + dz * dz;
}

function findHostSegment(
    draft: SupportState,
    parentShaftId: string,
): { trunkId: string; segment: { id: string; bottomJoint?: { pos: { x: number; y: number; z: number } } | null; topJoint?: { pos: { x: number; y: number; z: number } } | null } } | null {
    for (const [tid, trunk] of Object.entries(draft.trunks)) {
        for (const seg of trunk.segments) {
            if (seg.id === parentShaftId) return { trunkId: tid, segment: seg };
        }
        if (tid === parentShaftId) {
            // Legacy: knot parent was trunkId, pick the segment closest to knot.pos later
            // For validation we treat this as missingSegment so it gets rehosted
            return null;
        }
    }
    return null;
}

/** Rehost knots whose parentShaftId is a trunkId (legacy fan leaves/branches) to the nearest segment of that trunk. */
export function rehostLegacyKnots(draft: SupportState): SupportState {
    let nextKnots = draft.knots;
    let changed = false;
    for (const [kid, knot] of Object.entries(draft.knots)) {
        if (draft.trunks[knot.parentShaftId]) {
            const trunk = draft.trunks[knot.parentShaftId];
            let bestSeg: typeof trunk.segments[0] | null = null;
            let bestDist2 = Infinity;
            let bestT = 0;
            for (const seg of trunk.segments) {
                const start = seg.bottomJoint?.pos ?? { x: 0, y: 0, z: 0 };
                const end = seg.topJoint?.pos;
                if (!end) continue;
                // Compute t of projection of knot.pos onto segment
                const abx = end.x - start.x, aby = end.y - start.y, abz = end.z - start.z;
                const apx = knot.pos.x - start.x, apy = knot.pos.y - start.y, apz = knot.pos.z - start.z;
                const ab2 = abx * abx + aby * aby + abz * abz;
                const t = ab2 < 1e-9 ? 0 : Math.max(0, Math.min(1, (apx * abx + apy * aby + apz * abz) / ab2));
                const cx = start.x + abx * t, cy = start.y + aby * t, cz = start.z + abz * t;
                const d2 = (knot.pos.x - cx) ** 2 + (knot.pos.y - cy) ** 2 + (knot.pos.z - cz) ** 2;
                if (d2 < bestDist2) {
                    bestDist2 = d2;
                    bestSeg = seg as typeof trunk.segments[0];
                    bestT = t;
                }
            }
            if (bestSeg) {
                const updated: typeof knot = { ...knot, parentShaftId: bestSeg.id, t: bestT };
                nextKnots = { ...nextKnots, [kid]: updated };
                changed = true;
            }
        }
    }
    return changed ? { ...draft, knots: nextKnots } : draft;
}

/**
 * Enforce "contact cone body ≤ the shaft it sits on" across the whole draft —
 * the same invariant `setSettings`/`updateTipProfile` clamp for settings-driven
 * builds. The resize pass floors SEGMENTS at the cone demand, but cones are
 * never re-derived when the forest changes shape around them: a leaf fanned
 * while its host was temporarily thicker, a trunk whose cone profile was
 * transplanted by a replacement, or a re-run over a previously resized forest
 * can all leave a cone wider than its shaft. Clamping here makes the whole
 * forest match what clicking a support (rebuild from shaft) produces.
 */
export function syncContactConeDiameters(draft: SupportState): SupportState {
    const segmentDiameter = new Map<string, number>();
    for (const t of Object.values(draft.trunks)) {
        for (const seg of t.segments) {
            if (typeof seg.diameter === 'number' && seg.diameter > 0) {
                segmentDiameter.set(seg.id, seg.diameter);
            }
        }
    }
    for (const b of Object.values(draft.branches)) {
        for (const seg of b.segments) {
            if (typeof seg.diameter === 'number' && seg.diameter > 0) {
                segmentDiameter.set(seg.id, seg.diameter);
            }
        }
    }

    let changed = false;
    const clampCone = (cone: ContactCone | undefined, hostDia: number | undefined): ContactCone | undefined => {
        const body = cone?.profile?.bodyDiameterMm;
        if (!cone || body === undefined || hostDia === undefined) return cone;
        if (body > hostDia + 1e-6) {
            changed = true;
            return { ...cone, profile: { ...cone.profile, bodyDiameterMm: hostDia } };
        }
        return cone;
    };

    const nextTrunks: SupportState['trunks'] = { ...draft.trunks };
    for (const [tid, t] of Object.entries(draft.trunks)) {
        const topSeg = t.segments[t.segments.length - 1];
        const cone = clampCone(t.contactCone, topSeg?.diameter);
        if (cone !== t.contactCone) nextTrunks[tid] = { ...t, contactCone: cone };
    }
    const nextLeaves: SupportState['leaves'] = { ...draft.leaves };
    for (const [lid, l] of Object.entries(draft.leaves)) {
        const knot = draft.knots[l.parentKnotId];
        if (!knot) continue;
        const hostDia = segmentDiameter.get(knot.parentShaftId);
        if (hostDia === undefined) continue;
        const cone = clampCone(l.contactCone, hostDia);
        if (cone && cone !== l.contactCone) nextLeaves[lid] = { ...l, contactCone: cone };
    }

    const nextBranches: SupportState['branches'] = { ...draft.branches };
    for (const [bid, b] of Object.entries(draft.branches)) {
        const firstSeg = b.segments[0];
        const cone = clampCone(b.contactCone, firstSeg?.diameter);
        if (cone !== b.contactCone) nextBranches[bid] = { ...b, contactCone: cone };
    }

    if (!changed) return draft;
    return { ...draft, trunks: nextTrunks, leaves: nextLeaves, branches: nextBranches };
}

/** Validate leaves/branches host attachment after forest resize; cull orphans and return them for reporting. */
export function validateAndCullOrphans(
    draft: SupportState,
    mesh: THREE.Mesh | undefined,
): { draft: SupportState; orphans: OrphanInfo[] } {
    const orphans: OrphanInfo[] = [];
    const DRIFT_TOL_SQ = 0.25; // 0.5mm
    let nextDraft: SupportState = draft;
    const knotsToRemove = new Set<string>();
    const trunksToRemove = new Set<string>();

    // Trunk shafts that pierce the mesh (zig-zag trunks that crash) — cull the whole pillar
    if (mesh) {
        for (const [tid, trunk] of Object.entries(nextDraft.trunks)) {
            // Anchor trunks are vertical pillars — any segment that is blocked (excluding the tip contact itself)
            // is a mis-placed pillar that would print through the model.
            let blocked = false;
            for (const seg of trunk.segments) {
                const start = seg.bottomJoint?.pos;
                const end = seg.topJoint?.pos;
                if (!start || !end) continue;
                const radius = (seg.diameter ?? 1.0) / 2;
                // Offset the check slightly inward from the tip so the contact itself is not counted as blocked
                const tip = trunk.contactCone?.pos ?? end;
                const checkEnd = {
                    x: end.x * 0.9 + tip.x * 0.1,
                    y: end.y * 0.9 + tip.y * 0.1,
                    z: end.z * 0.9 + tip.z * 0.1,
                };
                // Use a slightly larger radius for the check to catch near-misses that render as crash
                if (isShaftBlocked(start, checkEnd, radius + 0.15, mesh)) {
                    blocked = true;
                    break;
                }
            }
            if (blocked) {
                const tip = trunk.contactCone?.pos;
                const where = tip ? ` @ (${tip.x.toFixed(1)}, ${tip.y.toFixed(1)}, Z${tip.z.toFixed(1)})` : '';
                orphans.push({ id: tid, kind: 'trunk', reason: 'trunkBlocked', detail: `trunk shaft pierces mesh${where}` });
                trunksToRemove.add(tid);
            }
        }
    }
    const checkAttachment = (
        id: string,
        kind: 'leaf' | 'branch',
        parentKnotId: string | undefined,
        tipPos: { x: number; y: number; z: number } | undefined,
    ) => {
        if (!parentKnotId) {
            orphans.push({ id, kind, reason: 'missingKnot', detail: 'no parentKnotId' });
            return false;
        }
        const knot = nextDraft.knots[parentKnotId];
        if (!knot) {
            orphans.push({ id, kind, reason: 'missingKnot', knotId: parentKnotId, detail: 'knot not in draft' });
            return false;
        }
        const host = findHostSegment(nextDraft, knot.parentShaftId);
        if (!host) {
            // parentShaftId is trunkId or missing segment (legacy or deleted host)
            const trunkExists = !!nextDraft.trunks[knot.parentShaftId];
            const reason = trunkExists ? 'missingSegment' as const : 'missingHost' as const;
            orphans.push({ id, kind, reason, hostId: knot.parentShaftId, knotId: knot.id, detail: `knot ${knot.id} parent ${knot.parentShaftId}` });
            return false;
        }
        const seg = host.segment;
        const start = seg.bottomJoint?.pos;
        const end = seg.topJoint?.pos;
        if (!start || !end) {
            orphans.push({ id, kind, reason: 'missingHost', hostId: host.trunkId, knotId: knot.id, detail: 'segment missing joints' });
            return false;
        }
        const drift2 = pointToSegmentDistanceSq(knot.pos, start, end);
        if (drift2 > DRIFT_TOL_SQ) {
            orphans.push({ id, kind, reason: 'drift', hostId: host.trunkId, knotId: knot.id, detail: `drift ${(Math.sqrt(drift2)).toFixed(2)}mm from shaft` });
            return false;
        }
        if (tipPos) {
            let blocked = false;
            if (kind === 'leaf') {
                const leafObj = nextDraft.leaves[id];
                const cone = leafObj?.contactCone;
                if (cone && mesh) {
                    const normal = cone.normal ?? { x: 0, y: 0, z: -1 };
                    const surfaceNormal = cone.surfaceNormal;
                    blocked = leafConeCollides(knot.pos, { pos: cone.pos, normal, surfaceNormal }, mesh);
                } else if (mesh) {
                    blocked = isShaftBlocked(knot.pos, tipPos, 0.2, mesh);
                }
            } else {
                const branchObj = nextDraft.branches[id];
                if (branchObj && mesh) {
                    // @ts-ignore — Branch satisfies {segments}
                    blocked = branchCollidesWithSDF(branchObj, mesh);
                } else if (mesh) {
                    blocked = isShaftBlocked(knot.pos, tipPos, 0.2, mesh);
                }
            }
            if (blocked) {
                orphans.push({ id, kind, reason: 'blocked', hostId: host.trunkId, knotId: knot.id, detail: 'knot→tip blocked by mesh' });
                return false;
            }
            // Shallow leaf/branch guard: after resize/rehost a leaf can drift to ~90°
            // from vertical (knot and tip end up at similar height). That reads
            // as a horizontal arm and prints poorly — cull it as "too shallow"
            // so it shows in the report instead of as a visible shallow leaf.
            if (tipPos) {
                const vDist = tipPos.z - knot.pos.z;
                const hDist = Math.hypot(tipPos.x - knot.pos.x, tipPos.y - knot.pos.y);
                const angleDeg = (Math.atan2(hDist, Math.max(0.001, vDist)) * 180) / Math.PI;
                // Post-resize drift can push a leaf to ~90° (horizontal). Use a
                // permissive 75° ceiling here (same as chunk consolidation) so
                // a leaf that was valid at placement (≤45°) and drifted to ~63°
                // stays as "cross" (kept), while a true 90° shallow leaf is culled.
                const maxAngle = 75;
                if (vDist < 0.4 || angleDeg > maxAngle + 1e-6) {
                    orphans.push({ id, kind, reason: 'blocked', hostId: host.trunkId, knotId: knot.id, detail: `too shallow ${angleDeg.toFixed(1)}° > ${maxAngle}° (h=${hDist.toFixed(1)} v=${vDist.toFixed(1)})` });
                    return false;
                }
            }
            if (leafPathCrossesSupports(knot.pos, tipPos, 0.25, nextDraft, host.trunkId)) {
                orphans.push({ id, kind, reason: 'cross', hostId: host.trunkId, knotId: knot.id, detail: 'leaf/branch crosses another shaft after thickening' });
                return true;
            }
        }
        return true;
    };

    const leavesToRemove = new Set<string>();
    for (const [lid, leaf] of Object.entries(nextDraft.leaves)) {
        const tipPos = leaf.contactCone?.pos;
        const ok = checkAttachment(lid, 'leaf', leaf.parentKnotId, tipPos);
        if (!ok) leavesToRemove.add(lid);
    }
    const branchesToRemove = new Set<string>();
    for (const [bid, branch] of Object.entries(nextDraft.branches)) {
        const tipPos = branch.contactCone?.pos;
        const ok = checkAttachment(bid, 'branch', branch.parentKnotId, tipPos);
        if (!ok) branchesToRemove.add(bid);
    }
    // Leaves/branches whose host trunk was culled (trunkBlocked) are also orphaned
    for (const [lid, leaf] of Object.entries(nextDraft.leaves)) {
        if (leavesToRemove.has(lid)) continue;
        const knot = nextDraft.knots[leaf.parentKnotId];
        if (!knot) continue;
        const host = findHostSegment(nextDraft, knot.parentShaftId);
        if (host && trunksToRemove.has(host.trunkId)) {
            orphans.push({ id: lid, kind: 'leaf', reason: 'missingHost', hostId: host.trunkId, knotId: knot.id, detail: 'host trunk culled (blocked)' });
            leavesToRemove.add(lid);
        } else if (trunksToRemove.has(knot.parentShaftId)) {
            orphans.push({ id: lid, kind: 'leaf', reason: 'missingHost', hostId: knot.parentShaftId, knotId: knot.id, detail: 'host trunk culled (blocked)' });
            leavesToRemove.add(lid);
        }
    }
    for (const [bid, branch] of Object.entries(nextDraft.branches)) {
        if (branchesToRemove.has(bid)) continue;
        const knot = nextDraft.knots[branch.parentKnotId];
        if (!knot) continue;
        const host = findHostSegment(nextDraft, knot.parentShaftId);
        if (host && trunksToRemove.has(host.trunkId)) {
            orphans.push({ id: bid, kind: 'branch', reason: 'missingHost', hostId: host.trunkId, knotId: knot.id, detail: 'host trunk culled (blocked)' });
            branchesToRemove.add(bid);
        } else if (trunksToRemove.has(knot.parentShaftId)) {
            orphans.push({ id: bid, kind: 'branch', reason: 'missingHost', hostId: knot.parentShaftId, knotId: knot.id, detail: 'host trunk culled (blocked)' });
            branchesToRemove.add(bid);
        }
    }

    if (leavesToRemove.size === 0 && branchesToRemove.size === 0 && trunksToRemove.size === 0) {
        return { draft: nextDraft, orphans };
    }

    // Collect knots that are only used by culled leaves/branches
    const remainingKnotUsers = new Map<string, number>();
    for (const leaf of Object.values(nextDraft.leaves)) {
        if (leavesToRemove.has(leaf.id)) continue;
        const kid = leaf.parentKnotId;
        if (kid) remainingKnotUsers.set(kid, (remainingKnotUsers.get(kid) ?? 0) + 1);
    }
    for (const branch of Object.values(nextDraft.branches)) {
        if (branchesToRemove.has(branch.id)) continue;
        const kid = branch.parentKnotId;
        if (kid) remainingKnotUsers.set(kid, (remainingKnotUsers.get(kid) ?? 0) + 1);
    }
    // Brace knots are separate — never cull a knot that is a brace endpoint
    for (const brace of Object.values(nextDraft.braces)) {
        remainingKnotUsers.set(brace.startKnotId, (remainingKnotUsers.get(brace.startKnotId) ?? 0) + 1);
        remainingKnotUsers.set(brace.endKnotId, (remainingKnotUsers.get(brace.endKnotId) ?? 0) + 1);
    }

    for (const lid of leavesToRemove) {
        const leaf = nextDraft.leaves[lid];
        const kid = leaf.parentKnotId;
        if (kid && !remainingKnotUsers.has(kid)) knotsToRemove.add(kid);
    }
    for (const bid of branchesToRemove) {
        const branch = nextDraft.branches[bid];
        const kid = branch.parentKnotId;
        if (kid && !remainingKnotUsers.has(kid)) knotsToRemove.add(kid);
    }
    // Knots on removed trunks
    const segmentIdsToRemove = new Set<string>();
    for (const tid of trunksToRemove) {
        const trunk = nextDraft.trunks[tid];
        if (trunk) for (const seg of trunk.segments) segmentIdsToRemove.add(seg.id);
    }
    for (const [kid, knot] of Object.entries(nextDraft.knots)) {
        if (segmentIdsToRemove.has(knot.parentShaftId) || trunksToRemove.has(knot.parentShaftId)) {
            if (!remainingKnotUsers.has(kid)) knotsToRemove.add(kid);
        }
    }

    const nextLeaves = { ...nextDraft.leaves };
    for (const id of leavesToRemove) delete nextLeaves[id];
    const nextBranches = { ...nextDraft.branches };
    for (const id of branchesToRemove) delete nextBranches[id];
    const nextKnots = { ...nextDraft.knots };
    for (const id of knotsToRemove) delete nextKnots[id];
    const nextTrunks: SupportState['trunks'] = { ...nextDraft.trunks };
    for (const id of trunksToRemove) delete (nextTrunks as Record<string, unknown>)[id];
    const nextRoots: SupportState['roots'] = { ...nextDraft.roots } as SupportState['roots'];
    for (const tid of trunksToRemove) {
        const trunk = draft.trunks[tid];
        const rootId = trunk?.rootId;
        if (rootId && (nextRoots as Record<string, unknown>)[rootId]) {
            const stillUsed = Object.values(nextTrunks).some((t) => t.rootId === rootId);
            if (!stillUsed) delete (nextRoots as Record<string, unknown>)[rootId];
        }
    }

    nextDraft = { ...nextDraft, leaves: nextLeaves, branches: nextBranches, knots: nextKnots, trunks: nextTrunks, roots: nextRoots } as SupportState;
    return { draft: nextDraft, orphans };
}

export function fanLeafToTrunk(
    target: { x: number; y: number; z: number },
    modelId: string,
    shaftPoints: FanShaftPoint[],
    gridTrunkIds: ReadonlySet<string>,
    knotIdPrefix: string,
    fanRadiusMm: number,
    gridHostFanRadiusMm: number,
    maxAngleDeg: number,
    maxAttachments: number,
    draft: SupportState,
    mesh: THREE.Mesh | undefined,
    origin?: SupportOrigin,
): FanLeafResult {
    // Single pass over the shaft pool: the STEEPEST sample that is ELIGIBLE
    // (grid trunks host only up close) and geometrically VALID (not same-Z,
    // within the max angle from vertical) wins. The nearest sample alone is
    // not enough — it sits at the shallowest valid angle (the "knot at the
    // junction" look); the steepest sample in reach reads as a real branch.
    const candidates: Array<{ sp: FanShaftPoint; dist2: number; angleDeg: number }> = [];
    let refusal: FanLeafRefusal = 'noHost';

    for (const sp of shaftPoints) {
        const isGrid = gridTrunkIds.has(sp.trunkId);
        const limit = isGrid ? gridHostFanRadiusMm : fanRadiusMm;
        const ddx = sp.pos.x - target.x;
        const ddy = sp.pos.y - target.y;
        const ddz = sp.pos.z - target.z;
        const dist2 = ddx * ddx + ddy * ddy + ddz * ddz;
        if (dist2 > limit * limit) continue;

        // The leaf must RISE: the host sample must sit below the target tip.
        // absVDist here was the bug — it let leaves attach from a sample ABOVE
        // the tip, hanging downward (upside-down leaves that read as shallow).
        const vDist = target.z - sp.pos.z;
        if (vDist < 0.4) {
            // A real vertical drop is required. The ANGLE limit is the real
            // shallowness guard (75° needs drop ≥ 0.27 × lateral); this floor
            // only rejects same-height neighbours whose drop rounds to zero.
            if (refusal === 'noHost') refusal = 'sameZ';
            continue;
        }
        const angleDeg = (Math.atan2(Math.sqrt(ddx * ddx + ddy * ddy), vDist) * 180) / Math.PI;
        if (angleDeg > maxAngleDeg) {
            if (refusal === 'noHost') refusal = 'angle';
            continue;
        }
        candidates.push({ sp, dist2, angleDeg });
    }
    if (candidates.length === 0) return { ok: false, reason: refusal };

    // Steepest first; distance breaks ties.
    candidates.sort((a, b) => a.angleDeg - b.angleDeg || a.dist2 - b.dist2);

    // Try each candidate until one clears blocked/cross/capacity/build.
    let lastBlockedReason: FanLeafRefusal | null = null;
    for (const { sp, dist2, angleDeg } of candidates) {
        const parentKnot = {
            id: knotIdPrefix,
            parentShaftId: sp.segmentId ?? sp.trunkId,
            t: sp.t,
            pos: sp.pos,
            diameter: sp.diameter + 0.125,
        };
        if (mesh && isShaftBlocked(sp.pos, target, 0.2, mesh)) {
            lastBlockedReason = 'blocked';
            continue;
        }

        let leaf;
        try {
            const resolved = resolveSurfaceNormal(target, mesh ?? undefined);
            const built = buildLeafData({
                tipPos: resolved.point,
                surfaceNormal: resolved.normal,
                modelId,
                parentKnot,
                hostDiameterMm: sp.diameter,
                tipContactDiameterMm: activeSizingBand().tipContactDiameterMm,
                mesh: mesh ?? undefined,
            });
            if (built.supportData.error) {
                lastBlockedReason = 'build';
                continue;
            }
            leaf = built.leaf;
        } catch {
            lastBlockedReason = 'build';
            continue;
        }

        if (leafPathCrossesSupports(
            parentKnot.pos,
            leaf.contactCone?.pos ?? target,
            0.25,
            draft,
            sp.trunkId,
        )) {
            lastBlockedReason = 'cross';
            continue;
        }
        if (maxAttachments > 0 && isTrunkAtAttachmentCapacity(sp.trunkId, maxAttachments, draft)) {
            lastBlockedReason = 'capacity';
            continue;
        }

        const next = draftAddKnot(draft, parentKnot);
        if (origin) leaf.origin = origin;
        return {
            ok: true,
            draft: draftAddLeaf(next, leaf),
            trunkId: sp.trunkId,
            leafId: leaf.id,
            distMm: Math.sqrt(dist2),
            angleDeg,
        };
    }
    return { ok: false, reason: lastBlockedReason ?? refusal };
}

// ---------------------------------------------------------------------------
// Forest Report
// ---------------------------------------------------------------------------
// A structured per-run summary of the placed forest: every support's id, size,
// and sizing reasoning, plus the fan-out groups (host trunk → attached leaves
// and branches). Shown in the Auto Supports panel after a run; the per-entity
// placement log spam is off by default (see setAutoSupportVerboseLogging).

function clamp01(value: number, min: number, max: number): number {
    return Math.min(max, Math.max(min, value));
}

/** The sizing reasoning for one placed support: island area + active band + height factor. */
export function forestSizingNote(entry: ForestLedgerEntry, actualShaftMm: number): string {
    const heightFactor = 1 + clamp01((entry.zHeight - 20) / 200, 0, 0.25);
    const areaInput = Math.max(entry.areaMm2, 0.01);
    return `area ${areaInput.toFixed(2)}mm² · base Ø${entry.bandShaftMm.toFixed(2)} · h${heightFactor.toFixed(2)}` +
        ` → Ø${actualShaftMm.toFixed(2)}mm`;
}

export function buildForestReport(draft: SupportState, ledger: ForestLedgerEntry[]): ForestReport {
    const displayByEntity = new Map<string, string>();
    const entryByEntity = new Map<string, ForestLedgerEntry>();
    for (const entry of ledger) {
        displayByEntity.set(entry.entityId, entry.displayId);
        entryByEntity.set(entry.entityId, entry);
    }

    const memberById = new Map<string, { id: string; kind: 'leaf' | 'branch'; spanMm: number; angleDeg: number }>();
    const membersByHost = new Map<string, ForestTree['members']>();

    // Knots reference their host SEGMENT (or the trunk directly for legacy
    // data) — normalize to the trunk id for grouping.
    const trunkIdByShaftId = new Map<string, string>();
    for (const trunk of Object.values(draft.trunks)) {
        trunkIdByShaftId.set(trunk.id, trunk.id);
        for (const seg of trunk.segments) trunkIdByShaftId.set(seg.id, trunk.id);
    }

    const pushMember = (
        entityId: string,
        kind: 'leaf' | 'branch',
        hostShaftId: string,
        tipPos: { x: number; y: number; z: number } | undefined,
        knotPos: { x: number; y: number; z: number } | undefined,
    ) => {
        const hostTrunkId = trunkIdByShaftId.get(hostShaftId) ?? hostShaftId;
        const hDist = knotPos && tipPos ? Math.hypot(tipPos.x - knotPos.x, tipPos.y - knotPos.y) : 0;
        const vDist = knotPos && tipPos ? tipPos.z - knotPos.z : 0;
        const spanMm = knotPos && tipPos
            ? Math.hypot(tipPos.x - knotPos.x, tipPos.y - knotPos.y, tipPos.z - knotPos.z)
            : 0;
        const angleDeg = vDist > 0.01 ? (Math.atan2(hDist, vDist) * 180) / Math.PI : 90;
        const member = { id: displayByEntity.get(entityId) ?? entityId.slice(0, 8), kind, spanMm, angleDeg };
        memberById.set(entityId, member);
        const list = membersByHost.get(hostTrunkId);
        if (list) list.push(member);
        else membersByHost.set(hostTrunkId, [member]);
    };

    for (const leaf of Object.values(draft.leaves)) {
        const knot = draft.knots[leaf.parentKnotId];
        if (!knot) continue;
        pushMember(leaf.id, 'leaf', knot.parentShaftId, leaf.contactCone?.pos, knot.pos);
    }
    for (const branch of Object.values(draft.branches)) {
        const knot = draft.knots[branch.parentKnotId];
        if (!knot) continue;
        pushMember(branch.id, 'branch', knot.parentShaftId, branch.contactCone?.pos, knot.pos);
    }

    const trees: ForestTree[] = [];
    const bareTrunks: ForestReport['bareTrunks'] = [];

    for (const trunk of Object.values(draft.trunks)) {
        const shaftMm = trunk.segments[0]?.diameter ?? 0;
        const entry = entryByEntity.get(trunk.id);
        const members = membersByHost.get(trunk.id);
        if (members && members.length > 0) {
            trees.push({
                hostId: displayByEntity.get(trunk.id) ?? trunk.id.slice(0, 8),
                hostZ: trunk.contactCone?.pos?.z ?? 0,
                shaftDiameterMm: shaftMm,
                sizingNote: entry ? forestSizingNote(entry, shaftMm) : '',
                members,
            });
        } else {
            bareTrunks.push({
                id: displayByEntity.get(trunk.id) ?? trunk.id.slice(0, 8),
                z: trunk.contactCone?.pos?.z ?? 0,
                shaftDiameterMm: shaftMm,
                sizingNote: entry ? forestSizingNote(entry, shaftMm) : '',
            });
        }
    }

    trees.sort((a, b) => b.members.length - a.members.length);
    bareTrunks.sort((a, b) => a.z - b.z);

    return {
        trunkCount: Object.keys(draft.trunks).length,
        anchorCount: Object.keys(draft.anchors).length,
        leafCount: Object.keys(draft.leaves).length,
        branchCount: Object.keys(draft.branches).length,
        stickCount: Object.keys(draft.sticks).length,
        twigCount: Object.keys(draft.twigs).length,
        trees,
        bareTrunks,
    };
}

/** Plain-text rendering of the forest report (copy-to-clipboard format). */
export function forestReportToText(report: ForestReport): string {
    const lines: string[] = [];
    lines.push('FOREST REPORT');
    lines.push('─────────────');
    const s = report.scan;
    if (s) {
        lines.push('SCAN');
        lines.push(`  ${s.islands} islands ` +
            `(voxel ${s.bySource.voxel} · minima ${s.bySource.minima} · intersection ${s.bySource.intersection} · overhang ${s.bySource.overhang}) ` +
            `→ ${s.candidates} candidates · ${s.overhangRegions} overhang regions · ` +
            `coverage ${s.coveragePercent.toFixed(0)}% of ${s.totalAreaMm2.toFixed(0)}mm² (${s.uncoveredIslands} uncovered) · ${s.rejected} rejected`);
        // Justification: what scan means
        lines.push(`  → ${s.candidates} candidates after dedup/filter from ${s.islands} islands (fixed-density ring + grid infill)`);
        lines.push('');
    }
    if (report.orphans && report.orphans.length > 0) {
        lines.push('ORPHANS CULLED');
        // Group by reason with justification
        const byReason = new Map<string, typeof report.orphans>();
        for (const o of report.orphans) {
            const list = byReason.get(o.reason);
            if (list) list.push(o);
            else byReason.set(o.reason, [o]);
        }
        const reasonHelp: Record<string, string> = {
            trunkBlocked: 'shaft pierces mesh (vertical pillar would print through model)',
            blocked: 'knot→tip ray hits mesh (leaf/branch would go through model)',
            missingHost: 'host segment has no joints (single-segment anchor with no top joint)',
            missingSegment: 'knot points to trunkId not segmentId (legacy, rehost failed)',
            missingKnot: 'parent knot not in draft (deleted host)',
            drift: 'knot drifted >0.5mm from host shaft (split offset)',
            cross: 'leaf/branch crosses another shaft after thickening (kept but flagged)',
        };
        for (const [reason, list] of byReason) {
            const help = reasonHelp[reason] ?? '';
            lines.push(`  ${list.length}× ${reason}${help ? ` — ${help}` : ''}`);
        }
        for (const o of report.orphans) {
            lines.push(`    ${o.id} (${o.kind}) ${o.reason}${o.hostId ? ` @${o.hostId.slice(0, 8)}` : ''}${o.knotId ? ` knot ${o.knotId.slice(0, 8)}` : ''}${o.detail ? ` — ${o.detail}` : ''}`);
        }
        lines.push('');
    }
    if (report.diagnostics) {
        const d = report.diagnostics;
        lines.push('PLACEMENT DIAGNOSTICS');
        lines.push(`  Trunks by kind: grid ${d.trunksByKind.gridInfill} (ring + infill), gap-fill ${d.trunksByKind.coverageFill}, standalone ${d.trunksByKind.standalone} (sub-threshold overhang, no host)`);
        lines.push(`  Candidates by source: voxel ${d.candidatesBySource.voxel} · minima ${d.candidatesBySource.minima} · intersection ${d.candidatesBySource.intersection} · overhang ${d.candidatesBySource.overhang}`);
        const fanEntries = Object.entries(d.fanRefusals).filter(([, v]) => v);
        const mergeEntries = Object.entries(d.mergeRefusals).filter(([, v]) => v);
        if (fanEntries.length > 0 || mergeEntries.length > 0) {
            const fanStr = fanEntries.length > 0 ? fanEntries.map(([k, v]) => `${k}=${v}`).join(', ') : 'none';
            const mergeStr = mergeEntries.length > 0 ? mergeEntries.map(([k, v]) => `${k}=${v}`).join(', ') : 'none';
            const fanMaxDeg = getSettings().autoSupport?.leafFanMaxAngleDeg ?? LEAF_FAN_MAX_ANGLE_DEG;
            lines.push(`  Fan refusals: ${fanStr} (noHost=too far >5mm/2.5mm grid, angle=>${fanMaxDeg}° too flat, sameZ|cross|blocked|capacity=host full)`);
            const conEntries = Object.entries(d.consolidationRefusals ?? {}).filter(([, v]) => v);
            if (conEntries.length > 0) {
                const conStr = conEntries.map(([k, v]) => `${k}=${v}`).join(', ');
                lines.push(`  Consolidation refusals: ${conStr} (sameZ=surface too flat for side-leaves — chunking needs ≥0.4 mm neighbour height rise)`);
            }
            lines.push(`  Merge refusals: ${mergeStr} (noHost=no trunk within 4mm, rejected=host at capacity or collision)`);
        } else {
            lines.push(`  Fan/Merge refusals: none (all fanned or standalone)`);
        }
        if (d.cavityFallbacks && d.cavityFallbacks.length > 0) {
            lines.push(`  Cavity fallbacks: ${d.cavityFallbacks.length} — trunk could not reach the plate (bridged model-to-model)`);
            for (const fb of d.cavityFallbacks.slice(0, 20)) {
                const fanNote = fb.fanRefusal ? ` fan:${fb.fanRefusal}` : ' fan:—';
                lines.push(`    ${fb.id} (${fb.kind}) @ (${fb.tip.x.toFixed(1)}, ${fb.tip.y.toFixed(1)}, Z${fb.tip.z.toFixed(1)})${fanNote}`);
            }
        }
        lines.push('');
    }
    lines.push(`${report.trunkCount} trunks · ${report.leafCount} leaves · ${report.branchCount} branches · ` +
        `${report.bareTrunks.length} bare trunks`);
    if (report.trees.length > 0) {
        lines.push('');
        lines.push('FAN-OUT GROUPS');
        lines.push(`  (host trunk → leaves/branches within 5mm fan radius, 2.5mm for grid hosts, <${getSettings().autoSupport?.leafFanMaxAngleDeg ?? LEAF_FAN_MAX_ANGLE_DEG}° from vertical, not blocked/crossing, not at capacity)`);
        for (const tree of report.trees) {
            const members = tree.members
                .map((m) => `${m.id}(${m.kind === 'leaf' ? 'L' : 'B'} ${m.spanMm.toFixed(1)}mm/${m.angleDeg.toFixed(0)}°)`)
                .join(' ');
            lines.push(`  ${tree.hostId} @ Z=${tree.hostZ.toFixed(1)}mm Ø${tree.shaftDiameterMm.toFixed(2)}mm ` +
                (tree.sizingNote ? `[${tree.sizingNote}] ` : '') +
                `→ ${tree.members.length}: ${members}`);
        }
    }
    if (report.bareTrunks.length > 0) {
        lines.push('');
        lines.push('STANDALONE TRUNKS');
        lines.push(`  (no host within fan radius — 1:1 pillar; grid-/fill- = region ring + infill, v/m = standalone voxel/minima)`);
        for (const trunk of report.bareTrunks) {
            const id = trunk.id;
            let why = '';
            if (id.startsWith('grid-') || id.startsWith('fill-')) why = ' — region ring + grid infill';
            else if (id.startsWith('v') || id.startsWith('m')) why = ' — standalone voxel/minima (below threshold or consolidated)';
            lines.push(`  ${trunk.id} @ Z=${trunk.z.toFixed(1)}mm Ø${trunk.shaftDiameterMm.toFixed(2)}mm ` +
                (trunk.sizingNote ? `[${trunk.sizingNote}]` : '') + why);
        }
    }
    return lines.join('\n');
}

export function computeAutoSupportPlan(
    islands: DetectedIsland[],
    modelId: string,
    settingsOverride?: Partial<AutoSupportSettings>,
    baseState?: SupportState,
    baseKickstand?: KickstandState,
    mesh?: THREE.Mesh,
): AutoSupportPlan | null {
    // ------------------------------------------------------------------
    // 0. Settings
    // ------------------------------------------------------------------

    const autoSettings = normalizeAutoSupportSettings(settingsOverride ?? undefined);

    if (!autoSettings.enabled) {
        return null;
    }

    const before = baseState ?? structuredClone(getSnapshot());
    const kickstandBefore = baseKickstand ?? structuredClone(getKickstandSnapshot());
    let draft: SupportState = before;
    let kickstandDraft: KickstandState = kickstandBefore;

    // Trunks placed from density-grid cells — fanning hosts only up close.
    const gridTrunkIds = new Set<string>();

    // Early-exit no-op plan (no candidates / nothing to place): the run
    // reported as unchanged, so the caller commits nothing.
    const noopPlan = (result: AutoPlaceResult): AutoSupportPlan => ({
        before,
        kickstandBefore,
        support: draft,
        kickstand: kickstandDraft,
        analytics: {
            islandsCovered: 0,
            islandsUncovered: islands.length,
            presets: { detail: 0, structure: 0, anchor: 0 },
            rejectionReasons: {},
            areaCoverage: 0,
        },
        result,
    });

    // The model mesh is needed by the grid phase (surface snapping) and the
    // placement pipeline (pathfinding + collision).
    const resolvedMesh: THREE.Mesh | undefined = mesh ?? (getModelMesh(modelId) ?? undefined);
    if (resolvedMesh) resolvedMesh.updateMatrixWorld();

    // ------------------------------------------------------------------
    // 1. Generate candidates
    // ------------------------------------------------------------------

    console.log(LOG_PREFIX, `Input: ${islands.length} islands from scan`);

    let candidates = generateCandidates(islands, autoSettings);
    candidates = candidates.map((c): CandidatePoint => ({ ...c, modelId }));

    // Candidate generation phase: every overhang region above the threshold
    // gets the unified fixed-density distribution (2D-projected boundary ring
    // + grid infill). Shape decides the degenerate cases — slivers get a ring
    // only, small patches stay on the single-candidate path below. A
    // generation failure must not kill the whole run — fall back to the
    // region's single candidate.
    const overhangIslands = islands.filter((i) => i.source === 'overhang');
    const eligible = overhangIslands.filter((i) => (i.areaMm2 ?? 0) >= autoSettings.gridAreaThresholdMm2);
    if (eligible.length > 0) {
        let generated: CandidatePoint[] = [];
        try {
            generated = generateGridCandidates(eligible, autoSettings, resolvedMesh)
                .map((c): CandidatePoint => ({ ...c, modelId }));
        } catch (e) {
            console.error(LOG_PREFIX,
                `Candidate generation failed — falling back to per-region candidates.`,
                e instanceof Error ? e.message : String(e));
        }
        const generatedRegionIds = new Set(eligible.map((i) => i.id));
        if (generated.length > 0) {
            candidates = [
                ...generated,
                ...candidates.filter((c) => !generatedRegionIds.has(c.id)),
            ];
        }
    }

    console.log(LOG_PREFIX,
        `Step 1/3: ${candidates.length} candidates generated ` +
        `(filtered from ${islands.length} islands, min area ${autoSettings.minIslandAreaMm2}mm², ` +
        `grid: ${autoSettings.areaPerSupportMm2}mm²/support @ ${autoSettings.gridAreaThresholdMm2}mm² threshold)`);
    if (candidates.length === 0) {
        return noopPlan(makeResult(0, 0, 0, 0, 0, 0, false, 'No viable support candidates found.'));
    }

    // ------------------------------------------------------------------
    // 2. Deduplicate
    // ------------------------------------------------------------------

    const beforeDedup = candidates.length;
    candidates = deduplicateCandidates(candidates, autoSettings);

    console.log(LOG_PREFIX,
        `Step 2/3: ${candidates.length} candidates after dedup ` +
        `(removed ${beforeDedup - candidates.length} within ${autoSettings.tipInfluenceRadiusMm}mm radius)`);

    if (candidates.length === 0) {
        return noopPlan(makeResult(0, 0, 0, 0, 0, 0, false, 'All candidates deduplicated — nothing to place.'));
    }

    // ------------------------------------------------------------------
    // 2b. Filter out already-supported positions
    // ------------------------------------------------------------------

    const beforeSupportFilter = candidates.length;
    candidates = filterAlreadySupported(candidates, draft);
    console.log(LOG_PREFIX,
        `Step 2b: ${candidates.length} candidates after support filter ` +
        `(removed ${beforeSupportFilter - candidates.length} already supported within ${ALREADY_SUPPORTED_RADIUS_MM}mm)`);

    if (candidates.length === 0) {
        return noopPlan(makeResult(0, 0, 0, 0, 0, 0, false,
            'All candidate positions already have supports.'));
    }

    // ------------------------------------------------------------------
    // 3. Place candidates through the standard pipeline
    // ------------------------------------------------------------------
    // Each candidate goes through resolveNormal → buildTrunkData →
    // decideGridPlacement.  State is committed after each placement so
    // subsequent candidates see existing supports (enabling organic
    // tree fan-out via grid occupancy).

    console.log(LOG_PREFIX,
        `Mesh for ${modelId}: ${resolvedMesh ? 'available (pathfinding + SDF active)' : 'UNAVAILABLE (supports route straight, no collision avoidance)'}`);

    const gridEnabled = getSettings().grid?.enabled;
    console.log(LOG_PREFIX,
        `Grid mode: ${gridEnabled ? 'ENABLED (supports share grid nodes, branch/leaf fan-out active)' : 'DISABLED (all supports become standalone trunks)'}`);

    // ── Model sizing context (mesh volume/top-Z for the debug analytics) ──
    let modelCtx: ModelSizingContext | undefined;
    if (resolvedMesh) {
        const bbox = new THREE.Box3().setFromObject(resolvedMesh);
        modelCtx = {
            modelVolumeMm3: computeMeshVolumeMm3(resolvedMesh),
            modelZMaxMm: bbox.max.z,
            totalCandidates: candidates.length,
        };
    }

    let placedTrunks = 0;
    let placedAnchors = 0;
    let placedBranches = 0;
    let placedLeaves = 0;
    let placedSticks = 0;
    let rejectedCount = 0;

    // Placement-path diagnostics: where each placed trunk came from and why
    // non-fanned candidates didn't fan/merge. Pure counts — no physics.
    const diagnostics: PlacementDiagnostics = {
        candidatesBySource: { voxel: 0, minima: 0, intersection: 0, overhang: 0 },
        trunksByKind: { gridInfill: 0, coverageFill: 0, standalone: 0 },
        fanRefusals: {},
        mergeRefusals: {},
        cavityFallbacks: [],
    };
    // Consolidation (chunk fanning) refusal tallies — hoisted so the forest
    // report can surface them even when the resize pass re-scopes.
    const conRefusals: Partial<Record<FanLeafRefusal, number>> = {};
    // Trunk id → origin kind, so the consolidation pass can adjust the tallies
    // when it converts a standalone grid pillar into a fan leaf.
    const trunkOriginById = new Map<string, 'gridInfill' | 'coverageFill'>();
    // Per-placed-entity ledger for the Forest Report (display id, sizing inputs).
    const forestLedger: ForestLedgerEntry[] = [];

    // Analytics accumulators
    const presets = { detail: 0, structure: 0, anchor: 0 };
    const rejectionReasons: Record<string, number> = {};

    // Step 3 is wrapped in a rollback guard: state is committed per-candidate,
    // so an uncaught failure mid-run would otherwise leave partial supports in
    // the store with no history entry to undo them.
    let analytics!: AutoPlaceAnalytics;
    try {
    // Per-candidate placement, shared by the main pass and the coverage
    // convergence (gap-fill) passes. Each placement advances the local draft
    // (no store commit) so later candidates see earlier supports.
    const placeOne = (candidate: CandidatePoint): string => {
        try {
            const result = placeOneCandidate(candidate, draft, settingsOverride, gridTrunkIds);
            draft = result.draft;
            if (result.kickstand) kickstandDraft = result.kickstand;
            if (candidate.gridPoint && result.kind === 'trunk' && result.entityId) {
                gridTrunkIds.add(result.entityId);
            }
            switch (result.kind) {
                case 'trunk':   placedTrunks++; break;
                case 'anchor':  placedAnchors++; break;
                case 'branch':  placedBranches++; break;
                case 'leaf':    placedLeaves++; break;
                case 'stick':
                case 'twig':
                    // Cavity fallback: the trunk could not reach the plate, so
                    // we bridged model-to-model. Report WHERE, so avoidable
                    // bridges are visible instead of buried in a count.
                    diagnostics.cavityFallbacks.push({
                        id: candidate.id,
                        kind: result.kind,
                        tip: candidate.tipPos,
                        fanRefusal: (result as { cavityFanRefusal?: string }).cavityFanRefusal,
                    });
                    if (result.kind === 'stick') placedSticks++;
                    break;
                case 'reject':
                    rejectedCount++;
                    if (result.rejectedReason) {
                        rejectionReasons[result.rejectedReason] = (rejectionReasons[result.rejectedReason] ?? 0) + 1;
                    }
                    break;
            }
            if (result.preset) presets[result.preset]++;

            // Placement-path diagnostics: where each candidate ended up.
            diagnostics.candidatesBySource[candidate.source] =
                (diagnostics.candidatesBySource[candidate.source] ?? 0) + 1;
            if (result.kind === 'trunk' && result.entityId) {
                if (candidate.gridPoint) {
                    {
                        diagnostics.trunksByKind.gridInfill++;
                        trunkOriginById.set(result.entityId, 'gridInfill');
                    }
                } else {
                    diagnostics.trunksByKind.standalone++;
                }
            }
            if (result.fanRefusal) {
                diagnostics.fanRefusals[result.fanRefusal] = (diagnostics.fanRefusals[result.fanRefusal] ?? 0) + 1;
            }
            if (result.mergeRefusal) {
                diagnostics.mergeRefusals[result.mergeRefusal] = (diagnostics.mergeRefusals[result.mergeRefusal] ?? 0) + 1;
            }
            if (result.kind !== 'reject' && result.entityId) {
                forestLedger.push({
                    displayId: candidate.id,
                    kind: result.kind as ForestLedgerEntry['kind'],
                    entityId: result.entityId,
                    areaMm2: candidate.islandAreaMm2,
                    zHeight: candidate.zHeight,
                    preset: result.preset ?? presetForArea(candidate.islandAreaMm2),
                    bandShaftMm: activeSizingBand().shaftDiameterMm,
                });
            }
            return result.kind;
        } catch (e) {
            rejectedCount++;
            rejectionReasons['exception'] = (rejectionReasons['exception'] ?? 0) + 1;
            console.warn(LOG_PREFIX,
                `Exception placing ${candidate.id}: ${e instanceof Error ? e.message : String(e)}`);
            return 'reject';
        }
    };

    for (const candidate of candidates) {
        placeOne(candidate);
    }

    // ── Overhang→tree consolidation (order-independent) ──────────────
    // A BARE overhang-origin trunk (organic Poisson, coverage fill,
    // sub-threshold single) whose tip is within the consolidation fan radius
    // of a valid host is converted into a fan leaf — whether the host placed
    // before or after it, the junction reads as a tree. The radius is wider
    // than the regular fanning radius (8 mm) so overhang trunks 5–8 mm from
    // an island trunk still merge, and the angle is relaxed to 75° so
    // neighbours on shallow surfaces can chunk (see below). Same-height
    // pillars (vDist ≈ 0) still cannot fan and stay as their own trunks.
    const CONSOLIDATION_FAN_RADIUS_MM = 8;
    // Routed consolidation branches only above this height — near the plate
    // they read as a zig-zag spiderweb; high up they read as trees.
    const CONSOLIDATION_BRANCH_MIN_HEIGHT_MM = 10;
    const conFanRadiusMm = Math.max(autoSettings.leafFanRadiusMm ?? LEAF_FAN_RADIUS_MM, CONSOLIDATION_FAN_RADIUS_MM);
    // Chunk links may be shallower than placement fans (75° floor vs the
    // leafFanMaxAngleDeg gate, now 45° from vertical): on a surface sloped
    // <45° from horizontal, neighbouring pillars can NEVER satisfy the fan
    // rule (the link angle is always 90° − surface slope), so chunking would
    // be geometrically impossible.
    // The chunk's interior hosts carry the load; the shallow links are the
    // connective tissue that makes supports release in chunks.
    const conFanMaxAngleDeg = Math.max(
        autoSettings.leafFanMaxAngleDeg ?? LEAF_FAN_MAX_ANGLE_DEG,
        75,
    );
    let consolidated = 0;
    for (let pass = 0; pass < 3; pass++) {
        let convertedThisPass = 0;
        for (const tid of Object.keys(draft.trunks)) {
            // Convertible: ring + grid infill, coverage fill, and
            // sub-threshold overhang singles — the overhang forest reads as
            // TREES: neighbouring pillars fan into each other so supports
            // release in chunks (one plate contact per chunk). Chunk size is
            // bounded by maxAttachmentsPerTrunk; anchors (near-plate) and
            // island trunks are never converted.
            const originKind = trunkOriginById.get(tid);
            const isConvertible = draft.trunks[tid].origin !== 'anchor'
                && (originKind === 'gridInfill'
                    || originKind === 'coverageFill'
                    || draft.trunks[tid].origin === 'standalone');
            if (!isConvertible) continue;
            if (countAttachmentsOnTrunk(tid, draft) > 0) continue;
            const trunk = draft.trunks[tid];
            const tip = trunk.contactCone?.pos;
            if (!tip) continue;
            const tipNormal = trunk.contactCone?.normal ?? { x: 0, y: 0, z: -1 };
            const pruned: SupportState = {
                ...draft,
                trunks: { ...draft.trunks },
                roots: { ...draft.roots },
            };
            delete pruned.trunks[tid];
            delete pruned.roots[trunk.rootId];
            const pool = collectFanShaftPoints(pruned);
            if (pool.length === 0) break;
            const fan = fanLeafToTrunk(
                tip,
                modelId,
                pool,
                new Set(),
                `auto-con-${tid}-p${pass}`,
                conFanRadiusMm,
                GRID_HOST_FAN_RADIUS_MM,
                conFanMaxAngleDeg,
                autoSettings.maxAttachmentsPerTrunk,
                pruned,
                resolvedMesh ?? undefined,
                'overhang',
            );
            if (!fan.ok) {
                // Routed-branch fallback, HEIGHT-GATED: a straight leaf can be
                // impossible between same-height or concave-surface pillars
                // (the leaf must rise; a horizontal link is not a support),
                // and that is exactly where chunking is still wanted — tall
                // pillar forests like an under-arm row. A routed branch high
                // above the plate reads as a tree; near the plate it reads as
                // a zig-zag spiderweb, so only tips at
                // ≥ CONSOLIDATION_BRANCH_MIN_HEIGHT_MM qualify.
                const branchResult = (tip.z >= CONSOLIDATION_BRANCH_MIN_HEIGHT_MM
                    && (fan.reason === 'blocked' || fan.reason === 'cross' || fan.reason === 'sameZ'))
                    ? buildConsolidationBranch({
                        tip,
                        tipNormal,
                        modelId,
                        pool,
                        pruned,
                        mesh: resolvedMesh ?? undefined,
                        radiusMm: conFanRadiusMm,
                        maxAttachments: autoSettings.maxAttachmentsPerTrunk,
                        knotId: `auto-con-branch-${tid}`,
                    })
                    : null;
                if (branchResult) {
                    draft = branchResult.draft;
                    gridTrunkIds.delete(tid);
                    const origin = originKind ?? 'standalone';
                    diagnostics.trunksByKind[origin]--;
                    placedTrunks--;
                    placedBranches++;
                    consolidated++;
                    convertedThisPass++;
                    const trunkEntry = forestLedger.find((e) => e.entityId === tid);
                    if (trunkEntry) {
                        forestLedger.push({ ...trunkEntry, kind: 'branch', entityId: branchResult.branchId });
                    }
                    continue;
                }
                conRefusals[fan.reason] = (conRefusals[fan.reason] ?? 0) + 1;
                continue;
            }
            draft = fan.draft;
            gridTrunkIds.delete(tid);
            const origin = originKind ?? 'standalone';
            diagnostics.trunksByKind[origin]--;
            placedTrunks--;
            placedLeaves++;
            consolidated++;
            convertedThisPass++;
            const trunkEntry = forestLedger.find((e) => e.entityId === tid);
            if (trunkEntry) {
                forestLedger.push({ ...trunkEntry, kind: 'leaf', entityId: fan.leafId });
            }
        }
        if (convertedThisPass === 0) break;
    }
    if (consolidated > 0) {
        console.log(LOG_PREFIX,
            `Overhang consolidation: ${consolidated} standalone trunks merged into fan trees`);
    }

    // ── Anchor pass: none ──────────────────────────────────────────
    // Near-plate contacts place as anchor primitives upstream (tip Z below
    // ANCHOR_HEIGHT_THRESHOLD_MM) and stay standalone.

    const fmtRefusals = (r: Record<string, number | undefined>): string => {
        const entries = Object.entries(r).filter(([, v]) => v !== undefined) as Array<[string, number]>;
        return entries.length === 0 ? 'none' : entries.map(([k, v]) => `${k}=${v}`).join(', ');
    };
    console.log(LOG_PREFIX,
        `Placement: ${diagnostics.trunksByKind.gridInfill} ring+infill, ` +
        `${diagnostics.trunksByKind.coverageFill} coverage-fill, ${diagnostics.trunksByKind.standalone} standalone trunks ` +
        `| fan refusals: ${fmtRefusals(diagnostics.fanRefusals)} | merge refusals: ${fmtRefusals(diagnostics.mergeRefusals)} ` +
        `| consolidation refusals: ${fmtRefusals(conRefusals)}`);

    // ── Coverage convergence (gap-fill) ─────────────────────────────
    // Footprint-aware: an overhang region is covered when its projected
    // footprint is covered by tips, not just its centroid. Under-covered
    // regions get additional standalone trunks at uncovered footprint
    // clusters (the gridPoint path — region normal, no wrong-face raycast),
    // iterating until the coverage target is met or nothing more places.
    let gapFilledTrunks = 0;
    for (let pass = 0; pass < MAX_GAP_FILL_PASSES; pass++) {
        const tips = collectSupportTips(getSnapshot());
        const gapCandidates = buildGapFillCandidates(overhangIslands, autoSettings, tips)
            .map((c): CandidatePoint => ({ ...c, modelId }));
        if (gapCandidates.length === 0) break;
        let placedThisPass = 0;
        for (const c of gapCandidates) {
            const kind = placeOne(c);
            if (kind === 'trunk' || kind === 'anchor') placedThisPass++;
        }
        gapFilledTrunks += placedThisPass;
        if (placedThisPass === 0) break;
    }
    if (gapFilledTrunks > 0) {
        console.log(LOG_PREFIX, `Coverage convergence: ${gapFilledTrunks} gap-fill trunks placed`);
    }

    console.log(LOG_PREFIX,
        `Step 3/3: ${placedTrunks}T ${placedAnchors}A ${placedBranches}B ${placedLeaves}L ${placedSticks}S — ${rejectedCount} rejected ` +
        `| presets: detail=${presets.detail} structure=${presets.structure} anchor=${presets.anchor}`);

    // ── Coverage analytics ────────────────────────────────────────
    const snapshot = draft;
    const supportedIds = new Set<string>();
    const SUPPORT_COVERAGE_RADIUS_MM = 4.0;
    const covR2 = SUPPORT_COVERAGE_RADIUS_MM * SUPPORT_COVERAGE_RADIUS_MM;

    // Collect all support tips from the post-placement snapshot.
    const allTips: Array<{ x: number; y: number; z: number }> = [];
    for (const t of Object.values(snapshot.trunks)) {
        if (t.contactCone?.pos) allTips.push(t.contactCone.pos);
    }
    for (const b of Object.values(snapshot.branches)) {
        if (b.contactCone?.pos) allTips.push(b.contactCone.pos);
    }
    for (const l of Object.values(snapshot.leaves)) {
        if (l.contactCone?.pos) allTips.push(l.contactCone.pos);
    }
    for (const a of Object.values(snapshot.anchors)) {
        if (a.contactCone?.pos) allTips.push(a.contactCone.pos);
    }

    let coveredArea = 0;
    let totalArea = 0;
    for (const island of islands) {
        const area = island.areaMm2 ?? 0;
        totalArea += area;
        // FOOTPRINT coverage: the fraction of the region's contact voxels
        // within the support radius of a tip (the gap-fill's own measure).
        // The old centroid heuristic under-counted big regions — a 20×20
        // grid read 1% covered — which sent the fanning pass after
        // already-supported surfaces (redundant "floating" leaves).
        let fraction: number;
        if (island.contactVoxels && island.contactVoxels.count > 0) {
            fraction = computeRegionCoverage(island, allTips, SUPPORT_COVERAGE_RADIUS_MM);
        } else {
            // No footprint (minima islands): centroid proximity fallback.
            let hit = false;
            for (const tip of allTips) {
                const dx = island.contact.x - tip.x;
                const dy = island.contact.y - tip.y;
                const dz = island.contact.z - tip.z;
                if (dx * dx + dy * dy + dz * dz <= covR2) {
                    hit = true;
                    break;
                }
            }
            fraction = hit ? 1 : 0;
        }
        coveredArea += area * fraction;
        if (fraction >= 0.9) supportedIds.add(island.id);
    }

    // ── Sizing debug info ───────────────────────────────────────────
    let sizingDebug: AutoPlaceAnalytics['sizingDebug'];
    if (modelCtx && candidates.length > 0) {
        const weightG = modelCtx.modelVolumeMm3 * 0.0011;
        const areas = candidates.map(c => c.islandAreaMm2);
        areas.sort((a, b) => a - b);
        const minArea = areas[0];
        const maxArea = areas[areas.length - 1];
        const avgArea = areas.reduce((s, a) => s + a, 0) / areas.length;
        const zMax = Math.max(...candidates.map(c => c.zHeight), 1);
        // Sample min/max/avg candidates for shaft diameter range.
        const makeSample = (area: number, z: number): CandidatePoint => ({
            id: 'dbg', tipPos: { x: 0, y: 0, z: 0 }, tipNormal: { x: 0, y: 0, z: -1 },
            modelId: '', source: 'voxel', islandAreaMm2: area,
            zHeight: z, priority: 0,
        });
        const sMin = sizeParameters(makeSample(minArea, 10), getSettings().autoSupport?.sizeScale ?? 1);
        const sMax = sizeParameters(makeSample(maxArea, zMax), getSettings().autoSupport?.sizeScale ?? 1);
        const sAvg = sizeParameters(makeSample(avgArea, zMax / 2), getSettings().autoSupport?.sizeScale ?? 1);
        sizingDebug = {
            modelVolumeMm3: Math.round(modelCtx.modelVolumeMm3),
            estimatedWeightG: round2Mm(weightG),
            totalCandidates: modelCtx.totalCandidates,
            // Honest mass share: total model weight divided by the number of
            // placed supports. A load share, not a force estimate.
            weightPerSupportG: round2Mm(placedTrunks > 0 ? weightG / placedTrunks : 0),
            avgIslandAreaMm2: round2Mm(avgArea),
            standaloneTrunks: diagnostics.trunksByKind.standalone,
            gridInfillTrunks: diagnostics.trunksByKind.gridInfill + diagnostics.trunksByKind.coverageFill,
            shaftDiameterRange: {
                min: round2Mm(sMin.shaftDiameterMm ?? 0),
                max: round2Mm(sMax.shaftDiameterMm ?? 0),
                avg: round2Mm(sAvg.shaftDiameterMm ?? 0),
            },
            tipContactRange: {
                min: round2Mm(sMin.tipContactDiameterMm ?? 0),
                max: round2Mm(sMax.tipContactDiameterMm ?? 0),
                avg: round2Mm(sAvg.tipContactDiameterMm ?? 0),
            },
        };
    }

    analytics = {
        islandsCovered: supportedIds.size,
        islandsUncovered: islands.length - supportedIds.size,
        presets,
        rejectionReasons,
        areaCoverage: totalArea > 0 ? coveredArea / totalArea : 0,
        placement: diagnostics,
        sizingDebug,
    };
    console.log(LOG_PREFIX,
        `Coverage: ${analytics.islandsCovered}/${islands.length} islands (${(analytics.areaCoverage * 100).toFixed(0)}% of area). ` +
        `${analytics.islandsUncovered} islands uncovered.`);

    // ── Post-placement leaf fanning (iterative convergence) ──────────
    const fanRadiusMm = autoSettings.leafFanRadiusMm ?? LEAF_FAN_RADIUS_MM;
    const fanMaxAngleDeg = autoSettings.leafFanMaxAngleDeg ?? LEAF_FAN_MAX_ANGLE_DEG;

    console.log(LOG_PREFIX,
        `Leaf fanning: ${analytics.islandsUncovered} uncovered islands, ${placedTrunks} trunks available. ` +
        `Max ${MAX_FANNING_PASSES} passes, fan radius ${fanRadiusMm}mm, max angle ${fanMaxAngleDeg}°.`);

    for (let pass = 0; pass < MAX_FANNING_PASSES && analytics.islandsUncovered > 0; pass++) {
        const shaftPoints = collectFanShaftPoints(draft);
        if (shaftPoints.length === 0) {
            console.log(LOG_PREFIX, `Leaf fanning pass ${pass}: no shaft points — breaking.`);
            break;
        }

        let fannedCount = 0;

        let skippedDist = 0;
        let skippedAngle = 0;
        let skippedSameZ = 0;
        let skippedCross = 0;
        let skippedOther = 0;

        for (const island of islands) {
            if (supportedIds.has(island.id)) continue;
            const fan = fanLeafToTrunk(
                { x: island.contact.x, y: island.contact.y, z: island.contact.z },
                modelId,
                shaftPoints,
                gridTrunkIds,
                `auto-fan-${island.id}-p${pass}`,
                fanRadiusMm,
                GRID_HOST_FAN_RADIUS_MM,
                fanMaxAngleDeg,
                autoSettings.maxAttachmentsPerTrunk,
                draft,
                resolvedMesh ?? undefined,
                island.source === 'overhang' ? 'overhang' : 'island',
            );
            if (!fan.ok) {
                if (fan.reason === 'noHost') skippedDist++;
                else if (fan.reason === 'angle') skippedAngle++;
                else if (fan.reason === 'sameZ') skippedSameZ++;
                else if (fan.reason === 'cross') skippedCross++;
                else skippedOther++;
                continue;
            }
            draft = fan.draft;
            fannedCount++;
            supportedIds.add(island.id);
            coveredArea += (island.areaMm2 ?? 0);
            forestLedger.push({
                displayId: island.id,
                kind: 'leaf',
                entityId: fan.leafId,
                areaMm2: island.areaMm2 ?? 0,
                zHeight: island.contact.z,
                preset: presetForArea(island.areaMm2 ?? 0),
                bandShaftMm: activeSizingBand().shaftDiameterMm,
            });
            console.log(LOG_PREFIX,
                `Leaf (fan p${pass}) ${island.id} → trunk ${fan.trunkId} ` +
                `dist=${fan.distMm.toFixed(1)}mm angle=${fan.angleDeg.toFixed(0)}°`);
        }

        if (fannedCount > 0) {
            placedLeaves += fannedCount;
            analytics.islandsCovered += fannedCount;
            analytics.islandsUncovered -= fannedCount;
            analytics.areaCoverage = totalArea > 0 ? coveredArea / totalArea : 0;
            console.log(LOG_PREFIX,
                `Leaf fanning pass ${pass}: ${fannedCount} leaves, ` +
                `${analytics.islandsUncovered} islands still uncovered.`);
        } else {
            console.log(LOG_PREFIX,
                `Leaf fanning pass ${pass}: 0 leaves — ` +
                `${skippedDist} too far (>${fanRadiusMm}mm), ` +
                `${skippedAngle} angle too steep (>${LEAF_FAN_MAX_ANGLE_DEG}°), ` +
                `${skippedSameZ} same Z (can't attach), ` +
                `${skippedCross} crossing another support, ` +
                `${skippedOther} blocked/build/capacity.`);
            break;
        }
    }

    // ── Overhang surface coverage ──────────────────────────────────
    // Large flat overhangs need more than one support to distribute
    // peel forces evenly.  Use the island's contactVoxels footprint
    // to place additional supports across the surface.
    const OVERHANG_AREA_THRESHOLD_MM2 = 1.5;
    const OVERHANG_GRID_SPACING_MM = 2.5;

    const islandById = new Map(islands.map(i => [i.id, i]));
    let overhangSupportsPlaced = 0;

    for (const [tid, trunk] of Object.entries(draft.trunks)) {
        // Find which island this trunk was placed for by matching tip
        // proximity to island contact positions.
        const tip = trunk.contactCone?.pos;
        if (!tip) continue;
        let bestIsland: DetectedIsland | null = null;
        let bestDist2 = Infinity;
        for (const island of islands) {
            const dx = tip.x - island.contact.x;
            const dy = tip.y - island.contact.y;
            const dz = tip.z - island.contact.z;
            const d2 = dx * dx + dy * dy + dz * dz;
            if (d2 < bestDist2) { bestDist2 = d2; bestIsland = island; }
        }
        if (!bestIsland) continue;

        // Overhang regions are gridded by the grid phase — the legacy
        // overhang-coverage pass is for flat voxel islands only.
        if (bestIsland.source === 'overhang') continue;

        const area = bestIsland.areaMm2 ?? 0;
        const voxels = bestIsland.contactVoxels;
        if (area < OVERHANG_AREA_THRESHOLD_MM2 || !voxels || voxels.count < 3) continue;

        // Compute bounding box of contact voxels.
        let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
        for (let vi = 0; vi < voxels.count; vi++) {
            const vx = footprintX(voxels, vi);
            const vy = footprintY(voxels, vi);
            if (vx < minX) minX = vx;
            if (vy < minY) minY = vy;
            if (vx > maxX) maxX = vx;
            if (vy > maxY) maxY = vy;
        }
        const width = maxX - minX;
        const height = maxY - minY;
        if (width < OVERHANG_GRID_SPACING_MM && height < OVERHANG_GRID_SPACING_MM) continue;

        // Place a grid of support points across the footprint.
        const cols = Math.max(2, Math.round(width / OVERHANG_GRID_SPACING_MM));
        const rows = Math.max(2, Math.round(height / OVERHANG_GRID_SPACING_MM));

        for (let r = 0; r < rows; r++) {
            for (let c = 0; c < cols; c++) {
                const gx = minX + (width * (c + 0.5)) / cols;
                const gy = minY + (height * (r + 0.5)) / rows;

                // Check if this grid point is within the voxel footprint
                // (simple containment: near any contact voxel).
                let inFootprint = false;
                for (let vi = 0; vi < voxels.count; vi++) {
                    const dx = gx - footprintX(voxels, vi);
                    const dy = gy - footprintY(voxels, vi);
                    if (dx * dx + dy * dy <= OVERHANG_GRID_SPACING_MM * OVERHANG_GRID_SPACING_MM) {
                        inFootprint = true;
                        break;
                    }
                }
                if (!inFootprint) continue;

                // Skip the centroid (already covered by the trunk tip).
                const cDist = (gx - bestIsland.contact.x) ** 2 + (gy - bestIsland.contact.y) ** 2;
                if (cDist < 1.0) continue;

                // Place as a branch from the existing trunk.
                try {
                    const overhangTip = { x: gx, y: gy, z: bestIsland.contact.z };
                    const resolved = resolveSurfaceNormal(overhangTip, mesh);
                    const knotPos = trunk.segments[trunk.segments.length - 1]?.topJoint?.pos ?? tip;
                    const parentKnot = {
                        id: `auto-overhang-${bestIsland.id}-${r}-${c}`,
                        parentShaftId: tid,
                        pos: knotPos,
                        diameter: (trunk.segments[trunk.segments.length - 1]?.diameter ?? 1.0) + 0.1,
                    };
                    const bm: THREE.Mesh | undefined = resolvedMesh ?? undefined;
                    const { branch, supportData: sd } = buildBranchData({
                        tipPos: resolved.point,
                        tipNormal: resolved.normal,
                        modelId,
                        parentKnot,
                        mesh: bm,
                        shaftDiameterMm: activeSizingBand().shaftDiameterMm,
                        tipContactDiameterMm: activeSizingBand().tipContactDiameterMm,
                        rootsDiameterMm: activeSizingBand().rootDiameterMm,
                    });
                    if (!sd.error) {
                        const ohCap = autoSettings.maxAttachmentsPerTrunk;
                        if (isTrunkAtAttachmentCapacity(tid, ohCap, draft)) {
                            continue;
                        }
                        // The tips are voxel-island footprints — island origin.
                        branch.origin = 'island';
                        draft = draftAddKnot(draft, parentKnot);
                        draft = draftAddBranch(draft, branch);
                        overhangSupportsPlaced++;
                        placedBranches++;
                    }
                } catch (_) {
                    // Skip this grid point.
                }
            }
        }

        if (overhangSupportsPlaced > 0) {
            console.log(LOG_PREFIX,
                `Overhang coverage: ${overhangSupportsPlaced} additional branches placed for flat surfaces.`);
        }
    }
    } catch (e) {
        // Safety net: the promote path can mid-run swap the store, so restore
        // the pre-run snapshots on failure. Everything else never commits, so
        // this is the only path that can leave anything behind.
        console.error(LOG_PREFIX,
            `Auto-support failed mid-run — rolling back.`,
            e instanceof Error ? e.message : String(e));
        setSnapshot(before);
        setKickstandSnapshot(kickstandBefore);
        return null;
    }

    const changed =
        placedTrunks > 0 ||
        placedAnchors > 0 ||
        placedBranches > 0 ||
        placedLeaves > 0 ||
        placedSticks > 0;

    // ------------------------------------------------------------------
    // 4. Forest resize pass — re-derive every trunk's stepwise diameter
    //    profile from its final attachment tree (a trunk carrying four
    //    branches gets thicker; a lone trunk stays at its placed diameter).
    // ------------------------------------------------------------------

    if (changed) {
        try {
            const resized = computeForestDiameterProfile(draft);
            if (resized !== draft) {
                draft = resized;
                console.log(LOG_PREFIX, 'Forest resize pass applied (attachment-loaded trunks thickened).');
            }
            // Legacy fan knots used trunkId as parentShaftId — rehost to the nearest segment so
            // diameter demands and drift checks use segment ids.
            const rehosted = rehostLegacyKnots(draft);
            if (rehosted !== draft) {
                draft = rehosted;
                console.log(LOG_PREFIX, 'Legacy knot rehost: trunkId → segmentId');
            }
            // Post-resize validation: drift (>0.5mm), cross after thickening, or missing host.
            // This is where the "leaf attached to nowhere" shows up in the report.
            let orphanInfos: OrphanInfo[] = [];
            try {
                const culled = validateAndCullOrphans(draft, resolvedMesh ?? undefined);
                if (culled.orphans.length > 0) {
                    draft = culled.draft;
                    orphanInfos = culled.orphans;
                    console.log(LOG_PREFIX, `Orphan cull: ${culled.orphans.length} leaves/branches removed — ${culled.orphans.map((o) => `${o.id}:${o.reason}${o.hostId ? `@${o.hostId.slice(0,8)}` : ''}`).join(', ')}`);
                }
            } catch (e) {
                console.warn(LOG_PREFIX, `Orphan validation failed (non-fatal): ${e instanceof Error ? e.message : String(e)}`);
            }

            // Cone/shaft sync: the resize and merge passes thicken shafts and
            // rehost members, but a contact cone keeps whatever body diameter
            // it was built with — a leaf fanned onto a then-thicker host (or a
            // trunk whose profile was transplanted during a replacement) can
            // end up wider than the shaft it sits on. Clicking the support
            // rebuilt the cone from the shaft and "snapped it correct"; do
            // that globally instead of waiting for a click.
            const coneSynced = syncContactConeDiameters(draft);
            if (coneSynced !== draft) {
                draft = coneSynced;
                console.log(LOG_PREFIX, 'Contact cone sync: clamped oversized cone bodies to their host shafts.');
            }

            // ── Forest Report ───────────────────────────────────────
            // Structured per-run summary: every placed support's id, size,
            // and sizing reasoning, plus the fan-out groups. Shown in the
            // Auto Supports panel; the log gets a one-line summary only.
            const forestReport = buildForestReport(draft, forestLedger);
            const bySource = { voxel: 0, minima: 0, intersection: 0, overhang: 0 };
            for (const island of islands) {
                (bySource as Record<string, number>)[island.source] = ((bySource as Record<string, number>)[island.source] ?? 0) + 1;
            }
            const scanTotalAreaMm2 = islands.reduce((sum, island) => sum + (island.areaMm2 ?? 0), 0);
            forestReport.scan = {
                islands: islands.length,
                bySource,
                overhangRegions: overhangIslands.length,
                anchorClusters: 0,
                anchorRegions: 0,
                candidates: candidates.length,
                totalAreaMm2: scanTotalAreaMm2,
                coveragePercent: analytics.areaCoverage * 100,
                uncoveredIslands: analytics.islandsUncovered,
                rejected: rejectedCount,
            };
            if (orphanInfos.length > 0) {
                forestReport.orphans = orphanInfos;
            }
            forestReport.diagnostics = {
                candidatesBySource: diagnostics.candidatesBySource,
                trunksByKind: diagnostics.trunksByKind,
                fanRefusals: { ...diagnostics.fanRefusals },
                mergeRefusals: { ...diagnostics.mergeRefusals },
                consolidationRefusals: { ...conRefusals },
                cavityFallbacks: [...diagnostics.cavityFallbacks],
            };
            analytics.forestReport = forestReport;
            console.log(LOG_PREFIX,
                `Forest report: ${forestReport.trunkCount} trunks, ${forestReport.leafCount} leaves, ` +
                `${forestReport.branchCount} branches, ${forestReport.stickCount} sticks — ` +
                `${forestReport.trees.length} fan-out trees, ${forestReport.bareTrunks.length} bare trunks` +
                (orphanInfos.length > 0 ? ` — ${orphanInfos.length} orphans culled` : ''));
        } catch (e) {
            console.warn(LOG_PREFIX,
                `Forest resize failed (non-fatal): ${e instanceof Error ? e.message : String(e)}`);
        }
    }

    // ------------------------------------------------------------------
    // 5. Auto-bracing (draft-only, folded into the plan)
    // ------------------------------------------------------------------

    if (changed && !autoSettings.debugSkipAutoBracing) {
        console.log(LOG_PREFIX, 'Running auto-brace...');
        try {
            const braceResult = buildAutoBracedSnapshot(draft, getSettings().autoBracing, kickstandDraft);
            draft = braceResult.snapshot;
            kickstandDraft = braceResult.kickstand;
            console.log(LOG_PREFIX, `Auto-brace: ${braceResult.message}`);
        } catch (e) {
            console.warn(LOG_PREFIX,
                `Auto-brace failed (non-fatal): ${e instanceof Error ? e.message : String(e)}`);
        }
    } else if (changed) {
        console.log(LOG_PREFIX, 'Auto-brace skipped (debug setting).');
    }

    const result: AutoPlaceResult = {
        ...makeResult(
            placedTrunks,
            placedAnchors,
            placedBranches,
            placedLeaves,
            placedSticks,
            rejectedCount,
            changed,
            `Placed ${placedTrunks} trunks, ${placedAnchors} anchors, ${placedBranches} branches, ${placedLeaves} leaves, ${placedSticks} sticks. ` +
            `${rejectedCount} rejected. Coverage: ${analytics.islandsCovered}/${islands.length} islands (${(analytics.areaCoverage * 100).toFixed(0)}%).`,
        ),
        analytics,
    };

    return {
        before,
        kickstandBefore,
        support: draft,
        kickstand: kickstandDraft,
        analytics,
        result,
    };
}

/**
 * Run auto-support end-to-end: compute the plan, then commit it as ONE
 * atomic store update + ONE undoable history entry (supports + braces +
 * kickstands together).
 */
export function runAutoPlace(
    islands: DetectedIsland[],
    modelId: string,
    settingsOverride?: Partial<AutoSupportSettings>,
): AutoPlaceResult {
    const plan = computeAutoSupportPlan(islands, modelId, settingsOverride);
    if (!plan) {
        return makeResult(0, 0, 0, 0, 0, 0, false, 'Auto-support is disabled.');
    }

    if (plan.result.changed) {
        setSnapshot(plan.support);
        setKickstandSnapshot(plan.kickstand);
        try {
            pushSupportHistory({
                type: SUPPORT_AUTO_PLACE,
                payload: {
                    before: plan.before,
                    after: plan.support,
                    kickstandBefore: plan.kickstandBefore,
                    kickstandAfter: plan.kickstand,
                },
            });
            console.log(LOG_PREFIX, 'History entry pushed — undo available.');
        } catch (e) {
            console.warn(LOG_PREFIX,
                `History push failed (non-fatal): ${e instanceof Error ? e.message : String(e)}`);
        }
    }

    return plan.result;
}
