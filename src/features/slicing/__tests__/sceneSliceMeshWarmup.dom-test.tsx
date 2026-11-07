import assert from 'node:assert/strict';
import test from 'node:test';
import { act, useEffect, useState } from 'react';
import type { Dispatch, SetStateAction } from 'react';
import { addMaterialProfile, addPrinterProfile, setActiveMaterialProfile, setActivePrinterProfile } from '@/features/profiles/profileStore';
import { ExportManager } from '@/features/export/logic/ExportManager';
import { useSceneAutosave, resetAutosavePathCache, sceneAutosaveSuppressRef } from '@/hooks/useSceneAutosave';
import { createTypedHistory } from '@/history/typedHistory';
import { msg } from '@lingui/core/macro';
import { getSnapshot, setSnapshot } from '@/supports/state';
import { createEmptySupportCollections } from '@/supports/supportTypeRegistry';
import { getRaftSettings, setRaftSettings, updateRaftSettings } from '@/supports/Rafts/Crenelated/RaftState';
import { installFakeMeshChunkUpload } from '@/utils/__tests__/helpers/fakeMeshChunkUpload';
import { renderWithProviders } from '@/utils/__tests__/helpers/renderDom';
import { cubeModel } from './helpers/captureAppSliceJob';
import { readSliceMeshWarmupContext } from '../sliceInputContext';
import { prewarmSliceMesh } from '../sliceMeshSnapshot';
import { SLICE_MESH_CACHE_QUIET_MS } from '../sliceMeshWarmup';
import { useSceneSliceMeshWarmup } from '../useSceneSliceMeshWarmup';
import type { SceneSliceMeshWarmupOptions } from '../useSceneSliceMeshWarmup';

type SceneInput = Omit<SceneSliceMeshWarmupOptions, 'revision'>;

// Runs under the documented DOM preload, including the production React Compiler.
// Only native IPC is faked; history, autosave effects and the mesh producer are real.
for (const enabled of [false, true]) {
  test(`scene cache has its own dirty deadline with autosave ${enabled ? 'enabled' : 'disabled'}`, async (t) => {
    const printerId = addPrinterProfile({
      name: 'Independent cache printer',
      buildVolumeMm: { width: 20, depth: 20, height: 20 },
      display: { resolutionX: 64, resolutionY: 64, outputFormat: '.ctb' },
    });
    const materialId = addMaterialProfile(printerId, { name: 'Independent cache resin', layerHeightMm: 0.05 });
    setActivePrinterProfile(printerId);
    setActiveMaterialProfile(materialId);
    const previousSupports = getSnapshot();
    const previousRaft = getRaftSettings();
    setSnapshot({ ...previousSupports, ...createEmptySupportCollections() });
    updateRaftSettings({ bottomMode: 'off' });
    const model = cubeModel(`independent-cache-${enabled}`, 2);
    const frame = { id: 'cache-bed', index: 0, dxMm: 0, dyMm: 0, minX: -10, minY: -10, maxX: 10, maxY: 10 };
    const initial: SceneInput = {
      models: [], plateFrames: [frame], activePlateId: frame.id,
      excludedModelIds: [], exportMode: false, ready: false,
    };
    let updateScene!: Dispatch<SetStateAction<SceneInput>>;
    const notifications: number[] = [];
    let lastSavedAt: string | null = null;
    let saves = 0;
    let manifests = 0;
    const manifestWritten = Promise.withResolvers<void>();
    t.mock.method(ExportManager, 'exportScene', async () => { saves += 1; return null; });
    const upload = installFakeMeshChunkUpload(async (command) => {
      if (command === 'scene_autosave_get_paths') return {
        voxlPath: '/recovery/cache.voxl', manifestPath: '/recovery/cache.json',
        origin: 'recovery-dir', projectPath: null, fallbackReason: null,
      };
      if (command === 'scene_autosave_write_manifest') { manifests += 1; manifestWritten.resolve(); return; }
      throw new Error(`Unexpected operation during scene cache test: ${command}`);
    });
    const internals = Object.getOwnPropertyDescriptor(window, '__TAURI_INTERNALS__');
    const idleDescriptor = Object.getOwnPropertyDescriptor(window, 'requestIdleCallback');
    const cancelIdleDescriptor = Object.getOwnPropertyDescriptor(window, 'cancelIdleCallback');
    Object.defineProperty(window, '__TAURI_INTERNALS__', { configurable: true, value: { invoke: upload.invoke } });
    const idle = new Map<number, IdleRequestCallback>();
    let nextIdle = 0;
    Object.defineProperty(window, 'requestIdleCallback', { configurable: true, value: (callback: IdleRequestCallback, options?: IdleRequestOptions) => {
      assert.equal(options, undefined, 'idle preparation never uses a forced timeout');
      const id = ++nextIdle;
      idle.set(id, callback);
      return id;
    } });
    Object.defineProperty(window, 'cancelIdleCallback', { configurable: true, value: (id: number) => { idle.delete(id); } });
    resetAutosavePathCache();
    sceneAutosaveSuppressRef.current = 0;
    function SceneRoot() {
      const [scene, setScene] = useState(initial);
      const [revision, setRevision] = useState(0);
      useEffect(() => { updateScene = setScene; }, []);
      const autosave = useSceneAutosave({
        models: scene.models, activeModelId: null, selectedModelIds: [], enabled,
        debounceMs: 60_000, cooldownMs: 180_000, capMs: 300_000,
        onSceneContentChanged: (next) => { notifications.push(next); setRevision(next); },
      });
      useEffect(() => { lastSavedAt = autosave.lastAutosaveAt; }, [autosave.lastAutosaveAt]);
      useSceneSliceMeshWarmup({ ...scene, revision, ready: scene.ready && !autosave.isAutosaving });
      return null;
    }
    const tree = await renderWithProviders(<SceneRoot />);
    t.mock.timers.enable({ apis: ['Date', 'setTimeout'], now: Date.now() });
    const clockSetTimeout = globalThis.setTimeout;
    const clockClearTimeout = globalThis.clearTimeout;
    t.mock.method(window, 'setTimeout', (callback: () => void, delay?: number) => clockSetTimeout(callback, delay) as unknown as number);
    t.mock.method(window, 'clearTimeout', (id: number) => { clockClearTimeout(id); });
    const advance = async (ms: number) => { await act(async () => { t.mock.timers.tick(ms); }); };
    const idleTurn = async () => {
      await act(async () => {
        const callbacks = [...idle.values()];
        idle.clear();
        for (const callback of callbacks) callback({ didTimeout: false, timeRemaining: () => 50 });
      });
    };
    const contextOptions = () => {
      const context = readSliceMeshWarmupContext();
      assert.ok(context);
      return {
        models: [model], printerProfile: context.printerProfile, materialProfile: context.materialProfile,
        antiAliasing: context.antiAliasing,
        plateVolumeBoundsMm: { minX: frame.minX, minY: frame.minY, maxX: frame.maxX, maxY: frame.maxY },
        plateOffsetMm: { dxMm: frame.dxMm, dyMm: frame.dyMm },
      };
    };
    const history = createTypedHistory<{ move: { before: number; after: number } }>({ move: msg`Move model` });
    const unregister = history.register('move', (payload, direction) => {
      model.transform.position.x = direction === 'undo' ? payload.before : payload.after;
    });
    try {
      await act(async () => { updateScene((scene) => ({ ...scene, models: [model] })); });
      assert.ok(notifications.length > 0, 'model count notifies even with autosave disabled');
      await advance(SLICE_MESH_CACHE_QUIET_MS * 2);
      assert.equal(upload.readStats().workerStarts, 0, 'an unfinished import never assembles a scene');
      await act(async () => { updateScene((scene) => ({ ...scene, ready: true })); });
      await advance(SLICE_MESH_CACHE_QUIET_MS - 1);
      assert.equal(upload.readStats().workerStarts, 0, 'settled imports wait the entire cache deadline');
      await advance(1);
      assert.equal(upload.readStats().workerStarts, 0, 'quiet does not substitute for idle');
      assert.equal(idle.size, 1);
      await idleTurn();
      await prewarmSliceMesh(contextOptions());
      assert.equal(upload.readStats().uploadBegins, 1);
      assert.equal(saves, 0, 'cache completion neither writes nor advances the save revision');
      assert.equal(lastSavedAt, null);
      await advance(15_000); // The original autosave deadline is 60 s after import, not after cache completion.
      if (enabled) await act(async () => {
        await manifestWritten.promise;
        await new Promise<void>((resolve) => setImmediate(resolve));
      });
      assert.equal(saves, enabled ? 1 : 0);
      assert.equal(manifests, enabled ? 1 : 0);
      assert.equal(lastSavedAt !== null, enabled);
      const warmed = upload.readStats();
      await advance(120_000);
      await idleTurn();
      assert.deepEqual(upload.readStats(), warmed, 'clean cache has no recurring worker launch');
      const revisions = notifications.length;
      await act(async () => {
        model.transform.position.x = 0.5;
        history.push({ type: 'move', payload: { before: 0, after: 0.5 } });
      });
      assert.equal(notifications.length, revisions + 1, 'real history edits share the same notification seam');
      await advance(SLICE_MESH_CACHE_QUIET_MS);
      await idleTurn();
      await prewarmSliceMesh(contextOptions());
      assert.equal(upload.readStats().uploadBegins, warmed.uploadBegins + 1);
      assert.equal(saves, enabled ? 1 : 0, 'cache refresh is not an autosave flush');
    } finally {
      unregister();
      await tree.unmount();
      t.mock.restoreAll();
      t.mock.timers.reset();
      for (const [key, descriptor] of [
        ['__TAURI_INTERNALS__', internals], ['requestIdleCallback', idleDescriptor], ['cancelIdleCallback', cancelIdleDescriptor],
      ] as const) {
        if (descriptor) Object.defineProperty(window, key, descriptor);
        else Reflect.deleteProperty(window, key);
      }
      upload.restore();
      resetAutosavePathCache();
      setSnapshot(previousSupports); setRaftSettings(previousRaft);
      model.geometry.geometry.dispose();
    }
  });
}
