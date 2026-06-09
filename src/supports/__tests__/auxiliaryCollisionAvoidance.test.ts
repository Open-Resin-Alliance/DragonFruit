import assert from 'node:assert/strict';
import test from 'node:test';

import * as THREE from 'three';
import { initializeBVH, accelerateGeometry } from '../../utils/bvh';
import { buildStick } from '../SupportTypes/Stick/stickBuilder';
import { buildTwig } from '../SupportTypes/Twig/twigBuilder';
import { recomputeContactConeForMovedDisk } from '../SupportPrimitives/ContactDisk/ContactDiskInteraction';
import type { ContactCone } from '../SupportPrimitives/ContactCone/types';
import { setSettings } from '../Settings/state';
import { createDefaultSettings } from '../Settings/types';

function makeThinBlockingMesh(z: number): THREE.Mesh {
    // A very thin horizontal plate (0.1mm thickness)
    const geometry = new THREE.BoxGeometry(20, 20, 0.1);
    accelerateGeometry(geometry);
    const mesh = new THREE.Mesh(geometry, new THREE.MeshBasicMaterial());
    mesh.position.set(0, 0, z);
    mesh.updateMatrixWorld(true);
    return mesh;
}

test('buildStick detects collision with thin model feature when mesh is provided', () => {
    initializeBVH();
    const settings = createDefaultSettings();
    setSettings(settings);

    // Place a thin plate at z = 5 (between A* start/end)
    const mesh = makeThinBlockingMesh(5);

    const input = {
        modelId: 'test-model-1',
        aPos: { x: 0, y: 0, z: 0 },
        aNormal: { x: 0, y: 0, z: 1 },
        bPos: { x: 0, y: 0, z: 10 },
        bNormal: { x: 0, y: 0, z: -1 },
    };

    // 1. Without mesh parameter -> no error
    const resultWithoutMesh = buildStick(input);
    assert.equal(resultWithoutMesh.error, undefined);

    // 2. With mesh parameter -> COLLISION_WITH_MODEL
    const resultWithMesh = buildStick({ ...input, mesh });
    assert.equal(resultWithMesh.error, 'COLLISION_WITH_MODEL');
});

test('buildTwig detects collision with thin model feature when mesh is provided', () => {
    initializeBVH();
    const settings = createDefaultSettings();
    setSettings(settings);

    // Place a thin plate at z = 5 (between A* start/end)
    const mesh = makeThinBlockingMesh(5);

    const input = {
        modelId: 'test-model-2',
        aPos: { x: 0, y: 0, z: 0 },
        aNormal: { x: 0, y: 0, z: 1 },
        bPos: { x: 0, y: 0, z: 10 },
        bNormal: { x: 0, y: 0, z: -1 },
    };

    // 1. Without mesh parameter -> no error
    const resultWithoutMesh = buildTwig(input);
    assert.equal(resultWithoutMesh.error, undefined);

    // 2. With mesh parameter -> COLLISION_WITH_MODEL
    const resultWithMesh = buildTwig({ ...input, mesh });
    assert.equal(resultWithMesh.error, 'COLLISION_WITH_MODEL');
});

test('hybrid segmentBlockedMethod detects thin feature in standoff calculation', () => {
    initializeBVH();
    const settings = createDefaultSettings();
    setSettings(settings);

    const cone: ContactCone = {
        id: 'test-cone-1',
        pos: { x: 0, y: 0, z: 0 },
        normal: { x: 0, y: 0, z: 1 },
        surfaceNormal: { x: 0, y: 0, z: 1 },
        profile: {
            type: 'disk',
            contactDiameterMm: 0.4,
            bodyDiameterMm: 1.2,
            lengthMm: 3,
            penetrationMm: 0.05,
            diskThicknessMm: 0.1,
            maxStandoffMm: 1.6,
            standoffAngleThreshold: Math.PI / 4,
        },
    };

    // Place a very thin plate (0.1mm thickness) at z = 0.2, right in the way of the contact disk
    const mesh = makeThinBlockingMesh(0.2);

    // Recompute contact cone without mesh -> standoff is minimal (diskThicknessMm = 0.1)
    const withoutMesh = recomputeContactConeForMovedDisk(cone, { x: 0, y: 0, z: 0 }, { x: 0, y: 0, z: 1 }, { x: 0, y: 0, z: 4 });
    assert.ok(withoutMesh.diskLengthOverride !== undefined);
    assert.equal(withoutMesh.diskLengthOverride, 0.1);

    // Recompute contact cone with mesh -> standoff is pushed out past the thin plate (standoff > 0.2mm)
    const withMesh = recomputeContactConeForMovedDisk(cone, { x: 0, y: 0, z: 0 }, { x: 0, y: 0, z: 1 }, { x: 0, y: 0, z: 4 }, mesh);
    assert.ok(withMesh.diskLengthOverride !== undefined);
    assert.ok(withMesh.diskLengthOverride > 0.2);
});
