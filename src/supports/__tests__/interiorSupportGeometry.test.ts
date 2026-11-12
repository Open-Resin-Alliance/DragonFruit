import assert from 'node:assert/strict';
import test from 'node:test';

import * as THREE from 'three';
import { MeshBVH } from 'three-mesh-bvh';

import { createCavityTester, isInteriorContact } from '../interiorSupportGeometry';
import { createDefaultSettings } from '../Settings/types';
import { setSettings } from '../Settings/state';
import { buildStick } from '../SupportTypes/Stick/stickBuilder';
import { buildTwig } from '../SupportTypes/Twig/twigBuilder';

function assertVecClose(
    actual: { x: number; y: number; z: number },
    expected: { x: number; y: number; z: number },
    label: string,
    eps = 1e-9,
): void {
    assert.ok(Math.abs(actual.x - expected.x) <= eps, `${label}.x: ${actual.x} vs ${expected.x}`);
    assert.ok(Math.abs(actual.y - expected.y) <= eps, `${label}.y: ${actual.y} vs ${expected.y}`);
    assert.ok(Math.abs(actual.z - expected.z) <= eps, `${label}.z: ${actual.z} vs ${expected.z}`);
}

/** A single triangle in the z=0 plane with its face normal along +z. */
function planeGeometry(): THREE.BufferGeometry {
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute('position', new THREE.Float32BufferAttribute([
        0, 0, 0,
        10, 0, 0,
        0, 10, 0,
    ], 3));
    geometry.computeVertexNormals();
    (geometry as THREE.BufferGeometry & { boundsTree?: unknown }).boundsTree = new MeshBVH(geometry);
    return geometry;
}

test('an unstamped point is classified against the cavity wall, not assumed visible', () => {
    const geometry = planeGeometry();
    const cavity = createCavityTester(new Map([['m', geometry]]));

    assert.equal(cavity.isOnInteriorSide({ x: 1, y: 1, z: 2 }), true, 'cavity side of the wall');
    assert.equal(cavity.isOnInteriorSide({ x: 1, y: 1, z: -0.5 }), true, 'within the shell thickness of the wall');
    assert.equal(cavity.isOnInteriorSide({ x: 1, y: 1, z: -5 }), false, 'outside the shell on the solid side');
    assert.equal(cavity.isInsideVoid({ x: 1, y: 1, z: 2 }), true, 'strict void side');
    assert.equal(cavity.isInsideVoid({ x: 1, y: 1, z: -0.5 }), false, 'near the wall is not the void');
});

test('a stamped placement surface wins over the geometry', () => {
    const geometry = planeGeometry();
    const cavity = createCavityTester(new Map([['m', geometry]]));

    assert.equal(isInteriorContact({ pos: { x: 1, y: 1, z: 2 }, placementSurface: 'exterior' }, 'm', cavity.isOnInteriorSide), false);
    assert.equal(isInteriorContact({ pos: { x: 1, y: 1, z: -5 }, placementSurface: 'interior' }, 'm', cavity.isOnInteriorSide), true);
    assert.equal(isInteriorContact({ pos: { x: 1, y: 1, z: 2 } }, 'm', cavity.isOnInteriorSide), true,
        'no stamp goes to the cavity test');
});

test('no cavity geometry means no point is classified interior', () => {
    const cavity = createCavityTester(new Map());
    assert.equal(cavity.isOnInteriorSide({ x: 0, y: 0, z: 0 }), false);
    assert.equal(cavity.isInsideVoid({ x: 0, y: 0, z: 0 }), false);
});

test('buildTwig canonicalizes contactDiskA/B and segment bottom/top joints into lower-to-upper Z order', () => {
    setSettings(createDefaultSettings());

    const upperFirst = buildTwig({
        modelId: 'm',
        aPos: { x: 2, y: 3, z: 14 },
        aNormal: { x: 0, y: 0, z: -1 },
        bPos: { x: 2, y: 3, z: 10 },
        bNormal: { x: 0, y: 0, z: 1 },
    }).twig;

    const lowerFirst = buildTwig({
        modelId: 'm',
        aPos: { x: 2, y: 3, z: 10 },
        aNormal: { x: 0, y: 0, z: 1 },
        bPos: { x: 2, y: 3, z: 14 },
        bNormal: { x: 0, y: 0, z: -1 },
    }).twig;

    for (const [label, twig] of [['upperFirst', upperFirst], ['lowerFirst', lowerFirst]] as const) {
        assert.equal(twig.contactDiskA.pos.z, 10, `${label}: contactDiskA is lower Z`);
        assert.equal(twig.contactDiskB.pos.z, 14, `${label}: contactDiskB is upper Z`);
        const seg = twig.segments[0];
        assert.ok(seg.bottomJoint && seg.topJoint, `${label}: segment carries both joints`);
        assert.ok(
            seg.bottomJoint.pos.z < seg.topJoint.pos.z,
            `${label}: bottomJoint.pos.z (${seg.bottomJoint.pos.z}) < topJoint.pos.z (${seg.topJoint.pos.z})`,
        );
        const expectedBottomZ = twig.contactDiskA.pos.z
            + twig.contactDiskA.surfaceNormal.z * (twig.contactDiskA.diskLengthOverride ?? 0);
        const expectedTopZ = twig.contactDiskB.pos.z
            + twig.contactDiskB.surfaceNormal.z * (twig.contactDiskB.diskLengthOverride ?? 0);
        assert.ok(Math.abs(seg.bottomJoint.pos.z - expectedBottomZ) <= 1e-9, `${label}: bottomJoint matches contactDiskA`);
        assert.ok(Math.abs(seg.topJoint.pos.z - expectedTopZ) <= 1e-9, `${label}: topJoint matches contactDiskB`);
    }

    assertVecClose(upperFirst.contactDiskA.pos, lowerFirst.contactDiskA.pos, 'contactDiskA.pos');
    assertVecClose(upperFirst.contactDiskB.pos, lowerFirst.contactDiskB.pos, 'contactDiskB.pos');
    assertVecClose(upperFirst.contactDiskA.surfaceNormal, lowerFirst.contactDiskA.surfaceNormal, 'contactDiskA.surfaceNormal');
    assertVecClose(upperFirst.contactDiskB.surfaceNormal, lowerFirst.contactDiskB.surfaceNormal, 'contactDiskB.surfaceNormal');
    assertVecClose(upperFirst.contactDiskA.coneAxis, lowerFirst.contactDiskA.coneAxis, 'contactDiskA.coneAxis');
    assertVecClose(upperFirst.contactDiskB.coneAxis, lowerFirst.contactDiskB.coneAxis, 'contactDiskB.coneAxis');
    assertVecClose(upperFirst.segments[0].bottomJoint!.pos, lowerFirst.segments[0].bottomJoint!.pos, 'bottomJoint.pos');
    assertVecClose(upperFirst.segments[0].topJoint!.pos, lowerFirst.segments[0].topJoint!.pos, 'topJoint.pos');

    // Equal-Z deterministic tie-breaking by Y then X
    const tieSwapped = buildTwig({
        modelId: 'm',
        aPos: { x: 4, y: 5, z: 10 },
        aNormal: { x: -1, y: 0, z: 0 },
        bPos: { x: 1, y: 2, z: 10 },
        bNormal: { x: 1, y: 0, z: 0 },
    }).twig;
    const tieOrdered = buildTwig({
        modelId: 'm',
        aPos: { x: 1, y: 2, z: 10 },
        aNormal: { x: 1, y: 0, z: 0 },
        bPos: { x: 4, y: 5, z: 10 },
        bNormal: { x: -1, y: 0, z: 0 },
    }).twig;

    assertVecClose(tieSwapped.contactDiskA.pos, { x: 1, y: 2, z: 10 }, 'tieSwapped contactDiskA.pos');
    assertVecClose(tieSwapped.contactDiskB.pos, { x: 4, y: 5, z: 10 }, 'tieSwapped contactDiskB.pos');
    assertVecClose(tieSwapped.contactDiskA.pos, tieOrdered.contactDiskA.pos, 'tie contactDiskA.pos');
    assertVecClose(tieSwapped.contactDiskB.pos, tieOrdered.contactDiskB.pos, 'tie contactDiskB.pos');
    assertVecClose(tieSwapped.contactDiskA.coneAxis, tieOrdered.contactDiskA.coneAxis, 'tie contactDiskA.coneAxis');
    assertVecClose(tieSwapped.contactDiskB.coneAxis, tieOrdered.contactDiskB.coneAxis, 'tie contactDiskB.coneAxis');
    assertVecClose(tieSwapped.segments[0].bottomJoint!.pos, tieOrdered.segments[0].bottomJoint!.pos, 'tie bottomJoint.pos');
    assertVecClose(tieSwapped.segments[0].topJoint!.pos, tieOrdered.segments[0].topJoint!.pos, 'tie topJoint.pos');
});

test('buildStick canonicalizes contactConeA/B and segment bottom/top joints into lower-to-upper Z order', () => {
    setSettings(createDefaultSettings());

    const upperFirst = buildStick({
        modelId: 'm',
        aPos: { x: 2, y: 3, z: 22 },
        aNormal: { x: 0, y: 0, z: -1 },
        bPos: { x: 2, y: 3, z: 10 },
        bNormal: { x: 0, y: 0, z: 1 },
    }).stick;

    const lowerFirst = buildStick({
        modelId: 'm',
        aPos: { x: 2, y: 3, z: 10 },
        aNormal: { x: 0, y: 0, z: 1 },
        bPos: { x: 2, y: 3, z: 22 },
        bNormal: { x: 0, y: 0, z: -1 },
    }).stick;

    for (const [label, stick] of [['upperFirst', upperFirst], ['lowerFirst', lowerFirst]] as const) {
        assert.equal(stick.contactConeA.pos.z, 10, `${label}: contactConeA is lower Z`);
        assert.equal(stick.contactConeB.pos.z, 22, `${label}: contactConeB is upper Z`);
        const seg = stick.segments[0];
        assert.ok(seg.bottomJoint && seg.topJoint, `${label}: segment carries both joints`);
        assert.equal(seg.bottomJoint.id, stick.contactConeA.socketJointId, `${label}: bottomJoint matches contactConeA.socketJointId`);
        assert.equal(seg.topJoint.id, stick.contactConeB.socketJointId, `${label}: topJoint matches contactConeB.socketJointId`);
        assert.ok(
            seg.bottomJoint.pos.z < seg.topJoint.pos.z,
            `${label}: bottomJoint.pos.z (${seg.bottomJoint.pos.z}) < topJoint.pos.z (${seg.topJoint.pos.z})`,
        );

        const upperCone = stick.contactConeB;
        const upperSocketZ = upperCone.pos.z
            + (upperCone.surfaceNormal?.z ?? 0) * (upperCone.diskLengthOverride ?? 0)
            + upperCone.normal.z * upperCone.profile.lengthMm;
        assert.ok(
            upperSocketZ <= upperCone.pos.z,
            `${label}: upper cone socket Z (${upperSocketZ}) does not protrude above contact (${upperCone.pos.z})`,
        );
    }

    assertVecClose(upperFirst.contactConeA.pos, lowerFirst.contactConeA.pos, 'contactConeA.pos');
    assertVecClose(upperFirst.contactConeB.pos, lowerFirst.contactConeB.pos, 'contactConeB.pos');
    assertVecClose(upperFirst.contactConeA.normal, lowerFirst.contactConeA.normal, 'contactConeA.normal');
    assertVecClose(upperFirst.contactConeB.normal, lowerFirst.contactConeB.normal, 'contactConeB.normal');
    assertVecClose(upperFirst.segments[0].bottomJoint!.pos, lowerFirst.segments[0].bottomJoint!.pos, 'bottomJoint.pos');
    assertVecClose(upperFirst.segments[0].topJoint!.pos, lowerFirst.segments[0].topJoint!.pos, 'topJoint.pos');
});
