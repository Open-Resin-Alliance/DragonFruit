import assert from 'node:assert/strict';
import test from 'node:test';
import * as THREE from 'three';

import '../state';
import { addKnot, addRoot, addSupportEntity, getSnapshot, recomputeKnotDependentGeometry, resetStore } from '../state';
import { getSupportTypeDescriptor, knotHostId, SUPPORT_COLLECTION_KEYS, SUPPORT_TYPES, updateSupportEntity } from '../supportTypeRegistry';
import { supportSettleFor, typesWithSettleHook } from '../settle/seam';
import { recomputeLeafPreviewContactCone } from '../SupportTypes/Leaf/leafPreviewCone';
import { getFinalSocketPosition } from '../SupportPrimitives/ContactCone/contactConeUtils';
import { calculateDiskThickness } from '../SupportPrimitives/ContactDisk/contactDiskUtils';
import { syncContactConeDiameters } from '../autoSupport/autoPlace';
import { clearSDFCacheForMesh, getOrCreateSDFCache } from '../PlacementLogic/Pathfinding/SDFCachePool';
import { accelerateGeometry, initializeBVH } from '../../utils/bvh';
import type { ContactCone } from '../SupportPrimitives/ContactCone/types';
import type { Knot, Leaf, SupportState, Vec3 } from '../types';

/**
 * The settle seam, and the write-path bug routing leaf through it exposed.
 *
 * `applySupportEntityUpdate` wrote the entity's own collection and then the
 * generic `knots` / `leaves` defaults over the top. For a type whose collection
 * IS `leaves` -- leaf -- the later `leaves:` won, so
 * `updateSupportEntity('leaf', entity)` kept the PRE-write leaves and returned
 * true. Nothing caught it because leaf had a bespoke updater that never took this
 * path; moving that body behind the seam is what reached it.
 */

const vec = (x: number, y: number, z: number): Vec3 => ({ x, y, z });

const ROOT_ID = 'settle-root';
const KNOT_ID = 'settle-knot';

const cone = (pos: Vec3): ContactCone => ({
    id: 'settle-cone',
    pos,
    normal: vec(0, 0, -1),
    surfaceNormal: vec(0, 0, -1),
    profile: { type: 'cone', lengthMm: 2, contactDiameterMm: 0.3, bodyDiameterMm: 0.8 },
} as unknown as ContactCone);

function seedLeaf(): void {
    resetStore();
    addRoot({
        id: ROOT_ID,
        modelId: 'model-a',
        transform: { pos: vec(0, 0, 10), rotation: vec(0, 0, 0), scale: vec(1, 1, 1) },
        diameter: 3,
        diskHeight: 1,
        coneHeight: 2,
    } as never);
    // The knot has to be a real cone host for the leaf's cascade to reach it:
    // the pass reads the pseudo-shaft id, which is the prefix the leaf type
    // declares, so it is built rather than spelled.
    addKnot({
        id: KNOT_ID,
        parentShaftId: knotHostId('leaf', 'leaf-1'),
        pos: vec(0, 0, 20),
        diameter: 1.4,
    } as never);
    addSupportEntity('leaf', {
        id: 'leaf-1',
        modelId: 'model-a',
        parentKnotId: KNOT_ID,
        contactCone: cone(vec(1, 2, 3)),
    } as never);
}

test('a write to the leaves collection is not overwritten by the generic leaf default', () => {
    seedLeaf();
    const stored = getSnapshot().leaves['leaf-1'];
    const moved = { ...stored, contactCone: { ...stored.contactCone, pos: vec(9, 9, 9) } };

    assert.equal(updateSupportEntity('leaf', moved), true, 'the write reports success');
    assert.equal(
        getSnapshot().leaves['leaf-1'].contactCone.pos.x,
        9,
        'and the entity it was handed is the one stored -- not the pre-write leaves',
    );
});

test('every type writes to its own collection, whichever collection that is', () => {
    // The bug was collection-specific: it only fired when a type's own collection
    // shared a name with one of the generic settle defaults. That is `leaves`
    // today, and this holds the property rather than the name.
    seedLeaf();
    const descriptor = getSupportTypeDescriptor('leaf');
    assert.equal(descriptor.location.key, 'leaves', 'fixture: leaf writes to `leaves`');

    const before = getSnapshot();
    const storedBefore = before.leaves['leaf-1'];
    updateSupportEntity('leaf', { ...storedBefore, contactCone: cone(vec(4, 4, 4)) } as never);
    const after = getSnapshot();
    assert.notEqual(after.leaves['leaf-1'], storedBefore, 'the collection holds a new entity object');
});

test('the settle hooks that exist are the two types that need a different order', () => {
    assert.deepEqual(
        [...typesWithSettleHook()].sort(),
        ['brace', 'leaf'],
        'a hook is for the types whose cascade differs from the generic one',
    );
});

test('a type with no settle hook is written by the generic path alone', () => {
    // The complement of the hooked types, walked off the registry rather than
    // listed: the two types that declare a hook are pinned above, so every OTHER
    // declared type has to settle to nothing. A type added later is covered by
    // being declared, not by being remembered here.
    const hooked = new Set(typesWithSettleHook());
    for (const descriptor of SUPPORT_TYPES) {
        if (hooked.has(descriptor.id)) continue;
        assert.equal(supportSettleFor(descriptor.id), null, `${descriptor.id} should settle to nothing`);
    }
});

test('a leaf write settles the knots rather than leaving them untouched', () => {
    // The leaf's cascade is the reason it has a hook at all: its contact cone
    // sits on the model while its knot rides a host shaft, so writing a leaf
    // moves the knot. A hook that returned nothing would pass every assertion
    // above while silently dropping the cascade.
    seedLeaf();
    const stored = getSnapshot().leaves['leaf-1'];
    const coneMoved = { ...stored, contactCone: { ...stored.contactCone, pos: vec(30, 30, 30) } };

    const knotsBefore = getSnapshot().knots;
    updateSupportEntity('leaf', coneMoved);
    const knotsAfter = getSnapshot().knots;

    assert.notEqual(knotsAfter, knotsBefore, 'the knot collection was rewritten by the settle pass');
});

function emptySupportState(): SupportState {
    const state = {} as Record<string, Record<string, unknown>>;
    for (const key of SUPPORT_COLLECTION_KEYS) state[key] = {};
    return state as unknown as SupportState;
}

test('recomputeKnotDependentGeometry and host settle clear stale diskLengthOverride on uncollided leaf and pin socket', () => {
    resetStore();
    addRoot({
        id: 'settle-trunk-root',
        modelId: 'model-a',
        transform: { pos: vec(0, 0, 0), rot: { x: 0, y: 0, z: 0, w: 1 } },
        diameter: 3,
        diskHeight: 1,
        coneHeight: 2,
    } as never);
    addSupportEntity('trunk', {
        id: 'settle-trunk',
        modelId: 'model-a',
        rootId: 'settle-trunk-root',
        segments: [{
            id: 'settle-seg',
            diameter: 1.4,
            bottomJoint: { id: 'bj', pos: vec(0, 0, 3), diameter: 1.5 },
            topJoint: { id: 'tj', pos: vec(0, 0, 15), diameter: 1.5 },
        }],
    } as never);
    addKnot({
        id: 'settle-host-knot',
        parentShaftId: 'settle-seg',
        t: 0.5,
        pos: vec(0, 0, 9),
        diameter: 1.5,
    } as never);
    const staleCone: ContactCone = {
        id: 'disk-cone',
        pos: vec(1.5, 0, 11),
        normal: vec(-0.5, 0, -0.8660254),
        surfaceNormal: vec(0, 0, -1),
        diskLengthOverride: 0.32,
        profile: {
            type: 'disk',
            contactDiameterMm: 0.4,
            bodyDiameterMm: 1.0,
            lengthMm: 2.5,
            penetrationMm: 0.05,
            diskThicknessMm: 0.1,
            maxStandoffMm: 1.5,
            standoffAngleThreshold: Math.PI / 4,
        },
    };
    addSupportEntity('leaf', {
        id: 'settle-disk-leaf',
        modelId: 'model-a',
        parentKnotId: 'settle-host-knot',
        contactCone: staleCone,
    } as never);

    const movedKnotPos = vec(0.4, 0.2, 8.6);
    const directUpdated = recomputeKnotDependentGeometry(
        getSnapshot().leaves,
        { 'settle-host-knot': movedKnotPos },
    )['settle-disk-leaf'];

    assert.equal(directUpdated.contactCone.diskLengthOverride, undefined);
    const directSocket = getFinalSocketPosition(directUpdated.contactCone);
    const directErr = Math.hypot(
        directSocket.x - movedKnotPos.x,
        directSocket.y - movedKnotPos.y,
        directSocket.z - movedKnotPos.z,
    );
    assert.ok(directErr < 1e-5, `expected socket pinned within 1e-5, got ${directErr}`);

    const trunk = getSnapshot().trunks['settle-trunk'];
    updateSupportEntity('trunk', {
        ...trunk,
        segments: [{
            ...trunk.segments[0],
            bottomJoint: { id: 'bj', pos: vec(0.5, 0, 3), diameter: 1.5 },
            topJoint: { id: 'tj', pos: vec(0.5, 0, 15), diameter: 1.5 },
        }],
    });
    const settledLeaf = getSnapshot().leaves['settle-disk-leaf'];
    const settledKnot = getSnapshot().knots['settle-host-knot'];
    assert.equal(settledLeaf.contactCone.diskLengthOverride, undefined);
    const settledSocket = getFinalSocketPosition(settledLeaf.contactCone);
    const settledErr = Math.hypot(
        settledSocket.x - settledKnot.pos.x,
        settledSocket.y - settledKnot.pos.y,
        settledSocket.z - settledKnot.pos.z,
    );
    assert.ok(settledErr < 1e-5, `expected trunk settle socket pinned within 1e-5, got ${settledErr}`);
});

test('recomputeLeafPreviewContactCone clears stale diskLengthOverride when updating preview cone', () => {
    const leaf: Leaf = {
        id: 'preview-leaf',
        modelId: 'model-a',
        parentKnotId: 'preview-knot',
        contactCone: {
            id: 'preview-cone',
            pos: vec(1, 2, 10),
            normal: vec(0, 0, -1),
            surfaceNormal: vec(0, 0, -1),
            diskLengthOverride: 0.32,
            profile: {
                type: 'disk',
                contactDiameterMm: 0.4,
                bodyDiameterMm: 1.2,
                lengthMm: 3,
                penetrationMm: 0.05,
                diskThicknessMm: 0.1,
                maxStandoffMm: 1.5,
                standoffAngleThreshold: Math.PI / 4,
            },
        },
    };
    const previewKnot: Knot = {
        id: 'preview-knot',
        parentShaftId: 'missing-seg',
        pos: vec(1.8, 2.2, 7.5),
        diameter: 1.4,
    };

    const updated = recomputeLeafPreviewContactCone(leaf, previewKnot, new Map());
    assert.equal(updated.contactCone.diskLengthOverride, undefined);
    const socket = getFinalSocketPosition(updated.contactCone);
    const err = Math.hypot(
        socket.x - previewKnot.pos.x,
        socket.y - previewKnot.pos.y,
        socket.z - previewKnot.pos.z,
    );
    assert.ok(err < 1e-5, `expected preview socket pinned within 1e-5, got ${err}`);
});

test('syncContactConeDiameters preserves socket when widening contactDiameterMm and updates diskLengthOverride', () => {
    const buildDraftWithTrunk = (overrides: { maxStandoffMm: number; diskLengthOverride?: number }) => {
        const draft = emptySupportState();
        draft.roots['r1'] = {
            id: 'r1',
            modelId: 'model-a',
            transform: { pos: vec(0, 0, 0), rot: { x: 0, y: 0, z: 0, w: 1 } },
            diameter: 3,
            diskHeight: 1,
            coneHeight: 2,
        };
        const cone: ContactCone = {
            id: 'cone-t1',
            pos: vec(0, 0, 10),
            normal: vec(0.5, 0, -0.8660254),
            surfaceNormal: vec(0, 0, -1),
            diskLengthOverride: overrides.diskLengthOverride,
            profile: {
                type: 'disk',
                contactDiameterMm: 0.30,
                bodyDiameterMm: 0.8,
                lengthMm: 2.5,
                penetrationMm: 0.05,
                diskThicknessMm: 0.1,
                maxStandoffMm: overrides.maxStandoffMm,
                standoffAngleThreshold: Math.PI / 4,
            },
        };
        draft.trunks['t1'] = {
            id: 't1',
            modelId: 'model-a',
            rootId: 'r1',
            segments: [{
                id: 'seg-1',
                diameter: 1.76,
                bottomJoint: { id: 'bj', pos: vec(0, 0, 3), diameter: 1.86 },
                topJoint: { id: 'tj', pos: getFinalSocketPosition(cone), diameter: 1.86 },
            }],
            contactCone: cone,
        };
        return draft;
    };

    const uncollidedDraft = buildDraftWithTrunk({ maxStandoffMm: 1.5, diskLengthOverride: 0.32 });
    const uncollidedPreSocket = getFinalSocketPosition(uncollidedDraft.trunks['t1'].contactCone!);
    const uncollidedSynced = syncContactConeDiameters(uncollidedDraft, 'model-a');
    const uncollidedCone = uncollidedSynced.trunks['t1'].contactCone!;

    assert.ok(Math.abs(uncollidedCone.profile.contactDiameterMm - 0.44) < 1e-9);
    assert.equal(uncollidedCone.diskLengthOverride, undefined);
    const uncollidedPostSocket = getFinalSocketPosition(uncollidedCone);
    const uncollidedErr = Math.hypot(
        uncollidedPostSocket.x - uncollidedPreSocket.x,
        uncollidedPostSocket.y - uncollidedPreSocket.y,
        uncollidedPostSocket.z - uncollidedPreSocket.z,
    );
    assert.ok(uncollidedErr < 1e-5, `expected uncollided socket drift < 1e-5, got ${uncollidedErr}`);

    initializeBVH();
    const geom = new THREE.BoxGeometry(20, 20, 0.1);
    accelerateGeometry(geom);
    const mesh = new THREE.Mesh(geom, new THREE.MeshBasicMaterial());
    mesh.position.set(0, 0, 9.8);
    mesh.updateMatrixWorld(true);

    try {
        getOrCreateSDFCache(mesh);
        const collidingDraft = buildDraftWithTrunk({ maxStandoffMm: 1.6 });
        const collidingPreSocket = getFinalSocketPosition(collidingDraft.trunks['t1'].contactCone!);
        const collidingSynced = syncContactConeDiameters(collidingDraft, 'model-a', undefined, mesh);
        const collidingCone = collidingSynced.trunks['t1'].contactCone!;

        assert.ok(Math.abs(collidingCone.profile.contactDiameterMm - 0.44) < 1e-9);
        if (collidingCone.profile.type !== 'disk') {
            assert.fail('expected disk profile');
        }
        const angleThickness = calculateDiskThickness(
            collidingCone.surfaceNormal!,
            collidingCone.normal,
            collidingCone.profile,
        );
        assert.ok(collidingCone.diskLengthOverride !== undefined);
        assert.ok(collidingCone.diskLengthOverride > angleThickness);
        const collidingPostSocket = getFinalSocketPosition(collidingCone);
        const collidingErr = Math.hypot(
            collidingPostSocket.x - collidingPreSocket.x,
            collidingPostSocket.y - collidingPreSocket.y,
            collidingPostSocket.z - collidingPreSocket.z,
        );
        assert.ok(collidingErr < 1e-5, `expected colliding socket drift < 1e-5, got ${collidingErr}`);
    } finally {
        clearSDFCacheForMesh(mesh.uuid);
    }
});
