import assert from 'node:assert/strict';
import test from 'node:test';
import * as THREE from 'three';

import { addKnot, addRoot, addSupportEntity, getSnapshot, resetStore, subscribe, transformSupportsForModel } from '../state';
import type { Segment } from '../types';

/**
 * A kickstand stands on its own root and is reached by no edge, so it has to be
 * transformed by the same walk as every other type. These fix the behaviour that
 * walk owes: a kickstand on the moved model follows it, one hosted on the moved
 * model's graph follows it even when it names another model, and the whole
 * transform reaches subscribers as a single notification.
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

function addKickstand(id: string, x: number, modelId: string) {
    addRoot(root(`root-${id}`, x, modelId) as never);
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

test('a kickstand on the moved model follows it', () => {
    resetStore();
    addHostTrunk();
    addKickstand('probe', 6, MODEL);

    const result = transformSupportsForModel(MODEL, MIRROR_X.before, MIRROR_X.after);

    const moved = getSnapshot().kickstands.probe;
    assert.equal(moved.segments[0]?.bottomJoint?.pos.x, -6, 'the shaft follows the mirror');
    assert.equal(getSnapshot().knots['knot-probe'].pos.x, -6, 'the knot on that shaft follows too');
    assert.equal(result.kickstandsChanged, true, 'the commit reports the kickstand moved');
});

test('a kickstand on a moved root follows it while naming another model', () => {
    // Reached through the root the moved model owns, not through `modelId`: a
    // kickstand whose root belongs to the moved model travels with it.
    resetStore();
    addHostTrunk();
    addRoot(root('root-probe', 6, MODEL) as never);
    addSupportEntity('kickstand', {
        id: 'probe', modelId: OTHER, rootId: 'root-probe',
        hostKnotId: 'knot-host', hostSegmentId: 'seg-host', hostMinT: 0,
        segments: [segment('seg-probe', 6, 0, 36)],
        profile: { bodyDiameterMm: 1.2, terminalStartDiameterMm: 1.2, terminalEndDiameterMm: 1.2 },
    } as never);
    addKnot({
        id: 'knot-probe', parentShaftId: 'seg-probe', t: 0.5,
        pos: { x: 6, y: 0, z: 18 }, diameter: 1.3,
    } as never);

    const result = transformSupportsForModel(MODEL, MIRROR_X.before, MIRROR_X.after);

    assert.equal(
        getSnapshot().kickstands.probe.segments[0]?.bottomJoint?.pos.x,
        -6,
        'a kickstand on the moved model\'s root follows it whatever its own modelId says',
    );
    assert.equal(result.kickstandsChanged, true, 'the commit reports the kickstand moved');
});

test('a kickstand untouched by the transform stays put and is not reported', () => {
    resetStore();
    addHostTrunk();

    addRoot(root('root-far', 20, OTHER) as never);
    addSupportEntity('kickstand', {
        id: 'far', modelId: OTHER, rootId: 'root-far',
        hostKnotId: 'knot-far', hostSegmentId: 'seg-far', hostMinT: 0,
        segments: [segment('seg-far', 20, 0, 36)],
        profile: { bodyDiameterMm: 1.2, terminalStartDiameterMm: 1.2, terminalEndDiameterMm: 1.2 },
    } as never);
    addKnot({
        id: 'knot-far', parentShaftId: 'seg-far', t: 0.5,
        pos: { x: 20, y: 0, z: 18 }, diameter: 1.3,
    } as never);

    const before = getSnapshot().kickstands;
    const result = transformSupportsForModel(MODEL, MIRROR_X.before, MIRROR_X.after);

    assert.equal(getSnapshot().kickstands, before, 'the collection is not copied when nothing in it moved');
    assert.equal(result.kickstandsChanged, false, 'the commit reports no kickstand moved');
});

test('transforming a model with a kickstand notifies subscribers once', () => {
    resetStore();
    addHostTrunk();
    addKickstand('probe', 6, MODEL);

    let notifications = 0;
    const unsubscribe = subscribe(() => { notifications += 1; });
    transformSupportsForModel(MODEL, MIRROR_X.before, MIRROR_X.after);
    unsubscribe();

    assert.equal(notifications, 1, 'one transform is one store notification');
});
