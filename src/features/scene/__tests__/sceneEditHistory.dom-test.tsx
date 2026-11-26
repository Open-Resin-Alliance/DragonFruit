import assert from 'node:assert/strict';
import { resolveObjectURL } from 'node:buffer';
import test from 'node:test';
import { useEffect } from 'react';
import { msg } from '@lingui/core/macro';
import * as THREE from 'three';
import { serializeVoxlDocumentV2 } from '@/features/scene/voxl';
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

async function loadVoxlWithMetadata(
  scene: () => Scene,
  sourcePath: string,
  originalFileName: string,
) {
  const beforeCount = scene().models.length;
  const bin = await serializeVoxlDocumentV2(
    {
      models: [{
        id: `voxl-${beforeCount}`,
        name: 'sourced',
        visible: true,
        color: '#ffffff',
        polygonCount: 12,
        sourcePath,
        originalRef: {
          mode: 'external-file',
          fileName: originalFileName,
        },
        transform: {
          position: { x: 0, y: 0, z: 0 },
          rotation: { x: 0, y: 0, z: 0 },
          scale: { x: 1, y: 1, z: 1 },
        },
        mesh: {
          mode: 'embedded-chunk',
          chunkIndex: 0,
          fileName: 'cube.stl',
          mimeType: 'model/stl',
        },
      }],
      activeModelId: `voxl-${beforeCount}`,
      selectedModelIds: [],
      supports: { version: 1, meta: { source: 'test', objectCenter: { x: 0, y: 0, z: 0 } }, roots: [] } as never,
    },
    new Map([[0, new TextEncoder().encode(CUBE_STL)]]),
    undefined,
    { embedOriginalMesh: false },
  );
  const fileBytes = Uint8Array.from(bin).buffer;
  const ok = await scene().importSceneFiles([new File([fileBytes], 'sourced.voxl', { type: 'application/octet-stream' })]);
  assert.equal(ok, true, 'voxl scene import must succeed');
  await waitFor(() => scene().models.length === beforeCount + 1, 'voxl model to load');
  await settle(50);
  return scene().models[scene().models.length - 1];
}

test('replaceModelGeometry and splitModelIntoParts clear sourcePath and originalRef and restore them on undo', async (t) => {
  const { tree, scene } = await mountScene();
  try {
    await t.test('replaceModelGeometry clears sourcePath and originalRef with undo/redo symmetry', async () => {
      const loaded = await loadVoxlWithMetadata(scene, '/tmp/original-a.stl', 'sidecars/original-a.stl');
      const model = () => scene().models.find((m) => m.id === loaded.id);
      assert.equal(model()?.sourcePath, '/tmp/original-a.stl');
      assert.equal(model()?.originalRef?.fileName, 'sidecars/original-a.stl');

      clearHistory();
      const nextGeom = new THREE.BoxGeometry(4, 4, 4);
      const replaced = scene().replaceModelGeometry(loaded.id, nextGeom, msg`Replace geometry`, {
        historyBefore: {},
      });
      assert.equal(replaced, true);
      await settle(20);

      assert.equal(model()?.sourcePath, null, 'replaceModelGeometry must clear stale sourcePath');
      assert.equal(model()?.originalRef, undefined, 'replaceModelGeometry must clear stale originalRef');

      undo();
      await settle(20);
      assert.equal(model()?.sourcePath, '/tmp/original-a.stl', 'undo restores sourcePath');
      assert.equal(model()?.originalRef?.fileName, 'sidecars/original-a.stl', 'undo restores originalRef');

      redo();
      await settle(20);
      assert.equal(model()?.sourcePath, null, 'redo clears sourcePath again');
      assert.equal(model()?.originalRef, undefined, 'redo clears originalRef again');
    });

    await t.test('splitModelIntoParts clears sourcePath and originalRef on part0 and extra parts, restoring on undo', async () => {
      const loaded = await loadVoxlWithMetadata(scene, '/tmp/original-b.stl', 'sidecars/original-b.stl');
      const model = () => scene().models.find((m) => m.id === loaded.id);
      assert.equal(model()?.sourcePath, '/tmp/original-b.stl');
      assert.equal(model()?.originalRef?.fileName, 'sidecars/original-b.stl');

      clearHistory();
      const extraIds = scene().splitModelIntoParts(
        loaded.id,
        [new THREE.BoxGeometry(4, 4, 4), new THREE.BoxGeometry(3, 3, 3)],
        msg`Split model`,
      );
      assert.ok(extraIds && extraIds.length === 1);
      await settle(20);

      const part0 = model();
      const part1 = scene().models.find((m) => m.id === extraIds[0]);
      assert.equal(part0?.sourcePath, null, 'part0 must clear stale sourcePath');
      assert.equal(part0?.originalRef, undefined, 'part0 must clear stale originalRef');
      assert.equal(part1?.sourcePath ?? null, null, 'extra part must not carry sourcePath');
      assert.equal(part1?.originalRef, undefined, 'extra part must not carry originalRef');

      undo();
      await settle(20);
      assert.equal(model()?.sourcePath, '/tmp/original-b.stl', 'undo restores sourcePath on unsplit model');
      assert.equal(model()?.originalRef?.fileName, 'sidecars/original-b.stl', 'undo restores originalRef on unsplit model');

      redo();
      await settle(20);
      assert.equal(model()?.sourcePath, null, 'redo clears sourcePath on part0 again');
      assert.equal(model()?.originalRef, undefined, 'redo clears originalRef on part0 again');
    });
  } finally {
    await tree.unmount();
  }
});
