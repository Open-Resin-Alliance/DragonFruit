import assert from 'node:assert/strict';
import { resolveObjectURL } from 'node:buffer';
import test from 'node:test';
import { useEffect } from 'react';
import { clearHistory, undo } from '@/history/historyStore';
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

    clearHistory();
    assert.equal(scene().removePlate(plate2), true);
    await waitFor(() => scene().plates.length === 3, 'the plate to go');
    await settle(100);

    assert.deepEqual(scene().plates.map((plate) => plate.id), [plate1, plate3, plate4]);
    assert.deepEqual(plateNames(), ['', '', 'LalaLa'], 'the name stays with its plate');
    assert.equal(scene().models.length, 4, 'the empty plate took no model with it');
    for (const [id, plateId] of Object.entries(placed)) assert.equal(plateOf(id), plateId, 'each model moves with its plate');

    undo();
    await waitFor(() => scene().plates.length === 4, 'undo to bring the plate back');
    await settle(100);
    for (const [id, plateId] of Object.entries(placed)) assert.equal(plateOf(id), plateId, 'and undo puts them back');
  } finally {
    await tree.unmount();
    clearHistory();
  }
});
