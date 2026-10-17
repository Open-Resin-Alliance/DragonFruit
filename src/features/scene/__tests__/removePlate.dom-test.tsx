import assert from 'node:assert/strict';
import { resolveObjectURL } from 'node:buffer';
import test from 'node:test';
import { useEffect } from 'react';
import { clearHistory, undo } from '@/history/historyStore';
import { getSnapshot as getSupportSnapshot, loadFromImportFormat, resetStore as resetSupportStore } from '@/supports/state';
import { SUPPORT_COLLECTION_KEYS } from '@/supports/supportTypeRegistry';
import type { DragonfruitImportFormat } from '@/supports/types';
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

/** One support root standing under each model, where the model stands. */
function rootsUnder(models: ReadonlyArray<{ id: string; x: number; y: number }>): DragonfruitImportFormat {
  const collections = Object.fromEntries(SUPPORT_COLLECTION_KEYS.map((key) => [key, []]));
  return {
    ...collections,
    version: 1,
    meta: { source: 'dom-test', objectCenter: { x: 0, y: 0, z: 0 } },
    roots: models.map(({ id, x, y }) => ({
      id: `root-${id}`,
      modelId: id,
      transform: { pos: { x, y, z: 0 }, rot: { x: 0, y: 0, z: 0, w: 1 } },
      diameter: 4,
      diskHeight: 0.5,
      coneHeight: 1,
    })),
    knots: [],
  } as unknown as DragonfruitImportFormat;
}

async function waitFor(condition: () => boolean, label: string, timeoutMs = 10_000) {
  const start = Date.now();
  while (!condition()) {
    if (Date.now() - start > timeoutMs) assert.fail(`timed out waiting for ${label}`);
    await settle(20);
  }
}

test('deleting a plate from the middle keeps every other model on its own plate', async () => {
  const ref: { scene: Scene | null } = { scene: null };
  function Probe() {
    const scene = useSceneCollectionManager();
    useEffect(() => {
      ref.scene = scene;
    });
    return null;
  }
  const tree = await renderWithProviders(<Probe />);
  const scene = () => {
    assert.ok(ref.scene, 'scene manager mounted');
    return ref.scene;
  };
  const loadCube = async (name: string) => {
    const before = scene().models.length;
    await scene().loadFiles([new File([CUBE_STL], name, { type: 'model/stl' })]);
    await waitFor(() => scene().models.length === before + 1, `${name} to load`);
    await settle(50);
    return scene().models[scene().models.length - 1].id;
  };
  const plateOf = (id: string) => scene().resolveModelPlateId(scene().models.find((m) => m.id === id)!);
  const plateNames = () => scene().plates.map((plate) => plate.name);
  const positionOf = (id: string) => {
    const { x, y } = scene().models.find((m) => m.id === id)!.transform.position;
    return { x, y };
  };
  const rootOf = (id: string) => {
    const pos = getSupportSnapshot().roots[`root-${id}`]?.transform.pos;
    assert.ok(pos, `${id} still has its support`);
    return { x: pos.x, y: pos.y };
  };

  try {
    const a = await loadCube('a.stl');
    const b = await loadCube('b.stl');
    const c = await loadCube('c.stl');
    const d = await loadCube('d.stl');
    const plate1 = plateOf(a);
    const plate2 = scene().addPlate();
    await settle(20);
    const plate3 = scene().addPlate();
    await settle(20);
    const plate4 = scene().addPlate();
    await settle(20);
    scene().moveModelsToPlate([c], plate3);
    await settle(50);
    scene().moveModelsToPlate([d], plate4);
    await settle(50);
    scene().renamePlate(plate4, 'LalaLa');
    await settle(20);
    const placed = { [a]: plate1, [b]: plate1, [c]: plate3, [d]: plate4 };
    for (const [id, plateId] of Object.entries(placed)) assert.equal(plateOf(id), plateId, 'set up as described');
    // Supports live in world space, apart from the models, so a bed that moves has to take them.
    resetSupportStore();
    loadFromImportFormat(rootsUnder([a, c, d].map((id) => ({ id, ...positionOf(id) }))));
    const rootsBefore = { [a]: rootOf(a), [c]: rootOf(c), [d]: rootOf(d) };

    clearHistory();
    assert.equal(scene().removePlate(plate2), true);
    await waitFor(() => scene().plates.length === 3, 'the plate to go');
    await settle(100);

    assert.deepEqual(scene().plates.map((plate) => plate.id), [plate1, plate3, plate4]);
    assert.deepEqual(plateNames(), ['', '', 'LalaLa'], 'the name stays with its plate');
    assert.equal(scene().models.length, 4, 'the empty plate took no model with it');
    for (const [id, plateId] of Object.entries(placed)) assert.equal(plateOf(id), plateId, 'each model moves with its plate');
    for (const id of [a, c, d]) assert.deepEqual(rootOf(id), positionOf(id), 'and its supports with it');
    assert.notDeepEqual(rootOf(c), rootsBefore[c], 'a later plate did move');

    undo();
    await waitFor(() => scene().plates.length === 4, 'undo to bring the plate back');
    await settle(100);
    for (const [id, plateId] of Object.entries(placed)) assert.equal(plateOf(id), plateId, 'and undo puts them back');
    for (const id of [a, c, d]) assert.deepEqual(rootOf(id), rootsBefore[id], 'supports included');
  } finally {
    await tree.unmount();
    clearHistory();
    resetSupportStore();
  }
});
