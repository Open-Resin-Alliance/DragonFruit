import assert from 'node:assert/strict';
import test from 'node:test';

import * as THREE from 'three';

import { recomputeContactConeForMovedDisk } from '../SupportPrimitives/ContactDisk/ContactDiskInteraction';
import type { ContactCone } from '../SupportPrimitives/ContactCone/types';
import { initializeBVH, accelerateGeometry } from '../../utils/bvh';
import { calculateSmartPlacementV2 } from '../PlacementLogic/Pathfinding/SmartPlacementV2';
import { setSettings } from '../Settings/state';
import { createDefaultSettings } from '../Settings/types';

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

test('calculateSmartPlacementV2 detects thin feature collision using raycast preflight check', () => {
    initializeBVH();
    const settings = createDefaultSettings();
    settings.roots.diskHeightMm = 1.0;
    settings.roots.coneHeightMm = 1.0;
    settings.roots.diameterMm = 3.0;
    settings.shaft.diameterMm = 1.5;
    setSettings(settings);

    // Create a very thin horizontal plate directly between tip (z=10) and base (z=0)
    // The plate is placed at z = 5. Thickness = 0.2mm.
    const geometry = new THREE.BoxGeometry(20, 20, 0.2);
    accelerateGeometry(geometry);

    const mesh = new THREE.Mesh(geometry, new THREE.MeshBasicMaterial());
    mesh.position.set(0, 0, 5);
    mesh.updateMatrixWorld(true);

    const result = calculateSmartPlacementV2({
        tipPos: { x: 0, y: 0, z: 10 },
        tipNormal: { x: 0, y: 0, z: -1 },
        tipProfile: {
            type: 'disk',
            contactDiameterMm: 0.4,
            bodyDiameterMm: 1.2,
            lengthMm: 1.2,
            penetrationMm: 0.05,
            diskThicknessMm: 0.1,
            maxStandoffMm: 0.35,
            standoffAngleThreshold: Math.PI / 4,
        },
        modelId: 'model-1',
        mesh,
        rootsTopZ: 2,
    });

    // Without hybrid raycast checks, the thin plate at z=5 would be skipped by SDF checks,
    // causing straightClear to return true and placing a straight support (error = undefined).
    // With our hybrid raycast check, it detects the collision and fails placement (error = 'COLLISION_WITH_MODEL').
    assert.equal(result.error, 'COLLISION_WITH_MODEL');
});

test('calculateSmartPlacementV2 detects collision with back-facing/flipped surfaces using double-sided raycast', () => {
    initializeBVH();
    const settings = createDefaultSettings();
    settings.roots.diskHeightMm = 1.0;
    settings.roots.coneHeightMm = 1.0;
    settings.roots.diameterMm = 3.0;
    settings.shaft.diameterMm = 1.5;
    setSettings(settings);

    // Create a very thin horizontal plane (using PlaneGeometry) at z = 5
    // and rotate it 180 degrees so its normal points down (-Z).
    // A downward raycast will hit its back face.
    const geometry = new THREE.PlaneGeometry(20, 20);
    accelerateGeometry(geometry);

    const mesh = new THREE.Mesh(geometry, new THREE.MeshBasicMaterial());
    mesh.rotation.x = Math.PI; // Face normal now points in -Z direction
    mesh.position.set(0, 0, 5);
    mesh.updateMatrixWorld(true);

    const result = calculateSmartPlacementV2({
        tipPos: { x: 0, y: 0, z: 10 },
        tipNormal: { x: 0, y: 0, z: -1 },
        tipProfile: {
            type: 'disk',
            contactDiameterMm: 0.4,
            bodyDiameterMm: 1.2,
            lengthMm: 1.2,
            penetrationMm: 0.05,
            diskThicknessMm: 0.1,
            maxStandoffMm: 0.35,
            standoffAngleThreshold: Math.PI / 4,
        },
        modelId: 'model-2',
        mesh,
        rootsTopZ: 2,
    });

    // A single-sided raycaster would miss this back-facing plane, leading to a successful straight support.
    // Our double-sided raycasting modification ensures the back-face is detected, returning COLLISION_WITH_MODEL.
    assert.equal(result.error, 'COLLISION_WITH_MODEL');
});
