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
    assert.equal(settings.topOffsetFromTopMm, AUTO_BRACING_CONSTRAINTS.topOffsetFromTopMm.defaultValue);
    assert.equal(settings.middleRepeatIntervalMm, AUTO_BRACING_CONSTRAINTS.middleRepeatIntervalMm.defaultValue);
    assert.equal(settings.bottomOffsetFromBottomMm, AUTO_BRACING_CONSTRAINTS.bottomOffsetFromBottomMm.defaultValue);
    assert.equal(settings.topPattern, 'singleDiagonal');
    assert.equal(settings.middlePattern, 'singleDiagonal');
    assert.equal(settings.bottomPattern, 'singleDiagonal');
    assert.equal(settings.debugSectionColorsEnabled, false);
});

test('normalizeAutoBracingSettings clamps numeric values and restores invalid patterns', () => {
    const normalized = normalizeAutoBracingSettings({
        braceDiameterMm: -5,
        maxGroupSize: 42,
        topPattern: 'invalid-pattern' as any,
        topOffsetFromTopMm: 999,
        middlePattern: 'crossDiagonal',
        middleRepeatIntervalMm: -1,
        bottomPattern: 'invalid-pattern' as any,
        bottomOffsetFromBottomMm: 999,
        debugSectionColorsEnabled: 'yes' as any,
    });

    assert.equal(normalized.braceDiameterMm, AUTO_BRACING_CONSTRAINTS.braceDiameterMm.min);
    assert.equal(normalized.maxGroupSize, AUTO_BRACING_CONSTRAINTS.maxGroupSize.max);
    assert.equal(normalized.topPattern, 'singleDiagonal');
    assert.equal(normalized.topOffsetFromTopMm, AUTO_BRACING_CONSTRAINTS.topOffsetFromTopMm.max);
    assert.equal(normalized.middlePattern, 'crossDiagonal');
    assert.equal(normalized.middleRepeatIntervalMm, AUTO_BRACING_CONSTRAINTS.middleRepeatIntervalMm.min);
    assert.equal(normalized.bottomPattern, 'singleDiagonal');
    assert.equal(normalized.bottomOffsetFromBottomMm, AUTO_BRACING_CONSTRAINTS.bottomOffsetFromBottomMm.max);
    assert.equal(normalized.debugSectionColorsEnabled, false);
});

test('applyAutoBracingSettingsPatch keeps untouched fields and normalizes patched values', () => {
    const base = createDefaultAutoBracingSettings();
    const patched = applyAutoBracingSettingsPatch(base, {
        maxGroupSize: 8.8,
        topPattern: 'crossDiagonal',
        debugSectionColorsEnabled: true,
    });

    assert.equal(patched.maxGroupSize, 9);
    assert.equal(patched.topPattern, 'crossDiagonal');
    assert.equal(patched.debugSectionColorsEnabled, true);
    assert.equal(patched.bottomPattern, base.bottomPattern);
    assert.equal(patched.braceDiameterMm, base.braceDiameterMm);
});
