import assert from 'node:assert/strict';
import test from 'node:test';

import * as THREE from 'three';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';

import { recomputeContactConeForMovedDisk } from '../SupportPrimitives/ContactDisk/ContactDiskInteraction';
import type { ContactCone } from '../SupportPrimitives/ContactCone/types';
import type { Vec3 } from '../types';
import { getSocketPosition } from '../SupportPrimitives/ContactCone';
import { calculateDiskThickness } from '../SupportPrimitives/ContactDisk/contactDiskUtils';
import { isContactConeBlocked } from '../PlacementLogic/CollisionAvoidance';
import { getOrCreateSDFCache } from '../PlacementLogic/Pathfinding/SDFCachePool';
import { initializeBVH, accelerateGeometry } from '../../utils/bvh';
import { calculateSmartPlacementV3 } from '../PlacementLogicV3/SmartPlacementV3';
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

test('SmartPlacementV3 detects a thin feature between the tip and the plate', () => {
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

    const result = calculateSmartPlacementV3({
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

    // A 0.2mm plate is thinner than the SDF's 0.5mm cells, so the point is that
    // a cell-centre distance lookup still sees it: the signed distance inside
    // the plate is negative, so both the column and every candidate leg within
    // the envelope are rejected rather than silently passed.
    assert.equal(result.error, 'COLLISION_WITH_MODEL');
});

test('SmartPlacementV3 detects a flipped, back-facing surface', () => {
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

    const result = calculateSmartPlacementV3({
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

    // A single-sided distance test would miss this back-facing plane. The SDF
    // signs its distance from the nearest triangle's normal, so a segment
    // crossing the plane is rejected whichever way the face points.
    assert.equal(result.error, 'COLLISION_WITH_MODEL');
});

const RIB_TIP_PROFILE = {
    type: 'disk' as const,
    contactDiameterMm: 0.4,
    bodyDiameterMm: 1.0,
    lengthMm: 3.0,
    penetrationMm: 0.05,
    diskThicknessMm: 0.1,
    maxStandoffMm: 0.25,
    standoffAngleThreshold: Math.PI / 4,
};
/** The tip hangs from the underside of a plate at z=10, trunk below it. */
const RIB_TIP = { x: 0, y: 0, z: 10 };
const RIB_NORMAL = { x: 0, y: 0, z: -1 };
const RIB_ROOTS_TOP_Z = 2;

/**
 * Model above the build plate: the plate the tip attaches to, with a rib beside
 * the cone body — or two of them, forming a slot the cone cannot leave.
 */
function makePlateWithRib(ribHeightMm: number, fins = false): THREE.Mesh {
    initializeBVH();
    const plate = new THREE.BoxGeometry(20, 20, 2).translate(0, 0, 11);
    const ribs: THREE.BufferGeometry[] = [];
    const rib = (x: number) => new THREE.BoxGeometry(0.4, 6, ribHeightMm)
        .translate(x, 0, RIB_TIP.z - ribHeightMm / 2);
    if (fins) {
        ribs.push(rib(0.65), rib(-0.65));
    } else if (ribHeightMm > 0) {
        ribs.push(rib(0.4));
    }
    const geometry = ribs.length > 0 ? mergeGeometries([plate, ...ribs])! : plate;
    accelerateGeometry(geometry);
    const mesh = new THREE.Mesh(geometry, new THREE.MeshBasicMaterial());
    mesh.updateMatrixWorld(true);
    return mesh;
}

/** The cone the router committed, as a collision subject. */
function committedCone(mesh: THREE.Mesh, socketPos: Vec3, coneAxis?: Vec3) {
    const sdf = getOrCreateSDFCache(mesh);
    sdf.refreshMatrix();
    const thickness = calculateDiskThickness(RIB_NORMAL, coneAxis ?? RIB_NORMAL, RIB_TIP_PROFILE);
    return {
        sdf,
        cone: {
            start: { x: RIB_TIP.x, y: RIB_TIP.y, z: RIB_TIP.z - thickness },
            end: socketPos,
            startRadius: RIB_TIP_PROFILE.contactDiameterMm / 2,
            endRadius: RIB_TIP_PROFILE.bodyDiameterMm / 2,
        },
    };
}

function placeTrunk(mesh: THREE.Mesh, modelId: string) {
    setSettings(createDefaultSettings());
    return calculateSmartPlacementV3({
        tipPos: RIB_TIP,
        tipNormal: RIB_NORMAL,
        tipProfile: RIB_TIP_PROFILE,
        modelId,
        mesh,
        rootsTopZ: RIB_ROOTS_TOP_Z,
    });
}

test('SmartPlacementV3 reaches around a rib beside the tip instead of burying the cone', () => {
    // The socket clears the rib, the cone body does not: the trunk has to walk
    // the cone around the tip to attach, and must never commit a cone leaning
    // into the rib.
    const ribbed = makePlateWithRib(2);
    const reached = placeTrunk(ribbed, 'model-rib');
    assert.equal(reached.error, undefined);
    const committed = committedCone(ribbed, reached.socketPos, reached.coneAxis);
    assert.equal(isContactConeBlocked(committed.sdf, committed.cone), false);

    // Same tip with nothing beside it: still places, cone tangent and clear.
    const clean = makePlateWithRib(0);
    const placed = placeTrunk(clean, 'model-clean');
    assert.equal(placed.error, undefined);
    const tangent = committedCone(clean, placed.socketPos, placed.coneAxis);
    assert.equal(isContactConeBlocked(tangent.sdf, tangent.cone), false);
});

test('SmartPlacementV3 refuses when no cone deviation can clear the model', () => {
    // Fins form a slot narrower than the cone body, so every deviation either
    // stays inside it or drives the socket into a fin.
    const slotted = makePlateWithRib(4, true);
    assert.equal(placeTrunk(slotted, 'model-slot').error, 'COLLISION_WITH_MODEL');
});

test('isContactConeBlocked clears cones tangent to their own surface, on flat and sloped faces', () => {
    const boxMesh = (place: (mesh: THREE.Mesh) => void): THREE.Mesh => {
        initializeBVH();
        const geometry = new THREE.BoxGeometry(20, 20, 2);
        accelerateGeometry(geometry);
        const mesh = new THREE.Mesh(geometry, new THREE.MeshBasicMaterial());
        place(mesh);
        mesh.updateMatrixWorld(true);
        return mesh;
    };
    const coneOn = (mesh: THREE.Mesh, tipNormal: Vec3, tipPos: Vec3) => {
        const sdf = getOrCreateSDFCache(mesh);
        sdf.refreshMatrix();
        const thickness = calculateDiskThickness(tipNormal, tipNormal, RIB_TIP_PROFILE);
        const start = {
            x: tipPos.x + tipNormal.x * thickness,
            y: tipPos.y + tipNormal.y * thickness,
            z: tipPos.z + tipNormal.z * thickness,
        };
        return {
            sdf,
            cone: {
                start,
                end: getSocketPosition(start, tipNormal, RIB_TIP_PROFILE),
                startRadius: RIB_TIP_PROFILE.contactDiameterMm / 2,
                endRadius: RIB_TIP_PROFILE.bodyDiameterMm / 2,
            },
        };
    };

    // A cone standing on the face it attaches to is tangent there: those samples
    // are clear by construction, and reading them as collisions is what refused
    // every placement on a sloped or rotated face.
    const flat = boxMesh((mesh) => mesh.position.set(0, 0, 1));
    const flatDown = { x: 0, y: 0, z: -1 };
    const flatCone = coneOn(flat, flatDown, { x: 0, y: 0, z: 0 });
    assert.equal(isContactConeBlocked(flatCone.sdf, flatCone.cone), false);

    const slope = boxMesh((mesh) => {
        mesh.rotation.x = -Math.PI / 4;
        mesh.position.set(0, -0.7071, -0.7071);
    });
    const slopeUp = { x: 0, y: 0.7071, z: 0.7071 };
    const slopeCone = coneOn(slope, slopeUp, { x: 0, y: 0, z: 0 });
    assert.equal(isContactConeBlocked(slopeCone.sdf, slopeCone.cone), false);

    // The same cone beside a rib is a real collision and must stay one.
    const ribbed = makePlateWithRib(2);
    const ribCone = coneOn(ribbed, RIB_NORMAL, RIB_TIP);
    assert.equal(isContactConeBlocked(ribCone.sdf, ribCone.cone), true);
});
