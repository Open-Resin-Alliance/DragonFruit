import assert from 'node:assert/strict';
import test from 'node:test';

import { buildStick } from '../SupportTypes/Stick/stickBuilder';
import { setSettings } from '../Settings/state';
import { createDefaultSettings } from '../Settings/types';
import { activeSizingBand } from '../autoSupport/parameterSizing';
import { getFinalSocketPosition } from '../SupportPrimitives/ContactCone/contactConeUtils';
import { calculateDiskThickness } from '../SupportPrimitives/ContactDisk/contactDiskUtils';

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

test('recomputes disk thickness and socket position after final cone axis clamp', () => {
    const studio = createDefaultSettings();
    setSettings({
        ...studio,
        tip: {
            ...studio.tip,
            contactDiameterMm: 0.2,
            diskThicknessMm: 0.1,
            maxStandoffMm: 1.4,
            standoffAngleThreshold: 0.39,
        },
    });

    try {
        const result = buildStick({
            modelId: 'm',
            aPos: { x: 0, y: 0, z: 0 },
            aNormal: { x: 0, y: 0, z: 1 },
            bPos: { x: 0.38, y: 0, z: 0.98 },
            bNormal: { x: 0, y: 0, z: -1 },
        });

        assert.equal(result.error, undefined);
        const segment = result.stick.segments[0];
        const coneA = result.stick.contactConeA;
        const coneB = result.stick.contactConeB;
        assert.ok(coneA && coneB && segment.bottomJoint && segment.topJoint);
        if (coneA.profile.type !== 'disk' || coneB.profile.type !== 'disk') {
            assert.fail('expected disk tip profiles on stick contact cones');
        }

        const expectedThicknessA = calculateDiskThickness(
            coneA.surfaceNormal ?? coneA.normal,
            coneA.normal,
            coneA.profile,
        );
        const expectedThicknessB = calculateDiskThickness(
            coneB.surfaceNormal ?? coneB.normal,
            coneB.normal,
            coneB.profile,
        );
        assert.ok(
            Math.abs((coneA.diskLengthOverride ?? 0) - expectedThicknessA) < 1e-9,
            `coneA diskLengthOverride (${coneA.diskLengthOverride}) matches post-clamp thickness (${expectedThicknessA})`,
        );
        assert.ok(
            Math.abs((coneB.diskLengthOverride ?? 0) - expectedThicknessB) < 1e-9,
            `coneB diskLengthOverride (${coneB.diskLengthOverride}) matches post-clamp thickness (${expectedThicknessB})`,
        );

        const expectedSocketA = getFinalSocketPosition({ ...coneA, diskLengthOverride: undefined });
        const expectedSocketB = getFinalSocketPosition({ ...coneB, diskLengthOverride: undefined });
        for (const axis of ['x', 'y', 'z'] as const) {
            assert.ok(
                Math.abs(segment.bottomJoint.pos[axis] - expectedSocketA[axis]) < 1e-9,
                `bottomJoint.pos.${axis} (${segment.bottomJoint.pos[axis]}) matches getFinalSocketPosition (${expectedSocketA[axis]})`,
            );
            assert.ok(
                Math.abs(segment.topJoint.pos[axis] - expectedSocketB[axis]) < 1e-9,
                `topJoint.pos.${axis} (${segment.topJoint.pos[axis]}) matches getFinalSocketPosition (${expectedSocketB[axis]})`,
            );
        }
    } finally {
        setSettings(createDefaultSettings());
    }
});
