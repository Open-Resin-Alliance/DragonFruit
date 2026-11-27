import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import * as THREE from 'three';
import { MeshBVH, acceleratedRaycast } from 'three-mesh-bvh';

import { clearHistory } from '../../history/historyStore';
import { clearSDFCacheForMesh, hasWarmSDFCache } from '../PlacementLogic/Pathfinding/SDFCachePool';
import {
    buildLeafCapAnchor,
    orbitLeafCapAnchorTowardKnot,
    resolvePlacementNormalAndCap,
} from '../PlacementLogic/PlacementNormalSynthesis';
import { resolveManualLeafTipAndCap } from '../PlacementLogic/PlacementUtils';
import { createDefaultSettings } from '../Settings/types';
import { getSettings, setSettings } from '../Settings/state';
import { getFinalSocketPosition } from '../SupportPrimitives/ContactCone/contactConeUtils';
import type { LeafCapAnchor } from '../SupportPrimitives/ContactCone/types';
import { recomputeContactConeForMovedDisk } from '../SupportPrimitives/ContactDisk/ContactDiskInteraction';
import { buildLeafData } from '../SupportTypes/Leaf/leafBuilder';
import { syncSproutTipFromRaycast } from '../SupportTypes/Leaf/leafFanningRaycast';
import { leafPlacementStore } from '../SupportTypes/Leaf/leafPlacementState';
import { recomputeLeafPreviewContactCone } from '../SupportTypes/Leaf/leafPreviewCone';
import { refreshMovedLeafCapAnchor } from '../SupportTypes/Leaf/LeafRenderer';
import { useLeafPlacement } from '../SupportTypes/Leaf/useLeafPlacement';
import {
    addKnot,
    addRoot,
    addSupportEntity,
    buildSupportDeltaTransform,
    getSnapshot,
    recomputeKnotDependentGeometry,
    resetStore,
    transformSupportRecord,
} from '../state';
import { updateSupportEntity } from '../supportTypeRegistry';
import type { Knot, Leaf, Vec3 } from '../types';

type BvhGeometry = THREE.BufferGeometry & { boundsTree?: MeshBVH };

function makeCubeMesh(size = 10, modelId = 'cube-model', centerZ = 0): THREE.Mesh {
    const geom = new THREE.BoxGeometry(size, size, size).toNonIndexed();
    if (centerZ !== 0) {
        geom.translate(0, 0, centerZ);
    }
    geom.computeVertexNormals();
    (geom as BvhGeometry).boundsTree = new MeshBVH(geom);
    const mesh = new THREE.Mesh(geom, new THREE.MeshBasicMaterial());
    mesh.raycast = acceleratedRaycast;
    mesh.userData = { modelId };
    mesh.updateMatrixWorld(true);
    return mesh;
}

function raycastMesh(mesh: THREE.Mesh, origin: THREE.Vector3, direction: THREE.Vector3): THREE.Intersection {
    const rc = new THREE.Raycaster(origin, direction.clone().normalize());
    const hits = rc.intersectObject(mesh, false);
    assert.ok(hits.length >= 1, 'expected raycast hit');
    return hits[0];
}

function angleDeg(a: Vec3, b: Vec3): number {
    const va = new THREE.Vector3(a.x, a.y, a.z).normalize();
    const vb = new THREE.Vector3(b.x, b.y, b.z).normalize();
    return THREE.MathUtils.radToDeg(Math.acos(THREE.MathUtils.clamp(va.dot(vb), -1, 1)));
}

test('1. G2 resolveManualLeafTipAndCap executes 1 shapecast for overhang, omits capAnchor on top face / forceRaw / smooth off, and populates store on click + sprout', () => {
    const prevSettings = getSettings();
    const mesh = makeCubeMesh(10, 'cube-manual', 10);
    const bvh = (mesh.geometry as BvhGeometry).boundsTree!;

    let shapecastCount = 0;
    const origShapecast = bvh.shapecast.bind(bvh);
    bvh.shapecast = ((...args: Parameters<MeshBVH['shapecast']>) => {
        shapecastCount += 1;
        return origShapecast(...args);
    }) as MeshBVH['shapecast'];

    try {
        const defaults = createDefaultSettings();
        setSettings({
            ...defaults,
            smoothContactNormals: true,
            normalSynthesisPreset: 'bisector',
            devToolsEnabled: false,
            tip: { ...defaults.tip, contactDiameterMm: 0.4 },
        });

        // Bottom overhang edge (z = 5, near x = 5): single shapecast returns normal + LeafCapAnchor
        const overhangHit = raycastMesh(mesh, new THREE.Vector3(4.95, 0, -5), new THREE.Vector3(0, 0, 1));
        shapecastCount = 0;
        const resolved = resolveManualLeafTipAndCap(overhangHit);
        assert.equal(shapecastCount, 1, 'G2 must run exactly 1 BVH shapecast for downward overhang');
        assert.ok(resolved.surfaceNormal instanceof THREE.Vector3);
        assert.ok(resolved.capAnchor, 'expected capAnchor on downward overhang');
        assert.ok(resolved.capAnchor.downwardTriCount > 0);
        assert.deepEqual(resolved.capAnchor.tipPos, {
            x: overhangHit.point.x,
            y: overhangHit.point.y,
            z: overhangHit.point.z,
        });

        // Top face (z = 15, raw.z > sin(35°)): capAnchor is undefined
        const topHit = raycastMesh(mesh, new THREE.Vector3(0, 0, 25), new THREE.Vector3(0, 0, -1));
        const topResolved = resolveManualLeafTipAndCap(topHit);
        assert.equal(topResolved.capAnchor, undefined);
        assert.ok(topResolved.surfaceNormal.z > 0.99);

        // forceRaw skips shapecast and returns capAnchor: undefined
        shapecastCount = 0;
        const forcedRaw = resolveManualLeafTipAndCap(overhangHit, { forceRaw: true });
        assert.equal(shapecastCount, 0);
        assert.equal(forcedRaw.capAnchor, undefined);
        assert.ok(forcedRaw.surfaceNormal.z < -0.9999);

        // smoothContactNormals: false skips shapecast and returns capAnchor: undefined
        setSettings({ ...getSettings(), smoothContactNormals: false });
        shapecastCount = 0;
        const smoothOff = resolveManualLeafTipAndCap(overhangHit);
        assert.equal(shapecastCount, 0);
        assert.equal(smoothOff.capAnchor, undefined);
        assert.ok(smoothOff.surfaceNormal.z < -0.9999);

        // Re-enable smooth and verify useLeafPlacement.onModelClick + syncSproutTipFromRaycast populate tipCapAnchor
        setSettings({ ...getSettings(), smoothContactNormals: true });
        leafPlacementStore.setHotkeyActive(true);
        let hookApi: ReturnType<typeof useLeafPlacement> | null = null;
        function Probe() {
            hookApi = useLeafPlacement();
            return null;
        }
        renderToStaticMarkup(React.createElement(Probe));
        assert.ok(hookApi);
        (hookApi as ReturnType<typeof useLeafPlacement>).onModelClick(overhangHit);
        const afterClick = leafPlacementStore.getSnapshot();
        assert.equal(afterClick.stage, 'awaitingBase');
        assert.ok(afterClick.tipCapAnchor, 'onModelClick must store tipCapAnchor');

        leafPlacementStore.reset();
        assert.equal(leafPlacementStore.getSnapshot().tipCapAnchor, null, 'reset() must clear tipCapAnchor');

        // Sprout raycast populates tipCapAnchor on hit and clears on miss
        leafPlacementStore.setStage('awaitingSproutTip');
        const sproutRay = new THREE.Raycaster(new THREE.Vector3(4.95, 0, -5), new THREE.Vector3(0, 0, 1));
        const sproutHit = syncSproutTipFromRaycast(sproutRay, [mesh]);
        assert.ok(sproutHit.surfaceNormal);
        assert.ok(leafPlacementStore.getSnapshot().tipCapAnchor, 'syncSproutTipFromRaycast must store tipCapAnchor');

        const missRay = new THREE.Raycaster(new THREE.Vector3(100, 100, -5), new THREE.Vector3(0, 0, 1));
        syncSproutTipFromRaycast(missRay, [mesh]);
        assert.equal(leafPlacementStore.getSnapshot().tipCapAnchor, null, 'off-mesh miss must clear tipCapAnchor');
    } finally {
        leafPlacementStore.setHotkeyActive(false);
        leafPlacementStore.reset();
        setSettings(prevSettings);
    }
});

test('2. awaitingBase/awaitingSproutTip orbiting, LeafPlacementController G4 cold-SDF guard, and LeafRenderer drag commit refresh', () => {
    const prevSettings = getSettings();
    const mesh = makeCubeMesh(10, 'cube-orbit', 10);
    const bvh = (mesh.geometry as BvhGeometry).boundsTree!;

    try {
        const defaults = createDefaultSettings();
        setSettings({
            ...defaults,
            smoothContactNormals: true,
            normalSynthesisPreset: 'bisector',
            devToolsEnabled: false,
            tip: { ...defaults.tip, contactDiameterMm: 0.4 },
        });

        const overhangHit = raycastMesh(mesh, new THREE.Vector3(4.95, 0, -5), new THREE.Vector3(0, 0, 1));
        const { surfaceNormal, capAnchor } = resolveManualLeafTipAndCap(overhangHit);
        assert.ok(capAnchor);

        let shapecastsDuringOrbit = 0;
        const origShapecast = bvh.shapecast.bind(bvh);
        bvh.shapecast = ((...args: Parameters<MeshBVH['shapecast']>) => {
            shapecastsDuringOrbit += 1;
            return origShapecast(...args);
        }) as MeshBVH['shapecast'];

        const tipPos = { x: overhangHit.point.x, y: overhangHit.point.y, z: overhangHit.point.z };
        const knotDown = { x: 4.95, y: 0, z: 0 };
        const knotSide = { x: 8.5, y: 0, z: 0 };
        const normalDown = orbitLeafCapAnchorTowardKnot(tipPos, knotDown, capAnchor);
        const normalSide = orbitLeafCapAnchorTowardKnot(tipPos, knotSide, capAnchor);
        assert.equal(shapecastsDuringOrbit, 0, 'orbiting uses 0 BVH shapecasts');
        assert.ok(angleDeg(normalDown, normalSide) > 10, 'orbiting toward +X knot tilts surfaceNormal cleanly');
        assert.notDeepEqual(surfaceNormal, normalDown);

        const built = buildLeafData({
            tipPos,
            surfaceNormal: normalSide,
            modelId: 'cube-orbit',
            parentKnot: { id: 'k1', parentShaftId: 's1', t: 0.5, pos: knotSide, diameter: 1.2 },
            hostDiameterMm: 1.2,
            capAnchor,
        });
        assert.deepEqual(built.leaf.contactCone.capAnchor, capAnchor);

        // Moving tip in recomputeContactConeForMovedDisk clears stale capAnchor, keeping when stationary
        const keptCone = recomputeContactConeForMovedDisk(built.leaf.contactCone, tipPos, normalDown, knotDown);
        assert.deepEqual(keptCone.capAnchor, capAnchor);
        const movedCone = recomputeContactConeForMovedDisk(
            built.leaf.contactCone,
            { x: tipPos.x - 1.0, y: tipPos.y, z: tipPos.z },
            { x: 0, y: 0, z: -1 },
            knotDown,
        );
        assert.equal(movedCone.capAnchor, undefined);

        // LeafRenderer onCommit helper refreshes capAnchor at moved tip when smoothContactNormals is on
        const refreshed = refreshMovedLeafCapAnchor(movedCone, 'cube-orbit', mesh);
        assert.ok(refreshed.capAnchor, 'LeafRenderer commit helper must refresh capAnchor at moved tip');
        assert.deepEqual(refreshed.capAnchor.tipPos, movedCone.pos);
        setSettings({ ...getSettings(), smoothContactNormals: false });
        const refreshedRaw = refreshMovedLeafCapAnchor(refreshed, 'cube-orbit', mesh);
        assert.equal(refreshedRaw.capAnchor, undefined, 'smoothContactNormals: false clears capAnchor on commit');

        // Structural verification of LeafPlacementController (G4 + orbiting + signature) & LeafRenderer (commit cap refresh)
        const controllerSrc = readFileSync(new URL('../SupportTypes/Leaf/LeafPlacementController.tsx', import.meta.url), 'utf8');
        assert.match(controllerSrc, /\bhasWarmSDFCache\b/, 'LeafPlacementController must apply G4 cold-SDF preview guard');
        assert.match(controllerSrc, /\borbitLeafCapAnchorTowardKnot\b/, 'LeafPlacementController must orbit awaitingBase and awaitingSproutTip');

        const rendererSrc = readFileSync(new URL('../SupportTypes/Leaf/LeafRenderer.tsx', import.meta.url), 'utf8');
        assert.match(rendererSrc, /\bextractSphericalCapDescriptor\b/, 'LeafRenderer onCommit must refresh capAnchor');
        assert.match(rendererSrc, /\bbuildLeafCapAnchor\b/, 'LeafRenderer onCommit must build refreshed LeafCapAnchor');
    } finally {
        setSettings(prevSettings);
    }
});

test('3. G3 recomputeLeafPreviewContactCone performs 0 BVH/SDF calls and completes K=16 leaves in < 1 ms', () => {
    const prevSettings = getSettings();
    const mesh = makeCubeMesh(10, 'cube-g3', 10);
    const bvh = (mesh.geometry as BvhGeometry).boundsTree!;

    let shapecasts = 0;
    const origShapecast = bvh.shapecast.bind(bvh);
    bvh.shapecast = ((...args: Parameters<MeshBVH['shapecast']>) => {
        shapecasts += 1;
        return origShapecast(...args);
    }) as MeshBVH['shapecast'];

    try {
        setSettings({ ...createDefaultSettings(), smoothContactNormals: true });
        const hit = raycastMesh(mesh, new THREE.Vector3(4.95, 0, -5), new THREE.Vector3(0, 0, 1));
        const { capAnchor } = resolveManualLeafTipAndCap(hit);
        assert.ok(capAnchor);

        const leaves: Leaf[] = Array.from({ length: 16 }, (_, idx) => {
            const tipPos = { x: 4.95, y: (idx - 8) * 0.25, z: 5 };
            const anchor: LeafCapAnchor = { ...capAnchor, tipPos };
            const built = buildLeafData({
                tipPos,
                surfaceNormal: { x: 0, y: 0, z: -1 },
                modelId: 'cube-g3',
                parentKnot: { id: 'preview-k', parentShaftId: 'seg-1', t: 0.5, pos: { x: 4.95, y: 0, z: 0 }, diameter: 1.2 },
                hostDiameterMm: 1.2,
                capAnchor: anchor,
            });
            return { ...built.leaf, id: `g3-leaf-${idx}` };
        });

        const previewKnot: Knot = {
            id: 'preview-k',
            parentShaftId: 'seg-1',
            t: 0.6,
            pos: { x: 8.0, y: 1.0, z: 0.5 },
            diameter: 1.2,
        };
        const twigMap = new Map();

        // JIT warmup outside timed loop (still counts BVH/SDF side effects)
        shapecasts = 0;
        const warmed = recomputeLeafPreviewContactCone(leaves[0], previewKnot, twigMap);
        assert.equal(shapecasts, 0);
        assert.equal(hasWarmSDFCache(mesh), false);
        assert.ok(angleDeg(warmed.contactCone.surfaceNormal!, leaves[0].contactCone.surfaceNormal!) > 10);

        // No-op frame returns exact same leaf object reference
        assert.equal(recomputeLeafPreviewContactCone(warmed, previewKnot, twigMap), warmed);

        const t0 = performance.now();
        for (let i = 0; i < leaves.length; i++) {
            recomputeLeafPreviewContactCone(leaves[i], previewKnot, twigMap);
        }
        const elapsedMs = performance.now() - t0;
        assert.equal(shapecasts, 0);
        assert.equal(hasWarmSDFCache(mesh), false);
        assert.ok(elapsedMs < 1.0, `expected G3 K=16 recompute < 1 ms, got ${elapsedMs.toFixed(3)} ms`);
    } finally {
        clearSDFCacheForMesh(mesh.uuid);
        setSettings(prevSettings);
    }
});

test('4. state.ts recomputeKnotDependentGeometry re-orbits surfaceNormal, preserves capAnchor, pins socket, and settles with trunk update', () => {
    const prevSettings = getSettings();
    resetStore();
    clearHistory();

    try {
        setSettings({ ...createDefaultSettings(), smoothContactNormals: true });
        const mesh = makeCubeMesh(10, 'cube-settle', 10);
        const hit = raycastMesh(mesh, new THREE.Vector3(4.95, 0, -5), new THREE.Vector3(0, 0, 1));
        const { capAnchor } = resolveManualLeafTipAndCap(hit);
        assert.ok(capAnchor);

        addRoot({
            id: 'settle-r',
            modelId: 'cube-settle',
            transform: { pos: { x: 4.95, y: 0, z: 0 }, rot: { x: 0, y: 0, z: 0, w: 1 } },
            diameter: 3,
            diskHeight: 0.5,
            coneHeight: 1.0,
        } as never);
        addSupportEntity('trunk', {
            id: 'settle-t',
            modelId: 'cube-settle',
            rootId: 'settle-r',
            segments: [{
                id: 'settle-s',
                diameter: 1.2,
                bottomJoint: { id: 'bj', pos: { x: 4.95, y: 0, z: 1.5 }, diameter: 1.3 },
                topJoint: { id: 'tj', pos: { x: 4.95, y: 0, z: 4.5 }, diameter: 1.3 },
            }],
        } as never);
        addKnot({
            id: 'settle-k',
            parentShaftId: 'settle-s',
            t: 0.5,
            pos: { x: 4.95, y: 0, z: 3.0 },
            diameter: 1.3,
        } as never);

        const tipPos = { x: hit.point.x, y: hit.point.y, z: hit.point.z };
        const initialNormal = orbitLeafCapAnchorTowardKnot(tipPos, { x: 4.95, y: 0, z: 3.0 }, capAnchor);
        const built = buildLeafData({
            tipPos,
            surfaceNormal: initialNormal,
            modelId: 'cube-settle',
            parentKnot: getSnapshot().knots['settle-k'],
            hostDiameterMm: 1.2,
            capAnchor,
        });
        addSupportEntity('leaf', built.leaf);

        // Direct recomputeKnotDependentGeometry toward moved outward knot
        const movedKnotPos = { x: 8.5, y: 0, z: 2.0 };
        const updatedLeaves = recomputeKnotDependentGeometry(getSnapshot().leaves, { 'settle-k': movedKnotPos });
        const updatedLeaf = updatedLeaves[built.leaf.id];
        assert.deepEqual(updatedLeaf.contactCone.capAnchor, capAnchor, 'settle must preserve capAnchor');
        assert.ok(
            angleDeg(updatedLeaf.contactCone.surfaceNormal!, initialNormal) > 10,
            'settle must re-orbit surfaceNormal toward moved knot',
        );
        const socket = getFinalSocketPosition(updatedLeaf.contactCone);
        const err = Math.hypot(socket.x - movedKnotPos.x, socket.y - movedKnotPos.y, socket.z - movedKnotPos.z);
        assert.ok(err < 1e-5, `expected socket pinned within 1e-5, got ${err}`);

        // Idempotent no-op returns exact same leaves map reference
        assert.equal(recomputeKnotDependentGeometry(updatedLeaves, { 'settle-k': movedKnotPos }), updatedLeaves);

        // Full trunk settle cascade updates leaf surfaceNormal + socket
        const trunk = getSnapshot().trunks['settle-t'];
        updateSupportEntity('trunk', {
            ...trunk,
            segments: [{
                ...trunk.segments[0],
                bottomJoint: { id: 'bj', pos: { x: 8.0, y: 0, z: 1.5 }, diameter: 1.3 },
                topJoint: { id: 'tj', pos: { x: 8.0, y: 0, z: 4.5 }, diameter: 1.3 },
            }],
        });
        const settledLeaf = getSnapshot().leaves[built.leaf.id];
        const settledKnot = getSnapshot().knots['settle-k'];
        assert.deepEqual(settledLeaf.contactCone.capAnchor, capAnchor);
        assert.ok(angleDeg(settledLeaf.contactCone.surfaceNormal!, initialNormal) > 10);
        const settledSocket = getFinalSocketPosition(settledLeaf.contactCone);
        assert.ok(
            Math.hypot(
                settledSocket.x - settledKnot.pos.x,
                settledSocket.y - settledKnot.pos.y,
                settledSocket.z - settledKnot.pos.z,
            ) < 1e-5,
        );
    } finally {
        resetStore();
        clearHistory();
        setSettings(prevSettings);
    }
});

test('5. transformContactCone preserves and rotates capAnchor on translation + Z-yaw, invalidates on pitch/roll tilt', () => {
    const mesh = makeCubeMesh(10, 'cube-xform', 10);
    const hit = raycastMesh(mesh, new THREE.Vector3(4.95, 0, -5), new THREE.Vector3(0, 0, 1));
    const { synthesis, cap } = resolvePlacementNormalAndCap(mesh, hit.point, { x: 0, y: 0, z: -1 }, {
        mode: 'bisector',
        contactRadiusMm: 0.2,
    });
    const capAnchor = buildLeafCapAnchor(hit.point, cap, synthesis.normal)!;
    assert.ok(capAnchor);

    const leaf: Leaf = {
        id: 'leaf-xform',
        typeId: 'leaf',
        modelId: 'cube-xform',
        parentKnotId: 'k-xform',
        contactCone: {
            id: 'cone-xform',
            pos: { x: hit.point.x, y: hit.point.y, z: hit.point.z },
            normal: { x: 0, y: 0, z: -1 },
            surfaceNormal: { x: synthesis.normal.x, y: synthesis.normal.y, z: synthesis.normal.z },
            capAnchor,
            profile: {
                type: 'disk',
                contactDiameterMm: 0.4,
                bodyDiameterMm: 1.2,
                lengthMm: 2.5,
                penetrationMm: 0.05,
                diskThicknessMm: 0.1,
                maxStandoffMm: 1.5,
                standoffAngleThreshold: Math.PI / 4,
            },
        },
    };

    const beforePose = {
        position: new THREE.Vector3(0, 0, 0),
        rotation: new THREE.Euler(0, 0, 0),
        scale: new THREE.Vector3(1, 1, 1),
    };

    // Pure translation + build-plate Z-yaw (90 deg around Z)
    const yawDelta = buildSupportDeltaTransform(beforePose, {
        position: new THREE.Vector3(10, -4, 3),
        rotation: new THREE.Euler(0, 0, Math.PI / 2),
        scale: new THREE.Vector3(1, 1, 1),
    })!;
    assert.ok(yawDelta);
    const yawLeaf = transformSupportRecord('leaf', leaf as unknown as Record<string, unknown>, yawDelta) as unknown as Leaf;
    const yawCap = yawLeaf.contactCone.capAnchor;
    assert.ok(yawCap, 'pure translation + Z-yaw must preserve capAnchor');
    assert.ok(Math.abs(yawCap.nMean.z - capAnchor.nMean.z) <= 1e-5);
    assert.ok(Math.abs(yawCap.nMean.y - capAnchor.nMean.x) < 1e-5, 'Z-yaw 90° rotates nMean.x into nMean.y');
    assert.ok(Math.abs(yawCap.baseNormal.y - capAnchor.baseNormal.x) < 1e-5);
    assert.ok(Math.abs(yawCap.tipPos.z - (capAnchor.tipPos.z + 3)) < 1e-5);

    // Pitch tilt around X (25 deg) invalidates capAnchor
    const pitchDelta = buildSupportDeltaTransform(beforePose, {
        position: new THREE.Vector3(0, 0, 0),
        rotation: new THREE.Euler(THREE.MathUtils.degToRad(25), 0, 0),
        scale: new THREE.Vector3(1, 1, 1),
    })!;
    assert.ok(pitchDelta);
    const pitchLeaf = transformSupportRecord('leaf', leaf as unknown as Record<string, unknown>, pitchDelta) as unknown as Leaf;
    assert.equal(pitchLeaf.contactCone.capAnchor, undefined, 'pitch/roll tilt must invalidate capAnchor');

    // Roll tilt around Y (25 deg) invalidates capAnchor
    const rollDelta = buildSupportDeltaTransform(beforePose, {
        position: new THREE.Vector3(0, 0, 0),
        rotation: new THREE.Euler(0, THREE.MathUtils.degToRad(25), 0),
        scale: new THREE.Vector3(1, 1, 1),
    })!;
    assert.ok(rollDelta);
    const rollLeaf = transformSupportRecord('leaf', leaf as unknown as Record<string, unknown>, rollDelta) as unknown as Leaf;
    assert.equal(rollLeaf.contactCone.capAnchor, undefined, 'roll tilt must invalidate capAnchor');
});
