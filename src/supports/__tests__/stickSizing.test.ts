import assert from 'node:assert/strict';
import test from 'node:test';

import { buildStick } from '../SupportTypes/Stick/stickBuilder';
import { setSettings } from '../Settings/state';
import { createDefaultSettings } from '../Settings/types';
import { activeSizingBand } from '../autoSupport/parameterSizing';

/**
 * A stick built for auto supports carries the tier band; a manual one carries
 * the Studio preset. The builder ignored both tier overrides once, so an auto
 * run silently inherited whatever profile was selected by hand.
 */
test('auto-tier overrides size the stick, not the Studio preset', () => {
    const studio = createDefaultSettings();
    setSettings({
        ...studio,
        shaft: { ...studio.shaft, diameterMm: 0.6 },
        tip: { ...studio.tip, contactDiameterMm: 0.5 },
    });

    try {
        const band = activeSizingBand();
        assert.notEqual(band.shaftDiameterMm, 0.6,
            'fixture is only meaningful while the tier and the Studio preset differ');

        const placement = {
            modelId: 'm',
            aPos: { x: 0, y: 0, z: 10 }, aNormal: { x: 0, y: 0, z: -1 },
            bPos: { x: 0, y: 0, z: 18 }, bNormal: { x: 0, y: 0, z: 1 },
        };

        const auto = buildStick({
            ...placement,
            shaftDiameterMm: band.shaftDiameterMm,
            tipContactDiameterMm: band.tipContactDiameterMm,
        });
        const manual = buildStick(placement);

        assert.ok(!auto.error && !manual.error, 'both sticks build');
        assert.equal(auto.stick.segments[0].diameter, band.shaftDiameterMm,
            `auto shaft is the tier band (${auto.stick.segments[0].diameter})`);
        assert.equal(auto.stick.contactConeA?.profile.contactDiameterMm, band.tipContactDiameterMm,
            `auto tip contact is the tier band (${auto.stick.contactConeA?.profile.contactDiameterMm})`);
        assert.equal(manual.stick.segments[0].diameter, 0.6,
            'manual placement still sizes from the Studio preset');
    } finally {
        setSettings(createDefaultSettings());
    }
});
