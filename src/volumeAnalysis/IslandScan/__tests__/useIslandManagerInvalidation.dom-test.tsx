import assert from 'node:assert/strict';
import test from 'node:test';
import { act, StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import * as THREE from 'three';
import { I18nClientProvider } from '@/components/I18nClientProvider';
import { IslandVoxelVisualization } from '@/components/scene/IslandVoxelVisualization';
import { HotkeyProvider } from '@/hotkeys/HotkeyContext';
import type { GeometryWithBounds } from '@/hooks/useStlGeometry';
import { settle } from '@/utils/__tests__/helpers/renderDom';
import { disposeEventLoopChannel } from '@/utils/yieldToEventLoop';
import type { ScanResults } from '@/volumeAnalysis/IslandScan/ScanOrchestrator';
import { useIslandManager } from '@/volumeAnalysis/IslandScan/useIslandManager';

function createIndexedOutwardTetrahedron(): GeometryWithBounds {
  const vertices = new Float32Array([
    0, 0, 0, // 0
    4, 0, 0, // 1
    0, 4, 0, // 2
    0, 0, 4, // 3
  ]);
  const indices = [
    0, 2, 1,
    0, 3, 2,
    0, 1, 3,
    1, 2, 3,
  ];
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.BufferAttribute(vertices, 3));
  geometry.setIndex(indices);
  geometry.computeBoundingBox();
  const bbox = geometry.boundingBox!.clone();
  const center = bbox.getCenter(new THREE.Vector3());
  const size = bbox.getSize(new THREE.Vector3());
  return { geometry, bbox, center, size, flatteningPlanes: [] };
}

function signedVolume(positions: Float32Array): number {
  let sum = 0;
  for (let i = 0; i + 8 < positions.length; i += 9) {
    const ax = positions[i], ay = positions[i + 1], az = positions[i + 2];
    const bx = positions[i + 3], by = positions[i + 4], bz = positions[i + 5];
    const cx = positions[i + 6], cy = positions[i + 7], cz = positions[i + 8];
    const cxProdX = by * cz - bz * cy;
    const cxProdY = bz * cx - bx * cz;
    const cxProdZ = bx * cy - by * cx;
    sum += ax * cxProdX + ay * cxProdY + az * cxProdZ;
  }
  return sum / 6;
}

function makeTransform(pos = [0, 0, 0], rot = [0, 0, 0], scale = [1, 1, 1]) {
  return {
    position: new THREE.Vector3(pos[0], pos[1], pos[2]),
    rotation: new THREE.Euler(rot[0], rot[1], rot[2], 'ZYX'),
    scale: new THREE.Vector3(scale[0], scale[1], scale[2]),
  };
}

interface FakeWorkerControl {
  deferReplies: boolean;
  emitErrorOnLayer: boolean;
  emitErrorOnFirstWorkerOnly: boolean;
  emitMessageErrorOnLayer: boolean;
  terminatedCount: number;
  capturedPositions: Float32Array[];
  activeListenerCount: () => number;
  flushDeferred: () => void;
  uninstall: () => void;
}

function installFakeScanWorkers(): FakeWorkerControl {
  const OriginalWorker = globalThis.Worker;
  const OriginalURL = globalThis.URL;
  const createdWorkers: FakeScanWorker[] = [];
  let firstLayerDispatchedInScan = false;
  const control: FakeWorkerControl = {
    deferReplies: false,
    emitErrorOnLayer: false,
    emitErrorOnFirstWorkerOnly: false,
    emitMessageErrorOnLayer: false,
    terminatedCount: 0,
    capturedPositions: [],
    activeListenerCount: () => createdWorkers.reduce((sum, w) => sum + w.listenerCount(), 0),
    flushDeferred: () => {},
    uninstall: () => {
      globalThis.Worker = OriginalWorker;
      globalThis.URL = OriginalURL;
    },
  };
  const pendingReplies: Array<() => void> = [];
  control.flushDeferred = () => {
    while (pendingReplies.length > 0) {
      const fn = pendingReplies.shift()!;
      fn();
    }
  };

  class FakeScanWorker {
    private listeners = new Map<string, Set<(e: Event) => void>>();
    private terminated = false;

    constructor() {
      createdWorkers.push(this);
    }

    listenerCount(): number {
      let total = 0;
      for (const set of this.listeners.values()) {
        total += set.size;
      }
      return total;
    }

    addEventListener(type: string, cb: (e: Event) => void) {
      let set = this.listeners.get(type);
      if (!set) {
        set = new Set();
        this.listeners.set(type, set);
      }
      set.add(cb);
    }

    removeEventListener(type: string, cb: (e: Event) => void) {
      this.listeners.get(type)?.delete(cb);
    }

    postMessage(data: { type: string; positions?: Float32Array; gridRef?: { width: number; height: number } }) {
      if (data.type === 'init' && data.positions) {
        firstLayerDispatchedInScan = false;
        control.capturedPositions.push(data.positions.slice());
        return;
      }
      if (data.type !== 'layer') return;
      const isFirstLayerWorker = !firstLayerDispatchedInScan;
      firstLayerDispatchedInScan = true;
      if (control.emitErrorOnFirstWorkerOnly && !isFirstLayerWorker) {
        // Sibling workers intentionally stay silent; first worker's error must still abort & terminate all.
        return;
      }
      const width = data.gridRef?.width ?? 2;
      const height = data.gridRef?.height ?? 2;
      const deliver = () => {
        if (this.terminated) return;
        if (control.emitErrorOnFirstWorkerOnly) {
          const errEvent = new Event('error') as ErrorEvent;
          Object.defineProperty(errEvent, 'message', { value: 'Single worker fatal error' });
          for (const cb of Array.from(this.listeners.get('error') ?? [])) {
            cb(errEvent);
          }
          return;
        }
        if (control.emitErrorOnLayer) {
          const errEvent = new Event('error') as ErrorEvent;
          Object.defineProperty(errEvent, 'message', { value: 'Worker crashed during slice' });
          for (const cb of Array.from(this.listeners.get('error') ?? [])) {
            cb(errEvent);
          }
          return;
        }
        if (control.emitMessageErrorOnLayer) {
          const msgErrEvent = new Event('messageerror');
          for (const cb of Array.from(this.listeners.get('messageerror') ?? [])) {
            cb(msgErrEvent);
          }
          return;
        }
        const maskRows = Array.from({ length: height }, (_, y) => (y === 0 ? new Int32Array([0, 1]) : new Int32Array(0)));
        const labelRows = Array.from({ length: height }, (_, y) => (y === 0 ? new Int32Array([0, 1, 1]) : new Int32Array(0)));
        const msg = {
          data: {
            type: 'done',
            result: {
              islandMaskRle: { rows: maskRows, width, height },
              solidMaskRle: { rows: maskRows, width, height },
              islandCount: 1,
              islandLabelsRle: { rows: labelRows, width, height },
              components: [{ id: 1, label: 1, area_px: 1, size: 1, centroidSumX: 0, centroidSumY: 0 }],
            },
          },
        } as unknown as MessageEvent;
        for (const cb of Array.from(this.listeners.get('message') ?? [])) {
          cb(msg);
        }
      };
      if (control.deferReplies) {
        pendingReplies.push(deliver);
      } else {
        setTimeout(deliver, 0);
      }
    }

    terminate() {
      if (!this.terminated) {
        this.terminated = true;
        control.terminatedCount += 1;
      }
    }
  }

  globalThis.Worker = FakeScanWorker as unknown as typeof Worker;
  globalThis.URL = class extends OriginalURL {
    constructor(url: string | URL, base?: string | URL) {
      try {
        super(url, base);
      } catch {
        super(String(url), 'file:///');
      }
    }
  } as typeof URL;

  return control;
}

type IslandMgr = ReturnType<typeof useIslandManager>;

function ManagerHarness({
  geom,
  transform,
  layerHeightMm,
  onHook,
}: {
  geom: GeometryWithBounds | null;
  transform: ReturnType<typeof makeTransform>;
  layerHeightMm: number;
  onHook: (mgr: IslandMgr) => void;
}) {
  const mgr = useIslandManager({ geom, transform, layerHeightMm });
  onHook(mgr);
  return null;
}

test('MIR-02 & MIR-06a: useIslandManager converts indexed geom to outward soup, clears on transform/geom change, ignores wrapper re-renders, and aborts mid-flight scans', async () => {
  const workers = installFakeScanWorkers();
  const geom1 = createIndexedOutwardTetrahedron();
  const geom2 = createIndexedOutwardTetrahedron();
  const container = document.createElement('div');
  document.body.appendChild(container);
  const root = createRoot(container);
  let latest: IslandMgr | null = null;

  const renderMgr = async (
    geom: GeometryWithBounds | null,
    transform: ReturnType<typeof makeTransform>,
  ) => {
    await act(async () => {
      root.render(
        <StrictMode>
          <I18nClientProvider>
            <HotkeyProvider>
              <ManagerHarness
                geom={geom}
                transform={transform}
                layerHeightMm={1.0}
                onHook={(m) => {
                  latest = m;
                }}
              />
            </HotkeyProvider>
          </I18nClientProvider>
        </StrictMode>,
      );
    });
  };

  try {
    // 1. Scan indexed geometry under mirrored scale (-1, 1, 1) -> MIR-06a check
    await renderMgr(geom1, makeTransform([0, 0, 0], [0, 0, 0], [-1, 1, 1]));
    await act(async () => {
      await latest!.onRunScanlineScan();
    });
    assert.ok(latest!.scanData !== null, 'scanData should populate after scan');
    assert.ok(workers.capturedPositions.length >= 1);
    const sent = workers.capturedPositions[0];
    assert.equal(sent.length, 4 * 9, 'indexed geometry must be converted via toNonIndexed() to 36 floats');
    assert.ok(
      signedVolume(sent) > 0,
      `expected positive signed volume (outward normals) under det < 0, got ${signedVolume(sent)}`,
    );

    // 2. Re-render with fresh wrapper objects carrying identical scalars -> scanData must survive!
    await renderMgr(
      { ...geom1, bbox: geom1.bbox.clone() },
      makeTransform([0, 0, 0], [0, 0, 0], [-1, 1, 1]),
    );
    assert.ok(latest!.scanData !== null, 'fresh wrapper objects with identical scalars must not clear scanData');

    // 3. Flip scale back to (1, 1, 1) -> must clear scanData
    await renderMgr(geom1, makeTransform([0, 0, 0], [0, 0, 0], [1, 1, 1]));
    assert.equal(latest!.scanData, null, 'scale change must invalidate scanData');
    assert.equal(latest!.scanBBox, null, 'scale change must clear scanBBox');

    // 4. Scan again, then change position -> must clear scanData
    await act(async () => {
      await latest!.onRunScanlineScan();
    });
    assert.ok(latest!.scanData !== null);
    await renderMgr(geom1, makeTransform([10, 0, 0], [0, 0, 0], [1, 1, 1]));
    assert.equal(latest!.scanData, null, 'position change must invalidate scanData');

    // 5. Scan again, then change rotation -> must clear scanData
    await act(async () => {
      await latest!.onRunScanlineScan();
    });
    assert.ok(latest!.scanData !== null);
    await renderMgr(geom1, makeTransform([10, 0, 0], [0.5, 0, 0], [1, 1, 1]));
    assert.equal(latest!.scanData, null, 'rotation change must invalidate scanData');

    // 6. Scan again, then swap geom.geometry (mirror bake) -> must clear scanData
    await act(async () => {
      await latest!.onRunScanlineScan();
    });
    assert.ok(latest!.scanData !== null);
    await renderMgr(geom2, makeTransform([10, 0, 0], [0.5, 0, 0], [1, 1, 1]));
    assert.equal(latest!.scanData, null, 'geometry swap must invalidate scanData');

    // 7. Mid-flight scan aborted by transform change must terminate workers and never commit stale scanData
    workers.deferReplies = true;
    const terminatedBefore = workers.terminatedCount;
    let inFlightPromise: Promise<void> | null = null;
    await act(async () => {
      inFlightPromise = latest!.onRunScanlineScan();
      await new Promise((r) => setTimeout(r, 10));
    });
    assert.equal(latest!.scanning, true, 'should be scanning while worker is mid-flight');

    await renderMgr(geom2, makeTransform([10, 0, 0], [0.5, 0, 0], [-1, 1, 1]));
    assert.equal(latest!.scanning, false, 'aborted mid-flight scan must reset scanning immediately');
    assert.ok(workers.terminatedCount > terminatedBefore, 'aborted scan must terminate workers immediately');

    workers.flushDeferred();
    await act(async () => {
      await inFlightPromise;
    });
    await settle(20);
    assert.equal(latest!.scanData, null, 'aborted scan must not commit stale scanData');
  } finally {
    await act(async () => {
      root.unmount();
    });
    container.remove();
    geom1.geometry.dispose();
    geom2.geometry.dispose();
    disposeEventLoopChannel();
    workers.uninstall();
  }
});

test('MIR-04: IslandVoxelVisualization renders outer group at origin (0,0,0) when RLE grid already holds world-space XY', async () => {
  const row0 = new Int32Array(0);
  const row1 = new Int32Array([1, 1, 1]); // col 1, len 1, islandId 1
  const row2 = new Int32Array(0);
  const layerLabels = { rows: [row0, row1, row2], width: 3, height: 3 };
  const scanResults: ScanResults = {
    grid: { originX: 24, originZ: 14, width: 3, height: 3, px_mm: 1 },
    layers: [{ islandMaskRle: { rows: [], width: 3, height: 3 }, islandCount: 1, islandLabels: layerLabels }],
    firstHit: new Int16Array(9).fill(-1),
    lastHit: new Int16Array(9).fill(-1),
    baseFootprint: new Uint8Array(9),
    baseLabels: new Int32Array(9),
    compBase: new Int16Array([0, 0]),
    compTop: new Int16Array([0, 0]),
    islands: [
      {
        id: 1,
        firstLayer: 0,
        lastLayer: 0,
        status: 'active',
        totalAreaMm2: 1,
        perLayerAreaMm2: new Map([[0, 1]]),
        childIds: [],
        centroidSumX: 25.5,
        centroidSumY: -15.5,
        centroidSumZ: 0.25,
        centroidCount: 1,
      },
    ],
    islandLabelsPerLayer: [layerLabels],
  };

  const container = document.createElement('div');
  document.body.appendChild(container);
  const root = createRoot(container);

  try {
    await act(async () => {
      root.render(
        <StrictMode>
          <I18nClientProvider>
            <HotkeyProvider>
              <IslandVoxelVisualization
                scanResults={scanResults}
                layerHeightMm={0.5}
                enabled={true}
                transform={makeTransform([25, -15, 0], [0, 0, 0], [1, 1, 1])}
              />
            </HotkeyProvider>
          </I18nClientProvider>
        </StrictMode>,
      );
    });

    const outerGroup = container.querySelector('group');
    assert.ok(outerGroup, 'outer <group> should render');
    const groupPropsKey = Object.keys(outerGroup).find((k) => k.startsWith('__reactProps$'));
    assert.ok(groupPropsKey);
    const groupPos = (outerGroup as unknown as Record<string, { position?: THREE.Vector3 }>)[groupPropsKey].position;
    assert.equal(groupPos, undefined, 'outer <group> must stay at origin (no double translation via getScanVisualPosition)');

    const meshEl = container.querySelector('mesh');
    assert.ok(meshEl, 'child <mesh> should render');
    const meshPropsKey = Object.keys(meshEl).find((k) => k.startsWith('__reactProps$'));
    assert.ok(meshPropsKey);
    const geometry = (meshEl as unknown as Record<string, { geometry?: THREE.BufferGeometry }>)[meshPropsKey].geometry;
    assert.ok(geometry, '<mesh> must receive generated BufferGeometry');
    geometry.computeBoundingBox();
    const center = geometry.boundingBox!.getCenter(new THREE.Vector3());
    assert.ok(Math.abs(center.x - 25.5) < 1e-4, `expected mesh X center near 25.5, got ${center.x}`);
    assert.ok(Math.abs(center.y - -15.5) < 1e-4, `expected mesh Y center near -15.5, got ${center.y}`);
    assert.ok(Math.abs(center.z - 0.25) < 1e-4, `expected mesh Z center near 0.25, got ${center.z}`);
  } finally {
    await act(async () => {
      root.unmount();
    });
    container.remove();
  }
});

test('ScanOrchestrator rejects cleanly on worker error and messageerror, terminates workers, cleans listeners, and resets scanning=false', async () => {
  const workers = installFakeScanWorkers();
  const geom = createIndexedOutwardTetrahedron();
  const container = document.createElement('div');
  document.body.appendChild(container);
  const root = createRoot(container);
  let latest: IslandMgr | null = null;

  try {
    await act(async () => {
      root.render(
        <StrictMode>
          <I18nClientProvider>
            <HotkeyProvider>
              <ManagerHarness
                geom={geom}
                transform={makeTransform()}
                layerHeightMm={1.0}
                onHook={(m) => {
                  latest = m;
                }}
              />
            </HotkeyProvider>
          </I18nClientProvider>
        </StrictMode>,
      );
    });

    const raceTimeout = <T,>(promise: Promise<T>, label: string): Promise<T> => Promise.race([
      promise,
      new Promise<T>((_, reject) => setTimeout(() => reject(new Error(`Timed out waiting for ${label} rejection`)), 400)),
    ]);

    // 1. Worker emits 'error'
    workers.emitErrorOnLayer = true;
    const terminatedBeforeErr = workers.terminatedCount;
    await act(async () => {
      await assert.rejects(
        () => raceTimeout(latest!.onRunScanlineScan(), 'worker error'),
        /Worker crashed during slice/i,
      );
    });
    assert.equal(latest!.scanning, false, 'scanning must reset to false after worker error');
    assert.equal(latest!.scanData, null, 'scanData must remain null after worker error');
    assert.ok(workers.terminatedCount > terminatedBeforeErr, 'workers must be terminated after worker error');
    assert.equal(workers.activeListenerCount(), 0, 'all worker listeners must be removed after worker error');

    // 2. Worker emits 'messageerror'
    workers.emitErrorOnLayer = false;
    workers.emitMessageErrorOnLayer = true;
    const terminatedBeforeMsgErr = workers.terminatedCount;
    await act(async () => {
      await assert.rejects(
        () => raceTimeout(latest!.onRunScanlineScan(), 'worker messageerror'),
        /message/i,
      );
    });
    assert.equal(latest!.scanning, false, 'scanning must reset to false after worker messageerror');
    assert.ok(workers.terminatedCount > terminatedBeforeMsgErr, 'workers must be terminated after worker messageerror');
    assert.equal(workers.activeListenerCount(), 0, 'all worker listeners must be removed after worker messageerror');

    // 3. Only the first worker emits 'error' while sibling workers stay silent -> must not hang, must terminate & detach all workers
    workers.emitMessageErrorOnLayer = false;
    workers.emitErrorOnFirstWorkerOnly = true;
    const terminatedBeforeSingleErr = workers.terminatedCount;
    await act(async () => {
      await assert.rejects(
        () => raceTimeout(latest!.onRunScanlineScan(), 'single worker error with silent siblings'),
        /Single worker fatal error/i,
      );
    });
    assert.equal(latest!.scanning, false, 'scanning must reset to false when one worker fails and siblings stay silent');
    assert.equal(latest!.scanData, null, 'scanData must remain null after partial worker failure');
    assert.ok(workers.terminatedCount > terminatedBeforeSingleErr, 'all pool workers must be terminated on single-worker error');
    assert.equal(workers.activeListenerCount(), 0, 'listeners on silent sibling workers must also be removed');

    // 4. Subsequent healthy scan recovers cleanly after worker failures
    workers.emitErrorOnFirstWorkerOnly = false;
    await act(async () => {
      await raceTimeout(latest!.onRunScanlineScan(), 'post-error recovery scan');
    });
    assert.equal(latest!.scanning, false, 'scanning resets to false after recovery scan');
    assert.ok(latest!.scanData !== null, 'subsequent scan succeeds cleanly after prior worker errors');
  } finally {
    await act(async () => {
      root.unmount();
    });
    container.remove();
    geom.geometry.dispose();
    disposeEventLoopChannel();
    workers.uninstall();
  }
});
