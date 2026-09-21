import assert from 'node:assert/strict';
import test from 'node:test';

import {
    FLEXING_KNOT_HOST_TYPES,
    getSupportTypeDescriptor,
    SUPPORT_TYPES,
} from '../supportTypeRegistry';
import { applySolvedJoints } from '../SupportPrimitives/Knot/elasticShaftPreview';
import type { Segment } from '../types';

/**
 * Which shafts flex when their host knot is dragged.
 *
 * Both the flexing types and each one's contact field are declared, so a second
 * flexing type is captured and keeps its tip constraint.
 */

test('every flexing type declares the knot edge the capture filters on', () => {
    assert.ok(FLEXING_KNOT_HOST_TYPES.length > 0, 'no flexing type declared');
    for (const { typeId, knotFields } of FLEXING_KNOT_HOST_TYPES) {
        assert.ok(
            knotFields.length > 0,
            `${typeId} flexes on a host knot but declares no hostedBy edge onto knots; `
            + 'the capture would never find it',
        );
    }
});

test('a flexing type has segments for the solver to bend', () => {
    // The solver walks segment joints. A type with none would capture an empty
    // chain and contribute nothing, which is a declaration mistake, not a shape.
    for (const { typeId } of FLEXING_KNOT_HOST_TYPES) {
        assert.equal(
            getSupportTypeDescriptor(typeId).hasSegments,
            true,
            `${typeId} declares flexesOnHostKnotDrag but has no segments`,
        );
    }
});

test('the flexing list is derived from the flag, for every type', () => {
    // Pins the derivation itself: declaring the flag on a new type must be the
    // only edit needed to bring it into the capture.
    const declared = SUPPORT_TYPES
        .filter((descriptor) => descriptor.flexesOnHostKnotDrag)
        .map((descriptor) => descriptor.id);
    assert.deepEqual(FLEXING_KNOT_HOST_TYPES.map((entry) => entry.typeId), declared);
});

test('a flexing type names the contact field the capture reads', () => {
    // The capture reads `upper.field` rather than one spelling, because the
    // types do not agree on one. A cone endpoint must name its field.
    for (const { typeId } of FLEXING_KNOT_HOST_TYPES) {
        const upper = getSupportTypeDescriptor(typeId).upper;
        if (upper.kind === 'knot') continue;
        assert.ok(
            upper.field,
            `${typeId}'s upper endpoint is a ${upper.kind} but names no field; `
            + 'the elastic tip constraint would be dropped',
        );
    }
});

function segmentWithJoints(topZ: number, bottomZ: number): Segment {
    return {
        id: 'seg-1',
        topJoint: { id: 'top', pos: { x: 0, y: 0, z: topZ } },
        bottomJoint: { id: 'bottom', pos: { x: 0, y: 0, z: bottomZ } },
    } as unknown as Segment;
}

test('applySolvedJoints reports no change when nothing moved', () => {
    // The three call sites branch on null to decide whether to write a preview
    // override at all, so "unchanged" must be distinguishable from "changed".
    const segments = [segmentWithJoints(10, 0)];
    const result = applySolvedJoints(segments, {
        knotPos: { x: 0, y: 0, z: 0 },
        jointPositions: { top: { x: 0, y: 0, z: 10 }, bottom: { x: 0, y: 0, z: 0 } },
        isLocked: false,
    });
    assert.equal(result, null);
});

test('applySolvedJoints writes moved joints without mutating the input', () => {
    const segments = [segmentWithJoints(10, 0)];
    const result = applySolvedJoints(segments, {
        knotPos: { x: 0, y: 0, z: 0 },
        jointPositions: { top: { x: 0, y: 0, z: 25 }, bottom: { x: 0, y: 0, z: 0 } },
        isLocked: false,
    });
    assert.ok(result, 'a moved joint must produce new segments');
    assert.equal(result[0].topJoint?.pos.z, 25);
    assert.equal(segments[0].topJoint?.pos.z, 10, 'the captured segments were mutated');
});
