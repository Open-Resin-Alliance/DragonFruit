import assert from 'node:assert/strict';
import test from 'node:test';

import { applySettingsToSupportTarget, addKnot, addRoot, addSupportEntity, getSnapshot, resetStore } from '../state';
import { createDefaultSettings } from '../Settings/types';
import { resolveShaftSegments } from '../SupportTypes/useShaftSegments';
import type { Kickstand, Knot, Roots } from '../types';

const MODEL_ID = 'model-1';
const HOST_KNOT_DIAMETER = 1.1;

function seedKickstand(bodyDiameterMm: number): void {
    resetStore();
    addRoot({
        id: 'root-1',
        modelId: MODEL_ID,
        transform: { pos: { x: 0, y: 0, z: 0 }, rot: { x: 0, y: 0, z: 0, w: 1 } },
        diameter: 2,
        diskHeight: 0.5,
        coneHeight: 1,
    } as Roots);
    addKnot({
        id: 'knot-1',
        parentShaftId: 'shaft-1',
        t: 0.25,
        pos: { x: 2, y: 0, z: 14 },
        diameter: HOST_KNOT_DIAMETER,
    } as Knot);
    addSupportEntity('kickstand', {
        id: 'kick-1',
        modelId: MODEL_ID,
        rootId: 'root-1',
        hostKnotId: 'knot-1',
        hostSegmentId: 'shaft-1',
        hostMinT: 0,
        segments: [
            {
                id: 'seg-1',
                diameter: bodyDiameterMm,
                bottomJoint: { id: 'j-1', pos: { x: 0, y: 0, z: 0 }, diameter: bodyDiameterMm },
                topJoint: { id: 'j-2', pos: { x: 0, y: 0, z: 10 }, diameter: bodyDiameterMm },
            },
            {
                id: 'seg-2',
                diameter: bodyDiameterMm,
                bottomJoint: { id: 'j-2', pos: { x: 0, y: 0, z: 10 }, diameter: bodyDiameterMm },
            },
        ],
        profile: {
            bodyDiameterMm,
            terminalStartDiameterMm: bodyDiameterMm,
            terminalEndDiameterMm: HOST_KNOT_DIAMETER,
        },
    } as unknown as Kickstand);
}

function terminalTaper(): { start?: number; end?: number; uniform: boolean } {
    const snapshot = getSnapshot();
    const kickstand = snapshot.kickstands['kick-1'];
    const shafts = resolveShaftSegments(kickstand as never, {
        root: snapshot.roots['root-1'],
        hostKnot: snapshot.knots['knot-1'],
    });
    const last = shafts[shafts.length - 1];
    return { start: last.diameterStart, end: last.diameterEnd, uniform: last.isUniformDiameter };
}

test('a resized kickstand still tapers into its host', () => {
    seedKickstand(1);
    assert.equal(terminalTaper().uniform, false, 'the seeded column already tapers');

    const settings = createDefaultSettings();
    settings.shaft.diameterMm = 2.1;
    assert.equal(applySettingsToSupportTarget({ kind: 'kickstand', id: 'kick-1' }, settings), true);

    const taper = terminalTaper();
    assert.equal(taper.start, 2.1, 'the taper starts at the new shaft width');
    assert.equal(taper.end, HOST_KNOT_DIAMETER, 'and still ends at the host');
    assert.equal(taper.uniform, false, 'so the terminal segment is not a cylinder');

    resetStore();
});
