import assert from 'node:assert/strict';
import { resolveObjectURL } from 'node:buffer';
import test from 'node:test';
import { useEffect } from 'react';

import { refineUnderStroke } from '@/features/mesh-smoothing/refineUnderStroke';
import { replaceMeshSmoothingGeometry } from '@/features/mesh-smoothing/meshSmoothingEngine';
import { useMeshSmoothingGeometryReplacement } from '@/features/mesh-smoothing/useMeshSmoothingGeometryReplacement';
import { useSceneCollectionManager } from '@/features/scene/useSceneCollectionManager';
import { clearHistory, getUndoCount, redo, undo } from '@/history/historyStore';
import { renderWithProviders, settle } from '@/utils/__tests__/helpers/renderDom';

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

function Probe({ onRender }: { onRender: (scene: Scene) => void }) {
  const scene = useSceneCollectionManager();
  useMeshSmoothingGeometryReplacement(scene);
  useEffect(() => {
    onRender(scene);
  });
  return null;
}

async function waitFor(condition: () => boolean, label: string, timeoutMs = 10_000) {
  const start = Date.now();
  while (!condition()) {
    if (Date.now() - start > timeoutMs) assert.fail(`timed out waiting for ${label}`);
    await settle(20);
  }
}

test('a stroke that split the mesh is one undo step back to the mesh it started on', async () => {
  let mounted: Scene | null = null;
  const tree = await renderWithProviders(<Probe onRender={(next) => { mounted = next; }} />);
  const scene = () => {
    assert.ok(mounted, 'hooks mounted');
    return mounted;
  };
  try {
    await scene().loadFiles([new File([CUBE_STL], 'cube.stl', { type: 'model/stl' })]);
    await waitFor(() => scene().models.length === 1, 'the cube to load');
    await settle(50);
    clearHistory();

    const original = scene().models[0].geometry.geometry;
    const local = original.boundingBox;
    assert.ok(local, 'the loaded mesh has its bounds');
    const corner = local.max.toArray();
    const split = refineUnderStroke(original, corner, 0.5, 0.5);
    assert.ok(split, 'the 12-triangle cube is coarser than the brush');

    assert.equal(replaceMeshSmoothingGeometry(original, split), true);
    await settle(20);
    assert.equal(scene().models[0].geometry.geometry, split, 'the model now is the split mesh');
    assert.equal(scene().models[0].polygonCount, split.getAttribute('position').count / 3);
    assert.equal(getUndoCount(), 1, 'one step for the stroke');

    undo();
    await settle(20);
    assert.equal(scene().models[0].geometry.geometry, original, 'undo is the mesh the stroke started on');

    redo();
    await settle(20);
    assert.equal(scene().models[0].geometry.geometry, split, 'redo is the stroke again');
  } finally {
    clearHistory();
    tree.unmount();
  }
});
