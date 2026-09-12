import assert from 'node:assert/strict';
import test from 'node:test';

import {
    addBranch,
    addKnot,
    addLeaf,
    addRoot,
    addSupportEntity,
    addTrunk,
    applySettingsToSupportTarget,
    getSnapshot,
    resetStore,
} from '../state';
import { EDITABLE_SUPPORT_TYPES, getSupportTypeDescriptor } from '../supportTypeRegistry';
import { createDefaultSettings } from '../Settings/types';
import { DEFAULT_TIP_PROFILE } from '../SupportPrimitives/ContactCone/types';
import type { Branch, Leaf, Trunk } from '../types';

/**
 * Writing sidebar settings onto the selected support.
 *
 * Pins what each editable type writes.
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
    profile: { ...DEFAULT_TIP_PROFILE },
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
    addRoot({
        id: 'root-k', modelId: MODEL,
        transform: { pos: { x: 5, y: 0, z: 0 }, rot: { x: 0, y: 0, z: 0, w: 1 } },
        diameter: 3, diskHeight: 0.5, coneHeight: 1.5,
    } as never);
    addSupportEntity('kickstand', {
        id: 'kickstand-a', modelId: MODEL, rootId: 'root-k',
        hostKnotId: 'knot-a', hostSegmentId: 'seg-ta',
        segments: [segment('seg-ka')],
    } as never);
}

/** Settings distinguishable from the defaults in every field this reads. */
function settings() {
    const base = createDefaultSettings();
    return {
        ...base,
        shaft: { ...base.shaft, diameterMm: 2.75 },
        tip: { ...base.tip, contactDiameterMm: 0.85, bodyDiameterMm: 1.9, lengthMm: 3.25, penetrationMm: 0.2 },
        roots: { ...base.roots, diameterMm: 6.5, diskHeightMm: 1.25, coneHeightMm: 2.5 },
    };
}

test('every editable type applies without falling through', () => {
    // The leaf branch used to be an unguarded fallthrough, so an unhandled kind
    // was silently written as a leaf.
    for (const descriptor of EDITABLE_SUPPORT_TYPES) {
        scene();
        assert.equal(
            applySettingsToSupportTarget({ kind: descriptor.id, id: `${descriptor.id}-a` }, settings() as never),
            true,
            `${descriptor.id} should apply`,
        );
    }
});


test('a missing entity or non-editable type applies nothing', () => {
    scene();
    assert.equal(applySettingsToSupportTarget({ kind: 'trunk', id: 'nope' }, settings() as never), false);
    assert.equal(applySettingsToSupportTarget({ kind: 'stick', id: 'stick-a' } as never, settings() as never), false);
});

