import assert from 'node:assert/strict';
import test from 'node:test';

import * as THREE from 'three';

import { resolveConeAxisPolicy } from '../PlacementLogic/ConeAxisPolicy';
import type { Vec3 } from '../types';

function angleBetween(a: Vec3, b: Vec3): number {
    const va = new THREE.Vector3(a.x, a.y, a.z).normalize();
    const vb = new THREE.Vector3(b.x, b.y, b.z).normalize();
    return THREE.MathUtils.radToDeg(Math.acos(THREE.MathUtils.clamp(va.dot(vb), -1, 1)));
}

test('adaptive cone axis stays close to the surface normal on vertical walls', () => {
    const surfaceNormal = { x: 1, y: 0, z: 0 };
    const { coneAxis } = resolveConeAxisPolicy({
        surfaceNormal,
        coneAngleMode: 'adaptive',
        adaptiveConeAngleOffsetDeg: 60,
    });

    assert.ok(
        angleBetween(surfaceNormal, coneAxis) <= 35.001,
        `expected adaptive cone axis to stay within 35° of the surface normal, got ${angleBetween(surfaceNormal, coneAxis).toFixed(2)}°`,
    );
});

test('locked cone axis also remains broadly aligned with the contact-disk direction', () => {
    const surfaceNormal = { x: 1, y: 0, z: 0 };
    const { coneAxis } = resolveConeAxisPolicy({
        surfaceNormal,
        coneAngleMode: 'locked',
    });

    assert.ok(
        angleBetween(surfaceNormal, coneAxis) <= 35.001,
        `expected locked cone axis to stay within 35° of the surface normal, got ${angleBetween(surfaceNormal, coneAxis).toFixed(2)}°`,
    );
});