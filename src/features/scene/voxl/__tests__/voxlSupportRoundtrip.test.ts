import assert from 'node:assert/strict';
import test from 'node:test';

import { buildSupportExportFromStores } from '../codec';
import { parseVoxlBinaryV2, serializeVoxlDocumentV2 } from '../codec-v2';
import { encodeSupportSettingsHex } from '@/supports/Settings/supportSettingsCodec';
import { createDefaultSettings } from '@/supports/Settings/types';
import { getFinalSocketPosition } from '@/supports/SupportPrimitives/ContactCone/contactConeUtils';
import type { ContactCone } from '@/supports/SupportPrimitives/ContactCone/types';
import { getSnapshot, loadFromImportFormat, resetStore, resetKickstandsInState} from '@/supports/state';
import { readKickstands } from '@/supports/__tests__/helpers/kickstandFixture';
import {
    getSupportTypeDescriptor,
    SUPPORT_COLLECTION_KEYS,
    type SupportCollectionKey,
    type SupportTypeId,
} from '@/supports/supportTypeRegistry';
import type { DragonfruitImportFormat, SupportCollectionByType, Vec3 } from '@/supports/types';

/** Collection keys come from the registry; `roots` and `knots` are primitives. */
function emptyWireCollections(): Pick<DragonfruitImportFormat, SupportCollectionKey> {
    const collections = {} as Record<string, unknown[]>;
    for (const key of SUPPORT_COLLECTION_KEYS) collections[key] = [];
    return collections as unknown as Pick<DragonfruitImportFormat, SupportCollectionKey>;
}

/** What the wire format carries under a type's collection key. */
type WireEntities<K extends SupportTypeId> =
    DragonfruitImportFormat[SupportCollectionByType[K] & keyof DragonfruitImportFormat];

/** Fill one collection, keyed by the type that declares it. */
function setCollection<K extends SupportTypeId>(
    payload: DragonfruitImportFormat,
    typeId: K,
    entities: WireEntities<K>,
): void {
    (payload as unknown as Record<string, unknown>)[getSupportTypeDescriptor(typeId).location.key] = entities;
}

function almostEqual(a: number, b: number, epsilon = 1e-6): boolean {
    return Math.abs(a - b) <= epsilon;
}

test('VOXL support roundtrip preserves imported leaf and brace normalization intent', async () => {
    resetStore();
    resetKickstandsInState();

    const imported: DragonfruitImportFormat = {
        ...emptyWireCollections(),
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
    };

    setCollection(imported, 'trunk', [
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
    ]);

    setCollection(imported, 'branch', [
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
    ]);

    setCollection(imported, 'leaf', [
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
    ]);

    setCollection(imported, 'brace', [
        {
            id: 'brace-1',
            modelId: 'model-1',
            startKnotId: 'k-left',
            endKnotId: 'k-right',
            profile: { diameter: 1.0 },
        },
    ]);

    loadFromImportFormat(imported);
    const normalizedSnapshot = getSnapshot();

    assert.strictEqual(normalizedSnapshot.knots['k-leaf']?.normalizationHint, 'project', 'Leaf knot should persist project intent after initial load');
    assert.strictEqual(normalizedSnapshot.knots['k-left']?.normalizationHint, 'braceImported', 'Brace start knot should persist brace intent after initial load');
    assert.strictEqual(normalizedSnapshot.knots['k-right']?.normalizationHint, 'braceImported', 'Brace end knot should persist brace intent after initial load');

    const supports = buildSupportExportFromStores(normalizedSnapshot);
    const binary = await serializeVoxlDocumentV2({
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
    }, new Map());

    const parsed = (await parseVoxlBinaryV2(binary)).document;

    resetStore();
    resetKickstandsInState();
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
    resetKickstandsInState();
});

function vecHypotDiff(a: Vec3, b: Vec3): number {
    return Math.hypot(a.x - b.x, a.y - b.y, a.z - b.z);
}

function assertVecBitEqual(actual: Vec3, expected: Vec3, label: string): void {
    assert.strictEqual(actual.x, expected.x, `${label}.x`);
    assert.strictEqual(actual.y, expected.y, `${label}.y`);
    assert.strictEqual(actual.z, expected.z, `${label}.z`);
}

test('VOXL V2 binary roundtrip preserves non-collinear contact normals, overrides, sockets, settingsCodeHex, and twig disks', async () => {
    resetStore();
    resetKickstandsInState();

    try {
        const customSettings = createDefaultSettings();
        customSettings.tip.coneAngleMode = 'adaptive';
        customSettings.tip.adaptiveConeAngleOffsetDeg = 25;
        customSettings.tip.diskThicknessMm = 0.15;
        customSettings.tip.maxStandoffMm = 0.5;
        const settingsCodeHex = encodeSupportSettingsHex(customSettings);

        const diskTipProfile = {
            type: 'disk' as const,
            contactDiameterMm: 0.4,
            bodyDiameterMm: 1.2,
            lengthMm: 3,
            penetrationMm: 0.05,
            diskThicknessMm: 0.15,
            maxStandoffMm: 0.5,
            standoffAngleThreshold: Math.PI / 4,
        };

        const trunkCone: ContactCone = {
            id: 'trunk-cone-v2',
            pos: { x: 1, y: 0.5, z: 12 },
            normal: { x: 0.28, y: 0, z: -0.96 },
            surfaceNormal: { x: 0.6, y: 0, z: -0.8 },
            diskLengthOverride: 0.42,
            socketJointId: 'trunk-top-joint-v2',
            profile: { ...diskTipProfile },
        };
        const branchCone: ContactCone = {
            id: 'branch-cone-v2',
            pos: { x: 3.5, y: 1.5, z: 10 },
            normal: { x: -2 / 7, y: 3 / 7, z: -6 / 7 },
            surfaceNormal: { x: -0.6, y: 0, z: -0.8 },
            diskLengthOverride: 0.37,
            socketJointId: 'branch-top-joint-v2',
            profile: { ...diskTipProfile },
        };
        const leafCone: ContactCone = {
            id: 'leaf-cone-v2',
            pos: { x: 2.5, y: 1.5, z: 7.5 },
            normal: { x: 0.6, y: 0, z: -0.8 },
            surfaceNormal: { x: 0, y: 0.6, z: -0.8 },
            diskLengthOverride: 0.29,
            profile: { ...diskTipProfile },
        };
        const stumpCone: ContactCone = {
            id: 'stump-cone-v2',
            pos: { x: 5.5, y: 0.5, z: 3.5 },
            normal: { x: 2 / 7, y: -3 / 7, z: -6 / 7 },
            surfaceNormal: { x: 0.6, y: 0, z: -0.8 },
            diskLengthOverride: 0.33,
            socketJointId: 'stump-joint-v2',
            profile: { ...diskTipProfile },
        };
        const stickConeA: ContactCone = {
            id: 'stick-cone-a-v2',
            pos: { x: -3, y: 1, z: 2 },
            normal: { x: 0, y: 0.6, z: 0.8 },
            surfaceNormal: { x: 0.6, y: 0, z: 0.8 },
            diskLengthOverride: 0.24,
            socketJointId: 'stick-bj-v2',
            profile: { ...diskTipProfile },
        };
        const stickConeB: ContactCone = {
            id: 'stick-cone-b-v2',
            pos: { x: -3.5, y: 1.5, z: 10 },
            normal: { x: 2 / 7, y: 3 / 7, z: -6 / 7 },
            surfaceNormal: { x: 0, y: 0.8, z: -0.6 },
            diskLengthOverride: 0.31,
            socketJointId: 'stick-tj-v2',
            profile: { ...diskTipProfile },
        };

        const twigDiskA = {
            id: 'twig-disk-a-v2',
            pos: { x: 8, y: -2, z: 3 },
            surfaceNormal: { x: 0.6, y: 0, z: 0.8 },
            coneAxis: { x: 0, y: 0.6, z: 0.8 },
            diskLengthOverride: 0.28,
            contactDiameterMm: 0.36,
            profile: {
                type: 'disk' as const,
                diskThicknessMm: 0.1,
                maxStandoffMm: 0.5,
                standoffAngleThreshold: Math.PI / 4,
            },
        };
        const twigDiskB = {
            id: 'twig-disk-b-v2',
            pos: { x: 8.5, y: -1.5, z: 6 },
            surfaceNormal: { x: 0, y: 0.6, z: -0.8 },
            coneAxis: { x: -2 / 7, y: 3 / 7, z: -6 / 7 },
            diskLengthOverride: 0.34,
            contactDiameterMm: 0.36,
            profile: {
                type: 'disk' as const,
                diskThicknessMm: 0.1,
                maxStandoffMm: 0.5,
                standoffAngleThreshold: Math.PI / 4,
            },
        };

        const trunkSocketPos = getFinalSocketPosition(trunkCone);
        const branchSocketPos = getFinalSocketPosition(branchCone);
        const leafSocketPos = getFinalSocketPosition(leafCone);
        const stumpSocketPos = getFinalSocketPosition(stumpCone);
        const stickSocketAPos = getFinalSocketPosition(stickConeA);
        const stickSocketBPos = getFinalSocketPosition(stickConeB);
        const twigJointAPos: Vec3 = {
            x: twigDiskA.pos.x + twigDiskA.surfaceNormal.x * twigDiskA.diskLengthOverride,
            y: twigDiskA.pos.y + twigDiskA.surfaceNormal.y * twigDiskA.diskLengthOverride,
            z: twigDiskA.pos.z + twigDiskA.surfaceNormal.z * twigDiskA.diskLengthOverride,
        };
        const twigJointBPos: Vec3 = {
            x: twigDiskB.pos.x + twigDiskB.surfaceNormal.x * twigDiskB.diskLengthOverride,
            y: twigDiskB.pos.y + twigDiskB.surfaceNormal.y * twigDiskB.diskLengthOverride,
            z: twigDiskB.pos.z + twigDiskB.surfaceNormal.z * twigDiskB.diskLengthOverride,
        };

        const imported: DragonfruitImportFormat = {
            ...emptyWireCollections(),
            version: 1,
            meta: {
                source: 'unit-test-v2',
                objectCenter: { x: 0, y: 0, z: 0 },
            },
            roots: [
                {
                    id: 'root-v2',
                    modelId: 'model-1',
                    transform: { pos: { x: 0, y: 0, z: 0 }, rot: { x: 0, y: 0, z: 0, w: 1 } },
                    diameter: 6,
                    diskHeight: 1,
                    coneHeight: 1,
                },
            ],
            knots: [
                {
                    id: 'k-branch-host-v2',
                    parentShaftId: 'trunk-seg-lower-v2',
                    t: 0.75,
                    pos: { x: 0, y: 0, z: 5 },
                    diameter: 1.3,
                },
                {
                    id: 'k-leaf-host-v2',
                    parentShaftId: 'trunk-seg-lower-v2',
                    t: 0.5,
                    pos: { x: 0, y: 0, z: 4 },
                    diameter: 1.3,
                },
            ],
        };

        setCollection(imported, 'trunk', [
            {
                id: 'trunk-v2',
                modelId: 'model-1',
                rootId: 'root-v2',
                settingsCodeHex,
                segments: [
                    {
                        id: 'trunk-seg-lower-v2',
                        type: 'straight',
                        diameter: 1.2,
                        topJoint: { id: 'trunk-mid-joint-v2', pos: { x: 0, y: 0, z: 6 }, diameter: 1.3 },
                    },
                    {
                        id: 'trunk-seg-upper-v2',
                        type: 'straight',
                        diameter: 1.2,
                        bottomJoint: { id: 'trunk-mid-joint-v2', pos: { x: 0, y: 0, z: 6 }, diameter: 1.3 },
                        topJoint: { id: 'trunk-top-joint-v2', pos: trunkSocketPos, diameter: 1.3 },
                    },
                ],
                contactCone: trunkCone,
            },
        ]);

        setCollection(imported, 'branch', [
            {
                id: 'branch-v2',
                modelId: 'model-1',
                parentKnotId: 'k-branch-host-v2',
                settingsCodeHex,
                segments: [
                    {
                        id: 'branch-seg-v2',
                        type: 'straight',
                        diameter: 1.0,
                        topJoint: { id: 'branch-top-joint-v2', pos: branchSocketPos, diameter: 1.1 },
                    },
                ],
                contactCone: branchCone,
            },
        ]);

        setCollection(imported, 'leaf', [
            {
                id: 'leaf-v2',
                modelId: 'model-1',
                parentKnotId: 'k-leaf-host-v2',
                settingsCodeHex,
                contactCone: leafCone,
            },
        ]);

        setCollection(imported, 'stump', [
            {
                id: 'stump-v2',
                modelId: 'model-1',
                settingsCodeHex,
                rootPos: { x: 6, y: 0, z: 0 },
                rootBaseDiameter: 2.0,
                rootTopDiameter: 1.5,
                rootHeight: 1.0,
                joint: { id: 'stump-joint-v2', pos: stumpSocketPos, diameter: 1.5 },
                segments: [],
                contactCone: stumpCone,
            },
        ]);

        setCollection(imported, 'stick', [
            {
                id: 'stick-v2',
                modelId: 'model-1',
                settingsCodeHex,
                segments: [
                    {
                        id: 'stick-seg-v2',
                        type: 'straight',
                        diameter: 1.0,
                        bottomJoint: { id: 'stick-bj-v2', pos: stickSocketAPos, diameter: 1.1 },
                        topJoint: { id: 'stick-tj-v2', pos: stickSocketBPos, diameter: 1.1 },
                    },
                ],
                contactConeA: stickConeA,
                contactConeB: stickConeB,
            },
        ]);

        setCollection(imported, 'twig', [
            {
                id: 'twig-v2',
                modelId: 'model-1',
                settingsCodeHex,
                segments: [
                    {
                        id: 'twig-seg-v2',
                        type: 'straight',
                        diameter: 0.36,
                        bottomJoint: { id: 'twig-bj-v2', pos: twigJointAPos, diameter: 0.46 },
                        topJoint: { id: 'twig-tj-v2', pos: twigJointBPos, diameter: 0.46 },
                    },
                ],
                contactDiskA: twigDiskA,
                contactDiskB: twigDiskB,
            },
        ]);

        loadFromImportFormat(imported);
        const initialSnapshot = getSnapshot();
        const supports = buildSupportExportFromStores(initialSnapshot);

        const binary = await serializeVoxlDocumentV2({
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
        }, new Map());

        const parsed = (await parseVoxlBinaryV2(binary)).document;
        resetStore();
        resetKickstandsInState();
        loadFromImportFormat(parsed.supports);

        const rt = getSnapshot();

        const assertConeRoundtrip = (
            actual: ContactCone | undefined,
            expected: ContactCone,
            expectedSocket: Vec3,
            label: string,
        ) => {
            assert.ok(actual, `${label} contactCone must exist`);
            assert.ok(actual.surfaceNormal, `${label} surfaceNormal must exist`);
            assert.ok(
                vecHypotDiff(actual.normal, actual.surfaceNormal) > 0.15,
                `${label} normal and surfaceNormal must stay non-collinear (hypot > 0.15)`,
            );
            assertVecBitEqual(actual.normal, expected.normal, `${label}.normal`);
            assertVecBitEqual(actual.surfaceNormal, expected.surfaceNormal!, `${label}.surfaceNormal`);
            assert.strictEqual(actual.diskLengthOverride, expected.diskLengthOverride, `${label}.diskLengthOverride`);
            assertVecBitEqual(getFinalSocketPosition(actual), expectedSocket, `${label}.socketPosition`);
        };

        const rtTrunk = rt.trunks['trunk-v2'];
        assert.ok(rtTrunk, 'Trunk must roundtrip');
        assert.strictEqual(rtTrunk.settingsCodeHex, settingsCodeHex, 'Trunk settingsCodeHex');
        assertConeRoundtrip(rtTrunk.contactCone, trunkCone, trunkSocketPos, 'Trunk');
        assertVecBitEqual(rtTrunk.segments[1].topJoint!.pos, trunkSocketPos, 'Trunk.topJoint.pos');

        const rtBranch = rt.branches['branch-v2'];
        assert.ok(rtBranch, 'Branch must roundtrip');
        assert.strictEqual(rtBranch.settingsCodeHex, settingsCodeHex, 'Branch settingsCodeHex');
        assertConeRoundtrip(rtBranch.contactCone, branchCone, branchSocketPos, 'Branch');
        assertVecBitEqual(rtBranch.segments[0].topJoint!.pos, branchSocketPos, 'Branch.topJoint.pos');

        const rtLeafKnot = rt.knots['k-leaf-host-v2'];
        assert.ok(rtLeafKnot, 'Leaf host knot must roundtrip');
        assertVecBitEqual(rtLeafKnot.pos, { x: 0, y: 0, z: 4 }, 'Leaf host knot pos');
        assert.strictEqual(rtLeafKnot.t, 0.5, 'Leaf host knot t');

        const rtLeaf = rt.leaves['leaf-v2'];
        assert.ok(rtLeaf, 'Leaf must roundtrip');
        assert.strictEqual(rtLeaf.settingsCodeHex, settingsCodeHex, 'Leaf settingsCodeHex');
        assertConeRoundtrip(rtLeaf.contactCone, leafCone, leafSocketPos, 'Leaf');

        const rtStump = rt.stumps['stump-v2'];
        assert.ok(rtStump, 'Stump must roundtrip');
        assert.strictEqual(rtStump.settingsCodeHex, settingsCodeHex, 'Stump settingsCodeHex');
        assertConeRoundtrip(rtStump.contactCone, stumpCone, stumpSocketPos, 'Stump');
        assertVecBitEqual(rtStump.joint.pos, stumpSocketPos, 'Stump.joint.pos');

        const rtStick = rt.sticks['stick-v2'];
        assert.ok(rtStick, 'Stick must roundtrip');
        assert.strictEqual(rtStick.settingsCodeHex, settingsCodeHex, 'Stick settingsCodeHex');
        assertConeRoundtrip(rtStick.contactConeA, stickConeA, stickSocketAPos, 'Stick.contactConeA');
        assertConeRoundtrip(rtStick.contactConeB, stickConeB, stickSocketBPos, 'Stick.contactConeB');
        assertVecBitEqual(rtStick.segments[0].bottomJoint!.pos, stickSocketAPos, 'Stick.bottomJoint.pos');
        assertVecBitEqual(rtStick.segments[0].topJoint!.pos, stickSocketBPos, 'Stick.topJoint.pos');

        const rtTwig = rt.twigs['twig-v2'];
        assert.ok(rtTwig, 'Twig must roundtrip');
        assert.strictEqual(rtTwig.settingsCodeHex, settingsCodeHex, 'Twig settingsCodeHex');
        for (const [label, actualDisk, expectedDisk, expectedJointPos] of [
            ['Twig.contactDiskA', rtTwig.contactDiskA, twigDiskA, twigJointAPos],
            ['Twig.contactDiskB', rtTwig.contactDiskB, twigDiskB, twigJointBPos],
        ] as const) {
            assert.ok(
                vecHypotDiff(actualDisk.coneAxis, actualDisk.surfaceNormal) > 0.15,
                `${label} coneAxis and surfaceNormal must stay non-collinear (hypot > 0.15)`,
            );
            assertVecBitEqual(actualDisk.coneAxis, expectedDisk.coneAxis, `${label}.coneAxis`);
            assertVecBitEqual(actualDisk.surfaceNormal, expectedDisk.surfaceNormal, `${label}.surfaceNormal`);
            assert.strictEqual(actualDisk.diskLengthOverride, expectedDisk.diskLengthOverride, `${label}.diskLengthOverride`);
            assertVecBitEqual(
                {
                    x: actualDisk.pos.x + actualDisk.surfaceNormal.x * (actualDisk.diskLengthOverride ?? 0),
                    y: actualDisk.pos.y + actualDisk.surfaceNormal.y * (actualDisk.diskLengthOverride ?? 0),
                    z: actualDisk.pos.z + actualDisk.surfaceNormal.z * (actualDisk.diskLengthOverride ?? 0),
                },
                expectedJointPos,
                `${label}.socketPosition`,
            );
        }
        assertVecBitEqual(rtTwig.segments[0].bottomJoint!.pos, twigJointAPos, 'Twig.bottomJoint.pos');
        assertVecBitEqual(rtTwig.segments[0].topJoint!.pos, twigJointBPos, 'Twig.topJoint.pos');
    } finally {
        resetStore();
        resetKickstandsInState();
    }
});

test('VOXL V2 binary roundtrip preserves maxSafePenetrationMm and keeps absent case undefined', async () => {
    resetStore();
    resetKickstandsInState();

    try {
        const cappedCone: ContactCone = {
            id: 'stick-cone-capped',
            pos: { x: 0, y: 0, z: 2 },
            normal: { x: 0, y: 0, z: 1 },
            surfaceNormal: { x: 0, y: 0, z: 1 },
            socketJointId: 'stick-bj-pen',
            profile: {
                type: 'disk',
                contactDiameterMm: 0.4,
                bodyDiameterMm: 1.2,
                lengthMm: 3,
                penetrationMm: 0.05,
                maxSafePenetrationMm: 0.09,
                diskThicknessMm: 0.1,
                maxStandoffMm: 0.25,
                standoffAngleThreshold: Math.PI / 4,
            },
        };
        const uncappedCone: ContactCone = {
            id: 'stick-cone-uncapped',
            pos: { x: 0, y: 0, z: 10 },
            normal: { x: 0, y: 0, z: -1 },
            surfaceNormal: { x: 0, y: 0, z: -1 },
            socketJointId: 'stick-tj-pen',
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
        };

        const imported: DragonfruitImportFormat = {
            ...emptyWireCollections(),
            version: 1,
            meta: { source: 'unit-test-v2-max-pen', objectCenter: { x: 0, y: 0, z: 0 } },
            roots: [],
            knots: [],
        };
        setCollection(imported, 'stick', [
            {
                id: 'stick-pen-v2',
                modelId: 'model-1',
                segments: [
                    {
                        id: 'stick-seg-pen',
                        type: 'straight',
                        diameter: 1.0,
                        bottomJoint: { id: 'stick-bj-pen', pos: getFinalSocketPosition(cappedCone), diameter: 1.1 },
                        topJoint: { id: 'stick-tj-pen', pos: getFinalSocketPosition(uncappedCone), diameter: 1.1 },
                    },
                ],
                contactConeA: cappedCone,
                contactConeB: uncappedCone,
            },
        ]);

        loadFromImportFormat(imported);
        const supports = buildSupportExportFromStores(getSnapshot());
        const binary = await serializeVoxlDocumentV2({
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
        }, new Map());

        const parsed = (await parseVoxlBinaryV2(binary)).document;
        resetStore();
        resetKickstandsInState();
        loadFromImportFormat(parsed.supports);

        const rtStick = getSnapshot().sticks['stick-pen-v2'];
        assert.ok(rtStick, 'Stick must roundtrip');
        assert.strictEqual(rtStick.contactConeA.profile.maxSafePenetrationMm, 0.09);
        assert.strictEqual(rtStick.contactConeB.profile.maxSafePenetrationMm, undefined);
        assert.strictEqual('maxSafePenetrationMm' in rtStick.contactConeB.profile, false);
    } finally {
        resetStore();
        resetKickstandsInState();
    }
});