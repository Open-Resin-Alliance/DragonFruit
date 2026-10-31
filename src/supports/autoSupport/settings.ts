import { MIN_LEAF_FAN_RADIUS_MM } from './constants';

/**
 * The seven numbers a run sizes every shaft, tip and root from — a Support
 * Studio preset's tip, shaft and roots, read as one band.
 *
 * They are not the auto-support block's own data: `autoSupport.sizingPreset`
 * names the Support Studio preset the run borrows them from, and the engine
 * resolves that id on every run. The coupling is deliberate — see the backlog
 * entry — so editing a manual preset changes what auto-support prints.
 */
export interface SizingBand {
    shaftDiameterMm: number;
    tipContactDiameterMm: number;
    tipLengthMm: number;
    tipPenetrationMm: number;
    rootDiameterMm: number;
    rootDiskHeightMm: number;
    rootConeHeightMm: number;
}

/**
 * The three factory Support Studio presets, whose bands `SIZING_BANDS` mirrors.
 * `presetForArea` still names the tier a supported area falls in for the forest
 * ledger, and the load budget weighs a support's cross-section against them.
 */
export type SizingPreset = 'detail' | 'structure' | 'anchor';

/**
 * The factory bands, mirroring what the three factory Support Studio presets
 * carry (detail / structure / anchor). Two consumers: the auto-support built-in
 * presets name these tiers, and the *fallback* `activeSizingBand()` uses when the
 * id in the settings names no preset at all (`structure` is the baseline).
 */
/**
 * The smallest contact tip an auto-support run may produce (mm).
 *
 * A Support Studio preset is an open id and its tip field can be edited below
 * this; the run floors the resolved band, the angle-scaled contact and every
 * per-point override here. Manual placement keeps the profile the user set.
 */
export const MIN_CONTACT_TIP_DIAMETER_MM = 0.22;

export const SIZING_BANDS: Record<SizingPreset, SizingBand> = {
    detail: {
        shaftDiameterMm: 0.8,
        tipContactDiameterMm: 0.22,
        tipLengthMm: 2.5,
        tipPenetrationMm: 0,
        rootDiameterMm: 2.0,
        rootDiskHeightMm: 0.5,
        rootConeHeightMm: 1.0,
    },
    structure: {
        shaftDiameterMm: 1.0,
        tipContactDiameterMm: 0.28,
        tipLengthMm: 2.5,
        tipPenetrationMm: 0,
        rootDiameterMm: 2.0,
        rootDiskHeightMm: 0.5,
        rootConeHeightMm: 1.0,
    },
    anchor: {
        shaftDiameterMm: 1.4,
        tipContactDiameterMm: 0.4,
        tipLengthMm: 2.5,
        tipPenetrationMm: 0,
        rootDiameterMm: 2.3,
        rootDiskHeightMm: 0.5,
        rootConeHeightMm: 1.0,
    },
};

export interface AutoSupportSettings {
    enabled: boolean;
    minIslandAreaMm2: number;
    tipInfluenceRadiusMm: number;
    prioritizeIntersection: boolean;
    /** Max combined leaves + branches that can attach to a single trunk. */
    maxAttachmentsPerTrunk: number;
    /** Projected surface area each grid support carries (mm²) — the density knob.
     *  Grid spacing = √areaPerSupportMm2. */
    areaPerSupportMm2: number;
    /** Overhang regions at or above this projected area (mm²) get a density
     *  grid; smaller regions get a single support. */
    gridAreaThresholdMm2: number;
    /** Surface angle from horizontal (deg) at and below which a face counts
     *  as an overhang needing supports. 0° = flat ceiling; the resin standard
     *  is 45°. Steeper faces are considered self-supporting. */
    overhangSelfSupportAngleDeg: number;
    /** Master multiplier over the preset sizing bands (shaft/tip/root). */
    sizeScale: number;
    /** Grid spacing multiplier on flat ceilings (0°) — the densest case.
     *  <1 = denser than the area setting implies. */
    flatDensityBoost: number;
    /** Grid spacing multiplier at the self-support angle — the sparsest case.
     *  >1 = sparser than the area setting implies. */
    slopeRelaxFactor: number;
        /** Area-scaling exponent for flat-region density: spacing ∝ (threshold/area)^exp
     *  on the flat end. Higher = denser on large shallow ceilings (peel force
     *  grows with cross-section — direction physical, values calibration).
     *  0 disables area scaling. */
    suctionAreaExponent: number;
            /** Percentage of each region's projected footprint the auto grid must
     *  cover before gap-fill stops (75–100). */
    coverageTargetPercent: number;
    /** The band auto supports are sized with — shaft, tip contact/length/
     *  penetration and the root pad. Independent of the active trunk preset
     *  (which is for manual placement only). Default = the `structure` band,
     *  the block the removed `sizingPreset` default selected. */
    /**
     * The Support Studio preset whose tip, shaft and roots numbers size this run.
     * An open id — the three factory presets plus any preset the user made — and a
     * value that no longer resolves (a deleted preset) falls back to the factory
     * structure band rather than failing the run.
     */
    sizingPreset: string;
    /** Leaf fanning: max horizontal reach from a trunk shaft (mm). */
    leafFanRadiusMm: number;
    /** Leaf fanning: max angle from vertical for a fan leaf (deg). */
    leafFanMaxAngleDeg: number;
    /** Debug: color supports by placement origin (anchor/overhang/island/
     *  standalone) in the scene instead of the model color. */
    debugSupportOriginColors: boolean;
    debugSkipAutoBracing: boolean;
    /** Add stabilization anchors for poses bearing on a point/edge (default on). */
    stabilizationEnabled: boolean;
    /** Ring mesh minima (the first point of a section) with reinforcement
     *  contacts on their own flank (default on). */
    minimaReinforcementEnabled: boolean;
    /** Fraction of the local free width a contact tip may occupy so the
     *  rendered disc fits the feature it lands on. **Calibration, not a
     *  preference**: 0.9 is measured — at 0.6 the cap shrank a 0.28 mm band tip
     *  to 0.22 mm inside a 0.30–0.45 mm feature (the "tips read a little thin"
     *  report) for no fit benefit, so the value here is the published middle.
     *  Read by `applyContactTipCap`. */
    tipContactMarginScale: number;
    /** Least shaft diameter a hosted member takes, as a fraction of the host
     *  shaft it sprouts from. **Calibration, not a preference**: 0.7 is measured
     *  — at ×1.6 (host 1.62 mm) the member/host ratio ran 0.62 with no floor
     *  (*a little thin*) and 0.80 with the first attempt (*a little thick*), so
     *  0.7 sits between them. Read by `memberShaftDiameterMm`. */
    memberHostShaftRatio: number;
    /** Master switch for the run-level model-scale sizing (size × load ×
     *  height factors). Off pins every one of them to ×1, so sizing is exactly
     *  the active band plus the local terms. */
    modelScaleEnabled: boolean;
    /** Ceiling of the run-level size factor
     *  `(bbox diagonal / SIZE_REFERENCE_MM)^SIZE_EXPONENT`. **Calibration, not a
     *  preference** — the measured bound that keeps a large part's trunk growth
     *  sub-linear. Read by `modelSizingFactors`. */
    modelSizeFactorCap: number;
    /** Ceiling of the run-level load factor
     *  `(resin grams per support / SHARE_REFERENCE_G)^SHARE_EXPONENT`.
     *  **Calibration, not a preference.** Read by `modelSizingFactors`. */
    modelLoadFactorCap: number;
    /** Ceiling of the height factor
     *  `(zHeight / HEIGHT_REFERENCE_MM)^HEIGHT_EXPONENT` — a column's buckling
     *  load falls with L², so the cap bounds how much a tall support thickens.
     *  **Calibration, not a preference.** Read by `sizeParameters`. */
    heightFactorCap: number;
}

/**
 * The block's diagnostic keys: switches a user flips to look *at* a run (color
 * supports by origin, skip bracing to read the forest). They are stored with the
 * block like any other key, but they are not run policy, so they are treated
 * differently in three places:
 *
 * - the settings dialog applies them the moment they are toggled, instead of
 *   staging them for `Save` (they are there to be flipped while reading the
 *   scene, and a diagnostic that needs a commit is a diagnostic nobody uses);
 * - they never mark the dialog dirty, so closing it does not ask whether to
 *   discard a view switch;
 * - they never make the active preset read as modified.
 *
 * `docs/dev/auto-supports.md` carries the same list in prose; the test beside
 * `isAutoSupportPresetDirty` fails if a new debug switch is added without a
 * decision about which side of this line it is on.
 */
export const DIAGNOSTIC_AUTO_SUPPORT_KEYS = [
    'debugSupportOriginColors',
    'debugSkipAutoBracing',
] as const satisfies readonly (keyof AutoSupportSettings)[];

/** A key from {@link DIAGNOSTIC_AUTO_SUPPORT_KEYS}. */
export type AutoSupportDiagnosticKey = (typeof DIAGNOSTIC_AUTO_SUPPORT_KEYS)[number];

export type NumericConstraint = {
    min: number;
    max: number;
    step: number;
    defaultValue: number;
    integer?: boolean;
};

export type NumericAutoSupportSettingKey =
    | 'minIslandAreaMm2'
    | 'tipInfluenceRadiusMm'
    | 'maxAttachmentsPerTrunk'
    | 'areaPerSupportMm2'
    | 'gridAreaThresholdMm2'
    | 'overhangSelfSupportAngleDeg'
    | 'sizeScale'
    | 'flatDensityBoost'
    | 'slopeRelaxFactor'
        | 'suctionAreaExponent'
          | 'coverageTargetPercent'
    | 'leafFanRadiusMm'
    | 'leafFanMaxAngleDeg'
    | 'tipContactMarginScale'
    | 'memberHostShaftRatio'
    | 'modelSizeFactorCap'
    | 'modelLoadFactorCap'
    | 'heightFactorCap';

export const AUTO_SUPPORT_CONSTRAINTS = {
    minIslandAreaMm2: { min: 0.01, max: 10, step: 0.01, defaultValue: 0.02 },
    tipInfluenceRadiusMm: { min: 0.1, max: 10, step: 0.1, defaultValue: 0.5 },
    maxAttachmentsPerTrunk: { min: 2, max: 50, step: 1, defaultValue: 12, integer: true },
    areaPerSupportMm2: { min: 1, max: 30, step: 0.5, defaultValue: 10 },
    gridAreaThresholdMm2: { min: 5, max: 200, step: 5, defaultValue: 25 },
    overhangSelfSupportAngleDeg: { min: 20, max: 75, step: 5, defaultValue: 45 },
    sizeScale: { min: 0.5, max: 2, step: 0.05, defaultValue: 1 },
    flatDensityBoost: { min: 0.5, max: 1, step: 0.05, defaultValue: 0.7 },
    slopeRelaxFactor: { min: 1, max: 2, step: 0.1, defaultValue: 1.3 },
    suctionAreaExponent: { min: 0, max: 0.4, step: 0.05, defaultValue: 0.15 },
    coverageTargetPercent: { min: 75, max: 100, step: 5, defaultValue: 95, integer: true },
    leafFanRadiusMm: { min: MIN_LEAF_FAN_RADIUS_MM, max: 15, step: 0.5, defaultValue: MIN_LEAF_FAN_RADIUS_MM },
    leafFanMaxAngleDeg: { min: 20, max: 80, step: 5, defaultValue: 45, integer: true },
    tipContactMarginScale: { min: 0.4, max: 1, step: 0.05, defaultValue: 0.9 },
    memberHostShaftRatio: { min: 0.5, max: 1, step: 0.05, defaultValue: 0.7 },
    modelSizeFactorCap: { min: 1, max: 2, step: 0.05, defaultValue: 1.45 },
    modelLoadFactorCap: { min: 1, max: 2, step: 0.05, defaultValue: 1.3 },
    heightFactorCap: { min: 1, max: 2, step: 0.05, defaultValue: 1.35 },
} satisfies Record<NumericAutoSupportSettingKey, NumericConstraint>;

function precisionFromStep(step: number): number {
    const text = String(step);
    const parts = text.split('.');
    return parts[1] ? parts[1].length : 0;
}

function clampNumeric(value: unknown, constraint: NumericConstraint): number {
    const raw = typeof value === 'number' && Number.isFinite(value)
        ? value
        : constraint.defaultValue;

    const clamped = Math.min(constraint.max, Math.max(constraint.min, raw));

    if (constraint.integer) {
        return Math.round(clamped);
    }

    const stepsFromMin = Math.round((clamped - constraint.min) / constraint.step);
    const stepped = constraint.min + stepsFromMin * constraint.step;
    const precision = Math.max(0, precisionFromStep(constraint.step));
    const rounded = Number(stepped.toFixed(precision));

    return Math.min(constraint.max, Math.max(constraint.min, rounded));
}

function normalizeBoolean(value: unknown, fallback: boolean): boolean {
    return typeof value === 'boolean' ? value : fallback;
}

export function createDefaultAutoSupportSettings(): AutoSupportSettings {
    return {
        enabled: true,
        minIslandAreaMm2: AUTO_SUPPORT_CONSTRAINTS.minIslandAreaMm2.defaultValue,
        tipInfluenceRadiusMm: AUTO_SUPPORT_CONSTRAINTS.tipInfluenceRadiusMm.defaultValue,
        prioritizeIntersection: false,
        maxAttachmentsPerTrunk: AUTO_SUPPORT_CONSTRAINTS.maxAttachmentsPerTrunk.defaultValue,
        areaPerSupportMm2: AUTO_SUPPORT_CONSTRAINTS.areaPerSupportMm2.defaultValue,
        gridAreaThresholdMm2: AUTO_SUPPORT_CONSTRAINTS.gridAreaThresholdMm2.defaultValue,
        overhangSelfSupportAngleDeg: AUTO_SUPPORT_CONSTRAINTS.overhangSelfSupportAngleDeg.defaultValue,
        sizeScale: AUTO_SUPPORT_CONSTRAINTS.sizeScale.defaultValue,
        flatDensityBoost: AUTO_SUPPORT_CONSTRAINTS.flatDensityBoost.defaultValue,
        slopeRelaxFactor: AUTO_SUPPORT_CONSTRAINTS.slopeRelaxFactor.defaultValue,
        suctionAreaExponent: AUTO_SUPPORT_CONSTRAINTS.suctionAreaExponent.defaultValue,
        coverageTargetPercent: AUTO_SUPPORT_CONSTRAINTS.coverageTargetPercent.defaultValue,
        sizingPreset: 'structure',
        leafFanRadiusMm: AUTO_SUPPORT_CONSTRAINTS.leafFanRadiusMm.defaultValue,
        leafFanMaxAngleDeg: AUTO_SUPPORT_CONSTRAINTS.leafFanMaxAngleDeg.defaultValue,
        tipContactMarginScale: AUTO_SUPPORT_CONSTRAINTS.tipContactMarginScale.defaultValue,
        memberHostShaftRatio: AUTO_SUPPORT_CONSTRAINTS.memberHostShaftRatio.defaultValue,
        modelScaleEnabled: true,
        modelSizeFactorCap: AUTO_SUPPORT_CONSTRAINTS.modelSizeFactorCap.defaultValue,
        modelLoadFactorCap: AUTO_SUPPORT_CONSTRAINTS.modelLoadFactorCap.defaultValue,
        heightFactorCap: AUTO_SUPPORT_CONSTRAINTS.heightFactorCap.defaultValue,
        debugSupportOriginColors: false,
        debugSkipAutoBracing: false,
        stabilizationEnabled: true,
        minimaReinforcementEnabled: true,
    };
}

export function normalizeAutoSupportSettings(input?: Partial<AutoSupportSettings> | null): AutoSupportSettings {
    const defaults = createDefaultAutoSupportSettings();
    // A block written by the band-era build carries the seven numbers instead of
    // the preset id: migrating here means every read path (the settings store's own
    // load, a preset payload applied through it, a direct patch) lands on the id.
    const source = migrateLegacySizingPreset(input ?? defaults);

    return {
        enabled: normalizeBoolean(source.enabled, defaults.enabled),
        minIslandAreaMm2: clampNumeric(source.minIslandAreaMm2, AUTO_SUPPORT_CONSTRAINTS.minIslandAreaMm2),
        tipInfluenceRadiusMm: clampNumeric(source.tipInfluenceRadiusMm, AUTO_SUPPORT_CONSTRAINTS.tipInfluenceRadiusMm),
        prioritizeIntersection: normalizeBoolean(source.prioritizeIntersection, defaults.prioritizeIntersection),
        maxAttachmentsPerTrunk: clampNumeric(source.maxAttachmentsPerTrunk, AUTO_SUPPORT_CONSTRAINTS.maxAttachmentsPerTrunk),
        areaPerSupportMm2: clampNumeric(source.areaPerSupportMm2, AUTO_SUPPORT_CONSTRAINTS.areaPerSupportMm2),
        gridAreaThresholdMm2: clampNumeric(source.gridAreaThresholdMm2, AUTO_SUPPORT_CONSTRAINTS.gridAreaThresholdMm2),
        overhangSelfSupportAngleDeg: clampNumeric(source.overhangSelfSupportAngleDeg, AUTO_SUPPORT_CONSTRAINTS.overhangSelfSupportAngleDeg),
        sizeScale: clampNumeric(source.sizeScale, AUTO_SUPPORT_CONSTRAINTS.sizeScale),
        flatDensityBoost: clampNumeric(source.flatDensityBoost, AUTO_SUPPORT_CONSTRAINTS.flatDensityBoost),
        slopeRelaxFactor: clampNumeric(source.slopeRelaxFactor, AUTO_SUPPORT_CONSTRAINTS.slopeRelaxFactor),
        suctionAreaExponent: clampNumeric(source.suctionAreaExponent, AUTO_SUPPORT_CONSTRAINTS.suctionAreaExponent),
        coverageTargetPercent: clampNumeric(source.coverageTargetPercent, AUTO_SUPPORT_CONSTRAINTS.coverageTargetPercent),
        sizingPreset: normalizeSizingPreset(source.sizingPreset, defaults.sizingPreset),
        leafFanRadiusMm: clampNumeric(source.leafFanRadiusMm, AUTO_SUPPORT_CONSTRAINTS.leafFanRadiusMm),
        leafFanMaxAngleDeg: clampNumeric(source.leafFanMaxAngleDeg, AUTO_SUPPORT_CONSTRAINTS.leafFanMaxAngleDeg),
        tipContactMarginScale: clampNumeric(source.tipContactMarginScale, AUTO_SUPPORT_CONSTRAINTS.tipContactMarginScale),
        memberHostShaftRatio: clampNumeric(source.memberHostShaftRatio, AUTO_SUPPORT_CONSTRAINTS.memberHostShaftRatio),
        modelScaleEnabled: normalizeBoolean(source.modelScaleEnabled, defaults.modelScaleEnabled),
        modelSizeFactorCap: clampNumeric(source.modelSizeFactorCap, AUTO_SUPPORT_CONSTRAINTS.modelSizeFactorCap),
        modelLoadFactorCap: clampNumeric(source.modelLoadFactorCap, AUTO_SUPPORT_CONSTRAINTS.modelLoadFactorCap),
        heightFactorCap: clampNumeric(source.heightFactorCap, AUTO_SUPPORT_CONSTRAINTS.heightFactorCap),
        debugSupportOriginColors: normalizeBoolean(source.debugSupportOriginColors, defaults.debugSupportOriginColors),
        debugSkipAutoBracing: normalizeBoolean(source.debugSkipAutoBracing, defaults.debugSkipAutoBracing),
        stabilizationEnabled: normalizeBoolean(source.stabilizationEnabled, defaults.stabilizationEnabled),
        minimaReinforcementEnabled: normalizeBoolean(
            source.minimaReinforcementEnabled,
            defaults.minimaReinforcementEnabled,
        ),
    };
}

export function applyAutoSupportSettingsPatch(
    current: AutoSupportSettings,
    patch: Partial<AutoSupportSettings>,
): AutoSupportSettings {
    return normalizeAutoSupportSettings({
        ...current,
        ...patch,
    });
}

// ---------------------------------------------------------------------------
// Migration off the band-as-data block
//
// One build in this session wrote the seven numbers into the block as
// `autoSupport.sizingBand`. The field names a Support Studio preset again, so a
// block carrying a band is rewritten to the factory preset whose band matches
// (or `structure`, the default). This is the only place that key is read.
// ---------------------------------------------------------------------------

/** The factory preset a band's seven numbers are, or `structure` when they match none. */
function sizingPresetForBand(value: unknown): SizingPreset {
    if (typeof value !== 'object' || value === null) return 'structure';
    const band = value as Record<string, unknown>;
    const tier = (Object.keys(SIZING_BANDS) as SizingPreset[]).find((name) =>
        (Object.keys(SIZING_BANDS[name]) as (keyof SizingBand)[])
            .every((field) => SIZING_BANDS[name][field] === band[field]),
    );
    return tier ?? 'structure';
}

/**
 * Rewrite a stored auto-support block off the removed `sizingBand` object: the
 * obsolete key is dropped and the factory preset whose band it matched is written
 * in its place (`structure` for a band the factory never shipped). Unknown keys
 * pass through untouched, because a preset payload carries keys this build cannot
 * name and must keep them.
 *
 * The band wins over any id in the same payload: no build wrote both, so an id
 * sitting beside a band can only have come from merging the defaults over a
 * band-era block, and the band is the honest value there. A payload without a
 * band is returned as it is, same reference.
 */
export function migrateLegacySizingPreset<T extends object>(payload: T): T {
    const record = payload as Record<string, unknown>;
    if (!Object.hasOwn(record, 'sizingBand')) return payload;
    const { sizingBand, ...rest } = record;
    return { ...rest, sizingPreset: sizingPresetForBand(sizingBand) } as unknown as T;
}

/**
 * The tier a block names: any non-empty string is an id to resolve at run time
 * (a user's own preset is as valid as a factory one, and a deleted one is a
 * fallback rather than an error), so the only repair here is the default.
 */
function normalizeSizingPreset(value: unknown, fallback: string): string {
    return typeof value === 'string' && value.trim().length > 0 ? value : fallback;
}
