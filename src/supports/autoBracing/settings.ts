export type AutoBracingPattern = 'singleDiagonal' | 'crossDiagonal';

export interface AutoBracingSettings {
    braceDiameterMm: number;
    maxGroupSize: number;
    topPattern: AutoBracingPattern;
    topOffsetFromTopMm: number;
    middlePattern: AutoBracingPattern;
    middleRepeatIntervalMm: number;
    bottomPattern: AutoBracingPattern;
    bottomOffsetFromBottomMm: number;
    debugSectionColorsEnabled: boolean;
}

type NumericConstraint = {
    min: number;
    max: number;
    step: number;
    defaultValue: number;
    integer?: boolean;
};

type NumericAutoBracingSettingKey =
    | 'braceDiameterMm'
    | 'maxGroupSize'
    | 'topOffsetFromTopMm'
    | 'middleRepeatIntervalMm'
    | 'bottomOffsetFromBottomMm';

export const AUTO_BRACING_PATTERN_OPTIONS: readonly AutoBracingPattern[] = [
    'singleDiagonal',
    'crossDiagonal',
];

export const AUTO_BRACING_CONSTRAINTS = {
    braceDiameterMm: { min: 0.5, max: 2.0, step: 0.05, defaultValue: 0.7 },
    maxGroupSize: { min: 3, max: 10, step: 1, defaultValue: 10, integer: true },
    topOffsetFromTopMm: { min: 0.1, max: 25, step: 0.1, defaultValue: 2.0 },
    middleRepeatIntervalMm: { min: 0.1, max: 25, step: 0.1, defaultValue: 3.0 },
    bottomOffsetFromBottomMm: { min: 0.1, max: 25, step: 0.1, defaultValue: 2.0 },
} satisfies Record<NumericAutoBracingSettingKey, NumericConstraint>;

export const AUTO_BRACING_HARD_RULES = {
    braceAngleDeg: 45,
    maxBraceLengthMm: 10,
    minGroupSize: 3,
    minAxisSeparationDeg: 20,
    supportBraceMeshClearanceMm: 0.5,
    minHeightForBottomSectionMm: 0,
    minHeightForFirstMiddleTierMm: 0,
    firstMiddleMinClearanceFromTopBottomMm: 0,
    middleTierRepeatMinClearanceMm: 0,
    sectionActivationOrder: ['top', 'bottom', 'middle'] as const,
    qualificationAnchorSectionRule: 'top-most-middle-if-present-else-top' as const,
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

function normalizePattern(value: unknown, fallback: AutoBracingPattern): AutoBracingPattern {
    if (value === 'singleDiagonal' || value === 'crossDiagonal') {
        return value;
    }
    return fallback;
}

function normalizeBoolean(value: unknown, fallback: boolean): boolean {
    return typeof value === 'boolean' ? value : fallback;
}

export function createDefaultAutoBracingSettings(): AutoBracingSettings {
    return {
        braceDiameterMm: AUTO_BRACING_CONSTRAINTS.braceDiameterMm.defaultValue,
        maxGroupSize: AUTO_BRACING_CONSTRAINTS.maxGroupSize.defaultValue,
        topPattern: 'singleDiagonal',
        topOffsetFromTopMm: AUTO_BRACING_CONSTRAINTS.topOffsetFromTopMm.defaultValue,
        middlePattern: 'singleDiagonal',
        middleRepeatIntervalMm: AUTO_BRACING_CONSTRAINTS.middleRepeatIntervalMm.defaultValue,
        bottomPattern: 'singleDiagonal',
        bottomOffsetFromBottomMm: AUTO_BRACING_CONSTRAINTS.bottomOffsetFromBottomMm.defaultValue,
        debugSectionColorsEnabled: false,
    };
}

export function normalizeAutoBracingSettings(input?: Partial<AutoBracingSettings> | null): AutoBracingSettings {
    const defaults = createDefaultAutoBracingSettings();
    const source = input ?? defaults;

    return {
        braceDiameterMm: clampNumeric(source.braceDiameterMm, AUTO_BRACING_CONSTRAINTS.braceDiameterMm),
        maxGroupSize: clampNumeric(source.maxGroupSize, AUTO_BRACING_CONSTRAINTS.maxGroupSize),
        topPattern: normalizePattern(source.topPattern, defaults.topPattern),
        topOffsetFromTopMm: clampNumeric(source.topOffsetFromTopMm, AUTO_BRACING_CONSTRAINTS.topOffsetFromTopMm),
        middlePattern: normalizePattern(source.middlePattern, defaults.middlePattern),
        middleRepeatIntervalMm: clampNumeric(source.middleRepeatIntervalMm, AUTO_BRACING_CONSTRAINTS.middleRepeatIntervalMm),
        bottomPattern: normalizePattern(source.bottomPattern, defaults.bottomPattern),
        bottomOffsetFromBottomMm: clampNumeric(source.bottomOffsetFromBottomMm, AUTO_BRACING_CONSTRAINTS.bottomOffsetFromBottomMm),
        debugSectionColorsEnabled: normalizeBoolean(source.debugSectionColorsEnabled, defaults.debugSectionColorsEnabled),
    };
}

export function applyAutoBracingSettingsPatch(
    current: AutoBracingSettings,
    patch: Partial<AutoBracingSettings>,
): AutoBracingSettings {
    return normalizeAutoBracingSettings({
        ...current,
        ...patch,
    });
}
