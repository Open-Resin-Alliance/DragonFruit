import assert from 'node:assert/strict';
import { resolveObjectURL } from 'node:buffer';
import test from 'node:test';
import { useEffect } from 'react';
import { clearHistory, getUndoCount, redo, undo } from '@/history/historyStore';
import { addRoot, getSnapshot } from '@/supports/state';
import { renderWithProviders, settle } from '@/utils/__tests__/helpers/renderDom';
import { useSceneCollectionManager } from '../useSceneCollectionManager';

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
