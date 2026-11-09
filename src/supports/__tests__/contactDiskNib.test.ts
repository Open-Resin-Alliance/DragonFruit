import assert from 'node:assert/strict';
import test from 'node:test';

import { calculateDiskThickness } from '../SupportPrimitives/ContactDisk/contactDiskUtils';
import type { ContactDiskProfile } from '../SupportPrimitives/ContactCone/types';
import { createDefaultSettings } from '../Settings/types';
import type { Vec3 } from '../types';

const FLAT_NORMAL: Vec3 = { x: 0, y: 0, z: 1 };
/** A surface steep enough that the angle-driven standoff dominates the nib. */
const STEEP_AXIS: Vec3 = { x: Math.sin((80 * Math.PI) / 180), y: 0, z: Math.cos((80 * Math.PI) / 180) };

function nibProfile(overrides: Partial<ContactDiskProfile> = {}): ContactDiskProfile {
    const tip = createDefaultSettings().tip;
    return {
        type: 'disk',
        diskThicknessMm: tip.diskThicknessMm ?? 0.1,
        maxStandoffMm: tip.maxStandoffMm ?? 1.5,
        standoffAngleThreshold: tip.standoffAngleThreshold ?? Math.PI / 4,
        contactDiameterMm: tip.contactDiameterMm,
        ...overrides,
    };
}

// The round tip is centered on the nib's top face, so a nib shorter than the
// ball's radius drops the ball's underside below the flat contact face: it pokes
// out through the model side of the nib, and only the nib's diameter used to
// follow the contact diameter.
test('a wide contact grows the nib so the round tip stays above the contact face', () => {
    for (const contactDiameterMm of [0.3, 0.4, 1.0, 2.0, 4.0]) {
        const thickness = calculateDiskThickness(FLAT_NORMAL, FLAT_NORMAL, nibProfile({ contactDiameterMm }));
        const tipBallLowestMm = thickness - contactDiameterMm / 2;
        assert.ok(
            tipBallLowestMm >= 0,
            `contact ${contactDiameterMm}mm: the tip ball dips ${(-tipBallLowestMm).toFixed(3)}mm below the contact face`,
        );
    }
});

test('a steep surface still thickens the nib past the tip ball radius', () => {
    const profile = nibProfile({ contactDiameterMm: 0.3 });

    const flatThickness = calculateDiskThickness(FLAT_NORMAL, FLAT_NORMAL, profile);
    const steepThickness = calculateDiskThickness(FLAT_NORMAL, STEEP_AXIS, profile);

    assert.equal(flatThickness, 0.15, 'a flat contact holds the nib at the ball radius');
    assert.ok(
        steepThickness > 0.3,
        `a steep contact must keep its standoff, got ${steepThickness}mm`,
    );
});

test('a profile that declares no contact diameter keeps the plain nib thickness', () => {
    const profile = nibProfile({ contactDiameterMm: undefined });

    assert.equal(calculateDiskThickness(FLAT_NORMAL, FLAT_NORMAL, profile), profile.diskThicknessMm);
});
