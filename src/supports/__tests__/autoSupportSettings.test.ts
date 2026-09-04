import assert from 'node:assert/strict';
import test from 'node:test';

import {
    createDefaultAutoSupportSettings,
    normalizeAutoSupportSettings,
    applyAutoSupportSettingsPatch,
    AUTO_SUPPORT_CONSTRAINTS,
} from '../autoSupport/settings';

test('defaults match constraints', () => {
    const defaults = createDefaultAutoSupportSettings();

    assert.equal(defaults.enabled, true);
    assert.equal(defaults.minIslandAreaMm2, AUTO_SUPPORT_CONSTRAINTS.minIslandAreaMm2.defaultValue);
    assert.equal(defaults.tipInfluenceRadiusMm, AUTO_SUPPORT_CONSTRAINTS.tipInfluenceRadiusMm.defaultValue);
    assert.equal(defaults.prioritizeIntersection, false);
    assert.equal(defaults.maxAttachmentsPerTrunk, AUTO_SUPPORT_CONSTRAINTS.maxAttachmentsPerTrunk.defaultValue);
    assert.equal(defaults.areaPerSupportMm2, AUTO_SUPPORT_CONSTRAINTS.areaPerSupportMm2.defaultValue);
    assert.equal(defaults.overhangSelfSupportAngleDeg, AUTO_SUPPORT_CONSTRAINTS.overhangSelfSupportAngleDeg.defaultValue);
    assert.equal(defaults.sizeScale, 1);
    assert.equal(defaults.flatDensityBoost, AUTO_SUPPORT_CONSTRAINTS.flatDensityBoost.defaultValue);
    assert.equal(defaults.slopeRelaxFactor, AUTO_SUPPORT_CONSTRAINTS.slopeRelaxFactor.defaultValue);
    assert.equal(defaults.coverageTargetPercent, AUTO_SUPPORT_CONSTRAINTS.coverageTargetPercent.defaultValue);
    assert.equal(defaults.leafFanRadiusMm, AUTO_SUPPORT_CONSTRAINTS.leafFanRadiusMm.defaultValue);
    assert.equal(defaults.leafFanMaxAngleDeg, AUTO_SUPPORT_CONSTRAINTS.leafFanMaxAngleDeg.defaultValue);
    assert.equal(defaults.debugSkipAutoBracing, false);
});

test('normalize clamps the new knobs', () => {
    const normalized = normalizeAutoSupportSettings({
        sizeScale: 9,
        flatDensityBoost: 0.1,
        slopeRelaxFactor: 5,
        coverageTargetPercent: 50,
        leafFanRadiusMm: 100,
        leafFanMaxAngleDeg: 200,
    });
    assert.equal(normalized.sizeScale, AUTO_SUPPORT_CONSTRAINTS.sizeScale.max);
    assert.equal(normalized.flatDensityBoost, AUTO_SUPPORT_CONSTRAINTS.flatDensityBoost.min);
    assert.equal(normalized.slopeRelaxFactor, AUTO_SUPPORT_CONSTRAINTS.slopeRelaxFactor.max);
    assert.equal(normalized.coverageTargetPercent, AUTO_SUPPORT_CONSTRAINTS.coverageTargetPercent.min);
    assert.equal(normalized.leafFanRadiusMm, AUTO_SUPPORT_CONSTRAINTS.leafFanRadiusMm.max);
    assert.equal(normalized.leafFanMaxAngleDeg, AUTO_SUPPORT_CONSTRAINTS.leafFanMaxAngleDeg.max);
});

test('normalize clamps high values', () => {
    const normalized = normalizeAutoSupportSettings({
        minIslandAreaMm2: 999,
        maxAttachmentsPerTrunk: 999,
    });

    assert.equal(normalized.minIslandAreaMm2, AUTO_SUPPORT_CONSTRAINTS.minIslandAreaMm2.max);
    assert.equal(normalized.maxAttachmentsPerTrunk, AUTO_SUPPORT_CONSTRAINTS.maxAttachmentsPerTrunk.max);
});

test('normalize fills missing fields', () => {
    const normalized = normalizeAutoSupportSettings({});
    const defaults = createDefaultAutoSupportSettings();

    assert.equal(normalized.enabled, defaults.enabled);
    assert.equal(normalized.minIslandAreaMm2, defaults.minIslandAreaMm2);
    assert.equal(normalized.tipInfluenceRadiusMm, defaults.tipInfluenceRadiusMm);
    assert.equal(normalized.prioritizeIntersection, defaults.prioritizeIntersection);
    assert.equal(normalized.maxAttachmentsPerTrunk, defaults.maxAttachmentsPerTrunk);
    assert.equal(normalized.debugSkipAutoBracing, defaults.debugSkipAutoBracing);
});

test('normalize drops legacy dead keys', () => {
    // Settings saved before the dead-knob removal (clusterRadiusMm and friends)
    // must normalize cleanly to the live shape without errors. Cast through any
    // because the keys no longer exist on the type.
    const normalized = normalizeAutoSupportSettings({
        clusterRadiusMm: 30,
        debugClusterColorsEnabled: true,
        minIslandAreaMm2: 0.1,
    } as unknown as Parameters<typeof normalizeAutoSupportSettings>[0]);

    assert.equal(normalized.minIslandAreaMm2, 0.1);
    assert.equal(normalized.tipInfluenceRadiusMm, AUTO_SUPPORT_CONSTRAINTS.tipInfluenceRadiusMm.defaultValue);
});

test('defaults include the densification knobs', () => {
    const defaults = createDefaultAutoSupportSettings();

    assert.equal(defaults.suctionAreaExponent, AUTO_SUPPORT_CONSTRAINTS.suctionAreaExponent.defaultValue);
});

test('normalize clamps the densification knobs', () => {
    const normalized = normalizeAutoSupportSettings({
        suctionAreaExponent: 9,
    });

    assert.equal(normalized.suctionAreaExponent, AUTO_SUPPORT_CONSTRAINTS.suctionAreaExponent.max);
});

test('defaults include distribution mode and perimeter factor', () => {
    const defaults = createDefaultAutoSupportSettings();

    assert.equal(defaults.debugSupportOriginColors, false);
});

test('normalize whitelists the sizing tier (trunk presets never own it)', () => {
    assert.equal(normalizeAutoSupportSettings({}).sizingPreset, 'structure');
    assert.equal(normalizeAutoSupportSettings({ sizingPreset: 'detail' as const }).sizingPreset, 'detail');
    assert.equal(normalizeAutoSupportSettings({ sizingPreset: 'banana' as never }).sizingPreset, 'structure');
});

test('patch merges partially', () => {
    const base = createDefaultAutoSupportSettings();
    const patched = applyAutoSupportSettingsPatch(base, {
        enabled: false,
        maxAttachmentsPerTrunk: 30,
    });

    assert.equal(patched.enabled, false);
    assert.equal(patched.maxAttachmentsPerTrunk, 30);
    assert.equal(patched.minIslandAreaMm2, base.minIslandAreaMm2);
    assert.equal(patched.tipInfluenceRadiusMm, base.tipInfluenceRadiusMm);
    assert.equal(patched.prioritizeIntersection, base.prioritizeIntersection);
    assert.equal(patched.debugSkipAutoBracing, base.debugSkipAutoBracing);
});
