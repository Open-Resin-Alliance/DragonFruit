import assert from 'node:assert/strict';
import test, { beforeEach } from 'node:test';
import * as THREE from 'three';

import { initializeBVH, accelerateGeometry } from '../../utils/bvh';
import { getJointRadius } from '../constants';
import type { TrunkPlacementResult } from '../PlacementLogic/StandardPlacement';
import { setSettings } from '../Settings/state';
import { createDefaultSettings } from '../Settings/types';
import { getContactConeLowestZ, getFinalSocketPosition } from '../SupportPrimitives/ContactCone/contactConeUtils';
import type { ContactCone } from '../SupportPrimitives/ContactCone/types';
import {
    buildTrunkData,
    buildTrunkDataFromPlacement,
    type TrunkBuildInput,
    type TrunkBuildResult,
} from '../SupportTypes/Trunk/trunkBuilder';
import type { LimitationCode } from '../types';

beforeEach(() => {
    const settings = createDefaultSettings();
    settings.grid.enabled = false;
    settings.tip.coneAngleMode = 'normal';
    settings.tip.contactDiameterMm = 0.2;
    settings.tip.bodyDiameterMm = 0.4;
    settings.tip.diskThicknessMm = 0.1;
    settings.tip.maxStandoffMm = 0.35;
    settings.shaft.diameterMm = 0.4;
    settings.roots.diskHeightMm = 0.2;
    settings.roots.coneHeightMm = 0.3;
    setSettings(settings);
});

function input(overrides: Partial<TrunkBuildInput> = {}): TrunkBuildInput {
    return {
        tipPos: { x: 0, y: 0, z: 5 },
        tipNormal: { x: 0, y: 0, z: -1 },
        modelId: 'plate-bounds',
        overrides: { tipLengthMm: 6 },
        ...overrides,
    };
}

function placement(overrides: Partial<TrunkPlacementResult> = {}): TrunkPlacementResult {
    return {
        basePos: { x: 0, y: 0, z: 0 },
        socketPos: { x: 0, y: 0, z: -1.1 },
        joints: [],
        constructionJoints: [],
        ...overrides,
    };
}

function assertError(built: TrunkBuildResult, error: LimitationCode | undefined): void {
    assert.equal(built.error, error);
    assert.equal(built.supportData.error, error);
    assert.equal(built.route.error, error);
    assert.equal(built.route.validity, error ? 'hard_invalid' : 'valid');
    if ('snappedValidity' in built.route) {
        assert.equal(built.route.snappedValidity, error ? 'hard_invalid' : 'valid');
    }
}

function cone(overrides: Partial<ContactCone> = {}): ContactCone {
    return {
        id: 'cone-bounds',
        pos: { x: 0, y: 0, z: 2 },
        normal: { x: 0, y: 0, z: -1 },
        profile: {
            type: 'disk',
            contactDiameterMm: 0.2,
            bodyDiameterMm: 0.4,
            lengthMm: 1,
            penetrationMm: 0,
            diskThicknessMm: 0.1,
            maxStandoffMm: 0.35,
            standoffAngleThreshold: Math.PI / 4,
        },
        ...overrides,
    };
}

function close(actual: number, expected: number): void {
    assert.ok(Math.abs(actual - expected) < 1e-10, `${actual} != ${expected}`);
}

test('5 mm contact with a 6 mm cone is refused without shortening or moving geometry', () => {
    const request = input();
    const original = structuredClone(request);
    const built = buildTrunkData(request);

    assertError(built, 'OUT_OF_BOUNDS');
    close(built.trunk.contactCone!.profile.lengthMm, 6);
    close(built.route.socketPos.z, -1.1);
    assert.deepEqual(built.trunk.contactCone!.pos, original.tipPos);
    assert.deepEqual(built.root.transform.pos, { x: 0, y: 0, z: 0 });
    assert.deepEqual(getFinalSocketPosition(built.trunk.contactCone!), built.route.socketPos);
    assert.deepEqual(request, original);
    assertError(buildTrunkData(input({ overrides: { tipLengthMm: 3 } })), undefined);
});

test('preview and click enforce the same final geometry bound with and without a mesh', () => {
    initializeBVH();
    const geometry = new THREE.BoxGeometry(2, 2, 2);
    accelerateGeometry(geometry);
    const mesh = new THREE.Mesh(geometry, new THREE.MeshBasicMaterial());
    // Keep model collision out of this test: exercise the mesh-backed builder,
    // while isolating the independent world-plate constraint.
    mesh.position.set(100, 0, 6);
    mesh.updateMatrixWorld(true);
    try {
        for (const collisionMesh of [undefined, mesh]) {
            for (const length of [6, 3]) {
                const request = input({ mesh: collisionMesh, overrides: { tipLengthMm: length } });
                const preview = buildTrunkData({ ...request, isPreview: true });
                const click = buildTrunkData({ ...request, isPreview: false });
                const expected = length === 6 ? 'OUT_OF_BOUNDS' : undefined;
                assertError(preview, expected);
                assertError(click, expected);
                assert.deepEqual(preview.route.socketPos, click.route.socketPos);
                assert.deepEqual(preview.trunk.contactCone!.profile, click.trunk.contactCone!.profile);
                assert.deepEqual(preview.trunk.contactCone!.normal, click.trunk.contactCone!.normal);
            }
        }
    } finally {
        geometry.dispose();
        (mesh.material as THREE.Material).dispose();
    }
});

test('the final solver-authored tilted rim is checked, not the nominal cone or socket centre', () => {
    const request = input({
        tipNormal: { x: 1, y: 0, z: 0 },
        overrides: { tipLengthMm: 0.5, tipBodyDiameterMm: 2, shaftDiameterMm: 0.1 },
    });
    const authored = placement({ socketPos: { x: 3, y: 0, z: 0.4 } });
    const originalInput = structuredClone(request);
    const originalPlacement = structuredClone(authored);
    const built = buildTrunkDataFromPlacement(request, authored);

    assert.ok(built.route.socketPos.z > getJointRadius(0.1));
    assert.ok(getContactConeLowestZ(built.trunk.contactCone!) < 0);
    assert.ok(built.trunk.contactCone!.profile.lengthMm > request.overrides!.tipLengthMm!);
    assertError(built, 'OUT_OF_BOUNDS');
    assert.deepEqual(request, originalInput);
    assert.deepEqual(authored, originalPlacement);
    close(built.route.socketPos.x, authored.socketPos.x);
    close(built.route.socketPos.z, authored.socketPos.z);
});

test('a socket joint below the plate is refused even when the whole cone clears it', () => {
    const built = buildTrunkDataFromPlacement(input(), placement({ socketPos: { x: 0, y: 0, z: 0.2 } }));
    assert.ok(getContactConeLowestZ(built.trunk.contactCone!) > 0);
    assert.ok(built.route.socketPos.z > 0);
    const socketJoint = built.trunk.segments.at(-1)!.topJoint!;
    assert.ok(socketJoint.pos.z - socketJoint.diameter / 2 < 0);
    assertError(built, 'OUT_OF_BOUNDS');
});

test('tangent socket joints and sub-micron roundoff are allowed, deeper crossings are not', () => {
    const radius = getJointRadius(0.4);
    for (const delta of [0, 0.5e-6, -0.5e-6, -2e-6]) {
        const built = buildTrunkDataFromPlacement(input(), placement({
            socketPos: { x: 0, y: 0, z: radius + delta },
            snappedNodeKey: '0,0',
            unsnappedBottomPos: { x: 0, y: 0, z: 0 },
        }));
        assertError(built, delta < -1e-6 ? 'OUT_OF_BOUNDS' : undefined);
    }
});

test('existing placement errors keep precedence, including on snapped routes', () => {
    for (const error of ['ANGLE_TOO_STEEP', 'COLLISION_WITH_MODEL'] as const) {
        const built = buildTrunkDataFromPlacement(input(), placement({
            error,
            snappedNodeKey: '0,0',
        }));

        assert.ok(getContactConeLowestZ(built.trunk.contactCone!) < 0);
        assertError(built, error);
    }
});

test('the plate bound follows final authored geometry rather than the nominal profile', () => {
    const request = input({ overrides: { tipLengthMm: 6, tipDiskLengthOverrideMm: 0.75 } });
    const authored = placement({ socketPos: { x: 0, y: 0, z: 0.4 } });
    const built = buildTrunkDataFromPlacement(request, authored);
    const finalCone = built.trunk.contactCone!;

    // The existing disk recomputation resolves the standoff against the fixed
    // socket. Classify that resulting geometry, not the input's nominal cone.
    close(getContactConeLowestZ(finalCone), 0.4);
    close(built.route.socketPos.z, authored.socketPos.z);
    assert.equal(request.overrides!.tipDiskLengthOverrideMm, 0.75);
    assertError(built, undefined);
});

test('cone bounds include the tilted body rim, round contact tip and disk rim', () => {
    const horizontal = cone({ normal: { x: 1, y: 0, z: 0 }, pos: { x: 0, y: 0, z: 0.15 } });
    close(getContactConeLowestZ(horizontal), -0.05);
    const legacy = cone({ profile: { ...horizontal.profile, type: undefined }, pos: { x: 0, y: 0, z: 0.05 } });
    close(getContactConeLowestZ(legacy), -0.95);
    const roundTip = cone({
        normal: { x: 0, y: 0, z: 1 },
        diskLengthOverride: 0,
        pos: { x: 0, y: 0, z: 0.05 },
    });
    close(getContactConeLowestZ(roundTip), -0.05);
    const diskRim = cone({
        normal: { x: 0, y: 0, z: 1 },
        surfaceNormal: { x: Math.sqrt(0.75), y: 0, z: 0.5 },
        pos: { x: 0, y: 0, z: 0.05 },
        diskLengthOverride: 1,
    });
    close(getContactConeLowestZ(diskRim), 0.05 - 0.1 * Math.sqrt(0.75));
});

test('cone bounds respect the actual disk standoff override, fallback normal and penetration', () => {
    const down = cone({ pos: { x: 0, y: 0, z: 1.5 } });
    close(getContactConeLowestZ(down), 0.4);
    close(getContactConeLowestZ({ ...down, diskLengthOverride: 0.75 }), -0.25);
    const up = cone({
        normal: { x: 0, y: 0, z: 1 },
        pos: { x: 0, y: 0, z: 0.02 },
        profile: { ...down.profile, penetrationMm: 0.05 },
    });
    close(getContactConeLowestZ(up), -0.03);
    const sphere = cone({
        normal: { x: 0, y: 0, z: 1 },
        pos: { x: 0, y: 0, z: 0.1 },
        diskLengthOverride: 10,
        profile: { ...down.profile, type: 'sphere', sphereRadiusRatio: 1.5 },
    });
    close(getContactConeLowestZ(sphere), 0);
});
