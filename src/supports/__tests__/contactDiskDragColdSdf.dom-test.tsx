import assert from 'node:assert/strict';
import test, { afterEach, beforeEach } from 'node:test';
import React, { act, useEffect, useRef, useState } from 'react';
import * as THREE from 'three';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';

import { clearHistory } from '@/history/historyStore';
import { renderWithProviders, settle } from '@/utils/__tests__/helpers/renderDom';
import { accelerateGeometry, initializeBVH } from '../../utils/bvh';
import { clearAllSDFCaches, getOrCreateSDFCache, hasWarmSDFCache } from '../PlacementLogic/Pathfinding/SDFCachePool';
import { createDefaultSettings } from '../Settings/types';
import { setSettings } from '../Settings/state';
import type { ContactCone, ContactDiskProfile } from '../SupportPrimitives/ContactCone/types';
import type { ContactDiskDragHit } from '../SupportPrimitives/ContactDisk/contactDiskDragController';
import { recomputeContactConeForMovedDisk } from '../SupportPrimitives/ContactDisk/ContactDiskInteraction';
import { calculateDiskThickness } from '../SupportPrimitives/ContactDisk/contactDiskUtils';
import { useContactDiskDragSession, type ContactDiskDragContact } from '../SupportTypes/useContactDiskDragSession';
import { cancelPendingSupportEditHistory } from '../history/supportEditHistory';
import { clearConeDragSession, getConeDragSession } from '../instanced/coneDragWriter';
import { resetStore } from '../state';
import type { SupportTypeId } from '../supportTypeRegistry';
import type { Vec3 } from '../types';

const MODEL_ID = 'cold-sdf-model';

const TEST_DISK_PROFILE: ContactDiskProfile = {
    type: 'disk',
    contactDiameterMm: 0.4,
    diskThicknessMm: 0.1,
    maxStandoffMm: 1.6,
    standoffAngleThreshold: Math.PI / 4,
};

function makeCone(): ContactCone {
    return {
        id: 'cone-drag-1',
        pos: { x: 0, y: 0, z: 0 },
        normal: { x: 0, y: 0, z: 1 },
        surfaceNormal: { x: 0, y: 0, z: 1 },
        profile: {
            ...TEST_DISK_PROFILE,
            contactDiameterMm: 0.4,
            bodyDiameterMm: 1.2,
            lengthMm: 3,
            penetrationMm: 0.05,
        },
    };
}

/**
 * Horizontal plate at z <= 0 with a thin vertical blocking rib off to +x so
 * downward pick rays around x <= 0 hit the plate cleanly while the angled cone
 * path toward socket (1.5, 0, 3) passes beside the rib and requires standoff backoff.
 */
function makeSurfaceWithRibMesh(): THREE.Mesh {
    initializeBVH();
    const plate = new THREE.BoxGeometry(20, 20, 1).translate(0, 0, -0.5);
    const rib = new THREE.BoxGeometry(0.16, 4, 0.2).translate(0.55, 0, 0.22);
    const geometry = mergeGeometries([plate, rib]);
    assert.ok(geometry, 'merged plate + rib geometry');
    accelerateGeometry(geometry);
    const mesh = new THREE.Mesh(geometry, new THREE.MeshBasicMaterial());
    mesh.userData = { modelId: MODEL_ID };
    mesh.updateMatrixWorld(true);
    return mesh;
}

function makeOrthoCamera(): THREE.OrthographicCamera {
    const camera = new THREE.OrthographicCamera(-10, 10, 10, -10, 0.1, 50);
    camera.position.set(0, 0, 20);
    camera.up.set(0, 1, 0);
    camera.lookAt(0, 0, 0);
    camera.updateMatrixWorld(true);
    camera.updateProjectionMatrix();
    return camera;
}

function pointerEvent(type: string, clientX: number, clientY: number): MouseEvent {
    return new MouseEvent(type, { bubbles: true, button: 0, clientX, clientY });
}

function stubViewportRect(el: HTMLElement): void {
    el.getBoundingClientRect = () => ({
        left: 0,
        top: 0,
        width: 200,
        height: 200,
        right: 200,
        bottom: 200,
        x: 0,
        y: 0,
        toJSON: () => ({}),
    }) as DOMRect;
}

interface HarnessProps {
    typeId?: SupportTypeId;
    scene: THREE.Scene;
    camera: THREE.Camera;
    initialCone: ContactCone;
    socketAnchor: Vec3;
    contact?: ContactDiskDragContact;
    transformHit?: (hit: ContactDiskDragHit) => ContactDiskDragHit;
    shouldRejectHit?: (hit: ContactDiskDragHit) => boolean;
    onHitObserved: (hit: ContactDiskDragHit, computed: ContactCone | null) => void;
    onPreviewObserved: (preview: ContactCone | null) => void;
    onCommitObserved: (cone: ContactCone) => void;
    onApiReady?: (api: { stop: () => void; startAt: (clientX: number, clientY: number) => void }) => void;
}

function DragHarness({
    typeId = 'branch',
    scene,
    camera,
    initialCone,
    socketAnchor,
    contact,
    transformHit,
    shouldRejectHit,
    onHitObserved,
    onPreviewObserved,
    onCommitObserved,
    onApiReady,
}: HarnessProps) {
    const domRef = useRef<HTMLDivElement | null>(null);
    const previewRef = useRef<ContactCone | null>(null);
    const [previewState, setPreviewState] = useState<ContactCone | null>(null);

    const tipDrag = useContactDiskDragSession<ContactCone>(typeId, {
        onHit: (rawHit) => {
            const hit = transformHit ? transformHit(rawHit) : rawHit;
            if (shouldRejectHit?.(hit)) {
                onHitObserved(hit, null);
                return null;
            }
            const recomputed = recomputeContactConeForMovedDisk(
                initialCone,
                hit.point,
                hit.surfaceNormal,
                socketAnchor,
                hit.mesh,
            );
            previewRef.current = recomputed;
            setPreviewState(recomputed);
            onHitObserved(hit, recomputed);
            return recomputed;
        },
        onCommit: (committed) => {
            onCommitObserved(committed);
        },
        ...(contact ? { coneFromPreview: (cone: ContactCone) => cone } : {}),
    });

    const { start, stop, preview } = tipDrag;

    useEffect(() => {
        if (domRef.current) stubViewportRect(domRef.current);
    }, []);

    useEffect(() => {
        onPreviewObserved(preview ?? previewState);
    }, [onPreviewObserved, preview, previewState]);

    useEffect(() => {
        const handleWindowPointerUp = () => {
            stop();
        };
        window.addEventListener('pointerup', handleWindowPointerUp, true);
        return () => {
            window.removeEventListener('pointerup', handleWindowPointerUp, true);
        };
    }, [stop]);

    useEffect(() => {
        onApiReady?.({
            stop,
            startAt: (clientX: number, clientY: number) => {
                if (!domRef.current) return;
                start({
                    event: pointerEvent('pointerdown', clientX, clientY),
                    camera,
                    domElement: domRef.current,
                    scene,
                    modelId: MODEL_ID,
                    contact,
                });
            },
        });
    }, [camera, contact, onApiReady, scene, start, stop]);

    const handlePointerDown = (e: React.PointerEvent<HTMLDivElement>) => {
        if (!domRef.current) return;
        start({
            event: e,
            camera,
            domElement: domRef.current,
            scene,
            modelId: MODEL_ID,
            contact,
        });
    };

    const effectivePreview = preview ?? previewState;

    return (
        <div
            ref={domRef}
            data-testid="drag-viewport"
            data-preview-override={effectivePreview?.diskLengthOverride ?? 'none'}
            onPointerDown={handlePointerDown}
        />
    );
}

beforeEach(() => {
    clearAllSDFCaches();
    clearConeDragSession();
    cancelPendingSupportEditHistory();
    clearHistory();
    resetStore();
    setSettings(createDefaultSettings());
});

afterEach(() => {
    clearAllSDFCaches();
    clearConeDragSession();
    cancelPendingSupportEditHistory();
    clearHistory();
    resetStore();
});

test('cold mesh skips SDFCache construction during live drag and resolves collision on pointerup commit', async () => {
    const mesh = makeSurfaceWithRibMesh();
    const scene = new THREE.Scene();
    scene.add(mesh);
    const camera = makeOrthoCamera();
    const initialCone = makeCone();
    const socketAnchor = { x: 1.5, y: 0, z: 3 };

    assert.equal(hasWarmSDFCache(mesh), false, 'precondition: mesh starts with cold SDF cache');

    const observedHits: ContactDiskDragHit[] = [];
    const committed: ContactCone[] = [];
    const latestPreview: { current: ContactCone | null } = { current: null };

    const tree = await renderWithProviders(
        <DragHarness
            scene={scene}
            camera={camera}
            initialCone={initialCone}
            socketAnchor={socketAnchor}
            onHitObserved={(hit) => observedHits.push(hit)}
            onPreviewObserved={(preview) => {
                latestPreview.current = preview;
            }}
            onCommitObserved={(cone) => committed.push(cone)}
        />,
    );

    try {
        const viewport = tree.container.querySelector('[data-testid="drag-viewport"]') as HTMLElement;
        assert.ok(viewport);

        // pointerdown at NDC (0, 0) -> world (0, 0, 0)
        await act(async () => {
            viewport.dispatchEvent(pointerEvent('pointerdown', 100, 100));
        });

        assert.equal(observedHits.length >= 1, true, 'initial pointerdown triggers onHit');
        assert.equal(observedHits[observedHits.length - 1].mesh, undefined, 'cold hit.mesh is masked during pointerdown');
        assert.equal(hasWarmSDFCache(mesh), false, 'SDF cache stays cold during pointerdown');
        assert.equal(committed.length, 0, 'onCommit does not fire on pointerdown');
        assert.ok(latestPreview.current, 'live preview exists after pointerdown');
        assert.equal(latestPreview.current.diskLengthOverride, undefined, 'live cold preview omits collision override');

        // pointermove -> rAF -> world (-0.2, 0, 0)
        const hitsBeforeMove = observedHits.length;
        await act(async () => {
            window.dispatchEvent(pointerEvent('pointermove', 98, 100));
        });
        await settle(40);

        assert.equal(observedHits.length, hitsBeforeMove + 1, 'rAF pointermove triggers onHit');
        const moveHit = observedHits[observedHits.length - 1];
        assert.equal(moveHit.mesh, undefined, 'cold hit.mesh stays masked during rAF pointermove');
        assert.equal(hasWarmSDFCache(mesh), false, 'SDF cache stays cold throughout live drag');
        assert.equal(committed.length, 0, 'onCommit has not fired before pointerup');
        assert.ok(latestPreview.current);
        assert.equal(latestPreview.current.diskLengthOverride, undefined, 'live cold move preview has no collision override');

        const expectedAngleThickness = calculateDiskThickness(
            moveHit.surfaceNormal,
            latestPreview.current.normal,
            TEST_DISK_PROFILE,
        );

        // pointerup -> onEnd resolves full collision backoff and commits
        await act(async () => {
            window.dispatchEvent(pointerEvent('pointerup', 98, 100));
        });

        assert.equal(hasWarmSDFCache(mesh), true, 'SDF cache warms on pointerup commit');
        assert.equal(committed.length, 1, 'onCommit fires once on pointerup');
        assert.equal(observedHits[observedHits.length - 1].mesh, mesh, 'onEnd invokes onHit with unmasked mesh');
        assert.ok(
            committed[0].diskLengthOverride !== undefined && committed[0].diskLengthOverride > expectedAngleThickness,
            `committed cone must carry collision backoff > angleThickness (${expectedAngleThickness}), got ${committed[0].diskLengthOverride}`,
        );
    } finally {
        await tree.unmount();
    }
});

test('cold mesh defers SDF build on instanced fast-path (contact + coneFromPreview) until commit', async () => {
    const mesh = makeSurfaceWithRibMesh();
    const scene = new THREE.Scene();
    scene.add(mesh);
    const camera = makeOrthoCamera();
    const initialCone = makeCone();
    const socketAnchor = { x: 1.5, y: 0, z: 3 };

    const observedHits: ContactDiskDragHit[] = [];
    const committed: ContactCone[] = [];

    const tree = await renderWithProviders(
        <DragHarness
            typeId="leaf"
            scene={scene}
            camera={camera}
            initialCone={initialCone}
            socketAnchor={socketAnchor}
            contact={{ field: 'contactCone', cone: initialCone, supportId: 'leaf-1' }}
            onHitObserved={(hit) => observedHits.push(hit)}
            onPreviewObserved={() => {}}
            onCommitObserved={(cone) => committed.push(cone)}
        />,
    );

    try {
        const viewport = tree.container.querySelector('[data-testid="drag-viewport"]') as HTMLElement;
        await act(async () => {
            viewport.dispatchEvent(pointerEvent('pointerdown', 100, 100));
        });
        await act(async () => {
            window.dispatchEvent(pointerEvent('pointermove', 98, 100));
        });
        await settle(40);

        assert.equal(hasWarmSDFCache(mesh), false, 'fast-path live drag leaves SDF cache cold');
        assert.equal(committed.length, 0);
        const fastPreview = getConeDragSession()?.lastPreview;
        assert.ok(fastPreview, 'fast-path session tracks live preview cone');
        assert.equal(fastPreview.diskLengthOverride, undefined);

        const moveHit = observedHits[observedHits.length - 1];
        const expectedAngleThickness = calculateDiskThickness(
            moveHit.surfaceNormal,
            fastPreview.normal,
            TEST_DISK_PROFILE,
        );

        await act(async () => {
            window.dispatchEvent(pointerEvent('pointerup', 98, 100));
        });

        assert.equal(hasWarmSDFCache(mesh), true, 'fast-path commit warms SDF cache on pointerup');
        assert.equal(committed.length, 1);
        assert.ok(
            committed[0].diskLengthOverride !== undefined && committed[0].diskLengthOverride > expectedAngleThickness,
            `fast-path commit must resolve collision backoff > ${expectedAngleThickness}, got ${committed[0].diskLengthOverride}`,
        );
    } finally {
        await tree.unmount();
    }
});

test('warm mesh passes hit.mesh unmasked and surfaces collision diskLengthOverride during live drag', async () => {
    const mesh = makeSurfaceWithRibMesh();
    getOrCreateSDFCache(mesh);
    assert.equal(hasWarmSDFCache(mesh), true, 'precondition: mesh SDF cache is pre-warmed');

    const scene = new THREE.Scene();
    scene.add(mesh);
    const camera = makeOrthoCamera();
    const initialCone = makeCone();
    const socketAnchor = { x: 1.5, y: 0, z: 3 };

    const observedHits: ContactDiskDragHit[] = [];
    const committed: ContactCone[] = [];
    const latestPreview: { current: ContactCone | null } = { current: null };

    const tree = await renderWithProviders(
        <DragHarness
            scene={scene}
            camera={camera}
            initialCone={initialCone}
            socketAnchor={socketAnchor}
            onHitObserved={(hit) => observedHits.push(hit)}
            onPreviewObserved={(preview) => {
                latestPreview.current = preview;
            }}
            onCommitObserved={(cone) => committed.push(cone)}
        />,
    );

    try {
        const viewport = tree.container.querySelector('[data-testid="drag-viewport"]') as HTMLElement;
        await act(async () => {
            viewport.dispatchEvent(pointerEvent('pointerdown', 100, 100));
        });

        assert.equal(observedHits[observedHits.length - 1].mesh, mesh, 'warm hit.mesh is NOT masked on pointerdown');
        assert.ok(latestPreview.current, 'live preview exists immediately on warm pointerdown');
        const downHit = observedHits[observedHits.length - 1];
        const downAngleThickness = calculateDiskThickness(
            downHit.surfaceNormal,
            latestPreview.current.normal,
            TEST_DISK_PROFILE,
        );
        assert.ok(
            latestPreview.current.diskLengthOverride !== undefined && latestPreview.current.diskLengthOverride > downAngleThickness,
            `warm pointerdown preview immediately carries collision override > ${downAngleThickness}, got ${latestPreview.current.diskLengthOverride}`,
        );

        await act(async () => {
            window.dispatchEvent(pointerEvent('pointermove', 98, 100));
        });
        await settle(40);

        const moveHit = observedHits[observedHits.length - 1];
        assert.equal(moveHit.mesh, mesh, 'warm hit.mesh is NOT masked on rAF pointermove');
        assert.ok(latestPreview.current);
        const moveAngleThickness = calculateDiskThickness(
            moveHit.surfaceNormal,
            latestPreview.current.normal,
            TEST_DISK_PROFILE,
        );
        assert.ok(
            latestPreview.current.diskLengthOverride !== undefined && latestPreview.current.diskLengthOverride > moveAngleThickness,
            `warm rAF preview immediately carries collision override > ${moveAngleThickness}, got ${latestPreview.current.diskLengthOverride}`,
        );
        assert.equal(committed.length, 0, 'commit waits for pointerup');

        const hitsBeforeUp = observedHits.length;
        await act(async () => {
            window.dispatchEvent(pointerEvent('pointerup', 98, 100));
        });

        assert.equal(observedHits.length, hitsBeforeUp, 'warm mesh does not need extra recompute pass in onEnd');
        assert.equal(committed.length, 1);
        assert.ok(
            committed[0].diskLengthOverride !== undefined && committed[0].diskLengthOverride > moveAngleThickness,
        );
    } finally {
        await tree.unmount();
    }
});

test('abort and unmount reset tracking refs without warming cold SDF or leaking prior hit state', async () => {
    const mesh = makeSurfaceWithRibMesh();
    const scene = new THREE.Scene();
    scene.add(mesh);
    const camera = makeOrthoCamera();
    const initialCone = makeCone();
    const socketAnchor = { x: 1.5, y: 0, z: 3 };

    const observedHits: ContactDiskDragHit[] = [];
    const committed: ContactCone[] = [];
    let rejectNext = true;
    let stripMesh = false;
    let api: { stop: () => void; startAt: (x: number, y: number) => void } | null = null;

    const tree = await renderWithProviders(
        <DragHarness
            scene={scene}
            camera={camera}
            initialCone={initialCone}
            socketAnchor={socketAnchor}
            transformHit={(hit) => (stripMesh ? { ...hit, mesh: undefined } : hit)}
            shouldRejectHit={() => rejectNext}
            onHitObserved={(hit) => observedHits.push(hit)}
            onPreviewObserved={() => {}}
            onCommitObserved={(cone) => committed.push(cone)}
            onApiReady={(nextApi) => {
                api = nextApi;
            }}
        />,
    );

    const viewport = tree.container.querySelector('[data-testid="drag-viewport"]') as HTMLElement;

    // 1. Cancelled hit (onHit returns null) + rAF move + stop() must not warm SDF or commit.
    await act(async () => {
        viewport.dispatchEvent(pointerEvent('pointerdown', 100, 100));
    });
    await act(async () => {
        window.dispatchEvent(pointerEvent('pointermove', 98, 100));
    });
    await settle(40);
    assert.equal(observedHits.length >= 2, true);
    await act(async () => {
        api!.stop();
    });
    assert.equal(hasWarmSDFCache(mesh), false, 'cancelled drag leaves SDF cold');
    assert.equal(committed.length, 0, 'cancelled drag does not commit');

    // 2. Subsequent drag without mesh (mesh: undefined) must not inherit prior
    //    cancelled session's hit or skipped-cold-mesh flag.
    rejectNext = false;
    stripMesh = true;
    await act(async () => {
        viewport.dispatchEvent(pointerEvent('pointerdown', 100, 100));
    });
    await act(async () => {
        window.dispatchEvent(pointerEvent('pointerup', 100, 100));
    });
    assert.equal(hasWarmSDFCache(mesh), false, 'meshless drag does not warm prior cold mesh');
    assert.equal(committed.length, 1);
    assert.equal(committed[0].diskLengthOverride, undefined);

    // 3. Completed cold drag resets tracking refs onEnd so a subsequent
    //    meshless drag after clearing caches does not replay the prior hit.
    stripMesh = false;
    await act(async () => {
        viewport.dispatchEvent(pointerEvent('pointerdown', 100, 100));
    });
    await act(async () => {
        window.dispatchEvent(pointerEvent('pointerup', 100, 100));
    });
    assert.equal(hasWarmSDFCache(mesh), true);
    assert.equal(committed.length, 2);

    clearAllSDFCaches();
    stripMesh = true;
    await act(async () => {
        viewport.dispatchEvent(pointerEvent('pointerdown', 100, 100));
    });
    await act(async () => {
        window.dispatchEvent(pointerEvent('pointerup', 100, 100));
    });
    assert.equal(hasWarmSDFCache(mesh), false, 'refs reset onEnd prevent replaying prior cold mesh hit');
    assert.equal(committed.length, 3);

    // 4. Unmount while a pending rAF is queued on a rejected session cancels
    //    the frame cleanly and resets tracking refs.
    clearAllSDFCaches();
    rejectNext = true;
    stripMesh = false;
    await act(async () => {
        api!.startAt(100, 100);
    });
    const hitsBeforeMove = observedHits.length;
    window.dispatchEvent(pointerEvent('pointermove', 98, 100));
    await tree.unmount();
    await settle(40);

    assert.equal(observedHits.length, hitsBeforeMove, 'unmount cancels pending pointermove rAF');
    assert.equal(hasWarmSDFCache(mesh), false, 'unmount after rejected session keeps SDF cold');
    assert.equal(committed.length, 3, 'unmount after rejected session does not commit');
});
