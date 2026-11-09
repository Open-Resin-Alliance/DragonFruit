import assert from 'node:assert/strict';
import test from 'node:test';

import { collectProxyPrimitives } from '../SupportProxyMeshLayer';
import { addKnot, addRoot, addSupportEntity, getSnapshot, resetStore } from '../state';
import type { Kickstand, Knot, Roots } from '../types';

const MODEL_ID = 'model-1';
const HOST_DIAMETER = 1.1;
const BODY_DIAMETER = 2.1;

/** A kickstand whose terminal segment narrows into a thinner host. */
function seedKickstand(terminalEndDiameterMm: number): void {
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
        diameter: HOST_DIAMETER,
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
                id: 'seg-lower',
                diameter: BODY_DIAMETER,
                bottomJoint: { id: 'j-1', pos: { x: 0, y: 0, z: 0 }, diameter: 2.2 },
                topJoint: { id: 'j-2', pos: { x: 0, y: 0, z: 10 }, diameter: 2.2 },
            },
            {
                id: 'seg-terminal',
                diameter: BODY_DIAMETER,
                bottomJoint: { id: 'j-2', pos: { x: 0, y: 0, z: 10 }, diameter: 2.2 },
            },
        ],
        profile: {
            bodyDiameterMm: BODY_DIAMETER,
            terminalStartDiameterMm: BODY_DIAMETER,
            terminalEndDiameterMm,
        },
    } as unknown as Kickstand);
}

function shaftsOf(): { id: string; diameter: number; diameterEnd?: number }[] {
    const byModel = collectProxyPrimitives(getSnapshot(), {
        includeDetailedPrimitives: true,
        interiorSupportIdSet: null,
    });
    return byModel.get(MODEL_ID)?.shafts ?? [];
}

test('a kickstand terminal segment carries the width it narrows to', () => {
    seedKickstand(HOST_DIAMETER);
    const terminal = shaftsOf().find((shaft) => shaft.id === 'seg-terminal');

    assert.ok(terminal, 'the terminal segment is drawn');
    assert.equal(terminal.diameter, BODY_DIAMETER);
    assert.equal(terminal.diameterEnd, HOST_DIAMETER, 'so the proxy can taper it');
    resetStore();
});

test('a segment ending at a joint carries no taper', () => {
    seedKickstand(HOST_DIAMETER);
    const lower = shaftsOf().find((shaft) => shaft.id === 'seg-lower');

    assert.ok(lower, 'the lower segment is drawn');
    assert.equal(lower.diameterEnd, undefined, 'it stays in the instanced batch');
    resetStore();
});

test('a column as wide as its host is left uniform', () => {
    seedKickstand(BODY_DIAMETER);
    const terminal = shaftsOf().find((shaft) => shaft.id === 'seg-terminal');

    assert.ok(terminal);
    assert.equal(terminal.diameterEnd, BODY_DIAMETER, 'equal ends are not a taper');
    resetStore();
});
