export type AutoBracingPattern = 'singleDiagonal' | 'crossDiagonal';

export interface AutoBracingSettings {
    braceDiameterMm: number;
    initialPattern: AutoBracingPattern;
    initialDistanceMm: number;
    repeatingPattern: AutoBracingPattern;
    patternIntervalMm: number;
    maxGroupSize: number;
    maxBraceLengthMm: number;
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
    | 'initialDistanceMm'
    | 'patternIntervalMm'
    | 'maxGroupSize'
    | 'maxBraceLengthMm';

export const AUTO_BRACING_PATTERN_OPTIONS: readonly AutoBracingPattern[] = [
    'singleDiagonal',
    'crossDiagonal',
];

export const AUTO_BRACING_CONSTRAINTS = {
    braceDiameterMm: { min: 0.5, max: 2.0, step: 0.05, defaultValue: 0.7 },
    initialDistanceMm: { min: 0.1, max: 25, step: 0.1, defaultValue: 2.0 },
    patternIntervalMm: { min: 1.0, max: 50, step: 0.1, defaultValue: 10.0 },
    maxGroupSize: { min: 3, max: 20, step: 1, defaultValue: 7, integer: true },
    maxBraceLengthMm: { min: 1.0, max: 50, step: 0.1, defaultValue: 10.0 },
} satisfies Record<NumericAutoBracingSettingKey, NumericConstraint>;

export const DEBUG_SECTION_COLORS: Record<string, string> = {
    initial: '#00ff00', // Green
    repeating: '#00e5ff', // Light Blue
};

export const AUTO_BRACING_HARD_RULES = {
    braceAngleDeg: 45,
    minGroupSize: 3,
    minAxisSeparationDeg: 50,
    targetAxisSeparationDeg: 90,
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
        initialPattern: 'singleDiagonal',
        initialDistanceMm: AUTO_BRACING_CONSTRAINTS.initialDistanceMm.defaultValue,
        repeatingPattern: 'singleDiagonal',
        patternIntervalMm: AUTO_BRACING_CONSTRAINTS.patternIntervalMm.defaultValue,
        maxGroupSize: AUTO_BRACING_CONSTRAINTS.maxGroupSize.defaultValue,
        maxBraceLengthMm: AUTO_BRACING_CONSTRAINTS.maxBraceLengthMm.defaultValue,
        debugSectionColorsEnabled: false,
    };
}

export function normalizeAutoBracingSettings(input?: Partial<AutoBracingSettings> | null): AutoBracingSettings {
    const defaults = createDefaultAutoBracingSettings();
    const source = input ?? defaults;

    return {
        braceDiameterMm: clampNumeric(source.braceDiameterMm, AUTO_BRACING_CONSTRAINTS.braceDiameterMm),
        initialPattern: normalizePattern(source.initialPattern, defaults.initialPattern),
        initialDistanceMm: clampNumeric(source.initialDistanceMm, AUTO_BRACING_CONSTRAINTS.initialDistanceMm),
        repeatingPattern: normalizePattern(source.repeatingPattern, defaults.repeatingPattern),
        patternIntervalMm: clampNumeric(source.patternIntervalMm, AUTO_BRACING_CONSTRAINTS.patternIntervalMm),
        maxGroupSize: clampNumeric(source.maxGroupSize, AUTO_BRACING_CONSTRAINTS.maxGroupSize),
        maxBraceLengthMm: clampNumeric(source.maxBraceLengthMm, AUTO_BRACING_CONSTRAINTS.maxBraceLengthMm),
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
