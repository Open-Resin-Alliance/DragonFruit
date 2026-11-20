import assert from 'node:assert/strict';
import { resolveObjectURL } from 'node:buffer';
import test from 'node:test';
import { strToU8, zipSync } from 'fflate';
import { useEffect } from 'react';
import { clearHistory, getUndoCount, redo, undo } from '@/history/historyStore';
import { renderWithProviders, settle } from '@/utils/__tests__/helpers/renderDom';
import { useSceneCollectionManager } from '../useSceneCollectionManager';

type Scene = ReturnType<typeof useSceneCollectionManager>;

// The importer reads the dropped file back through a `blob:` URL, which happy-dom's fetch
// refuses; the URL is Node's, so Node can resolve it.
const domFetch = globalThis.fetch;
globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
  const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
  const blob = url.startsWith('blob:') ? resolveObjectURL(url) : undefined;
  return blob ? new Response(await blob.arrayBuffer()) : domFetch(input, init);
}) as typeof fetch;

const CUBE_VERTICES = [
  [0, 0, 0], [10, 0, 0], [10, 10, 0], [0, 10, 0],
  [0, 0, 10], [10, 0, 10], [10, 10, 10], [0, 10, 10],
];
const CUBE_TRIANGLES = [
  [0, 2, 1], [0, 3, 2], [4, 5, 6], [4, 6, 7], [0, 1, 5], [0, 5, 4],
  [1, 2, 6], [1, 6, 5], [2, 3, 7], [2, 7, 6], [3, 0, 4], [3, 4, 7],
];

/** A 3MF with three cubes as separate build items, 20 mm apart along X. */
function threeCube3mf(): Blob {
  const mesh = `<mesh><vertices>${CUBE_VERTICES.map(([x, y, z]) => `<vertex x="${x}" y="${y}" z="${z}"/>`).join('')}</vertices>`
    + `<triangles>${CUBE_TRIANGLES.map(([a, b, c]) => `<triangle v1="${a}" v2="${b}" v3="${c}"/>`).join('')}</triangles></mesh>`;
  const model = '<?xml version="1.0" encoding="UTF-8"?>'
    + '<model unit="millimeter" xmlns="http://schemas.microsoft.com/3dmanufacturing/core/2015/02">'
    + `<resources><object id="1" type="model">${mesh}</object></resources>`
    + '<build>'
    + [0, 20, 40].map((x) => `<item objectid="1" transform="1 0 0 0 1 0 0 0 1 ${x} 0 0"/>`).join('')
    + '</build></model>';
  const zip = zipSync({
    '[Content_Types].xml': strToU8('<?xml version="1.0" encoding="UTF-8"?>'
      + '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">'
      + '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>'
      + '<Default Extension="model" ContentType="application/vnd.ms-package.3dmanufacturing-3dmodel+xml"/>'
      + '</Types>'),
    '_rels/.rels': strToU8('<?xml version="1.0" encoding="UTF-8"?>'
      + '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">'
      + '<Relationship Target="/3D/3dmodel.model" Id="rel0" Type="http://schemas.microsoft.com/3dmanufacturing/2013/01/3dmodel"/>'
      + '</Relationships>'),
    '3D/3dmodel.model': strToU8(model),
  });
  return new Blob([new Uint8Array(zip)]);
}

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

test('deleting a body of a 3MF keeps the model and is one undo step', async () => {
  const { tree, scene } = await mountScene();
  try {
    await scene().loadFiles([new File([threeCube3mf()], 'cubes.3mf', { type: 'model/3mf' })]);
    await waitFor(() => scene().models.length === 1, 'the 3MF to load');
    await settle(50);
    const id = scene().models[0].id;
    const model = () => scene().models.find((candidate) => candidate.id === id);
    const original = model()!;
    assert.equal(original.splitBodies?.length, 3, 'the 3MF loads as one model with three bodies');

    clearHistory();
    assert.equal(scene().deleteModelBodies(id, [1]), true);
    await settle(20);
    assert.equal(scene().models.length, 1, 'the model stays in the scene');
    assert.deepEqual(model()?.splitBodies, [original.splitBodies![0], original.splitBodies![2]]);
    assert.equal(model()?.polygonCount, 24);
    assert.equal(getUndoCount(), 1);

    undo();
    await settle(20);
    assert.equal(model()?.splitBodies?.length, 3, 'undo brings the body back');
    assert.equal(model()?.geometry.geometry, original.geometry.geometry);
    redo();
    await settle(20);
    assert.equal(model()?.splitBodies?.length, 2, 'redo removes it again');

    assert.equal(scene().deleteModelBodies(id, [0, 1]), true);
    await waitFor(() => scene().models.length === 0, 'the emptied model to go');
  } finally {
    await tree.unmount();
  }
});
