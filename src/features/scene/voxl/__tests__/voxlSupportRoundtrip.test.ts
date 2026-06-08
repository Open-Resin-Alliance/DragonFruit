import assert from 'node:assert/strict';
import test from 'node:test';

import { buildSupportExportFromStores, buildVoxlDocumentV1, parseVoxlDocument, serializeVoxlDocument } from '../codec';
import { getSnapshot, loadFromImportFormat, resetStore } from '@/supports/state';
import { getKickstandSnapshot, resetKickstandStore } from '@/supports/SupportTypes/Kickstand/kickstandStore';
import type { DragonfruitImportFormat } from '@/supports/types';

function almostEqual(a: number, b: number, epsilon = 1e-6): boolean {
    return Math.abs(a - b) <= epsilon;
}

test('VOXL support roundtrip preserves imported leaf and brace normalization intent', () => {
    resetStore();
    resetKickstandStore();

    const imported: DragonfruitImportFormat = {
        version: 1,
        meta: {
            source: 'unit-test',
            objectCenter: { x: 0, y: 0, z: 0 },
        },
        roots: [
            {
                id: 'root-left',
                modelId: 'model-1',
                transform: { pos: { x: 0, y: 0, z: 0 }, rot: { x: 0, y: 0, z: 0, w: 1 } },
                diameter: 6,
                diskHeight: 1,
                coneHeight: 1,
            },
            {
                id: 'root-right',
                modelId: 'model-1',
                transform: { pos: { x: 12, y: 0, z: 0 }, rot: { x: 0, y: 0, z: 0, w: 1 } },
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
                        diameter: 0.8,
                        topJoint: { id: 'joint-left-top', pos: { x: 0, y: 0, z: 10 }, diameter: 0.9 },
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
                        diameter: 1.6,
                        topJoint: { id: 'joint-right-top', pos: { x: 12, y: 0, z: 10 }, diameter: 1.7 },
                    },
                ],
            },
        ],
        branches: [
            {
                id: 'branch-1',
                modelId: 'model-1',
                parentKnotId: 'k-parent',
                segments: [
                    {
                        id: 'branch-seg-1',
                        type: 'straight',
                        diameter: 1,
                        topJoint: {
                            id: 'branch-top',
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
                startKnotId: 'k-left',
                endKnotId: 'k-right',
                profile: { diameter: 1.0 },
            },
        ],
        anchors: [],
        knots: [
            {
                id: 'k-parent',
                parentShaftId: 'external-host',
                pos: { x: 0, y: 0, z: 0 },
                diameter: 1.1,
            },
            {
                id: 'k-leaf',
                parentShaftId: 'branch-seg-1',
                t: 0,
                pos: { x: 4, y: 2, z: 5 },
                diameter: 1.1,
                _importHint: 'project',
            },
            {
                id: 'k-left',
                parentShaftId: 'seg-left',
                t: 0.5,
                pos: { x: 0, y: 0, z: 5 },
                diameter: 1.1,
                _importHint: 'braceImported',
            },
            {
                id: 'k-right',
                parentShaftId: 'seg-right',
                t: 0.5,
                pos: { x: 12, y: 0, z: 5 },
                diameter: 1.1,
                _importHint: 'braceImported',
            },
        ],
        kickstands: [],
    };

    loadFromImportFormat(imported);
    const normalizedSnapshot = getSnapshot();

    assert.strictEqual(normalizedSnapshot.knots['k-leaf']?.normalizationHint, 'project', 'Leaf knot should persist project intent after initial load');
    assert.strictEqual(normalizedSnapshot.knots['k-left']?.normalizationHint, 'braceImported', 'Brace start knot should persist brace intent after initial load');
    assert.strictEqual(normalizedSnapshot.knots['k-right']?.normalizationHint, 'braceImported', 'Brace end knot should persist brace intent after initial load');

    const supports = buildSupportExportFromStores(normalizedSnapshot, getKickstandSnapshot());
    const document = buildVoxlDocumentV1({
        models: [
            {
                id: 'model-1',
                name: 'Model 1',
                visible: true,
                color: '#ffffff',
                polygonCount: 0,
                transform: {
                    position: { x: 0, y: 0, z: 0 },
                    rotation: { x: 0, y: 0, z: 0 },
                    scale: { x: 1, y: 1, z: 1 },
                },
            },
        ],
        activeModelId: 'model-1',
        selectedModelIds: ['model-1'],
        supports,
    });

    const serialized = serializeVoxlDocument(document, true, { compression: 'none' });
    const parsed = parseVoxlDocument(serialized);

    resetStore();
    resetKickstandStore();
    loadFromImportFormat(parsed.supports);

    const roundTripped = getSnapshot();
    const leafKnot = roundTripped.knots['k-leaf'];
    const leftBraceKnot = roundTripped.knots['k-left'];
    const rightBraceKnot = roundTripped.knots['k-right'];

    assert.ok(leafKnot, 'Expected leaf host knot after VOXL roundtrip');
    assert.ok(leftBraceKnot, 'Expected left brace host knot after VOXL roundtrip');
    assert.ok(rightBraceKnot, 'Expected right brace host knot after VOXL roundtrip');

    assert.strictEqual(leafKnot.normalizationHint, 'project', 'Leaf knot project intent should survive VOXL roundtrip');
    assert.strictEqual(leftBraceKnot.normalizationHint, 'braceImported', 'Brace start knot intent should survive VOXL roundtrip');
    assert.strictEqual(rightBraceKnot.normalizationHint, 'braceImported', 'Brace end knot intent should survive VOXL roundtrip');
    assert.ok(almostEqual(leafKnot.pos.x, 0), 'Leaf knot X should stay projected after VOXL roundtrip');
    assert.ok(almostEqual(leafKnot.pos.y, 0), 'Leaf knot Y should stay projected after VOXL roundtrip');
    assert.ok(almostEqual(leafKnot.pos.z, 5), 'Leaf knot Z should stay projected after VOXL roundtrip');
    assert.ok(almostEqual(leftBraceKnot.diameter ?? 0, 1.1), 'Brace start knot diameter should stay uniform after VOXL roundtrip');
    assert.ok(almostEqual(rightBraceKnot.diameter ?? 0, 1.1), 'Brace end knot diameter should stay uniform after VOXL roundtrip');

    resetStore();
    resetKickstandStore();
});