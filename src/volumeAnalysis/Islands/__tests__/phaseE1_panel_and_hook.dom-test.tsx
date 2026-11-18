import assert from 'node:assert/strict';
import test, { after } from 'node:test';
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import * as THREE from 'three';

import { IslandsPanel } from '@/components/controls/IslandsPanel';
import type { GeometryWithBounds } from '@/hooks/useStlGeometry';
import { settle, withProviders } from '@/utils/__tests__/helpers/renderDom';
import { disposeEventLoopChannel } from '@/utils/yieldToEventLoop';
import { markerIdFor } from '@/volumeAnalysis/Islands/islandPuckMarkers';
import type { OverhangRegion } from '@/volumeAnalysis/Islands/types';
import { useIslands, type UseIslandsInput, type UseIslandsReturn } from '@/volumeAnalysis/Islands/useIslands';

after(() => disposeEventLoopChannel());

function createTetGeom(): GeometryWithBounds {
  const positions = new Float32Array([
    0, 0, 0, 0, 4, 0, 4, 0, 0,
    0, 0, 0, 0, 0, 4, 0, 4, 0,
    0, 0, 0, 4, 0, 0, 0, 0, 4,
    4, 0, 0, 0, 4, 0, 0, 0, 4,
  ]);
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.BufferAttribute(positions, 3));
  geometry.computeBoundingBox();
  const bbox = geometry.boundingBox!.clone();
  return {
    geometry,
    bbox,
    center: bbox.getCenter(new THREE.Vector3()),
    size: bbox.getSize(new THREE.Vector3()),
    flatteningPlanes: [],
  };
}

function makeTransform() {
  return {
    position: new THREE.Vector3(0, 0, 0),
    rotation: new THREE.Euler(0, 0, 0, 'ZYX'),
    scale: new THREE.Vector3(1, 1, 1),
  };
}

function makeOverhangRegion(
  originX: number,
  originY: number,
  gridSize: number,
  z: number,
  maxZ = z + 1,
): OverhangRegion {
  const pxMm = 0.25;
  const count = gridSize * gridSize;
  const data = new Array<number>(count).fill(1);
  const surfaceZ = new Array<number>(count).fill(z);
  const span = gridSize * pxMm;
  return {
    triangleIds: [0],
    areaMm2: span * span,
    projectedAreaMm2: span * span,
    angleDeg: 20,
    normal: [0, 0, -1],
    xyMin: [originX, originY],
    xyMax: [originX + span, originY + span],
    minZ: z,
    maxZ,
    footprint: {
      width: gridSize,
      height: gridSize,
      originX,
      originY,
      pxMm,
      data,
      surfaceZ,
    },
  };
}

interface MockNativeScanPayload {
  voxelIslands: Array<{
    id: string;
    contact: { x: number; y: number; z: number };
    baseZ: number;
    rawBaseZ?: number;
    areaMm2: number;
    peakAreaMm2?: number;
    isDetached?: boolean;
    layerSpan: [number, number];
    contactVoxels?: number[];
  }>;
  minimaIslands: Array<{ position: { x: number; y: number; z: number } }>;
  overhangIslands: OverhangRegion[];
  stability: null;
}

function installScanMock(payload: MockNativeScanPayload) {
  const win = window as unknown as Record<string, unknown>;
  const prevInternals = win.__TAURI_INTERNALS__;
  const prevEventInternals = win.__TAURI_EVENT_PLUGIN_INTERNALS__;
  let nextCallbackId = 1;

  win.__TAURI_INTERNALS__ = {
    invoke: async (cmd: string) => {
      if (cmd === 'plugin:event|listen') return nextCallbackId;
      if (cmd === 'plugin:event|unlisten') return null;
      if (cmd === 'stage_mesh_binary_set') return null;
      if (cmd === 'scan_islands_staged') return payload;
      throw new Error(`Unexpected Tauri command: ${cmd}`);
    },
    transformCallback: () => nextCallbackId++,
    unregisterCallback: () => {},
  };
  win.__TAURI_EVENT_PLUGIN_INTERNALS__ = {
    unregisterListener: () => {},
  };

  return () => {
    if (prevInternals === undefined) delete win.__TAURI_INTERNALS__;
    else win.__TAURI_INTERNALS__ = prevInternals;
    if (prevEventInternals === undefined) delete win.__TAURI_EVENT_PLUGIN_INTERNALS__;
    else win.__TAURI_EVENT_PLUGIN_INTERNALS__ = prevEventInternals;
  };
}

function PanelAndHookHarness({
  input,
  onHook,
}: {
  input: UseIslandsInput;
  onHook: (value: UseIslandsReturn) => void;
}) {
  const islands = useIslands(input);
  onHook(islands);
  return <IslandsPanel islands={islands} hasGeometry={true} />;
}

async function mountHarness(initialInput: UseIslandsInput) {
  const container = document.createElement('div');
  document.body.appendChild(container);
  const root = createRoot(container);
  let latest: UseIslandsReturn | null = null;

  const renderInput = async (input: UseIslandsInput) => {
    await act(async () => {
      root.render(
        withProviders(
          <PanelAndHookHarness
            input={input}
            onHook={(v) => {
              latest = v;
            }}
          />,
        ),
      );
    });
  };

  await renderInput(initialInput);

  return {
    container,
    getHook: () => latest!,
    renderInput,
    unmount: async () => {
      await act(async () => {
        root.unmount();
      });
      container.remove();
    },
  };
}

function readBreakdownCell(container: HTMLElement, labelText: string): string {
  const spans = Array.from(container.querySelectorAll('span'));
  const label = spans.find((s) => s.textContent?.trim() === labelText);
  assert.ok(label, `expected breakdown label "${labelText}"`);
  const valueEl = label.parentElement?.nextElementSibling;
  assert.ok(valueEl, `expected breakdown value sibling for "${labelText}"`);
  return valueEl.textContent?.replace(/\s+/g, '') ?? '';
}

function readStepperText(container: HTMLElement): string {
  const prevBtn = container.querySelector('button[title="Previous (B)"]');
  assert.ok(prevBtn, 'expected Previous (B) stepper button');
  const counterEl = prevBtn.nextElementSibling;
  assert.ok(counterEl, 'expected stepper counter element');
  const spans = Array.from(counterEl.querySelectorAll('span'));
  return spans.map((s) => s.textContent?.trim() ?? '').join(' ').replace(/\s+/g, ' ').trim();
}

test('1: overhang-only scan emits zero pucks, zero orderedIslands, and keeps hasData true in IslandsPanel', async () => {
  const uninstall = installScanMock({
    voxelIslands: [],
    minimaIslands: [],
    overhangIslands: [
      makeOverhangRegion(0, 0, 8, 5.0),
      makeOverhangRegion(10, 10, 8, 8.0),
    ],
    stability: null,
  });
  const geom = createTetGeom();
  const harness = await mountHarness({
    geom,
    transform: makeTransform(),
    layerHeightMm: 0.05,
    supportTips: [],
    plateZ: 0,
    modelId: 'oh-only',
    sourcePath: 'C:\\models\\oh.stl',
  });

  try {
    await act(async () => {
      await harness.getHook().onRunScan();
    });
    await settle(20);

    const h = harness.getHook();
    assert.equal(h.overhangIslands.length, 2);
    assert.equal(h.tableStats.overhangTotal, 2);
    assert.equal(h.tableStats.overhangUnsupported, 2);
    assert.equal(h.tableStats.allTotal, 0);
    assert.equal(h.tableStats.allUnsupported, 0);
    assert.equal(h.orderedIslands.length, 0);
    assert.equal(h.byMarkerId.size, 0);
    assert.equal(h.islandInstances.count, 0, 'overhang regions must NOT emit type 0 pale-blue pucks');
    assert.equal(h.islandMarkers.length, 0);

    assert.equal(
      harness.container.textContent?.includes('Scan the model to detect unsupported islands'),
      false,
      'overhang-only scan must keep hasData true and show breakdown',
    );
    assert.equal(readBreakdownCell(harness.container, 'Voxels'), '0');
    assert.equal(readBreakdownCell(harness.container, 'Minima'), '0');
    assert.equal(readBreakdownCell(harness.container, 'Coincident'), '0');

    // Toggling showOverhangs false still preserves overhangTotal so hasData remains true
    await act(async () => {
      h.setShowOverhangs(false);
    });
    assert.equal(harness.getHook().tableStats.overhangTotal, 2);
    assert.equal(
      harness.container.textContent?.includes('Scan the model to detect unsupported islands'),
      false,
    );
  } finally {
    await harness.unmount();
    geom.geometry.dispose();
    uninstall();
  }
});

test('2: toggling showOverhangs false restores CantileverFringe voxel islands while keeping structuralIslands unchanged', async () => {
  const uninstall = installScanMock({
    voxelIslands: [
      {
        id: 'v0',
        contact: { x: 1, y: 1, z: 5.0 },
        baseZ: 5.0,
        areaMm2: 0.5,
        isDetached: false,
        layerSpan: [100, 102],
        contactVoxels: [1, 1, 1.05, 1],
      },
      {
        id: 'v1',
        contact: { x: 20, y: 20, z: 8.0 },
        baseZ: 8.0,
        areaMm2: 0.4,
        isDetached: false,
        layerSpan: [160, 162],
        contactVoxels: [20, 20],
      },
    ],
    minimaIslands: [],
    overhangIslands: [makeOverhangRegion(0, 0, 16, 5.0)],
    stability: null,
  });
  const geom = createTetGeom();
  const harness = await mountHarness({
    geom,
    transform: makeTransform(),
    layerHeightMm: 0.05,
    supportTips: [],
    plateZ: 0,
    modelId: 'oh-toggle',
    sourcePath: 'C:\\models\\oh-toggle.stl',
  });

  try {
    await act(async () => {
      await harness.getHook().onRunScan();
    });
    await settle(20);

    const before = harness.getHook();
    assert.deepEqual(before.orderedIslands.map((i) => i.id), ['v1']);
    assert.equal(before.tableStats.voxelTotal, 1);
    assert.equal(before.tableStats.overhangTotal, 1);
    const instancesBefore = before.islandInstances.count;
    assert.equal(instancesBefore, 1);
    const structuralIdsBefore = before.structuralIslands.map((i) => i.id);
    assert.deepEqual(structuralIdsBefore, ['v1', 'o0']);

    await act(async () => {
      before.setShowOverhangs(false);
    });
    await settle(10);

    const afterToggle = harness.getHook();
    assert.deepEqual(afterToggle.orderedIslands.map((i) => i.id), ['v0', 'v1']);
    assert.equal(afterToggle.tableStats.voxelTotal, 2);
    assert.equal(afterToggle.tableStats.voxelUnsupported, 2);
    assert.equal(afterToggle.tableStats.allUnsupported, 2);
    assert.equal(afterToggle.tableStats.overhangTotal, 1);
    assert.ok(afterToggle.islandInstances.count > instancesBefore, 'restored CantileverFringe adds 3D instances');
    assert.deepEqual(
      afterToggle.structuralIslands.map((i) => i.id),
      structuralIdsBefore,
      'structuralIslands must remain unaffected by showOverhangs = false',
    );
  } finally {
    await harness.unmount();
    geom.geometry.dispose();
    uninstall();
  }
});

test('3: stepper uses selectedIndex+1, breakdown shows live unsupported/{total}, and byMarkerId/orderedIslands/tableStats stay consistent', async () => {
  const uninstall = installScanMock({
    voxelIslands: [
      {
        id: 'v47',
        contact: { x: 0, y: 0, z: 1.0 },
        baseZ: 1.0,
        areaMm2: 0.04,
        isDetached: true,
        layerSpan: [20, 22],
        contactVoxels: [0, 0],
      },
      {
        id: 'v12',
        contact: { x: 5, y: 0, z: 3.0 },
        baseZ: 3.0,
        areaMm2: 6.0, // > 0.5 mm² -> needs 2 supports at areaPerSupport=4.0
        isDetached: true,
        layerSpan: [60, 62],
        contactVoxels: [5, 0, 6, 0],
      },
      {
        id: 'v5',
        contact: { x: 10, y: 0, z: 7.0 },
        baseZ: 7.0,
        areaMm2: 0.3,
        isDetached: true,
        layerSpan: [140, 142],
        contactVoxels: [10, 0],
      },
    ],
    minimaIslands: [
      { position: { x: 10, y: 0, z: 7.0 } },
      { position: { x: 15, y: 0, z: 9.0 } },
    ],
    overhangIslands: [],
    stability: null,
  });
  const geom = createTetGeom();
  const baseInput: UseIslandsInput = {
    geom,
    transform: makeTransform(),
    layerHeightMm: 0.05,
    supportTips: [],
    plateZ: 0,
    modelId: 'ux-counts',
    sourcePath: 'C:\\models\\ux.stl',
  };
  const harness = await mountHarness(baseInput);

  try {
    await act(async () => {
      await harness.getHook().onRunScan();
    });
    await settle(20);

    const h0 = harness.getHook();
    assert.deepEqual(h0.orderedIslands.map((i) => i.id), ['v47', 'v12', 'v5', 'm1']);
    assert.equal(h0.orderedIslands[0].supportCount, 0, 'orderedIslands[0] preserves post-annotation supportCount');
    assert.equal(h0.orderedIslands[0].supported, false, 'orderedIslands[0] preserves post-annotation supported');
    assert.equal(h0.orderedIslands[0].grounded, false, 'orderedIslands[0] preserves post-annotation grounded');
    assert.equal(h0.tableStats.allTotal, 4);
    assert.equal(h0.tableStats.allUnsupported, 4);
    assert.equal(h0.byMarkerId.size, 4);
    assert.equal(h0.orderedIslands.length, 4);

    assert.equal(readBreakdownCell(harness.container, 'Voxels'), '2');
    assert.equal(readBreakdownCell(harness.container, 'Minima'), '1');
    assert.equal(readBreakdownCell(harness.container, 'Coincident'), '1');
    assert.equal(readStepperText(harness.container), '4');

    const nextBtn = harness.container.querySelector('button[title="Next (N)"]') as HTMLButtonElement;
    assert.ok(nextBtn);
    await act(async () => {
      nextBtn.click();
    });
    assert.equal(harness.getHook().selectedMarkerId, 47);
    assert.equal(readStepperText(harness.container), '1 / 4', 'must render selectedIndex + 1, not raw ID 47');

    await act(async () => {
      nextBtn.click();
    });
    assert.equal(harness.getHook().selectedMarkerId, 12);
    assert.equal(readStepperText(harness.container), '2 / 4', 'must render selectedIndex + 1, not raw ID 12');

    // Support v47 (<= 0.5 mm² -> fully hidden)
    const tipV47 = new THREE.Vector3(0, 0, 1.0);
    await harness.renderInput({ ...baseInput, supportTips: [tipV47] });
    const h1 = harness.getHook();
    assert.equal(h1.tableStats.voxelUnsupported, 1);
    assert.equal(h1.tableStats.voxelTotal, 2);
    assert.equal(h1.tableStats.allUnsupported, 3);
    assert.equal(h1.orderedIslands.length, 3);
    assert.equal(h1.byMarkerId.size, 3);
    assert.equal(readBreakdownCell(harness.container, 'Voxels'), '1/2');

    // 1st support on v12 (6.0 mm² > 0.5 -> still effectively unsupported!)
    const tipV12a = new THREE.Vector3(5, 0, 3.0);
    await harness.renderInput({ ...baseInput, supportTips: [tipV47, tipV12a] });
    const h2 = harness.getHook();
    assert.equal(h2.tableStats.voxelUnsupported, 1, '1 support on 6.0 mm² island must still count as unsupported');
    assert.equal(h2.tableStats.allUnsupported, 3);
    assert.equal(h2.orderedIslands.length, 3);
    assert.equal(h2.byMarkerId.size, 3);
    assert.equal(h2.orderedIslands[0].id, 'v12');
    assert.equal(h2.orderedIslands[0].supportCount, 1);
    assert.equal(h2.orderedIslands[0].supported, true);
    assert.equal(h2.orderedIslands[0].fullySupported, false);
    assert.equal(h2.orderedIslands[0].grounded, false);

    // 2nd support on v12 -> now fullySupported
    const tipV12b = new THREE.Vector3(6, 0, 3.0);
    await harness.renderInput({ ...baseInput, supportTips: [tipV47, tipV12a, tipV12b] });
    const h3 = harness.getHook();
    assert.equal(h3.tableStats.voxelUnsupported, 0);
    assert.equal(h3.tableStats.allUnsupported, 2);
    assert.equal(h3.orderedIslands.length, 2);
    assert.equal(h3.byMarkerId.size, 2);
    assert.equal(readBreakdownCell(harness.container, 'Voxels'), '0/2');

    // showAlreadySupported = true keeps byMarkerId.size === orderedIslands.length === 4 while tableStats.allUnsupported stays 2
    await act(async () => {
      h3.setFilterToggles({ ...h3.filterToggles, showAlreadySupported: true });
    });
    const hShowSup = harness.getHook();
    assert.equal(hShowSup.orderedIslands.length, 4);
    assert.equal(hShowSup.byMarkerId.size, 4);
    assert.equal(hShowSup.tableStats.allUnsupported, 2);

    // Back to default showAlreadySupported = false, test consolidateVoxel + removeSupportedAreaClusters
    await act(async () => {
      hShowSup.setFilterToggles({ showAlreadySupported: false, showPlateContact: false });
      hShowSup.setConsolidateVoxel(true);
      hShowSup.setRemoveSupportedAreaClusters(false);
    });
    const hConsKeep = harness.getHook();
    // v12 (6.0 mm²) and v5 (0.3 mm²) are contoured (>= 0.06 mm²), v12 is supported so retained while !removeSupportedAreaClusters
    assert.equal(hConsKeep.orderedIslands.length, 3);
    assert.equal(hConsKeep.byMarkerId.size, 3);

    await act(async () => {
      hConsKeep.setRemoveSupportedAreaClusters(true);
    });
    const hConsRemove = harness.getHook();
    assert.equal(hConsRemove.orderedIslands.length, 2);
    assert.equal(hConsRemove.byMarkerId.size, 2);
    assert.equal(hConsRemove.tableStats.allUnsupported, 2);

    // Individual layer toggles preserve byMarkerId.size === orderedIslands.length
    await act(async () => {
      hConsRemove.setShowMinimaOnly(false);
    });
    assert.equal(harness.getHook().orderedIslands.length, 1);
    assert.equal(harness.getHook().byMarkerId.size, 1);

    await act(async () => {
      harness.getHook().setShowIntersection(false);
    });
    assert.equal(harness.getHook().orderedIslands.length, 0);
    assert.equal(harness.getHook().byMarkerId.size, 0);

    await act(async () => {
      harness.getHook().setShowVoxelOnly(false);
      harness.getHook().setShowMinimaOnly(true);
      harness.getHook().setShowIntersection(true);
    });
    assert.equal(harness.getHook().orderedIslands.length, 2);
    assert.equal(harness.getHook().byMarkerId.size, 2);
  } finally {
    await harness.unmount();
    geom.geometry.dispose();
    uninstall();
  }
});

test('4 & 5: contoured/consolidated intersection pins + spaced subApexes + marker dedup + structuralIslands invariance + no Reduce intersections UI', async () => {
  const uninstall = installScanMock({
    voxelIslands: [
      {
        id: 'v0',
        contact: { x: 0, y: 0, z: 5.0 },
        baseZ: 5.0,
        areaMm2: 1.0, // >= 0.06 so contoured; <= 4.0 so 1 support makes it fullySupported
        isDetached: true,
        layerSpan: [100, 102],
        contactVoxels: [0, 0, 0.5, 0, 1.0, 0, 1.5, 0, 2.0, 0, 2.5, 0],
      },
      {
        id: 'v1',
        contact: { x: 20, y: 20, z: 6.0 },
        baseZ: 6.0,
        areaMm2: 0.2,
        isDetached: true,
        layerSpan: [120, 122],
        contactVoxels: [20, 20],
      },
      {
        id: 'v2',
        contact: { x: 20.1, y: 20.1, z: 6.0 },
        baseZ: 6.0,
        areaMm2: 0.2,
        isDetached: true,
        layerSpan: [120, 122],
        contactVoxels: [20.1, 20.1],
      },
      {
        id: 'v3',
        contact: { x: 41, y: 41, z: 6.0 },
        baseZ: 6.0,
        areaMm2: 0.3,
        isDetached: false, // CantileverFringe covered by o0
        layerSpan: [120, 122],
        contactVoxels: [41, 41],
      },
    ],
    minimaIslands: [
      { position: { x: 0, y: 0, z: 5.0 } },   // primary match on v0
      { position: { x: 0.4, y: 0, z: 5.0 } }, // < 0.8 mm from primary -> filtered out
      { position: { x: 1.5, y: 0, z: 5.0 } }, // >= 0.8 mm from primary -> spaced pin 1
      { position: { x: 1.9, y: 0, z: 5.0 } }, // < 0.8 mm from pin 1 -> filtered out
      { position: { x: 2.6, y: 0, z: 5.0 } }, // >= 0.8 mm from pin 1 -> spaced pin 2
    ],
    overhangIslands: [makeOverhangRegion(40, 40, 16, 6.0)],
    stability: null,
  });
  const geom = createTetGeom();
  const baseInput: UseIslandsInput = {
    geom,
    transform: makeTransform(),
    layerHeightMm: 0.05,
    supportTips: [],
    plateZ: 0,
    modelId: 'pins-and-structural',
    sourcePath: 'C:\\models\\pins.stl',
  };
  const harness = await mountHarness(baseInput);

  try {
    await act(async () => {
      await harness.getHook().onRunScan();
    });
    await settle(20);

    const baselineStructuralIds = harness.getHook().structuralIslands.map((i) => i.id);
    assert.deepEqual(baselineStructuralIds, ['v0', 'v1', 'v2', 'm0', 'm1', 'm2', 'm3', 'm4', 'o0']);

    // Before adding supports: structuralIslands must ignore consolidateVoxel, showOverhangs, showVoxelOnly, showAlreadySupported
    await act(async () => {
      const hToggle = harness.getHook();
      hToggle.setConsolidateVoxel(true);
      hToggle.setShowOverhangs(false);
      hToggle.setShowVoxelOnly(false);
      hToggle.setFilterToggles({ showAlreadySupported: true, showPlateContact: false });
    });
    await settle(10);
    assert.deepEqual(
      harness.getHook().structuralIslands.map((i) => i.id),
      baselineStructuralIds,
      'structuralIslands must remain identical across UI display/cluster/overhang/filter toggles',
    );

    // Restore visibility toggles, support v0, and keep consolidateVoxel=true & removeSupportedAreaClusters=false
    await harness.renderInput({
      ...baseInput,
      supportTips: [new THREE.Vector3(0, 0, 5.0)],
    });
    await act(async () => {
      const h = harness.getHook();
      h.setShowOverhangs(true);
      h.setShowVoxelOnly(true);
      h.setFilterToggles({ showAlreadySupported: false, showPlateContact: false });
      h.setConsolidateVoxel(true);
      h.setRemoveSupportedAreaClusters(false);
    });
    await settle(10);

    const h = harness.getHook();
    const v0MarkerId = markerIdFor({
      id: 'v0',
      source: 'voxel',
      contact: new THREE.Vector3(0, 0, 5),
      baseZ: 5,
    });
    const v0Pins: Array<{ x: number; y: number; z: number; type: number }> = [];
    let v0Type3Count = 0;
    for (let i = 0; i < h.islandInstances.count; i++) {
      const mId = h.islandInstances.meta[i * 2];
      const typ = h.islandInstances.meta[i * 2 + 1];
      if (mId === v0MarkerId) {
        if (typ === 2) {
          v0Pins.push({
            x: h.islandInstances.centerRadius[i * 4],
            y: h.islandInstances.centerRadius[i * 4 + 1],
            z: h.islandInstances.centerRadius[i * 4 + 2],
            type: typ,
          });
        } else if (typ === 3) {
          v0Type3Count++;
        }
      }
    }

    assert.equal(v0Type3Count, 6, 'consolidated/contoured v0 keeps its 6 type 3 footprint instances');
    assert.equal(v0Pins.length, 3, 'keeps primary type 2 pin + 2 >=0.8mm-spaced subApex type 2 pins even when supported');
    assert.ok(Math.abs(v0Pins[0].x - 0) < 1e-4);
    assert.ok(Math.abs(v0Pins[1].x - 1.5) < 1e-4);
    assert.ok(Math.abs(v0Pins[2].x - 2.6) < 1e-4);
    assert.equal(h.islandInstances.layerHeightMm, 0.05, 'layerHeightMm passed through to buildIslandInstances');

    // islandMarkers must deduplicate by markerId so CameraFocusController gets 1 marker at primary contact
    const v0Markers = h.islandMarkers.filter((m) => m.id === v0MarkerId);
    assert.equal(v0Markers.length, 1);
    assert.ok(Math.abs(v0Markers[0].centerX - 0) < 1e-4);
    assert.equal(h.islandMarkers.length, h.orderedIslands.length);

    // structuralIslands must still filter out supported v0/m0 even when showAlreadySupported=true
    await act(async () => {
      const cur = harness.getHook();
      cur.setShowOverhangs(false);
      cur.setShowVoxelOnly(false);
      cur.setFilterToggles({ showAlreadySupported: true, showPlateContact: false });
    });
    await settle(10);

    const hAfter = harness.getHook();
    assert.deepEqual(
      hAfter.structuralIslands.map((i) => i.id),
      ['v1', 'v2', 'm1', 'm2', 'm3', 'm4', 'o0'],
      'structuralIslands ignores UI toggles and filters out supported v0/m0 via DEFAULT_FILTER_TOGGLES',
    );

    // Scenario 5: Open Settings modal and confirm "Reduce intersections" is gone
    const settingsBtn = Array.from(harness.container.querySelectorAll('button')).find(
      (b) => b.getAttribute('title') === 'Scan settings',
    );
    assert.ok(settingsBtn, 'expected Scan settings button');
    await act(async () => {
      settingsBtn.click();
    });
    await settle(10);

    const dialog = document.body.querySelector('[role="dialog"]');
    assert.ok(dialog, 'expected Scan Settings dialog');
    assert.equal(
      dialog.textContent?.includes('Reduce intersections'),
      false,
      'dead Reduce intersections UI must be removed from IslandsPanel',
    );
    assert.equal(dialog.textContent?.includes('Consolidate'), true);
    assert.equal(dialog.textContent?.includes('Contoured regions'), true);
    assert.equal(dialog.textContent?.includes('Remove supported clusters'), true);
  } finally {
    await harness.unmount();
    geom.geometry.dispose();
    uninstall();
  }
});

test('6: orderedIslands keeps post-annotation flags, showPlateContact/showVoxelOnly keep 1:1 sync, and footprints draw before all pins', async () => {
  const uninstall = installScanMock({
    voxelIslands: [
      {
        id: 'v99',
        contact: { x: 30, y: 0, z: 0.0 },
        baseZ: 0.0,
        areaMm2: 0.2,
        isDetached: true,
        layerSpan: [0, 1],
        contactVoxels: [30, 0],
      },
      {
        id: 'v0',
        contact: { x: 0, y: 0, z: 5.0 },
        baseZ: 5.0,
        areaMm2: 1.0,
        isDetached: true,
        layerSpan: [100, 102],
        contactVoxels: [0, 0, 0.5, 0, 1.5, 0],
      },
      {
        id: 'v1',
        contact: { x: 10, y: 0, z: 6.0 },
        baseZ: 6.0,
        areaMm2: 0.5,
        isDetached: true,
        layerSpan: [120, 122],
        contactVoxels: [10, 0, 10.5, 0],
      },
      {
        id: 'v2',
        contact: { x: 20, y: 0, z: 7.0 },
        baseZ: 7.0,
        areaMm2: 0.2,
        isDetached: true,
        layerSpan: [140, 142],
        contactVoxels: [20, 0],
      },
    ],
    minimaIslands: [
      { position: { x: 0, y: 0, z: 5.0 } },
      { position: { x: 1.5, y: 0, z: 5.0 } },
      { position: { x: 10, y: 0, z: 6.0 } },
      { position: { x: 25, y: 0, z: 8.0 } },
    ],
    overhangIslands: [],
    stability: null,
  });
  const geom = createTetGeom();
  const harness = await mountHarness({
    geom,
    transform: makeTransform(),
    layerHeightMm: 0.05,
    supportTips: [],
    plateZ: 0,
    modelId: 'draw-order-and-sync',
    sourcePath: 'C:\\models\\draw-order.stl',
  });

  try {
    await act(async () => {
      await harness.getHook().onRunScan();
    });
    await settle(20);

    const h = harness.getHook();
    assert.deepEqual(h.orderedIslands.map((i) => i.id), ['v0', 'v1', 'v2', 'm3']);
    assert.equal(h.byMarkerId.size, h.orderedIslands.length);
    assert.equal(h.orderedIslands[0].supportCount, 0);
    assert.equal(h.orderedIslands[0].supported, false);
    assert.equal(h.orderedIslands[0].grounded, false);

    // Every footprint (type 0 or 3) must precede every pin/minima (type 1 or 2) in islandInstances.meta.
    const types: number[] = [];
    for (let i = 0; i < h.islandInstances.count; i++) {
      types.push(h.islandInstances.meta[i * 2 + 1]);
    }
    const firstPinIdx = types.findIndex((t) => t === 1 || t === 2);
    assert.ok(firstPinIdx > 0, 'expected both footprints and pins in islandInstances');
    assert.equal(
      types.slice(0, firstPinIdx).every((t) => t === 0 || t === 3),
      true,
      'leading instances must all be footprints (type 0 or 3)',
    );
    assert.equal(
      types.slice(firstPinIdx).every((t) => t === 1 || t === 2),
      true,
      `all pins (type 1 or 2) must follow all footprints, got meta types [${types.join(',')}]`,
    );
    assert.equal(types.includes(1) && types.includes(2), true, 'includes both minima type 1 and intersection type 2 pins');

    // showPlateContact = true keeps byMarkerId.size === orderedIslands.length and preserves grounded annotation
    await act(async () => {
      h.setFilterToggles({ showAlreadySupported: false, showPlateContact: true });
    });
    await settle(10);
    const hPlate = harness.getHook();
    assert.equal(hPlate.orderedIslands.length, 5);
    assert.equal(hPlate.byMarkerId.size, hPlate.orderedIslands.length);
    assert.equal(hPlate.orderedIslands[0].id, 'v99');
    assert.equal(hPlate.orderedIslands[0].grounded, true);
    assert.equal(hPlate.orderedIslands[0].supportCount, 0);

    // showVoxelOnly = false && showIntersection = true preserves 1:1 sync and primary contact in islandMarkers
    await act(async () => {
      hPlate.setFilterToggles({ showAlreadySupported: false, showPlateContact: false });
      hPlate.setShowVoxelOnly(false);
      hPlate.setShowIntersection(true);
    });
    await settle(10);
    const hPinsOnly = harness.getHook();
    assert.deepEqual(hPinsOnly.orderedIslands.map((i) => i.id), ['v0', 'v1', 'm3']);
    assert.equal(hPinsOnly.byMarkerId.size, hPinsOnly.orderedIslands.length);
    assert.equal(hPinsOnly.islandMarkers.length, hPinsOnly.orderedIslands.length);

    const v0MarkerId = markerIdFor({
      id: 'v0',
      source: 'voxel',
      contact: new THREE.Vector3(0, 0, 5),
      baseZ: 5,
    });
    const v0Marker = hPinsOnly.islandMarkers.find((m) => m.id === v0MarkerId);
    assert.ok(v0Marker, 'expected primary islandMarker for intersection v0');
    assert.equal(v0Marker.type, 2);
    assert.ok(Math.abs(v0Marker.centerX - 0) < 1e-4);
    assert.ok(Math.abs(v0Marker.centerY - 0) < 1e-4);
    assert.ok(Math.abs(v0Marker.baseZ - 5.0) < 1e-4);
  } finally {
    await harness.unmount();
    geom.geometry.dispose();
    uninstall();
  }
});
