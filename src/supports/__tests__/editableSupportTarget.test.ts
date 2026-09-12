import assert from 'node:assert/strict';
import test from 'node:test';

import {
    addBranch,
    addKnot,
    addLeaf,
    addRoot,
    addTrunk,
    resetStore,
    resolveEditableSupportTarget,
} from '../state';
import { EDITABLE_SUPPORT_TYPES, isEditableSupportType, SUPPORT_TYPES } from '../supportTypeRegistry';
import { DEFAULT_TIP_PROFILE } from '../SupportPrimitives/ContactCone/types';
import type { Branch, Leaf, Trunk } from '../types';

/**
 * Resolving a selected primitive back to the support whose settings it edits.
 *
 * This walked trunks, branches and leaves in three duplicated loops per
 * category. It now walks EDITABLE_SUPPORT_TYPES, so a type gains sidebar
 * editing by declaring `hasEditableSettings` -- and a type that declares it
 * without being handled here would silently resolve to null.
 */

const MODEL = 'model-a';

const segment = (id: string) => ({
    id,
    diameter: 1,
    bottomJoint: { id: `${id}-bj`, pos: { x: 0, y: 0, z: 0 }, diameter: 1 },
    topJoint: { id: `${id}-tj`, pos: { x: 0, y: 0, z: 4 }, diameter: 1 },
});

const cone = (id: string) => ({
    id,
    socketJointId: `${id}-socket`,
    pos: { x: 0, y: 0, z: 4 },
    normal: { x: 0, y: 0, z: 1 },
    surfaceNormal: { x: 0, y: 0, z: 1 },
    diameter: 1,
    height: 1,
    profile: DEFAULT_TIP_PROFILE,
});

function scene() {
    resetStore();
    addRoot({
        id: 'root-a', modelId: MODEL,
        transform: { pos: { x: 0, y: 0, z: 0 }, rot: { x: 0, y: 0, z: 0, w: 1 } },
        diameter: 3, diskHeight: 0.5, coneHeight: 1.5,
    } as never);
    addTrunk({
        id: 'trunk-a', modelId: MODEL, rootId: 'root-a',
        segments: [segment('seg-ta')], contactCone: cone('cone-ta'),
    } as unknown as Trunk);
    addKnot({ id: 'knot-a', parentShaftId: 'seg-ta', t: 0.5, pos: { x: 0, y: 0, z: 2 }, diameter: 1 } as never);
    addBranch({
        id: 'branch-a', modelId: MODEL, parentKnotId: 'knot-a',
        segments: [segment('seg-ba')], contactCone: cone('cone-ba'),
    } as unknown as Branch);
    addLeaf({ id: 'leaf-a', modelId: MODEL, parentKnotId: 'knot-a', contactCone: cone('cone-la') } as unknown as Leaf);
}

test('a selected support resolves to itself', () => {
    scene();
    for (const descriptor of EDITABLE_SUPPORT_TYPES) {
        const id = `${descriptor.id}-a`;
        assert.deepEqual(
            resolveEditableSupportTarget(id, descriptor.selectionCategory as never),
            { kind: descriptor.id, id },
        );
    }
});

test('a root resolves to the trunk that owns it', () => {
    scene();
    assert.deepEqual(resolveEditableSupportTarget('root-a', 'root'), { kind: 'trunk', id: 'trunk-a' });
});

test('a segment resolves to its owner, trunk or branch', () => {
    scene();
    assert.deepEqual(resolveEditableSupportTarget('seg-ta', 'segment'), { kind: 'trunk', id: 'trunk-a' });
    assert.deepEqual(resolveEditableSupportTarget('seg-ba', 'segment'), { kind: 'branch', id: 'branch-a' });
});

test('a joint resolves through segments and through contact sockets', () => {
    scene();
    assert.deepEqual(resolveEditableSupportTarget('seg-ta-tj', 'joint'), { kind: 'trunk', id: 'trunk-a' });
    assert.deepEqual(resolveEditableSupportTarget('seg-ba-bj', 'joint'), { kind: 'branch', id: 'branch-a' });
    assert.deepEqual(resolveEditableSupportTarget('cone-ta-socket', 'joint'), { kind: 'trunk', id: 'trunk-a' });
});

test('a contact disk resolves to whichever type owns it', () => {
    // The field is named differently per type, so this reads contactFields
    // rather than knowing that trunks and branches call theirs contactCone.
    scene();
    assert.deepEqual(resolveEditableSupportTarget('cone-ta', 'contactDisk'), { kind: 'trunk', id: 'trunk-a' });
    assert.deepEqual(resolveEditableSupportTarget('cone-ba', 'contactDisk'), { kind: 'branch', id: 'branch-a' });
    assert.deepEqual(resolveEditableSupportTarget('cone-la', 'contactDisk'), { kind: 'leaf', id: 'leaf-a' });
});

test('a knot resolves to the shaft hosting it, trunk before branch', () => {
    scene();
    // knot-a sits on the trunk's segment; branch-a also references it as its
    // parent. Trunk wins because it comes first in registry order.
    assert.deepEqual(resolveEditableSupportTarget('knot-a', 'knot'), { kind: 'trunk', id: 'trunk-a' });
});

test('an unknown id resolves to nothing', () => {
    scene();
    assert.equal(resolveEditableSupportTarget('nope', 'segment'), null);
    assert.equal(resolveEditableSupportTarget(null, 'trunk'), null);
});

test('the editable set is exactly the types declaring editable settings', () => {
    assert.deepEqual(
        EDITABLE_SUPPORT_TYPES.map((descriptor) => descriptor.id),
        SUPPORT_TYPES.filter((descriptor) => descriptor.hasEditableSettings).map((descriptor) => descriptor.id),
    );
    assert.ok(isEditableSupportType('trunk'));
    assert.ok(!isEditableSupportType('stick'));
});
