import assert from 'node:assert/strict';
import test from 'node:test';
import * as THREE from 'three';

import { addKnot, addRoot, addSupportEntity, getSnapshot, resetStore, transformSupportsForModel } from '../state';
import { SUPPORT_TYPES } from '../supportTypeRegistry';
import type { Segment } from '../types';

/**
 * A knot rides a segment, so a shaft the model moves has to claim its own
 * segments or the knots on them stay where the model used to be.
 */

const MODEL = 'model-1';
const joint = (id: string, x: number, z: number) => ({ id, pos: { x, y: 0, z }, diameter: 1.3 });
const segment = (id: string, x: number, bottomZ: number, topZ: number): Segment => ({
    id,
    type: 'straight',
    diameter: 1.2,
    bottomJoint: joint(`${id}-bottom`, x, bottomZ),
    topJoint: joint(`${id}-top`, x, topZ),
});
const root = (id: string, x: number) => ({
    id,
    modelId: MODEL,
    transform: { pos: { x, y: 0, z: 0 }, rot: { x: 0, y: 0, z: 0, w: 1 } },
    diameter: 2,
    diskHeight: 0.5,
    coneHeight: 1,
});

test('a knot on a root-owning shaft moves with the model', () => {
    // Every type that stands on its own root: nothing points at such a shaft,
    // so it is reached only by claiming its segments.
    for (const descriptor of SUPPORT_TYPES.filter((candidate) => candidate.ownsRoot)) {
        resetStore();

        addRoot(root('root-host', 0) as never);
        addSupportEntity('trunk', {
            id: 'host', modelId: MODEL, rootId: 'root-host',
            segments: [segment('seg-host', 0, 0, 40)],
        } as never);
        addKnot({
            id: 'knot-host', parentShaftId: 'seg-host', t: 0.9,
            pos: { x: 0, y: 0, z: 36 }, diameter: 1.2,
        } as never);

        const id = `probe-${descriptor.id}`;
        addRoot(root(`root-${id}`, 6) as never);
        addSupportEntity(descriptor.id, {
            id, modelId: MODEL, rootId: `root-${id}`,
            hostKnotId: 'knot-host', hostSegmentId: 'seg-host', hostMinT: 0,
            segments: [segment(`seg-${id}`, 6, 0, 36)],
            profile: { bodyDiameterMm: 1.2, terminalStartDiameterMm: 1.2, terminalEndDiameterMm: 1.2 },
        } as never);
        addKnot({
            id: `knot-${id}`, parentShaftId: `seg-${id}`, t: 0.5,
            pos: { x: 6, y: 0, z: 18 }, diameter: 1.3,
        } as never);

        transformSupportsForModel(
            MODEL,
            { position: new THREE.Vector3(0, 0, 0), rotation: new THREE.Euler(), scale: new THREE.Vector3(1, 1, 1) },
            { position: new THREE.Vector3(0, 0, 0), rotation: new THREE.Euler(), scale: new THREE.Vector3(-1, 1, 1) },
        );

        assert.equal(
            getSnapshot().knots[`knot-${id}`].pos.x,
            -6,
            `${descriptor.id}: a knot on its own shaft follows the mirror`,
        );
    }
    resetStore();
});

test('a transform leaves a snapshot taken before it alone', () => {
    // A caller records the pre-transform state as its undo entry and holds it
    // across the write; writing into the live collections corrupted it.
    resetStore();
    try {
        addRoot(root('root-1', 3) as never);
        addSupportEntity('trunk', {
            id: 'trunk-1', modelId: MODEL, rootId: 'root-1',
            segments: [segment('seg-1', 3, 0, 40)],
        } as never);
        addKnot({
            id: 'knot-1', parentShaftId: 'seg-1', t: 0.5,
            pos: { x: 3, y: 0, z: 20 }, diameter: 1.3,
        } as never);

        const captured = getSnapshot();
        const before = JSON.stringify(captured);

        transformSupportsForModel(
            MODEL,
            { position: new THREE.Vector3(0, 0, 0), rotation: new THREE.Euler(), scale: new THREE.Vector3(1, 1, 1) },
            { position: new THREE.Vector3(0, 0, 0), rotation: new THREE.Euler(), scale: new THREE.Vector3(-1, 1, 1) },
        );

        assert.equal(JSON.stringify(captured), before, 'the snapshot is untouched');
        assert.equal(getSnapshot().knots['knot-1'].pos.x, -3, 'while the store did move');
    } finally {
        resetStore();
    }
});
