/**
 * Turning a measured pull-off or deflection into the green-state constants the
 * solver uses.
 *
 * The solver's numbers are only as good as these three constants, and none of
 * them can be derived from the mesh:
 *
 * - `NOMINAL_PEEL_PRESSURE_MPA` — film pressure at the 10 mm² reference disc,
 *   from a suction-cup pull-off test (peak force / coupon area, corrected for
 *   the traction factor when the coupon is not the reference size).
 * - `GREEN_RESIN_MODULUS_MPA` — from a printed cantilever bar deflecting under
 *   a known tip load (`E = F·L³ / (3·δ·I)`).
 * - `DEFAULT_SUPPORT_BREAK_STRENGTH_MPA` — from a single contact's pull-off
 *   (`σ = F / (π·(d/2)²)`). The datasheet tensile is derated to it, because a
 *   thin green strut breaks far below the bulk value: DM12 measures 4.8 MPa on
 *   a 0.5 × 0.5 mm section against a 24 MPa datasheet (Cao et al. 2025). This is
 *   the **contact/tip** strength. A support member's bending section is not
 *   that coupon: `solveSupportFrameStress` takes `memberStrengthMpa` (the bulk
 *   tensile) for members, so a 2.2 mm trunk at 14 MPa is not called broken by a
 *   4.8 MPa contact measurement.
 *
 * All three are unit-consistent with the rest of the support stack (N, mm,
 * MPa), and every function returns `null` for a measurement that cannot
 * produce a physical value (zero area, zero deflection) instead of a silent 0.
 */

/** Support break strength as a fraction of the resin's datasheet tensile:
 *  the thin green section's measured break load is about a fifth of bulk. */
export const SUPPORT_BREAK_STRENGTH_RATIO = 0.2;

/** The break strength the solver and every placement capacity use, from the
 *  datasheet tensile the material profile carries. */
export function supportBreakStrengthMpa(tensileStrengthMpa: number): number {
    return Math.max(0.01, tensileStrengthMpa) * SUPPORT_BREAK_STRENGTH_RATIO;
}

/** Default datasheet tensile of a standard resin (MPa): the DM12 the measured
 *  coupon used. Derated by `SUPPORT_BREAK_STRENGTH_RATIO` at the solver, so
 *  the default support break strength is 4.8 MPa. */
export const DEFAULT_RESIN_TENSILE_STRENGTH_MPA = 24;

/** Default support break strength (MPa), derived from the default datasheet
 *  tensile: 24 × 0.2 = 4.8 MPa, the measured 1.2 N on a 0.5 × 0.5 mm section. */
export const DEFAULT_SUPPORT_BREAK_STRENGTH_MPA =
    DEFAULT_RESIN_TENSILE_STRENGTH_MPA * SUPPORT_BREAK_STRENGTH_RATIO;

/** The 10 mm² disc the nominal peel pressure is defined at. */
export const NOMINAL_PEEL_REFERENCE_AREA_MM2 = 10;

const TRACTION_FACTOR_FLOOR = 0.5;
const TRACTION_FACTOR_WEIGHT = 0.5;
const TRACTION_FACTOR_EXPONENT = 0.22;
const TRACTION_FACTOR_MIN = 0.65;
const TRACTION_FACTOR_MAX = 1.55;

/**
 * The compression the solver applies to a layer's mean Stefan pressure, as a
 * function of the coupon's mean pressure over the 10 mm² reference disc's mean.
 * Mirrors `stefanTractionFactorAt` / `stefanLayerForceFactor`; a reference-size
 * coupon is exactly 1.
 */
export function peelTractionFactorForArea(
    areaMm2: number,
    referenceAreaMm2: number = NOMINAL_PEEL_REFERENCE_AREA_MM2,
): number {
    if (!(areaMm2 > 0) || !(referenceAreaMm2 > 0)) return 1;
    if (Math.abs(areaMm2 - referenceAreaMm2) < 1e-9) return 1;
    const ratio = areaMm2 / referenceAreaMm2;
    const factor = TRACTION_FACTOR_FLOOR + TRACTION_FACTOR_WEIGHT * Math.pow(ratio, TRACTION_FACTOR_EXPONENT);
    return Math.max(TRACTION_FACTOR_MIN, Math.min(TRACTION_FACTOR_MAX, factor));
}

export interface PullOffMeasurement {
    /** Peak force at release (N). */
    forceN: number;
    /** Coupon's contact area (mm²). */
    couponAreaMm2: number;
}

/**
 * Film pressure at the 10 mm² reference disc from a pull-off measurement. A
 * coupon larger than the reference peels with the compressed traction factor
 * baked into the measured force, so the force is divided by `area × factor`
 * rather than by the area alone; on a reference-size coupon the factor is 1.
 */
export function peelPressureFromPullOff(measurement: PullOffMeasurement): number | null {
    const { forceN, couponAreaMm2 } = measurement;
    if (!(forceN > 0) || !(couponAreaMm2 > 0)) return null;
    const factor = peelTractionFactorForArea(couponAreaMm2);
    const pressureMpa = forceN / (couponAreaMm2 * factor);
    return Number.isFinite(pressureMpa) ? pressureMpa : null;
}

export interface CantileverDeflectionMeasurement {
    /** Tip load applied during the measurement (N). */
    forceN: number;
    /** Free length of the bar (mm). */
    lengthMm: number;
    /** Round bar diameter (mm). */
    diameterMm: number;
    /** Measured tip deflection under that load (mm). */
    deflectionMm: number;
}

/** Second moment of area of a round bar (mm⁴). */
export function roundBarInertiaMm4(diameterMm: number): number {
    return (Math.PI * diameterMm ** 4) / 64;
}

/**
 * Green modulus from a cantilever bar: `E = F·L³ / (3·δ·I)`. This is the
 * constant the frame solver's stiffness matrix uses (850 MPa today); a bar
 * measured in green state is the only direct read of it.
 */
export function greenModulusFromCantilever(measurement: CantileverDeflectionMeasurement): number | null {
    const { forceN, lengthMm, diameterMm, deflectionMm } = measurement;
    if (!(forceN > 0) || !(lengthMm > 0) || !(diameterMm > 0) || !(deflectionMm > 0)) return null;
    const inertia = roundBarInertiaMm4(diameterMm);
    const modulus = (forceN * lengthMm ** 3) / (3 * deflectionMm * inertia);
    return Number.isFinite(modulus) && modulus > 0 ? modulus : null;
}

export interface ContactPullOffMeasurement {
    /** Peak tensile force a single contact held (N). */
    forceN: number;
    /** Contact diameter (mm). */
    contactDiameterMm: number;
}

/** Green tensile strength from a single contact pull-off: `σ = F / A`. */
export function greenUtsFromContactPullOff(measurement: ContactPullOffMeasurement): number | null {
    const { forceN, contactDiameterMm } = measurement;
    if (!(forceN > 0) || !(contactDiameterMm > 0)) return null;
    const areaMm2 = Math.PI * (contactDiameterMm / 2) ** 2;
    const utsMpa = forceN / areaMm2;
    return Number.isFinite(utsMpa) && utsMpa > 0 ? utsMpa : null;
}
