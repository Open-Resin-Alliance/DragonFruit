import assert from 'node:assert/strict';
import test from 'node:test';
import { act, StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import * as THREE from 'three';
import { I18nClientProvider } from '@/components/I18nClientProvider';
import { HotkeyProvider } from '@/hotkeys/HotkeyContext';
import type { GeometryWithBounds } from '@/hooks/useStlGeometry';
import { renderWithProviders, settle } from '@/utils/__tests__/helpers/renderDom';
import { disposeEventLoopChannel } from '@/utils/yieldToEventLoop';
import { useIslands, type UseIslandsInput, type UseIslandsReturn } from '@/volumeAnalysis/Islands/useIslands';

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
  uninstall: () => void;
}

type MockScanResult = {
  voxelIslands: Array<{
    id: string;
    contact: { x: number; y: number; z: number };
    baseZ: number;
    areaMm2: number;
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
  onScanStaged?: () => MockScanResult | Promise<MockScanResult>;
}): TauriCapture {
  const commands: string[] = [];
  const stagedPositions: Float32Array[] = [];
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
      if (cmd === 'scan_islands_staged' || cmd === 'scan_islands_from_path') {
        if (options?.onScanStaged) {
          return options.onScanStaged();
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

test('MIR-01 & MIR-06a: sourcePath + geom stages winding-corrected world soup and invokes scan_islands_staged', async () => {
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
    assert.ok(
      signedVolume(staged) > 0,
      `expected positive signed volume (outward normals) under det < 0, got ${signedVolume(staged)}`,
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
