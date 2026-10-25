import assert from 'node:assert/strict';
import test from 'node:test';

import {
    areSupportGeometrySettingsEqual,
    decodeSupportSettingsHex,
    encodeSupportSettingsHex,
} from '../supportSettingsCodec';
import { createDefaultSettings } from '../types';

test('a sphere tip survives an encode/decode round trip', () => {
    const settings = createDefaultSettings();
    settings.tip.type = 'sphere';

    const decoded = decodeSupportSettingsHex(encodeSupportSettingsHex(settings));

    assert.equal(decoded?.tip.type, 'sphere');
});

test('a disk tip survives an encode/decode round trip', () => {
    const settings = createDefaultSettings();
    settings.tip.type = 'disk';

    const decoded = decodeSupportSettingsHex(encodeSupportSettingsHex(settings));

    assert.equal(decoded?.tip.type, 'disk');
});

test('a payload written without the tip shape bit decodes as a disk tip', () => {
    const legacyHex = encodeSupportSettingsHex(createDefaultSettings()).slice(0, 2)
        + '00'
        + encodeSupportSettingsHex(createDefaultSettings()).slice(4);

    assert.equal(decodeSupportSettingsHex(legacyHex)?.tip.type, 'disk');
});

test('changing only the tip shape is a geometry change', () => {
    const disk = createDefaultSettings();
    const sphere = createDefaultSettings();
    sphere.tip.type = 'sphere';

    assert.equal(areSupportGeometrySettingsEqual(disk, sphere), false);
    assert.equal(areSupportGeometrySettingsEqual(disk, createDefaultSettings()), true);
});
