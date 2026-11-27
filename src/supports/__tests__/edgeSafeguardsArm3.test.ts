import assert from 'node:assert/strict';
import test from 'node:test';
import * as THREE from 'three';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';

import {
    DEFAULT_MATERIAL_ANTI_ALIASING_SETTINGS,
    addMaterialProfile,
    addPrinterProfile,
    getActiveMaterialProfile,
    getActivePrinterProfile,
    removeMaterialProfile,
    removePrinterProfile,
    setActiveMaterialProfile,
    setActivePrinterProfile,
} from '@/features/profiles/profileStore';
import { buildSupportAndRaftWorldTriangles } from '@/features/slicing/rasterLayerZipExport';
import { clearHistory } from '@/history/historyStore';
import { accelerateGeometry, initializeBVH } from '@/utils/bvh';
import type { DetectedIsland } from '@/volumeAnalysis/Islands/types';
import { footprintFromPoints } from '@/volumeAnalysis/Islands/voxelFootprint';
import { isContactConeBlocked } from '../PlacementLogic/CollisionAvoidance';
import { clearSDFCacheForMesh, getOrCreateSDFCache } from '../PlacementLogic/Pathfinding/SDFCachePool';
import { getSettings, setSettings } from '../Settings/state';
import { createDefaultSettings } from '../Settings/types';
import { getFinalSocketPosition } from '../SupportPrimitives/ContactCone/contactConeUtils';
import type { ContactCone, LeafCapAnchor, SupportTipProfile } from '../SupportPrimitives/ContactCone/types';
import { recomputeContactConeForMovedDisk } from '../SupportPrimitives/ContactDisk/ContactDiskInteraction';
import { calculateDiskThickness } from '../SupportPrimitives/ContactDisk/contactDiskUtils';
import { buildStick } from '../SupportTypes/Stick/stickBuilder';
import { computeAutoSupportPlan } from '../autoSupport/autoPlace';
import { computeNormalSynthesisMetrics } from '../autoSupport/normalSynthesisTelemetry';
import { buildConeSlotIndex } from '../instanced/coneSlots';
import { appendConeGeometry } from '../exportGeometry/helpers';
import { getSnapshot, resetKickstandsInState, resetStore, setSnapshot } from '../state';
import { createEmptySupportCollections } from '../supportTypeRegistry';
import type { SupportState, Vec3 } from '../types';

function emptySupportState(): SupportState {
    return {
        ...createEmptySupportCollections(),
        selectedId: null,
        hoveredId: null,
        selectedCategory: null,
        hoveredCategory: 'none',
        interactionWarning: null,
    };
}

function makeNonIndexedAcceleratedMesh(
    geom: THREE.BufferGeometry,
    material: THREE.Material = new THREE.MeshBasicMaterial({ side: THREE.FrontSide }),
): THREE.Mesh {
    initializeBVH();
    const nonIndexed = geom.index ? geom.toNonIndexed() : geom;
    nonIndexed.computeVertexNormals();
    accelerateGeometry(nonIndexed);
    const mesh = new THREE.Mesh(nonIndexed, material);
    mesh.updateMatrixWorld(true);
    return mesh;
}

function makeDiskCone(overrides: Omit<Partial<ContactCone>, 'profile'> & { profile?: Partial<Extract<SupportTipProfile, { type: 'disk' }>> } = {}): ContactCone {
    const { profile: profileOverrides, ...coneOverrides } = overrides;
    return {
        id: 'cone-edge-test',
        pos: { x: 0, y: 0, z: 10 },
        normal: { x: 0, y: 0, z: -1 },
        surfaceNormal: { x: 0, y: 0, z: -1 },
        profile: {
            type: 'disk',
            contactDiameterMm: 0.28,
            bodyDiameterMm: 0.8,
            lengthMm: 2.5,
            penetrationMm: 0.05,
            diskThicknessMm: 0.1,
            maxStandoffMm: 1.5,
            standoffAngleThreshold: Math.PI / 4,
            ...profileOverrides,
        },
        ...coneOverrides,
    };
}

test('Test 1 (Pen-A1): 0.20 mm closed FrontSide blade stamps maxSafePenetrationMm=0.09 across cone, stick, coneSlots, SupportGeometryGenerator, and slicer without mutating renderGeometry normals', () => {
    const prevSettings = getSettings();
    const prevSnapshot = getSnapshot();
    const prevPrinter = getActivePrinterProfile();
    const prevMaterial = getActiveMaterialProfile();
    setSettings(createDefaultSettings());
    resetStore();
    clearHistory();
    initializeBVH();

    const tempPrinterId = prevPrinter
        ? null
        : addPrinterProfile({ name: 'Pen-A1 Test Printer', manufacturer: 'Test' });
    const printerId = prevPrinter?.id ?? tempPrinterId!;
    const tempMaterialId = addMaterialProfile(printerId, {
        name: 'Pen-A1 Manual 0.25mm',
        layerHeightMm: 0.05,
        antiAliasingSettings: {
            ...DEFAULT_MATERIAL_ANTI_ALIASING_SETTINGS,
            enableCustomSettings: true,
            enableOverride: true,
            tipOffsetMode: 'manual',
            tipOffsetMm: 0.25,
            tipOffsetDisplayInUi: true,
        },
    });

    // 0.20 mm closed FrontSide blade occupying z in [10.0, 10.2] with split render/raycast geometries (#797)
    const renderGeom = new THREE.BoxGeometry(10, 10, 0.2).translate(0, 0, 10.1).toNonIndexed();
    renderGeom.computeVertexNormals();
    const renderNormalsBefore = new Float32Array(renderGeom.attributes.normal.array as Float32Array);

    const raycastGeom = new THREE.BoxGeometry(10, 10, 0.2).translate(0, 0, 10.1).toNonIndexed();
    raycastGeom.computeVertexNormals();
    accelerateGeometry(raycastGeom);

    const bladeMesh = new THREE.Mesh(renderGeom, new THREE.MeshBasicMaterial({ side: THREE.FrontSide }));
    bladeMesh.userData = { raycastGeometry: raycastGeom };
    bladeMesh.updateMatrixWorld(true);

    try {
        setActiveMaterialProfile(tempMaterialId);

        const baseCone = makeDiskCone({
            id: 'pen-a1-cone',
            pos: { x: 0, y: 0, z: 10 },
            normal: { x: 0, y: 0, z: -1 },
            surfaceNormal: { x: 0, y: 0, z: -1 },
        });
        const recomputed = recomputeContactConeForMovedDisk(
            baseCone,
            { x: 0, y: 0, z: 10 },
            { x: 0, y: 0, z: -1 },
            { x: 0, y: 0, z: 7 },
            bladeMesh,
            { edgeSafeguards: true },
        );

        assert.equal(recomputed.profile.maxSafePenetrationMm, 0.09);
        assert.deepEqual(
            renderGeom.attributes.normal.array as Float32Array,
            renderNormalsBefore,
            '#797 renderGeometry normals must stay immutable',
        );

        // Stick Pen-A1 check on the same 0.20 mm blade
        const stickRes = buildStick({
            modelId: 'm-blade',
            aPos: { x: 0, y: 0, z: 10 },
            aNormal: { x: 0, y: 0, z: -1 },
            bPos: { x: 0, y: 0, z: 5 },
            bNormal: { x: 0, y: 0, z: 1 },
            mesh: bladeMesh,
            edgeSafeguards: true,
        });
        // contactConeB corresponds to z=10 after canonical lower-to-upper Z sort
        assert.equal(stickRes.stick.contactConeB.profile.maxSafePenetrationMm, 0.09);
        assert.equal(stickRes.stick.contactConeA.profile.maxSafePenetrationMm, undefined);

        // Consumer 1: buildConeSlotIndex
        const slotIndex = buildConeSlotIndex([{ color: '#ffffff', cones: [recomputed] }]);
        assert.equal(slotIndex.slots.length, 1);
        assert.equal(slotIndex.slots[0].slot.maxSafePenetrationMm, 0.09);

        // Consumer 2: appendConeGeometry (SupportGeometryGenerator) with AA = 0.25 mm
        const exportGroup = new THREE.Group();
        appendConeGeometry(exportGroup, recomputed);
        const coneGroup = exportGroup.children[0] as THREE.Group;
        const tipSphere = coneGroup.children[1] as THREE.Mesh;
        // contactDiameter=0.28 -> r=0.14 -> z = 10 - 0.14 + 0.09 = 9.95 (instead of uncapped 10.11)
        assert.ok(
            Math.abs(tipSphere.position.z - 9.95) < 1e-6,
            `expected clamped tipSphere.z=9.95, got ${tipSphere.position.z}`,
        );
        const diskGroup = exportGroup.children[1] as THREE.Group;
        const diskShaft = diskGroup.children[0] as THREE.Mesh;
        const shaftHeight = (diskShaft.geometry as THREE.CylinderGeometry).parameters.height;
        assert.ok(Math.abs(shaftHeight - 0.23) < 1e-6, `expected clamped disk height 0.23, got ${shaftHeight}`);

        // Consumer 3: rasterLayerZipExport (`buildSupportAndRaftWorldTriangles`) with AA = 0.25 mm
        const state = emptySupportState();
        state.roots['r-1'] = {
            id: 'r-1',
            modelId: 'm-blade',
            transform: { pos: { x: 0, y: 0, z: 0 }, rot: { x: 0, y: 0, z: 0, w: 1 } },
            diameter: 2,
            diskHeight: 0.5,
            coneHeight: 1.0,
        };
        state.trunks['t-1'] = {
            id: 't-1',
            modelId: 'm-blade',
            rootId: 'r-1',
            segments: [
                {
                    id: 's-1',
                    diameter: 0.8,
                    bottomJoint: { id: 'j0', pos: { x: 0, y: 0, z: 1.5 }, diameter: 0.8 },
                    topJoint: { id: 'j1', pos: { x: 0, y: 0, z: 7 }, diameter: 0.8 },
                },
            ],
            contactCone: recomputed,
        };
        setSnapshot(state);
        const triangles = buildSupportAndRaftWorldTriangles(new Set(['m-blade']));
        const maxTriZ = triangles.reduce((acc, tri) => Math.max(acc, tri.zMax), -Infinity);
        // Unclamped AA=0.25 reaches 10.25 (past blade top 10.20); clamped stops at <= 10.09
        assert.ok(maxTriZ <= 10.09 + 1e-5, `expected raster triangles <= 10.09 mm, got ${maxTriZ}`);
    } finally {
        clearSDFCacheForMesh(bladeMesh.uuid);
        setSnapshot(prevSnapshot);
        setSettings(prevSettings);
        if (prevPrinter) setActivePrinterProfile(prevPrinter.id);
        if (prevMaterial) setActiveMaterialProfile(prevMaterial.id);
        removeMaterialProfile(tempMaterialId);
        if (tempPrinterId) removePrinterProfile(tempPrinterId);
    }
});

test('Test 2 (Pen-A2): 90-degree concave valley raises diskLengthOverride >= 0.14*SQRT2 when aligned with bisector while convex corner stays flush at 0.14 mm', () => {
    const bisector: Vec3 = { x: -Math.SQRT1_2, y: 0, z: -Math.SQRT1_2 };
    const socket: Vec3 = { x: -2.5 * Math.SQRT1_2, y: 0, z: -2.5 * Math.SQRT1_2 };
    const cone = makeDiskCone({
        id: 'pen-a2-cone',
        pos: { x: 0, y: 0, z: 0 },
        normal: bisector,
        surfaceNormal: bisector,
        profile: {
            type: 'disk',
            contactDiameterMm: 0.28,
            bodyDiameterMm: 0.8,
            lengthMm: 2.5,
            penetrationMm: 0,
            diskThicknessMm: 0.1,
            maxStandoffMm: 1.5,
            standoffAngleThreshold: Math.PI / 4,
        },
    });

    const concave = recomputeContactConeForMovedDisk(
        cone,
        cone.pos,
        bisector,
        socket,
        undefined,
        {
            edgeSafeguards: true,
            cornerMeta: { isConcave: true, thetaSpreadRad: Math.PI / 4 },
        },
    );
    const expectedFloor = 0.14 * Math.SQRT2;
    assert.ok(concave.diskLengthOverride !== undefined, 'concave valley must set diskLengthOverride');
    assert.ok(
        concave.diskLengthOverride >= expectedFloor - 1e-12,
        `expected diskLengthOverride >= ${expectedFloor}, got ${concave.diskLengthOverride}`,
    );

    const capAnchor: LeafCapAnchor = {
        nMean: bisector,
        baseNormal: bisector,
        thetaSpreadRad: Math.PI / 4,
        rimSlackRad: 0,
        thetaCapRad: Math.PI / 4,
        coneAngleLimitRad: Math.PI / 4,
        isConcave: true,
        downwardTriCount: 2,
        tipPos: cone.pos,
    };
    const fromCapAnchor = recomputeContactConeForMovedDisk(
        { ...cone, capAnchor },
        cone.pos,
        bisector,
        socket,
        undefined,
        { edgeSafeguards: true },
    );
    assert.ok(
        fromCapAnchor.diskLengthOverride !== undefined
        && fromCapAnchor.diskLengthOverride >= expectedFloor - 1e-12,
        'capAnchor metadata must drive Pen-A2 concave floor when cornerMeta option omitted',
    );

    const convex = recomputeContactConeForMovedDisk(
        cone,
        cone.pos,
        bisector,
        socket,
        undefined,
        {
            edgeSafeguards: true,
            cornerMeta: { isConcave: false, thetaSpreadRad: Math.PI / 4 },
        },
    );
    assert.equal(convex.diskLengthOverride, undefined, '90-degree convex corner stays flush');
    if (convex.profile.type !== 'disk') assert.fail('expected disk profile');
    const convexThickness = calculateDiskThickness(convex.surfaceNormal!, convex.normal, convex.profile);
    assert.ok(Math.abs(convexThickness - 0.14) < 1e-12, `expected 0.14 mm flush thickness, got ${convexThickness}`);
});

test('Test 3 (Safe-B1/B2 & H3): oblique cone in 90-degree corner gets exact-SDF standoff, keeps pinned socket exact vs shifts rigidly when undefined, and reports H3 metrics', () => {
    initializeBVH();
    const ceiling = new THREE.BoxGeometry(10, 10, 2).translate(-5, 0, 1);
    const wall = new THREE.BoxGeometry(2, 10, 12).translate(1, 0, -4);
    const cornerGeom = mergeGeometries([ceiling, wall], false);
    assert.ok(cornerGeom);
    const cornerMesh = makeNonIndexedAcceleratedMesh(cornerGeom);

    try {
        const contactPos: Vec3 = { x: 0, y: 0, z: 0 };
        const bisector: Vec3 = { x: -Math.SQRT1_2, y: 0, z: -Math.SQRT1_2 };
        const cornerMeta = { isConcave: true, thetaSpreadRad: Math.PI / 4 };

        // Case A: fixedSocketPos pinned (x = -0.36 clears socket radius 0.25 + 0.05 = 0.30, while mid-cone grazes wall x=0)
        const pinnedSocket: Vec3 = { x: -0.36, y: 0, z: -2.0 };
        const pinnedInput = makeDiskCone({
            id: 'safe-b-pinned',
            pos: contactPos,
            normal: { x: -0.1, y: 0, z: -0.995 },
            surfaceNormal: bisector,
            profile: {
                type: 'disk',
                contactDiameterMm: 0.28,
                bodyDiameterMm: 0.6,
                lengthMm: 2.0,
                penetrationMm: 0,
                diskThicknessMm: 0.1,
                maxStandoffMm: 1.5,
                standoffAngleThreshold: Math.PI / 4,
            },
        });
        const pinnedRecomputed = recomputeContactConeForMovedDisk(
            pinnedInput,
            contactPos,
            bisector,
            pinnedSocket,
            cornerMesh,
            { edgeSafeguards: true, cornerMeta },
        );
        if (pinnedRecomputed.profile.type !== 'disk') assert.fail('expected disk profile');
        const pinnedUncollided = calculateDiskThickness(
            pinnedRecomputed.surfaceNormal!,
            pinnedRecomputed.normal,
            pinnedRecomputed.profile,
        );
        assert.ok(
            pinnedRecomputed.diskLengthOverride !== undefined
            && pinnedRecomputed.diskLengthOverride > pinnedUncollided + 1e-4,
            `pinned oblique corner cone must get collision standoff (${pinnedRecomputed.diskLengthOverride} vs ${pinnedUncollided})`,
        );
        const pinnedFinalSocket = getFinalSocketPosition(pinnedRecomputed);
        const pinnedErr = Math.hypot(
            pinnedFinalSocket.x - pinnedSocket.x,
            pinnedFinalSocket.y - pinnedSocket.y,
            pinnedFinalSocket.z - pinnedSocket.z,
        );
        assert.ok(pinnedErr < 1e-12, `expected pinned socket exact within 1e-12, got ${pinnedErr}`);

        const cornerSdf = getOrCreateSDFCache(cornerMesh);
        cornerSdf.refreshMatrix();
        assert.equal(
            isContactConeBlocked(cornerSdf, {
                start: {
                    x: contactPos.x + bisector.x * pinnedRecomputed.diskLengthOverride,
                    y: contactPos.y + bisector.y * pinnedRecomputed.diskLengthOverride,
                    z: contactPos.z + bisector.z * pinnedRecomputed.diskLengthOverride,
                },
                end: pinnedFinalSocket,
                startRadius: 0.14,
                endRadius: 0.3,
            }),
            false,
            'pinned corner cone must clear exact SDF sweep',
        );

        // Case B: fixedSocketPos undefined -> shifts rigidly along surfaceNormal
        const initialThickness = 0.14;
        const shiftCone = makeDiskCone({
            id: 'safe-b-shift',
            pos: contactPos,
            normal: { x: 0, y: 0, z: -1 },
            surfaceNormal: bisector,
            profile: {
                type: 'disk',
                contactDiameterMm: 0.28,
                bodyDiameterMm: 0.5,
                lengthMm: 2.0,
                penetrationMm: 0,
                diskThicknessMm: 0.1,
                maxStandoffMm: 1.5,
                standoffAngleThreshold: Math.PI / 4,
            },
        });
        const originalSocket = getFinalSocketPosition(shiftCone);
        const shiftedRecomputed = recomputeContactConeForMovedDisk(
            shiftCone,
            contactPos,
            bisector,
            undefined,
            cornerMesh,
            { edgeSafeguards: true, cornerMeta },
        );
        if (shiftedRecomputed.profile.type !== 'disk') assert.fail('expected disk profile');
        const shiftUncollided = calculateDiskThickness(
            shiftedRecomputed.surfaceNormal!,
            shiftedRecomputed.normal,
            shiftedRecomputed.profile,
        );
        assert.ok(
            shiftedRecomputed.diskLengthOverride !== undefined
            && shiftedRecomputed.diskLengthOverride > shiftUncollided + 1e-4,
            `unpinned oblique corner cone must get collision standoff (${shiftedRecomputed.diskLengthOverride} vs ${shiftUncollided})`,
        );
        const shiftedFinalSocket = getFinalSocketPosition(shiftedRecomputed);
        const expectedShift = shiftedRecomputed.diskLengthOverride - initialThickness;
        const shiftErr = Math.hypot(
            shiftedFinalSocket.x - (originalSocket.x + bisector.x * expectedShift),
            shiftedFinalSocket.y - (originalSocket.y + bisector.y * expectedShift),
            shiftedFinalSocket.z - (originalSocket.z + bisector.z * expectedShift),
        );
        assert.ok(shiftErr < 1e-9, `expected rigid socket shift along bisector, err=${shiftErr}`);
        assert.equal(
            isContactConeBlocked(cornerSdf, {
                start: {
                    x: contactPos.x + bisector.x * shiftedRecomputed.diskLengthOverride,
                    y: contactPos.y + bisector.y * shiftedRecomputed.diskLengthOverride,
                    z: contactPos.z + bisector.z * shiftedRecomputed.diskLengthOverride,
                },
                end: shiftedFinalSocket,
                startRadius: 0.14,
                endRadius: 0.25,
            }),
            false,
            'rigidly shifted corner cone must clear exact SDF sweep',
        );

        // H3 telemetry: collisionDrivenCount > 0, concaveFloorCount, thinWallClampedCount
        const state = emptySupportState();
        state.leaves['leaf-corner'] = {
            id: 'leaf-corner',
            modelId: 'm-h3',
            parentKnotId: 'k-1',
            contactCone: {
                ...pinnedRecomputed,
                capAnchor: {
                    nMean: bisector,
                    baseNormal: bisector,
                    thetaSpreadRad: Math.PI / 4,
                    rimSlackRad: 0,
                    thetaCapRad: Math.PI / 4,
                    coneAngleLimitRad: Math.PI / 4,
                    isConcave: true,
                    downwardTriCount: 2,
                    tipPos: contactPos,
                },
            },
        };
        state.trunks['trunk-thin'] = {
            id: 'trunk-thin',
            modelId: 'm-h3',
            rootId: 'r-1',
            segments: [],
            contactCone: makeDiskCone({
                id: 'cone-thin',
                profile: { maxSafePenetrationMm: 0.09 },
            }),
        };

        const h3Metrics = computeNormalSynthesisMetrics(state, 'm-h3', {
            mode: 'bisector',
            leafCapOrbit: true,
            edgeSafeguards: true,
        });

        assert.ok(h3Metrics.overall.collisionDrivenCount > 0);
        assert.equal(h3Metrics.concaveFloorCount, 1);
        assert.equal(h3Metrics.thinWallClampedCount, 1);
    } finally {
        clearSDFCacheForMesh(cornerMesh.uuid);
    }
});

test('Test 4 (edgeSafeguards: false): computeAutoSupportPlan omits thinWallClampedCount/concaveFloorCount and keeps Arm 2 purity while edgeSafeguards: true clamps thin walls', () => {
    const prevSettings = getSettings();
    setSettings(createDefaultSettings());
    resetStore();
    resetKickstandsInState();
    clearHistory();
    initializeBVH();

    // 0.20 mm thin slab overhang at z in [12.0, 12.2]
    const slabMesh = makeNonIndexedAcceleratedMesh(new THREE.BoxGeometry(10, 10, 0.2).translate(0, 0, 12.1));

    try {
        const points: { x: number; y: number }[] = [];
        for (let x = -4; x <= 4; x += 0.5) {
            for (let y = -4; y <= 4; y += 0.5) {
                points.push({ x, y });
            }
        }
        const islands: DetectedIsland[] = [
            {
                id: 'thin-slab-island',
                source: 'overhang',
                contact: new THREE.Vector3(0, 0, 12),
                baseZ: 12,
                areaMm2: 100,
                surfaceNormal: { x: 0, y: 0, z: -1 },
                contactVoxels: footprintFromPoints(points),
            },
        ];

        const baseOpts = {
            debugSkipAutoBracing: true,
            stabilizationEnabled: false,
            minimaReinforcementEnabled: false,
            normalSynthesisMode: 'bisector' as const,
            leafCapOrbit: true,
            leafRimSlackDeg: 0,
        };

        const arm2Plan = computeAutoSupportPlan(
            islands,
            'm-arm2-off',
            { ...baseOpts, edgeSafeguards: false },
            undefined,
            slabMesh,
        );
        const arm3Plan = computeAutoSupportPlan(
            islands,
            'm-arm3-on',
            { ...baseOpts, edgeSafeguards: true },
            undefined,
            slabMesh,
        );

        assert.ok(arm2Plan && arm3Plan);
        const arm2Metrics = arm2Plan.analytics.normalSynthesisMetrics;
        const arm3Metrics = arm3Plan.analytics.normalSynthesisMetrics;

        assert.ok(arm2Metrics && arm3Metrics);
        assert.equal(arm2Metrics.mode, 'bisector');
        assert.equal(arm2Metrics.leafCapOrbit, true);
        assert.equal('thinWallClampedCount' in arm2Metrics, false);
        assert.equal('concaveFloorCount' in arm2Metrics, false);

        const arm2Cones: ContactCone[] = [
            ...Object.values(arm2Plan.support.trunks).map((t) => t.contactCone).filter((c): c is ContactCone => Boolean(c)),
            ...Object.values(arm2Plan.support.branches).map((b) => b.contactCone).filter((c): c is ContactCone => Boolean(c)),
            ...Object.values(arm2Plan.support.leaves).map((l) => l.contactCone),
            ...Object.values(arm2Plan.support.stumps).map((s) => s.contactCone),
            ...Object.values(arm2Plan.support.sticks).flatMap((s) => [s.contactConeA, s.contactConeB]),
        ];
        assert.ok(arm2Cones.length > 0);
        for (const c of arm2Cones) {
            assert.equal(c.profile.maxSafePenetrationMm, undefined, 'edgeSafeguards: false must not stamp maxSafePenetrationMm');
        }

        assert.equal('thinWallClampedCount' in arm3Metrics, true);
        assert.equal('concaveFloorCount' in arm3Metrics, true);
        assert.ok((arm3Metrics.thinWallClampedCount ?? 0) > 0, 'edgeSafeguards: true must stamp thin-wall clamps on 0.20 mm slab');
    } finally {
        clearSDFCacheForMesh(slabMesh.uuid);
        setSettings(prevSettings);
    }
});
