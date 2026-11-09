import assert from 'node:assert/strict';
import test from 'node:test';

import * as THREE from 'three';

import {
    coneAxisLeanFromVerticalDeg,
    coneKeepsContactHighest,
    isSideWallContact,
    MAX_SIDE_WALL_CONTACT_LEAN_DEG,
    resolveConeAxisPolicy,
} from '../PlacementLogic/ConeAxisPolicy';
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
/** A surface leaning `leanDeg` off vertical, facing downward. */
function leaningNormal(leanDeg: number) {
    const rad = (leanDeg * Math.PI) / 180;
    return { x: Math.sin(rad), y: 0, z: -Math.cos(rad) };
}

test('the cone lean a contact renders is measured on the resolved axis, not the normal', () => {
    // A flat ceiling: the cone points straight at the plate, however it is
    // resolved.
    for (const mode of ['normal', 'locked', 'adaptive'] as const) {
        assert.ok(
            coneAxisLeanFromVerticalDeg({ x: 0, y: 0, z: -1 }, mode) < 0.001,
            `${mode}: a ceiling cone is vertical`,
        );
    }

    // A near-vertical face. Under `normal` the axis is the normal, so an 80.8°
    // contact renders 80.8° off vertical — 9° above flat. Adaptive tilts the
    // axis toward the plate and the same contact measures 55.4°, which is the
    // difference between a whisker and a support.
    const wall = leaningNormal(80.8);
    assert.ok(Math.abs(coneAxisLeanFromVerticalDeg(wall, 'normal') - 80.8) < 0.05,
        'normal mode renders the normal');
    const adaptive = coneAxisLeanFromVerticalDeg(wall, 'adaptive');
    assert.ok(adaptive > 55 && adaptive < 56,
        `adaptive tilts the axis toward the plate (measured ${adaptive.toFixed(1)}°)`);
});

test('a contact whose cone renders within 15 degrees of flat is a side wall', () => {
    // 75° from vertical is the bound: 15° above flat. Inside it the contact
    // stands, past it the cone is a whisker.
    assert.equal(isSideWallContact(leaningNormal(MAX_SIDE_WALL_CONTACT_LEAN_DEG - 1), 'normal'), false,
        'just inside the bound the contact stands');
    assert.equal(isSideWallContact(leaningNormal(MAX_SIDE_WALL_CONTACT_LEAN_DEG + 1), 'normal'), true,
        'just past it the cone is refused');

    // The 80.8° minima side-wall contact the old 85° exemption kept.
    assert.equal(isSideWallContact(leaningNormal(80.8), 'normal'), true,
        'a cone 9° above flat is refused');
    // The same contact under adaptive renders at 55°, so it is not a side wall.
    assert.equal(isSideWallContact(leaningNormal(80.8), 'adaptive'), false,
        'adaptive renders the same contact steeply enough to keep');
    // And a genuine overhang is never touched, however steep.
    assert.equal(isSideWallContact({ x: 0, y: 0, z: -1 }, 'normal'), false);
    assert.equal(isSideWallContact(leaningNormal(45), 'normal'), false);
});

/** A cone `leanDeg` off vertical, socket `lengthMm` down the axis from the tip. */
function coneUnderTest(leanDeg: number, lengthMm: number, bodyDiameterMm: number) {
    const rad = (leanDeg * Math.PI) / 180;
    const tipPos = { x: 0, y: 0, z: 10 };
    const coneAxis = { x: Math.sin(rad), y: 0, z: -Math.cos(rad) };
    return {
        tipPos,
        coneAxis,
        socketPos: {
            x: tipPos.x + coneAxis.x * lengthMm,
            y: tipPos.y + coneAxis.y * lengthMm,
            z: tipPos.z + coneAxis.z * lengthMm,
        },
        bodyDiameterMm,
    };
}

test('a cone stays under its contact until its own socket end would rise over it', () => {
    // 3mm cone, 1.2mm body: the socket end rises `0.6 * sin(lean)` over a descent
    // of `3 * cos(lean)`, so the tip stays on top up to atan(3 / 0.6) = 78.7°.
    const bound = (Math.atan2(3, 0.6) * 180) / Math.PI;
    assert.ok(coneKeepsContactHighest(coneUnderTest(bound - 1, 3, 1.2)),
        'just inside the bound the contact is still the highest point');
    assert.equal(coneKeepsContactHighest(coneUnderTest(bound + 1, 3, 1.2)), false,
        'past it the socket end is over the tip');

    // Flat is over the tip whatever the body: at 90° the descent is zero and the
    // socket's own rim is a body radius above the contact.
    assert.equal(coneKeepsContactHighest(coneUnderTest(90, 3, 1.2)), false,
        'a cone lying flat is not a support');

    // And past flat the socket is above the tip outright — the geometry that
    // grows back up over its contact.
    assert.equal(coneKeepsContactHighest(coneUnderTest(97, 3, 1.2)), false,
        'a cone pointing up is refused by the same check');

    // Steep cones are never in question: this is what a support normally is.
    assert.ok(coneKeepsContactHighest(coneUnderTest(0, 3, 1.2)), 'a vertical cone keeps its tip on top');
    assert.ok(coneKeepsContactHighest(coneUnderTest(45, 3, 1.2)), 'so does the 45° shape');
    assert.ok(coneKeepsContactHighest(coneUnderTest(60, 2.5, 1.0)),
        'the adaptive wall cone (60° off vertical) keeps its tip on top');
});
