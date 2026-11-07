import assert from 'node:assert/strict';
import test from 'node:test';
import { act, useEffect, useState, type Dispatch, type SetStateAction } from 'react';
import { addMaterialProfile, addPrinterProfile, setActiveMaterialProfile, setActivePrinterProfile } from '@/features/profiles/profileStore';
import { clearPreparedGeometryCacheForModel } from '@/features/mesh-modifiers/prepareModelGeometry';
import { deleteStoredMeshModifiers, storeModelMeshModifiers } from '@/features/mesh-modifiers/meshModifierStore';
import { getSnapshot, setSnapshot } from '@/supports/state';
import { createEmptySupportCollections } from '@/supports/supportTypeRegistry';
import { getRaftSettings, setRaftSettings, updateRaftSettings } from '@/supports/Rafts/Crenelated/RaftState';
import { installFakeMeshChunkUpload } from '@/utils/__tests__/helpers/fakeMeshChunkUpload';
import { renderWithProviders, settle } from '@/utils/__tests__/helpers/renderDom';
import { cubeModel } from './helpers/captureAppSliceJob';
import { readSliceMeshWarmupContext } from '../sliceInputContext';
import { prewarmSliceMesh } from '../sliceMeshSnapshot';
import { runSliceExportOrchestrator } from '../sliceExportOrchestrator';
import { cancelSliceMeshWarmup } from '../useSliceMeshWarmup';
import { useSceneSliceMeshWarmup, type SceneSliceMeshWarmupOptions } from '../useSceneSliceMeshWarmup';

async function waitFor(condition: () => boolean, label: string) {
  const deadline = Date.now() + 10_000;
  while (!condition()) {
    assert.ok(Date.now() < deadline, `timed out waiting for ${label}`);
    await settle(10);
  }
}

// Mount only the scene coordinator, never ExportPanelStack or SlicingPanel.
// This crosses real modifier preparation, mesh assembly, worker hashing and export startup;
// only native IPC is faked, and the slicer throws before doing any rendered work.
test('finalized import warms while editing and first Slice restores without preparing again', async () => {
  const printerId = addPrinterProfile({
    name: 'Scene warmup printer',
    buildVolumeMm: { width: 20, depth: 20, height: 20 },
    display: { resolutionX: 64, resolutionY: 64, outputFormat: '.ctb' },
  });
  const materialId = addMaterialProfile(printerId, { name: 'Scene warmup material', layerHeightMm: 0.05 });
  setActivePrinterProfile(printerId);
  setActiveMaterialProfile(materialId);
  const previousSupports = getSnapshot();
  const previousRaft = getRaftSettings();
  setSnapshot({ ...previousSupports, ...createEmptySupportCollections() });
  updateRaftSettings({ bottomMode: 'off' });

  const first = cubeModel('scene-import-warm-first', 2);
  const second = cubeModel('scene-import-warm-second', 2);
  second.transform.position.x += 3;
  const position = first.geometry.geometry.getAttribute('position');
  const originalGetX = position.getX.bind(position);
  let vertexReads = 0;
  position.getX = (index: number) => { vertexReads += 1; return originalGetX(index); };
  storeModelMeshModifiers(first.id, { hollowing: {
    enabled: true, bakedIntoGeometry: false, mode: 'cavity',
    voxelSizeMm: 0.5, shellThicknessMm: 0.4, openFace: 'z_max',
    sourcePositionsBase64: Buffer.from(position.array.buffer).toString('base64'),
    sourcePositionCount: position.count,
  } });
  let hollowCalls = 0;
  let slices = 0;
  const reachedSlicer = new Error('captured scene warmup slice');
  const upload = installFakeMeshChunkUpload(async (command) => {
    switch (command) {
      case 'mesh_hollow_staged':
        hollowCalls += 1;
        upload.replaceStaged(new Uint8Array(position.array.buffer));
        return JSON.stringify({ removedVoxels: 1 });
      case 'mesh_repair_read_positions': return upload.readStaged();
      case 'mesh_hollow_staged_read_cavity_positions': return new Uint8Array(0);
      case 'plugin:event|listen': return 1;
      case 'plugin:event|unlisten': return;
      case 'cancel_slicing': return;
      case 'slice_solid_native_to_temp_path': slices += 1; throw reachedSlicer;
      default: throw new Error(`Unexpected operation during scene warmup: ${command}`);
    }
  });
  const internals = Object.getOwnPropertyDescriptor(window, '__TAURI_INTERNALS__');
  const eventInternals = Object.getOwnPropertyDescriptor(window, '__TAURI_EVENT_PLUGIN_INTERNALS__');
  Object.defineProperty(window, '__TAURI_INTERNALS__', {
    configurable: true, value: { invoke: upload.invoke, transformCallback: () => 1 },
  });
  Object.defineProperty(window, '__TAURI_EVENT_PLUGIN_INTERNALS__', {
    configurable: true, value: { unregisterListener: () => {} },
  });

  const frame = { id: 'import-bed', index: 0, dxMm: 0, dyMm: 0, minX: -10, minY: -10, maxX: 10, maxY: 10 };
  const initial: SceneSliceMeshWarmupOptions = {
    models: [], plateFrames: [frame], activePlateId: frame.id,
    excludedModelIds: [], exportMode: false, ready: false,
  };
  let updateScene!: Dispatch<SetStateAction<SceneSliceMeshWarmupOptions>>;
  function SceneRoot() {
    const [scene, setScene] = useState(initial);
    useEffect(() => { updateScene = setScene; }, []);
    useSceneSliceMeshWarmup(scene);
    return null;
  }
  const tree = await renderWithProviders(<SceneRoot />);
  const models = [first, second];
  const options = () => {
    const context = readSliceMeshWarmupContext();
    assert.ok(context);
    return {
      models, printerProfile: context.printerProfile, materialProfile: context.materialProfile,
      antiAliasing: context.antiAliasing,
      plateVolumeBoundsMm: { minX: frame.minX, minY: frame.minY, maxX: frame.maxX, maxY: frame.maxY },
      plateOffsetMm: { dxMm: frame.dxMm, dyMm: frame.dyMm },
    };
  };
  try {
    await act(async () => { updateScene((scene) => ({ ...scene, models: [first] })); });
    await settle(30);
    await act(async () => { updateScene((scene) => ({ ...scene, models })); });
    await act(async () => { setSnapshot({ ...getSnapshot(), roots: {} }); });
    await settle(30);
    assert.equal(upload.readStats().uploadBegins, 0, 'partial batches and deferred support changes stay gated');
    assert.equal(hollowCalls, 0, 'import is not blocked by background modifier preparation');

    await act(async () => { updateScene((scene) => ({ ...scene, ready: true })); });
    await waitFor(() => upload.readStats().uploadBegins > 0, 'scene-owned idle preparation');
    await prewarmSliceMesh(options()); // Joins the idle producer only after it has started.
    assert.equal(hollowCalls, 1);
    assert.equal(slices, 0, 'editing-time warmup never starts slicing');
    const warmed = upload.readStats();
    const reads = vertexReads;
    await assert.rejects(runSliceExportOrchestrator({ ...options(), filenameBase: 'first-import-slice', outputMode: 'return' }), reachedSlicer);
    assert.equal(hollowCalls, 1, 'first Slice does not rebake');
    assert.equal(vertexReads, reads, 'first Slice does not reassemble world geometry');
    assert.equal(upload.readStats().workerStarts, warmed.workerStarts, 'first Slice does not start a hash worker');
    assert.equal(upload.readStats().uploadBegins, warmed.uploadBegins, 'first Slice does not upload');
    assert.equal(upload.readStats().restoreCalls, warmed.restoreCalls + 1);

    await act(async () => { updateScene((scene) => ({ ...scene, exportMode: true })); });
    await act(async () => { updateScene((scene) => ({ ...scene, exportMode: false })); });
    await settle(800);
    assert.equal(upload.readStats().uploadBegins, warmed.uploadBegins, 'workspace changes do not remount a second producer');

    cancelSliceMeshWarmup();
    await act(async () => { updateScene((scene) => ({ ...scene, ready: false })); });
    await act(async () => { updateScene((scene) => ({ ...scene, ready: true })); });
    await settle(800);
    assert.equal(upload.readStats().uploadBegins, warmed.uploadBegins, 'readiness alone does not undo explicit cancellation');

    position.setX(0, originalGetX(0) + 0.01);
    position.needsUpdate = true;
    await act(async () => { updateScene((scene) => ({ ...scene, models: [...models] })); });
    await waitFor(() => upload.readStats().uploadBegins > warmed.uploadBegins, 'the source attribute revision to warm');
    await prewarmSliceMesh(options());
    const edited = upload.readStats();
    await act(async () => { updateScene((scene) => ({ ...scene, ready: false })); });
    second.transform.position.x += 0.25;
    await act(async () => { updateScene((scene) => ({ ...scene, models: [...models] })); });
    await settle(800);
    assert.equal(upload.readStats().uploadBegins, edited.uploadBegins, 'transient geometry is not warmed');
    await act(async () => { updateScene((scene) => ({ ...scene, models: [] })); });
    await settle(800);
    assert.equal(upload.readStats().uploadBegins, edited.uploadBegins, 'clearing the scene stops future warmup');
  } finally {
    await tree.unmount();
    if (internals) Object.defineProperty(window, '__TAURI_INTERNALS__', internals);
    else Reflect.deleteProperty(window, '__TAURI_INTERNALS__');
    if (eventInternals) Object.defineProperty(window, '__TAURI_EVENT_PLUGIN_INTERNALS__', eventInternals);
    else Reflect.deleteProperty(window, '__TAURI_EVENT_PLUGIN_INTERNALS__');
    upload.restore();
    setSnapshot(previousSupports); setRaftSettings(previousRaft);
    clearPreparedGeometryCacheForModel(first.id); deleteStoredMeshModifiers(first.id);
    first.geometry.geometry.dispose(); second.geometry.geometry.dispose();
  }
});
