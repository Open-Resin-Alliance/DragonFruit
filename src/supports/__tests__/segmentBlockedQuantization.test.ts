import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from 'three';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import { initializeBVH, accelerateGeometry } from '@/utils/bvh';
import { calculateSafeOffset, isContactConeBlocked } from '../PlacementLogic/CollisionAvoidance';
import { SDFCache } from '../PlacementLogic/Pathfinding/SDFCache';
import { clearSDFCacheForMesh, getOrCreateSDFCache } from '../PlacementLogic/Pathfinding/SDFCachePool';

initializeBVH();

/**
 * Exact minimum distance from a segment to the mesh, by sampling plus the BVH's
 * closest-point query. The sampling step is finer than any clearance this test
 * uses, so the result is tight enough to judge the predicate against.
 */
function exactSegmentDistance(geometry: THREE.BufferGeometry, a: THREE.Vector3, b: THREE.Vector3): number {
    const bvh = geometry.boundsTree;
    if (!bvh) throw new Error('exactSegmentDistance: geometry has no boundsTree');
    const point = new THREE.Vector3();
    const target = { point: new THREE.Vector3(), distance: 0, faceIndex: -1 };
    const steps = Math.max(1, Math.ceil(a.distanceTo(b) / 0.05));
    let best = Infinity;
    for (let s = 0; s <= steps; s++) {
        point.lerpVectors(a, b, s / steps);
        const result = bvh.closestPointToPoint(point, target, 0, Infinity);
        if (result && result.distance < best) best = result.distance;
    }
    return best;
}

/**
 * `segmentBlocked` must never report a segment clear when it comes within
 * `clearance` of the model.
 *
 * The distance field answers for the nearest *lattice* point, not for the
 * sample, so a sample's true distance can be smaller by up to half a cell
 * diagonal (0.43 mm at the default 0.5 mm cell). Stepping on that value let the
 * march jump over geometry that was inside `clearance` - a column passing
 * 0.5976 mm from the model at clearance 0.7 mm came back clear on the router's
 * own probes. This sweep is the contract that catches it: tangent segments at
 * every offset just inside the clearance, where the closest approach is the
 * midpoint (usually not a sample) and the lattice distance is the larger one.
 */
test('segmentBlocked: a segment inside clearance is never reported clear', () => {
    // The radius is deliberately not a round number. A sphere of radius 10 sits
    // exactly on the 0.5 mm lattice, so every rounding lands on the surface and
    // the sweep passes even without the fix - which is how the first version of
    // this test managed to prove nothing.
    const radius = 10.137;
    const geometry = new THREE.SphereGeometry(radius, 96, 48);
    accelerateGeometry(geometry);
    const mesh = new THREE.Mesh(geometry);
    mesh.updateMatrixWorld(true);
    const sdf = new SDFCache(mesh);

    const clearance = 0.7;
    const normal = new THREE.Vector3();
    const tangent = new THREE.Vector3();
    const a = new THREE.Vector3();
    const b = new THREE.Vector3();
    let checked = 0;
    let missed = 0;

    for (let i = 0; i < 12; i++) {
        const theta = (i / 12) * Math.PI * 2;
        for (let j = 1; j < 6; j++) {
            const phi = (j / 6) * Math.PI;
            normal.setFromSphericalCoords(1, phi, theta);
            tangent.setFromSphericalCoords(1, phi, theta + Math.PI / 2).normalize();
            for (let k = 0; k < 30; k++) {
                // Offsets stay inside clearance but outside the quarter-cell
                // where the plain test would catch the segment anyway.
                const offset = 0.28 + (k / 30) * 0.44;
                const reach = Math.sqrt(Math.max(0, (radius + clearance) ** 2 - (radius + offset) ** 2));
                a.copy(normal).multiplyScalar(radius + offset).addScaledVector(tangent, -reach);
                b.copy(normal).multiplyScalar(radius + offset).addScaledVector(tangent, reach);
                const exact = exactSegmentDistance(geometry, a, b);
                if (exact >= clearance * 0.9) continue;
                checked++;
                if (!sdf.segmentBlocked(a.x, a.y, a.z, b.x, b.y, b.z, clearance)) missed++;
            }
        }
    }

    assert.ok(checked > 200, `sweep should exercise many segments, saw ${checked}`);
    assert.equal(missed, 0, `${missed} of ${checked} segments inside clearance were reported clear`);
});

test('calculateSafeOffset with exact contact-cone sweep clears 90° concave inside corner where legacy quantized path saturates 0.35 mm', () => {
    // L-bracket concave inside corner along (0, y, 0):
    // ceiling slab x in [-10, 0], z in [0, 2] (outward -Z at z=0) + vertical wall x in [0, 2], z in [-10, 2] (outward -X at x=0)
    const ceiling = new THREE.BoxGeometry(10, 10, 2).translate(-5, 0, 1);
    const wall = new THREE.BoxGeometry(2, 10, 12).translate(1, 0, -4);
    const merged = mergeGeometries([ceiling, wall], false);
    assert.ok(merged);
    accelerateGeometry(merged);
    const mesh = new THREE.Mesh(merged);
    mesh.updateMatrixWorld(true);

    try {
        const surfacePos = { x: 0, y: 0, z: 0 };
        const surfaceNormal = { x: -Math.SQRT1_2, y: 0, z: -Math.SQRT1_2 };
        const minOffset = 0.1;
        const maxOffset = 0.35;
        const startPos = {
            x: surfacePos.x + surfaceNormal.x * minOffset,
            y: surfacePos.y + surfaceNormal.y * minOffset,
            z: surfacePos.z + surfaceNormal.z * minOffset,
        };
        const targetPos = { x: startPos.x, y: startPos.y, z: startPos.z - 2.0 };
        const exactConeRadii = { startRadius: 0.15, endRadius: 0.25 };

        const legacyOffset = calculateSafeOffset(
            surfacePos,
            surfaceNormal,
            targetPos,
            exactConeRadii.endRadius + 0.05,
            mesh,
            minOffset,
            maxOffset,
            0.2,
            {
                startRadius: exactConeRadii.startRadius + 0.05,
                endRadius: exactConeRadii.endRadius + 0.05,
            },
        );
        assert.equal(legacyOffset, maxOffset, `expected legacy calculateSafeOffset to saturate at ${maxOffset}, got ${legacyOffset}`);

        const exactOffset = calculateSafeOffset(
            surfacePos,
            surfaceNormal,
            targetPos,
            exactConeRadii.endRadius,
            mesh,
            minOffset,
            maxOffset,
            0.2,
            undefined,
            {
                useExactContactConeSweep: true,
                exactConeRadii,
                shiftTargetRigidly: true,
                maxOffsetScale: Math.SQRT2,
            },
        );
        const scaledCeiling = maxOffset * Math.SQRT2;
        assert.ok(
            exactOffset > maxOffset && exactOffset < scaledCeiling - 1e-4,
            `expected exact sub-ceiling backoff in (${maxOffset}, ${scaledCeiling}), got ${exactOffset}`,
        );

        const sdf = getOrCreateSDFCache(mesh);
        sdf.refreshMatrix();
        const delta = exactOffset - minOffset;
        assert.equal(
            isContactConeBlocked(sdf, {
                start: {
                    x: surfacePos.x + surfaceNormal.x * exactOffset,
                    y: surfacePos.y + surfaceNormal.y * exactOffset,
                    z: surfacePos.z + surfaceNormal.z * exactOffset,
                },
                end: {
                    x: targetPos.x + surfaceNormal.x * delta,
                    y: targetPos.y + surfaceNormal.y * delta,
                    z: targetPos.z + surfaceNormal.z * delta,
                },
                startRadius: exactConeRadii.startRadius,
                endRadius: exactConeRadii.endRadius,
            }),
            false,
            'resolved exactOffset with rigidly shifted target must be verified clear by isContactConeBlocked',
        );
    } finally {
        clearSDFCacheForMesh(mesh.uuid);
    }
});
