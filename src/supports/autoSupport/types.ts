import type { Vec3, SupportState } from '../types';
import type { SupportTypeId } from '../supportTypeRegistry';

/**
 * Auto-placement reports cover a subset of the support types, not all of them.
 * `Extract` keeps each subset narrow while tying the names to the registry, so
 * a renamed or misspelled type fails to compile here.
 */
export type PlacedKind = Extract<SupportTypeId, 'trunk' | 'anchor' | 'leaf' | 'branch' | 'stick' | 'twig'>;
type AttachmentKind = Extract<SupportTypeId, 'leaf' | 'branch'>;
type CavityFallbackKind = Extract<SupportTypeId, 'stick' | 'twig'>;
type OrphanKind = Extract<SupportTypeId, 'leaf' | 'branch' | 'trunk'>;

/** What one candidate resolved to: a placed support type, or no placement. */
export type PlacementOutcomeKind = SupportTypeId | 'reject';

/** A single support placement candidate derived from island/minima detection. */
export interface CandidatePoint {
    /** Unique stable id from the source DetectedIsland. */
    id: string;
    /** Contact point on the model surface in world mm coordinates. */
    tipPos: Vec3;
    /** Surface normal at the contact point (world space, smoothed). */
    tipNormal: Vec3;
    /** The model this candidate belongs to. */
    modelId: string;
    /** Which detector produced this candidate. */
    source: 'voxel' | 'minima' | 'intersection' | 'overhang' | 'stabilization';
    /** Contact footprint area of the unsupported region (mm²). 0 for minima-only. */
    islandAreaMm2: number;
    /** Z-height above build plate (mm). */
    zHeight: number;
    /** Computed placement priority. Higher = place first. */
    priority: number;
    /** Per-point tip contact override (mm). Set for small-island candidates
     *  so fine detail gets a shrunk tip without dragging the shaft down;
     *  undefined = active band default (full contact for grid/overhang points). */
    tipDiameterMm?: number;
    /** Density-grid point: must become its own standalone trunk (never merged
     *  into a nearby host) so flat regions get independent supports. */
    gridPoint?: boolean;
}

/** Why a candidate was rejected. */
export type RejectReason =
    | 'trunk_build_error'
    | 'grid_reject_collision'
    | 'grid_reject_no_attachment'
    | 'grid_reject_other'
    | 'already_supported'
    | 'exception';

/**
 * The ledger's own type set, as values. `satisfies` ties it to `PlacedKind`, so
 * adding a name here that is not a support type fails to compile.
 */
export const LEDGER_KINDS = ['trunk', 'anchor', 'leaf', 'branch', 'stick', 'twig'] as const satisfies readonly PlacedKind[];

export function isLedgerKind(kind: PlacementOutcomeKind): kind is PlacedKind {
    return (LEDGER_KINDS as readonly string[]).includes(kind);
}

/** Per-placed-entity entry in the Forest Report ledger. */
export interface ForestLedgerEntry {
    displayId: string;
    kind: PlacedKind;
    entityId: string;
    areaMm2: number;
    zHeight: number;
    preset: 'detail' | 'structure' | 'anchor';
    /** The active profile band's shaft Ø at placement (mm). */
    bandShaftMm: number;
}

/** One fan-out group in the Forest Report: a host trunk + its attachments. */
export interface ForestTree {
    hostId: string;
    hostZ: number;
    shaftDiameterMm: number;
    sizingNote: string;
    members: Array<{ id: string; kind: AttachmentKind; spanMm: number; angleDeg: number }>;
}

/** Input-side metrics from the island/overhang scan for the Forest Report. */
export interface ForestScanMetrics {
    /** Islands fed into the run (all sources). */
    islands: number;
    bySource: { voxel: number; minima: number; intersection: number; overhang: number };
    /** Overhang regions from the Rust scan (the organic/grid generators' input). */
    overhangRegions: number;
    /** Z-clusters of overhang regions; the lowest is the anchor band. */
    anchorClusters: number;
    /** Overhang regions inside the anchor band. */
    anchorRegions: number;
    /** Candidates after dedup + support filtering. */
    candidates: number;
    /** Sum of the island areas (mm²). */
    totalAreaMm2: number;
    /** Fraction of the island area covered by tips (0–100). */
    coveragePercent: number;
    /** Islands still without a nearby support at the end of the run. */
    uncoveredIslands: number;
    /** Candidates collapsed onto a higher-priority neighbour before placement. */
    dedupedAway?: number;
    /** Candidates dropped because a support tip already sits within
     *  `ALREADY_SUPPORTED_RADIUS_MM` — including one BELOW the contact, which
     *  does not hold the surface the candidate is on. */
    alreadySupported?: number;
    /** Why each rejected candidate was rejected, by reason. */
    rejectionReasons?: Partial<Record<RejectReason, number>>;
    /** Candidates rejected during placement. */
    rejected: number;
}

/** Structured per-run summary of the placed forest. */
export interface ForestReport {
    trunkCount: number;
    anchorCount: number;
    leafCount: number;
    branchCount: number;
    stickCount: number;
    twigCount: number;
    trees: ForestTree[];
    bareTrunks: Array<{ id: string; z: number; shaftDiameterMm: number; sizingNote: string }>;
    /** Input-side island/overhang scan metrics (set by the orchestrator). */
    scan?: ForestScanMetrics;
    /** Leaves/branches whose host knot drifted, crossed, or lost its host segment. */
    orphans?: OrphanInfo[];
    /** Placement diagnostics: why trunks are where they are, fan/merge refusal counts */
    diagnostics?: {
        candidatesBySource: { voxel: number; minima: number; intersection: number; overhang: number; stabilization: number };
        trunksByKind: { gridInfill: number; coverageFill: number; standalone: number };
        fanRefusals: Partial<Record<string, number>>;
        mergeRefusals: Partial<Record<string, number>>;
        /** Why consolidation (chunk fanning) refused candidates — sameZ means
         *  the surface is too flat for side-leaves at the consolidation
         *  angle (raft/connector territory). */
        consolidationRefusals: Partial<Record<string, number>>;
        /** Candidates whose trunk could not reach the plate and were bridged
         *  model-to-model instead (cavity stick/twig). Tip position = where
         *  the bridge starts; each entry is a candidate for elimination by
         *  better routing. */
        cavityFallbacks: Array<{ id: string; kind: CavityFallbackKind; tip: { x: number; y: number; z: number }; fanRefusal?: string }>;
    };
}

/** One orphaned leaf/branch — host knot missing, drifted, or path now crosses a thickened shaft. */
export interface OrphanInfo {
    id: string;
    kind: OrphanKind;
    reason: 'missingKnot' | 'missingHost' | 'missingSegment' | 'drift' | 'cross' | 'blocked' | 'trunkBlocked';
    hostId?: string;
    knotId?: string;
    detail?: string;
}



/** Competitive distribution bake-off result for anchor surfaces. */
export interface CompetitiveBakeoffAnalytics {
    /** Anchor regions that went through the bake-off. */
    anchorRegions: number;
    /** Anchor regions where grid won. */
    gridWins: number;
    /** Anchor regions where Poisson won. */
    poissonWins: number;
    /** Mean winner margin (absolute coverage delta) across bake-offs. */
    avgWinnerMargin: number;
}

/** Detailed analytics from an auto-place run. */
export interface AutoPlaceAnalytics {
    /** Number of islands that had at least one support placed near them. */
    islandsCovered: number;
    /** Number of islands that still have no nearby support. */
    islandsUncovered: number;
    /** Breakdown of candidates by assigned preset. */
    presets: { detail: number; structure: number; anchor: number };
    /** Breakdown of rejections by reason. */
    rejectionReasons: Partial<Record<RejectReason, number>>;
    /** Area coverage: sum of covered island areas / total island area (0–1). */
    areaCoverage: number;
    /** Placement-path breakdown — why trunks ended up where they did. */
    placement?: PlacementDiagnostics;
    /** Debug sizing info from the physics calculations. */
    sizingDebug?: SizingDebugInfo;
    /** Per-run forest summary: every support's id, size, and fan groups. */
    forestReport?: ForestReport;
}

/** Why a fan-leaf attempt was refused. */
export type FanLeafRefusal =
    | 'noHost'      // no shaft point within the fan radius
    | 'sameZ'       // host and target at the same height (can't attach)
    | 'angle'       // too steep from vertical
    | 'blocked'     // straight path crosses the model
    | 'build'       // leaf geometry failed
    | 'cross'       // leaf would cross another support's shaft
    | 'capacity';   // host trunk is at its attachment limit

/** Why a trunk was placed standalone instead of fanning/merging. */
export interface PlacementDiagnostics {
    /** Candidate counts by detector source. */
    candidatesBySource: { voxel: number; minima: number; intersection: number; overhang: number; stabilization: number };
    /** Placed trunks by origin. */
    trunksByKind: {
        /** Fixed-density grid points (boundary ring + lattice infill). */
        gridInfill: number;
        /** Coverage-convergence gap-fill points. */
        coverageFill: number;
        /** Non-gridPoint candidates that neither fanned nor merged. */
        standalone: number;
    };
    /** Why overhang candidates failed to fan (leaf path). */
    fanRefusals: Partial<Record<FanLeafRefusal, number>>;
    /** Why candidates failed to merge (no host vs host rejected the attachment). */
    mergeRefusals: Partial<Record<'noHost' | 'rejected', number>>;
    /** Candidates whose trunk could not reach the plate and were bridged
     *  model-to-model instead (cavity stick/twig). Tip = where the bridge
     *  starts; each entry is a candidate for elimination by better routing. */
    cavityFallbacks: Array<{ id: string; kind: CavityFallbackKind; tip: { x: number; y: number; z: number }; fanRefusal?: string }>;
}

/** Physics-based sizing debug data. */
export interface SizingDebugInfo {
    modelVolumeMm3: number;
    estimatedWeightG: number;
    totalCandidates: number;
    weightPerSupportG: number;
    avgIslandAreaMm2: number;
    /** Standalone trunks (neither fanned nor merged) — the over-supply signal. */
    standaloneTrunks: number;
    /** Trunks from the fixed-density grid (boundary ring + infill + gap fill). */
    gridInfillTrunks: number;
    shaftDiameterRange: { min: number; max: number; avg: number };
    tipContactRange: { min: number; max: number; avg: number };
}

/**
 * Outcome of an auto-place run, as a code rather than a sentence.
 *
 * The engine has no business producing display copy: it is imported by the unit
 * tests, which run under tsx with no Lingui macro transform, and a localized
 * string here would also freeze the language at call time. Callers turn the code
 * and the counts below into text.
 */
export type AutoPlaceStatus =
    /** Supports were placed; see the counts and `analytics`. */
    | 'placed'
    /** No island survived the area/angle filters, so there was nothing to try. */
    | 'no-candidates'
    /** Every candidate collapsed into another during deduplication. */
    | 'all-deduplicated'
    /** Every candidate position already carries a support. */
    | 'already-supported'
    /** Auto-support is switched off in the settings. */
    | 'disabled';

/** Result returned by the auto-place orchestrator. */
export interface AutoPlaceResult {
    placedTrunks: number;
    placedAnchors: number;
    placedBranches: number;
    placedLeaves: number;
    placedSticks: number;
    rejectedCandidates: number;
    /** Whether any supports were actually added/removed. */
    changed: boolean;
    /** What happened, as a code the UI resolves into text. */
    status: AutoPlaceStatus;
    /** Detailed analytics (undefined for no-op runs). */
    analytics?: AutoPlaceAnalytics;
}

/**
 * A fully-computed auto-support run, ready to commit.
 *
 * The pipeline computes against a local draft (no store mutations) and
 * returns the before/after pair — one `setSnapshot` + `setKickstandSnapshot`
 * + a single undoable history entry is all the caller needs. This is the
 * worker boundary: the same object is serializable to/from a Web Worker.
 */
export interface AutoSupportPlan {
    /** Support state committed before the run (for the undo payload). */
    before: SupportState;
    /** Final braced support state, kickstands included. */
    support: SupportState;
    /** Placement + coverage analytics. */
    analytics: AutoPlaceAnalytics;
    /** Counts/status — what the panel reports. */
    result: AutoPlaceResult;
}
