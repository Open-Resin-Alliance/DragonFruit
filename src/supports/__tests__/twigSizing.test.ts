import assert from 'node:assert/strict';
import test from 'node:test';

import { buildTwig } from '../SupportTypes/Twig/twigBuilder';

test('twigs are cylindrical: slightly smaller than the tip contact, both ends equal', () => {
    const short = buildTwig({
        modelId: 'm',
        aPos: { x: 0, y: 0, z: 10 }, aNormal: { x: 0, y: 0, z: -1 },
        bPos: { x: 0, y: 0, z: 13 }, bNormal: { x: 0, y: 0, z: 1 },
    });
    const long = buildTwig({
        modelId: 'm',
        aPos: { x: 0, y: 0, z: 10 }, aNormal: { x: 0, y: 0, z: -1 },
        bPos: { x: 0, y: 0, z: 35 }, bNormal: { x: 0, y: 0, z: 1 },
    });

    assert.ok(!short.error && !long.error, 'twigs build');
    const shortSeg = short.twig.segments[0];
    const longSeg = long.twig.segments[0];
    const shortBottom = shortSeg.bottomJoint?.diameter ?? 0;
    const shortTop = shortSeg.topJoint?.diameter ?? 0;
    const longBottom = longSeg.bottomJoint?.diameter ?? 0;
    const longTop = longSeg.topJoint?.diameter ?? 0;

    // Host end: 0.9× the tip contact (0.3 default) → joints under 0.33.
    assert.ok(shortBottom < 0.3 * 1.1,
        `host end slightly smaller (${shortBottom.toFixed(3)})`);

    // Cylindrical: both ends equal on every span. An earlier change scaled
    // the free end with span, which accidentally rendered twigs as cones.
    assert.ok(Math.abs(shortTop - shortBottom) < 1e-9,
        `short twig ends equal (${shortTop.toFixed(3)} vs ${shortBottom.toFixed(3)})`);
    assert.ok(Math.abs(longTop - longBottom) < 1e-9,
        `long twig ends equal (${longTop.toFixed(3)} vs ${longBottom.toFixed(3)})`);
    assert.ok(Math.abs(longTop - shortTop) < 1e-9,
        'diameter is span-independent');
});
