import assert from 'node:assert/strict';
import { resolveObjectURL } from 'node:buffer';
import test from 'node:test';
import { useEffect } from 'react';
import { clearHistory, pushHistory } from '@/history/historyStore';
import { renderWithProviders, settle } from '@/utils/__tests__/helpers/renderDom';
import { useSceneCollectionManager } from '@/features/scene/useSceneCollectionManager';
import type { SliceExportArtifact } from '@/features/slicing/sliceExportOrchestrator';
import { isSlicedPlateStale, sliceProfileFingerprint } from '../slicedPlates';
import { useSlicedPlates, type SlicedPlatesView } from '../useSlicedPlates';

type Scene = ReturnType<typeof useSceneCollectionManager>;

const FINGERPRINT = sliceProfileFingerprint('saturn-2', 'standard');

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

/** An artifact with no file behind it: nothing tries to read previews out of it. */
function artifact(name: string): SliceExportArtifact {
  return { blob: null, outputName: name, mimeType: '', byteSize: 1, nativeTempPath: null, outputFormat: '.ctb' };
}

async function mount() {
  const ref: { scene: Scene | null; view: SlicedPlatesView | null } = { scene: null, view: null };
  function Probe() {
    const scene = useSceneCollectionManager();
    const view = useSlicedPlates({
      activePlateId: scene.activePlateId,
      models: scene.models,
      plateOf: scene.resolveModelPlateId,
      profileFingerprint: FINGERPRINT,
    });
    useEffect(() => {
      ref.scene = scene;
      ref.view = view;
    });
    return null;
  }
  const tree = await renderWithProviders(<Probe />);
  const scene = () => {
    assert.ok(ref.scene, 'scene manager mounted');
    return ref.scene;
  };
  const stale = (plateId: string) => {
    assert.ok(ref.view, 'sliced plates mounted');
    return isSlicedPlateStale(ref.view.slicedPlates.getSnapshot().plates[plateId], FINGERPRINT);
  };
  return { tree, scene, view: () => ref.view!, stale };
}

async function waitFor(condition: () => boolean, label: string, timeoutMs = 10_000) {
  const start = Date.now();
  while (!condition()) {
    if (Date.now() - start > timeoutMs) assert.fail(`timed out waiting for ${label}`);
    await settle(20);
  }
}

async function loadCube(scene: () => Scene, name: string) {
  const before = scene().models.length;
  await scene().loadFiles([new File([CUBE_STL], name, { type: 'model/stl' })]);
  await waitFor(() => scene().models.length === before + 1, `${name} to load`);
  await settle(50);
  return scene().models[scene().models.length - 1];
}

test('a slice goes stale when its own plate is edited, not when another one is', async () => {
  const { tree, scene, view, stale } = await mount();
  try {
    const first = await loadCube(scene, 'first.stl');
    const second = await loadCube(scene, 'second.stl');
    const plate1 = scene().resolveModelPlateId(first);
    const plate2 = scene().addPlate();
    await settle(20);
    scene().moveModelsToPlate([second.id], plate2);
    await settle(50);
    assert.equal(scene().resolveModelPlateId(scene().models.find((m) => m.id === second.id)!), plate2);
    assert.notEqual(plate1, plate2);

    clearHistory();
    view().slicedPlates.record(plate1, artifact('one'), { totalLayers: 10, profileFingerprint: FINGERPRINT });
    view().slicedPlates.record(plate2, artifact('two'), { totalLayers: 10, profileFingerprint: FINGERPRINT });
    await settle(20);
    assert.equal(stale(plate1), false, 'recording a slice is not an edit');
    assert.equal(stale(plate2), false);

    scene().setModelVisibility(second.id, false);
    await settle(20);
    assert.equal(stale(plate2), true, 'hiding a model on plate 2 makes its slice stale');
    assert.equal(stale(plate1), false, 'and leaves plate 1 alone');

    // An edit that replaces no model — a support edit, say — cannot be put on a plate.
    pushHistory({ type: 'test:support-edit', payload: {}, description: { id: 'test:support-edit' } });
    await settle(20);
    assert.equal(stale(plate1), true, 'an edit no plate owns counts against every plate');

    view().slicedPlates.runStarted(plate2);
    view().slicedPlates.record(plate2, artifact('two-again'), { totalLayers: 10, profileFingerprint: FINGERPRINT });
    await settle(20);
    assert.equal(stale(plate2), false, 're-slicing plate 2 makes it fresh');
    assert.equal(stale(plate1), true, 'and leaves plate 1 stale');
  } finally {
    await tree.unmount();
    clearHistory();
  }
});
