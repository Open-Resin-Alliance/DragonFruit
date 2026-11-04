import assert from 'node:assert/strict';
import test from 'node:test';
import * as THREE from 'three';

import { getSnapshot, loadFromImportFormat, resetStore, transformSupportsForModel } from '../state';
import { getFinalSocketPosition } from '../SupportPrimitives/ContactCone/contactConeUtils';
import { DEFAULT_TIP_PROFILE } from '../SupportPrimitives/ContactCone/types';
import { getSettings } from '../Settings/state';
import { encodeSupportSettingsHex } from '../Settings/supportSettingsCodec';
import { SUPPORT_COLLECTION_KEYS } from '../supportTypeRegistry';
import type { DragonfruitImportFormat } from '../types';

const MODEL_ID = 'model-1';
const ROOT_TOP_Z = 1.1;

function emptyPayload(): DragonfruitImportFormat {
    const payload = {
        version: 1,
        meta: { source: 'unit-test', objectCenter: { x: 0, y: 0, z: 0 } },
        roots: [],
        knots: [],
    } as unknown as DragonfruitImportFormat;
    for (const key of SUPPORT_COLLECTION_KEYS) {
        (payload as unknown as Record<string, unknown>)[key] = [];
    }
    return payload;
}

function cone(tipZ: number, lengthMm: number, id: string) {
    return {
        id,
        pos: { x: 5, y: 5, z: tipZ },
        normal: { x: 0, y: 0, z: -1 },
        surfaceNormal: { x: 0, y: 0, z: -1 },
        profile: { ...DEFAULT_TIP_PROFILE, lengthMm },
        socketJointId: `${id}-socket`,
    };
}

function stump(tipZ: number) {
    return {
        id: 'stump-1',
        modelId: MODEL_ID,
        settingsCodeHex: encodeSupportSettingsHex(getSettings()),
        rootPos: { x: 5, y: 5, z: 0 },
        rootBaseDiameter: 2,
        rootTopDiameter: 1.5,
        rootHeight: 1,
        joint: { id: 'stump-joint-1', pos: { x: 5, y: 5, z: ROOT_TOP_Z }, diameter: 1.5 },
        segments: [],
        contactCone: cone(tipZ, 1.8, 'stump-cone-1'),
    };
}

function bareTrunk(tipZ: number) {
    return {
        id: 'trunk-bare',
        modelId: MODEL_ID,
        rootId: 'root-bare',
        segments: [{
            id: 'seg-bare',
            type: 'straight',
            diameter: 1.5,
            bottomJoint: { id: 'seg-bare-bottom', pos: { x: 10, y: 10, z: ROOT_TOP_Z }, diameter: 1.5 },
            topJoint: { id: 'seg-bare-top', pos: { x: 10, y: 10, z: tipZ - 2.1 }, diameter: 1.5 },
        }],
        contactCone: cone(tipZ, 2, 'trunk-cone'),
    };
}

function hostedTrunk(tipZ: number) {
    return {
        id: 'trunk-hosted',
        modelId: MODEL_ID,
        rootId: 'root-hosted',
        segments: [{
            id: 'seg-hosted',
            type: 'straight',
            diameter: 1.5,
            bottomJoint: { id: 'seg-hosted-bottom', pos: { x: 20, y: 20, z: ROOT_TOP_Z }, diameter: 1.5 },
            topJoint: { id: 'seg-hosted-top', pos: { x: 20, y: 20, z: tipZ - 2.1 }, diameter: 1.5 },
        }],
        contactCone: cone(tipZ, 2, 'hosted-cone'),
    };
}

function root(id: string, x: number) {
    return {
        id,
        modelId: MODEL_ID,
        transform: { pos: { x, y: 10, z: 0 }, rot: { x: 0, y: 0, z: 0, w: 1 } },
        diameter: 2,
        diskHeight: 0.1,
        coneHeight: 1,
    };
}

function loadScene(): void {
    const payload = emptyPayload();
    (payload as unknown as Record<string, unknown>).roots = [
        root('root-bare', 10),
        root('root-hosted', 20),
    ];
    (payload as unknown as Record<string, unknown>).knots = [{
        id: 'hosted-knot',
        parentShaftId: 'seg-hosted',
        t: 0.5,
        pos: { x: 20, y: 20, z: 4 },
        diameter: 1.6,
    }];
    (payload as unknown as Record<string, unknown>).stumps = [stump(3)];
    (payload as unknown as Record<string, unknown>).trunks = [bareTrunk(6), hostedTrunk(6)];
    loadFromImportFormat(payload);
}

function moveModel(dz: number): void {
    transformSupportsForModel(
        MODEL_ID,
        {
            position: new THREE.Vector3(0, 0, 0),
            rotation: new THREE.Euler(0, 0, 0),
            scale: new THREE.Vector3(1, 1, 1),
        },
        {
            position: new THREE.Vector3(0, 0, dz),
            rotation: new THREE.Euler(0, 0, 0),
            scale: new THREE.Vector3(1, 1, 1),
        },
    );
}

test('a stump under the band keeps its root grounded and stretches its cone', () => {
    resetStore();
    loadScene();

    moveModel(1.5);

    const snapshot = getSnapshot();
    const next = snapshot.stumps['stump-1'];
    assert.ok(next, 'the stump stays a stump under the band');
    assert.equal(next.rootPos.z, 0, 'the root stays on the plate');
    assert.equal(next.joint.pos.z, ROOT_TOP_Z, 'the joint stays at the root top');
    assert.ok(Math.abs(getFinalSocketPosition(next.contactCone).z - ROOT_TOP_Z) < 1e-6, 'the cone socket meets the joint');
    assert.ok(next.contactCone.profile.lengthMm > 1.8, 'the cone grew with the gap');

    resetStore();
});

test('a stump above the band becomes a trunk with a grounded root and a shaft', () => {
    resetStore();
    loadScene();

    moveModel(3);

    const snapshot = getSnapshot();
    assert.equal(snapshot.stumps['stump-1'], undefined, 'the stump left its collection');
    const trunk = snapshot.trunks['stump-1'];
    assert.ok(trunk, 'the trunk took its place');
    assert.equal(trunk.segments.length, 1);
    const nextRoot = snapshot.roots[trunk.rootId];
    assert.ok(nextRoot, 'the trunk has a plate root');
    assert.equal(nextRoot.transform.pos.z, 0);
    assert.equal(trunk.segments[0].bottomJoint?.pos.z, ROOT_TOP_Z);
    assert.ok(trunk.contactCone, 'the trunk keeps the contact cone');
    assert.ok(getFinalSocketPosition(trunk.contactCone).z > ROOT_TOP_Z, 'the cone socket sits above the root');

    resetStore();
});

test('a bare vertical trunk below the band becomes a stump, a hosted one stays a trunk', () => {
    resetStore();
    loadScene();

    moveModel(-2);

    const snapshot = getSnapshot();
    assert.equal(snapshot.trunks['trunk-bare'], undefined, 'the bare trunk converted');
    const next = snapshot.stumps['trunk-bare'];
    assert.ok(next, 'the stump took its place');
    assert.equal(next.rootPos.z, 0);
    assert.equal(next.joint.pos.z, ROOT_TOP_Z);
    assert.ok(Math.abs(getFinalSocketPosition(next.contactCone).z - ROOT_TOP_Z) < 1e-6);
    assert.equal(snapshot.roots['root-bare'], undefined, 'its root left with it');

    assert.ok(snapshot.trunks['trunk-hosted'], 'a trunk carrying a knot is left alone');

    resetStore();
});
