export type AutoBracingPattern = 'singleDiagonal' | 'crossDiagonal';

export interface AutoBracingSettings {
    braceDiameterMm: number;
    maxGroupSize: number;
    initialPattern: AutoBracingPattern;
    repeatPattern: AutoBracingPattern;
    initialOffsetFromBottomMm: number;
    repeatIntervalMm: number;
    debugSectionColorsEnabled: boolean;
    debugSupportHeightLabelsEnabled: boolean;
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
    | 'initialOffsetFromBottomMm'
    | 'repeatIntervalMm';

export const AUTO_BRACING_PATTERN_OPTIONS: readonly AutoBracingPattern[] = [
    'singleDiagonal',
    'crossDiagonal',
];

export const AUTO_BRACING_CONSTRAINTS = {
    braceDiameterMm: { min: 0.5, max: 2.0, step: 0.05, defaultValue: 0.7 },
    maxGroupSize: { min: 3, max: 10, step: 1, defaultValue: 10, integer: true },
    initialOffsetFromBottomMm: { min: 0.1, max: 25, step: 0.1, defaultValue: 5.0 },
    repeatIntervalMm: { min: 0.1, max: 25, step: 0.1, defaultValue: 10.0 },
} satisfies Record<NumericAutoBracingSettingKey, NumericConstraint>;

export const AUTO_BRACING_HARD_RULES = {
    braceAngleDeg: 45,
    maxBraceLengthMm: 10,
    minGroupSize: 3,
    minAxisSeparationDeg: 20,
    supportBraceMeshClearanceMm: 0.5,
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
        initialPattern: 'singleDiagonal',
        repeatPattern: 'singleDiagonal',
        initialOffsetFromBottomMm: AUTO_BRACING_CONSTRAINTS.initialOffsetFromBottomMm.defaultValue,
        repeatIntervalMm: AUTO_BRACING_CONSTRAINTS.repeatIntervalMm.defaultValue,
        debugSectionColorsEnabled: false,
        debugSupportHeightLabelsEnabled: false,
    };
}

export function normalizeAutoBracingSettings(input?: Partial<AutoBracingSettings> | null): AutoBracingSettings {
    const defaults = createDefaultAutoBracingSettings();
    const source = input ?? defaults;
    const normalizedInitialPattern = normalizePattern(source.initialPattern, defaults.initialPattern);
    const normalizedRepeatPattern = normalizePattern(source.repeatPattern, defaults.repeatPattern);

    return {
        braceDiameterMm: clampNumeric(source.braceDiameterMm, AUTO_BRACING_CONSTRAINTS.braceDiameterMm),
        maxGroupSize: clampNumeric(source.maxGroupSize, AUTO_BRACING_CONSTRAINTS.maxGroupSize),
        initialPattern: normalizedInitialPattern,
        repeatPattern: normalizedRepeatPattern,
        initialOffsetFromBottomMm: clampNumeric(source.initialOffsetFromBottomMm, AUTO_BRACING_CONSTRAINTS.initialOffsetFromBottomMm),
        repeatIntervalMm: clampNumeric(source.repeatIntervalMm, AUTO_BRACING_CONSTRAINTS.repeatIntervalMm),
        debugSectionColorsEnabled: normalizeBoolean(source.debugSectionColorsEnabled, defaults.debugSectionColorsEnabled),
        debugSupportHeightLabelsEnabled: normalizeBoolean(source.debugSupportHeightLabelsEnabled, defaults.debugSupportHeightLabelsEnabled),
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
