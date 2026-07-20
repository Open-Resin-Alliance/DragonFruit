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
const MIN_SHAFT_DIAMETER_MM = 1.0;
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
    /** Total number of candidates being placed (for weight distribution). */
    totalCandidates: number;
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
            tipContactDiameterMm: round(Math.min(tipContactBase * areaScale, shaft * 0.6), 3),
            tipBodyDiameterMm: shaft,
            tipLengthMm: round(tipLengthBase, 3),
            tipPenetrationMm: round(tipPenBase, 3),
            rootsDiameterMm: round(rootsDiaBase * clamp(areaScale * 0.8, 1.0, 1.5), 3),
            rootsDiskHeightMm: baseSettings?.roots?.diskHeightMm ?? 0.5,
            rootsConeHeightMm: baseSettings?.roots?.coneHeightMm ?? 1.0,
        };
    }

    // ── Dynamic physics-based sizing (upside-down printing) ───────
    // In bottom-up SLA the model hangs from the build plate.  The
    // build plate moves UP (+Z), so layers with higher Z are printed
    // earlier and carry the weight of all layers above them.
    //
    // A support at Z=30 must hold everything from Z=0..30.
    // A support at Z=10 only holds Z=0..10.

    const modelWeightG = ctx.modelVolumeMm3 * RESIN_DENSITY_G_PER_MM3;

    // Total model height (from bounding box or candidate Z range).
    const modelZMax = Math.max(candidate.zHeight, 30); // fallback 30mm

    // This support carries weight proportional to its Z position.
    // Higher Z = more layers above = more weight.
    const zHeight = Math.max(candidate.zHeight, 1);
    const weightFraction = zHeight / modelZMax; // 1.0 at top, ~0 at bottom
    const carriedWeightG = modelWeightG * weightFraction;

    // Peel force from the total supported area (cluster total for core
    // trunks, own area for standalone).  A core trunk supporting a
    // cluster of islands must be thicker than a standalone one.
    const effectiveArea = Math.max(totalSupportedAreaMm2 ?? candidate.islandAreaMm2, 0.01);
    const peelForceN = effectiveArea * PEEL_FORCE_N_PER_MM2;

    // Total load: weight (converted to N) + peel force.
    const loadN = carriedWeightG * 0.0098 + peelForceN;

    // Shaft diameter: scales with sqrt(load), floored at MIN.
    const shaftDiameterMm = round(
        clamp(shaftBase * clamp(Math.sqrt(loadN) * 1.2, 0.8, 2.0), MIN_SHAFT_DIAMETER_MM, MAX_SHAFT_DIAMETER_MM),
    3);

    // Tip contact: scales with this specific island's area.
    const ownArea = Math.max(candidate.islandAreaMm2, 0.01);
    const tipScale = clampStretch(ownArea, 0.05, 1.0, 0.5, 1.2);
    const tipContactDiameterMm = round(Math.min(tipContactBase * tipScale, shaftDiameterMm * 0.6), 3);
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
