import assert from 'node:assert/strict';
import test from 'node:test';
import { getTrunkSegmentEndpoints } from '../SupportPrimitives/Knot/knotUtils';
import { setRaftSettings } from '../Rafts/Crenelated/RaftState';

test('Trunk segment endpoints Z-position matches root geometry with solid raft', () => {
    // Setup solid raft settings
    setRaftSettings({
        bottomMode: 'solid',
        thickness: 0.5,
        wallEnabled: false,
    } as any);

    const root = {
        id: 'root-1',
        supportId: 'support-1',
        modelId: 'model-1',
        transform: {
            pos: { x: 0, y: 0, z: 0 },
            rot: { x: 0, y: 0, z: 0, w: 1 },
            scale: { x: 1, y: 1, z: 1 }
        },
        diameter: 3.0,
        diskHeight: 1.0,
        coneHeight: 1.5,
    };

    const trunk = {
        id: 'support-1',
        modelId: 'model-1',
        segments: [
            {
                id: 'seg-1',
                parentShaftId: 'support-1',
                startKnotId: 'root-1',
                endKnotId: 'knot-2',
            }
        ]
    };

    const segment = trunk.segments[0];

    const endpoints = getTrunkSegmentEndpoints(trunk as any, segment as any, 0, root as any);
    assert.ok(endpoints, 'Endpoints should be generated');

    // Expected root top Z = diskHeight (1.0) + coneHeight (1.5) = 2.5.
    // Under Option B, the disk starts at Z=0, so rootTopZ = 1.0 + 1.5 = 2.5.
    assert.equal(endpoints.start.z, 2.5, 'First segment start Z must match configured diskHeight + coneHeight');
});
