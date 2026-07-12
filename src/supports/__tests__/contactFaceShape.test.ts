import assert from 'node:assert/strict';
import test from 'node:test';

import type * as THREE from 'three';
import {
    CONTACT_FACE_MIN_RATIO,
    createContactDiskLoftGeometry,
    resolveContactDiskRadialSegments,
    resolveContactFaceShape,
} from '../SupportPrimitives/ContactDisk/contactDiskUtils';
import { commitContactFaceShape, normalizeContactFaceAngle } from '../SupportPrimitives/ContactDisk/contactFaceActions';
import { getSnapshot, loadFromImportFormat, resetStore } from '../state';
import type { DragonfruitImportFormat } from '../types';

function almostEqual(a: number, b: number, epsilon = 1e-6): boolean {
    return Math.abs(a - b) <= epsilon;
}

/** Max |x| and |z| across loft vertices lying (within eps) on the given Y plane. */
function ringExtents(geometry: THREE.BufferGeometry, y: number, eps = 1e-4): { maxAbsX: number; maxAbsZ: number } {
    const position = geometry.getAttribute('position');
    let maxAbsX = 0;
    let maxAbsZ = 0;
    for (let i = 0; i < position.count; i += 1) {
        if (Math.abs(position.getY(i) - y) > eps) continue;
        maxAbsX = Math.max(maxAbsX, Math.abs(position.getX(i)));
        maxAbsZ = Math.max(maxAbsZ, Math.abs(position.getZ(i)));
    }
    return { maxAbsX, maxAbsZ };
}

test('resolveContactFaceShape defaults to a circle and clamps the ratio', () => {
    assert.deepEqual(resolveContactFaceShape(undefined), { ratio: 1, angleRad: 0 });
    assert.deepEqual(resolveContactFaceShape({}), { ratio: 1, angleRad: 0 });
    assert.deepEqual(resolveContactFaceShape({ contactFaceRatio: 0.5, contactFaceAngleRad: 0.7 }), { ratio: 0.5, angleRad: 0.7 });
    assert.equal(resolveContactFaceShape({ contactFaceRatio: 0.05 }).ratio, CONTACT_FACE_MIN_RATIO);
    assert.equal(resolveContactFaceShape({ contactFaceRatio: 1.8 }).ratio, 1);
    assert.equal(resolveContactFaceShape({ contactFaceRatio: Number.NaN }).ratio, 1);
    assert.equal(resolveContactFaceShape({ contactFaceAngleRad: Number.NaN }).angleRad, 0);
});

test('normalizeContactFaceAngle wraps into [0, π)', () => {
    assert.ok(almostEqual(normalizeContactFaceAngle(Math.PI / 2), Math.PI / 2));
    assert.ok(almostEqual(normalizeContactFaceAngle(Math.PI + 0.3), 0.3));
    assert.ok(almostEqual(normalizeContactFaceAngle(-0.2), Math.PI - 0.2));
    assert.equal(normalizeContactFaceAngle(Number.NaN), 0);
});

test('resolveContactDiskRadialSegments upgrades only squished discs', () => {
    // Untouched circles keep the caller's base tessellation.
    assert.equal(resolveContactDiskRadialSegments(24, 1), 24);
    assert.equal(resolveContactDiskRadialSegments(16, 1), 16);
    assert.equal(resolveContactDiskRadialSegments(12, 1), 12);
    assert.equal(resolveContactDiskRadialSegments(8, 1), 8);
    // Ovals always get the fine wall: 24, or 12 in low-detail contexts.
    assert.equal(resolveContactDiskRadialSegments(24, 0.5), 24);
    assert.equal(resolveContactDiskRadialSegments(16, 0.5), 24);
    assert.equal(resolveContactDiskRadialSegments(12, 0.5), 24);
    assert.equal(resolveContactDiskRadialSegments(8, 0.5), 12);
});

test('loft geometry: full oval through the penetration zone, circle at the tip', () => {
    // radius 1, ratio 0.5, thickness 0.4, penetration 0.2 → height 0.6
    // rings: bottom y=-0.3 (oval), surface y=-0.1 (oval), top y=+0.3 (circle)
    const loft = createContactDiskLoftGeometry({
        radius: 1,
        ratio: 0.5,
        thickness: 0.4,
        penetrationMm: 0.2,
        radialSegments: 8,
    });

    const bottom = ringExtents(loft, -0.3);
    assert.ok(almostEqual(bottom.maxAbsX, 0.5), `bottom squished axis: ${bottom.maxAbsX}`);
    assert.ok(almostEqual(bottom.maxAbsZ, 1), `bottom full axis: ${bottom.maxAbsZ}`);

    const surface = ringExtents(loft, -0.1);
    assert.ok(almostEqual(surface.maxAbsX, 0.5), `surface squished axis: ${surface.maxAbsX}`);
    assert.ok(almostEqual(surface.maxAbsZ, 1), `surface full axis: ${surface.maxAbsZ}`);

    // Squished lofts wrap the tip ball with a circumscribed polygon
    // (radius / cos(π/segments) + slack) so faceted ball meshes never poke
    // through the faceted wall — the top rim is that inflated circle.
    const hugR = 1 / Math.cos(Math.PI / 8) + 0.002;
    const top = ringExtents(loft, 0.3);
    assert.ok(almostEqual(top.maxAbsX, hugR), `top is circular: ${top.maxAbsX}`);
    assert.ok(almostEqual(top.maxAbsZ, hugR), `top is circular: ${top.maxAbsZ}`);

    loft.dispose();
});

test('loft geometry: ratio 1 reproduces a plain cylinder profile', () => {
    const loft = createContactDiskLoftGeometry({
        radius: 0.2,
        ratio: 1,
        thickness: 0.1,
        penetrationMm: 0.1,
        radialSegments: 8,
    });
    const bottom = ringExtents(loft, -0.1);
    const top = ringExtents(loft, 0.1);
    assert.ok(almostEqual(bottom.maxAbsX, 0.2));
    assert.ok(almostEqual(bottom.maxAbsZ, 0.2));
    assert.ok(almostEqual(top.maxAbsX, 0.2));
    loft.dispose();
});

test('loft geometry: zero penetration degenerates to a single oval→circle blend', () => {
    const loft = createContactDiskLoftGeometry({
        radius: 1,
        ratio: 0.5,
        thickness: 0.4,
        penetrationMm: 0,
        radialSegments: 8,
    });
    const bottom = ringExtents(loft, -0.2);
    const top = ringExtents(loft, 0.2);
    assert.ok(almostEqual(bottom.maxAbsX, 0.5));
    // Top rim = ball-circumscribing polygon radius (see the tangency test above).
    assert.ok(almostEqual(top.maxAbsX, 1 / Math.cos(Math.PI / 8) + 0.002));
    loft.dispose();
});

const DISK_PROFILE = {
    type: 'disk' as const,
    diskThicknessMm: 0.1,
    maxStandoffMm: 0.25,
    standoffAngleThreshold: Math.PI / 4,
};

const TIP_PROFILE = {
    type: 'disk' as const,
    contactDiameterMm: 0.4,
    bodyDiameterMm: 1.2,
    lengthMm: 2,
    penetrationMm: 0.05,
    diskThicknessMm: 0.1,
    maxStandoffMm: 0.25,
    standoffAngleThreshold: Math.PI / 4,
};

function loadShapeTestState() {
    resetStore();
    const data: DragonfruitImportFormat = {
        version: 1,
        meta: { source: 'unit-test', objectCenter: { x: 0, y: 0, z: 0 } },
        roots: [],
        trunks: [],
        branches: [],
        leaves: [],
        twigs: [
            {
                id: 'twig-1',
                modelId: 'model-1',
                segments: [
                    {
                        id: 'twig-seg',
                        type: 'straight',
                        diameter: 0.4,
                        bottomJoint: { id: 'twig-ja', pos: { x: 0, y: 0, z: 0.2 }, diameter: 0.45 },
                        topJoint: { id: 'twig-jb', pos: { x: 5, y: 0, z: 0.2 }, diameter: 0.45 },
                    },
                ],
                contactDiskA: {
                    id: 'twig-disk-a',
                    pos: { x: 0, y: 0, z: 0 },
                    surfaceNormal: { x: 0, y: 0, z: 1 },
                    coneAxis: { x: 0, y: 0, z: 1 },
                    profile: DISK_PROFILE,
                    contactDiameterMm: 0.4,
                },
                contactDiskB: {
                    id: 'twig-disk-b',
                    pos: { x: 5, y: 0, z: 0 },
                    surfaceNormal: { x: 0, y: 0, z: 1 },
                    coneAxis: { x: 0, y: 0, z: 1 },
                    profile: DISK_PROFILE,
                    contactDiameterMm: 0.4,
                },
            },
        ],
        sticks: [
            {
                id: 'stick-1',
                modelId: 'model-1',
                segments: [
                    {
                        id: 'stick-seg',
                        type: 'straight',
                        diameter: 0.4,
                        bottomJoint: { id: 'stick-ja', pos: { x: 0, y: 2, z: 2 }, diameter: 0.45 },
                        topJoint: { id: 'stick-jb', pos: { x: 5, y: 2, z: 2 }, diameter: 0.45 },
                    },
                ],
                contactConeA: {
                    id: 'stick-cone-a',
                    pos: { x: 0, y: 2, z: 0 },
                    normal: { x: 0, y: 0, z: 1 },
                    surfaceNormal: { x: 0, y: 0, z: 1 },
                    profile: TIP_PROFILE,
                },
                contactConeB: {
                    id: 'stick-cone-b',
                    pos: { x: 5, y: 2, z: 0 },
                    normal: { x: 0, y: 0, z: 1 },
                    surfaceNormal: { x: 0, y: 0, z: 1 },
                    profile: TIP_PROFILE,
                },
            },
        ],
        braces: [],
        knots: [],
    };
    loadFromImportFormat(data);
}

test('commitContactFaceShape resolves twig B-slot, clamps and normalizes, keeps A untouched', () => {
    loadShapeTestState();

    assert.equal(commitContactFaceShape('twig-disk-b', 0.5, Math.PI + 0.3), true);
    const twig = getSnapshot().twigs['twig-1'];
    assert.equal(twig.contactDiskB.contactFaceRatio, 0.5);
    assert.ok(almostEqual(twig.contactDiskB.contactFaceAngleRad ?? Number.NaN, 0.3));
    assert.equal(twig.contactDiskA.contactFaceRatio, undefined);
});

test('commitContactFaceShape resolves stick A-slot with ratio clamped to the floor', () => {
    loadShapeTestState();

    assert.equal(commitContactFaceShape('stick-cone-a', 0.05, -0.2), true);
    const stick = getSnapshot().sticks['stick-1'];
    assert.equal(stick.contactConeA.contactFaceRatio, CONTACT_FACE_MIN_RATIO);
    assert.ok(almostEqual(stick.contactConeA.contactFaceAngleRad ?? Number.NaN, Math.PI - 0.2));
    assert.equal(stick.contactConeB.contactFaceRatio, undefined);
});

test('commitContactFaceShape returns false for unknown ids without mutating state', () => {
    loadShapeTestState();
    const before = getSnapshot();
    assert.equal(commitContactFaceShape('no-such-disk', 0.5, 0), false);
    assert.equal(getSnapshot(), before);
});
