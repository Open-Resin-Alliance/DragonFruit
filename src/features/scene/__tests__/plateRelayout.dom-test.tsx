import assert from 'node:assert/strict';
import { resolveObjectURL } from 'node:buffer';
import test from 'node:test';
import { useEffect } from 'react';
import { getMultiPlateSettingsSnapshot, saveMultiPlateSettings } from '@/components/settings/multiPlatePreferences';
import { clearHistory, getUndoCount, redo, undo } from '@/history/historyStore';
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

/**
 * One support standing under each model, where the model stands.
 *
 * Each root carries the trunk that owns it: an import drops a root nothing
 * claims, so a bare root would not survive to be measured.
 */
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
    trunks: models.map(({ id, x, y }) => ({
      id: `trunk-${id}`,
      modelId: id,
      rootId: `root-${id}`,
      segments: [{
        id: `seg-${id}`,
        diameter: 1,
        topJoint: { id: `joint-${id}`, pos: { x, y, z: 10 }, diameter: 1.1 },
      }],
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

/** Mount the scene manager and hand back the probes both tests read it through. */
async function mountScene() {
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
  const positionOf = (id: string) => {
    const { x, y } = scene().models.find((m) => m.id === id)!.transform.position;
    return { x, y };
  };
  const rootOf = (id: string) => {
    const pos = getSupportSnapshot().roots[`root-${id}`]?.transform.pos;
    assert.ok(pos, `${id} still has its support`);
    return { x: pos.x, y: pos.y };
  };
  const unmount = async () => {
    await tree.unmount();
    clearHistory();
    resetSupportStore();
  };
  return { scene, loadCube, plateOf, positionOf, rootOf, unmount };
}

test('deleting a plate from the middle keeps every other model on its own plate', async () => {
  const { scene, loadCube, plateOf, positionOf, rootOf, unmount } = await mountScene();
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
    await unmount();
  }
});

test('adding beds in one go moves the supports of every model whose bed moves (#926)', async () => {
  // The dynamic grid widens as beds are added, which re-lays the ones already there; the
  // fixed grid only ever appends.
  const orderingBefore = getMultiPlateSettingsSnapshot().plateOrdering;
  saveMultiPlateSettings({ plateOrdering: 'dynamic' });
  const { scene, loadCube, plateOf, positionOf, rootOf, unmount } = await mountScene();

  try {
    const a = await loadCube('a.stl');
    const c = await loadCube('c.stl');
    const plate1 = plateOf(a);
    scene().addPlate();
    await settle(20);
    const plate3 = scene().addPlate();
    await settle(20);
    scene().addPlate();
    await settle(20);
    scene().moveModelsToPlate([c], plate3);
    await settle(50);
    assert.equal(plateOf(a), plate1, 'set up as described');
    assert.equal(plateOf(c), plate3, 'set up as described');
    resetSupportStore();
    loadFromImportFormat(rootsUnder([a, c].map((id) => ({ id, ...positionOf(id) }))));
    const cBefore = positionOf(c);

    // Four beds sit in a 2x2 grid; a fifth makes it 3x2, which moves the third bed from
    // the second row to the end of the first.
    scene().addPlates(1);
    await waitFor(() => scene().plates.length === 5, 'the bed to be added');
    await settle(50);

    assert.notDeepEqual(positionOf(c), cBefore, 'the third bed did move');
    assert.equal(plateOf(c), plate3, 'the model moves with its bed');
    for (const id of [a, c]) assert.deepEqual(rootOf(id), positionOf(id), 'and its supports with it');
  } finally {
    await unmount();
    saveMultiPlateSettings({ plateOrdering: orderingBefore });
  }
});

test('deleting the first plate takes its models and moves the other beds up a slot', async () => {
  const { scene, loadCube, plateOf, positionOf, rootOf, unmount } = await mountScene();

  try {
    const a = await loadCube('a.stl');
    const c = await loadCube('c.stl');
    const d = await loadCube('d.stl');
    const plate1 = plateOf(a);
    const plate2 = scene().addPlate();
    await settle(20);
    const plate3 = scene().addPlate();
    await settle(20);
    scene().moveModelsToPlate([c], plate2);
    await settle(50);
    scene().moveModelsToPlate([d], plate3);
    await settle(50);
    const kept = { [c]: plate2, [d]: plate3 };
    assert.equal(plateOf(a), plate1, 'set up as described');
    for (const [id, plateId] of Object.entries(kept)) assert.equal(plateOf(id), plateId, 'set up as described');
    resetSupportStore();
    loadFromImportFormat(rootsUnder([a, c, d].map((id) => ({ id, ...positionOf(id) }))));
    const rootsBefore = { [a]: rootOf(a), [c]: rootOf(c), [d]: rootOf(d) };

    clearHistory();
    assert.equal(scene().removePlate(plate1), true, 'the first plate can go');
    await waitFor(() => scene().plates.length === 2, 'the plate to go');
    await settle(100);

    assert.deepEqual(scene().plates.map((plate) => plate.id), [plate2, plate3]);
    assert.deepEqual(scene().models.map((model) => model.id), [c, d], 'its model went with it');
    assert.equal(getSupportSnapshot().roots[`root-${a}`], undefined, 'and so did its support');
    for (const [id, plateId] of Object.entries(kept)) assert.equal(plateOf(id), plateId, 'each other model stays on its plate');
    for (const id of [c, d]) assert.deepEqual(rootOf(id), positionOf(id), 'and its supports with it');
    assert.notDeepEqual(rootOf(c), rootsBefore[c], 'the beds did move up');
    assert.notEqual(scene().activePlateId, plate1, 'the active plate is one that still exists');

    undo();
    await waitFor(() => scene().plates.length === 3, 'undo to bring the plate back');
    await settle(100);
    assert.equal(plateOf(a), plate1, 'undo brings the model back onto the first plate');
    for (const [id, plateId] of Object.entries(kept)) assert.equal(plateOf(id), plateId, 'and the others back onto theirs');
    for (const id of [a, c, d]) assert.deepEqual(rootOf(id), rootsBefore[id], 'supports included');
  } finally {
    await unmount();
  }
});

test('renaming a plate is a step undo takes back and redo puts back', async () => {
  const { scene, loadCube, unmount } = await mountScene();
  const plateNames = () => scene().plates.map((plate) => plate.name);

  try {
    const a = await loadCube('a.stl');
    const plate2 = scene().addPlate();
    await settle(20);
    clearHistory();

    scene().renamePlate(plate2, 'Azalea Berro');
    await waitFor(() => plateNames()[1] === 'Azalea Berro', 'the rename');
    scene().setPlateName('Calabaza');
    await waitFor(() => plateNames()[0] === 'Calabaza', 'the active plate rename');
    scene().renamePlate(plate2, 'Azalea Berro');
    await settle(20);
    assert.equal(getUndoCount(), 2, 'one step per rename, none for a name that did not change');

    undo();
    await waitFor(() => plateNames()[0] === '', 'undo to take back the active plate rename');
    assert.deepEqual(plateNames(), ['', 'Azalea Berro']);
    undo();
    await waitFor(() => plateNames()[1] === '', 'undo to take back the first rename');
    assert.deepEqual(scene().models.map((model) => model.id), [a], 'the models are left as they were');

    redo();
    await waitFor(() => plateNames()[1] === 'Azalea Berro', 'redo to put the rename back');
  } finally {
    await unmount();
  }
});
