import assert from 'node:assert/strict';
import test from 'node:test';
import * as THREE from 'three';
import { BoxGeometry } from 'three';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';

import { initializeBVH, accelerateGeometry } from '../../utils/bvh';
import { setSettings } from '../Settings/state';
import { createDefaultSettings } from '../Settings/types';
import { buildStick } from '../SupportTypes/Stick/stickBuilder';
import { buildTwig } from '../SupportTypes/Twig/twigBuilder';

const MODEL_ID = 'model-1';

// A slab above with its underside at z = 10, a body below whose top face sits
// `gapMm` under it: two flat, parallel surfaces with nothing between them.
function makeGapMesh(gapMm: number): THREE.Mesh {
    const topZ = 10 - gapMm;
    const body = new BoxGeometry(20, 20, 8);
    body.translate(0, 0, topZ - 4);
    const slab = new BoxGeometry(20, 20, 2);
    slab.translate(0, 0, 11);
    const geometry = mergeGeometries([body, slab], false);
    assert.ok(geometry);
    geometry.computeVertexNormals();
    const mesh = new THREE.Mesh(geometry, new THREE.MeshStandardMaterial());
    mesh.updateMatrixWorld(true);
    initializeBVH();
    accelerateGeometry(mesh.geometry);
    return mesh;
}

const upperContact = { x: 0, y: 0, z: 10 };
const upperNormal = { x: 0, y: 0, z: -1 };
const lowerNormal = { x: 0, y: 0, z: 1 };

test('a stick bridges a gap narrower than its own two cones', () => {
    const settings = createDefaultSettings();
    setSettings(settings);
    // The shaft is 1mm across and the cone 2.5mm per end, so a 2mm gap has no
    // room for the stock cones: they used to run through each other into the
    // material and the shaft then started inside it, which read as a collision
    // on every stick aimed across a gap this size.
    const mesh = makeGapMesh(2);
    const lowerContact = { x: 2, y: 0, z: 8 };

    const bridge = buildStick({
        modelId: MODEL_ID,
        aPos: upperContact,
        aNormal: upperNormal,
        bPos: lowerContact,
        bNormal: lowerNormal,
        mesh,
    });

    assert.equal(bridge.error, undefined, 'a clear 2mm gap is not a collision');
    const segment = bridge.stick.segments[0];
    const socketA = segment.bottomJoint!.pos;
    const socketB = segment.topJoint!.pos;
    for (const socket of [socketA, socketB]) {
        assert.ok(socket.z > 8 && socket.z < 10,
            `socket stays inside the gap (z=${socket.z.toFixed(2)})`);
    }
    assert.ok(
        Math.hypot(socketB.x - socketA.x, socketB.y - socketA.y, socketB.z - socketA.z) > 0.5,
        'and the two sockets do not meet',
    );
});

test('a gap too narrow for the shaft is still a collision', () => {
    const settings = createDefaultSettings();
    setSettings(settings);
    // 0.8mm of gap against a 1mm shaft: it genuinely does not fit, and the
    // clearance check has to keep saying so.
    const mesh = makeGapMesh(0.8);
    const bridge = buildStick({
        modelId: MODEL_ID,
        aPos: upperContact,
        aNormal: upperNormal,
        bPos: { x: 2, y: 0, z: 9.2 },
        bNormal: lowerNormal,
        mesh,
    });

    assert.equal(bridge.error, 'COLLISION_WITH_MODEL');

    // The refusal is the shaft's width against the gap, not the anchored ends:
    // the same bridge with a shaft that fits that gap is clear.
    const thinner = buildStick({
        modelId: MODEL_ID,
        shaftDiameterMm: 0.5,
        aPos: upperContact,
        aNormal: upperNormal,
        bPos: { x: 2, y: 0, z: 9.2 },
        bNormal: lowerNormal,
        mesh,
    });
    assert.equal(thinner.error, undefined);
});

test('a twig across the same gap is unaffected', () => {
    const settings = createDefaultSettings();
    setSettings(settings);
    const mesh = makeGapMesh(2);
    const twig = buildTwig({
        modelId: MODEL_ID,
        aPos: upperContact,
        aNormal: upperNormal,
        bPos: { x: 2, y: 0, z: 8 },
        bNormal: lowerNormal,
        mesh,
    });
    assert.equal(twig.error, undefined);
});
