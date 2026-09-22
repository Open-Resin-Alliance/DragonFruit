import assert from 'node:assert/strict';
import test from 'node:test';

import '../state';
import { addKnot, addRoot, addSupportEntity, getSnapshot, resetStore } from '../state';
import { SUPPORT_TYPES } from '../supportTypeRegistry';
import { supportProxyGeometryOf, typesMissingProxyGeometry } from '../proxyGeometry/seam';
import { collectProxyPrimitives } from '../SupportProxyMeshLayer';
import type { ContactCone } from '../SupportPrimitives/ContactCone/types';
import type { Vec3 } from '../types';

/**
 * Where each type's proxy primitives come from: a recipe registered in its own
 * folder. A type that registers none draws nothing, and a declared flag that
 * stops being honoured brings back geometry the view was hiding -- neither is
 * covered by a golden.
 */

const vec = (x: number, y: number, z: number): Vec3 => ({ x, y, z });

const ROOT_ID = 'proxy-root';
const KNOT_ID = 'proxy-knot';

const cone = (id: string, pos: Vec3): ContactCone => ({
    id,
    pos,
    normal: vec(0, 0, -1),
    surfaceNormal: vec(0, 0, -1),
    profile: { type: 'cone', lengthMm: 2, contactDiameterMm: 0.3, bodyDiameterMm: 0.8 },
} as unknown as ContactCone);

/** One entity per type, with whatever hosts its recipe reaches for. */
function entityFor(typeId: string): Record<string, unknown> {
    const segment = {
        id: `seg-${typeId}`,
        diameter: 1.2,
        type: 'straight',
        bottomJoint: { id: `j-${typeId}`, pos: vec(1, 2, 3), diameter: 1.2 },
        topJoint: { id: `jt-${typeId}`, pos: vec(1, 2, 8), diameter: 1.2 },
    };
    const shared = { id: `entity-${typeId}`, modelId: 'model-a' };

    switch (typeId) {
        case 'trunk':
            return { ...shared, rootId: ROOT_ID, segments: [segment], contactCone: cone('cone-trunk', vec(1, 2, 9)) };
        case 'branch':
            return { ...shared, parentKnotId: KNOT_ID, segments: [segment], contactCone: cone('cone-branch', vec(1, 2, 9)) };
        case 'leaf':
            return { ...shared, parentKnotId: KNOT_ID, contactCone: cone('cone-leaf', vec(1, 2, 9)) };
        case 'twig':
            return {
                ...shared,
                segments: [segment],
                contactDiskA: { ...cone('disk-a', vec(1, 2, 2)), coneAxis: vec(0, 0, -1), contactDiameterMm: 0.4 },
                contactDiskB: { ...cone('disk-b', vec(1, 2, 9)), coneAxis: vec(0, 0, -1), contactDiameterMm: 0.4 },
            };
        case 'stick':
            return {
                ...shared,
                segments: [segment],
                contactConeA: cone('cone-a', vec(1, 2, 2)),
                contactConeB: cone('cone-b', vec(1, 2, 9)),
            };
        case 'brace':
            return { ...shared, startKnotId: KNOT_ID, endKnotId: KNOT_ID, profile: { diameter: 1 }, segments: [] };
        case 'stump':
            return {
                ...shared,
                rootPos: vec(0, 0, 0),
                rootBaseDiameter: 2,
                rootTopDiameter: 1.5,
                rootHeight: 2,
                joint: { id: 'stump-joint', pos: vec(0, 0, 2), diameter: 1.2 },
                segments: [],
                contactCone: cone('cone-stump', vec(0, 0, 5)),
            };
        case 'kickstand':
            return { ...shared, rootId: ROOT_ID, hostKnotId: KNOT_ID, segments: [segment] };
        default:
            return shared;
    }
}

function seed(): void {
    resetStore();
    addRoot({
        id: ROOT_ID,
        modelId: 'model-a',
        transform: { pos: vec(0, 0, 10), rotation: vec(0, 0, 0), scale: vec(1, 1, 1) },
        diameter: 3,
        diskHeight: 1,
        coneHeight: 2,
    } as never);
    addKnot({ id: KNOT_ID, parentShaftId: 'none', pos: vec(0, 0, 20), diameter: 1.4 } as never);
}

/** Total primitives the layer emits, across every model. */
function primitiveCount(detailed: boolean, interior: Set<string> | null): number {
    const byModel = collectProxyPrimitives(getSnapshot(), {
        includeDetailedPrimitives: detailed,
        interiorSupportIdSet: interior,
    });
    let total = 0;
    for (const geometry of byModel.values()) {
        total += geometry.shafts.length + geometry.roots.length + geometry.joints.length + geometry.cones.length;
    }
    return total;
}

test('every type registers its proxy geometry', () => {
    // A type with no recipe is skipped by the walk, so it draws nothing.
    assert.deepEqual(
        typesMissingProxyGeometry(SUPPORT_TYPES.map((descriptor) => descriptor.id)),
        [],
    );
});

test('every registered recipe emits at least one primitive for its own entity', () => {
    for (const descriptor of SUPPORT_TYPES) {
        seed();
        addSupportEntity(descriptor.id, entityFor(descriptor.id) as never);

        assert.ok(
            primitiveCount(true, null) > 0,
            `${descriptor.id} registered a recipe but emitted nothing for its own entity`,
        );
    }
});

test('a type declaring detailedOnly contributes nothing to the coarse view', () => {
    // Leaf is the one that declares it: a cone and a rod with nothing to draw
    // coarsely.
    const detailedOnly = SUPPORT_TYPES.filter(
        (descriptor) => supportProxyGeometryOf(descriptor.id)?.registration.detailedOnly,
    );
    assert.ok(detailedOnly.length > 0, 'expected at least one detailedOnly type');

    for (const descriptor of detailedOnly) {
        seed();
        addSupportEntity(descriptor.id, entityFor(descriptor.id) as never);
        assert.ok(primitiveCount(true, null) > 0, `${descriptor.id}: emits in the detailed view`);
        assert.equal(primitiveCount(false, null), 0, `${descriptor.id}: must not emit in the coarse view`);
    }
});

test('a type declaring skipInInteriorView contributes nothing to the interior view', () => {
    const skipped = SUPPORT_TYPES.filter(
        (descriptor) => supportProxyGeometryOf(descriptor.id)?.registration.skipInInteriorView,
    );
    assert.ok(skipped.length > 0, 'expected at least one skipInInteriorView type');

    for (const descriptor of skipped) {
        seed();
        addSupportEntity(descriptor.id, entityFor(descriptor.id) as never);
        assert.ok(primitiveCount(true, null) > 0, `${descriptor.id}: emits in the ordinary view`);

        const interior = new Set([`${descriptor.id}:entity-${descriptor.id}`]);
        assert.equal(primitiveCount(true, interior), 0, `${descriptor.id}: must not emit in the interior view`);
    }
});
