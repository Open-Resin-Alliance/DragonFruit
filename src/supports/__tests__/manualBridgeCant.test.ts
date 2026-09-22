import assert from 'node:assert/strict';
import test from 'node:test';

// Every type's registration runs from the barrel `state.ts` loads, and
// `state.ts` asserts at load that they all did — so a focused test has to
// enter the graph through `state.ts`, not through one registration module:
// that module reaches `state.ts` back through the export helpers, and the
// assertion would run before its own registration had.
import '../state';
import { shaftVerticalCos, type ShaftedEntity } from '../SupportTypes/shaftVerticality';
import { MAX_TWIG_SHAFT_ANGLE_DEG } from '../SupportTypes/Twig/twigVerticality';
import { MAX_SHAFT_ANGLE_DEG } from '../SupportTypes/Stick/stickVerticality';
import { buildContactBridge, type ContactBridgeRequest } from '../supportTypeRegistry';

// The registry types a bridge entity as `{ id: string }`; the geometry is in
// its segments.
const shaftAngleDeg = (entity: { id: string }) =>
    (Math.acos(shaftVerticalCos(entity as unknown as ShaftedEntity)) * 180) / Math.PI;

const bridge = (
    typeId: 'twig' | 'stick',
    bPos: { x: number; y: number; z: number },
    manual?: boolean,
) => buildContactBridge(typeId, {
    modelId: 'm',
    aPos: { x: 0, y: 0, z: 10 },
    aNormal: { x: 0, y: 0, z: -1 },
    bPos,
    bNormal: { x: 0, y: 0, z: 1 },
    ...(manual ? { manual: true } : {}),
} as ContactBridgeRequest);

test('a manually aimed twig builds past the cant the auto pass refuses', () => {
    // Six mm across for a half mm of drop: the whisker the auto pass refuses
    // outright, and the shape a hand keeps aiming across a gap.
    const whisker = { x: 6, y: 0, z: 9.5 };
    assert.equal(bridge('twig', whisker), null, 'the auto pass still refuses it');

    const aimed = bridge('twig', whisker, true);
    assert.ok(aimed, 'a manual aim builds it');
    const angleDeg = shaftAngleDeg(aimed.entity);
    assert.ok(angleDeg > MAX_TWIG_SHAFT_ANGLE_DEG,
        `and it really is past the twig gate (${angleDeg.toFixed(1)} > ${MAX_TWIG_SHAFT_ANGLE_DEG})`);
});

test('a manually aimed stick builds past the cant the auto pass refuses', () => {
    const wedged = { x: 6, y: 0, z: 9.5 };
    assert.equal(bridge('stick', wedged), null, 'the auto pass still refuses it');

    const aimed = bridge('stick', wedged, true);
    assert.ok(aimed, 'a manual aim builds it');
    const angleDeg = shaftAngleDeg(aimed.entity);
    assert.ok(angleDeg > MAX_SHAFT_ANGLE_DEG,
        `and it really is past the stick gate (${angleDeg.toFixed(1)} > ${MAX_SHAFT_ANGLE_DEG})`);
});
