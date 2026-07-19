export interface AutoSupportSettings {
    enabled: boolean;
    minIslandAreaMm2: number;
    clusterRadiusMm: number;
    maxBranchReachMm: number;
    maxBranchAngleDeg: number;
    minTrunkSeparationMm: number;
    densityFactor: number;
    tipInfluenceRadiusMm: number;
    prioritizeIntersection: boolean;
    debugClusterColorsEnabled: boolean;
}

type NumericConstraint = {
    min: number;
    max: number;
    step: number;
    defaultValue: number;
    integer?: boolean;
};

type NumericAutoSupportSettingKey =
    | 'minIslandAreaMm2'
    | 'clusterRadiusMm'
    | 'maxBranchReachMm'
    | 'maxBranchAngleDeg'
    | 'minTrunkSeparationMm'
    | 'densityFactor'
    | 'tipInfluenceRadiusMm';

export const AUTO_SUPPORT_CONSTRAINTS = {
    minIslandAreaMm2: { min: 0.01, max: 10, step: 0.01, defaultValue: 0.02 },
    clusterRadiusMm: { min: 5, max: 40, step: 0.5, defaultValue: 20 },
    maxBranchReachMm: { min: 5, max: 40, step: 0.5, defaultValue: 25 },
    maxBranchAngleDeg: { min: 20, max: 60, step: 1, defaultValue: 50 },
    minTrunkSeparationMm: { min: 3, max: 30, step: 0.5, defaultValue: 6 },
    densityFactor: { min: 0.5, max: 3.0, step: 0.1, defaultValue: 1.0 },
    tipInfluenceRadiusMm: { min: 0.1, max: 10, step: 0.1, defaultValue: 0.5 },
} satisfies Record<NumericAutoSupportSettingKey, NumericConstraint>;

export const AUTO_SUPPORT_HARD_RULES = {
    ANCHOR_HEIGHT_THRESHOLD_MM: 5.0,
    MAX_LEAF_SPAN_MM: 2.5,
    MIN_GROUP_SIZE: 2,
    MIN_ANGLE_FROM_HORIZONTAL_DEG: 30,
};

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
        clusterRadiusMm: AUTO_SUPPORT_CONSTRAINTS.clusterRadiusMm.defaultValue,
        maxBranchReachMm: AUTO_SUPPORT_CONSTRAINTS.maxBranchReachMm.defaultValue,
        maxBranchAngleDeg: AUTO_SUPPORT_CONSTRAINTS.maxBranchAngleDeg.defaultValue,
        minTrunkSeparationMm: AUTO_SUPPORT_CONSTRAINTS.minTrunkSeparationMm.defaultValue,
        densityFactor: AUTO_SUPPORT_CONSTRAINTS.densityFactor.defaultValue,
        tipInfluenceRadiusMm: AUTO_SUPPORT_CONSTRAINTS.tipInfluenceRadiusMm.defaultValue,
        prioritizeIntersection: false,
        debugClusterColorsEnabled: false,
    };
}

export function normalizeAutoSupportSettings(input?: Partial<AutoSupportSettings> | null): AutoSupportSettings {
    const defaults = createDefaultAutoSupportSettings();
    const source = input ?? defaults;

    return {
        enabled: normalizeBoolean(source.enabled, defaults.enabled),
        minIslandAreaMm2: clampNumeric(source.minIslandAreaMm2, AUTO_SUPPORT_CONSTRAINTS.minIslandAreaMm2),
        clusterRadiusMm: clampNumeric(source.clusterRadiusMm, AUTO_SUPPORT_CONSTRAINTS.clusterRadiusMm),
        maxBranchReachMm: clampNumeric(source.maxBranchReachMm, AUTO_SUPPORT_CONSTRAINTS.maxBranchReachMm),
        maxBranchAngleDeg: clampNumeric(source.maxBranchAngleDeg, AUTO_SUPPORT_CONSTRAINTS.maxBranchAngleDeg),
        minTrunkSeparationMm: clampNumeric(source.minTrunkSeparationMm, AUTO_SUPPORT_CONSTRAINTS.minTrunkSeparationMm),
        densityFactor: clampNumeric(source.densityFactor, AUTO_SUPPORT_CONSTRAINTS.densityFactor),
        tipInfluenceRadiusMm: clampNumeric(source.tipInfluenceRadiusMm, AUTO_SUPPORT_CONSTRAINTS.tipInfluenceRadiusMm),
        prioritizeIntersection: normalizeBoolean(source.prioritizeIntersection, defaults.prioritizeIntersection),
        debugClusterColorsEnabled: normalizeBoolean(source.debugClusterColorsEnabled, defaults.debugClusterColorsEnabled),
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
