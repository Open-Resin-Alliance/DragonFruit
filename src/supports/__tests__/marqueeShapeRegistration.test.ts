import assert from 'node:assert/strict';
import test from 'node:test';

import '../state';
import { addKnot, addRoot, addSupportEntity, getSnapshot, resetStore } from '../state';
import { SUPPORT_TYPES } from '../supportTypeRegistry';
import { typesMissingMarqueeShape } from '../marqueeGeometry/seam';
import { collectSupportMarqueeShapes } from '@/components/scene/SceneCanvas/supportMarqueeShapes';
import type { ContactCone } from '../SupportPrimitives/ContactCone/types';
import type { Vec3 } from '../types';

/**
 * Every type's marquee polyline comes from a recipe registered in its own folder.
 *
 * This decides what a drag selects, and nothing else covers it: a type whose
 * recipe never registers has nothing to hit-test against, so it is unselectable
 * by the marquee while every golden still passes.
 */

const vec = (x: number, y: number, z: number): Vec3 => ({ x, y, z });

const ROOT_ID = 'marquee-root';
const KNOT_ID = 'marquee-knot';

const cone = (id: string, pos: Vec3): ContactCone => ({
    id,
    pos,
    normal: vec(0, 0, -1),
    surfaceNormal: vec(0, 0, -1),
    profile: { type: 'cone', lengthMm: 2, contactDiameterMm: 0.3, bodyDiameterMm: 0.8 },
} as unknown as ContactCone);

/** One entity per type, with the hosts its recipe reaches for. */
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
                contactDiskA: { ...cone('disk-a', vec(1, 2, 2)), coneAxis: vec(0, 0, -1) },
                contactDiskB: { ...cone('disk-b', vec(1, 2, 9)), coneAxis: vec(0, 0, -1) },
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

const shapesWithId = (id: string) =>
    collectSupportMarqueeShapes(getSnapshot()).filter((shape) => shape.id === id);

test('every type registers a marquee polyline', () => {
    assert.deepEqual(
        typesMissingMarqueeShape(SUPPORT_TYPES.map((descriptor) => descriptor.id)),
        [],
    );
});

test('every registered recipe yields a polyline a drag can hit', () => {
    for (const descriptor of SUPPORT_TYPES) {
        seed();
        addSupportEntity(descriptor.id, entityFor(descriptor.id) as never);

        const shapes = shapesWithId(`entity-${descriptor.id}`);
        assert.equal(
            shapes.length,
            1,
            `${descriptor.id} registered a recipe but produced no polyline, so a drag cannot select it`,
        );

        const [shape] = shapes;
        assert.ok(shape.points.length > 0, `${descriptor.id}: the polyline has no points`);
        assert.equal(
            shape.struts.length,
            Math.max(0, shape.points.length - 1),
            `${descriptor.id}: every consecutive pair of points needs a strut to hit-test`,
        );
        assert.ok(
            shape.modelId,
            `${descriptor.id}: a shape with no model id is never grouped for hit-testing`,
        );
    }
});
