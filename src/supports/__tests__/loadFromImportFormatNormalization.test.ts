import assert from 'node:assert/strict';
import test from 'node:test';

import { getSnapshot, loadFromImportFormat, resetStore } from '../state';
import type { DragonfruitImportFormat } from '../types';

function almostEqual(a: number, b: number, epsilon = 1e-6): boolean {
    return Math.abs(a - b) <= epsilon;
}

test('loadFromImportFormat normalizes imported host-knot positions for brace/leaf visuals', () => {
    resetStore();

    const data: DragonfruitImportFormat = {
        version: 1,
        meta: {
            source: 'unit-test',
            objectCenter: { x: 0, y: 0, z: 0 },
        },
        roots: [],
        trunks: [],
        branches: [
            {
                id: 'branch-1',
                modelId: 'model-1',
                parentKnotId: 'k-parent',
                segments: [
                    {
                        id: 'seg-1',
                        type: 'straight',
                        diameter: 1.0,
                        topJoint: {
                            id: 'joint-top',
                            pos: { x: 0, y: 0, z: 10 },
                            diameter: 1,
                        },
                    },
                ],
            },
        ],
        leaves: [
            {
                id: 'leaf-1',
                modelId: 'model-1',
                parentKnotId: 'k-leaf',
                contactCone: {
                    id: 'cone-1',
                    pos: { x: 2, y: 0, z: 12 },
                    normal: { x: 0, y: 0, z: -1 },
                    surfaceNormal: { x: 0, y: 0, z: -1 },
                    profile: {
                        type: 'disk',
                        contactDiameterMm: 0.4,
                        bodyDiameterMm: 1.2,
                        lengthMm: 3,
                        penetrationMm: 0.05,
                        diskThicknessMm: 0.1,
                        maxStandoffMm: 0.25,
                        standoffAngleThreshold: Math.PI / 4,
                    },
                },
            },
        ],
        twigs: [],
        sticks: [],
        braces: [
            {
                id: 'brace-1',
                modelId: 'model-1',
                startKnotId: 'k-leaf',
                endKnotId: 'k-brace',
                profile: { diameter: 0.8 },
            },
        ],
        knots: [
            {
                id: 'k-parent',
                parentShaftId: 'external-host',
                pos: { x: 0, y: 0, z: 0 },
                diameter: 1.1,
            },
            {
                id: 'k-leaf',
                parentShaftId: 'seg-1',
                t: 0,
                pos: { x: 4, y: 2, z: 5 },
                diameter: 1.1,
            },
            {
                id: 'k-brace',
                parentShaftId: 'seg-1',
                t: 0,
                pos: { x: -3, y: 1, z: 8 },
                diameter: 1.1,
            },
        ],
    };

    loadFromImportFormat(data);
    const snapshot = getSnapshot();

    const knotLeaf = snapshot.knots['k-leaf'];
    const knotBrace = snapshot.knots['k-brace'];
    const leaf = snapshot.leaves['leaf-1'];

    assert.ok(knotLeaf, 'Expected k-leaf to exist after load');
    assert.ok(knotBrace, 'Expected k-brace to exist after load');
    assert.ok(leaf?.contactCone, 'Expected leaf contact cone to exist after load');

    // Branch seg-1 runs from parent knot (0,0,0) to top joint (0,0,10).
    // Even when imported t is wrong (0), load normalization should derive t from authored position
    // and avoid collapsing to the segment start.
    assert.ok(almostEqual(knotLeaf.pos.x, 0), 'k-leaf X should be projected onto the host shaft on load');
    assert.ok(almostEqual(knotLeaf.pos.y, 0), 'k-leaf Y should be projected onto the host shaft on load');
    assert.ok(almostEqual(knotLeaf.pos.z, 5), 'k-leaf Z should remain aligned with authored host height (not collapse to segment start)');
    assert.ok(almostEqual(knotLeaf.t ?? -1, 0.5), 'k-leaf t should be recomputed from authored host position on load');

    assert.ok(almostEqual(knotBrace.pos.x, 0), 'k-brace X should be projected onto the host shaft on load');
    assert.ok(almostEqual(knotBrace.pos.y, 0), 'k-brace Y should be projected onto the host shaft on load');
    assert.ok(almostEqual(knotBrace.pos.z, 8), 'k-brace Z should remain aligned with authored host height (not collapse to segment start)');
    assert.ok(almostEqual(knotBrace.t ?? -1, 0.8), 'k-brace t should be recomputed from authored host position on load');

    // Leaf cone should re-orient toward the normalized parent knot automatically.
    assert.ok((leaf?.contactCone.normal.x ?? 0) < -0.1, 'Leaf cone axis should be recomputed using the normalized knot position');

    resetStore();
});

test('loadFromImportFormat preserves authored brace host positions on large endpoint reprojection', () => {
    resetStore();

    const data: DragonfruitImportFormat = {
        version: 1,
        meta: {
            source: 'unit-test',
            objectCenter: { x: 0, y: 0, z: 0 },
        },
        roots: [
            {
                id: 'root-left',
                modelId: 'model-1',
                transform: {
                    pos: { x: 0, y: 0, z: 0 },
                    rot: { x: 0, y: 0, z: 0, w: 1 },
                },
                diameter: 6,
                diskHeight: 1,
                coneHeight: 1,
            },
            {
                id: 'root-right',
                modelId: 'model-1',
                transform: {
                    pos: { x: 10, y: 0, z: 0 },
                    rot: { x: 0, y: 0, z: 0, w: 1 },
                },
                diameter: 6,
                diskHeight: 1,
                coneHeight: 1,
            },
        ],
        trunks: [
            {
                id: 'trunk-left',
                modelId: 'model-1',
                rootId: 'root-left',
                segments: [
                    {
                        id: 'seg-left',
                        type: 'straight',
                        diameter: 1,
                        topJoint: {
                            id: 'joint-left-top',
                            pos: { x: 0, y: 0, z: 10 },
                            diameter: 1,
                        },
                    },
                ],
            },
            {
                id: 'trunk-right',
                modelId: 'model-1',
                rootId: 'root-right',
                segments: [
                    {
                        id: 'seg-right',
                        type: 'straight',
                        diameter: 1,
                        topJoint: {
                            id: 'joint-right-top',
                            pos: { x: 10, y: 0, z: 10 },
                            diameter: 1,
                        },
                    },
                ],
            },
        ],
        branches: [],
        leaves: [],
        twigs: [],
        sticks: [],
        braces: [
            {
                id: 'brace-1',
                modelId: 'model-1',
                startKnotId: 'k-left',
                endKnotId: 'k-right',
                profile: { diameter: 0.8 },
            },
        ],
        knots: [
            {
                id: 'k-left',
                parentShaftId: 'seg-left',
                t: 0,
                pos: { x: 0, y: 0, z: -6 },
                diameter: 1.1,
            },
            {
                id: 'k-right',
                parentShaftId: 'seg-right',
                t: 1,
                pos: { x: 10, y: 0, z: 20 },
                diameter: 1.1,
            },
        ],
    };

    loadFromImportFormat(data);
    const snapshot = getSnapshot();

    const knotLeft = snapshot.knots['k-left'];
    const knotRight = snapshot.knots['k-right'];

    assert.ok(knotLeft, 'Expected k-left to exist after load');
    assert.ok(knotRight, 'Expected k-right to exist after load');

    assert.ok(almostEqual(knotLeft.pos.z, -6), 'k-left Z should preserve authored brace endpoint position when endpoint reprojection would cause a large snap');
    assert.ok(almostEqual(knotRight.pos.z, 20), 'k-right Z should preserve authored brace endpoint position when endpoint reprojection would cause a large snap');

    resetStore();
});

test('loadFromImportFormat preserves terminal endpoint knots but keeps descendant-host branch knots projected', () => {
    resetStore();

    const data: DragonfruitImportFormat = {
        version: 1,
        meta: {
            source: 'unit-test',
            objectCenter: { x: 0, y: 0, z: 0 },
        },
        roots: [
            {
                id: 'root-1',
                modelId: 'model-1',
                transform: {
                    pos: { x: 0, y: 0, z: 0 },
                    rot: { x: 0, y: 0, z: 0, w: 1 },
                },
                diameter: 6,
                diskHeight: 1,
                coneHeight: 1,
            },
        ],
        trunks: [
            {
                id: 'trunk-1',
                modelId: 'model-1',
                rootId: 'root-1',
                segments: [
                    {
                        id: 'trunk-seg-1',
                        type: 'straight',
                        diameter: 1,
                        topJoint: {
                            id: 'trunk-top',
                            pos: { x: 0, y: 0, z: 10 },
                            diameter: 1,
                        },
                    },
                ],
            },
        ],
        branches: [
            {
                id: 'branch-1',
                modelId: 'model-1',
                parentKnotId: 'k-parent-host',
                segments: [
                    {
                        id: 'branch-seg-1',
                        type: 'straight',
                        diameter: 0.8,
                        topJoint: {
                            id: 'branch-top',
                            pos: { x: 4, y: 0, z: 20 },
                            diameter: 1,
                        },
                    },
                ],
            },
            {
                id: 'branch-2-child',
                modelId: 'model-1',
                parentKnotId: 'k-child-on-branch',
                segments: [
                    {
                        id: 'branch-seg-2',
                        type: 'straight',
                        diameter: 0.6,
                        topJoint: {
                            id: 'branch2-top',
                            pos: { x: 8, y: 0, z: 24 },
                            diameter: 0.8,
                        },
                    },
                ],
            },
        ],
        leaves: [
            {
                id: 'leaf-terminal',
                modelId: 'model-1',
                parentKnotId: 'k-terminal-endpoint',
                contactCone: {
                    id: 'leaf-cone-terminal',
                    pos: { x: 4, y: 0, z: 21 },
                    normal: { x: 0, y: 0, z: -1 },
                    surfaceNormal: { x: 0, y: 0, z: -1 },
                    profile: {
                        type: 'disk',
                        contactDiameterMm: 0.4,
                        bodyDiameterMm: 1.2,
                        lengthMm: 3,
                        penetrationMm: 0.05,
                        diskThicknessMm: 0.1,
                        maxStandoffMm: 0.25,
                        standoffAngleThreshold: Math.PI / 4,
                    },
                },
            },
        ],
        twigs: [],
        sticks: [],
        braces: [],
        knots: [
            {
                id: 'k-parent-host',
                parentShaftId: 'trunk-seg-1',
                t: 1,
                pos: { x: 0, y: 0, z: 25 },
                diameter: 1.1,
            },
            {
                id: 'k-child-on-branch',
                parentShaftId: 'branch-seg-1',
                t: 0.7,
                pos: { x: 2.8, y: 0, z: 17 },
                diameter: 1.1,
            },
            {
                id: 'k-terminal-endpoint',
                parentShaftId: 'branch-seg-1',
                t: 0,
                pos: { x: 0, y: 0, z: 0.2 },
                diameter: 1.1,
            },
        ],
    };

    loadFromImportFormat(data);
    const snapshot = getSnapshot();

    const parentHost = snapshot.knots['k-parent-host'];
    const terminal = snapshot.knots['k-terminal-endpoint'];

    assert.ok(parentHost, 'Expected branch host parent knot to exist after load');
    assert.ok(terminal, 'Expected terminal endpoint knot to exist after load');

    // Host knot with descendants should stay projected (not preserved at authored overshoot z=25).
    assert.ok(parentHost.pos.z <= 10 + 1e-6,
        'Descendant-host branch parent knot should remain projected onto its trunk segment');

    // Terminal endpoint knot can keep authored endpoint intent at large endpoint clamp.
    assert.ok(almostEqual(terminal.pos.z, 0.2),
        'Terminal endpoint knot should preserve authored endpoint position on large endpoint reprojection');

    resetStore();
});
