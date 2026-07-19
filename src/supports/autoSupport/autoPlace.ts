import * as THREE from 'three';
import type { CandidatePoint, SupportPlan, AutoPlaceResult } from './types';
import type { AutoSupportSettings } from './settings';
import { normalizeAutoSupportSettings } from './settings';
import { generateCandidates, deduplicateCandidates } from './candidateGeneration';
import { planSupportTree } from './treeFanOut';
import { sizeParameters } from './parameterSizing';
import type { SizeOverrides } from './parameterSizing';
import { getSettings } from '../Settings/state';
import { getSnapshot, addRoot, addTrunk, addBranch, addLeaf, addKnot, addAnchor } from '../state';
import type { DetectedIsland } from '../../volumeAnalysis/Islands/types';
import { buildTrunkData } from '../SupportTypes/Trunk/trunkBuilder';
import type { TrunkBuildResult } from '../SupportTypes/Trunk/trunkBuilder';
import { buildBranchData } from '../SupportTypes/Branch/branchBuilder';
import { buildLeafData } from '../SupportTypes/Leaf/leafBuilder';
import { buildAnchorData } from '../SupportTypes/Anchor/anchorBuilder';
import { runAutoBracing } from '../autoBracing/autoBrace';
import { pushHistory } from '@/history/historyStore';

const LOG_PREFIX = '[AutoSupport]';

/**
 * History action type for auto-place operations.
 *
 * Defined inline here until it is permanently added to
 * {@link src/supports/history/actionTypes.ts}.  Follows the existing
 * `'support:<verb>' as const` convention used by the other action types
 * (e.g. `SUPPORT_AUTO_BRACE_REPLACE`).
 */
const SUPPORT_AUTO_PLACE = 'support:auto-place' as const;

// ---------------------------------------------------------------------------
// Internal return type — carries computed geometry for the state-commit
// caller in addition to the public AutoPlaceResult summary.
// ---------------------------------------------------------------------------

export interface AutoPlaceInternalResult extends AutoPlaceResult {
    /** Computed trunk results, keyed by candidate id.  The caller commits
     *  each trunk's root + shaft to state and records knots for branch/leaf
     *  attachment. */
    _trunkResults: Map<string, TrunkBuildResult>;
    /** The full support plan so the caller can iterate branches/leaves and
     *  resolve their placeholder knots against real trunk shaft positions. */
    _plan: SupportPlan;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function distance(a: { x: number; y: number; z: number }, b: { x: number; y: number; z: number }): number {
    const dx = a.x - b.x;
    const dy = a.y - b.y;
    const dz = a.z - b.z;
    return Math.sqrt(dx * dx + dy * dy + dz * dz);
}

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
// runAutoPlace
// ---------------------------------------------------------------------------

/**
 * Run the complete auto-support pipeline:
 *
 * 1. Generate candidate points from detected islands
 * 2. Deduplicate candidates spatially
 * 3. Plan a support tree (clusters, core trunks, branch/leaf fan-out)
 * 4. Build support geometry for each planned element
 * 5. Return the results (state commit is done by the caller)
 *
 * This function is PURE — it does not mutate global state.
 * The caller is responsible for committing results to SupportState
 * and running auto-bracing afterward.
 *
 * @param islands  - Detected islands from the combined island/minima scan.
 * @param modelId  - The model to place supports for.
 * @param mesh     - Optional THREE.js mesh for surface normal queries and
 *                   collision-aware pathfinding.  When omitted, trunks fall
 *                   back to standard (non-collision) placement.
 * @param settingsOverride - Partial auto-support settings that are merged
 *                           on top of the module defaults.  (The full
 *                           {@link SupportSettings} from the settings store
 *                           are also read internally for support sizing.)
 * @returns A summary of what was placed / rejected, plus internal geometry
 *          data (`_trunkResults`, `_plan`) for the state-commit caller.
 */
export function runAutoPlace(
    islands: DetectedIsland[],
    modelId: string,
    mesh?: THREE.Mesh,
    settingsOverride?: Partial<AutoSupportSettings>,
): AutoPlaceInternalResult {
    // ------------------------------------------------------------------
    // 0. Settings
    // ------------------------------------------------------------------

    const supportSettings = getSettings();

    // AutoSupportSettings are not yet stored inside SupportSettings, so
    // we merge the caller's override on top of the module defaults.
    const autoSettings = normalizeAutoSupportSettings(settingsOverride ?? undefined);

    if (!autoSettings.enabled) {
        return {
            ...makeResult(0, 0, 0, 0, 0, false, 'Auto-support is disabled.'),
            _trunkResults: new Map(),
            _plan: { trunks: [], anchors: [], branches: [], leaves: [], rejectedCandidates: [] },
        };
    }

    // Capture the before-snapshot for the eventual history entry.
    // (Not pushed to history yet — see TODO at the bottom.)
    const beforeSnapshot = getSnapshot();

    // ------------------------------------------------------------------
    // 1. Generate candidates
    // ------------------------------------------------------------------

    console.log(LOG_PREFIX, `Input: ${islands.length} islands from scan`);

    let candidates = generateCandidates(islands, autoSettings);
    console.log(LOG_PREFIX, `Step 1/4: ${candidates.length} candidates generated (filtered from ${islands.length} islands, min area ${autoSettings.minIslandAreaMm2}mm²)`);

    // Attach the target modelId (generateCandidates leaves it empty).
    candidates = candidates.map((c): CandidatePoint => ({ ...c, modelId }));

    if (candidates.length === 0) {
        void beforeSnapshot;
        return {
            ...makeResult(0, 0, 0, 0, 0, false, 'No viable support candidates found.'),
            _trunkResults: new Map(),
            _plan: { trunks: [], anchors: [], branches: [], leaves: [], rejectedCandidates: [] },
        };
    }

    // ------------------------------------------------------------------
    // 2. Deduplicate
    // ------------------------------------------------------------------

    const beforeDedup = candidates.length;
    candidates = deduplicateCandidates(candidates, autoSettings);
    console.log(LOG_PREFIX, `Step 2/4: ${candidates.length} candidates after dedup (removed ${beforeDedup - candidates.length} within ${autoSettings.tipInfluenceRadiusMm}mm influence radius)`);

    if (candidates.length === 0) {
        void beforeSnapshot;
        return {
            ...makeResult(0, 0, 0, 0, 0, false, 'All candidates deduplicated — nothing to place.'),
            _trunkResults: new Map(),
            _plan: { trunks: [], anchors: [], branches: [], leaves: [], rejectedCandidates: [] },
        };
    }

    // ------------------------------------------------------------------
    // 3. Plan support tree
    // ------------------------------------------------------------------

    const plan: SupportPlan = planSupportTree(candidates, autoSettings);
    console.log(LOG_PREFIX, `Step 3/4: Tree plan → ${plan.trunks.length}T ${plan.anchors.length}A ${plan.branches.length}B ${plan.leaves.length}L ${plan.rejectedCandidates.length}R (cluster radius ${autoSettings.clusterRadiusMm}mm, max branch reach ${autoSettings.maxBranchReachMm}mm)`);

    // ------------------------------------------------------------------
    // 4. Build geometry and commit to state
    // ------------------------------------------------------------------
    // Each builder returns the computed geometry without touching global
    // state.  When the TODO(state-commit) blocks below are filled in, the
    // returned entities (Roots, Trunk, Branch, Leaf, Anchor, Knot) will be
    // committed via addRoot / addTrunk / addBranch / addLeaf / addAnchor /
    // addKnot.

    let placedTrunks = 0;
    let placedAnchors = 0;
    let placedBranches = 0;
    let placedLeaves = 0;
    const rejected: Array<{ candidate: CandidatePoint; reason: string }> = [
        ...plan.rejectedCandidates,
    ];

    // Per-candidate trunk results for the state-commit caller.
    const trunkResults = new Map<string, TrunkBuildResult>();

    // -- 4a. Anchors ---------------------------------------------------

    for (const { candidate } of plan.anchors) {
        try {
            const { anchor, supportData: _supportData } = buildAnchorData({
                tipPos: candidate.tipPos,
                tipNormal: candidate.tipNormal,
                modelId,
                mesh,
            });

            addAnchor(anchor);
            console.log(LOG_PREFIX, `Anchor placed: ${candidate.id} at Z=${candidate.zHeight.toFixed(1)}mm`);
            placedAnchors++;
        } catch (e) {
            rejected.push({
                candidate,
                reason: `Anchor build failed: ${e instanceof Error ? e.message : String(e)}`,
            });
        }
    }

    // -- 4b. Trunks ----------------------------------------------------

    for (const { candidate, overrides } of plan.trunks) {
        try {
            // Compute size overrides from the island geometry.
            // For standalone (single-candidate) trunks the supported area
            // equals the candidate's own area.  For core trunks (those
            // selected as the core of a multi-candidate cluster) the
            // caller should eventually pass the summed area of the whole
            // cluster — tracked via the `totalSupportedAreaMm2` param.
            const sizedOverrides: SizeOverrides = sizeParameters(
                candidate,
                candidate.islandAreaMm2,
                candidate.zHeight,
                supportSettings,
            );

            const mergedOverrides = { ...sizedOverrides, ...overrides };

            const result = buildTrunkData({
                tipPos: candidate.tipPos,
                tipNormal: candidate.tipNormal,
                modelId,
                mesh,
                overrides: mergedOverrides,
                isPreview: false,
            });

            if (result.error) {
                rejected.push({
                    candidate,
                    reason: `Trunk build error: ${result.error}`,
                });
                continue;
            }

            addRoot(result.root);
            addTrunk(result.trunk);
            console.log(LOG_PREFIX, `Trunk placed: ${candidate.id} area=${candidate.islandAreaMm2.toFixed(2)}mm² Z=${candidate.zHeight.toFixed(1)}mm shaft=Ø${(mergedOverrides.shaftDiameterMm ?? supportSettings.shaft.diameterMm).toFixed(2)}mm`);

            trunkResults.set(candidate.id, result);
            placedTrunks++;
        } catch (e) {
            rejected.push({
                candidate,
                reason: `Trunk build failed: ${e instanceof Error ? e.message : String(e)}`,
            });
        }
    }

    // -- 4c. Branches --------------------------------------------------

    for (const { candidate, parentKnot } of plan.branches) {
        try {
            // NOTE: parentKnot from planSupportTree is a placeholder.
            // Before committing, the knot must be resolved to a real
            // position on the parent trunk shaft.  Currently the knot's
            // parentShaftId is empty and its pos is the core tip position.
            // The resolution step will be added once state-commit is
            // integrated.
            const result = buildBranchData({
                tipPos: candidate.tipPos,
                tipNormal: candidate.tipNormal,
                modelId,
                parentKnot,
                mesh,
            });

            addKnot(parentKnot);
            addBranch(result.branch);
            console.log(LOG_PREFIX, `Branch placed: ${candidate.id} → host knot on shaft ${parentKnot.parentShaftId || '(placeholder)'}`);
            placedBranches++;
        } catch (e) {
            rejected.push({
                candidate,
                reason: `Branch build failed: ${e instanceof Error ? e.message : String(e)}`,
            });
        }
    }

    // -- 4d. Leaves ----------------------------------------------------

    for (const { candidate, parentKnot, hostDiameterMm } of plan.leaves) {
        try {
            // NOTE: parentKnot is a placeholder (same caveat as branches).
            const result = buildLeafData({
                tipPos: candidate.tipPos,
                surfaceNormal: candidate.tipNormal,
                modelId,
                parentKnot,
                hostDiameterMm:
                    hostDiameterMm > 0
                        ? hostDiameterMm
                        : supportSettings.shaft.diameterMm,
                mesh,
            });

            addKnot(parentKnot);
            addLeaf(result.leaf);
            console.log(LOG_PREFIX, `Leaf placed: ${candidate.id} span=${distance(candidate.tipPos, parentKnot.pos).toFixed(1)}mm`);
            placedLeaves++;
        } catch (e) {
            rejected.push({
                candidate,
                reason: `Leaf build failed: ${e instanceof Error ? e.message : String(e)}`,
            });
        }
    }

    // ------------------------------------------------------------------
    // 5. Assemble result
    // ------------------------------------------------------------------

    const totalRejected = rejected.length;
    const changed =
        placedTrunks > 0 ||
        placedAnchors > 0 ||
        placedBranches > 0 ||
        placedLeaves > 0;

    console.log(LOG_PREFIX, `Step 4/4: Built ${placedTrunks}T ${placedAnchors}A ${placedBranches}B ${placedLeaves}L — ${totalRejected} rejected${changed ? '' : ' (no changes)'}`);

    // ------------------------------------------------------------------
    // 6. State commit — auto-bracing + history
    // ------------------------------------------------------------------

    if (changed) {
        console.log(LOG_PREFIX, `Committing ${placedTrunks}T ${placedAnchors}A ${placedBranches}B ${placedLeaves}L — running auto-brace...`);

        // Auto-brace the newly placed supports.
        try {
            const braceResult = runAutoBracing();
            console.log(LOG_PREFIX, `Auto-brace: ${braceResult.message}`);
        } catch (e) {
            console.warn(LOG_PREFIX, `Auto-brace failed (non-fatal): ${e instanceof Error ? e.message : String(e)}`);
        }

        // Push an undo entry so the user can revert the entire operation.
        try {
            const afterSnapshot = getSnapshot();
            pushHistory({
                type: SUPPORT_AUTO_PLACE,
                payload: { before: beforeSnapshot, after: afterSnapshot },
            });
            console.log(LOG_PREFIX, 'History entry pushed — undo available.');
        } catch (e) {
            console.warn(LOG_PREFIX, `History push failed (non-fatal): ${e instanceof Error ? e.message : String(e)}`);
        }
    }

    return {
        placedTrunks,
        placedAnchors,
        placedBranches,
        placedLeaves,
        rejectedCandidates: totalRejected,
        changed,
        message: `Placed ${placedTrunks} trunks, ${placedAnchors} anchors, ${placedBranches} branches, ${placedLeaves} leaves. ${totalRejected} rejected.`,
        _trunkResults: trunkResults,
        _plan: plan,
    };
}
