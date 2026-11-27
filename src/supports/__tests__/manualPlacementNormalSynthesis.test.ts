import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import * as THREE from 'three';
import { MeshBVH, acceleratedRaycast } from 'three-mesh-bvh';

import { footprintFromPoints } from '@/volumeAnalysis/Islands/voxelFootprint';
import { clearHistory } from '../../history/historyStore';
import { calculateRawWorldNormal, calculateSmoothedNormal } from '../PlacementLogic/PlacementUtils';
import { createDefaultSettings } from '../Settings/types';
import { getSettings, setSettings } from '../Settings/state';
import {
    startContactDiskDragSession,
    type ContactDiskDragHit,
} from '../SupportPrimitives/ContactDisk/contactDiskDragController';
import type { ContactCone } from '../SupportPrimitives/ContactCone/types';
import { syncSproutTipFromRaycast } from '../SupportTypes/Leaf/leafFanningRaycast';
import { leafPlacementStore } from '../SupportTypes/Leaf/leafPlacementState';
import {
    useContactDiskDragSession,
    type ContactDiskDragSessionApi,
} from '../SupportTypes/useContactDiskDragSession';
import { computeAutoSupportPlan } from '../autoSupport/autoPlace';
import { resetKickstandsInState, resetStore } from '../state';
import type { DetectedIsland } from '../../volumeAnalysis/Islands/types';

type BvhGeometry = THREE.BufferGeometry & { boundsTree?: MeshBVH };

function makeCubeMesh(size = 10, modelId = 'cube-model'): THREE.Mesh {
    const geom = new THREE.BoxGeometry(size, size, size).toNonIndexed();
    geom.computeVertexNormals();
    (geom as BvhGeometry).boundsTree = new MeshBVH(geom);
    const mesh = new THREE.Mesh(geom, new THREE.MeshBasicMaterial());
    mesh.raycast = acceleratedRaycast;
    mesh.userData = { modelId };
    mesh.updateMatrixWorld(true);
    return mesh;
}

function angleDeg(
    a: { x: number; y: number; z: number },
    b: { x: number; y: number; z: number },
): number {
    const va = new THREE.Vector3(a.x, a.y, a.z).normalize();
    const vb = new THREE.Vector3(b.x, b.y, b.z).normalize();
    return THREE.MathUtils.radToDeg(Math.acos(THREE.MathUtils.clamp(va.dot(vb), -1, 1)));
}

function raycastCube(
    mesh: THREE.Mesh,
    origin: THREE.Vector3,
    direction: THREE.Vector3,
): THREE.Intersection {
    const rc = new THREE.Raycaster(origin, direction.clone().normalize());
    const hits = rc.intersectObject(mesh, false);
    assert.ok(hits.length >= 1, 'expected raycast hit on cube');
    return hits[0];
}

function createViewportElement(): HTMLElement {
    return {
        getBoundingClientRect: () => ({
            left: 0,
            top: 0,
            width: 200,
            height: 200,
            right: 200,
            bottom: 200,
            x: 0,
            y: 0,
            toJSON: () => ({}),
        }),
    } as unknown as HTMLElement;
}

function withMockWindowAndRaf<T>(
    run: (controls: {
        dispatchPointerMove: (clientX: number, clientY: number) => void;
        flushRaf: () => void;
    }) => T,
): T {
    const g = globalThis as unknown as {
        window?: unknown;
        requestAnimationFrame?: (cb: FrameRequestCallback) => number;
        cancelAnimationFrame?: (id: number) => void;
    };
    const prevWindow = g.window;
    const prevRaf = g.requestAnimationFrame;
    const prevCancel = g.cancelAnimationFrame;

    const listeners = new Map<string, Set<(ev: unknown) => void>>();
    const rafQueue = new Map<number, FrameRequestCallback>();
    let nextRafId = 1;

    g.window = {
        addEventListener: (type: string, listener: (ev: unknown) => void) => {
            let set = listeners.get(type);
            if (!set) {
                set = new Set();
                listeners.set(type, set);
            }
            set.add(listener);
        },
        removeEventListener: (type: string, listener: (ev: unknown) => void) => {
            listeners.get(type)?.delete(listener);
        },
        dispatchEvent: (ev: { type: string }) => {
            const set = listeners.get(ev.type);
            if (set) {
                for (const fn of [...set]) fn(ev);
            }
            return true;
        },
    };
    g.requestAnimationFrame = (cb: FrameRequestCallback) => {
        const id = nextRafId++;
        rafQueue.set(id, cb);
        return id;
    };
    g.cancelAnimationFrame = (id: number) => {
        rafQueue.delete(id);
    };

    try {
        return run({
            dispatchPointerMove: (clientX: number, clientY: number) => {
                const set = listeners.get('pointermove');
                if (set) {
                    const ev = { type: 'pointermove', clientX, clientY };
                    for (const fn of [...set]) fn(ev);
                }
            },
            flushRaf: () => {
                const pending = [...rafQueue.entries()];
                rafQueue.clear();
                for (const [, cb] of pending) {
                    cb(performance.now());
                }
            },
        });
    } finally {
        if (prevWindow === undefined) delete g.window;
        else g.window = prevWindow;
        if (prevRaf === undefined) delete g.requestAnimationFrame;
        else g.requestAnimationFrame = prevRaf;
        if (prevCancel === undefined) delete g.cancelAnimationFrame;
        else g.cancelAnimationFrame = prevCancel;
    }
}

test('1. 90° sharp cube edge hover & sprout return bisector when smoothContactNormals: true and bit-for-bit raw when false', () => {
    const prevSettings = getSettings();
    const mesh = makeCubeMesh(10, 'cube-hover');
    const faceDown = { x: 0, y: 0, z: -1 };
    const bisector45 = new THREE.Vector3(1, 0, -1).normalize();

    try {
        const defaults = createDefaultSettings();
        setSettings({
            ...defaults,
            smoothContactNormals: true,
            normalSynthesisPreset: 'bisector',
            devToolsEnabled: false,
            tip: { ...defaults.tip, contactDiameterMm: 0.3 }, // contactRadiusMm = 0.15 -> D_disk = 0.30, W_blend = 0.30, deadband = 0.1125
        });

        const edgeHit = raycastCube(mesh, new THREE.Vector3(4.95, 0, -10), new THREE.Vector3(0, 0, 1));
        const raw = calculateRawWorldNormal(edgeHit);
        assert.ok(angleDeg(raw, faceDown) < 1e-6, 'raw normal stays perpendicular to bottom face');

        const smoothed = calculateSmoothedNormal(edgeHit);
        assert.ok(
            angleDeg(smoothed, bisector45) < 1.0,
            `expected bisector-synthesized normal within 1° of 45°, got ${angleDeg(smoothed, bisector45).toFixed(3)}°`,
        );

        const forcedRaw = calculateSmoothedNormal(edgeHit, { forceRaw: true });
        assert.deepEqual(forcedRaw, raw, 'forceRaw: true must match calculateRawWorldNormal bit-for-bit');

        // Explicit contactRadiusMm widens W_blend past d = 0.35 mm at x = 4.65
        const midHit = raycastCube(mesh, new THREE.Vector3(4.65, 0, -10), new THREE.Vector3(0, 0, 1));
        const defaultRadiusNormal = calculateSmoothedNormal(midHit);
        assert.ok(angleDeg(defaultRadiusNormal, faceDown) < 1e-4, 'default R=0.45 / W_blend=0.30 stays flat at d=0.35 mm');
        const wideRadiusNormal = calculateSmoothedNormal(midHit, { contactRadiusMm: 0.5 });
        assert.ok(
            angleDeg(wideRadiusNormal, faceDown) > 5.0,
            `expected contactRadiusMm=0.5 to blend at d=0.35 mm, got ${angleDeg(wideRadiusNormal, faceDown).toFixed(3)}°`,
        );

        // Sprout raycast uses calculateSmoothedNormal too
        leafPlacementStore.setHotkeyActive(false);
        leafPlacementStore.setStage('awaitingSproutTip');
        const sproutRay = new THREE.Raycaster(new THREE.Vector3(4.95, 0, -10), new THREE.Vector3(0, 0, 1));
        const sproutSmooth = syncSproutTipFromRaycast(sproutRay, [mesh]);
        assert.ok(sproutSmooth.surfaceNormal);
        assert.ok(angleDeg(sproutSmooth.surfaceNormal, bisector45) < 1.0);

        // Toggle smoothContactNormals off -> bit-for-bit match to calculateRawWorldNormal
        setSettings({
            ...getSettings(),
            smoothContactNormals: false,
        });
        const disabledNormal = calculateSmoothedNormal(edgeHit);
        assert.deepEqual(disabledNormal, raw, 'smoothContactNormals: false must match calculateRawWorldNormal bit-for-bit');

        const sproutRaw = syncSproutTipFromRaycast(sproutRay, [mesh]);
        assert.deepEqual(sproutRaw.surfaceNormal, raw);
    } finally {
        leafPlacementStore.setHotkeyActive(false);
        leafPlacementStore.reset();
        setSettings(prevSettings);
    }
});

test('2. devTools synthesis fields affect calculateSmoothedNormal ONLY when devToolsEnabled === true', () => {
    const prevSettings = getSettings();
    const mesh = makeCubeMesh(10, 'cube-devtools');
    const faceDown = { x: 0, y: 0, z: -1 };
    const bisector45 = new THREE.Vector3(1, 0, -1).normalize();

    try {
        const defaults = createDefaultSettings();
        // contactDiameterMm = 0.5 -> contactRadiusMm = 0.25, D_disk = 0.5, W_blend = 0.375, deadband = 0.1875
        setSettings({
            ...defaults,
            smoothContactNormals: true,
            normalSynthesisPreset: 'bisector',
            tip: { ...defaults.tip, contactDiameterMm: 0.5 },
            devToolsEnabled: false,
            devTools: {
                ...defaults.devTools,
                normalSampleRadiusScale: 1.5, // W_blend 0.375 -> 0.5625 if enabled
                normalCreaseThresholdDeg: 60, // rejects 90° adjacent face if enabled
                normalDeadbandScale: 0, // removes deadband if enabled
                normalFlatThresholdDeg: 10,
            },
        });

        const nearEdgeHit = raycastCube(mesh, new THREE.Vector3(4.95, 0, -10), new THREE.Vector3(0, 0, 1));
        const outsideDefaultBlendHit = raycastCube(mesh, new THREE.Vector3(4.55, 0, -10), new THREE.Vector3(0, 0, 1)); // d = 0.45 mm
        const deadbandOuterHit = raycastCube(mesh, new THREE.Vector3(4.90, 0, -10), new THREE.Vector3(0, 0, 1)); // d = 0.10 mm
        const deadbandInnerHit = raycastCube(mesh, new THREE.Vector3(4.98, 0, -10), new THREE.Vector3(0, 0, 1)); // d = 0.02 mm

        // With devToolsEnabled: false, ALL devTools overrides are ignored
        assert.ok(
            angleDeg(calculateSmoothedNormal(nearEdgeHit), bisector45) < 1.0,
            'normalCreaseThresholdDeg=60 ignored when devToolsEnabled=false',
        );
        assert.ok(
            angleDeg(calculateSmoothedNormal(outsideDefaultBlendHit), faceDown) < 1e-4,
            'normalSampleRadiusScale=1.5 ignored when devToolsEnabled=false',
        );
        assert.ok(
            angleDeg(calculateSmoothedNormal(deadbandOuterHit), calculateSmoothedNormal(deadbandInnerHit)) < 1e-4,
            'normalDeadbandScale=0 ignored when devToolsEnabled=false',
        );

        // Enable devTools: normalCreaseThresholdDeg=60 rejects 90° wall
        setSettings({
            ...getSettings(),
            devToolsEnabled: true,
        });
        assert.ok(
            angleDeg(calculateSmoothedNormal(nearEdgeHit), faceDown) < 1e-4,
            'normalCreaseThresholdDeg=60 rejects 90° wall when devToolsEnabled=true',
        );

        // normalSampleRadiusScale=1.5 widens blend to cover d=0.45 mm (< 0.5625 mm)
        setSettings({
            ...getSettings(),
            devToolsEnabled: true,
            devTools: {
                ...getSettings().devTools,
                normalCreaseThresholdDeg: 0,
                normalSampleRadiusScale: 1.5,
            },
        });
        assert.ok(
            angleDeg(calculateSmoothedNormal(outsideDefaultBlendHit), faceDown) > 3.0,
            'normalSampleRadiusScale=1.5 widens blend when devToolsEnabled=true',
        );

        // normalDeadbandScale=0 differentiates d=0.10 vs d=0.02 near crease
        setSettings({
            ...getSettings(),
            devToolsEnabled: true,
            devTools: {
                ...getSettings().devTools,
                normalCreaseThresholdDeg: 0,
                normalSampleRadiusScale: 1.0,
                normalDeadbandScale: 0,
            },
        });
        const outerWithDev = calculateSmoothedNormal(deadbandOuterHit);
        const innerWithDev = calculateSmoothedNormal(deadbandInnerHit);
        assert.ok(
            angleDeg(outerWithDev, innerWithDev) > 2.0,
            `expected normalDeadbandScale=0 to differentiate d=0.10 vs d=0.02, got ${angleDeg(outerWithDev, innerWithDev).toFixed(3)}°`,
        );
    } finally {
        setSettings(prevSettings);
    }
});

test('3. contactDiskDragController applies S-A3 (zero deadband + <=15° SLERP clamp), respects contactRadiusMm, and BranchRenderer/TwigRenderer/useContactDiskDragSession wire it', () => {
    const prevSettings = getSettings();
    const mesh = makeCubeMesh(10, 'cube-drag');

    try {
        const defaults = createDefaultSettings();
        setSettings({
            ...defaults,
            smoothContactNormals: true,
            normalSynthesisPreset: 'bisector',
            devToolsEnabled: false,
            tip: { ...defaults.tip, contactDiameterMm: 0.3 },
        });

        withMockWindowAndRaf(({ dispatchPointerMove, flushRaf }) => {
            const scene = new THREE.Scene();
            scene.add(mesh);
            const domElement = createViewportElement();

            // (a) Zero deadband near crease during drag (contactRadiusMm = 0.25 -> static deadband = 0.1875)
            const bottomCam = new THREE.OrthographicCamera(-10, 10, 10, -10, 0.1, 50);
            bottomCam.position.set(0, 0, -20);
            bottomCam.up.set(0, 1, 0);
            bottomCam.lookAt(0, 0, 0);
            bottomCam.updateMatrixWorld(true);
            bottomCam.updateProjectionMatrix();

            const deadbandHits: ContactDiskDragHit[] = [];
            const deadbandSession = startContactDiskDragSession({
                camera: bottomCam,
                domElement,
                scene,
                modelId: 'cube-drag',
                contactRadiusMm: 0.25,
                // NDC x = -0.49 -> world x = +4.90 (d = 0.10 mm from edge x = 5)
                initialEvent: { clientX: 51.0, clientY: 100 },
                onHit: (hit) => deadbandHits.push(hit),
            });
            // Move to world x = +4.98 (d = 0.02 mm from edge x = 5)
            dispatchPointerMove(50.2, 100);
            flushRaf();
            deadbandSession.stop();

            assert.equal(deadbandHits.length, 2);
            assert.ok(deadbandHits[0].point.x > 4.85 && deadbandHits[1].point.x > 4.95);
            const dragDeadbandDelta = angleDeg(deadbandHits[0].surfaceNormal, deadbandHits[1].surfaceNormal);
            assert.ok(
                dragDeadbandDelta > 2.0,
                `S-A3 zero deadband must differentiate d=0.10 vs d=0.02 during drag, got ${dragDeadbandDelta.toFixed(3)}°`,
            );

            // (b) <= 15° SLERP step clamp across rapid 90° corner jump + clean prevNormal reset on stop
            const cornerCam = new THREE.OrthographicCamera(-10, 10, 10, -10, 0.1, 50);
            cornerCam.position.set(15, 0, -15);
            cornerCam.up.set(0, 1, 0);
            cornerCam.lookAt(5, 0, -5);
            cornerCam.updateMatrixWorld(true);
            cornerCam.updateProjectionMatrix();

            const slerpHits: ContactDiskDragHit[] = [];
            const slerpSession = startContactDiskDragSession({
                camera: cornerCam,
                domElement,
                scene,
                modelId: 'cube-drag',
                contactRadiusMm: 0.25,
                initialEvent: { clientX: 150, clientY: 100 }, // bottom face (z = -5), normal (0, 0, -1)
                onHit: (hit) => slerpHits.push(hit),
            });
            dispatchPointerMove(50, 100); // rapid 90° jump to right face (x = 5), normal (1, 0, 0)
            flushRaf();
            dispatchPointerMove(50, 100); // second step continues converging <= 15° per frame
            flushRaf();
            slerpSession.stop();

            assert.equal(slerpHits.length, 3);
            assert.ok(angleDeg(slerpHits[0].surfaceNormal, { x: 0, y: 0, z: -1 }) < 1e-4);
            const step1Deg = angleDeg(slerpHits[0].surfaceNormal, slerpHits[1].surfaceNormal);
            const step2Deg = angleDeg(slerpHits[1].surfaceNormal, slerpHits[2].surfaceNormal);
            assert.ok(step1Deg <= 15.001 && step1Deg >= 14.9, `expected 15° SLERP step 1, got ${step1Deg.toFixed(4)}°`);
            assert.ok(step2Deg <= 15.001 && step2Deg >= 14.9, `expected 15° SLERP step 2, got ${step2Deg.toFixed(4)}°`);

            // New session after stop() starts with fresh prevNormal (no stale carry-over from bottom face)
            const freshHits: ContactDiskDragHit[] = [];
            const freshSession = startContactDiskDragSession({
                camera: cornerCam,
                domElement,
                scene,
                modelId: 'cube-drag',
                contactRadiusMm: 0.25,
                initialEvent: { clientX: 50, clientY: 100 },
                onHit: (hit) => freshHits.push(hit),
            });
            freshSession.stop();
            assert.equal(freshHits.length, 1);
            assert.ok(
                angleDeg(freshHits[0].surfaceNormal, { x: 1, y: 0, z: 0 }) < 1e-4,
                'fresh drag session must reset prevSynthesizedNormal cleanly',
            );

            // (c) Passed contactRadiusMm overrides global settings.tip.contactDiameterMm (0.3 -> R=0.45, W_blend=0.30)
            // At world x = 4.60 (d = 0.40 mm from edge x = 5): radius=0.15 stays flat, radius=0.6 blends!
            const narrowHits: ContactDiskDragHit[] = [];
            const narrowSession = startContactDiskDragSession({
                camera: bottomCam,
                domElement,
                scene,
                modelId: 'cube-drag',
                contactRadiusMm: 0.15,
                initialEvent: { clientX: 54.0, clientY: 100 },
                onHit: (hit) => narrowHits.push(hit),
            });
            narrowSession.stop();
            assert.ok(angleDeg(narrowHits[0].surfaceNormal, { x: 0, y: 0, z: -1 }) < 1e-4);

            const wideHits: ContactDiskDragHit[] = [];
            const wideSession = startContactDiskDragSession({
                camera: bottomCam,
                domElement,
                scene,
                modelId: 'cube-drag',
                contactRadiusMm: 0.6,
                initialEvent: { clientX: 54.0, clientY: 100 },
                onHit: (hit) => wideHits.push(hit),
            });
            wideSession.stop();
            assert.ok(
                angleDeg(wideHits[0].surfaceNormal, { x: 0, y: 0, z: -1 }) > 5.0,
                'passed contactRadiusMm=0.6 must widen synthesis radius during drag',
            );

            // (d) useContactDiskDragSession forwards explicit contactRadiusMm AND contact.cone.profile.contactDiameterMm * 0.5
            let hookApi: ContactDiskDragSessionApi<ContactCone> | null = null;
            const forwardedHits: ContactDiskDragHit[] = [];
            function Probe() {
                hookApi = useContactDiskDragSession<ContactCone>('branch', {
                    onHit: (hit) => {
                        forwardedHits.push(hit);
                        return null;
                    },
                    onCommit: () => {},
                });
                return null;
            }
            renderToStaticMarkup(React.createElement(Probe));
            assert.ok(hookApi, 'hook API captured');

            (hookApi as ContactDiskDragSessionApi<ContactCone>).start({
                event: { clientX: 54.0, clientY: 100 },
                camera: bottomCam,
                domElement,
                scene,
                modelId: 'cube-drag',
                contactRadiusMm: 0.6,
            });
            (hookApi as ContactDiskDragSessionApi<ContactCone>).stop();
            assert.equal(forwardedHits.length, 1);
            assert.ok(
                angleDeg(forwardedHits[0].surfaceNormal, { x: 0, y: 0, z: -1 }) > 5.0,
                'useContactDiskDragSession forwards explicit contactRadiusMm',
            );

            const contactDerivedCone: ContactCone = {
                id: 'cone-probe',
                pos: { x: 0, y: 0, z: -5 },
                normal: { x: 0, y: 0, z: -1 },
                surfaceNormal: { x: 0, y: 0, z: -1 },
                profile: {
                    type: 'disk',
                    contactDiameterMm: 1.2, // contactRadiusMm = 0.6
                    bodyDiameterMm: 1.4,
                    lengthMm: 2.5,
                    penetrationMm: 0.05,
                    diskThicknessMm: 0.1,
                    maxStandoffMm: 1.5,
                    standoffAngleThreshold: Math.PI / 4,
                },
            };
            (hookApi as ContactDiskDragSessionApi<ContactCone>).start({
                event: { clientX: 54.0, clientY: 100 },
                camera: bottomCam,
                domElement,
                scene,
                modelId: 'cube-drag',
                contact: { field: 'contactCone', cone: contactDerivedCone },
            });
            (hookApi as ContactDiskDragSessionApi<ContactCone>).stop();
            assert.equal(forwardedHits.length, 2);
            assert.ok(
                angleDeg(forwardedHits[1].surfaceNormal, { x: 0, y: 0, z: -1 }) > 5.0,
                'useContactDiskDragSession falls back to contact.cone.profile.contactDiameterMm * 0.5',
            );
        });

        // (e) BranchRenderer & TwigRenderer pass contactRadiusMm into useContactDiskDragSession.start(...)
        const branchSrc = readFileSync(new URL('../SupportTypes/Branch/BranchRenderer.tsx', import.meta.url), 'utf8');
        const twigSrc = readFileSync(new URL('../SupportTypes/Twig/TwigRenderer.tsx', import.meta.url), 'utf8');
        assert.match(
            branchSrc,
            /tipDrag\.start\(\{[\s\S]*?contactRadiusMm\s*:/,
            'BranchRenderer must pass contactRadiusMm to tipDrag.start',
        );
        assert.match(
            twigSrc,
            /startTipDrag\(\{[\s\S]*?contactRadiusMm\s*:/,
            'TwigRenderer must pass contactRadiusMm to startTipDrag',
        );
    } finally {
        setSettings(prevSettings);
    }
});

test('4. autoPlace resolveSurfaceNormal synthesizes bisector in 3D when enabled, honors raw overrides, and avoids PlacementUtils.calculateSmoothedNormal', () => {
    const prevSettings = getSettings();
    resetStore();
    resetKickstandsInState();
    clearHistory();

    try {
        // 10x10x10 box translated so bottom face sits at z = 20 (normal (0,0,-1)) and right wall at x = 5 (normal (1,0,0))
        const geom = new THREE.BoxGeometry(10, 10, 10).toNonIndexed();
        geom.translate(0, 0, 25);
        geom.computeVertexNormals();
        (geom as BvhGeometry).boundsTree = new MeshBVH(geom);
        const mesh = new THREE.Mesh(geom);
        mesh.updateMatrixWorld(true);

        const islands: DetectedIsland[] = [
            {
                id: 'edge-island',
                source: 'voxel',
                contact: new THREE.Vector3(4.95, 0, 20),
                baseZ: 20,
                areaMm2: 0.5,
                contactVoxels: footprintFromPoints([{ x: 4.95, y: 0 }]),
            },
        ];

        const defaults = createDefaultSettings();
        setSettings({
            ...defaults,
            autoSupport: {
                ...defaults.autoSupport,
                smoothContactNormals: true,
                normalSynthesisPreset: 'bisector',
            },
        });
        const planSmoothOn = computeAutoSupportPlan(
            islands,
            'auto-3d-synth',
            { debugSkipAutoBracing: true },
            undefined,
            mesh,
        );

        const planCliRaw = computeAutoSupportPlan(
            islands,
            'auto-3d-synth',
            { debugSkipAutoBracing: true, normalSynthesisMode: 'raw' },
            undefined,
            mesh,
        );

        setSettings({
            ...defaults,
            autoSupport: {
                ...defaults.autoSupport,
                smoothContactNormals: false,
                normalSynthesisPreset: 'bisector',
            },
        });
        const planSmoothOff = computeAutoSupportPlan(
            islands,
            'auto-3d-synth',
            { debugSkipAutoBracing: true },
            undefined,
            mesh,
        );

        assert.ok(planSmoothOn && planCliRaw && planSmoothOff);
        const trunksOn = Object.values(planSmoothOn.support.trunks);
        const trunksCliRaw = Object.values(planCliRaw.support.trunks);
        const trunksOff = Object.values(planSmoothOff.support.trunks);
        assert.equal(trunksOn.length, 1);
        assert.equal(trunksCliRaw.length, 1);
        assert.equal(trunksOff.length, 1);

        const expectedBisector = new THREE.Vector3(1, 0, -1).normalize();
        const bisectorNormal = trunksOn[0].contactCone?.surfaceNormal;
        assert.ok(bisectorNormal, 'bisector trunk must carry surfaceNormal');
        assert.ok(
            angleDeg(bisectorNormal, expectedBisector) < 1e-6,
            `autoPlace must synthesize 45° edge bisector when smoothContactNormals=true, got (${bisectorNormal.x}, ${bisectorNormal.y}, ${bisectorNormal.z})`,
        );

        assert.deepEqual(
            trunksOff[0].contactCone?.surfaceNormal,
            { x: 0, y: 0, z: -1 },
            'autoPlace must return exact raw underside normal (0,0,-1) when autoSupport.smoothContactNormals=false',
        );
        assert.deepEqual(
            trunksCliRaw[0].contactCone?.surfaceNormal,
            { x: 0, y: 0, z: -1 },
            'autoPlace must return exact raw underside normal (0,0,-1) when settingsOverride.normalSynthesisMode=raw',
        );

        const autoPlaceSrc = readFileSync(new URL('../autoSupport/autoPlace.ts', import.meta.url), 'utf8');
        assert.equal(
            /\bcalculateSmoothedNormal\b/.test(autoPlaceSrc),
            false,
            'autoPlace.ts must not call PlacementUtils.calculateSmoothedNormal',
        );
        assert.match(
            autoPlaceSrc,
            /\bcalculateRawWorldNormal\b/,
            'autoPlace.ts resolveSurfaceNormal must use calculateRawWorldNormal',
        );
        assert.match(
            autoPlaceSrc,
            /\bsynthesizePlacementNormal\b/,
            'autoPlace.ts must use synthesizePlacementNormal directly',
        );
    } finally {
        resetStore();
        resetKickstandsInState();
        clearHistory();
        setSettings(prevSettings);
    }
});
