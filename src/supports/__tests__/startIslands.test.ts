import assert from 'node:assert/strict';
import test from 'node:test';
import * as THREE from 'three';

import {
    assessStartSupport,
    isStartIsland,
    markStartIslands,
    sameLayerStartTips,
    startRecipeForArea,
    START_SUPPORT_CONSTANTS,
} from '../autoSupport/startIslands';
import { collectSupportTips } from '../autoSupport/coverage';
import type { DetectedIsland } from '../../volumeAnalysis/Islands/types';

function island(over: Partial<DetectedIsland> = {}): DetectedIsland {
    return {
        id: 'v0',
        source: 'voxel',
        contact: new THREE.Vector3(0, 0, 10),
        baseZ: 10,
        areaMm2: 2,
        isDetached: true,
        ...over,
    };
}

test('a small detached 2 mm² island is a start with a two-contact base', () => {
    const start = island({ areaMm2: 2 });
    assert.equal(isStartIsland(start), true);
    const recipe = startRecipeForArea(2);
    assert.equal(recipe.minContacts, 2);
    assert.equal(recipe.coverageRadiusMm, START_SUPPORT_CONSTANTS.smallRadiusMm);
    assert.equal(recipe.coverageTarget, 0.99);
});

test('a narrow 1 mm-wide rib start is a start, recipe from its area', () => {
    const rib = island({ id: 'v-rib', areaMm2: 0.4 });
    assert.equal(isStartIsland(rib), true);
    assert.equal(startRecipeForArea(rib.areaMm2!).minContacts, 1,
        'a sub-0.5 mm² rib start needs one contact, not a three-point base it cannot fit');
});

test('a large 20 mm² flat start needs a three-point base', () => {
    const flat = island({ id: 'v-flat', areaMm2: 20 });
    assert.equal(isStartIsland(flat), true);
    const recipe = startRecipeForArea(20);
    assert.equal(recipe.minContacts, 3);
    assert.equal(recipe.coverageRadiusMm, START_SUPPORT_CONSTANTS.largeRadiusMm);
});

test('a non-start overhang is not a start', () => {
    const overhang = island({ source: 'overhang', isDetached: undefined, overhangAngleDeg: 30 });
    assert.equal(isStartIsland(overhang), false);
    assert.equal(markStartIslands([overhang])[0].startIsland, false);
});

test('an explicit startIsland stamp wins over the source heuristic', () => {
    assert.equal(isStartIsland(island({ source: 'minima', isDetached: undefined, startIsland: true })), true);
    assert.equal(isStartIsland(island({ startIsland: false })), false);
});

test('same-layer start tips ignore contacts at another cross-section', () => {
    const tips = [
        { x: 0, y: 0, z: 10.0 },
        { x: 0.5, y: 0, z: 10.1 },
        { x: 0.2, y: 0.2, z: 11.2 }, // a contact one layer up: must not suppress the start
        { x: 0.1, y: 0, z: 8.9 },
    ];
    const same = sameLayerStartTips(tips, 10);
    assert.deepEqual(same.map((t) => t.z), [10.0, 10.1],
        'only the 10 mm cross-section counts for the start recipe');
});

// ---------------------------------------------------------------------------
// Integration: three detached cross-sections, plus the old 3D dedupe trap
// ---------------------------------------------------------------------------

import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import { accelerateGeometry, initializeBVH } from '../../utils/bvh';
import { footprintFromPoints } from '../../volumeAnalysis/Islands/voxelFootprint';
import { computeAutoSupportPlan, forestReportToText } from '../autoSupport/autoPlace';
import { setModelMesh } from '../autoSupport/meshStore';
import { createDefaultSettings } from '../Settings/types';
import { getSettings, setSettings } from '../Settings/state';
import { resetKickstandsInState, resetStore } from '../state';

function detachedIsland(
    id: string,
    cx: number,
    cy: number,
    sizeX: number,
    sizeY: number,
    z: number,
): DetectedIsland {
    const voxels: Array<{ x: number; y: number; z?: number }> = [];
    for (let x = -sizeX / 2; x <= sizeX / 2 + 1e-9; x += 0.25) {
        for (let y = -sizeY / 2; y <= sizeY / 2 + 1e-9; y += 0.25) {
            voxels.push({ x: cx + x, y: cy + y, z });
        }
    }
    const area = sizeX * sizeY;
    return {
        id,
        source: 'voxel',
        contact: new THREE.Vector3(cx, cy, z),
        baseZ: z,
        areaMm2: area,
        isDetached: true,
        contactVoxels: footprintFromPoints(voxels),
    };
}

function detachedStartsScene(): { mesh: THREE.Mesh; islands: DetectedIsland[] } {
    const boxes = [
        new THREE.BoxGeometry(1, 0.5, 1).translate(-15, 0, 5.5),
        new THREE.BoxGeometry(1.9, 1.9, 1).translate(0, 0, 10.5),
        new THREE.BoxGeometry(4, 4, 1).translate(15, 0, 15.5),
    ];
    const geometry = mergeGeometries(boxes) ?? boxes[0];
    accelerateGeometry(geometry);
    const mesh = new THREE.Mesh(geometry);
    mesh.updateMatrixWorld(true);
    return {
        mesh,
        islands: [
            detachedIsland('start-tiny', -15, 0, 1, 0.5, 5),
            detachedIsland('start-small', 0, 0, 1.9, 1.9, 10),
            detachedIsland('start-large', 15, 0, 4, 4, 15),
        ],
    };
}

test('three stacked detached starts meet their recipe and report no pancake risk', () => {
    initializeBVH();
    const prev = getSettings();
    try {
        const settings = createDefaultSettings();
        settings.grid.enabled = false;
        setSettings(settings);
        resetStore();
        const { mesh, islands } = detachedStartsScene();
        setModelMesh('m', mesh);

        const plan = computeAutoSupportPlan(
            islands,
            'm',
            { debugSkipAutoBracing: true, stabilizationEnabled: false },
            undefined,
            mesh,
        );
        assert.ok(plan, 'plan computed');
        const tips = collectSupportTips(plan.support, 'm');
        for (const start of islands) {
            const status = assessStartSupport(start, tips, mesh);
            assert.ok(status.contacts >= status.minContacts,
                `${start.id}: ${status.contacts} contacts >= recipe ${status.minContacts}`);
            assert.ok(status.coverage >= START_SUPPORT_CONSTANTS.coverageTarget,
                `${start.id}: coverage ${(status.coverage * 100).toFixed(1)}% >= 99%`);
            assert.equal(status.pancakeRisk, false, `${start.id} must not be a pancake`);
        }
    } finally {
        setModelMesh('m', null);
        resetStore();
        resetKickstandsInState();
        setSettings(prev);
    }
});

test('an above-layer contact does not suppress the start contact the layer needs', () => {
    initializeBVH();
    const prev = getSettings();
    try {
        const settings = createDefaultSettings();
        settings.grid.enabled = false;
        setSettings(settings);
        resetStore();
        const { mesh, islands } = detachedStartsScene();
        setModelMesh('m', mesh);

        // Decoy: a support tip 1 mm above the tiny start, within 3 mm in 3D.
        // The generic filterAlreadySupported would drop a candidate there; the
        // start pass keys on the cross-section, so it must still fill it.
        const base = {
            roots: {
                rDecoy: {
                    id: 'rDecoy', modelId: 'm', transform: { pos: { x: -15, y: 0, z: 0 } },
                    diameter: 2, diskHeight: 0.5, coneHeight: 0.5,
                },
            },
            trunks: {
                tDecoy: {
                    id: 'tDecoy', modelId: 'm', rootId: 'rDecoy',
                    segments: [{
                        id: 'sDecoy', diameter: 1,
                        bottomJoint: { id: 'sd-b', pos: { x: -15, y: 0, z: 1 }, diameter: 1 },
                        topJoint: { id: 'sd-t', pos: { x: -15, y: 0, z: 6.8 }, diameter: 1 },
                    }],
                    contactCone: {
                        id: 'cDecoy', pos: { x: -15, y: 0, z: 6 },
                        normal: { x: 0, y: 0, z: -1 },
                        profile: { type: 'disk', contactDiameterMm: 0.28, bodyDiameterMm: 1, lengthMm: 2, penetrationMm: 0 },
                    },
                },
            },
            branches: {},
            leaves: {},
            twigs: {},
            sticks: {},
            braces: {},
            anchors: {},
            kickstands: {},
            stumps: {},
            knots: {},
            selectedId: null,
            hoveredId: null,
        } as never;

        const plan = computeAutoSupportPlan(
            islands,
            'm',
            { debugSkipAutoBracing: true, stabilizationEnabled: false },
            base,
            mesh,
        );
        assert.ok(plan, 'plan computed');
        // The decoy is 1 mm above the tiny start and inside the old 3 mm 3D
        // dedupe ball, so the generic candidate at this contact was dropped.
        const tinyStart = islands[0];
        assert.ok(Math.hypot(
            tinyStart.contact.x - -15,
            tinyStart.contact.y - 0,
            tinyStart.contact.z - 6,
        ) <= 3, 'the decoy is inside the old 3 mm 3D dedupe radius');
        const tips = collectSupportTips(plan.support, 'm');
        const tiny = assessStartSupport(tinyStart, tips, mesh);
        assert.ok(tiny.contacts >= 1, 'a same-layer start contact survives the above-layer decoy');
        assert.equal(tiny.pancakeRisk, false);
    } finally {
        setModelMesh('m', null);
        resetStore();
        resetKickstandsInState();
        setSettings(prev);
    }
});


test('the forest report carries a start row per start and a summary line', () => {
    initializeBVH();
    const prev = getSettings();
    try {
        const settings = createDefaultSettings();
        settings.grid.enabled = false;
        setSettings(settings);
        resetStore();
        const { mesh, islands } = detachedStartsScene();
        setModelMesh('m', mesh);
        const plateIsland: DetectedIsland = {
            ...detachedIsland('plate-grounded', -5, 0, 1, 1, 0),
            grounded: true,
        };
        const plan = computeAutoSupportPlan(
            [...islands, plateIsland],
            'm',
            { debugSkipAutoBracing: true, stabilizationEnabled: false },
            undefined,
            mesh,
        );
        assert.ok(plan, 'plan computed');
        const report = plan.result.analytics?.forestReport;
        assert.ok(report?.starts, 'start report present');
        assert.equal(report.starts.count, 3, 'a plate-grounded island is not a start needing support');
        assert.equal(report.starts.underSupported, 0);
        assert.equal(plan.result.analytics?.startIslands, 3);
        assert.equal(plan.result.analytics?.startsUnderSupported, 0);
        assert.deepEqual(report.starts.rows.map((row) => row.id).sort(),
            ['start-large', 'start-small', 'start-tiny']);
        for (const row of report.starts.rows) {
            assert.ok(row.coveragePct >= 99, `${row.id} coverage row >= 99%`);
            assert.ok(row.contacts >= row.minContacts, `${row.id} contacts row >= recipe`);
            assert.equal(row.pancakeRisk, false);
        }
        const text = forestReportToText(report);
        assert.match(text, /Starts: 3 \(0 under-supported\)/);
        assert.match(text, /start-large/);
    } finally {
        setModelMesh('m', null);
        resetStore();
        resetKickstandsInState();
        setSettings(prev);
    }
});

test('the generic passes alone leave a pancake; the closure removes it', () => {
    initializeBVH();
    const prev = getSettings();
    try {
        const settings = createDefaultSettings();
        settings.grid.enabled = false;
        setSettings(settings);
        const { mesh, islands } = detachedStartsScene();
        setModelMesh('m', mesh);

        // "Before": the same islands with the start marker disabled, so only
        // the generic overhang/area passes run (the pre-fix behavior).
        const legacyIslands = islands.map((island) => ({ ...island, startIsland: false }));
        resetStore();
        const legacyPlan = computeAutoSupportPlan(
            legacyIslands,
            'm',
            { debugSkipAutoBracing: true, stabilizationEnabled: false },
            undefined,
            mesh,
        );
        assert.ok(legacyPlan, 'legacy plan computed');
        const legacyTips = collectSupportTips(legacyPlan.support, 'm');
        const before = islands
            .map((start) => assessStartSupport(start, legacyTips, mesh))
            .filter((status) => status.pancakeRisk).length;

        // "After": the normal run, start markers on.
        resetStore();
        const fixedPlan = computeAutoSupportPlan(
            islands,
            'm',
            { debugSkipAutoBracing: true, stabilizationEnabled: false },
            undefined,
            mesh,
        );
        assert.ok(fixedPlan, 'fixed plan computed');
        const fixedTips = collectSupportTips(fixedPlan.support, 'm');
        const after = islands
            .map((start) => assessStartSupport(start, fixedTips, mesh))
            .filter((status) => status.pancakeRisk).length;

        assert.ok(before > 0, `the generic passes leave at least one pancake (got ${before})`);
        assert.equal(after, 0, 'the start closure leaves none');
    } finally {
        setModelMesh('m', null);
        resetStore();
        resetKickstandsInState();
        setSettings(prev);
    }
});
