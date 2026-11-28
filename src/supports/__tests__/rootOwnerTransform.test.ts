import assert from 'node:assert/strict';
import test from 'node:test';
import * as THREE from 'three';

import { addKnot, addRoot, addSupportEntity, getSnapshot, resetStore, subscribe, transformSupportsForModel } from '../state';
import type { Segment } from '../types';

/**
 * A root-owning type reached by no edge travels with the root it owns, not with
 * its own `modelId`, and the whole transform reaches subscribers once. Kickstand
 * is the only such type, so it is what exercises both rules.
 */

const MODEL = 'model-1';
const OTHER = 'model-2';

const joint = (id: string, x: number, z: number) => ({ id, pos: { x, y: 0, z }, diameter: 1.3 });
const segment = (id: string, x: number, bottomZ: number, topZ: number): Segment => ({
    id,
    type: 'straight',
    diameter: 1.2,
    bottomJoint: joint(`${id}-bottom`, x, bottomZ),
    topJoint: joint(`${id}-top`, x, topZ),
});
const root = (id: string, x: number, modelId = MODEL) => ({
    id,
    modelId,
    transform: { pos: { x, y: 0, z: 0 }, rot: { x: 0, y: 0, z: 0, w: 1 } },
    diameter: 2,
    diskHeight: 0.5,
    coneHeight: 1,
});

/** A trunk on the moved model, with a knot a kickstand can be hosted on. */
function addHostTrunk() {
    addRoot(root('root-host', 0) as never);
    addSupportEntity('trunk', {
        id: 'host', modelId: MODEL, rootId: 'root-host',
        segments: [segment('seg-host', 0, 0, 40)],
    } as never);
    addKnot({
        id: 'knot-host', parentShaftId: 'seg-host', t: 0.9,
        pos: { x: 0, y: 0, z: 36 }, diameter: 1.2,
    } as never);
}

function addKickstand(id: string, x: number, modelId: string, rootModelId = modelId) {
    addRoot(root(`root-${id}`, x, rootModelId) as never);
    addSupportEntity('kickstand', {
        id, modelId, rootId: `root-${id}`,
        hostKnotId: 'knot-host', hostSegmentId: 'seg-host', hostMinT: 0,
        segments: [segment(`seg-${id}`, x, 0, 36)],
        profile: { bodyDiameterMm: 1.2, terminalStartDiameterMm: 1.2, terminalEndDiameterMm: 1.2 },
    } as never);
    addKnot({
        id: `knot-${id}`, parentShaftId: `seg-${id}`, t: 0.5,
        pos: { x, y: 0, z: 18 }, diameter: 1.3,
    } as never);
}

const MIRROR_X = {
    before: { position: new THREE.Vector3(0, 0, 0), rotation: new THREE.Euler(), scale: new THREE.Vector3(1, 1, 1) },
    after: { position: new THREE.Vector3(0, 0, 0), rotation: new THREE.Euler(), scale: new THREE.Vector3(-1, 1, 1) },
};

test('a root owner follows the model owning its root, whatever its own modelId says', () => {
    resetStore();
    addHostTrunk();
    addKickstand('probe', 6, OTHER, MODEL);

    transformSupportsForModel(MODEL, MIRROR_X.before, MIRROR_X.after);

    assert.equal(getSnapshot().kickstands.probe.segments[0]?.bottomJoint?.pos.x, -6);
});

test('one transform is one store notification', () => {
    resetStore();
    addHostTrunk();
    addKickstand('probe', 6, MODEL);

    let notifications = 0;
    const unsubscribe = subscribe(() => { notifications += 1; });
    transformSupportsForModel(MODEL, MIRROR_X.before, MIRROR_X.after);
    unsubscribe();

    assert.equal(notifications, 1);
});
