import assert from 'node:assert/strict';
import test from 'node:test';

import { addKnot, addRoot, addSupportEntity, getSnapshot, resetStore } from '../state';
import { updateSupportEntity } from '../supportTypeRegistry';
import type { Joint, Segment, Vec3 } from '../types';

/**
 * A knot riding a kickstand's shaft follows the kickstand when it moves.
 *
 * A kickstand declares `lower.kind: 'plateRoot'` and `upper.kind: 'knot'`, and
 * holds its host in `hostKnotId`. Its hosts must therefore be read off the
 * declared edges: gating on `lower.kind` hands it no knot, and its last segment
 * -- the one with no top joint, ending at that knot -- then resolves to nothing.
 *
 * This pins the observable result: the knot ends up on the moved shaft.
 */

const vec = (x: number, y: number, z: number): Vec3 => ({ x, y, z });

const ROOT_ID = 'ks-root';
const TRUNK_ID = 'ks-trunk';
const HOST_KNOT_ID = 'ks-host-knot';
const KICKSTAND_ID = 'ks-1';
const RIDING_KNOT_ID = 'ks-riding-knot';

const joint = (id: string, pos: Vec3): Joint => ({ id, pos, diameter: 1.2 });

/**
 * A kickstand shaped like the store builds them: a segment rising from the
 * root, then one that ends at the host knot with no top joint.
 */
const segmentsFrom = (baseZ: number): Segment[] => [
    {
        id: 'ks-seg-0',
        type: 'straight',
        diameter: 1.2,
        bottomJoint: joint('ks-j0', vec(0, 0, baseZ)),
        topJoint: joint('ks-j1', vec(0, 0, baseZ + 4)),
    },
    {
        id: 'ks-seg-1',
        type: 'straight',
        diameter: 1.2,
        bottomJoint: joint('ks-j1', vec(0, 0, baseZ + 4)),
    },
];

function seed(): void {
    resetStore();
    addRoot({
        id: ROOT_ID,
        modelId: 'model-a',
        transform: { pos: vec(0, 0, 0), rotation: vec(0, 0, 0), scale: vec(1, 1, 1) },
        diameter: 3,
        diskHeight: 1,
        coneHeight: 2,
    } as never);
    // The knot a kickstand braces against lives on another support's shaft, so
    // the fixture gives it one: a knot with no `parentShaftId` is malformed, and
    // a real one always rides something.
    addSupportEntity('trunk', {
        id: TRUNK_ID,
        modelId: 'model-a',
        rootId: ROOT_ID,
        segments: [
            {
                id: 'trunk-seg-0',
                type: 'straight',
                diameter: 1.2,
                bottomJoint: joint('trunk-j0', vec(0, 0, 3)),
                topJoint: joint('trunk-j1', vec(0, 0, 20)),
            },
        ],
    } as never);
    addKnot({
        id: HOST_KNOT_ID,
        parentShaftId: 'trunk-seg-0',
        pos: vec(0, 0, 20),
        diameter: 1.4,
        t: 1,
    } as never);

    addSupportEntity('kickstand', {
        id: KICKSTAND_ID,
        modelId: 'model-a',
        rootId: ROOT_ID,
        hostKnotId: HOST_KNOT_ID,
        segments: segmentsFrom(0),
    } as never);

    // A knot riding the second segment, halfway along it.
    addKnot({
        id: RIDING_KNOT_ID,
        parentShaftId: 'ks-seg-1',
        pos: vec(0, 0, 12),
        t: 0.5,
    } as never);
}

/** Shift every joint of the kickstand, and its host knot, by +5mm in x. */
function moveByFive(): void {
    const shift = (p: Vec3): Vec3 => ({ x: p.x + 5, y: p.y, z: p.z });

    const kickstand = getSnapshot().kickstands[KICKSTAND_ID];
    const moved = kickstand.segments.map((segment) => ({
        ...segment,
        ...(segment.bottomJoint
            ? { bottomJoint: { ...segment.bottomJoint, pos: shift(segment.bottomJoint.pos) } }
            : {}),
        ...(segment.topJoint
            ? { topJoint: { ...segment.topJoint, pos: shift(segment.topJoint.pos) } }
            : {}),
    }));

    // The host knot moves with it, FIRST: the second segment ends at that knot,
    // so placing the riding knot reads where the knot has got to. Moving it after
    // the update would place the knot against the knot's old position.
    const host = getSnapshot().knots[HOST_KNOT_ID];
    host.pos = shift(host.pos);

    updateSupportEntity('kickstand', { ...kickstand, segments: moved });
}

test('a knot riding a kickstand segment moves with the kickstand', () => {
    seed();

    const before = getSnapshot().knots[RIDING_KNOT_ID].pos;
    assert.deepEqual(before, vec(0, 0, 12), 'fixture: the riding knot starts on the shaft');

    moveByFive();

    const after = getSnapshot().knots[RIDING_KNOT_ID].pos;
    assert.equal(
        after.x,
        5,
        'the knot was left behind when the kickstand moved',
    );
    assert.equal(after.z, 12, 'the knot stayed on the segment it rides');
});

test('the same knot is positioned correctly before anything moves', () => {
    // The guard against "it moved" passing for the wrong reason: the rule must
    // already place this knot on the segment it rides, so a later move is a
    // move rather than a first placement.
    seed();

    const kickstand = getSnapshot().kickstands[KICKSTAND_ID];
    updateSupportEntity('kickstand', { ...kickstand });

    const pos = getSnapshot().knots[RIDING_KNOT_ID].pos;
    assert.equal(pos.x, 0, 'the knot sits on the shaft in x');
    assert.equal(pos.z, 12, 'the knot sits halfway along the second segment');
});
