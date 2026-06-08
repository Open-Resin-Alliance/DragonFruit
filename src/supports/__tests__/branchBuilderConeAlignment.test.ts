import assert from 'node:assert/strict';
import test from 'node:test';

import * as THREE from 'three';

import { buildBranchData } from '../SupportTypes/Branch/branchBuilder';
import { calculateDiskThickness } from '../SupportPrimitives/ContactDisk/contactDiskUtils';
import { getFinalSocketPosition } from '../SupportPrimitives/ContactCone/contactConeUtils';
import { isCollisionFrustumBlocked, isCollisionSegmentBlocked } from '../PlacementLogic/CollisionAvoidance';
import { getSettings } from '../Settings';
import type { ContactCone } from '../SupportPrimitives/ContactCone/types';
import type { Knot, Vec3 } from '../types';

function makeBlockingMesh(): THREE.Mesh {
    const mesh = new THREE.Mesh(
        new THREE.BoxGeometry(0.2, 2.5, 0.75),
        new THREE.MeshBasicMaterial(),
    );
    mesh.position.set(0.7, 0, 0.75);
    mesh.updateMatrixWorld(true);
    return mesh;
}

function angleBetween(a: Vec3, b: Vec3): number {
    const va = new THREE.Vector3(a.x, a.y, a.z).normalize();
    const vb = new THREE.Vector3(b.x, b.y, b.z).normalize();
    return THREE.MathUtils.radToDeg(Math.acos(THREE.MathUtils.clamp(va.dot(vb), -1, 1)));
}

function getConeStart(cone: ContactCone): Vec3 {
    const surfaceNormal = cone.surfaceNormal ?? cone.normal;
    const thickness = cone.diskLengthOverride ?? (
        cone.profile.type === 'disk'
            ? calculateDiskThickness(surfaceNormal, cone.normal, cone.profile)
            : 0
    );

    return {
        x: cone.pos.x + surfaceNormal.x * thickness,
        y: cone.pos.y + surfaceNormal.y * thickness,
        z: cone.pos.z + surfaceNormal.z * thickness,
    };
}

test('buildBranchData keeps the contact cone aligned with the contact disk direction before using shaft rerouting', () => {
    const tipPos = { x: 0, y: 0, z: 0 };
    const tipNormal = { x: 1, y: 0, z: 0 };
    const parentKnot: Knot = {
        id: 'knot-1',
        parentShaftId: 'trunk-1',
        pos: { x: 1.6, y: 0, z: 3 },
    };

    const withoutMesh = buildBranchData({
        tipPos,
        tipNormal,
        modelId: 'model-1',
        parentKnot,
    }).branch;

    const directAngle = angleBetween(tipNormal, {
        x: parentKnot.pos.x - tipPos.x,
        y: parentKnot.pos.y - tipPos.y,
        z: parentKnot.pos.z - tipPos.z,
    });
    const solvedAngle = angleBetween(tipNormal, withoutMesh.contactCone!.normal);

    assert.ok(
        solvedAngle <= directAngle + 0.001,
        `expected solved cone angle ${solvedAngle.toFixed(2)}° to stay no worse than direct ${directAngle.toFixed(2)}°`,
    );
});

test('buildBranchData reroutes the shaft instead of steepening the cone near the disk when mesh blocks the direct exit', () => {
    const tipPos = { x: 0, y: 0, z: 0 };
    const tipNormal = { x: 1, y: 0, z: 0 };
    const parentKnot: Knot = {
        id: 'knot-1',
        parentShaftId: 'trunk-1',
        pos: { x: 1.6, y: 0, z: 3 },
    };
    const mesh = makeBlockingMesh();

    const withoutMesh = buildBranchData({
        tipPos,
        tipNormal,
        modelId: 'model-1',
        parentKnot,
    }).branch;
    const withMesh = buildBranchData({
        tipPos,
        tipNormal,
        modelId: 'model-1',
        parentKnot,
        mesh,
    }).branch;

    const directAngle = angleBetween(tipNormal, {
        x: parentKnot.pos.x - tipPos.x,
        y: parentKnot.pos.y - tipPos.y,
        z: parentKnot.pos.z - tipPos.z,
    });
    const withMeshAngle = angleBetween(tipNormal, withMesh.contactCone!.normal);
    const withMeshSocket = getFinalSocketPosition(withMesh.contactCone!);
    const coneStart = getConeStart(withMesh.contactCone!);
    const blocked = isCollisionFrustumBlocked(
        coneStart,
        withMeshSocket,
        (withMesh.contactCone!.profile.contactDiameterMm / 2) + 0.25,
        (withMesh.contactCone!.profile.bodyDiameterMm / 2) + 0.25,
        mesh,
    );

    assert.ok(
        withMeshAngle <= directAngle + 0.001,
        `expected mesh-aware cone angle ${withMeshAngle.toFixed(2)}° to stay no steeper than direct ${directAngle.toFixed(2)}°`,
    );
    assert.ok(withMesh.segments.length >= withoutMesh.segments.length);
    assert.equal(blocked, false);
});

test('buildBranchData prefers shaft deviation over aggressively stretching the contact cone', () => {
    const settings = getSettings();
    const nominalConeLength = settings.tip.lengthMm;
    const tipPos = { x: 0, y: 0, z: 0 };
    const tipNormal = { x: 1, y: 0, z: 0 };
    const parentKnot: Knot = {
        id: 'knot-far',
        parentShaftId: 'trunk-1',
        pos: { x: 6, y: 0, z: 4 },
    };

    const branch = buildBranchData({
        tipPos,
        tipNormal,
        modelId: 'model-1',
        parentKnot,
    }).branch;

    const directDistance = new THREE.Vector3(
        parentKnot.pos.x - tipPos.x,
        parentKnot.pos.y - tipPos.y,
        parentKnot.pos.z - tipPos.z,
    ).length();

    assert.ok(
        branch.contactCone!.profile.lengthMm <= nominalConeLength * 1.35,
        `expected cone length ${branch.contactCone!.profile.lengthMm.toFixed(2)}mm to stay close to nominal ${nominalConeLength.toFixed(2)}mm`,
    );
    assert.ok(
        branch.contactCone!.profile.lengthMm <= directDistance - 1.5,
        `expected cone length ${branch.contactCone!.profile.lengthMm.toFixed(2)}mm to stay well below direct reach ${directDistance.toFixed(2)}mm`,
    );
});

test('buildBranchData keeps the host knot separate from the cone socket so the shaft retains real span', () => {
    const tipPos = { x: 0, y: 0, z: 0 };
    const tipNormal = { x: 1, y: 0, z: 0 };
    const parentKnot: Knot = {
        id: 'knot-host',
        parentShaftId: 'trunk-1',
        pos: { x: 3.5, y: 0, z: 2.2 },
    };

    const branch = buildBranchData({
        tipPos,
        tipNormal,
        modelId: 'model-1',
        parentKnot,
    }).branch;

    const socketPos = getFinalSocketPosition(branch.contactCone!);
    const hostToSocketDistance = new THREE.Vector3(
        socketPos.x - parentKnot.pos.x,
        socketPos.y - parentKnot.pos.y,
        socketPos.z - parentKnot.pos.z,
    ).length();

    assert.ok(
        hostToSocketDistance > 0.5,
        `expected branch shaft to retain visible span, but host-to-socket distance was ${hostToSocketDistance.toFixed(3)}mm`,
    );
    assert.ok(branch.segments.length >= 2);
});

test('frustum cone collision checks catch wide-end clips that a narrow start-radius shaft would miss', () => {
    const mesh = new THREE.Mesh(
        new THREE.BoxGeometry(0.25, 0.25, 0.45),
        new THREE.MeshBasicMaterial(),
    );
    mesh.position.set(0.62, 0, 3.2);
    mesh.updateMatrixWorld(true);

    const start = { x: 0, y: 0, z: 0 };
    const end = { x: 0, y: 0, z: 4 };

    const narrowStartBlocked = isCollisionSegmentBlocked(start, end, 0.22, mesh);
    const frustumBlocked = isCollisionFrustumBlocked(start, end, 0.22, 0.72, mesh);

    assert.equal(narrowStartBlocked, false);
    assert.equal(frustumBlocked, true);
});
