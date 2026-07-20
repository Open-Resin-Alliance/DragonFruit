import type { Vec3, Knot } from '../types';

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
    source: 'voxel' | 'minima' | 'intersection';
    /** Max cross-sectional area of the unsupported region (mm²). 0 for minima-only. */
    islandAreaMm2: number;
    /** Z-height above build plate (mm). */
    zHeight: number;
    /** Estimated overhang angle from horizontal (degrees). 90 = flat ceiling. */
    overhangAngleDeg: number;
    /** Computed placement priority. Higher = place first. */
    priority: number;
}

/** A cluster of spatially-close candidates that can share a core trunk. */
export interface TreeCluster {
    /** Unique cluster id. */
    id: string;
    /** All candidates in this cluster. */
    candidates: CandidatePoint[];
    /** The candidate selected as the core trunk (largest area, lowest Z). */
    core: CandidatePoint;
    /** Remaining candidates that will fan out as branches/leaves from the core. */
    satellites: CandidatePoint[];
}

/** A complete support placement plan ready for execution. */
export interface SupportPlan {
    /** Trunks to place (each gets a root + shaft). */
    trunks: Array<{ candidate: CandidatePoint; overrides?: Record<string, number> }>;
    /** Anchors for tips < 5mm from the build plate. */
    anchors: Array<{ candidate: CandidatePoint }>;
    /** Branches fanning from existing trunk knots. Knot is pre-computed. */
    branches: Array<{ candidate: CandidatePoint; parentKnot: Knot }>;
    /** Leaves for tips within 2.5mm of a host knot. */
    leaves: Array<{ candidate: CandidatePoint; parentKnot: Knot; hostDiameterMm: number }>;
    /** Candidates that could not be placed (collision, no reachable host, etc.). */
    rejectedCandidates: Array<{ candidate: CandidatePoint; reason: string }>;
}

/** Why a candidate was rejected. */
export type RejectReason =
    | 'trunk_build_error'
    | 'grid_reject_collision'
    | 'grid_reject_no_attachment'
    | 'grid_reject_other'
    | 'already_supported'
    | 'exception';

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
    /** Debug sizing info from the physics calculations. */
    sizingDebug?: SizingDebugInfo;
}

/** Physics-based sizing debug data. */
export interface SizingDebugInfo {
    modelVolumeMm3: number;
    estimatedWeightG: number;
    totalCandidates: number;
    weightPerSupportG: number;
    avgIslandAreaMm2: number;
    avgPeelForceN: number;
    shaftDiameterRange: { min: number; max: number; avg: number };
    tipContactRange: { min: number; max: number; avg: number };
}

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
    /** Human-readable summary for UI feedback. */
    message: string;
    /** Detailed analytics (undefined for no-op runs). */
    analytics?: AutoPlaceAnalytics;
}
