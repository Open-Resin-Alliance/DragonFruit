import assert from 'node:assert/strict';
import { Buffer, resolveObjectURL } from 'node:buffer';
import test from 'node:test';
import { useEffect } from 'react';
import { clearHistory, getUndoCount, peekUndo, redo, undo } from '@/history/historyStore';
import { clearMocks, mockIPC } from '@tauri-apps/api/mocks';
import { addPrinterProfile, getProfileStoreSnapshot, removePrinterProfile, setActivePrinterProfile, updatePrinterProfile } from '@/features/profiles/profileStore';
import type { LayerSettingsRange } from '@/features/slicing/layerSettingsRanges';
import { serializeVoxlDocumentV2, type BuildVoxlDocumentInput } from '../voxl';
import { testInput } from '../voxl/__tests__/voxlTestSupport';
import { addRoot, getSnapshot } from '@/supports/state';
import { renderWithProviders, settle } from '@/utils/__tests__/helpers/renderDom';
import { SCENE_LAYER_SETTINGS_RANGES_APPLY, useSceneCollectionManager } from '../useSceneCollectionManager';

type Scene = ReturnType<typeof useSceneCollectionManager>;

const CUBE_STL = `solid cube
${[
  [[0, 0, 0], [10, 0, 0], [10, 10, 0]], [[0, 0, 0], [10, 10, 0], [0, 10, 0]],
  [[0, 0, 10], [10, 10, 10], [10, 0, 10]], [[0, 0, 10], [0, 10, 10], [10, 10, 10]],
  [[0, 0, 0], [10, 0, 10], [10, 0, 0]], [[0, 0, 0], [0, 0, 10], [10, 0, 10]],
  [[0, 10, 0], [10, 10, 0], [10, 10, 10]], [[0, 10, 0], [10, 10, 10], [0, 10, 10]],
  [[0, 0, 0], [0, 10, 0], [0, 10, 10]], [[0, 0, 0], [0, 10, 10], [0, 0, 10]],
  [[10, 0, 0], [10, 10, 10], [10, 10, 0]], [[10, 0, 0], [10, 0, 10], [10, 10, 10]],
].map((tri) => `facet normal 0 0 0
outer loop
${tri.map((v) => `vertex ${v.join(' ')}`).join('\n')}
endloop
endfacet`).join('\n')}
endsolid cube
`;

// The importer reads the dropped file back through a `blob:` URL, which happy-dom's fetch
// refuses; the URL is Node's, so Node can resolve it.
const domFetch = globalThis.fetch;
globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
  const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
  const blob = url.startsWith('blob:') ? resolveObjectURL(url) : undefined;
  return blob ? new Response(await blob.arrayBuffer()) : domFetch(input, init);
}) as typeof fetch;

async function mountScene() {
  const sceneRef: { current: Scene | null } = { current: null };
  function Probe() {
    const scene = useSceneCollectionManager();
    useEffect(() => {
      sceneRef.current = scene;
    });
    return null;
  }
  const tree = await renderWithProviders(<Probe />);
  const scene = () => {
    assert.ok(sceneRef.current, 'scene manager mounted');
    return sceneRef.current;
  };
  return { tree, scene };
}

async function waitFor(condition: () => boolean, label: string, timeoutMs = 10_000) {
  const start = Date.now();
  while (!condition()) {
    if (Date.now() - start > timeoutMs) assert.fail(`timed out waiting for ${label}`);
    await settle(20);
  }
}

async function loadCube(scene: () => Scene, name = 'cube.stl') {
  const before = scene().models.length;
  await scene().loadFiles([new File([CUBE_STL], name, { type: 'model/stl' })]);
  await waitFor(() => scene().models.length === before + 1, 'the cube to load');
  await settle(50);
  return scene().models[scene().models.length - 1];
}

/** Undoes the newest entry, then redoes it, checking `read()` lands on each value. */
async function assertUndoRedo<T>(read: () => T, before: T, after: T) {
  assert.deepEqual(read(), after);
  undo();
  await settle(20);
  assert.deepEqual(read(), before, 'undo restores the earlier state');
  redo();
  await settle(20);
  assert.deepEqual(read(), after, 'redo reapplies the change');
}

test('scene edits from the model list land in undo history', async (t) => {
  const { tree, scene } = await mountScene();
  try {
    const cube = await loadCube(scene);
    const model = () => scene().models.find((m) => m.id === cube.id);

    await t.test('renaming a model', async () => {
      clearHistory();
      scene().renameModel(cube.id, 'renamed');
      await settle(20);
      assert.equal(getUndoCount(), 1);
      await assertUndoRedo(() => model()?.name, cube.name, 'renamed');
    });

    await t.test('renaming to the same name records nothing', async () => {
      clearHistory();
      scene().renameModel(cube.id, model()!.name);
      await settle(20);
      assert.equal(getUndoCount(), 0);
    });

    await t.test('renaming a group', async () => {
      clearHistory();
      const groupId = scene().groupModels([cube.id], 'first');
      assert.ok(groupId);
      await settle(20);
      clearHistory();
      scene().renameGroup(groupId, 'second');
      await settle(20);
      assert.equal(getUndoCount(), 1);
      await assertUndoRedo(() => model()?.groupName, 'first', 'second');
    });

    await t.test('hiding a model', async () => {
      clearHistory();
      scene().setModelVisibility(cube.id, false);
      await settle(20);
      assert.equal(getUndoCount(), 1);
      await assertUndoRedo(() => model()?.visible, true, false);
    });

    await t.test('colouring the active model', async () => {
      clearHistory();
      scene().setActiveModelId(cube.id);
      await settle(20);
      const original = model()!.color;
      scene().setMeshColor('#ff0000');
      await settle(20);
      assert.equal(getUndoCount(), 1);
      await assertUndoRedo(() => model()?.color, original, '#ff0000');
    });

    await t.test('repairing a model in place', async () => {
      clearHistory();
      const original = model()!.geometry.geometry;
      assert.equal(await scene().repairModelsInPlace([cube.id]), true);
      await settle(20);
      const repaired = model()!.geometry.geometry;
      assert.notEqual(repaired, original);
      assert.equal(getUndoCount(), 1);
      await assertUndoRedo(() => model()?.geometry.geometry, original, repaired);
    });

    await t.test('repairing several models is one step', async () => {
      const other = await loadCube(scene, 'other.stl');
      clearHistory();
      const geometries = () => scene().models
        .filter((m) => m.id === cube.id || m.id === other.id)
        .map((m) => m.geometry.geometry);
      const originals = geometries();
      assert.equal(await scene().repairModelsInPlace([cube.id, other.id]), true);
      await settle(20);
      const repaired = geometries();
      repaired.forEach((geometry, i) => assert.notEqual(geometry, originals[i]));
      assert.equal(getUndoCount(), 1);
      await assertUndoRedo(geometries, originals, repaired);
    });
  } finally {
    await tree.unmount();
  }
});

/**
 * A move is a delta, not a copy of the support store: the pair records the two
 * transforms and the supports are replayed by the same call that moved them.
 * The clone it replaces was ~20k entities twice on a supported plate.
 */
test('moving a model carries its supports through undo and redo', async () => {
  const { tree, scene } = await mountScene();
  try {
    const cube = await loadCube(scene);
    clearHistory();
    addRoot({
      id: 'move-root',
      modelId: cube.id,
      transform: { pos: { x: 0, y: 0, z: 0 }, rotation: { x: 0, y: 0, z: 0, w: 1 }, scale: { x: 1, y: 1, z: 1 } },
      diameter: 3,
      diskHeight: 1,
      coneHeight: 2,
    } as never);

    const rootX = () => getSnapshot().roots['move-root'].transform.pos.x;
    const startX = rootX();
    const model = () => scene().models.find((candidate) => candidate.id === cube.id)!;
    const before = model().transform;
    const after = {
      position: before.position.clone().setX(before.position.x + 5),
      rotation: before.rotation.clone(),
      scale: before.scale.clone(),
    };

    const moved = scene().updateModelTransform(cube.id, after);
    assert.equal(moved.updated, true);
    scene().commitModelTransformHistory(cube.id, before, after);
    await settle(20);

    assert.equal(getUndoCount(), 1, 'the move is one undo step');
    assert.ok(Math.abs(rootX() - (startX + 5)) < 1e-6, 'the support moved with the model');

    undo();
    await settle(20);
    assert.ok(Math.abs(rootX() - startX) < 1e-6, 'undo moves the support back');
    assert.ok(Math.abs(model().transform.position.x - before.position.x) < 1e-6, 'and the model');

    redo();
    await settle(20);
    assert.ok(Math.abs(rootX() - (startX + 5)) < 1e-6, 'redo moves the support again');
    assert.ok(Math.abs(model().transform.position.x - after.position.x) < 1e-6, 'and the model');
  } finally {
    await tree.unmount();
  }
});


const LAYER_RANGES: LayerSettingsRange[] = [
  { id: 'wide-range', startLayer: 3, endLayer: 10, settings: { exposureSec: 4, liftHeightMm: 8 } },
  { id: 'nested-range', startLayer: 5, endLayer: 6, settings: { exposureSec: 7 } },
  { id: 'later-range', startLayer: 6, endLayer: 7, settings: { exposureSec: 9 } },
];

async function rangeSceneFile(overrides: Partial<BuildVoxlDocumentInput> = {}) {
  const bytes = await serializeVoxlDocumentV2(
    { ...testInput(['range-import-cube']), ...overrides },
    new Map([[0, new TextEncoder().encode(CUBE_STL)]]),
  );
  return new File([bytes], 'ranges.voxl');
}

const QUIET_IMPORT = {
  suppressRecentTracking: true,
  suppressProgress: true,
  suppressReport: true,
  suppressPlacementPrompt: true,
};

test('scene layer range Add, Edit and Delete each have one reversible action', async (t) => {
  const { tree, scene } = await mountScene();
  const readRanges = () => scene().layerSettingsRanges;
  try {
    await t.test('Add', async () => {
      clearHistory();
      scene().updateLayerSettingsRanges(LAYER_RANGES);
      await settle(20);
      assert.equal(getUndoCount(), 1);
      assert.equal(peekUndo()?.type, SCENE_LAYER_SETTINGS_RANGES_APPLY);
      await assertUndoRedo(readRanges, [], LAYER_RANGES);
      assert.equal(getUndoCount(), 1, 'undo/redo did not push another action');
    });

    const edited = LAYER_RANGES.map((range) => range.id === 'later-range'
      ? { ...range, settings: { exposureSec: 11 } }
      : range);
    await t.test('Edit keeps the id and order', async () => {
      clearHistory();
      scene().updateLayerSettingsRanges(edited);
      await settle(20);
      assert.equal(getUndoCount(), 1);
      await assertUndoRedo(readRanges, LAYER_RANGES, edited);
      assert.equal(getUndoCount(), 1);
    });

    const deleted = edited.filter((range) => range.id !== 'later-range');
    await t.test('Delete', async () => {
      clearHistory();
      scene().updateLayerSettingsRanges(deleted);
      await settle(20);
      assert.equal(getUndoCount(), 1);
      await assertUndoRedo(readRanges, edited, deleted);
      assert.equal(getUndoCount(), 1);
    });

    await t.test('identical owned content is a no-op, including patch key order', async () => {
      clearHistory();
      const current = readRanges();
      scene().updateLayerSettingsRanges(deleted.map((range, index) => index === 0
        ? { ...range, settings: { liftHeightMm: 8, exposureSec: 4 } }
        : { ...range, settings: { ...range.settings } }));
      await settle(20);
      assert.equal(getUndoCount(), 0);
      assert.equal(readRanges(), current, 'no-op preserves the published array');
    });

    await t.test('an id or array-order change is not a no-op', async () => {
      clearHistory();
      const reordered = [...deleted].reverse();
      scene().updateLayerSettingsRanges(reordered);
      await settle(20);
      assert.equal(getUndoCount(), 1);
      await assertUndoRedo(readRanges, deleted, reordered);
      clearHistory();
      const renamed = reordered.map((range, index) => {
        if (index === 0) return { ...range, id: 'replacement-id' };
        return range;
      });
      scene().updateLayerSettingsRanges(renamed);
      await settle(20);
      assert.equal(getUndoCount(), 1);
      await assertUndoRedo(readRanges, reordered, renamed);
    });

    await t.test('invalid input neither changes state nor records history', async () => {
      clearHistory();
      const current = readRanges();
      assert.throws(() => scene().updateLayerSettingsRanges([
        { ...LAYER_RANGES[0], startLayer: 0 },
      ]), /Invalid layer settings range:/);
      await settle(20);
      assert.equal(readRanges(), current);
      assert.equal(getUndoCount(), 0);
    });
  } finally {
    clearHistory();
    await tree.unmount();
  }
});

test('scene range updates own their input and use the latest value before React commits', async () => {
  const { tree, scene } = await mountScene();
  try {
    clearHistory();
    const first = structuredClone([LAYER_RANGES[0]]);
    scene().updateLayerSettingsRanges(first);
    first[0].settings.exposureSec = 99;
    first[0].id = 'mutated-caller-id';
    scene().updateLayerSettingsRanges(LAYER_RANGES.slice(0, 2));
    await settle(20);
    assert.equal(getUndoCount(), 2);
    await assertUndoRedo(() => scene().layerSettingsRanges, [LAYER_RANGES[0]], LAYER_RANGES.slice(0, 2));
    undo();
    undo();
    await settle(20);
    assert.deepEqual(scene().layerSettingsRanges, []);
    assert.equal(getUndoCount(), 0);
  } finally {
    clearHistory();
    await tree.unmount();
  }
});

test('last-model deletion clears ranges atomically in every owning deletion path', async (t) => {
  for (const kind of ['single plate', 'extra plates', 'removePlate', 'deleteModelsAndExtraPlates'] as const) {
    await t.test(kind, async () => {
      const { tree, scene } = await mountScene();
      try {
        const cube = await loadCube(scene);
        let extraPlateId: string | undefined;
        if (kind !== 'single plate') {
          extraPlateId = scene().addPlate();
          await settle(20);
          scene().moveModelsToPlate([cube.id], extraPlateId);
          await settle(20);
        }
        scene().updateLayerSettingsRanges(LAYER_RANGES);
        await settle(20);
        const beforePlates = scene().plates.map((plate) => plate.id);
        clearHistory();
        if (kind === 'removePlate') {
          assert.ok(extraPlateId);
          assert.equal(scene().removePlate(extraPlateId), true);
        } else if (kind === 'deleteModelsAndExtraPlates') {
          await scene().deleteModelsAndExtraPlates([cube.id]);
        } else {
          await scene().deleteModels([cube.id]);
        }
        await waitFor(() => scene().models.length === 0 && getUndoCount() === 1, 'atomic deletion history');
        assert.deepEqual(scene().layerSettingsRanges, []);
        assert.equal(scene().plates.length, 1);

        undo();
        await waitFor(() => scene().models.some((model) => model.id === cube.id), 'the deleted cube to return');
        assert.deepEqual(scene().layerSettingsRanges, LAYER_RANGES);
        assert.deepEqual(scene().plates.map((plate) => plate.id), beforePlates);
        assert.equal(getUndoCount(), 0, 'restoring ranges is part of the deletion, not another action');
        redo();
        await waitFor(() => scene().models.length === 0, 'redo to delete the cube');
        assert.deepEqual(scene().layerSettingsRanges, []);
        assert.equal(scene().plates.length, 1);
        assert.equal(getUndoCount(), 1);
      } finally {
        clearHistory();
        await tree.unmount();
      }
    });
  }
});

test('plate-owned partial deletion and its undo leave a newer range schedule alone', async (t) => {
  for (const kind of ['removePlate', 'deleteModelsAndExtraPlates'] as const) {
    await t.test(kind, async () => {
      const { tree, scene } = await mountScene();
      try {
        const survivor = await loadCube(scene, 'survivor.stl');
        const doomed = await loadCube(scene, 'doomed.stl');
        const extraPlateId = scene().addPlate();
        await settle(20);
        scene().moveModelsToPlate([doomed.id], extraPlateId);
        await settle(20);
        scene().updateLayerSettingsRanges(LAYER_RANGES);
        await settle(20);
        clearHistory();
        if (kind === 'removePlate') assert.equal(scene().removePlate(extraPlateId), true);
        else await scene().deleteModelsAndExtraPlates([doomed.id]);
        await waitFor(() => scene().models.length === 1 && getUndoCount() === 1, 'partial deletion');
        assert.equal(scene().models[0].id, survivor.id);
        assert.deepEqual(scene().layerSettingsRanges, LAYER_RANGES);

        assert.equal(await scene().importSceneFile(await rangeSceneFile({ layerSettingsRanges: [] }), QUIET_IMPORT), true);
        await settle(20);
        undo();
        await waitFor(() => scene().models.some((model) => model.id === doomed.id), 'partial deletion undo');
        assert.deepEqual(scene().layerSettingsRanges, [], 'unchanged ranges were not captured in the model/plate action');
        redo();
        await waitFor(() => scene().models.length === 1, 'partial deletion redo');
        assert.deepEqual(scene().layerSettingsRanges, []);
      } finally {
        clearHistory();
        await tree.unmount();
      }
    });
  }
});

test('VOXL imports adopt only present schedules whose models actually commit', async (t) => {
  const { tree, scene } = await mountScene();
  try {
    const cube = await loadCube(scene);
    scene().updateLayerSettingsRanges(LAYER_RANGES);
    await settle(20);
    clearHistory();

    await t.test('an absent key on append and a non-native import preserve ranges', async () => {
      assert.equal(await scene().importSceneFile(await rangeSceneFile(), QUIET_IMPORT), true);
      await settle(20);
      assert.deepEqual(scene().layerSettingsRanges, LAYER_RANGES);
      await loadCube(scene, 'another.stl');
      assert.deepEqual(scene().layerSettingsRanges, LAYER_RANGES);
    });

    await t.test('present ranges adopt without rebasing and model-only undo leaves them alone', async () => {
      clearHistory();
      scene().renameModel(cube.id, 'before-range-import');
      await settle(20);
      const importedRanges = [{ id: 'out-of-print', startLayer: 100, endLayer: 200, settings: { exposureSec: 12 } }];
      assert.equal(await scene().importSceneFile(await rangeSceneFile({ layerSettingsRanges: importedRanges }), QUIET_IMPORT), true);
      await settle(20);
      assert.deepEqual(scene().layerSettingsRanges, importedRanges);
      assert.equal(getUndoCount(), 1);
      await assertUndoRedo(() => scene().models.find((model) => model.id === cube.id)?.name, cube.name, 'before-range-import');
      assert.deepEqual(scene().layerSettingsRanges, importedRanges);
    });

    await t.test('present [] explicitly clears the schedule', async () => {
      assert.equal(await scene().importSceneFile(await rangeSceneFile({ layerSettingsRanges: [] }), QUIET_IMPORT), true);
      await settle(20);
      assert.deepEqual(scene().layerSettingsRanges, []);
    });

    await t.test('a file with no importable models does not adopt its schedule', async () => {
      scene().updateLayerSettingsRanges(LAYER_RANGES);
      await settle(20);
      const before = scene().layerSettingsRanges;
      const noModels = await rangeSceneFile({ models: [], activeModelId: null, layerSettingsRanges: [] });
      assert.equal(await scene().importSceneFile(noModels, QUIET_IMPORT), false);
      await settle(20);
      assert.equal(scene().layerSettingsRanges, before);
    });

    await t.test('support processing failure after model commit preserves the previous schedule', async () => {
      scene().updateLayerSettingsRanges(LAYER_RANGES);
      await settle(20);
      const beforeRanges = scene().layerSettingsRanges;
      // Deliberately malformed external support data: the codec accepts this
      // subtree, but the support importer rejects a null root after mesh commit.
      const invalidSupports = { ...testInput([]).supports, roots: [null] } as unknown as BuildVoxlDocumentInput['supports'];
      const file = await rangeSceneFile({ layerSettingsRanges: [], supports: invalidSupports });
      assert.equal(await scene().importSceneFile(file, QUIET_IMPORT), false);
      await settle(20);
      assert.equal(scene().layerSettingsRanges, beforeRanges);
      assert.deepEqual(scene().layerSettingsRanges, LAYER_RANGES);
    });

    await t.test('cancel at the missing-plugin prompt leaves ranges and models unchanged', async () => {
      const previousPrinterId = getProfileStoreSnapshot().activePrinterProfileId;
      const printerId = addPrinterProfile({ name: 'Range import cancellation fixture' });
      updatePrinterProfile(printerId, { missingPlugin: { id: 'range-import-fixture', name: 'Missing fixture' } });
      setActivePrinterProfile(previousPrinterId);
      await settle(20);
      const file = await rangeSceneFile({
        layerSettingsRanges: [],
        meta: { printer: { version: 1, printer: { id: printerId }, materials: [] } },
      });
      const beforeRanges = scene().layerSettingsRanges;
      const beforeModels = scene().models;
      const pending = scene().importSceneFile(file, QUIET_IMPORT);
      try {
        await waitFor(() => scene().missingPrinterPluginPrompt !== null, 'the missing-plugin choice');
        scene().resolveMissingPrinterPluginChoice('manage');
        assert.equal(await pending, false);
        await settle(20);
        assert.equal(scene().layerSettingsRanges, beforeRanges);
        assert.equal(scene().models, beforeModels);
      } finally {
        scene().resolveMissingPrinterPluginChoice('manage');
        await pending;
        removePrinterProfile(printerId);
        setActivePrinterProfile(previousPrinterId);
        await settle(20);
      }
    });

    await t.test('malformed ranges fail before native geometry loading', async () => {
      const valid = await rangeSceneFile({ layerSettingsRanges: LAYER_RANGES });
      const bytes = new Uint8Array(await valid.arrayBuffer());
      const field = '"startLayer":3';
      const index = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength).indexOf(field);
      assert.ok(index >= 0, 'the fixture has an uncompressed SCNE range');
      bytes[index + field.length - 1] = '0'.charCodeAt(0);
      const beforeRanges = scene().layerSettingsRanges;
      const beforeModels = scene().models;
      let meshLoads = 0;
      mockIPC((command) => {
        if (command === 'load_mesh_range') meshLoads += 1;
        return null;
      });
      try {
        assert.equal(await scene().importSceneFile(new File([bytes], 'malformed.voxl'), {
          ...QUIET_IMPORT,
          sourcePath: '/test/malformed-ranges.voxl',
        }), false);
        await settle(20);
        assert.equal(meshLoads, 0);
        assert.equal(scene().layerSettingsRanges, beforeRanges);
        assert.equal(scene().models, beforeModels);
      } finally {
        clearMocks();
      }
    });
  } finally {
    clearHistory();
    await tree.unmount();
  }
});
