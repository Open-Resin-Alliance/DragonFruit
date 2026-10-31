import { clamp, round } from '@/utils/math';
import type { CandidatePoint } from './types';
import { getSettings } from '../Settings/state';
import { getPresetById } from '../Settings/presets';
import { AUTO_SUPPORT_CONSTRAINTS, MIN_CONTACT_TIP_DIAMETER_MM, SIZING_BANDS } from './settings';
import type { SizingBand, SizingPreset } from './settings';
import type { SupportSettings } from '../Settings/types';

// ---------------------------------------------------------------------------
// Empirical sizing (locked: no physics pretense)
// ---------------------------------------------------------------------------
//
// The band is BORROWED from a Support Studio preset: `autoSupport.sizingPreset`
// names it, and `activeSizingBand()` resolves that id on every run (a deleted
// preset falls back to the factory `structure` band). The old area-derived shaft
// curve inverted the profiles — a light 16 mm² cell sized THICKER (1.28 mm) than
// a heavy 5 mm² cell (1.12 mm) because the curve rose with the cell area — so
// sizing reads the resolved band, never a tier name. The
// merged-cluster tail, the height factor and the model factor (print scale ×
// mass per support) ride on top of the band, all three floored at ×1 so the
// light end is untouched.
//
// Tip contact: band × underside angle (flat ceilings get the full contact,
// steeper slopes less), floored at 30% of the shaft so a thick shaft keeps a
// proportional tip. Roots ride with the shaft; tip length and penetration are
// the band, flat.
//
// The forest resize pass (post-placement, before commit) thickens trunks
// that actually carry branches — a trunk with four branches gets thicker, a
// lone trunk stays at its placed diameter.

/** Merge sizing overrides into a settings snapshot. The settingsCodeHex
 *  stamped on a placed support must describe the geometry ACTUALLY built
 *  (tier band after overrides), not the global band — otherwise Support
 *  Studio loads the wrong parameters for the selected support and any edit
 *  clobbers the sized geometry. */
export function applySizingOverridesToSettings(
    settings: SupportSettings,
    overrides?: Partial<SizeOverrides>,
): SupportSettings {
    if (!overrides) return settings;
    return {
        ...settings,
        shaft: {
            ...settings.shaft,
            diameterMm: overrides.shaftDiameterMm ?? settings.shaft.diameterMm,
        },
        tip: {
            ...settings.tip,
            contactDiameterMm: overrides.tipContactDiameterMm ?? settings.tip.contactDiameterMm,
            bodyDiameterMm: overrides.tipBodyDiameterMm ?? settings.tip.bodyDiameterMm,
            lengthMm: overrides.tipLengthMm ?? settings.tip.lengthMm,
            penetrationMm: overrides.tipPenetrationMm ?? settings.tip.penetrationMm,
        },
        roots: {
            ...settings.roots,
            diameterMm: overrides.rootsDiameterMm ?? settings.roots.diameterMm,
            diskHeightMm: overrides.rootsDiskHeightMm ?? settings.roots.diskHeightMm,
            coneHeightMm: overrides.rootsConeHeightMm ?? settings.roots.coneHeightMm,
        },
    };
}

/** The band a Support Studio preset carries: its tip, shaft and roots, read as
 *  the seven numbers the sizing paths use. Pure read — the preset is never
 *  written here. */
function sizingBandOfPreset(id: string | null | undefined): SizingBand | null {
    const preset = id ? getPresetById(id) : undefined;
    if (!preset) return null;
    const { tip, shaft, roots } = preset.settings;
    return {
        shaftDiameterMm: shaft.diameterMm,
        tipContactDiameterMm: tip.contactDiameterMm,
        tipLengthMm: tip.lengthMm,
        tipPenetrationMm: tip.penetrationMm,
        rootDiameterMm: roots.diameterMm,
        rootDiskHeightMm: roots.diskHeightMm,
        rootConeHeightMm: roots.coneHeightMm,
    };
}

/**
 * The band table a worker run resolves against, set from the payload it is handed.
 *
 * The worker has no storage, so it has no Support Studio presets beyond the
 * factory ones: a run naming a preset the user made would fall back to
 * `structure` there while the app resolved the user's own numbers. The main
 * thread therefore resolves every id the run can name and hands the numbers over,
 * and the worker reads them verbatim.
 */
let resolvedSizingBands: Record<string, SizingBand> | null = null;

export function setResolvedSizingBands(bands: Record<string, SizingBand> | null): void {
    resolvedSizingBands = bands;
}

/**
 * The bands a worker run may resolve, by Support Studio preset id: the run's own
 * tier plus the three analytic tiers the load budget weighs against. Called on the
 * thread that can reach the preset table, before the run is handed to a worker.
 */
export function resolvedSizingBandsForRun(id: string | null | undefined): Record<string, SizingBand> {
    const ids = new Set(['detail', 'structure', 'anchor', id ?? 'structure']);
    return Object.fromEntries([...ids].map((presetId) => [presetId, resolveSizingBand(presetId)]));
}

/**
 * The band a tier id resolves to: the band this thread was handed (a worker run),
 * else the Support Studio preset's own numbers, else the factory `structure` band.
 * Never throws — a user can delete a preset an auto-support block still names, and
 * the run has to size with something.
 */
export function resolveSizingBand(id: string | null | undefined): SizingBand {
    const band = (id ? resolvedSizingBands?.[id] : undefined) ?? sizingBandOfPreset(id) ?? SIZING_BANDS.structure;
    // A preset's tip is an editable profile field. A run never prints a contact
    // below the published floor, whatever the preset (or a worker's resolved
    // copy of it) carries.
    return band.tipContactDiameterMm >= MIN_CONTACT_TIP_DIAMETER_MM
        ? band
        : { ...band, tipContactDiameterMm: MIN_CONTACT_TIP_DIAMETER_MM };
}

/** The band the run sizes with: the Support Studio preset the live settings name. */
export function activeSizingBand(): SizingBand {
    return resolveSizingBand(getSettings().autoSupport?.sizingPreset);
}

/** Tip contact for small-island candidates: the factory `detail` tier's tip,
 *  resolved the same way, so fine detail gets a shrunk tip without dragging the
 *  shaft down to the detail band. */
export function smallIslandTipDiameterMm(): number {
    return resolveSizingBand('detail').tipContactDiameterMm;
}

/** Area a merged cluster must exceed before the shaft tail engages (mm²).
 *  Grid cells sit FLAT at the band — the lattice reads exactly the band,
 *  whatever its density. */
const CELL_REFERENCE_AREA_MM2 = 8;

/** Maximum shaft diameter (mm) for very large single supports. */
const MAX_SHAFT_DIAMETER_MM = 2.0;

/**
 * Combined ceiling on the three run-level model factors (mm-equivalent).
 *
 * Each factor has its own cap, but they multiply: 1.45 × 1.3 × 1.35 = 2.54,
 * and a tall support on a large heavy part reached thicknesses the documented
 * "up to ×1.85" never promised. The user's `sizeScale` stays outside this
 * ceiling — that is an explicit instruction, not a curve.
 */
const MAX_MODEL_SCALE_FACTOR = 1.85;

// ---------------------------------------------------------------------------
// Model-scale sizing: the three factors that ride ON TOP of the settings band
// (and under the user's `sizeScale` master multiplier).
//
// Direction is physical, values are calibration — the same deal the bands
// themselves are on. Each factor is a bounded power law of one input, floored
// at 1.0: NONE of them can thin a support below its band, so the light end
// (minis — the tier that already works) is provably untouched, and every
// factor is monotone in its own input. That is the property the removed
// area-derived shaft curve lacked: it inverted the tiers, because a light
// 16 mm² cell sized THICKER than a heavy 5 mm² one.
//
//  - Size: a bigger print is a bigger lever on every support. Euler buckling
//    wants d ∝ L^0.5 under a fixed load and thicker still once the load scales
//    with the part, so the exponent is positive and sub-linear.
//  - Load share: model weight / support count = the resin one trunk carries.
//    Mass per support is a load share, not a force estimate.
//  - Height: a column's buckling load falls with the square of its length, so
//    the same contact needs a thicker column the further it is from the plate.
// ---------------------------------------------------------------------------

/** Model extent (mm, bbox diagonal) at or below which supports are at band. */
export const SIZE_REFERENCE_MM = 60;
export const SIZE_EXPONENT = 0.3;

/** Resin grams per support at or below which supports are at band. */
export const SHARE_REFERENCE_G = 0.6;
export const SHARE_EXPONENT = 0.25;

/** Support height (mm) at or below which supports are at band. */
export const HEIGHT_REFERENCE_MM = 20;
export const HEIGHT_EXPONENT = 0.35;

/** Contact tip never narrower than this fraction of the shaft it sits on. */
export const TIP_CONTACT_MIN_SHAFT_RATIO = 0.3;

// The three caps are no longer constants: they are the `autoSupport`
// `modelSizeFactorCap` / `modelLoadFactorCap` / `heightFactorCap` settings, so a
// calibration has one home (`AUTO_SUPPORT_CONSTRAINTS` owns the defaults) and
// cannot drift from a second literal here.

/** Resin density (g/mm³) — 1.1 g/cm³. One figure for the sizing and its reports. */
export const RESIN_DENSITY_G_PER_MM3 = 0.0011;

function powerFactor(ratio: number, exponent: number, maxFactor: number): number {
    if (!(ratio > 1)) return 1;
    return Math.min(maxFactor, Math.pow(ratio, exponent));
}

/** The run-level terms the sizing reads, and what they resolved to. */
export interface ModelSizingFactors {
    /** Model extent (mm) the size term read. */
    sizeMm: number;
    /** Resin grams per support the load term read. */
    loadShareG: number;
    /** Geometric scale of the print, ×1 … the configured size cap. */
    sizeFactor: number;
    /** Mass one support carries, ×1 … the configured load cap. */
    loadFactor: number;
    /** sizeFactor × loadFactor — the run-level multiplier on shaft and roots. */
    trunkScale: number;
}

/** The live model-scale calibrations, read from the `autoSupport` settings. */
function modelSizingConfig(): { enabled: boolean; sizeCap: number; loadCap: number; heightCap: number } {
    const auto = getSettings().autoSupport;
    return {
        enabled: auto?.modelScaleEnabled ?? true,
        sizeCap: auto?.modelSizeFactorCap ?? AUTO_SUPPORT_CONSTRAINTS.modelSizeFactorCap.defaultValue,
        loadCap: auto?.modelLoadFactorCap ?? AUTO_SUPPORT_CONSTRAINTS.modelLoadFactorCap.defaultValue,
        heightCap: auto?.heightFactorCap ?? AUTO_SUPPORT_CONSTRAINTS.heightFactorCap.defaultValue,
    };
}

/**
 * Resolve the run-level sizing terms from the model context. Absent context
 * (a bare `sizeParameters` call — tests, callers with no mesh) returns all
 * ones, so sizing is exactly the band. `autoSupport.modelScaleEnabled === false`
 * pins every factor to ×1 the same way.
 */
export function modelSizingFactors(ctx?: ModelSizingContext): ModelSizingFactors {
    const { enabled, sizeCap, loadCap } = modelSizingConfig();
    const sizeMm = ctx?.modelSizeMm ?? 0;
    const shareG = ctx && ctx.totalCandidates > 0
        ? (ctx.modelVolumeMm3 * RESIN_DENSITY_G_PER_MM3) / ctx.totalCandidates
        : 0;
    const sizeFactor = enabled && sizeMm > 0
        ? powerFactor(sizeMm / SIZE_REFERENCE_MM, SIZE_EXPONENT, sizeCap)
        : 1;
    const loadFactor = enabled && shareG > 0
        ? powerFactor(shareG / SHARE_REFERENCE_G, SHARE_EXPONENT, loadCap)
        : 1;
    return {
        sizeMm,
        loadShareG: shareG,
        sizeFactor,
        loadFactor,
        trunkScale: sizeFactor * loadFactor,
    };
}

/** The tier a supported area (mm²) falls in — the factory bands' own label,
 *  used by the forest ledger and the load budget's relative weighting. Sizing
 *  does NOT read it: the band is the settings' `sizingBand`. */
export function presetForArea(areaMm2: number): SizingPreset {
    if (areaMm2 <= 0.15) return 'detail';
    if (areaMm2 <= 0.5) return 'structure';
    return 'anchor';
}

/** Shaft diameter: the band, then a gentle log tail beyond the cell
 *  reference for merged clusters (sub-linear — strength grows with the
 *  cross-section, not the area). A grid cell is FLAT at the band.
 *  The anchor girth multiplier is declared on the descriptor but not applied
 *  here — see docs/dev/support-registry-findings.md. */
function shaftDiameterForArea(baseDiameterMm: number, areaMm2: number): number {
    const a = Math.max(areaMm2, 0.01);
    const tail = a > CELL_REFERENCE_AREA_MM2
        ? 0.06 * Math.log(a / CELL_REFERENCE_AREA_MM2)
        : 0;
    return Math.min(MAX_SHAFT_DIAMETER_MM, baseDiameterMm + tail);
}

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
    /** Estimated model volume (mm³, from the mesh — exact tetrahedron sum). */
    modelVolumeMm3: number;
    /** Model top Z (world mm). */
    modelZMaxMm?: number;
    /** Total number of candidates being placed. */
    totalCandidates: number;
    /** Model extent in mm (world-frame bbox diagonal) — the size term's input. */
    modelSizeMm?: number;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Empirical sizing for an auto-support candidate.
 *
 * - Shaft: the active settings band (`autoSupport.sizingBand`) × height
 *   factor × model factor, then the candidate's OWN island area
 *   rides a gentle log tail above that (sub-linear — strength grows with the
 *   cross-section, not the area), capped at MAX_SHAFT_DIAMETER_MM.
 * - Model factor (`modelSizingFactors`): the run-level geometric scale of the
 *   print and the resin mass one support carries. Absent context = ×1, so a
 *   caller with no mesh gets the band exactly.
 * - Tip contact: band × angle factor — a flat ceiling (normal
 *   straight down, |z| ≈ 1) gets the full band contact; a steep slope is
 *   closer to self-supporting and gets a smaller one (down to 60%). Floored
 *   at 30% of the shaft — unless the candidate carries a per-point
 *   tipDiameterMm (small-island shrunk tip), which bypasses band and floor.
 * - Roots: the band, scaled with the trunk. The pad keeps its ratio to the
 *   shaft it carries; a 2 mm shaft on a 2 mm pad has no flare and no grip.
 * - Tip length / penetration: the band, flat.
 *
 * `sizeScale` (the user's master multiplier) rides on top of all of it, and is
 * the only term allowed past MAX_SHAFT_DIAMETER_MM — it is an explicit
 * instruction, not a curve.
 *
 * @param candidate - The island to size supports for.
 * @param sizeScale - Master multiplier over the sizing bands.
 * @param ctx - Model-level terms (mesh scale, weight per support). Omit for band sizing.
 */
export function sizeParameters(
    candidate: CandidatePoint,
    sizeScale = 1,
    ctx?: ModelSizingContext,
): SizeOverrides {
    const band = activeSizingBand();

    // The area that drives thickness: the candidate's own supported island.
    // No merge-radius cluster summing — dense regions would double-count
    // the same area onto every trunk (the old 4mm-radius sum inflated a
    // single trunk to 63% of the whole scan).
    const areaInput = Math.max(candidate.islandAreaMm2, 0.01);

    const zHeight = Math.max(candidate.zHeight, 1);
    // Height band: a column's buckling load falls with L², so the same contact
    // needs a thicker column the further it is from the plate. Monotone from
    // the band at HEIGHT_REFERENCE_MM up to the configured `heightFactorCap` —
    // a support shorter than the reference is at band, never below it.
    const { enabled: modelScaleEnabled, heightCap } = modelSizingConfig();
    const heightFactor = modelScaleEnabled
        ? powerFactor(zHeight / HEIGHT_REFERENCE_MM, HEIGHT_EXPONENT, heightCap)
        : 1;
    const trunkScale = modelSizingFactors(ctx).trunkScale;
    const modelScale = Math.min(MAX_MODEL_SCALE_FACTOR, heightFactor * trunkScale);
    const shaftDiameterMm = round(
        clamp(
            shaftDiameterForArea(band.shaftDiameterMm, areaInput) * modelScale,
            0.001,
            MAX_SHAFT_DIAMETER_MM,
        ) * sizeScale,
    3);
    // Underside normal z = cos(angle from straight-down). Flat ceilings
    // (|nz| ≈ 1) peel hardest → full band contact; steep slopes are closer
    // to self-supporting → smaller contact. Bounded to [0.6, 1.0]× band.
    const nz = Math.abs(candidate.tipNormal?.z ?? -1);
    const angleFactor = clamp(0.6 + 0.4 * nz, 0.6, 1.0);
    // Per-point override (small-island shrunk tip) bypasses the band and
    // its 30%-of-shaft floor — explicit means explicit.
    const tipContactDiameterMm = round(
        Math.max(
            MIN_CONTACT_TIP_DIAMETER_MM,
            candidate.tipDiameterMm ?? Math.max(band.tipContactDiameterMm * angleFactor, shaftDiameterMm * TIP_CONTACT_MIN_SHAFT_RATIO),
        ),
    3);

    return {
        shaftDiameterMm,
        tipContactDiameterMm,
        tipBodyDiameterMm: shaftDiameterMm,
        tipLengthMm: round(band.tipLengthMm, 3),
        tipPenetrationMm: round(band.tipPenetrationMm, 3),
        rootsDiameterMm: round(band.rootDiameterMm * trunkScale * sizeScale, 3),
        rootsDiskHeightMm: band.rootDiskHeightMm,
        rootsConeHeightMm: band.rootConeHeightMm,
    };
}

