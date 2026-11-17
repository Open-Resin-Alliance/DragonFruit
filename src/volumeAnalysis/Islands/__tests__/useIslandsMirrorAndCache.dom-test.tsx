import assert from 'node:assert/strict';
import test, { after } from 'node:test';
import { act, StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import * as THREE from 'three';
import { I18nClientProvider } from '@/components/I18nClientProvider';
import { HotkeyProvider } from '@/hotkeys/HotkeyContext';
import type { GeometryWithBounds } from '@/hooks/useStlGeometry';
import { renderWithProviders, settle } from '@/utils/__tests__/helpers/renderDom';
import { disposeEventLoopChannel } from '@/utils/yieldToEventLoop';
import { useIslands, type UseIslandsInput, type UseIslandsReturn } from '@/volumeAnalysis/Islands/useIslands';
import { dispatchScanlineWorkerMessage } from '@/volumeAnalysis/IslandScan/scanlineScan.worker';

after(() => disposeEventLoopChannel());

function createOutwardTetrahedronGeometry(): GeometryWithBounds {
  // Asymmetric watertight tetrahedron with outward CCW winding
  const v0 = [0, 0, 0];
  const v1 = [4, 0, 0];
  const v2 = [0, 4, 0];
  const v3 = [0, 0, 4];
  const positions = new Float32Array([
    ...v0, ...v2, ...v1, // bottom (-Z)
    ...v0, ...v3, ...v2, // back (-X)
    ...v0, ...v1, ...v3, // back (-Y)
    ...v1, ...v2, ...v3, // diagonal (+1,+1,+1)
  ]);
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.BufferAttribute(positions, 3));
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

function makeTransform(scaleX = 1) {
  return {
    position: new THREE.Vector3(0, 0, 0),
    rotation: new THREE.Euler(0, 0, 0, 'ZYX'),
    scale: new THREE.Vector3(scaleX, 1, 1),
  };
}

interface TauriCapture {
  commands: string[];
  stagedPositions: Float32Array[];
  scanStagedArgs: Array<{
    matrix?: number[];
    center?: [number, number, number];
    [key: string]: unknown;
  }>;
  uninstall: () => void;
}

type MockScanResult = {
  voxelIslands: Array<{
    id: string;
    contact: { x: number; y: number; z: number };
    baseZ: number;
    rawBaseZ?: number;
    areaMm2: number;
    peakAreaMm2?: number;
    isDetached?: boolean;
    layerSpan: [number, number];
  }>;
  minimaIslands: Array<{ position: { x: number; y: number; z: number } }>;
  overhangIslands: unknown[];
  stability: {
    bearingAreaMm2: number;
    bearingEdges: number;
    centroidDepthMm: number;
    contactDepthMm: number;
    dragMomentMm3: number;
    marginMm: number;
    adhesionRatio: number;
    pushDirDeg: number;
    dragTopMm: number;
    bearingIsRaft: boolean;
  };
};

function installTauriMock(options?: {
  onScanStaged?: (args: Record<string, unknown>) => MockScanResult | Promise<MockScanResult>;
  onScanOverhangsStaged?: () => unknown;
}): TauriCapture {
  const commands: string[] = [];
  const stagedPositions: Float32Array[] = [];
  const scanStagedArgs: TauriCapture['scanStagedArgs'] = [];
  let nextCallbackId = 1;
  const win = window as unknown as Record<string, unknown>;
  const prevInternals = win.__TAURI_INTERNALS__;
  const prevEventInternals = win.__TAURI_EVENT_PLUGIN_INTERNALS__;

  win.__TAURI_INTERNALS__ = {
    invoke: async (cmd: string, args: unknown) => {
      commands.push(cmd);
      if (cmd === 'plugin:event|listen') return nextCallbackId;
      if (cmd === 'plugin:event|unlisten') return null;
      if (cmd === 'stage_mesh_binary_set') {
        const bytes = args as Uint8Array;
        const copy = bytes.slice();
        stagedPositions.push(new Float32Array(copy.buffer, copy.byteOffset, copy.byteLength / 4));
        return null;
      }
      if (cmd === 'scan_overhangs_staged') {
        if (options?.onScanOverhangsStaged) {
          return options.onScanOverhangsStaged();
        }
        return { regions: [], stability: null };
      }
      if (cmd === 'scan_islands_staged' || cmd === 'scan_islands_from_path') {
        const argObj = (args ?? {}) as Record<string, unknown>;
        if (cmd === 'scan_islands_staged') {
          scanStagedArgs.push(argObj as TauriCapture['scanStagedArgs'][number]);
        }
        if (options?.onScanStaged) {
          return options.onScanStaged(argObj);
        }
        return {
          voxelIslands: [
            { id: 'v0', contact: { x: 1, y: 1, z: 0.5 }, baseZ: 0.5, areaMm2: 1.5, layerSpan: [1, 3] },
          ],
          minimaIslands: [{ position: { x: 0, y: 0, z: -2 } }],
          overhangIslands: [],
          stability: {
            bearingAreaMm2: 10,
            bearingEdges: 4,
            centroidDepthMm: 2,
            contactDepthMm: 2,
            dragMomentMm3: 42.5,
            marginMm: 1,
            adhesionRatio: 1000,
            pushDirDeg: 0,
            dragTopMm: 5,
            bearingIsRaft: false,
          },
        };
      }
      throw new Error(`Unexpected Tauri command: ${cmd}`);
    },
    transformCallback: () => nextCallbackId++,
    unregisterCallback: () => {},
  };
  win.__TAURI_EVENT_PLUGIN_INTERNALS__ = {
    unregisterListener: () => {},
  };

  return {
    commands,
    stagedPositions,
    scanStagedArgs,
    uninstall: () => {
      if (prevInternals === undefined) delete win.__TAURI_INTERNALS__;
      else win.__TAURI_INTERNALS__ = prevInternals;
      if (prevEventInternals === undefined) delete win.__TAURI_EVENT_PLUGIN_INTERNALS__;
      else win.__TAURI_EVENT_PLUGIN_INTERNALS__ = prevEventInternals;
    },
  };
}

function IslandsHarness({
  input,
  onHook,
}: {
  input: UseIslandsInput;
  onHook: (value: UseIslandsReturn) => void;
}) {
  const value = useIslands(input);
  onHook(value);
  return null;
}

function soupBounds(positions: Float32Array): { min: [number, number, number]; max: [number, number, number] } {
  let minX = Infinity, minY = Infinity, minZ = Infinity;
  let maxX = -Infinity, maxY = -Infinity, maxZ = -Infinity;
  for (let i = 0; i + 2 < positions.length; i += 3) {
    const x = positions[i], y = positions[i + 1], z = positions[i + 2];
    if (x < minX) minX = x;
    if (y < minY) minY = y;
    if (z < minZ) minZ = z;
    if (x > maxX) maxX = x;
    if (y > maxY) maxY = y;
    if (z > maxZ) maxZ = z;
  }
  return { min: [minX, minY, minZ], max: [maxX, maxY, maxZ] };
}

test('MIR-01 & MIR-01b: sourcePath + geom stages pre-TRS local soup + matrix/center and invokes scan_islands_staged', async () => {
  const tauri = installTauriMock();
  const geom = createOutwardTetrahedronGeometry();
  let latest: UseIslandsReturn | null = null;
  let tree: Awaited<ReturnType<typeof renderWithProviders>> | null = null;

  try {
    tree = await renderWithProviders(
      <IslandsHarness
        input={{
          geom,
          transform: makeTransform(-1),
          layerHeightMm: 0.05,
          supportTips: [],
          plateZ: 0,
          modelId: 'model-1',
          sourcePath: 'C:\\models\\tet.stl',
        }}
        onHook={(v) => {
          latest = v;
        }}
      />,
    );

    await act(async () => {
      await latest!.onRunScan();
    });
    await settle(20);

    assert.ok(
      tauri.commands.includes('scan_islands_staged'),
      `expected scan_islands_staged to be invoked, got: ${tauri.commands.join(', ')}`,
    );
    assert.ok(
      !tauri.commands.includes('scan_islands_from_path'),
      `did not expect scan_islands_from_path when geom is present, got: ${tauri.commands.join(', ')}`,
    );
    assert.equal(tauri.stagedPositions.length, 1);
    const staged = tauri.stagedPositions[0];
    assert.equal(staged.length, 4 * 9);
    // Pre-TRS local soup stays in local [0, 4]^3 space with original outward CCW winding
    assert.deepEqual(soupBounds(staged), { min: [0, 0, 0], max: [4, 4, 4] });
    assert.ok(
      signedVolume(staged) > 0,
      `expected positive local signed volume before Rust TRS flip, got ${signedVolume(staged)}`,
    );
    assert.equal(tauri.scanStagedArgs.length, 1);
    assert.deepEqual(tauri.scanStagedArgs[0].center, [2, 2, 2]);
    assert.deepEqual(
      tauri.scanStagedArgs[0].matrix?.map((v) => v + 0),
      [
        -1, 0, 0, 0,
        0, 1, 0, 0,
        0, 0, 1, 0,
        0, 0, 0, 1,
      ],
    );
    assert.equal(latest!.scanning, false);
    assert.equal(latest!.voxelIslands.length, 1);
    assert.equal(latest!.toppleCoverage, false);
    assert.equal(latest!.dragTotalMm3, 42.5);
  } finally {
    await tree?.unmount();
    geom.geometry.dispose();
    tauri.uninstall();
  }
});

test('MIR-01b fallback: when scan_islands_staged rejects, re-stages world winding-flipped soup before scan_overhangs_staged', async () => {
  const origWorker = (globalThis as { Worker?: unknown }).Worker;
  const OrigURL = globalThis.URL;
  class InlineScanlineWorker {
    private listeners = new Set<(e: MessageEvent) => void>();
    addEventListener(_type: string, cb: (e: MessageEvent) => void) {
      this.listeners.add(cb);
    }
    removeEventListener(_type: string, cb: (e: MessageEvent) => void) {
      this.listeners.delete(cb);
    }
    postMessage(msg: unknown) {
      dispatchScanlineWorkerMessage(msg as Parameters<typeof dispatchScanlineWorkerMessage>[0], (payload) => {
        const evt = { data: payload } as MessageEvent;
        for (const cb of [...this.listeners]) cb(evt);
      });
    }
    terminate() {}
  }
  class FallbackURL extends OrigURL {
    constructor(url: string | URL, base?: string | URL) {
      super(url, base ?? 'http://localhost:3005/');
    }
  }
  (globalThis as { Worker?: unknown }).Worker = InlineScanlineWorker;
  globalThis.URL = FallbackURL as unknown as typeof URL;

  const tauri = installTauriMock({
    onScanStaged: () => {
      throw new Error('simulated native staged scan failure');
    },
  });
  const geom = createOutwardTetrahedronGeometry();
  let latest: UseIslandsReturn | null = null;
  let tree: Awaited<ReturnType<typeof renderWithProviders>> | null = null;

  try {
    tree = await renderWithProviders(
      <IslandsHarness
        input={{
          geom,
          transform: makeTransform(-1),
          layerHeightMm: 0.25,
          supportTips: [],
          plateZ: 0,
          modelId: 'fallback-model',
          sourcePath: 'C:\\models\\tet.stl',
        }}
        onHook={(v) => {
          latest = v;
        }}
      />,
    );

    await act(async () => {
      await latest!.onRunScan();
    });
    await settle(40);

    const firstStageIdx = tauri.commands.indexOf('stage_mesh_binary_set');
    const scanIslandsIdx = tauri.commands.indexOf('scan_islands_staged');
    const secondStageIdx = tauri.commands.indexOf('stage_mesh_binary_set', firstStageIdx + 1);
    const scanOverhangsIdx = tauri.commands.indexOf('scan_overhangs_staged');

    assert.ok(firstStageIdx >= 0 && scanIslandsIdx > firstStageIdx);
    assert.ok(secondStageIdx > scanIslandsIdx, 'must re-stage soup after scan_islands_staged rejects');
    assert.ok(scanOverhangsIdx > secondStageIdx, 'must re-stage world soup BEFORE scan_overhangs_staged');
    assert.equal(tauri.stagedPositions.length, 2);

    // First stage: local pre-TRS soup [0..4]^3; second stage: centered/scaled/flipped world soup [-2..2]^3
    assert.deepEqual(soupBounds(tauri.stagedPositions[0]), { min: [0, 0, 0], max: [4, 4, 4] });
    assert.deepEqual(soupBounds(tauri.stagedPositions[1]), { min: [-2, -2, -2], max: [2, 2, 2] });
    assert.ok(signedVolume(tauri.stagedPositions[1]) > 0, 're-staged world soup preserves outward winding under det < 0');
  } finally {
    await tree?.unmount();
    geom.geometry.dispose();
    disposeEventLoopChannel();
    tauri.uninstall();
    globalThis.URL = OrigURL;
    (globalThis as { Worker?: unknown }).Worker = origWorker;
  }
});

test('C2 native mapping: propagates rawBaseZ/peakAreaMm2/isDetached, keeps isDetached below minAreaMm2, and uses dynamic zBandMm', async () => {
  const tauri = installTauriMock({
    onScanStaged: () => ({
      voxelIslands: [
        {
          id: 'v-detached',
          contact: { x: 0, y: 0, z: 1.25 },
          baseZ: 1.25,
          rawBaseZ: 1.00,
          areaMm2: 0.005,
          peakAreaMm2: 0.005,
          isDetached: true,
          layerSpan: [20, 20],
        },
        {
          id: 'v-fringe-peak',
          contact: { x: 5, y: 5, z: 3.0 },
          baseZ: 3.0,
          rawBaseZ: 3.0,
          areaMm2: 0.005,
          peakAreaMm2: 0.05,
          isDetached: false,
          layerSpan: [60, 62],
        },
        {
          id: 'v-speck',
          contact: { x: 10, y: 10, z: 6.0 },
          baseZ: 6.0,
          rawBaseZ: 6.0,
          areaMm2: 0.005,
          peakAreaMm2: 0.01,
          isDetached: false,
          layerSpan: [120, 120],
        },
      ],
      // Minimum at z=1.08: |rawBaseZ 1.00 - 1.08| = 0.08 <= max(2*0.05, 0.10) = 0.10
      // (while old layerHeightMm=0.05 zBandMm or baseZ=1.25 missed it).
      minimaIslands: [{ position: { x: 0, y: 0, z: 1.08 } }],
      overhangIslands: [],
      stability: {
        bearingAreaMm2: 10,
        bearingEdges: 4,
        centroidDepthMm: 2,
        contactDepthMm: 2,
        dragMomentMm3: 10,
        marginMm: 1,
        adhesionRatio: 1000,
        pushDirDeg: 0,
        dragTopMm: 5,
        bearingIsRaft: false,
      },
    }),
  });
  const geom = createOutwardTetrahedronGeometry();
  let latest: UseIslandsReturn | null = null;
  let tree: Awaited<ReturnType<typeof renderWithProviders>> | null = null;

  try {
    tree = await renderWithProviders(
      <IslandsHarness
        input={{
          geom,
          transform: makeTransform(1),
          layerHeightMm: 0.05,
          supportTips: [],
          plateZ: 0,
          modelId: 'c2-meta-model',
          sourcePath: 'C:\\models\\tet.stl',
        }}
        onHook={(v) => {
          latest = v;
        }}
      />,
    );

    await act(async () => {
      await latest!.onRunScan();
    });
    await settle(20);

    const ids = latest!.voxelIslands.map((v) => v.id);
    assert.deepEqual(ids, ['v-detached', 'v-fringe-peak'], 'keeps detached tip and peakAreaMm2 >= minAreaMm2 while culling tiny fringe');
    assert.equal(latest!.voxelIslands[0].isDetached, true);
    assert.equal(latest!.voxelIslands[0].rawBaseZ, 1.00);
    assert.equal(latest!.voxelIslands[1].peakAreaMm2, 0.05);
    assert.equal(latest!.stats.matched, 1, 'v-detached matches m0 via rawBaseZ + max(2h, 0.10) zBandMm');
    const matched = latest!.filteredIslands.find((i) => i.id === 'v-detached');
    assert.equal(matched?.class, 'intersection');
  } finally {
    await tree?.unmount();
    geom.geometry.dispose();
    tauri.uninstall();
  }
});

test('MIR-03: swapping geom.geometry (mirror bake) with identical sourcePath and transform misses cache; model switch A -> B -> A restores cache including toppleCoverage & dragTotalMm3', async () => {
  let scanCount = 0;
  const tauri = installTauriMock({
    onScanStaged: () => {
      scanCount += 1;
      return {
        voxelIslands: [
          { id: `v-scan-${scanCount}`, contact: { x: 1, y: 1, z: 0.5 }, baseZ: 0.5, areaMm2: 1.5, layerSpan: [1, 3] },
        ],
        minimaIslands: [{ position: { x: 0, y: 0, z: -2 } }],
        overhangIslands: [],
        stability: {
          bearingAreaMm2: 10,
          bearingEdges: 4,
          centroidDepthMm: 2,
          contactDepthMm: 2,
          dragMomentMm3: 77.25,
          marginMm: 1,
          adhesionRatio: 1000,
          pushDirDeg: 0,
          dragTopMm: 5,
          bearingIsRaft: false,
        },
      };
    },
  });

  const geomA = createOutwardTetrahedronGeometry();
  const geomBaked = createOutwardTetrahedronGeometry();
  const geomB = createOutwardTetrahedronGeometry();
  const identity = makeTransform(1);
  let latest: UseIslandsReturn | null = null;
  const container = document.createElement('div');
  document.body.appendChild(container);

  const root = createRoot(container);
  const renderInput = async (input: UseIslandsInput) => {
    await act(async () => {
      root.render(
        <StrictMode>
          <I18nClientProvider>
            <HotkeyProvider>
              <IslandsHarness input={input} onHook={(v) => { latest = v; }} />
            </HotkeyProvider>
          </I18nClientProvider>
        </StrictMode>,
      );
    });
  };

  try {
    // 1. Scan Model A
    await renderInput({
      geom: geomA,
      transform: identity,
      layerHeightMm: 0.05,
      supportTips: [],
      plateZ: 0,
      modelId: 'model-A',
      sourcePath: 'C:\\models\\shared.stl',
    });

    await act(async () => {
      await latest!.onRunScan();
    });
    assert.equal(latest!.voxelIslands[0]?.id, 'v-scan-1');
    assert.equal(latest!.toppleCoverage, false);
    assert.equal(latest!.dragTotalMm3, 77.25);

    // 2. Switch to Model B (even with same sourcePath!) -> clears, does not hit Model A cache
    await renderInput({
      geom: geomB,
      transform: identity,
      layerHeightMm: 0.05,
      supportTips: [],
      plateZ: 0,
      modelId: 'model-B',
      sourcePath: 'C:\\models\\shared.stl',
    });
    assert.equal(latest!.voxelIslands.length, 0);
    assert.equal(latest!.toppleCoverage, true);
    assert.equal(latest!.dragTotalMm3, 0);

    // 3. Switch back to Model A (unchanged geomA.geometry.uuid + transform) -> restores cache!
    await renderInput({
      geom: geomA,
      transform: identity,
      layerHeightMm: 0.05,
      supportTips: [],
      plateZ: 0,
      modelId: 'model-A',
      sourcePath: 'C:\\models\\shared.stl',
    });
    assert.equal(latest!.voxelIslands[0]?.id, 'v-scan-1', 'model A voxelIslands must restore on A -> B -> A');
    assert.equal(latest!.minimaIslands.length, 1);
    assert.equal(latest!.toppleCoverage, false, 'toppleCoverage must restore from cache');
    assert.equal(latest!.dragTotalMm3, 77.25, 'dragTotalMm3 must restore from cache');

    // 4. Simulate mirror bake on Model A: geomA replaced by geomBaked (different uuid) with identical modelId + sourcePath + transform
    await renderInput({
      geom: geomBaked,
      transform: identity,
      layerHeightMm: 0.05,
      supportTips: [],
      plateZ: 0,
      modelId: 'model-A',
      sourcePath: 'C:\\models\\shared.stl',
    });
    assert.equal(latest!.voxelIslands.length, 0, 'mirror bake uuid change must invalidate scan');

    // Switch B -> baked A -> must STILL miss pre-mirror geomA cache!
    await renderInput({
      geom: geomB,
      transform: identity,
      layerHeightMm: 0.05,
      supportTips: [],
      plateZ: 0,
      modelId: 'model-B',
      sourcePath: 'C:\\models\\shared.stl',
    });
    await renderInput({
      geom: geomBaked,
      transform: identity,
      layerHeightMm: 0.05,
      supportTips: [],
      plateZ: 0,
      modelId: 'model-A',
      sourcePath: 'C:\\models\\shared.stl',
    });
    assert.equal(latest!.voxelIslands.length, 0, 'switching back to mirror-baked A must NOT restore stale pre-mirror geomA cache');
  } finally {
    await act(async () => {
      root.unmount();
    });
    container.remove();
    geomA.geometry.dispose();
    geomBaked.geometry.dispose();
    geomB.geometry.dispose();
    disposeEventLoopChannel();
    tauri.uninstall();
  }
});

function makeMockScanResult(id: string, dragMomentMm3: number, minimaZ = -2): MockScanResult {
  return {
    voxelIslands: [
      { id, contact: { x: 1, y: 1, z: 0.5 }, baseZ: 0.5, areaMm2: 1.5, layerSpan: [1, 3] },
    ],
    minimaIslands: [{ position: { x: 0, y: 0, z: minimaZ } }],
    overhangIslands: [],
    stability: {
      bearingAreaMm2: 10,
      bearingEdges: 4,
      centroidDepthMm: 2,
      contactDepthMm: 2,
      dragMomentMm3,
      marginMm: 1,
      adhesionRatio: 1000,
      pushDirDeg: 0,
      dragTopMm: 5,
      bearingIsRaft: false,
    },
  };
}

test('overlapping onRunScan() on the same cacheKey keeps scanning=true until latest settles and discards stale slower scan results', async () => {
  const resolvers: Array<(res: MockScanResult) => void> = [];
  const tauri = installTauriMock({
    onScanStaged: () => new Promise<MockScanResult>((resolve) => {
      resolvers.push(resolve);
    }),
  });

  const geom = createOutwardTetrahedronGeometry();
  const identity = makeTransform(1);
  let latest: UseIslandsReturn | null = null;
  let tree: Awaited<ReturnType<typeof renderWithProviders>> | null = null;

  try {
    tree = await renderWithProviders(
      <IslandsHarness
        input={{
          geom,
          transform: identity,
          layerHeightMm: 0.05,
          supportTips: [],
          plateZ: 0,
          modelId: 'overlap-model',
          sourcePath: 'C:\\models\\overlap.stl',
        }}
        onHook={(v) => {
          latest = v;
        }}
      />,
    );

    // Case 1: first scan finishes earlier while second scan is still running -> scanning must stay true.
    let firstEarlyPromise!: Promise<void>;
    let secondLatePromise!: Promise<void>;
    act(() => {
      firstEarlyPromise = latest!.onRunScan();
    });
    await settle(20);
    assert.equal(resolvers.length, 1, 'first scan reached scan_islands_staged');
    assert.equal(latest!.scanning, true);

    act(() => {
      secondLatePromise = latest!.onRunScan();
    });
    await settle(20);
    assert.equal(resolvers.length, 2, 'second scan reached scan_islands_staged');
    assert.equal(latest!.scanning, true);

    // Resolve superseded first scan while second is still pending.
    await act(async () => {
      resolvers[0](makeMockScanResult('v-superseded-early', 10, -10));
      await firstEarlyPromise;
    });
    assert.equal(latest!.scanning, true, 'superseded first scan must not clear scanning while second scan is in flight');
    assert.equal(latest!.voxelIslands.length, 0, 'superseded first scan must not commit stale islands');
    assert.equal(latest!.minimaIslands.length, 0, 'superseded first scan must not commit stale minima');

    // Now resolve second scan.
    await act(async () => {
      resolvers[1](makeMockScanResult('v-second-winner', 20, -20));
      await secondLatePromise;
    });
    assert.equal(latest!.scanning, false, 'scanning resets once the latest scan settles');
    assert.equal(latest!.voxelIslands[0]?.id, 'v-second-winner');
    assert.equal(latest!.minimaIslands[0]?.baseZ, -20);
    assert.equal(latest!.dragTotalMm3, 20);

    // Case 2: second scan finishes first, slower first scan finishes second -> slower first must not overwrite newer result.
    resolvers.length = 0;
    let firstSlowPromise!: Promise<void>;
    let secondFastPromise!: Promise<void>;
    act(() => {
      firstSlowPromise = latest!.onRunScan();
    });
    await settle(20);
    assert.equal(latest!.scanning, true, 'scanning must be true while first scan is in flight');
    act(() => {
      secondFastPromise = latest!.onRunScan();
    });
    await settle(20);
    assert.equal(resolvers.length, 2, 'two overlapping scans in flight');
    assert.equal(latest!.scanning, true, 'scanning must stay true while overlapping second scan is in flight');

    await act(async () => {
      resolvers[1](makeMockScanResult('v-newer', 99, -99));
      await secondFastPromise;
    });
    assert.equal(latest!.scanning, false, 'scanning resets once second scan completes');
    assert.equal(latest!.voxelIslands[0]?.id, 'v-newer');
    assert.equal(latest!.minimaIslands[0]?.baseZ, -99);
    assert.equal(latest!.minimaIslands[0]?.contact.z, -99);
    assert.equal(latest!.dragTotalMm3, 99);

    await act(async () => {
      resolvers[0](makeMockScanResult('v-stale-slower', 11, -11));
      await firstSlowPromise;
    });
    assert.equal(latest!.scanning, false, 'scanning remains false after slower stale scan settles');
    assert.equal(latest!.voxelIslands[0]?.id, 'v-newer', 'slower first scan must not overwrite newer voxelIslands');
    assert.equal(latest!.minimaIslands[0]?.baseZ, -99, 'slower first scan must not overwrite newer minimaIslands');
    assert.equal(latest!.minimaIslands[0]?.contact.z, -99, 'slower first scan must not overwrite newer minimaIslands contact');
    assert.equal(latest!.dragTotalMm3, 99, 'slower first scan must not overwrite newer dragTotalMm3');
  } finally {
    await tree?.unmount();
    geom.geometry.dispose();
    tauri.uninstall();
  }
});

test('hasTauriRuntime treats window.__TAURI_INTERNALS__ = undefined as non-Tauri runtime', async () => {
  const win = window as unknown as Record<string, unknown>;
  const hadOwn = Object.prototype.hasOwnProperty.call(win, '__TAURI_INTERNALS__');
  const prev = win.__TAURI_INTERNALS__;
  win.__TAURI_INTERNALS__ = undefined;

  const warnings: unknown[][] = [];
  const origWarn = console.warn;
  console.warn = (...args: unknown[]) => {
    warnings.push(args);
  };

  const emptyGeom: GeometryWithBounds = {
    geometry: new THREE.BufferGeometry(),
    bbox: new THREE.Box3(),
    center: new THREE.Vector3(),
    size: new THREE.Vector3(),
    flatteningPlanes: [],
  };
  let latest: UseIslandsReturn | null = null;
  let tree: Awaited<ReturnType<typeof renderWithProviders>> | null = null;

  try {
    tree = await renderWithProviders(
      <IslandsHarness
        input={{
          geom: emptyGeom,
          transform: makeTransform(1),
          layerHeightMm: 0.05,
          supportTips: [],
          plateZ: 0,
          modelId: 'undef-tauri',
          sourcePath: 'C:\\models\\empty.stl',
        }}
        onHook={(v) => {
          latest = v;
        }}
      />,
    );

    await act(async () => {
      await latest!.onRunScan();
    });
    assert.equal(
      warnings.some((args) => String(args[0]).includes('Sideloaded Rust scan failed')),
      false,
      'must not invoke Tauri APIs when window.__TAURI_INTERNALS__ is undefined',
    );
  } finally {
    console.warn = origWarn;
    await tree?.unmount();
    emptyGeom.geometry.dispose();
    if (hadOwn) win.__TAURI_INTERNALS__ = prev;
    else delete win.__TAURI_INTERNALS__;
  }
});

test('fallback stage_mesh_binary_set aborts before scan_overhangs_staged when superseded and filter prefers peakAreaMm2', async () => {
  let stageCall = 0;
  let resolveFallbackStage!: () => void;
  let overhangCalls = 0;
  const win = window as unknown as Record<string, unknown>;
  const prevInternals = win.__TAURI_INTERNALS__;
  const prevEventInternals = win.__TAURI_EVENT_PLUGIN_INTERNALS__;
  let nextCallbackId = 1;

  win.__TAURI_INTERNALS__ = {
    invoke: async (cmd: string) => {
      if (cmd === 'plugin:event|listen') return nextCallbackId;
      if (cmd === 'plugin:event|unlisten') return null;
      if (cmd === 'stage_mesh_binary_set') {
        stageCall += 1;
        if (stageCall === 2) {
          return new Promise<null>((resolve) => {
            resolveFallbackStage = () => resolve(null);
          });
        }
        return null;
      }
      if (cmd === 'scan_overhangs_staged') {
        overhangCalls += 1;
        return { regions: [], stability: null };
      }
      if (cmd === 'scan_islands_staged') {
        if (stageCall === 1) {
          throw new Error('force fallback on first scan');
        }
        return {
          voxelIslands: [
            {
              id: 'v-zero-peak',
              contact: { x: 0, y: 0, z: 1 },
              baseZ: 1,
              areaMm2: 1,
              peakAreaMm2: 0,
              maxAreaMm2: 1,
              isDetached: true,
              layerSpan: [1, 1],
            },
            {
              id: 'v-valid-peak',
              contact: { x: 2, y: 0, z: 1 },
              baseZ: 1,
              areaMm2: 0.005,
              peakAreaMm2: 0.005,
              maxAreaMm2: 0,
              isDetached: true,
              layerSpan: [1, 1],
            },
          ],
          minimaIslands: [],
          overhangIslands: [],
          stability: null,
        };
      }
      throw new Error(`Unexpected command: ${cmd}`);
    },
    transformCallback: () => nextCallbackId++,
    unregisterCallback: () => {},
  };
  win.__TAURI_EVENT_PLUGIN_INTERNALS__ = { unregisterListener: () => {} };

  const geom = createOutwardTetrahedronGeometry();
  let latest: UseIslandsReturn | null = null;
  let tree: Awaited<ReturnType<typeof renderWithProviders>> | null = null;

  try {
    tree = await renderWithProviders(
      <IslandsHarness
        input={{
          geom,
          transform: makeTransform(1),
          layerHeightMm: 0.05,
          supportTips: [],
          plateZ: 0,
          modelId: 'fallback-epoch-model',
          sourcePath: 'C:\\models\\tet.stl',
        }}
        onHook={(v) => {
          latest = v;
        }}
      />,
    );

    let firstScan!: Promise<void>;
    act(() => {
      firstScan = latest!.onRunScan();
    });
    await settle(25);
    assert.equal(stageCall, 2, 'first scan suspended inside fallback stage_mesh_binary_set');

    await act(async () => {
      await latest!.onRunScan();
    });
    assert.deepEqual(
      latest!.voxelIslands.map((v) => v.id),
      ['v-valid-peak'],
      'isDetached filter must prefer peakAreaMm2 over maxAreaMm2',
    );

    await act(async () => {
      resolveFallbackStage();
      await firstScan;
    });
    assert.equal(overhangCalls, 0, 'superseded fallback scan must abort before scan_overhangs_staged');
  } finally {
    await tree?.unmount();
    geom.geometry.dispose();
    if (prevInternals === undefined) delete win.__TAURI_INTERNALS__;
    else win.__TAURI_INTERNALS__ = prevInternals;
    if (prevEventInternals === undefined) delete win.__TAURI_EVENT_PLUGIN_INTERNALS__;
    else win.__TAURI_EVENT_PLUGIN_INTERNALS__ = prevEventInternals;
  }
});
