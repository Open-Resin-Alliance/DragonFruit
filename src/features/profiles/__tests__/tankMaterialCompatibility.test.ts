import assert from 'node:assert/strict';
import test from 'node:test';

import type { MaterialProfile } from '../profileStore';
import { tankMaterialsDisagree } from '../tankMaterialCompatibility';

const material = (overrides: Partial<MaterialProfile> = {}): MaterialProfile => ({
    id: 'material',
    printerProfileId: 'printer',
    name: 'Resin',
    brand: 'Test',
    currencyCode: 'USD',
    bottlePrice: 0,
    bottleCapacityMl: 1000,
    resinFamily: 'standard',
    scaleCompensationPct: { x: 0, y: 0, z: 0 },
    layerHeightMm: 0.05,
    normalExposureSec: 2.5,
    bottomExposureSec: 30,
    bottomLayerCount: 5,
    liftDistanceMm: 6,
    liftSpeedMmMin: 60,
    retractSpeedMmMin: 150,
    minimumAaAlphaPercent: 35,
    bottomOutlineCompensationMm: 0,
    bottomHoleCompensationMm: 0,
    bottomCompensationFade: true,
    antiAliasingSettings: {} as MaterialProfile['antiAliasingSettings'],
    ...overrides,
});

test('matching layer height, initial layers and transition layers agree', () => {
    const a = material({ localSettingsByOutput: { '.zip': { traLayers: 2 } } });
    const b = material({ layerHeightMm: 0.05, bottomLayerCount: 5, localSettingsByOutput: { zip: { traLayers: 2 } } });
    assert.equal(tankMaterialsDisagree(a, b, '.zip'), false);
});

test('each of the three values can disagree on its own', () => {
    const base = material({ localSettingsByOutput: { '.zip': { traLayers: 2 } } });
    assert.equal(tankMaterialsDisagree(base, material({ layerHeightMm: 0.03, localSettingsByOutput: { '.zip': { traLayers: 2 } } }), '.zip'), true);
    assert.equal(tankMaterialsDisagree(base, material({ bottomLayerCount: 4, localSettingsByOutput: { '.zip': { traLayers: 2 } } }), '.zip'), true);
    assert.equal(tankMaterialsDisagree(base, material({ localSettingsByOutput: { '.zip': { traLayers: 3 } } }), '.zip'), true);
});

test('other material settings never count as a mismatch', () => {
    const a = material();
    const b = material({ normalExposureSec: 1, bottomExposureSec: 10, liftDistanceMm: 2 });
    assert.equal(tankMaterialsDisagree(a, b, '.zip'), false);
});
