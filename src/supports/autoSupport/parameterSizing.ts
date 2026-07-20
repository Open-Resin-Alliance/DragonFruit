import type { CandidatePoint } from './types';
import type { SupportSettings } from '../Settings/types';

// ---------------------------------------------------------------------------
// Physics constants
// ---------------------------------------------------------------------------

/** Typical SLA resin density (g/mm³).  ~1.1 g/cm³. */
const RESIN_DENSITY_G_PER_MM3 = 0.0011;
/** Approximate peel force per mm² of cross-section (N/mm²).
 *  Real measured values are 0.1–0.5 N/mm² for typical resins. */
const PEEL_FORCE_N_PER_MM2 = 0.2;
/** Base shaft diameter floor (mm).  Supports thinner than this
 *  are too fragile for any practical load. */
const MIN_SHAFT_DIAMETER_MM = 0.75;
/** Maximum shaft diameter (mm). */
const MAX_SHAFT_DIAMETER_MM = 2.5;

// ---------------------------------------------------------------------------
// Override type
// ---------------------------------------------------------------------------

export interface SizeOverrides {
    shaftDiameterMm?: number;
    tipContactDiameterMm?: number;
    tipBodyDiameterMm?: number;
    tipLengthMm?: number;
    tipPenetrationMm?: number;
    rootsDiameterMm?: number;
    rootsDiskHeightMm?: number;
    rootsConeHeightMm?: number;
}

/** Context passed from the orchestrator for model-level sizing. */
export interface ModelSizingContext {
    /** Estimated model volume in mm³ (from bounding box or mesh). */
    modelVolumeMm3: number;
    /** Total number of candidates being placed. */
    totalCandidates: number;
    /** Number of candidates at or below this candidate's Z height.
     *  These share the weight of layers above this Z. */
    candidatesBelowZ: number;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Compute support dimensions dynamically using physics-informed scaling.
 *
 * Shaft diameter scales with estimated load (model weight per support +
 * peel force from island area).  Tip diameter scales with island area.
 * Root diameter and base flare scale with trunk height.
 *
 * Falls back to preset-based sizing when no model context is available.
 *
 * @param candidate  - The island to size supports for.
 * @param ctx        - Optional model-level context for dynamic sizing.
 *                     When omitted, falls back to heuristic scaling from
 *                     island area alone.
 * @param baseSettings - The user's current support settings (baseline).
 */
export function sizeParameters(
    candidate: CandidatePoint,
    ctx?: ModelSizingContext,
    baseSettings?: SupportSettings,
    /** For core trunks: total area of all candidates this trunk supports
     *  (own area + branches + leaves).  For standalone trunks: own area. */
    totalSupportedAreaMm2?: number,
): SizeOverrides {
    // ── Baseline from user settings ───────────────────────────────
    const shaftBase = baseSettings?.shaft?.diameterMm ?? 1.0;
    const tipContactBase = baseSettings?.tip?.contactDiameterMm ?? 0.3;
    const tipLengthBase = baseSettings?.tip?.lengthMm ?? 2.5;
    const tipPenBase = baseSettings?.tip?.penetrationMm ?? 0.1;
    const rootsDiaBase = baseSettings?.roots?.diameterMm ?? 2.0;

    if (!ctx) {
        // No model context — use island-area-based heuristic scaling.
        const area = Math.max(candidate.islandAreaMm2, 0.01);
        const areaScale = clampStretch(area, 0.1, 2.0, 0.8, 1.5);
        const shaft = round(shaftBase * areaScale, 3);
        return {
            shaftDiameterMm: shaft,
            tipContactDiameterMm: round(clamp(tipContactBase * areaScale, shaft * 0.3, shaft * 0.6), 3),
            tipBodyDiameterMm: shaft,
            tipLengthMm: round(tipLengthBase, 3),
            tipPenetrationMm: round(tipPenBase, 3),
            rootsDiameterMm: round(rootsDiaBase * clamp(areaScale * 0.8, 1.0, 1.5), 3),
            rootsDiskHeightMm: baseSettings?.roots?.diskHeightMm ?? 0.5,
            rootsConeHeightMm: baseSettings?.roots?.coneHeightMm ?? 1.0,
        };
    }

    // ── Dynamic physics-based sizing (upside-down printing) ───────
    // In bottom-up SLA the model hangs from the build plate (Z=0).
    // Supports at low Z are printed first and carry everything above.
    //
    // Weight is distributed simply: the N supports at or below Z
    // share the weight of all layers remaining above Z.

    const modelWeightG = ctx.modelVolumeMm3 * RESIN_DENSITY_G_PER_MM3;
    const zHeight = Math.max(candidate.zHeight, 1);
    const modelZMax = Math.max(candidate.zHeight, 30);

    // Count supports at or below this Z (including this one).
    const supportsBelow = ctx.candidatesBelowZ ?? ctx.totalCandidates;
    const weightFraction = (modelZMax - zHeight) / modelZMax;
    const carriedWeightG = (modelWeightG * weightFraction) / Math.max(supportsBelow, 1);

    // Peel force from the supported area.
    const effArea = Math.max(totalSupportedAreaMm2 ?? candidate.islandAreaMm2, 0.01);
    const peelForceN = effArea * PEEL_FORCE_N_PER_MM2;

    // Total load.  Mesh minima are point contacts — 1.5× factor
    // because peel stress concentrates at a single sharp tip.
    const rawLoadN = carriedWeightG * 0.0098 + peelForceN;
    const loadN = candidate.source === 'minima' ? rawLoadN * 1.5 : rawLoadN;

    // Shaft diameter: scales with sqrt(load), floored at MIN.
    const shaftDiameterMm = round(
        clamp(shaftBase * clamp(Math.sqrt(loadN) * 1.2, 0.8, 2.0), MIN_SHAFT_DIAMETER_MM, MAX_SHAFT_DIAMETER_MM),
    3);

    // Tip contact: scaled by island area, but never thinner than 30%
    // of the shaft — a thick shaft needs a decent tip to transfer load.
    const ownArea = Math.max(candidate.islandAreaMm2, 0.01);
    const tipScale = clampStretch(ownArea, 0.05, 1.0, 0.5, 1.2);
    const tipContactDiameterMm = round(
        clamp(tipContactBase * tipScale, shaftDiameterMm * 0.3, shaftDiameterMm * 0.6),
    3);
    const tipBodyDiameterMm = shaftDiameterMm;

    // Tip length: slightly longer for taller supports.
    const tipLengthMm = round(tipLengthBase * clamp(1 + (zHeight - 10) / 100, 0.9, 1.3), 3);

    // Penetration: proportional to tip size.
    const tipPenetrationMm = round(Math.max(tipPenBase, tipContactDiameterMm * 0.25), 3);

    // Root diameter: wider for taller/heavier supports.
    const rootScale = clamp(Math.sqrt(loadN) * 0.6, 0.8, 1.8);
    const rootsDiameterMm = round(clamp(rootsDiaBase * rootScale, rootsDiaBase, 4.0), 3);

    return {
        shaftDiameterMm,
        tipContactDiameterMm,
        tipBodyDiameterMm,
        tipLengthMm,
        tipPenetrationMm,
        rootsDiameterMm,
        rootsDiskHeightMm: baseSettings?.roots?.diskHeightMm ?? 0.5,
        rootsConeHeightMm: baseSettings?.roots?.coneHeightMm ?? 1.0,
    };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function clamp(value: number, min: number, max: number): number {
    return Math.min(max, Math.max(min, value));
}

/** Clamp a value after linear remapping from [loIn, hiIn] to [loOut, hiOut]. */
function clampStretch(
    value: number,
    loIn: number, hiIn: number,
    loOut: number, hiOut: number,
): number {
    const t = (value - loIn) / (hiIn - loIn);
    return clamp(loOut + t * (hiOut - loOut), loOut, hiOut);
}

function round(value: number, decimals: number): number {
    return Number(value.toFixed(decimals));
}
