import assert from 'node:assert/strict';
import test from 'node:test';

import {
    addSupportEntity,
    getSupportEntity,
    removeJointById,
    resetStore,
} from '../state';
import { JOINT_REMOVAL_TYPES, getSupportTypeDescriptor } from '../supportTypeRegistry';
import type { Segment } from '../types';

/**
 * Removing one joint merges the two segments it split.
 *
 * The shafted types and the one whose upper end is a knot share one body; these
 * pin what each does with the segment list and the entity it reports.
 */

const joint = (id: string, z: number) => ({ id, pos: { x: 0, y: 0, z }, diameter: 1 });

function segments(): Segment[] {
    return [
        { id: 's1', diameter: 1, bottomJoint: joint('j0', 0), topJoint: joint('j1', 5) },
        { id: 's2', diameter: 1, bottomJoint: joint('j1', 5), topJoint: joint('j2', 10) },
    ] as unknown as Segment[];
}

/** A minimal entity of `typeId`, carrying two segments split by `j1`. */
function seedShaft(typeId: string, id: string) {
    const descriptor = getSupportTypeDescriptor(typeId as never);
    const entity: Record<string, unknown> = {
        id,
        modelId: 'model-1',
        typeId,
        segments: segments(),
    };
    // Give the type whatever its declared edges name, so nothing resolves to
    // undefined on the way through.
    for (const edge of descriptor.edges) {
        entity[edge.field] = `${edge.field}-${id}`;
    }
    addSupportEntity(entity as never);
    return entity;
}

test('every joint-removal type merges its two segments into one', () => {
    // Every type declaring joint removal, from the flag.
    assert.ok(JOINT_REMOVAL_TYPES.length > 0, 'no type declares joint removal');

    for (const typeId of JOINT_REMOVAL_TYPES) {
        resetStore();
        const id = `${typeId}-1`;
        seedShaft(typeId, id);

        const result = removeJointById('j1');
        assert.ok(result, `${typeId}: the joint was not found`);
        assert.equal(result.typeId, typeId, `${typeId}: reported the wrong type`);
        assert.equal(result.id, id);

        const after = getSupportEntity(typeId, id) as unknown as { segments: Segment[] } | null;
        assert.equal(after?.segments.length, 1, `${typeId}: the segments did not merge`);
        assert.equal(
            after?.segments[0].topJoint?.id,
            'j2',
            `${typeId}: the merged segment kept the wrong top joint`,
        );
    }
});

test('an unknown joint id reports nothing', () => {
    resetStore();
    seedShaft(JOINT_REMOVAL_TYPES[0], 'e-1');
    assert.equal(removeJointById('no-such-joint'), null);
});

test('removing the last joint in a chain drops it rather than merging', () => {
    resetStore();
    const typeId = JOINT_REMOVAL_TYPES[0];
    seedShaft(typeId, 'e-1');

    const result = removeJointById('j2');
    assert.ok(result, 'the top joint was not found');

    const after = getSupportEntity(typeId, 'e-1') as unknown as { segments: Segment[] } | null;
    assert.equal(after?.segments.length, 2, 'a chain-end removal must not merge');
    assert.equal(after?.segments[1].topJoint, undefined, 'the top joint should be gone');
});
