import assert from 'node:assert/strict';
import test from 'node:test';

import {
    getSettings,
    setSettings,
    updateRootsProfile,
    updateShaftProfile,
    updateTipProfile,
} from '../Settings/state';
import { SUPPORT_PROFILE_LIMITS } from '../Settings/defaults';
import { createDefaultSettings } from '../Settings/types';

function reset(): void {
    setSettings(createDefaultSettings());
}

// The General tab writes through these, and the same table feeds the inputs'
// min/max, so a negative value has no path into the stored geometry.
test('negative profile writes land on the field minimum', () => {
    reset();

    updateTipProfile({ contactDiameterMm: -1, lengthMm: -5, adaptiveConeAngleOffsetDeg: -30 });
    updateRootsProfile({ diameterMm: -2, diskHeightMm: -3, coneHeightMm: -1 });
    updateShaftProfile({ diameterMm: -4 });

    const settings = getSettings();
    assert.equal(settings.tip.contactDiameterMm, SUPPORT_PROFILE_LIMITS.tip.contactDiameterMm.min);
    assert.equal(settings.tip.lengthMm, SUPPORT_PROFILE_LIMITS.tip.lengthMm.min);
    assert.equal(settings.tip.adaptiveConeAngleOffsetDeg, SUPPORT_PROFILE_LIMITS.tip.adaptiveConeAngleOffsetDeg.min);
    assert.equal(settings.roots.diameterMm, SUPPORT_PROFILE_LIMITS.roots.diameterMm.min);
    assert.equal(settings.roots.diskHeightMm, SUPPORT_PROFILE_LIMITS.roots.diskHeightMm.min);
    assert.equal(settings.roots.coneHeightMm, SUPPORT_PROFILE_LIMITS.roots.coneHeightMm.min);
    assert.equal(settings.shaft.diameterMm, SUPPORT_PROFILE_LIMITS.shaft.diameterMm.min);
});

test('a zero height stays zero — no feature is a legal value', () => {
    reset();

    updateRootsProfile({ diskHeightMm: 0, coneHeightMm: 0 });

    assert.equal(getSettings().roots.diskHeightMm, 0);
    assert.equal(getSettings().roots.coneHeightMm, 0);
});

test('absurd values are capped and never exceed their maximum', () => {
    reset();

    updateTipProfile({ contactDiameterMm: 1000 });
    updateShaftProfile({ diameterMm: 1000 });
    updateRootsProfile({ diameterMm: 1000, diskHeightMm: 1000, coneHeightMm: 1000 });

    const settings = getSettings();
    assert.equal(settings.tip.contactDiameterMm, SUPPORT_PROFILE_LIMITS.tip.contactDiameterMm.max);
    assert.equal(settings.shaft.diameterMm, SUPPORT_PROFILE_LIMITS.shaft.diameterMm.max);
    assert.equal(settings.roots.diameterMm, SUPPORT_PROFILE_LIMITS.roots.diameterMm.max);
    assert.equal(settings.roots.diskHeightMm, SUPPORT_PROFILE_LIMITS.roots.diskHeightMm.max);
    assert.equal(settings.roots.coneHeightMm, SUPPORT_PROFILE_LIMITS.roots.coneHeightMm.max);
});

// Presets, imported scenes and plugin calls reach the store through setSettings,
// not through the tab, so the limit has to hold on that path too.
test('a preset carrying negatives is clamped on load', () => {
    const preset = createDefaultSettings();
    preset.tip.contactDiameterMm = -0.5;
    preset.tip.lengthMm = -1;
    preset.shaft.diameterMm = -3;
    preset.roots.diskHeightMm = -2;

    setSettings(preset);

    const settings = getSettings();
    assert.equal(settings.tip.contactDiameterMm, SUPPORT_PROFILE_LIMITS.tip.contactDiameterMm.min);
    assert.equal(settings.tip.lengthMm, SUPPORT_PROFILE_LIMITS.tip.lengthMm.min);
    assert.equal(settings.shaft.diameterMm, SUPPORT_PROFILE_LIMITS.shaft.diameterMm.min);
    assert.equal(settings.roots.diskHeightMm, 0);
});

test('the trunk diameter sync keeps the cone body inside the trunk', () => {
    reset();

    updateShaftProfile({ diameterMm: 1000 });

    const settings = getSettings();
    assert.equal(settings.shaft.diameterMm, SUPPORT_PROFILE_LIMITS.shaft.diameterMm.max);
    assert.ok(
        settings.tip.bodyDiameterMm <= settings.shaft.diameterMm,
        `cone body ${settings.tip.bodyDiameterMm}mm must not exceed trunk ${settings.shaft.diameterMm}mm`,
    );
});
