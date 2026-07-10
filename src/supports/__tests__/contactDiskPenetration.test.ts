import assert from 'node:assert/strict';
import test from 'node:test';

import * as THREE from 'three';
import {
    calculateDiskThickness,
    getContactDiskGeometrySpec,
    resolveDiskPenetrationMm,
} from '../SupportPrimitives/ContactDisk/contactDiskUtils';
import type { ContactDiskProfile } from '../SupportPrimitives/ContactCone/types';
import { SupportGeometryGenerator } from '@/features/export/logic/SupportGeometryGenerator';
import { buildTwig } from '../SupportTypes/Twig/twigBuilder';
import { getSettings } from '../Settings';

function almostEqual(a: number, b: number, epsilon = 1e-6): boolean {
    return Math.abs(a - b) <= epsilon;
}

const DISK_PROFILE: ContactDiskProfile = {
    type: 'disk',
    diskThicknessMm: 0.1,
    maxStandoffMm: 0.25,
    standoffAngleThreshold: Math.PI / 4,
};

const UP = { x: 0, y: 0, z: 1 };
const POS = { x: 1, y: 2, z: 3 };

test('resolveDiskPenetrationMm resolves explicit → profile → 0 and never returns negatives', () => {
    assert.equal(resolveDiskPenetrationMm({ penetrationMm: 0.3 }, 0.5), 0.5);
    assert.equal(resolveDiskPenetrationMm({ penetrationMm: 0.3 }), 0.3);
    assert.equal(resolveDiskPenetrationMm({}), 0);
    assert.equal(resolveDiskPenetrationMm(undefined), 0);
    assert.equal(resolveDiskPenetrationMm({ penetrationMm: -1 }), 0);
    assert.equal(resolveDiskPenetrationMm({ penetrationMm: Number.NaN }), 0);
});

test('spec with zero penetration matches the legacy disk layout', () => {
    const spec = getContactDiskGeometrySpec({
        pos: POS,
        surfaceNormal: UP,
        coneAxis: UP,
        profile: DISK_PROFILE,
        contactDiameterMm: 0.4,
    });

    const thickness = calculateDiskThickness(UP, UP, DISK_PROFILE);
    assert.equal(spec.thickness, thickness);
    assert.equal(spec.penetrationMm, 0);
    assert.equal(spec.height, thickness);
    assert.equal(spec.radius, 0.2);
    assert.ok(almostEqual(spec.center.z, POS.z + thickness / 2));
    assert.ok(almostEqual(spec.tipCenter.z, POS.z + thickness));
});

test('penetration extends the disk into the model and keeps the tip center fixed', () => {
    const profile: ContactDiskProfile = { ...DISK_PROFILE, penetrationMm: 0.3 };
    const spec = getContactDiskGeometrySpec({
        pos: POS,
        surfaceNormal: UP,
        coneAxis: UP,
        profile,
        contactDiameterMm: 0.4,
    });

    assert.ok(almostEqual(spec.height, spec.thickness + 0.3));
    assert.ok(almostEqual(spec.center.z, POS.z + (spec.thickness - 0.3) / 2));
    // Bottom of the cylinder is embedded by exactly the penetration depth…
    assert.ok(almostEqual(spec.center.z - spec.height / 2, POS.z - 0.3));
    // …while the cone-side tip never moves.
    assert.ok(almostEqual(spec.tipCenter.z, POS.z + spec.thickness));
});

test('explicit penetration argument overrides the profile value', () => {
    const profile: ContactDiskProfile = { ...DISK_PROFILE, penetrationMm: 0.3 };
    const spec = getContactDiskGeometrySpec({
        pos: POS,
        surfaceNormal: UP,
        coneAxis: UP,
        profile,
        contactDiameterMm: 0.4,
        penetrationMm: 0.1,
    });

    assert.equal(spec.penetrationMm, 0.1);
    assert.ok(almostEqual(spec.height, spec.thickness + 0.1));
});

test('overrideThickness wins over the computed standoff thickness', () => {
    const spec = getContactDiskGeometrySpec({
        pos: POS,
        surfaceNormal: UP,
        coneAxis: UP,
        profile: DISK_PROFILE,
        contactDiameterMm: 0.4,
        overrideThickness: 0.5,
    });

    assert.equal(spec.thickness, 0.5);
    assert.ok(almostEqual(spec.tipCenter.z, POS.z + 0.5));
});

test('export disk mesh embeds by the penetration depth with a fixed tip sphere', () => {
    // Downward-facing contact hanging at z=10 with 0.2mm penetration.
    const diskGroup = SupportGeometryGenerator.generateContactDiskMesh({
        pos: { x: 0, y: 0, z: 10 },
        normal: { x: 0, y: 0, z: -1 },
        surfaceNormal: { x: 0, y: 0, z: -1 },
        diskLengthOverride: 0.5,
        profile: {
            type: 'disk',
            contactDiameterMm: 0.4,
            bodyDiameterMm: 1.2,
            lengthMm: 2,
            penetrationMm: 0.2,
            diskThicknessMm: 0.1,
            maxStandoffMm: 0.2,
            standoffAngleThreshold: Math.PI / 4,
        },
    });

    diskGroup.updateMatrixWorld(true);

    const cylinder = diskGroup.children.find(
        (child) => (child as THREE.Mesh).geometry?.type === 'CylinderGeometry',
    ) as THREE.Mesh | undefined;
    assert.ok(cylinder, 'expected a disk cylinder in the export group');
    const cylinderParams = (cylinder!.geometry as THREE.CylinderGeometry).parameters;
    // Height includes penetration: 0.5 thickness + 0.2 penetration.
    assert.ok(almostEqual(cylinderParams.height, 0.7));

    const cylinderWorld = new THREE.Vector3();
    cylinder!.getWorldPosition(cylinderWorld);
    // Center shifts into the model: 10 - (0.5 - 0.2) / 2 = 9.85.
    assert.ok(almostEqual(cylinderWorld.z, 9.85));

    const sphere = diskGroup.children.find(
        (child) => (child as THREE.Mesh).geometry?.type === 'SphereGeometry',
    ) as THREE.Mesh | undefined;
    assert.ok(sphere, 'expected a tip sphere in the export group');
    const sphereWorld = new THREE.Vector3();
    sphere!.getWorldPosition(sphereWorld);
    // Tip center stays at pos + normal * thickness = 10 - 0.5 = 9.5 regardless of penetration.
    assert.ok(almostEqual(sphereWorld.z, 9.5));
});

test('export disk mesh is skipped for non-disk profiles', () => {
    const diskGroup = SupportGeometryGenerator.generateContactDiskMesh({
        pos: { x: 0, y: 0, z: 10 },
        normal: { x: 0, y: 0, z: -1 },
        profile: { type: 'sphere', contactDiameterMm: 0.4, bodyDiameterMm: 1.2, lengthMm: 2 },
    });
    assert.equal(diskGroup.children.length, 0);
});

test('buildTwig stamps the global penetration onto both disk profiles', () => {
    const result = buildTwig({
        modelId: 'model-test',
        aPos: { x: 0, y: 0, z: 0 },
        aNormal: { x: 0, y: 0, z: 1 },
        bPos: { x: 5, y: 0, z: 0 },
        bNormal: { x: 0, y: 0, z: 1 },
    });

    const expected = Math.max(0, getSettings().tip.penetrationMm ?? 0);
    assert.equal(result.twig.contactDiskA.profile.penetrationMm, expected);
    assert.equal(result.twig.contactDiskB.profile.penetrationMm, expected);
});
