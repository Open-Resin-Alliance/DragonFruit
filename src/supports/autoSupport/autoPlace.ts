import * as THREE from 'three';
import type { CandidatePoint, AutoPlaceResult } from './types';
import type { AutoSupportSettings } from './settings';
import { normalizeAutoSupportSettings } from './settings';
import { generateCandidates, deduplicateCandidates } from './candidateGeneration';
import { sizeParameters } from './parameterSizing';
import { getSettings } from '../Settings/state';
import { getSnapshot, addRoot, addTrunk, addBranch, addLeaf, addKnot, addAnchor } from '../state';
import type { DetectedIsland } from '../../volumeAnalysis/Islands/types';
import { buildTrunkData } from '../SupportTypes/Trunk/trunkBuilder';
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
    rejected: number,
    changed: boolean,
    message: string,
): AutoPlaceResult {
    return {
        placedTrunks: trunks,
        placedAnchors: anchors,
        placedBranches: branches,
        placedLeaves: leaves,
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
// Pipeline helpers
// ---------------------------------------------------------------------------

/**
 * Run a single candidate through the standard placement pipeline:
 * resolve surface normal → buildTrunkData → decideGridPlacement → commit.
 *
 * This is the same sequence used by manual placement clicks.
 * Returns the decision kind so the orchestrator can tally.
 */
function placeOneCandidate(
    candidate: CandidatePoint,
    settingsOverride: Partial<AutoSupportSettings> | undefined,
): { kind: string; rejectedReason?: string } {
    const supportSettings = getSettings();
    const autoSettings = normalizeAutoSupportSettings(settingsOverride ?? undefined);
    const snapshot = getSnapshot();
    const mesh = getModelMesh(candidate.modelId) ?? undefined;

    // Resolve the real surface normal by raycasting against the mesh.
    // candidateFromIsland sets tipNormal to {0,0,-1} as a placeholder.
    const resolved = resolveSurfaceNormal(candidate.tipPos, mesh);
    const tipPos = resolved.point;
    const tipNormal = resolved.normal;

    // Size parameters from island geometry.
    const overrides = sizeParameters(
        candidate,
        candidate.islandAreaMm2,
        candidate.zHeight,
        supportSettings,
    );

    const trunkResult = buildTrunkData({
        tipPos,
        tipNormal,
        modelId: candidate.modelId,
        mesh,
        overrides,
        isPreview: false,
    });

    if (trunkResult.error) {
        console.log(LOG_PREFIX, `Rejected ${candidate.id}: trunk build error \"${trunkResult.error}\"`);
        return { kind: 'reject', rejectedReason: `Trunk build error: ${trunkResult.error}` };
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
        case 'place_trunk':
            addRoot(decision.trunkBuild.root);
            addTrunk(decision.trunkBuild.trunk);
            console.log(LOG_PREFIX,
                `Trunk ${candidate.id} @ grid ${decision.nodeKey} ` +
                `area=${candidate.islandAreaMm2.toFixed(2)}mm² Z=${candidate.zHeight.toFixed(1)}mm`);
            return { kind: 'trunk' };

        case 'place_anchor':
            addAnchor(decision.anchor);
            console.log(LOG_PREFIX, `Anchor ${candidate.id} Z=${candidate.zHeight.toFixed(1)}mm`);
            return { kind: 'anchor' };

        case 'place_branch':
            addKnot(decision.knot);
            addBranch(decision.branch);
            console.log(LOG_PREFIX,
                `Branch ${candidate.id} → host ${decision.hostTrunkId} ` +
                `grid ${decision.nodeKey}`);
            return { kind: 'branch' };

        case 'place_leaf':
            addKnot(decision.knot);
            addLeaf(decision.leaf);
            console.log(LOG_PREFIX,
                `Leaf ${candidate.id} → host ${decision.hostTrunkId} ` +
                `grid ${decision.nodeKey}`);
            return { kind: 'leaf' };

        case 'replace_trunk':
            // The old trunk gets removed by the caller (or we accept overwrite).
            // For now: add the new trunk and root.  The old trunk's root is
            // implicitly replaced because we overwrite the grid node.
            addRoot(decision.trunkBuild.root);
            addTrunk(decision.trunkBuild.trunk);
            console.log(LOG_PREFIX,
                `Replace trunk @ ${decision.nodeKey}: ` +
                `${candidate.id} (Z=${candidate.zHeight.toFixed(1)}) → host ${decision.hostTrunkId}`);
            return { kind: 'trunk' };

        case 'reject':
            console.log(LOG_PREFIX, `Rejected ${candidate.id}: ${decision.reason} (grid ${decision.nodeKey})`);
            return { kind: 'reject', rejectedReason: decision.reason };
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
        return makeResult(0, 0, 0, 0, 0, false, 'Auto-support is disabled.');
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
        return makeResult(0, 0, 0, 0, 0, false, 'No viable support candidates found.');
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
        return makeResult(0, 0, 0, 0, 0, false, 'All candidates deduplicated — nothing to place.');
    }

    // ------------------------------------------------------------------
    // 3. Place candidates through the standard pipeline
    // ------------------------------------------------------------------
    // Each candidate goes through resolveNormal → buildTrunkData →
    // decideGridPlacement.  State is committed after each placement so
    // subsequent candidates see existing supports (enabling organic
    // tree fan-out via grid occupancy).

    const mesh = getModelMesh(modelId);
    console.log(LOG_PREFIX,
        `Mesh for ${modelId}: ${mesh ? 'available (pathfinding + SDF active)' : 'UNAVAILABLE (supports route straight, no collision avoidance)'}`);

    const gridEnabled = getSettings().grid?.enabled;
    console.log(LOG_PREFIX,
        `Grid mode: ${gridEnabled ? 'ENABLED (supports share grid nodes, branch/leaf fan-out active)' : 'DISABLED (all supports become standalone trunks)'}`);

    let placedTrunks = 0;
    let placedAnchors = 0;
    let placedBranches = 0;
    let placedLeaves = 0;
    let rejectedCount = 0;

    for (const candidate of candidates) {
        try {
            const result = placeOneCandidate(candidate, settingsOverride);
            switch (result.kind) {
                case 'trunk':   placedTrunks++; break;
                case 'anchor':  placedAnchors++; break;
                case 'branch':  placedBranches++; break;
                case 'leaf':    placedLeaves++; break;
                case 'reject':  rejectedCount++; break;
            }
        } catch (e) {
            rejectedCount++;
            console.warn(LOG_PREFIX,
                `Exception placing ${candidate.id}: ${e instanceof Error ? e.message : String(e)}`);
        }
    }

    const changed =
        placedTrunks > 0 ||
        placedAnchors > 0 ||
        placedBranches > 0 ||
        placedLeaves > 0;

    console.log(LOG_PREFIX,
        `Step 3/3: ${placedTrunks}T ${placedAnchors}A ${placedBranches}B ${placedLeaves}L — ${rejectedCount} rejected`);

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

    return makeResult(
        placedTrunks,
        placedAnchors,
        placedBranches,
        placedLeaves,
        rejectedCount,
        changed,
        `Placed ${placedTrunks} trunks, ${placedAnchors} anchors, ${placedBranches} branches, ${placedLeaves} leaves. ${rejectedCount} rejected.`,
    );
}
