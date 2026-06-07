import test from 'node:test';
import assert from 'node:assert/strict';
import { buildSupportPathSnapTargets } from '../interaction/shared/placement/snapping/supportPathTargets';
import { getFinalSocketPosition } from '../SupportPrimitives/ContactCone/contactConeUtils';
import type { SupportState } from '../types';

function makeBaseState(): Pick<SupportState, 'trunks' | 'branches' | 'braces' | 'twigs' | 'sticks' | 'roots' | 'knots'> {
    return {
        trunks: {},
        branches: {},
        braces: {},
        twigs: {},
        sticks: {},
        roots: {},
        knots: {},
    };
}

test('buildSupportPathSnapTargets uses the final trunk cone socket for the terminal shaft endpoint', () => {
    const state = makeBaseState();
    state.roots['root-1'] = {
        id: 'root-1',
        modelId: 'model-1',
        diameter: 2,
        diskHeight: 0.5,
        coneHeight: 1,
        transform: {
            pos: { x: 0, y: 0, z: 0 },
            rot: { x: 0, y: 0, z: 0 },
        },
    } as SupportState['roots'][string];

    state.trunks['trunk-1'] = {
        id: 'trunk-1',
        modelId: 'model-1',
        rootId: 'root-1',
        segments: [{
            id: 'trunk-seg-1',
            type: 'straight',
            diameter: 1.6,
            bottomJoint: undefined,
            topJoint: undefined,
        }],
        contactCone: {
            id: 'cone-1',
            pos: { x: 5, y: 0, z: 20 },
            normal: { x: 0, y: 0, z: 1 },
            surfaceNormal: { x: 1, y: 0, z: 0 },
            profile: {
                type: 'disk',
                contactDiameterMm: 0.4,
                bodyDiameterMm: 0.8,
                lengthMm: 3,
                penetrationMm: 0,
            },
        },
    } as SupportState['trunks'][string];

    const targets = buildSupportPathSnapTargets(state, { includeTrunks: true, includeBranches: false });
    const target = targets.find((entry) => entry.id === 'trunk-seg-1');
    assert.ok(target?.pathSegment);

    const expectedEnd = getFinalSocketPosition(state.trunks['trunk-1'].contactCone!);
    assert.deepEqual(target.pathSegment.end, expectedEnd);
});

test('buildSupportPathSnapTargets uses the final branch cone socket for the terminal shaft endpoint', () => {
    const state = makeBaseState();
    state.knots['host-knot'] = {
        id: 'host-knot',
        parentShaftId: 'trunk-seg-host',
        t: 0.5,
        pos: { x: 1, y: 2, z: 3 },
        diameter: 1.2,
    } as SupportState['knots'][string];

    state.branches['branch-1'] = {
        id: 'branch-1',
        modelId: 'model-1',
        parentKnotId: 'host-knot',
        segments: [{
            id: 'branch-seg-1',
            type: 'straight',
            diameter: 1.1,
            bottomJoint: undefined,
            topJoint: undefined,
        }],
        contactCone: {
            id: 'branch-cone-1',
            pos: { x: 4, y: 5, z: 6 },
            normal: { x: 0, y: 1, z: 0 },
            surfaceNormal: { x: 0, y: 0, z: 1 },
            profile: {
                type: 'disk',
                contactDiameterMm: 0.4,
                bodyDiameterMm: 0.8,
                lengthMm: 2,
                penetrationMm: 0,
            },
        },
    } as SupportState['branches'][string];

    const targets = buildSupportPathSnapTargets(state, { includeTrunks: false, includeBranches: true });
    const target = targets.find((entry) => entry.id === 'branch-seg-1');
    assert.ok(target?.pathSegment);

    const expectedEnd = getFinalSocketPosition(state.branches['branch-1'].contactCone!);
    assert.deepEqual(target.pathSegment.end, expectedEnd);
});
