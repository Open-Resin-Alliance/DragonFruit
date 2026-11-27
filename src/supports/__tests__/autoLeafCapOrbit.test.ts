import assert from 'node:assert/strict';
import test from 'node:test';
import * as THREE from 'three';
import { MeshBVH, acceleratedRaycast } from 'three-mesh-bvh';

import { clearHistory } from '../../history/historyStore';
import { accelerateGeometry, initializeBVH } from '../../utils/bvh';
import { footprintFromPoints } from '../../volumeAnalysis/Islands/voxelFootprint';
import type { DetectedIsland } from '../../volumeAnalysis/Islands/types';
import { decideGridPlacement } from '../PlacementLogic/Grid/gridPlacement';
import type { TrunkPlacementResult } from '../PlacementLogic/StandardPlacement';
import { getSettings, setSettings } from '../Settings/state';
import { createDefaultSettings } from '../Settings/types';
import { calculateDiskThickness } from '../SupportPrimitives/ContactDisk/contactDiskUtils';
import { buildTrunkDataFromPlacement } from '../SupportTypes/Trunk/trunkBuilder';
import {
    collectFanShaftPoints,
    computeAutoSupportPlan,
    fanLeafToHost,
} from '../autoSupport/autoPlace';
import { createDefaultAutoSupportSettings } from '../autoSupport/settings';
import { resetKickstandsInState, resetStore } from '../state';
import { createEmptySupportCollections } from '../supportTypeRegistry';
import type { SupportState, Vec3 } from '../types';

type BvhGeometry = THREE.BufferGeometry & { boundsTree?: MeshBVH };

function emptySupportState(): SupportState {
    return {
        ...createEmptySupportCollections(),
        selectedId: null,
        hoveredId: null,
    };
}

function makeBoxMesh(
    sizeX: number,
    sizeY: number,
    sizeZ: number,
    translate: [number, number, number],
    extraTriangles: number[][] = [],
): THREE.Mesh {
    const buildGeo = (): THREE.BufferGeometry => {
        const baseGeo = new THREE.BoxGeometry(sizeX, sizeY, sizeZ).toNonIndexed();
        baseGeo.translate(translate[0], translate[1], translate[2]);
        const basePos = baseGeo.getAttribute('position') as THREE.BufferAttribute;
        const totalFloats = basePos.count * 3 + extraTriangles.length * 9;
        const positions = new Float32Array(totalFloats);
        positions.set(basePos.array as Float32Array, 0);
        let offset = basePos.count * 3;
        for (const tri of extraTriangles) {
            positions.set(tri, offset);
            offset += 9;
        }
        const geometry = new THREE.BufferGeometry();
        geometry.setAttribute('position', new THREE.BufferAttribute(positions, 3));
        geometry.computeVertexNormals();
        accelerateGeometry(geometry);
        return geometry;
    };
    const renderGeo = buildGeo();
    const raycastGeo = buildGeo();
    const mesh = new THREE.Mesh(renderGeo, new THREE.MeshBasicMaterial());
    mesh.raycast = acceleratedRaycast;
    mesh.userData = { raycastGeometry: raycastGeo };
    mesh.updateMatrixWorld(true);
    return mesh;
}

function makeOpenBentSheetMesh(): THREE.Mesh {
    // Open +Z-facing sheet at z=12 meeting a 60°-sloped flank: upward rays miss so downHit runs.
    const dropZ = 2.5 * Math.sqrt(3);
    const positions = new Float32Array([
        -5, -5, 12, 0, -5, 12, 0, 5, 12,
        -5, -5, 12, 0, 5, 12, -5, 5, 12,
        0, -5, 12, 2.5, -5, 12 - dropZ, 2.5, 5, 12 - dropZ,
        0, -5, 12, 2.5, 5, 12 - dropZ, 0, 5, 12,
    ]);
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute('position', new THREE.BufferAttribute(positions, 3));
    geometry.computeVertexNormals();
    accelerateGeometry(geometry);
    const mesh = new THREE.Mesh(geometry, new THREE.MeshBasicMaterial());
    mesh.raycast = acceleratedRaycast;
    mesh.updateMatrixWorld(true);
    return mesh;
}

function addHostTrunk(
    state: SupportState,
    id: string,
    modelId: string,
    x: number,
    y: number,
    bottomZ: number,
    topZ: number,
    tipZ: number,
): void {
    const rootId = `r-${id}`;
    state.roots[rootId] = {
        id: rootId,
        modelId,
        transform: { pos: { x, y, z: 0 }, rot: { x: 0, y: 0, z: 0, w: 1 } },
        diameter: 2,
        diskHeight: 0.5,
        coneHeight: 1.0,
    };
    state.trunks[id] = {
        id,
        modelId,
        rootId,
        segments: [
            {
                id: `seg-${id}`,
                diameter: 1.0,
                bottomJoint: { id: `jb-${id}`, pos: { x, y, z: bottomZ }, diameter: 1.1 },
                topJoint: { id: `jt-${id}`, pos: { x, y, z: topZ }, diameter: 1.1 },
            },
        ],
        contactCone: {
            id: `cc-${id}`,
            pos: { x, y, z: tipZ },
            normal: { x: 0, y: 0, z: -1 },
            surfaceNormal: { x: 0, y: 0, z: -1 },
            profile: {
                type: 'disk',
                contactDiameterMm: 0.3,
                bodyDiameterMm: 1.0,
                lengthMm: 2.5,
                penetrationMm: 0.1,
                diskThicknessMm: 0.1,
                maxStandoffMm: 1.5,
                standoffAngleThreshold: Math.PI / 4,
            },
        },
    };
}

function spyShapecasts(mesh: THREE.Mesh): { count: () => number; reset: () => void } {
    const synthGeo = (mesh.userData?.raycastGeometry as BvhGeometry | undefined) ?? (mesh.geometry as BvhGeometry);
    const bvh = synthGeo.boundsTree!;
    let calls = 0;
    const orig = bvh.shapecast.bind(bvh);
    bvh.shapecast = ((...args: Parameters<MeshBVH['shapecast']>) => {
        calls += 1;
        return orig(...args);
    }) as MeshBVH['shapecast'];
    return {
        count: () => calls,
        reset: () => {
            calls = 0;
        },
    };
}

function angleDeg(a: Vec3, b: Vec3): number {
    const va = new THREE.Vector3(a.x, a.y, a.z).normalize();
    const vb = new THREE.Vector3(b.x, b.y, b.z).normalize();
    return THREE.MathUtils.radToDeg(Math.acos(THREE.MathUtils.clamp(va.dot(vb), -1, 1)));
}

test('1. G1 single shapecast per fanLeafToHost tip across multi-host pool + contactConeCollides uses orbited normal + branches stay un-orbited', () => {
    const prevSettings = getSettings();
    setSettings(createDefaultSettings());
    resetStore();
    resetKickstandsInState();
    clearHistory();
    initializeBVH();

    try {
        // Construct a tiny blocker triangle ONLY on the +0.25 offset ray of contactConeCollides
        // when using the un-orbited bisector normal (1/sqrt(2), 0, -1/sqrt(2)), while the orbited
        // normal shifts dir x n so all 3 rays clear it.
        const target = { x: 4.88, y: 0, z: 10 };
        const knotPos = new THREE.Vector3(3.5, -1.5, 7.0);
        const dir = new THREE.Vector3(target.x, target.y, target.z).sub(knotPos);
        const totalDist = dir.length();
        dir.normalize();
        const unorbited = new THREE.Vector3(1 / Math.SQRT2, 0, -1 / Math.SQRT2);
        const perp = new THREE.Vector3().crossVectors(dir, unorbited).normalize();
        const rayMid = knotPos.clone().addScaledVector(perp, 0.25).addScaledVector(dir, totalDist * 0.5);
        // Build two-sided tiny blocker (0.018 mm radius) oriented perpendicular to ray dir
        const uAxis = perp.clone().multiplyScalar(0.018);
        const vAxis = new THREE.Vector3().crossVectors(dir, perp).normalize().multiplyScalar(0.018);
        const p0 = rayMid.clone().add(uAxis);
        const p1 = rayMid.clone().sub(uAxis).add(vAxis);
        const p2 = rayMid.clone().sub(uAxis).sub(vAxis);
        const blockerTris = [
            [p0.x, p0.y, p0.z, p1.x, p1.y, p1.z, p2.x, p2.y, p2.z],
            [p0.x, p0.y, p0.z, p2.x, p2.y, p2.z, p1.x, p1.y, p1.z],
        ];

        const mesh = makeBoxMesh(10, 10, 10, [0, 0, 15], blockerTris);
        const spy = spyShapecasts(mesh);

        // Multi-host pool with 4 hosts: t-1 is pinned at (3.5, -1.5, 7.0) so all samples match the blocker ray
        const hostState = emptySupportState();
        addHostTrunk(hostState, 't-1', 'm-g1', 3.5, -1.5, 6.99, 7.0, 8.0);
        addHostTrunk(hostState, 't-2', 'm-g1', 3.2, -1.8, 1.5, 7.2, 8.0);
        addHostTrunk(hostState, 't-3', 'm-g1', 3.0, -2.0, 1.5, 7.3, 8.0);
        addHostTrunk(hostState, 't-4', 'm-g1', 2.8, -2.2, 1.5, 7.4, 8.0);
        const pool = collectFanShaftPoints(hostState);
        assert.ok(pool.length >= 16, 'expected multi-host pool across 4 hosts');

        // With leafCapOrbit: false -> un-orbited normal ray hits the blocker on t-1;
        // exclude t-2..t-4 so we isolate contactConeCollides on t-1.
        const t1OnlyExcluded = new Set(['t-2', 't-3', 't-4']);
        spy.reset();
        const unorbitedBlocked = fanLeafToHost(
            target,
            'm-g1',
            pool,
            new Set(),
            'k-unorb',
            6,
            6,
            45,
            6,
            hostState,
            mesh,
            'overhang',
            'steepest',
            undefined,
            t1OnlyExcluded,
            { ...createDefaultAutoSupportSettings(), normalSynthesisMode: 'bisector', leafCapOrbit: false },
        );
        assert.equal(unorbitedBlocked.ok, false, 'un-orbited contactConeCollides must hit blocker on +0.25 perp ray');
        assert.equal(unorbitedBlocked.reason, 'blocked');
        assert.equal(spy.count(), 1, 'G1: 1 shapecast even across multi-host pool');

        // With leafCapOrbit: true -> orbited normal shifts perp away from blocker so t-1 succeeds!
        spy.reset();
        const orbitedPass = fanLeafToHost(
            target,
            'm-g1',
            pool,
            new Set(),
            'k-orb',
            6,
            6,
            45,
            6,
            hostState,
            mesh,
            'overhang',
            'steepest',
            undefined,
            t1OnlyExcluded,
            { ...createDefaultAutoSupportSettings(), normalSynthesisMode: 'bisector', leafCapOrbit: true },
        );
        assert.equal(orbitedPass.ok, true, 'orbited contactConeCollides must clear blocker when leafCapOrbit=true');
        assert.equal(orbitedPass.kind, 'leaf');
        assert.equal(spy.count(), 1, 'G1 + G2: exactly 1 BVH shapecast per tip across pool');

        // Also test multi-host traversal where first 2 hosts in full pool are blocked by a leaf-crossing
        // dummy leaf or exclusion? Put an existing leaf blocking t-2/t-3 via leafPathCrossesSupports and
        // test t-4 wins while total shapecasts across all tried hosts stays === 1!
        const multiState = emptySupportState();
        addHostTrunk(multiState, 'h-a', 'm-multi', 3.4, 2.0, 1.5, 7.6, 8.2);
        addHostTrunk(multiState, 'h-b', 'm-multi', 3.1, -2.0, 1.5, 7.5, 8.2);
        addHostTrunk(multiState, 'h-c', 'm-multi', 2.8, 1.5, 1.5, 7.4, 8.2);
        addHostTrunk(multiState, 'h-d', 'm-multi', 2.4, 0, 1.5, 7.0, 8.2);
        const multiPool = collectFanShaftPoints(multiState);
        // Add existing leaves on h-a, h-b, h-c at capacity = 1 so pool tries h-a..h-c then succeeds on h-d
        for (const hid of ['h-a', 'h-b', 'h-c']) {
            multiState.knots[`k-full-${hid}`] = {
                id: `k-full-${hid}`,
                parentShaftId: `seg-${hid}`,
                t: 0.5,
                pos: { x: 3.0, y: 0, z: 4.5 },
                diameter: 1.1,
            };
        }
        const cleanMesh = makeBoxMesh(10, 10, 10, [0, 0, 15]);
        const cleanSpy = spyShapecasts(cleanMesh);
        cleanSpy.reset();
        const multiRes = fanLeafToHost(
            target,
            'm-multi',
            multiPool,
            new Set(),
            'k-multi',
            6,
            6,
            45,
            1,
            multiState,
            cleanMesh,
            'overhang',
            'steepest',
            undefined,
            undefined,
            { ...createDefaultAutoSupportSettings(), normalSynthesisMode: 'bisector', leafCapOrbit: true },
        );
        assert.equal(multiRes.ok, true);
        assert.equal(multiRes.hostId, 'h-d');
        assert.equal(cleanSpy.count(), 1, 'G1 must execute <= 1 shapecast regardless of multi-host pool traversal');

        // Verify isBranchAttempt === true (span > 5.9 mm) stays on un-orbited resolved.normal without capAnchor
        const branchState = emptySupportState();
        addHostTrunk(branchState, 'h-branch', 'm-br', 4.85, 0, 1.5, 3.5, 4.0);
        const branchPool = collectFanShaftPoints(branchState);
        cleanSpy.reset();
        const branchRes = fanLeafToHost(
            target,
            'm-br',
            branchPool,
            new Set(),
            'k-br',
            8,
            8,
            45,
            6,
            branchState,
            cleanMesh,
            'overhang',
            'steepest',
            undefined,
            undefined,
            { ...createDefaultAutoSupportSettings(), normalSynthesisMode: 'bisector', leafCapOrbit: true },
        );
        assert.equal(branchRes.ok, true);
        assert.equal(branchRes.kind, 'branch');
        assert.equal(cleanSpy.count(), 1);
        const branchCone = branchRes.draft.branches[branchRes.entityId]?.contactCone;
        assert.ok(branchCone?.surfaceNormal);
        assert.equal(branchCone.capAnchor, undefined, 'branch attempts must not receive leaf capAnchor');
        assert.ok(
            angleDeg(branchCone.surfaceNormal, unorbited) < 1.0,
            `branch attempt must stay on un-orbited resolved.normal, got (${branchCone.surfaceNormal.x.toFixed(3)}, ${branchCone.surfaceNormal.y.toFixed(3)}, ${branchCone.surfaceNormal.z.toFixed(3)})`,
        );
    } finally {
        setSettings(prevSettings);
    }
});

test('2. Convex 90° ridge with inward knot: leafCapOrbit orbits leaf surfaceNormal inward, reduces disk thickness, and attaches capAnchor (fanLeafToHost + merge)', () => {
    const prevSettings = getSettings();
    setSettings(createDefaultSettings());
    resetStore();
    resetKickstandsInState();
    clearHistory();
    initializeBVH();

    try {
        // 10x10x10 box translated so underside is z = 10, +X vertical wall at x = 5.
        const mesh = makeBoxMesh(10, 10, 10, [0, 0, 15]);
        const tipPos = { x: 4.92, y: 0, z: 10 };

        // A) fanLeafToHost comparison: leafCapOrbit: false vs true
        const fanHost = emptySupportState();
        addHostTrunk(fanHost, 't-inward', 'm-ridge', 2.5, 0, 1.5, 6.8, 7.2);
        const pool = collectFanShaftPoints(fanHost);

        const fanOff = fanLeafToHost(
            tipPos,
            'm-ridge',
            pool,
            new Set(),
            'k-off',
            6,
            6,
            45,
            6,
            fanHost,
            mesh,
            'overhang',
            'steepest',
            undefined,
            undefined,
            { ...createDefaultAutoSupportSettings(), normalSynthesisMode: 'bisector', leafCapOrbit: false },
        );
        const fanOn = fanLeafToHost(
            tipPos,
            'm-ridge',
            pool,
            new Set(),
            'k-on',
            6,
            6,
            45,
            6,
            fanHost,
            mesh,
            'overhang',
            'steepest',
            undefined,
            undefined,
            { ...createDefaultAutoSupportSettings(), normalSynthesisMode: 'bisector', leafCapOrbit: true },
        );

        assert.equal(fanOff.ok, true);
        assert.equal(fanOn.ok, true);
        assert.equal(fanOff.kind, 'leaf');
        assert.equal(fanOn.kind, 'leaf');

        const coneOff = fanOff.draft.leaves[fanOff.entityId]?.contactCone;
        const coneOn = fanOn.draft.leaves[fanOn.entityId]?.contactCone;
        assert.ok(coneOff?.surfaceNormal && coneOn?.surfaceNormal);
        assert.equal(coneOff.capAnchor, undefined, 'leafCapOrbit: false must not attach capAnchor');
        assert.ok(coneOn.capAnchor, 'leafCapOrbit: true must attach capAnchor');
        assert.ok(coneOn.capAnchor.downwardTriCount >= 1);

        // Off keeps 45° outward bisector (~0.707, 0, -0.707); On orbits inward toward -Z / inward knot
        assert.ok(coneOff.surfaceNormal.x > 0.65);
        assert.ok(
            coneOn.surfaceNormal.x < coneOff.surfaceNormal.x - 0.15,
            `expected orbited x < un-orbited ${coneOff.surfaceNormal.x.toFixed(3)}, got ${coneOn.surfaceNormal.x.toFixed(3)}`,
        );

        assert.equal(coneOff.profile.type, 'disk');
        assert.equal(coneOn.profile.type, 'disk');
        const thickOff = calculateDiskThickness(coneOff.surfaceNormal, coneOff.normal, coneOff.profile);
        const thickOn = calculateDiskThickness(coneOn.surfaceNormal, coneOn.normal, coneOn.profile);
        assert.ok(
            thickOn < thickOff - 0.01,
            `expected orbiting to reduce disk thickness (${thickOn.toFixed(4)} < ${thickOff.toFixed(4)})`,
        );

        // B) placeOneCandidate direct shaft merge-leaf path in computeAutoSupportPlan
        const mergeBase = emptySupportState();
        // Host trunk at x=1.8, top tip at z=7.2 -> >3mm away from (4.92,0,10) so not already-supported,
        // <=4mm XY so findMergeHost finds it, and knot at (1.8,0,6.8) -> span ~4.47mm <= 4.5mm leaf merge!
        addHostTrunk(mergeBase, 't-merge', 'm-merge', 1.8, 0, 1.5, 6.8, 7.2);
        const ridgeIsland: DetectedIsland[] = [
            {
                id: 'ridge-tip',
                source: 'voxel',
                class: 'voxelOnly',
                isDetached: false,
                contact: new THREE.Vector3(4.92, 0, 10),
                baseZ: 10,
                areaMm2: 0.4,
            },
        ];
        const planMergeOff = computeAutoSupportPlan(
            ridgeIsland,
            'm-merge',
            {
                debugSkipAutoBracing: true,
                stabilizationEnabled: false,
                minimaReinforcementEnabled: false,
                normalSynthesisMode: 'bisector',
                leafCapOrbit: false,
            },
            mergeBase,
            mesh,
        );
        const planMergeOn = computeAutoSupportPlan(
            ridgeIsland,
            'm-merge',
            {
                debugSkipAutoBracing: true,
                stabilizationEnabled: false,
                minimaReinforcementEnabled: false,
                normalSynthesisMode: 'bisector',
                leafCapOrbit: true,
            },
            mergeBase,
            mesh,
        );
        assert.ok(planMergeOff && planMergeOn);
        const mergeLeavesOff = Object.values(planMergeOff.support.leaves);
        const mergeLeavesOn = Object.values(planMergeOn.support.leaves);
        assert.equal(mergeLeavesOff.length, 1, 'expected direct merge leaf when leafCapOrbit=false');
        assert.equal(mergeLeavesOn.length, 1, 'expected direct merge leaf when leafCapOrbit=true');
        const mConeOff = mergeLeavesOff[0].contactCone!;
        const mConeOn = mergeLeavesOn[0].contactCone!;
        assert.equal(mConeOff.capAnchor, undefined);
        assert.ok(mConeOn.capAnchor, 'placeOneCandidate merge-leaf must attach capAnchor when leafCapOrbit=true');
        assert.ok(mConeOn.surfaceNormal!.x < mConeOff.surfaceNormal!.x - 0.15);
        assert.equal(mConeOff.profile.type, 'disk');
        assert.equal(mConeOn.profile.type, 'disk');
        assert.ok(
            calculateDiskThickness(mConeOn.surfaceNormal!, mConeOn.normal, mConeOn.profile) <
                calculateDiskThickness(mConeOff.surfaceNormal!, mConeOff.normal, mConeOff.profile) - 0.01,
        );
    } finally {
        setSettings(prevSettings);
    }
});

test('3. PlacementLogic/Grid/gridPlacement.ts (decideGridPlacement) lattice-node leaf orbits when knotWeightedLeafNormals: true and skips when false or smoothContactNormals: false', () => {
    const prevSettings = getSettings();
    resetStore();
    resetKickstandsInState();
    clearHistory();
    initializeBVH();

    try {
        // Box with underside at z=10 and +X wall at x=1.45 (x in [-6.55, 1.45], y in [-4, 4], z in [10, 18]).
        const mesh = makeBoxMesh(8, 8, 8, [-2.55, 0, 14]);
        const modelId = 'grid-orbit-m';

        // Host trunk standing at grid node (0, 0), segment from z=1.5 to z=8.6
        const snapshot = emptySupportState();
        addHostTrunk(snapshot, 't-grid-host', modelId, 0, 0, 1.5, 8.6, 9.2);

        const tipPos = { x: 1.40, y: 0, z: 10 };
        const tipNormal = { x: 1 / Math.SQRT2, y: 0, z: -1 / Math.SQRT2 };

        const makeGridSettings = (opts: {
            smooth: boolean;
            knotWeighted: boolean;
            devToolsEnabled?: boolean;
            leafRimSlackDeg?: number;
        }) => {
            const s = createDefaultSettings();
            s.grid.enabled = true;
            s.grid.spacingMm = 4;
            s.grid.minBranchAngleDeg = 45;
            s.grid.attachSearchStepMm = 0.25;
            s.smoothContactNormals = opts.smooth;
            s.autoSupport.smoothContactNormals = opts.smooth;
            s.autoSupport.knotWeightedLeafNormals = opts.knotWeighted;
            s.devToolsEnabled = opts.devToolsEnabled ?? false;
            s.devTools.leafRimSlackDeg = opts.leafRimSlackDeg ?? 0;
            return s;
        };

        const placement: TrunkPlacementResult = {
            basePos: { x: 0, y: 0, z: 0 },
            socketPos: { x: 1.4, y: 0, z: 9 },
            unsnappedBottomPos: { x: 0, y: 0, z: 0 },
            snappedNodeKey: '0,0',
            joints: [],
            constructionJoints: [],
        };
        const candidateBuild = buildTrunkDataFromPlacement(
            { tipPos, tipNormal, modelId },
            placement,
        );

        const settingsOn = makeGridSettings({ smooth: true, knotWeighted: true });
        setSettings(settingsOn);
        const decOn = decideGridPlacement({
            settings: settingsOn,
            snapshot,
            candidate: candidateBuild,
            tipPos,
            tipNormal,
            modelId,
            mesh,
        });
        assert.equal(decOn.kind, 'place');
        assert.equal(decOn.placed.typeId, 'leaf');
        const leafOn = decOn.placed.entity as SupportState['leaves'][string];
        assert.ok(leafOn.contactCone?.capAnchor, 'grid lattice leaf must attach capAnchor when knotWeightedLeafNormals=true');
        assert.ok(
            leafOn.contactCone.surfaceNormal!.x < tipNormal.x - 0.15,
            `expected grid leaf surfaceNormal.x < ${tipNormal.x.toFixed(3)}, got ${leafOn.contactCone.surfaceNormal!.x.toFixed(3)}`,
        );

        const settingsKnotOff = makeGridSettings({ smooth: true, knotWeighted: false });
        setSettings(settingsKnotOff);
        const decKnotOff = decideGridPlacement({
            settings: settingsKnotOff,
            snapshot,
            candidate: candidateBuild,
            tipPos,
            tipNormal,
            modelId,
            mesh,
        });
        assert.equal(decKnotOff.kind, 'place');
        assert.equal(decKnotOff.placed.typeId, 'leaf');
        const leafKnotOff = decKnotOff.placed.entity as SupportState['leaves'][string];
        assert.equal(leafKnotOff.contactCone?.capAnchor, undefined);
        assert.ok(angleDeg(leafKnotOff.contactCone!.surfaceNormal!, tipNormal) < 1e-6);

        const settingsSmoothOff = makeGridSettings({ smooth: false, knotWeighted: true });
        setSettings(settingsSmoothOff);
        const decSmoothOff = decideGridPlacement({
            settings: settingsSmoothOff,
            snapshot,
            candidate: candidateBuild,
            tipPos,
            tipNormal,
            modelId,
            mesh,
        });
        assert.equal(decSmoothOff.kind, 'place');
        assert.equal(decSmoothOff.placed.typeId, 'leaf');
        const leafSmoothOff = decSmoothOff.placed.entity as SupportState['leaves'][string];
        assert.equal(leafSmoothOff.contactCone?.capAnchor, undefined);
        assert.ok(angleDeg(leafSmoothOff.contactCone!.surfaceNormal!, tipNormal) < 1e-6);

        // DevTools leafRimSlackDeg gating
        const settingsDevOff = makeGridSettings({ smooth: true, knotWeighted: true, devToolsEnabled: false, leafRimSlackDeg: 15 });
        setSettings(settingsDevOff);
        const decDevOff = decideGridPlacement({
            settings: settingsDevOff,
            snapshot,
            candidate: candidateBuild,
            tipPos,
            tipNormal,
            modelId,
            mesh,
        });
        assert.equal(decDevOff.kind, 'place');
        assert.equal((decDevOff.placed.entity as SupportState['leaves'][string]).contactCone?.capAnchor?.rimSlackRad, 0);

        const settingsDevOn = makeGridSettings({ smooth: true, knotWeighted: true, devToolsEnabled: true, leafRimSlackDeg: 15 });
        setSettings(settingsDevOn);
        const decDevOn = decideGridPlacement({
            settings: settingsDevOn,
            snapshot,
            candidate: candidateBuild,
            tipPos,
            tipNormal,
            modelId,
            mesh,
        });
        assert.equal(decDevOn.kind, 'place');
        const devOnAnchor = (decDevOn.placed.entity as SupportState['leaves'][string]).contactCone?.capAnchor;
        assert.ok(devOnAnchor && devOnAnchor.rimSlackRad > THREE.MathUtils.degToRad(14));
    } finally {
        setSettings(prevSettings);
    }
});

test('4. Top-surface downHit contact in computeAutoSupportPlan and fanLeafToHost leaves capAnchor === undefined', () => {
    const prevSettings = getSettings();
    setSettings(createDefaultSettings());
    resetStore();
    resetKickstandsInState();
    clearHistory();
    initializeBVH();

    try {
        const sheetMesh = makeOpenBentSheetMesh();
        const modelId = 'downhit-m';
        const baseState = emptySupportState();
        // Host trunk below sheet near (-2, 0), top tip at z=9.2 (>3mm from (-0.05, 0, 12))
        addHostTrunk(baseState, 't-sheet', modelId, -2.0, 0, 1.5, 9.0, 9.2);

        // A) fanLeafToHost direct downHit check
        const pool = collectFanShaftPoints(baseState);
        const fanRes = fanLeafToHost(
            { x: -0.05, y: 0, z: 12 },
            modelId,
            pool,
            new Set(),
            'k-down-fan',
            6,
            6,
            45,
            6,
            baseState,
            sheetMesh,
            'overhang',
            'steepest',
            undefined,
            undefined,
            { ...createDefaultAutoSupportSettings(), normalSynthesisMode: 'bisector', leafCapOrbit: true },
        );
        assert.equal(fanRes.ok, true);
        assert.equal(fanRes.kind, 'leaf');
        assert.equal(
            fanRes.draft.leaves[fanRes.entityId]?.contactCone?.capAnchor,
            undefined,
            'downHit in fanLeafToHost must leave capAnchor === undefined',
        );

        // B) computeAutoSupportPlan end-to-end downHit check on a watertight 2.5 mm slab:
        //    Box z in [9.5, 12.0], x in [-4, 4]: at tip (3.95, 0, 12.0), upHit starts at seedZ=10.0
        //    (above bottom z=9.5, inside slab -> misses), so downHit from seedZ=14.0 hits top face!
        const slabMesh = makeBoxMesh(8, 8, 2.5, [0, 0, 10.75]);
        const planBase = emptySupportState();
        // Host trunk outside box at x=6.0, topZ=9.0, tipZ=9.2 (>3mm from (3.95,0,12.0) so not already-supported)
        addHostTrunk(planBase, 't-slab-host', modelId, 6.0, 0, 1.5, 9.0, 9.2);
        const islands: DetectedIsland[] = [
            {
                id: 'down-sheet',
                source: 'overhang',
                class: 'voxelOnly',
                isDetached: false,
                contact: new THREE.Vector3(3.95, 0, 12.0),
                baseZ: 12.0,
                areaMm2: 0.4,
            },
        ];
        const plan = computeAutoSupportPlan(
            islands,
            modelId,
            {
                debugSkipAutoBracing: true,
                stabilizationEnabled: false,
                minimaReinforcementEnabled: false,
                normalSynthesisMode: 'bisector',
                leafCapOrbit: true,
            },
            planBase,
            slabMesh,
        );
        assert.ok(plan);
        const leaves = Object.values(plan.support.leaves);
        assert.ok(leaves.length >= 1, 'expected downHit island to place a leaf onto baseState trunk');
        for (const leaf of leaves) {
            assert.equal(leaf.contactCone?.capAnchor, undefined, 'downHit in computeAutoSupportPlan must leave capAnchor === undefined');
        }
    } finally {
        setSettings(prevSettings);
    }
});

test('5. { normalSynthesisMode: "raw", leafCapOrbit: false } performs 0 synthesis/cap shapecasts and omits capSplit', () => {
    const prevSettings = getSettings();
    setSettings(createDefaultSettings());
    resetStore();
    resetKickstandsInState();
    clearHistory();
    initializeBVH();

    try {
        // #797 dual-geometry mesh: PlacementNormalSynthesis queries raycastGeometry via modelGeometryOf(mesh),
        // while SDFCache/Raycaster use renderGeometry — letting us spy purely on synthesis/cap shapecasts!
        const renderGeo = new THREE.BoxGeometry(12, 12, 6).toNonIndexed();
        renderGeo.translate(0, 0, 15);
        renderGeo.computeVertexNormals();
        accelerateGeometry(renderGeo);

        const raycastGeo = new THREE.BoxGeometry(12, 12, 6).toNonIndexed();
        raycastGeo.translate(0, 0, 15);
        raycastGeo.computeVertexNormals();
        accelerateGeometry(raycastGeo);

        const mesh = new THREE.Mesh(renderGeo, new THREE.MeshBasicMaterial());
        mesh.raycast = acceleratedRaycast;
        mesh.userData = { raycastGeometry: raycastGeo };
        mesh.updateMatrixWorld(true);

        const synthBvh = (raycastGeo as BvhGeometry).boundsTree!;
        let synthShapecasts = 0;
        const origShapecast = synthBvh.shapecast.bind(synthBvh);
        synthBvh.shapecast = ((...args: Parameters<MeshBVH['shapecast']>) => {
            synthShapecasts += 1;
            return origShapecast(...args);
        }) as MeshBVH['shapecast'];

        const points: { x: number; y: number }[] = [];
        for (let x = -5; x <= 5; x += 0.5) {
            for (let y = -5; y <= 5; y += 0.5) {
                points.push({ x, y });
            }
        }
        const islands: DetectedIsland[] = [
            {
                id: 'raw-slab',
                source: 'overhang',
                contact: new THREE.Vector3(0, 0, 12),
                baseZ: 12,
                areaMm2: 144,
                surfaceNormal: { x: 0, y: 0, z: -1 },
                contactVoxels: footprintFromPoints(points),
            },
        ];

        synthShapecasts = 0;
        const plan = computeAutoSupportPlan(
            islands,
            'raw-zero-m',
            { debugSkipAutoBracing: true, normalSynthesisMode: 'raw', leafCapOrbit: false },
            undefined,
            mesh,
        );
        assert.ok(plan);
        assert.equal(synthShapecasts, 0, 'raw + leafCapOrbit: false must perform 0 synthesis/cap BVH shapecasts');
        const leaves = Object.values(plan.support.leaves);
        assert.ok(leaves.length > 0, 'expected placed leaves on slab');
        for (const leaf of leaves) {
            assert.equal(leaf.contactCone?.capAnchor, undefined);
        }
        const metrics = plan.analytics.normalSynthesisMetrics!;
        assert.equal(metrics.mode, 'raw');
        assert.equal(metrics.leafCapOrbit, false);
        assert.equal(metrics.capSplit, undefined);
        assert.equal('capSplit' in metrics, false);
    } finally {
        setSettings(prevSettings);
    }
});
