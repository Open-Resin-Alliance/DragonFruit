import assert from 'node:assert/strict';
import test from 'node:test';

import { shaftVerticalCos, type ShaftedEntity } from '../SupportTypes/shaftVerticality';
import { MAX_TWIG_SHAFT_ANGLE_DEG } from '../SupportTypes/Twig/twigVerticality';
// The registry is populated by the type registrations' side effects, which
// `state.ts` imports for the app; a focused test has to ask for its own.
import '../SupportTypes/Twig/twigRegistration';
import { buildContactBridge, type ContactBridgeRequest } from '../supportTypeRegistry';

// The registry types a bridge entity as `{ id: string }`; the geometry is in
// its segments.
const shaftAngleDeg = (entity: { id: string }) =>
    (Math.acos(shaftVerticalCos(entity as unknown as ShaftedEntity)) * 180) / Math.PI;

const bridge = (bPos: { x: number; y: number; z: number }) => buildContactBridge('twig', {
    modelId: 'm',
    aPos: { x: 0, y: 0, z: 10 },
    aNormal: { x: 0, y: 0, z: -1 },
    bPos,
    bNormal: { x: 0, y: 0, z: 1 },
} as ContactBridgeRequest);

test('a twig is refused when its shaft is too canted to carry load', () => {
    const vertical = bridge({ x: 0, y: 0, z: 6 });
    assert.ok(vertical, 'a bridge straight down still builds');
    const angleDeg = shaftAngleDeg(vertical.entity);
    assert.ok(angleDeg < 5, `and it stands vertical (${angleDeg.toFixed(1)}deg)`);

    // Six mm across for a half mm of drop: the whisker the preview shows
    // crossing a gap, which hangs the island off a strut that carries nothing.
    const whisker = bridge({ x: 6, y: 0, z: 9.5 });
    assert.equal(whisker, null, 'a near-horizontal whisker is refused outright');
});

test('the gate is the twig rule, not the stick rule', () => {
    // A cant a twig keeps but a stick would not: measured pointed-tip props
    // land in this band, and they are real bridges. If this ever starts
    // failing, the twig picked up the stick's 20 degrees.
    const prop = bridge({ x: 1, y: 0, z: 7.5 });
    assert.ok(prop, 'a canted prop still builds');
    const angleDeg = shaftAngleDeg(prop.entity);
    assert.ok(angleDeg > 20, `it is canted past the stick gate (${angleDeg.toFixed(1)}deg)`);
    assert.ok(angleDeg < MAX_TWIG_SHAFT_ANGLE_DEG,
        `and inside the twig gate (${angleDeg.toFixed(1)} < ${MAX_TWIG_SHAFT_ANGLE_DEG})`);
});
