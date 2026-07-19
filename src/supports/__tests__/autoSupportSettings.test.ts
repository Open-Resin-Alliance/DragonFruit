import assert from 'node:assert/strict';
import test from 'node:test';

import {
    createDefaultAutoSupportSettings,
    normalizeAutoSupportSettings,
    applyAutoSupportSettingsPatch,
    AUTO_SUPPORT_CONSTRAINTS,
    AUTO_SUPPORT_HARD_RULES,
} from '../autoSupport/settings';

test('defaults match constraints', () => {
    const defaults = createDefaultAutoSupportSettings();

    assert.equal(defaults.enabled, true);
    assert.equal(defaults.minIslandAreaMm2, AUTO_SUPPORT_CONSTRAINTS.minIslandAreaMm2.defaultValue);
    assert.equal(defaults.clusterRadiusMm, AUTO_SUPPORT_CONSTRAINTS.clusterRadiusMm.defaultValue);
    assert.equal(defaults.maxBranchReachMm, AUTO_SUPPORT_CONSTRAINTS.maxBranchReachMm.defaultValue);
    assert.equal(defaults.maxBranchAngleDeg, AUTO_SUPPORT_CONSTRAINTS.maxBranchAngleDeg.defaultValue);
    assert.equal(defaults.minTrunkSeparationMm, AUTO_SUPPORT_CONSTRAINTS.minTrunkSeparationMm.defaultValue);
    assert.equal(defaults.densityFactor, AUTO_SUPPORT_CONSTRAINTS.densityFactor.defaultValue);
    assert.equal(defaults.tipInfluenceRadiusMm, AUTO_SUPPORT_CONSTRAINTS.tipInfluenceRadiusMm.defaultValue);
    assert.equal(defaults.prioritizeIntersection, false);
    assert.equal(defaults.debugClusterColorsEnabled, false);
});

test('normalize clamps high values', () => {
    const normalized = normalizeAutoSupportSettings({
        minIslandAreaMm2: 999,
        maxBranchAngleDeg: 999,
    });

    assert.equal(normalized.minIslandAreaMm2, AUTO_SUPPORT_CONSTRAINTS.minIslandAreaMm2.max);
    assert.equal(normalized.maxBranchAngleDeg, AUTO_SUPPORT_CONSTRAINTS.maxBranchAngleDeg.max);
});

test('normalize fills missing fields', () => {
    const normalized = normalizeAutoSupportSettings({});
    const defaults = createDefaultAutoSupportSettings();

    assert.equal(normalized.enabled, defaults.enabled);
    assert.equal(normalized.minIslandAreaMm2, defaults.minIslandAreaMm2);
    assert.equal(normalized.clusterRadiusMm, defaults.clusterRadiusMm);
    assert.equal(normalized.maxBranchReachMm, defaults.maxBranchReachMm);
    assert.equal(normalized.maxBranchAngleDeg, defaults.maxBranchAngleDeg);
    assert.equal(normalized.minTrunkSeparationMm, defaults.minTrunkSeparationMm);
    assert.equal(normalized.densityFactor, defaults.densityFactor);
    assert.equal(normalized.tipInfluenceRadiusMm, defaults.tipInfluenceRadiusMm);
    assert.equal(normalized.prioritizeIntersection, defaults.prioritizeIntersection);
    assert.equal(normalized.debugClusterColorsEnabled, defaults.debugClusterColorsEnabled);
});

test('patch merges partially', () => {
    const base = createDefaultAutoSupportSettings();
    const patched = applyAutoSupportSettingsPatch(base, {
        enabled: false,
        clusterRadiusMm: 30,
    });

    assert.equal(patched.enabled, false);
    assert.equal(patched.clusterRadiusMm, 30);
    assert.equal(patched.minIslandAreaMm2, base.minIslandAreaMm2);
    assert.equal(patched.maxBranchReachMm, base.maxBranchReachMm);
    assert.equal(patched.maxBranchAngleDeg, base.maxBranchAngleDeg);
    assert.equal(patched.minTrunkSeparationMm, base.minTrunkSeparationMm);
    assert.equal(patched.densityFactor, base.densityFactor);
    assert.equal(patched.tipInfluenceRadiusMm, base.tipInfluenceRadiusMm);
    assert.equal(patched.prioritizeIntersection, base.prioritizeIntersection);
    assert.equal(patched.debugClusterColorsEnabled, base.debugClusterColorsEnabled);
});

test('hard rules have correct values', () => {
    assert.equal(AUTO_SUPPORT_HARD_RULES.ANCHOR_HEIGHT_THRESHOLD_MM, 5);
    assert.equal(AUTO_SUPPORT_HARD_RULES.MAX_LEAF_SPAN_MM, 2.5);
    assert.equal(AUTO_SUPPORT_HARD_RULES.MIN_GROUP_SIZE, 2);
});
