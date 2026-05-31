import assert from 'node:assert/strict';
import test from 'node:test';

import * as THREE from 'three';

import { recomputeContactConeForMovedDisk } from '../SupportPrimitives/ContactDisk/ContactDiskInteraction';
import type { ContactCone } from '../SupportPrimitives/ContactCone/types';

function makeCone(): ContactCone {
    return {
        id: 'cone-1',
        pos: { x: 0, y: 0, z: 0 },
        normal: { x: 0, y: 0, z: 1 },
        surfaceNormal: { x: 1, y: 0, z: 0 },
        profile: {
            type: 'disk',
            contactDiameterMm: 0.4,
            bodyDiameterMm: 1.2,
            lengthMm: 3,
            penetrationMm: 0.05,
            diskThicknessMm: 0.1,
            maxStandoffMm: 1.1,
            standoffAngleThreshold: Math.PI / 4,
        },
    };
}

function makeBlockingMesh(): THREE.Mesh {
    const mesh = new THREE.Mesh(
        new THREE.BoxGeometry(0.16, 2.5, 0.35),
        new THREE.MeshBasicMaterial(),
    );
    mesh.position.set(0.74, 0, 0.2);
    mesh.updateMatrixWorld(true);
    return mesh;
}

test('recomputeContactConeForMovedDisk never reduces the resolved standoff when collision sampling is enabled', () => {
    const socketTarget = { x: 1.6, y: 0, z: 3 };
    const withoutAvoidance = recomputeContactConeForMovedDisk(
        makeCone(),
        { x: 0, y: 0, z: 0 },
        { x: 1, y: 0, z: 0 },
        socketTarget,
    );
    const withAvoidance = recomputeContactConeForMovedDisk(
        makeCone(),
        { x: 0, y: 0, z: 0 },
        { x: 1, y: 0, z: 0 },
        socketTarget,
        makeBlockingMesh(),
    );

    assert.ok((withAvoidance.diskLengthOverride ?? 0) >= (withoutAvoidance.diskLengthOverride ?? 0));
});
