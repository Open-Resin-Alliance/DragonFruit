import assert from 'node:assert/strict';
import { resolveObjectURL } from 'node:buffer';
import test from 'node:test';
import { useEffect } from 'react';
import { useMirrorManager } from '@/features/mirror/useMirrorManager';
import { useSceneCollectionManager } from '@/features/scene/useSceneCollectionManager';
import { useTransformManager } from '@/features/transform/useTransformManager';
import { clearHistory, getUndoCount, redo, undo } from '@/history/historyStore';
import { renderWithProviders, settle } from '@/utils/__tests__/helpers/renderDom';

type Scene = ReturnType<typeof useSceneCollectionManager>;
type Mirror = ReturnType<typeof useMirrorManager>;

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

// Stands in for the bake worker: answers with the positions reflected on the posted axes,
// or never answers, so the test can take the synchronous flush path instead.
let workerAnswers = true;
class FakeBakeWorker {
  onmessage: ((event: MessageEvent) => void) | null = null;
  onerror: (() => void) | null = null;
  postMessage(data: { positions: Float32Array; normals: Float32Array | null; indices: Uint32Array | null; posItemSize: number; axes: number[] }) {
    if (!workerAnswers) return;
    const positions = data.positions.slice();
    for (let i = 0; i < positions.length; i += data.posItemSize) {
      for (const axis of data.axes) positions[i + axis] = -positions[i + axis];
    }
    setTimeout(() => this.onmessage?.({ data: { positions, normals: null, indices: data.indices } } as MessageEvent), 0);
  }
  terminate() {}
}
globalThis.Worker = FakeBakeWorker as unknown as typeof Worker;
// The hook names its worker script with `new URL(path, import.meta.url)`, a base the test
// loader leaves unresolvable; the fake worker never reads it, so any base will do.
const DomURL = globalThis.URL;
globalThis.URL = class extends DomURL {
  constructor(url: string | URL, base?: string | URL) {
    try {
      super(url, base);
    } catch {
      super(String(url), 'file:///');
    }
  }
} as typeof URL;

type Mounted = { scene: Scene; mirror: Mirror };

function Probe({ onRender }: { onRender: (mounted: Mounted) => void }) {
  const scene = useSceneCollectionManager();
  const transformMgr = useTransformManager({ geom: scene.geom, activeModel: scene.activeModel ?? null });
  const mirror = useMirrorManager({
    scene,
    transformMgr,
    mirrorToolActive: true,
    suppressTransformPersistenceCycles: () => {},
    requestDestructiveTransformSupportDeletionWithContinuation: () => true,
  });
  useEffect(() => {
    onRender({ scene, mirror });
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

test('a mirror session is one undo step back to the unmirrored model', async (t) => {
  let mounted: Mounted | null = null;
  const tree = await renderWithProviders(<Probe onRender={(next) => { mounted = next; }} />);
  const current = () => {
    assert.ok(mounted, 'hooks mounted');
    return mounted;
  };
  try {
    await current().scene.loadFiles([new File([CUBE_STL], 'cube.stl', { type: 'model/stl' })]);
    await waitFor(() => current().scene.models.length === 1, 'the cube to load');
    const modelId = current().scene.models[0].id;
    current().scene.setActiveModelId(modelId);
    await settle(50);
    const model = () => current().scene.models[0];
    const pose = () => {
      const { position, rotation, scale } = model().transform;
      return [position.toArray(), rotation.toArray().slice(0, 3), scale.toArray()].flat().map((v) => Math.round(Number(v) * 1e6) / 1e6);
    };

    const renameThenClearHistory = async () => {
      const geometryBefore = model().geometry.geometry;
      const poseBefore = pose();
      current().scene.renameModel(modelId, 'Renamed');
      await settle(20);
      clearHistory();
      current().scene.renameModel(modelId, 'Renamed again');
      await settle(20);
      return { geometryBefore, poseBefore };
    };

    await t.test('when the bake worker answers', async () => {
      workerAnswers = true;
      const { geometryBefore, poseBefore } = await renameThenClearHistory();
      current().mirror.handleMirror('x');
      await waitFor(() => model().geometry.geometry !== geometryBefore, 'the baked geometry');
      await settle(20);
      const geometryAfter = model().geometry.geometry;
      const poseAfter = pose();
      assert.equal(getUndoCount(), 2, 'the rename and the mirror');

      undo();
      await settle(20);
      assert.equal(model().geometry.geometry, geometryBefore, 'undo restores the unmirrored geometry');
      assert.deepEqual(pose(), poseBefore, 'undo restores the transform from before the first flip');
      assert.equal(model().name, 'Renamed again', 'the step before the mirror is untouched');

      redo();
      await settle(20);
      assert.equal(model().geometry.geometry, geometryAfter);
      assert.deepEqual(pose(), poseAfter);
    });

    await t.test('when leaving the tool flushes the bake', async () => {
      workerAnswers = false;
      const { geometryBefore, poseBefore } = await renameThenClearHistory();
      current().mirror.handleMirror('y');
      await settle(20);
      current().mirror.handleMirror('x');
      await settle(20);
      current().mirror.flushPendingBake();
      await settle(20);
      assert.notEqual(model().geometry.geometry, geometryBefore);
      assert.equal(getUndoCount(), 2, 'two flips in one session are one step');

      undo();
      await settle(20);
      assert.equal(model().geometry.geometry, geometryBefore);
      assert.deepEqual(pose(), poseBefore);
      assert.equal(model().name, 'Renamed again');
    });
  } finally {
    await tree.unmount();
  }
});
