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
    assert.equal(settings.maxGroupSize, AUTO_BRACING_CONSTRAINTS.maxGroupSize.defaultValue);
    assert.equal(settings.initialPattern, 'singleDiagonal');
    assert.equal(settings.repeatPattern, 'singleDiagonal');
    assert.equal(settings.initialOffsetFromBottomMm, AUTO_BRACING_CONSTRAINTS.initialOffsetFromBottomMm.defaultValue);
    assert.equal(settings.repeatIntervalMm, AUTO_BRACING_CONSTRAINTS.repeatIntervalMm.defaultValue);
    assert.equal(settings.debugSectionColorsEnabled, false);
    assert.equal(settings.debugSupportHeightLabelsEnabled, false);
});

test('normalizeAutoBracingSettings clamps numeric values and restores invalid patterns', () => {
    const normalized = normalizeAutoBracingSettings({
        braceDiameterMm: -5,
        maxGroupSize: 42,
        initialPattern: 'invalid-pattern' as any,
        repeatPattern: 'crossDiagonal',
        initialOffsetFromBottomMm: 999,
        repeatIntervalMm: -1,
        debugSectionColorsEnabled: 'yes' as any,
        debugSupportHeightLabelsEnabled: 'yes' as any,
    });

    assert.equal(normalized.braceDiameterMm, AUTO_BRACING_CONSTRAINTS.braceDiameterMm.min);
    assert.equal(normalized.maxGroupSize, AUTO_BRACING_CONSTRAINTS.maxGroupSize.max);
    assert.equal(normalized.initialPattern, 'singleDiagonal');
    assert.equal(normalized.repeatPattern, 'crossDiagonal');
    assert.equal(normalized.initialOffsetFromBottomMm, AUTO_BRACING_CONSTRAINTS.initialOffsetFromBottomMm.max);
    assert.equal(normalized.repeatIntervalMm, AUTO_BRACING_CONSTRAINTS.repeatIntervalMm.min);
    assert.equal(normalized.debugSectionColorsEnabled, false);
    assert.equal(normalized.debugSupportHeightLabelsEnabled, false);
});

test('applyAutoBracingSettingsPatch keeps untouched fields and normalizes patched values', () => {
    const base = createDefaultAutoBracingSettings();
    const patched = applyAutoBracingSettingsPatch(base, {
        maxGroupSize: 8.8,
        initialPattern: 'crossDiagonal',
        repeatPattern: 'crossDiagonal',
        debugSectionColorsEnabled: true,
        debugSupportHeightLabelsEnabled: true,
    });

    assert.equal(patched.maxGroupSize, 9);
    assert.equal(patched.initialPattern, 'crossDiagonal');
    assert.equal(patched.repeatPattern, 'crossDiagonal');
    assert.equal(patched.debugSectionColorsEnabled, true);
    assert.equal(patched.debugSupportHeightLabelsEnabled, true);
    assert.equal(patched.repeatIntervalMm, base.repeatIntervalMm);
    assert.equal(patched.braceDiameterMm, base.braceDiameterMm);
});
