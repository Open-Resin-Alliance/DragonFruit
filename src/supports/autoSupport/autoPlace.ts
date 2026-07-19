import * as THREE from 'three';
import type { CandidatePoint, AutoPlaceResult, AutoPlaceAnalytics, RejectReason } from './types';
import type { AutoSupportSettings } from './settings';
import { normalizeAutoSupportSettings } from './settings';
import { generateCandidates, deduplicateCandidates } from './candidateGeneration';
import { sizeParameters } from './parameterSizing';
import { getSettings } from '../Settings/state';
import { getSnapshot, addRoot, addTrunk, addBranch, addLeaf, addKnot, addAnchor, addStick, addTwig } from '../state';
import type { DetectedIsland } from '../../volumeAnalysis/Islands/types';
import { buildTrunkData } from '../SupportTypes/Trunk/trunkBuilder';
import { buildCavityStick } from '../SupportTypes/Trunk/useTrunkPlacement';
import { buildBranchData } from '../SupportTypes/Branch/branchBuilder';
import { buildLeafData } from '../SupportTypes/Leaf/leafBuilder';
import { decideGridPlacement } from '../PlacementLogic/Grid/gridPlacement';
import { calculateSmoothedNormal } from '../PlacementLogic/PlacementUtils';
import { runAutoBracing } from '../autoBracing/autoBrace';
import { pushHistory } from '@/history/historyStore';
import { getModelMesh } from './meshStore';

const LOG_PREFIX = '[AutoSupport]';

// ---------------------------------------------------------------------------
// History action type
// ---------------------------------------------------------------------------

const SUPPORT_AUTO_PLACE = 'support:auto-place' as const;

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
 * Falls back to the candidate's existing tipNormal when the mesh is
 * unavailable or the raycast misses.
 */
function resolveSurfaceNormal(
    tipPos: CandidatePoint['tipPos'],
    mesh: THREE.Mesh | undefined,
): { point: { x: number; y: number; z: number }; normal: { x: number; y: number; z: number } } {
    if (!mesh) {
        return { point: tipPos, normal: { x: 0, y: 0, z: -1 } };
    }

    const raycaster = new THREE.Raycaster();
    // Shoot a ray from slightly above the candidate toward it.
    const origin = new THREE.Vector3(tipPos.x, tipPos.y, tipPos.z + 2);
    const direction = new THREE.Vector3(0, 0, -1);
    raycaster.set(origin, direction);

    // Also try shooting upward in case the surface faces down.
    const hitsUp: THREE.Intersection[] = [];
    raycaster.set(new THREE.Vector3(tipPos.x, tipPos.y, tipPos.z - 2), new THREE.Vector3(0, 0, 1));
    hitsUp.push(...raycaster.intersectObject(mesh, false));

    const hits = raycaster.intersectObject(mesh, false);
    if (hits.length > 0) {
        const hit = hits[0];
        const smoothed = calculateSmoothedNormal(hit);
        return {
            point: { x: hit.point.x, y: hit.point.y, z: hit.point.z },
            normal: smoothed,
        };
    }

    // Try the upward ray.
    if (hitsUp.length > 0) {
        const hit = hitsUp[0];
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

/** Distance within which a candidate is considered already supported. */
const ALREADY_SUPPORTED_RADIUS_MM = 3.0;

/**
 * Remove candidates whose tip position is already covered by an
 * existing support (any trunk / branch / leaf / anchor contact cone).
 * Prevents stacking duplicate supports on repeated runs.
 */
function filterAlreadySupported(candidates: CandidatePoint[]): CandidatePoint[] {
    const snapshot = getSnapshot();
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

/** When grid is disabled, merge candidates within this XY distance of an existing trunk. */
const GRIDLESS_MERGE_RADIUS_MM = 2.0;

interface MergeHost {
    trunkId: string;
    tipPos: { x: number; y: number; z: number };
}

// ---------------------------------------------------------------------------
// Leaf fan-out — max distance / angle constants
// ---------------------------------------------------------------------------

const LEAF_FAN_RADIUS_MM = 5.0;
const LEAF_FAN_MAX_ANGLE_DEG = 60;

// ---------------------------------------------------------------------------
// Nearby-trunk merge
// ---------------------------------------------------------------------------

/** Find the closest existing trunk (shaft or tip) within merge radius. */
function findMergeHost(
    tipPos: { x: number; y: number; z: number },
    modelId: string,
): MergeHost | null {
    const snapshot = getSnapshot();
    const r2 = GRIDLESS_MERGE_RADIUS_MM * GRIDLESS_MERGE_RADIUS_MM;
    let best: MergeHost | null = null;
    let bestDist2 = Infinity;

    for (const [id, trunk] of Object.entries(snapshot.trunks)) {
        if (trunk.modelId !== modelId) continue;

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
    settingsOverride: Partial<AutoSupportSettings> | undefined,
): { kind: string; rejectedReason?: RejectReason; preset?: 'detail' | 'structure' | 'anchor'; entityId?: string; stickCount?: number } {
    const supportSettings = getSettings();
    const autoSettings = normalizeAutoSupportSettings(settingsOverride ?? undefined);
    const snapshot = getSnapshot();
    const mesh = getModelMesh(candidate.modelId) ?? undefined;

    // Resolve the real surface normal by raycasting against the mesh.
    // candidateFromIsland sets tipNormal to {0,0,-1} as a placeholder.
    const resolved = resolveSurfaceNormal(candidate.tipPos, mesh);
    const tipPos = resolved.point;
    const tipNormal = resolved.normal;

    // Determine preset band for analytics.
    const area = candidate.islandAreaMm2;
    const preset = area <= 0.15 ? 'detail' as const : area <= 0.50 ? 'structure' as const : 'anchor' as const;

    // ── Gridless merge check ──────────────────────────────────────
    if (!supportSettings.grid?.enabled) {
        const host = findMergeHost(tipPos, candidate.modelId);
        if (host) {
            // Find the best attachment point on the host trunk's shaft,
            // below the candidate's tip.  This matches the W-key sprout
            // behaviour: leaves/branches fan from the shaft body, not
            // from the contact tip.
            const hostTrunk = snapshot.trunks[host.trunkId];
            let bestKnotPos: { x: number; y: number; z: number } | null = null;
            let bestKnotSegmentId = '';

            if (hostTrunk) {
                // Walk segments looking for a joint below the tip.
                for (const seg of hostTrunk.segments) {
                    const jp = seg.bottomJoint?.pos ?? seg.topJoint?.pos;
                    if (jp && jp.z < tipPos.z) {
                        if (!bestKnotPos || jp.z > bestKnotPos.z) {
                            bestKnotPos = jp;
                            bestKnotSegmentId = seg.id;
                        }
                    }
                }
            }

            // Fallback: use the host position if no shaft joint found.
            const knotPos = bestKnotPos ?? host.tipPos;
            const parentKnot = {
                id: `auto-merge-${candidate.id}`,
                parentShaftId: bestKnotSegmentId || host.trunkId,
                pos: knotPos,
            };
            try {
                const { branch, supportData: sd } = buildBranchData({
                    tipPos,
                    tipNormal,
                    modelId: candidate.modelId,
                    parentKnot,
                    mesh,
                });
                if (sd.error) {
                    console.log(LOG_PREFIX,
                        `Branch (merge) ${candidate.id}: collision \"${sd.error}\", falling back`);
                    // Fall through to trunk path.
                } else {
                    addKnot(parentKnot);
                    addBranch(branch);
                    console.log(LOG_PREFIX,
                        `Branch (merge) ${candidate.id} → host ${host.trunkId} ` +
                        `knotZ=${knotPos.z.toFixed(1)}mm`);
                    return { kind: 'branch', preset };
                }
            } catch (e) {
                console.log(LOG_PREFIX,
                    `Merge branch failed for ${candidate.id}, falling back to trunk: ` +
                    `${e instanceof Error ? e.message : String(e)}`);
            }
        }
    }

    // Size parameters based on island area preset (Detail/Structure/Anchor).
    const overrides = sizeParameters(candidate);

    const trunkResult = buildTrunkData({
        tipPos,
        tipNormal,
        modelId: candidate.modelId,
        mesh,
        overrides,
        isPreview: false,
    });

    if (trunkResult.error) {
        // Cavity fallback: if the trunk can't reach the build plate, try
        // bridging to a lower surface with a Stick (model-to-model).
        if (trunkResult.error === 'COLLISION_WITH_MODEL' && mesh) {
            const cavityResult = buildCavityStick(tipPos, tipNormal, candidate.modelId, mesh);
            if (cavityResult) {
                if (cavityResult.kind === 'stick') {
                    addStick(cavityResult.stick);
                    console.log(LOG_PREFIX,
                        `Stick (cavity) ${candidate.id} Z=${candidate.zHeight.toFixed(1)}mm`);
                    return { kind: 'stick', preset };
                } else {
                    addTwig(cavityResult.twig);
                    console.log(LOG_PREFIX,
                        `Twig (cavity) ${candidate.id} Z=${candidate.zHeight.toFixed(1)}mm`);
                    return { kind: 'twig', preset };
                }
            }
        }
        const bbox = mesh ? new THREE.Box3().setFromObject(mesh) : null;
        console.log(LOG_PREFIX,
            `Rejected ${candidate.id}: trunk build error \"${trunkResult.error}\" ` +
            `tip=(${tipPos.x.toFixed(1)},${tipPos.y.toFixed(1)},${tipPos.z.toFixed(1)}) ` +
            `mesh=${mesh ? 'yes' : 'no'} ` +
            `bbox=${bbox ? `(${bbox.min.x.toFixed(0)},${bbox.min.y.toFixed(0)},${bbox.min.z.toFixed(0)})-(${bbox.max.x.toFixed(0)},${bbox.max.y.toFixed(0)},${bbox.max.z.toFixed(0)})` : 'none'}`);
        return { kind: 'reject', rejectedReason: 'trunk_build_error', preset };
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
            addRoot(decision.trunkBuild.root);
            addTrunk(decision.trunkBuild.trunk);
            console.log(LOG_PREFIX,
                `Trunk ${candidate.id} (→ ${trunkId}) @ grid ${decision.nodeKey} ` +
                `area=${candidate.islandAreaMm2.toFixed(2)}mm² Z=${candidate.zHeight.toFixed(1)}mm ${preset}`);
            return { kind: 'trunk', preset, entityId: trunkId };
        }

        case 'place_anchor':
            addAnchor(decision.anchor);
            console.log(LOG_PREFIX, `Anchor ${candidate.id} Z=${candidate.zHeight.toFixed(1)}mm`);
            return { kind: 'anchor', preset };

        case 'place_branch':
            addKnot(decision.knot);
            addBranch(decision.branch);
            console.log(LOG_PREFIX,
                `Branch ${candidate.id} → host ${decision.hostTrunkId} ` +
                `grid ${decision.nodeKey}`);
            return { kind: 'branch', preset };

        case 'place_leaf':
            addKnot(decision.knot);
            addLeaf(decision.leaf);
            console.log(LOG_PREFIX,
                `Leaf ${candidate.id} → host ${decision.hostTrunkId} ` +
                `grid ${decision.nodeKey}`);
            return { kind: 'leaf', preset };

        case 'replace_trunk':
            // The old trunk gets removed by the caller (or we accept overwrite).
            // For now: add the new trunk and root.  The old trunk's root is
            // implicitly replaced because we overwrite the grid node.
            addRoot(decision.trunkBuild.root);
            addTrunk(decision.trunkBuild.trunk);
            console.log(LOG_PREFIX,
                `Replace trunk @ ${decision.nodeKey}: ` +
                `${candidate.id} (Z=${candidate.zHeight.toFixed(1)}) → host ${decision.hostTrunkId}`);
            return { kind: 'trunk', preset, entityId: decision.trunkBuild.trunk.id };

        case 'reject': {
            const reason: RejectReason =
                decision.reason === 'COLLISION_WITH_MODEL' ? 'grid_reject_collision' :
                decision.reason === 'NO_VALID_ATTACHMENT' || decision.reason === 'KNOT_ABOVE_TIP' ? 'grid_reject_no_attachment' :
                'grid_reject_other';
            console.log(LOG_PREFIX, `Rejected ${candidate.id}: ${decision.reason} (grid ${decision.nodeKey})`);
            return { kind: 'reject', rejectedReason: reason, preset };
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
export function runAutoPlace(
    islands: DetectedIsland[],
    modelId: string,
    settingsOverride?: Partial<AutoSupportSettings>,
): AutoPlaceResult {
    // ------------------------------------------------------------------
    // 0. Settings
    // ------------------------------------------------------------------

    const autoSettings = normalizeAutoSupportSettings(settingsOverride ?? undefined);

    if (!autoSettings.enabled) {
        return makeResult(0, 0, 0, 0, 0, 0, false, 'Auto-support is disabled.');
    }

    const beforeSnapshot = getSnapshot();

    // ------------------------------------------------------------------
    // 1. Generate candidates
    // ------------------------------------------------------------------

    console.log(LOG_PREFIX, `Input: ${islands.length} islands from scan`);

    let candidates = generateCandidates(islands, autoSettings);
    candidates = candidates.map((c): CandidatePoint => ({ ...c, modelId }));

    console.log(LOG_PREFIX,
        `Step 1/3: ${candidates.length} candidates generated ` +
        `(filtered from ${islands.length} islands, min area ${autoSettings.minIslandAreaMm2}mm²)`);

    if (candidates.length === 0) {
        return makeResult(0, 0, 0, 0, 0, 0, false, 'No viable support candidates found.');
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
        return makeResult(0, 0, 0, 0, 0, 0, false, 'All candidates deduplicated — nothing to place.');
    }

    // ------------------------------------------------------------------
    // 2b. Filter out already-supported positions
    // ------------------------------------------------------------------

    const beforeSupportFilter = candidates.length;
    candidates = filterAlreadySupported(candidates);
    console.log(LOG_PREFIX,
        `Step 2b: ${candidates.length} candidates after support filter ` +
        `(removed ${beforeSupportFilter - candidates.length} already supported within ${ALREADY_SUPPORTED_RADIUS_MM}mm)`);

    if (candidates.length === 0) {
        return makeResult(0, 0, 0, 0, 0, 0, false,
            'All candidate positions already have supports.');
    }

    // ------------------------------------------------------------------
    // 3. Place candidates through the standard pipeline
    // ------------------------------------------------------------------
    // Each candidate goes through resolveNormal → buildTrunkData →
    // decideGridPlacement.  State is committed after each placement so
    // subsequent candidates see existing supports (enabling organic
    // tree fan-out via grid occupancy).

    const mesh = getModelMesh(modelId);
    if (mesh) mesh.updateMatrixWorld();
    console.log(LOG_PREFIX,
        `Mesh for ${modelId}: ${mesh ? 'available (pathfinding + SDF active)' : 'UNAVAILABLE (supports route straight, no collision avoidance)'}`);

    const gridEnabled = getSettings().grid?.enabled;
    console.log(LOG_PREFIX,
        `Grid mode: ${gridEnabled ? 'ENABLED (supports share grid nodes, branch/leaf fan-out active)' : 'DISABLED (all supports become standalone trunks)'}`);

    let placedTrunks = 0;
    let placedAnchors = 0;
    let placedBranches = 0;
    let placedLeaves = 0;
    let placedSticks = 0;
    let rejectedCount = 0;

    // Analytics accumulators
    const presets = { detail: 0, structure: 0, anchor: 0 };
    const rejectionReasons: Record<string, number> = {};

    for (const candidate of candidates) {
        try {
            const result = placeOneCandidate(candidate, settingsOverride);
            switch (result.kind) {
                case 'trunk':   placedTrunks++; break;
                case 'anchor':  placedAnchors++; break;
                case 'branch':  placedBranches++; break;
                case 'leaf':    placedLeaves++; break;
                case 'stick':   placedSticks++; break;
                case 'reject':
                    rejectedCount++;
                    if (result.rejectedReason) {
                        rejectionReasons[result.rejectedReason] = (rejectionReasons[result.rejectedReason] ?? 0) + 1;
                    }
                    break;
            }
            if (result.preset) presets[result.preset]++;
        } catch (e) {
            rejectedCount++;
            rejectionReasons['exception'] = (rejectionReasons['exception'] ?? 0) + 1;
            console.warn(LOG_PREFIX,
                `Exception placing ${candidate.id}: ${e instanceof Error ? e.message : String(e)}`);
        }
    }

    const changed =
        placedTrunks > 0 ||
        placedAnchors > 0 ||
        placedBranches > 0 ||
        placedLeaves > 0 ||
        placedSticks > 0;

    console.log(LOG_PREFIX,
        `Step 3/3: ${placedTrunks}T ${placedAnchors}A ${placedBranches}B ${placedLeaves}L ${placedSticks}S — ${rejectedCount} rejected ` +
        `| presets: detail=${presets.detail} structure=${presets.structure} anchor=${presets.anchor}`);

    // ── Coverage analytics ────────────────────────────────────────
    const snapshot = getSnapshot();
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
        const cx = island.contact.x;
        const cy = island.contact.y;
        const cz = island.contact.z;
        let covered = false;
        for (const tip of allTips) {
            const dx = cx - tip.x;
            const dy = cy - tip.y;
            const dz = cz - tip.z;
            if (dx * dx + dy * dy + dz * dz <= covR2) {
                covered = true;
                break;
            }
        }
        if (covered) {
            supportedIds.add(island.id);
            coveredArea += area;
        }
    }

    const analytics: AutoPlaceAnalytics = {
        islandsCovered: supportedIds.size,
        islandsUncovered: islands.length - supportedIds.size,
        presets,
        rejectionReasons,
        areaCoverage: totalArea > 0 ? coveredArea / totalArea : 0,
    };

    console.log(LOG_PREFIX,
        `Coverage: ${analytics.islandsCovered}/${islands.length} islands (${(analytics.areaCoverage * 100).toFixed(0)}% of area). ` +
        `${analytics.islandsUncovered} islands uncovered.`);

    // ── Post-placement leaf fanning (iterative convergence) ──────────
    const MAX_FANNING_PASSES = 5;
    const SHAFT_SAMPLES_PER_SEGMENT = 5;

    console.log(LOG_PREFIX,
        `Leaf fanning: ${analytics.islandsUncovered} uncovered islands, ${placedTrunks} trunks available. ` +
        `Max ${MAX_FANNING_PASSES} passes, fan radius ${LEAF_FAN_RADIUS_MM}mm, max angle ${LEAF_FAN_MAX_ANGLE_DEG}°.`);

    for (let pass = 0; pass < MAX_FANNING_PASSES && analytics.islandsUncovered > 0; pass++) {
        const snap = getSnapshot();

        // Collect trunk shaft sample points from the current snapshot.
        const shaftPoints: Array<{
            trunkId: string; pos: { x: number; y: number; z: number }; diameter: number;
        }> = [];
        for (const [tid, trunk] of Object.entries(snap.trunks)) {
            for (const seg of trunk.segments) {
                const start = seg.bottomJoint?.pos
                    ?? { x: 0, y: 0, z: 1.5 };
                const end = seg.topJoint?.pos;
                if (!end) continue;
                const diameter = seg.diameter ?? 1.0;
                for (let i = 0; i <= SHAFT_SAMPLES_PER_SEGMENT; i++) {
                    const t = i / SHAFT_SAMPLES_PER_SEGMENT;
                    shaftPoints.push({
                        trunkId: tid,
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

        if (shaftPoints.length === 0) {
            console.log(LOG_PREFIX, `Leaf fanning pass ${pass}: no shaft points — breaking.`);
            break;
        }

        const fanR2 = LEAF_FAN_RADIUS_MM * LEAF_FAN_RADIUS_MM;
        const maxAngleRad = (LEAF_FAN_MAX_ANGLE_DEG * Math.PI) / 180;
        let fannedCount = 0;

        let skippedDist = 0;
        let skippedAngle = 0;
        let skippedBelow = 0;

        for (const island of islands) {
            if (supportedIds.has(island.id)) continue;
            const cx = island.contact.x;
            const cy = island.contact.y;
            const cz = island.contact.z;

            let bestDist2 = Infinity;
            let bestSP: typeof shaftPoints[0] | null = null;
            for (const sp of shaftPoints) {
                const dx = cx - sp.pos.x;
                const dy = cy - sp.pos.y;
                const dz = cz - sp.pos.z;
                const d2 = dx * dx + dy * dy + dz * dz;
                if (d2 < bestDist2) { bestDist2 = d2; bestSP = sp; }
            }

            if (!bestSP || bestDist2 > fanR2) {
                if (bestSP) skippedDist++;
                continue;
            }

            const sp = bestSP;
            const hDist = Math.sqrt((cx - sp.pos.x) ** 2 + (cy - sp.pos.y) ** 2);
            const vDist = cz - sp.pos.z;
            if (vDist <= 0) { skippedBelow++; continue; }
            const angleFromVertical = Math.atan2(hDist, vDist);
            if (angleFromVertical > maxAngleRad) { skippedAngle++; continue; }

            const parentKnot = {
                id: `auto-fan-${island.id}-p${pass}`,
                parentShaftId: sp.trunkId,
                pos: sp.pos,
                diameter: sp.diameter + 0.1,
            };

            try {
                const mesh = getModelMesh(modelId) ?? undefined;
                const resolved = resolveSurfaceNormal({ x: cx, y: cy, z: cz }, mesh);
                const { leaf, supportData: _sd } = buildLeafData({
                    tipPos: resolved.point,
                    surfaceNormal: resolved.normal,
                    modelId,
                    parentKnot,
                    hostDiameterMm: sp.diameter,
                    mesh,
                });
                addKnot(parentKnot);
                addLeaf(leaf);
                void _sd;
                fannedCount++;
                supportedIds.add(island.id);
                coveredArea += (island.areaMm2 ?? 0);
                console.log(LOG_PREFIX,
                    `Leaf (fan p${pass}) ${island.id} → trunk ${sp.trunkId} ` +
                    `dist=${Math.sqrt(bestDist2).toFixed(1)}mm angle=${(angleFromVertical * 180 / Math.PI).toFixed(0)}°`);
            } catch (e) {
                // Leaf build failed — island stays uncovered.
            }
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
                `${skippedDist} too far (>${LEAF_FAN_RADIUS_MM}mm), ` +
                `${skippedAngle} angle too steep (>${LEAF_FAN_MAX_ANGLE_DEG}°), ` +
                `${skippedBelow} shaft above island.`);
            break;
        }
    }

    // ------------------------------------------------------------------
    // 4. Auto-bracing + history
    // ------------------------------------------------------------------

    if (changed) {
        console.log(LOG_PREFIX, 'Running auto-brace...');
        try {
            const braceResult = runAutoBracing();
            console.log(LOG_PREFIX, `Auto-brace: ${braceResult.message}`);
        } catch (e) {
            console.warn(LOG_PREFIX,
                `Auto-brace failed (non-fatal): ${e instanceof Error ? e.message : String(e)}`);
        }

        try {
            const afterSnapshot = getSnapshot();
            pushHistory({
                type: SUPPORT_AUTO_PLACE,
                payload: { before: beforeSnapshot, after: afterSnapshot },
            });
            console.log(LOG_PREFIX, 'History entry pushed — undo available.');
        } catch (e) {
            console.warn(LOG_PREFIX,
                `History push failed (non-fatal): ${e instanceof Error ? e.message : String(e)}`);
        }
    }

    return {
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
}
