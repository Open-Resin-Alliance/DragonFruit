import assert from 'node:assert/strict';
import test from 'node:test';

import {
    AUTO_BRACING_CONSTRAINTS,
    applyAutoBracingSettingsPatch,
    createDefaultAutoBracingSettings,
    normalizeAutoBracingSettings,
} from '../autoBracing/settings';

test('auto-bracing defaults are created from the SSOT constraint defaults', () => {
    const settings = createDefaultAutoBracingSettings();

    assert.equal(settings.braceDiameterMm, AUTO_BRACING_CONSTRAINTS.braceDiameterMm.defaultValue);
    assert.equal(settings.initialDistanceMm, AUTO_BRACING_CONSTRAINTS.initialDistanceMm.defaultValue);
    assert.equal(settings.patternIntervalMm, AUTO_BRACING_CONSTRAINTS.patternIntervalMm.defaultValue);
    assert.equal(settings.seedSpacingMm, AUTO_BRACING_CONSTRAINTS.seedSpacingMm.defaultValue);
    assert.equal(settings.seedJitterMm, AUTO_BRACING_CONSTRAINTS.seedJitterMm.defaultValue);
    assert.equal(settings.maxBraceLengthMm, AUTO_BRACING_CONSTRAINTS.maxBraceLengthMm.defaultValue);
    assert.equal(settings.initialPattern, 'singleDiagonal');
    assert.equal(settings.repeatingPattern, 'singleDiagonal');
    assert.equal(settings.debugSectionColorsEnabled, false);
});

test('normalizeAutoBracingSettings clamps numeric values and restores invalid patterns', () => {
    const normalized = normalizeAutoBracingSettings({
        braceDiameterMm: -5,
        initialDistanceMm: 999,
        patternIntervalMm: -1,
        seedSpacingMm: 999,
        seedJitterMm: 999,
        maxBraceLengthMm: -1,
        initialPattern: 'invalid-pattern' as any,
        repeatingPattern: 'crossDiagonal',
        debugSectionColorsEnabled: 'yes' as any,
    });

    assert.equal(normalized.braceDiameterMm, AUTO_BRACING_CONSTRAINTS.braceDiameterMm.min);
    assert.equal(normalized.initialDistanceMm, AUTO_BRACING_CONSTRAINTS.initialDistanceMm.max);
    assert.equal(normalized.patternIntervalMm, AUTO_BRACING_CONSTRAINTS.patternIntervalMm.min);
    assert.equal(normalized.seedSpacingMm, AUTO_BRACING_CONSTRAINTS.seedSpacingMm.max);
    assert.equal(normalized.seedJitterMm, AUTO_BRACING_CONSTRAINTS.seedJitterMm.max);
    assert.equal(normalized.maxBraceLengthMm, AUTO_BRACING_CONSTRAINTS.maxBraceLengthMm.min);
    assert.equal(normalized.initialPattern, 'singleDiagonal');
    assert.equal(normalized.repeatingPattern, 'crossDiagonal');
    assert.equal(normalized.debugSectionColorsEnabled, false);
});

test('applyAutoBracingSettingsPatch keeps untouched fields and normalizes patched values', () => {
    const base = createDefaultAutoBracingSettings();
    const patched = applyAutoBracingSettingsPatch(base, {
        seedSpacingMm: 8.6,
        initialPattern: 'crossDiagonal',
        debugSectionColorsEnabled: true,
    });

    assert.equal(patched.seedSpacingMm, 8.5);
    assert.equal(patched.initialPattern, 'crossDiagonal');
    assert.equal(patched.debugSectionColorsEnabled, true);
    assert.equal(patched.repeatingPattern, base.repeatingPattern);
    assert.equal(patched.braceDiameterMm, base.braceDiameterMm);
});
