import assert from 'node:assert/strict';
import { resolveObjectURL } from 'node:buffer';
import test from 'node:test';
import * as THREE from 'three';
import { useEffect } from 'react';
import { msg } from '@lingui/core/macro';
import { useMirrorManager } from '@/features/mirror/useMirrorManager';
import { useSceneCollectionManager } from '@/features/scene/useSceneCollectionManager';
import { serializeVoxlDocumentV2 } from '@/features/scene/voxl';
import { useTransformManager } from '@/features/transform/useTransformManager';
import { clearHistory, getUndoCount, redo, undo } from '@/history/historyStore';
import { renderWithProviders, settle } from '@/utils/__tests__/helpers/renderDom';
import { computePreciseModelWorldBounds } from '@/utils/modelBounds';
import { quaternionFromGlobalEuler } from '@/utils/rotation';

type Scene = ReturnType<typeof useSceneCollectionManager>;
type Mirror = ReturnType<typeof useMirrorManager>;
type TransformMgr = ReturnType<typeof useTransformManager>;

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
let deferWorkerAnswers = false;
const manualWorkerReplies: Array<() => void> = [];
class FakeBakeWorker {
  onmessage: ((event: MessageEvent) => void) | null = null;
  onerror: (() => void) | null = null;
  private terminated = false;
  postMessage(data: { positions: Float32Array; normals: Float32Array | null; indices: Uint32Array | null; posItemSize: number; axes: number[] }) {
    if (!workerAnswers) return;
    const positions = data.positions.slice();
    for (const axis of data.axes) {
      for (let i = 0; i < positions.length; i += data.posItemSize) {
        positions[i + axis] = -positions[i + axis];
      }
      if (!data.indices) {
        const stride = data.posItemSize * 3;
        const triCount = Math.floor(positions.length / stride);
        for (let t = 0; t < triCount; t += 1) {
          const baseA = t * stride + data.posItemSize;
          const baseB = baseA + data.posItemSize;
          for (let c = 0; c < data.posItemSize; c += 1) {
            const tmp = positions[baseA + c];
            positions[baseA + c] = positions[baseB + c];
            positions[baseB + c] = tmp;
          }
        }
      }
    }
    const deliver = () => {
      if (this.terminated) return;
      this.onmessage?.({ data: { positions, normals: null, indices: data.indices } } as MessageEvent);
    };
    if (deferWorkerAnswers) {
      manualWorkerReplies.push(deliver);
    } else {
      setTimeout(deliver, 0);
    }
  }
  terminate() {
    this.terminated = true;
  }
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

type Mounted = { scene: Scene; mirror: Mirror; transformMgr: TransformMgr };

const zModalControl: { defer: boolean; pendingContinue: (() => void) | null } = {
  defer: false,
  pendingContinue: null,
};
const takePendingZContinue = () => {
  const fn = zModalControl.pendingContinue;
  zModalControl.pendingContinue = null;
  return fn;
};

function Probe({ onRender }: { onRender: (mounted: Mounted) => void }) {
  const scene = useSceneCollectionManager();
  const transformMgr = useTransformManager({ geom: scene.geom, activeModel: scene.activeModel ?? null });
  const mirror = useMirrorManager({
    scene,
    transformMgr,
    mirrorToolActive: true,
    suppressTransformPersistenceCycles: () => {},
    requestDestructiveTransformSupportDeletionWithContinuation: (_label, onContinue) => {
      if (zModalControl.defer) {
        zModalControl.pendingContinue = onContinue;
        return false;
      }
      return true;
    },
  });
  useEffect(() => {
    onRender({ scene, mirror, transformMgr });
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

    await t.test('the display mesh is reflected with its AO, not derived again', async () => {
      // No native side here, so no refine: the test hands the model a display mesh
      // the way a loaded one carries it, then checks it comes back reflected.
      workerAnswers = true;
      const display = model().geometry.geometry.toNonIndexed();
      const corners = display.getAttribute('position').count;
      display.setAttribute('aBakedAo', new THREE.BufferAttribute(Float32Array.from({ length: corners }, (_, i) => i / corners), 1));
      model().geometry.displayGeometry = display;
      const geometryBefore = model().geometry.geometry;
      current().mirror.handleMirror('z');
      await waitFor(() => model().geometry.geometry !== geometryBefore, 'the baked geometry');
      const reflected = model().geometry.displayGeometry;
      assert.ok(reflected && reflected !== display, 'the mirrored model lands with its own display mesh');
      assert.ok(reflected.getAttribute('aBakedAo'), 'and with its AO, so no frame draws it unoccluded');
      const before = display.getAttribute('position').array;
      const after = reflected.getAttribute('position').array;
      // Corner 0 keeps its place; corners 1 and 2 swap to keep the triangle facing out.
      assert.deepEqual([after[0], after[1], after[2]], [before[0], before[1], -before[2]]);
      assert.equal(reflected.getAttribute('aBakedAo').getX(2), display.getAttribute('aBakedAo').getX(1));
    });
  } finally {
    await tree.unmount();
  }
});

const WEDGE_STL = `solid wedge
${[
  [[0, 0, 0], [0, 10, 0], [10, 0, 0]],
  [[0, 0, 0], [10, 0, 0], [0, 0, 10]],
  [[0, 0, 0], [0, 0, 10], [0, 10, 0]],
  [[10, 0, 0], [0, 10, 0], [0, 0, 10]],
].map((tri) => `facet normal 0 0 0
outer loop
${tri.map((v) => `vertex ${v.join(' ')}`).join('\n')}
endloop
endfacet`).join('\n')}
endsolid wedge
`;

function collectWorldVertices(geometryData: Scene['models'][number]['geometry'], transform: Scene['models'][number]['transform']): number[][] {
  const posAttr = geometryData.geometry.getAttribute('position') as THREE.BufferAttribute;
  const mat = new THREE.Matrix4().compose(
    transform.position.clone(),
    quaternionFromGlobalEuler(transform.rotation),
    transform.scale.clone(),
  );
  const out: number[][] = [];
  const v = new THREE.Vector3();
  for (let i = 0; i < posAttr.count; i += 1) {
    v.fromBufferAttribute(posAttr, i).sub(geometryData.center).applyMatrix4(mat);
    out.push([
      Math.round(v.x * 1e4) / 1e4,
      Math.round(v.y * 1e4) / 1e4,
      Math.round(v.z * 1e4) / 1e4,
    ]);
  }
  out.sort((a, b) => (a[0] - b[0]) || (a[1] - b[1]) || (a[2] - b[2]));
  return out;
}

test('commitMirror clears stale sourcePath and originalRef with undo/redo symmetry', async () => {
  workerAnswers = true;
  deferWorkerAnswers = false;
  zModalControl.defer = false;
  zModalControl.pendingContinue = null;
  let mounted: Mounted | null = null;
  const tree = await renderWithProviders(<Probe onRender={(next) => { mounted = next; }} />);
  const current = () => {
    assert.ok(mounted, 'hooks mounted');
    return mounted;
  };
  try {
    const bin = await serializeVoxlDocumentV2(
      {
        models: [{
          id: 'mirror-voxl-0',
          name: 'voxl-cube',
          visible: true,
          color: '#ffffff',
          polygonCount: 12,
          sourcePath: '/tmp/mirror-source.stl',
          originalRef: {
            mode: 'external-file',
            fileName: 'sidecars/mirror-orig.stl',
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
        activeModelId: 'mirror-voxl-0',
        selectedModelIds: [],
        supports: { version: 1, meta: { source: 'test', objectCenter: { x: 0, y: 0, z: 0 } }, roots: [] } as never,
      },
      new Map([[0, new TextEncoder().encode(CUBE_STL)]]),
      undefined,
      { embedOriginalMesh: false },
    );
    const ok = await current().scene.importSceneFiles([
      new File([Uint8Array.from(bin).buffer], 'mirror-source.voxl', { type: 'application/octet-stream' }),
    ]);
    assert.equal(ok, true);
    await waitFor(() => current().scene.models.length === 1, 'voxl model load');
    const modelId = current().scene.models[0].id;
    current().scene.setActiveModelId(modelId);
    await settle(50);

    const model = () => current().scene.models[0];
    assert.equal(model().sourcePath, '/tmp/mirror-source.stl');
    assert.equal(model().originalRef?.fileName, 'sidecars/mirror-orig.stl');

    clearHistory();
    const geomBefore = model().geometry.geometry;
    current().mirror.handleMirror('x');
    await waitFor(() => model().geometry.geometry !== geomBefore, 'mirror bake commit');
    await settle(20);

    assert.equal(model().sourcePath, null, 'commitMirror must clear sourcePath');
    assert.equal(model().originalRef, undefined, 'commitMirror must clear originalRef');

    undo();
    await settle(20);
    assert.equal(model().sourcePath, '/tmp/mirror-source.stl', 'undo restores sourcePath');
    assert.equal(model().originalRef?.fileName, 'sidecars/mirror-orig.stl', 'undo restores originalRef');

    redo();
    await settle(20);
    assert.equal(model().sourcePath, null, 'redo clears sourcePath');
    assert.equal(model().originalRef, undefined, 'redo clears originalRef');
  } finally {
    await tree.unmount();
  }
});

test('tilted Z-mirror preserves exact minZ/maxZ and double-flip is involutive', async () => {
  workerAnswers = true;
  deferWorkerAnswers = false;
  zModalControl.defer = false;
  zModalControl.pendingContinue = null;
  let mounted: Mounted | null = null;
  const tree = await renderWithProviders(<Probe onRender={(next) => { mounted = next; }} />);
  const current = () => {
    assert.ok(mounted, 'hooks mounted');
    return mounted;
  };
  try {
    await current().scene.loadFiles([new File([WEDGE_STL], 'wedge.stl', { type: 'model/stl' })]);
    await waitFor(() => current().scene.models.length === 1, 'wedge load');
    const modelId = current().scene.models[0].id;
    current().scene.setActiveModelId(modelId);
    await settle(30);

    const model = () => current().scene.models[0];
    current().scene.updateModelTransform(modelId, {
      position: new THREE.Vector3(10, -5, 12),
      rotation: new THREE.Euler(0.7, 0.4, 0.2, 'ZYX'),
      scale: new THREE.Vector3(1, 1, 1),
    });
    await settle(30);
    clearHistory();

    const beforeBounds = computePreciseModelWorldBounds(model().geometry, model().transform);
    const beforeVerts = collectWorldVertices(model().geometry, model().transform);
    const geom0 = model().geometry.geometry;

    current().mirror.handleMirror('z');
    await waitFor(() => model().geometry.geometry !== geom0 && current().mirror.mirrorSessionRef.current === null, 'first Z bake');
    await settle(20);

    const onceBounds = computePreciseModelWorldBounds(model().geometry, model().transform);
    assert.ok(Math.abs(onceBounds.min.z - beforeBounds.min.z) < 1e-4, `minZ shifted: ${onceBounds.min.z} vs ${beforeBounds.min.z}`);
    assert.ok(Math.abs(onceBounds.max.z - beforeBounds.max.z) < 1e-4, `maxZ shifted: ${onceBounds.max.z} vs ${beforeBounds.max.z}`);

    const geom1 = model().geometry.geometry;
    current().mirror.handleMirror('z');
    await waitFor(() => model().geometry.geometry !== geom1 && current().mirror.mirrorSessionRef.current === null, 'second Z bake');
    await settle(20);

    const twiceBounds = computePreciseModelWorldBounds(model().geometry, model().transform);
    assert.ok(twiceBounds.min.distanceTo(beforeBounds.min) < 1e-4, 'double Z-mirror restores min bounds');
    assert.ok(twiceBounds.max.distanceTo(beforeBounds.max) < 1e-4, 'double Z-mirror restores max bounds');
    assert.deepEqual(collectWorldVertices(model().geometry, model().transform), beforeVerts, 'double Z-mirror is involutive');
  } finally {
    await tree.unmount();
  }
});

test('deferred Z-modal onContinue after an in-flight X bake settles does not strand negative scale', async () => {
  workerAnswers = true;
  deferWorkerAnswers = true;
  manualWorkerReplies.length = 0;
  zModalControl.defer = true;
  zModalControl.pendingContinue = null;
  let mounted: Mounted | null = null;
  const tree = await renderWithProviders(<Probe onRender={(next) => { mounted = next; }} />);
  const current = () => {
    assert.ok(mounted, 'hooks mounted');
    return mounted;
  };
  try {
    await current().scene.loadFiles([new File([CUBE_STL], 'cube.stl', { type: 'model/stl' })]);
    await waitFor(() => current().scene.models.length === 1, 'cube load');
    const modelId = current().scene.models[0].id;
    current().scene.setActiveModelId(modelId);
    await settle(50);

    const model = () => current().scene.models[0];
    const geom0 = model().geometry.geometry;

    // 1. Trigger X mirror: worker is now in-flight.
    current().mirror.handleMirror('x');
    assert.equal(manualWorkerReplies.length, 1, 'X bake worker started');

    // 2. User clicks Z mirror while X bake is still in-flight -> confirmation modal defers onContinue.
    current().mirror.handleMirror('z');
    assert.ok(zModalControl.pendingContinue, 'Z modal captured deferred onContinue');

    // 3. In-flight X worker completes while modal is open, clearing mirrorSessionRef.current.
    manualWorkerReplies.shift()!();
    await waitFor(() => model().geometry.geometry !== geom0 && current().mirror.mirrorSessionRef.current === null, 'X bake settled');
    await settle(30);
    const geomAfterX = model().geometry.geometry;

    // 4. User confirms the Z modal -> must initialize a fresh session from live post-X model and bake cleanly.
    const continueZ = takePendingZContinue();
    assert.ok(continueZ, 'deferred Z continuation must be available');
    continueZ();
    await settle(20);

    assert.equal(manualWorkerReplies.length, 1, 'deferred Z continuation must schedule a new bake worker');
    manualWorkerReplies.shift()!();
    await waitFor(() => model().geometry.geometry !== geomAfterX && current().mirror.mirrorSessionRef.current === null, 'Z bake settled');
    await settle(20);

    const { scale } = model().transform;
    assert.ok(scale.x > 0 && scale.y > 0 && scale.z > 0, `scale must not remain negative: ${scale.toArray().join(',')}`);
  } finally {
    deferWorkerAnswers = false;
    manualWorkerReplies.length = 0;
    zModalControl.defer = false;
    zModalControl.pendingContinue = null;
    await tree.unmount();
  }
});

test('worker bake preserves source.groups and swaps extra non-indexed attribute winding on odd flips', async () => {
  workerAnswers = true;
  deferWorkerAnswers = false;
  zModalControl.defer = false;
  zModalControl.pendingContinue = null;
  let mounted: Mounted | null = null;
  const tree = await renderWithProviders(<Probe onRender={(next) => { mounted = next; }} />);
  const current = () => {
    assert.ok(mounted, 'hooks mounted');
    return mounted;
  };
  try {
    await current().scene.loadFiles([new File([CUBE_STL], 'cube.stl', { type: 'model/stl' })]);
    await waitFor(() => current().scene.models.length === 1, 'cube load');
    const modelId = current().scene.models[0].id;
    current().scene.setActiveModelId(modelId);
    await settle(30);

    const src = new THREE.BufferGeometry();
    src.setAttribute('position', new THREE.BufferAttribute(new Float32Array([
      1, 0, 0,
      0, 2, 0,
      0, 0, 3,
    ]), 3));
    const srcColor = new THREE.BufferAttribute(new Float32Array([1, 0, 0, 0, 1, 0, 0, 0, 1]), 3);
    const srcUv = new THREE.BufferAttribute(new Float32Array([0, 0, 1, 0, 0, 1]), 2);
    const srcAo = new THREE.BufferAttribute(new Float32Array([0.1, 0.5, 0.9]), 1);
    src.setAttribute('color', srcColor);
    src.setAttribute('uv', srcUv);
    src.setAttribute('aBakedOcclusion', srcAo);
    src.addGroup(0, 3, 2);

    current().scene.replaceModelGeometry(modelId, src, msg`Set multi-attr geom`);
    await settle(30);

    const model = () => current().scene.models[0];
    current().mirror.handleMirror('x');
    await waitFor(() => model().geometry.geometry !== src, 'worker bake commit');
    await settle(20);

    const baked = model().geometry.geometry;
    assert.deepEqual(baked.groups, [{ start: 0, count: 3, materialIndex: 2 }], 'source.groups preserved');
    assert.notEqual(baked.getAttribute('color'), srcColor, 'color attribute cloned, not shared');
    assert.deepEqual(Array.from(baked.getAttribute('color').array as Float32Array), [1, 0, 0, 0, 0, 1, 0, 1, 0]);
    assert.deepEqual(Array.from(baked.getAttribute('uv').array as Float32Array), [0, 0, 0, 1, 1, 0]);
    assert.deepEqual(
      Array.from(baked.getAttribute('aBakedOcclusion').array as Float32Array).map((v) => Math.round(v * 1e6) / 1e6),
      [0.1, 0.9, 0.5],
    );
  } finally {
    await tree.unmount();
  }
});

function signedVolume(geometry: THREE.BufferGeometry): number {
  const posAttr = geometry.getAttribute('position') as THREE.BufferAttribute;
  const idx = geometry.getIndex();
  const a = new THREE.Vector3();
  const b = new THREE.Vector3();
  const c = new THREE.Vector3();
  const cross = new THREE.Vector3();
  let sum = 0;
  if (idx) {
    for (let i = 0; i + 2 < idx.count; i += 3) {
      a.fromBufferAttribute(posAttr, idx.getX(i));
      b.fromBufferAttribute(posAttr, idx.getX(i + 1));
      c.fromBufferAttribute(posAttr, idx.getX(i + 2));
      cross.crossVectors(b, c);
      sum += a.dot(cross);
    }
  } else {
    for (let i = 0; i + 2 < posAttr.count; i += 3) {
      a.fromBufferAttribute(posAttr, i);
      b.fromBufferAttribute(posAttr, i + 1);
      c.fromBufferAttribute(posAttr, i + 2);
      cross.crossVectors(b, c);
      sum += a.dot(cross);
    }
  }
  return sum / 6;
}

test('rapid same-tick handleMirror(x) then handleMirror(y) and handleMirror(x) then handleMirror(x) before re-render', async (t) => {
  workerAnswers = true;
  deferWorkerAnswers = false;
  zModalControl.defer = false;
  zModalControl.pendingContinue = null;
  let mounted: Mounted | null = null;
  const tree = await renderWithProviders(<Probe onRender={(next) => { mounted = next; }} />);
  const current = () => {
    assert.ok(mounted, 'hooks mounted');
    return mounted;
  };
  try {
    await current().scene.loadFiles([new File([WEDGE_STL], 'wedge.stl', { type: 'model/stl' })]);
    await waitFor(() => current().scene.models.length === 1, 'wedge load');
    const modelId = current().scene.models[0].id;
    current().scene.setActiveModelId(modelId);
    await settle(40);

    const model = () => current().scene.models[0];

    await t.test('same-tick X then Y produces positive scale (+1,+1,+1), outward normals, and clones non-swapped attributes', async () => {
      const src = new THREE.BufferGeometry();
      src.setAttribute('position', new THREE.BufferAttribute(new Float32Array([
        0, 0, 0,  0, 10, 0,  10, 0, 0,
        0, 0, 0,  10, 0, 0,  0, 0, 10,
        0, 0, 0,  0, 0, 10,  0, 10, 0,
        10, 0, 0,  0, 10, 0,  0, 0, 10,
      ]), 3));
      src.computeVertexNormals();
      const srcColor = new THREE.BufferAttribute(new Float32Array(12 * 3).fill(0.5), 3);
      src.setAttribute('color', srcColor);
      current().scene.replaceModelGeometry(modelId, src, msg`Set wedge geom`);
      await settle(40);

      const boundsBefore = computePreciseModelWorldBounds(model().geometry, model().transform);
      const pivot = boundsBefore.getCenter(new THREE.Vector3());
      const expectedVerts = collectWorldVertices(model().geometry, model().transform).map(([vx, vy, vz]) => [
        Math.round((2 * pivot.x - vx) * 1e4) / 1e4,
        Math.round((2 * pivot.y - vy) * 1e4) / 1e4,
        Math.round(vz * 1e4) / 1e4,
      ]).sort((a, b) => (a[0] - b[0]) || (a[1] - b[1]) || (a[2] - b[2]));

      // Fire X then Y synchronously before React re-renders.
      current().mirror.handleMirror('x');
      current().mirror.handleMirror('y');

      await waitFor(() => model().geometry.geometry !== src && current().mirror.mirrorSessionRef.current === null, 'X+Y bake');
      await settle(30);

      const { scale } = model().transform;
      assert.ok(
        Math.abs(scale.x - 1) < 1e-4 && Math.abs(scale.y - 1) < 1e-4 && Math.abs(scale.z - 1) < 1e-4,
        `expected positive scale (+1,+1,+1), got (${scale.x}, ${scale.y}, ${scale.z})`,
      );
      assert.ok(signedVolume(model().geometry.geometry) > 0, 'baked geometry must keep outward normals');
      assert.notEqual(model().geometry.geometry.getAttribute('color'), srcColor, 'even-flip extra BufferAttribute must be cloned, not aliased');
      assert.deepEqual(
        collectWorldVertices(model().geometry, model().transform),
        expectedVerts,
        'baked world vertices must reflect across both X and Y',
      );
    });

    await t.test('same-tick X then X resets transform to (+1,+1,+1) with no stranded negative scale', async () => {
      await settle(20);
      const geomBefore = model().geometry.geometry;
      const scaleBefore = model().transform.scale.clone();

      // Fire X twice synchronously before React re-renders.
      current().mirror.handleMirror('x');
      current().mirror.handleMirror('x');
      await settle(40);

      assert.equal(current().mirror.mirrorSessionRef.current, null, 'net-zero double X clears session');
      assert.equal(model().geometry.geometry, geomBefore, 'net-zero double X skips bake');
      const { scale } = model().transform;
      assert.ok(
        Math.abs(scale.x - scaleBefore.x) < 1e-4 &&
        Math.abs(scale.y - scaleBefore.y) < 1e-4 &&
        Math.abs(scale.z - scaleBefore.z) < 1e-4 &&
        scale.x > 0 && scale.y > 0 && scale.z > 0,
        `expected reset scale (+1,+1,+1), got (${scale.x}, ${scale.y}, ${scale.z})`,
      );
      const hookScale = current().transformMgr.transformHook.transform.scale;
      assert.ok(
        hookScale.x > 0 && hookScale.y > 0 && hookScale.z > 0,
        `transformHook scale must also reset to positive, got (${hookScale.x}, ${hookScale.y}, ${hookScale.z})`,
      );
    });

    await t.test('same-tick X then Y followed by flushPendingBake() (sync fallback) produces positive scale (+1,+1,+1), outward normals, and reflected vertices', async () => {
      workerAnswers = false;
      try {
        const srcSync = new THREE.BufferGeometry();
        srcSync.setAttribute('position', new THREE.BufferAttribute(new Float32Array([
          0, 0, 0,  0, 10, 0,  10, 0, 0,
          0, 0, 0,  10, 0, 0,  0, 0, 10,
          0, 0, 0,  0, 0, 10,  0, 10, 0,
          10, 0, 0,  0, 10, 0,  0, 0, 10,
        ]), 3));
        srcSync.computeVertexNormals();
        current().scene.replaceModelGeometry(modelId, srcSync, msg`Set wedge geom for sync flush`);
        await settle(40);

        const boundsBefore = computePreciseModelWorldBounds(model().geometry, model().transform);
        const pivot = boundsBefore.getCenter(new THREE.Vector3());
        const expectedVerts = collectWorldVertices(model().geometry, model().transform).map(([vx, vy, vz]) => [
          Math.round((2 * pivot.x - vx) * 1e4) / 1e4,
          Math.round((2 * pivot.y - vy) * 1e4) / 1e4,
          Math.round(vz * 1e4) / 1e4,
        ]).sort((a, b) => (a[0] - b[0]) || (a[1] - b[1]) || (a[2] - b[2]));

        // Fire X then Y synchronously before React re-renders, then flush synchronously.
        current().mirror.handleMirror('x');
        current().mirror.handleMirror('y');
        current().mirror.flushPendingBake();
        await settle(30);

        assert.equal(current().mirror.mirrorSessionRef.current, null, 'flushPendingBake clears mirror session');
        assert.notEqual(model().geometry.geometry, srcSync, 'flushPendingBake commits baked geometry');
        const { scale } = model().transform;
        assert.ok(
          Math.abs(scale.x - 1) < 1e-4 && Math.abs(scale.y - 1) < 1e-4 && Math.abs(scale.z - 1) < 1e-4,
          `expected positive scale (+1,+1,+1), got (${scale.x}, ${scale.y}, ${scale.z})`,
        );
        const hookScale = current().transformMgr.transformHook.transform.scale;
        assert.ok(
          Math.abs(hookScale.x - 1) < 1e-4 && Math.abs(hookScale.y - 1) < 1e-4 && Math.abs(hookScale.z - 1) < 1e-4,
          `expected transformHook positive scale (+1,+1,+1), got (${hookScale.x}, ${hookScale.y}, ${hookScale.z})`,
        );
        assert.ok(signedVolume(model().geometry.geometry) > 0, 'flushed geometry must keep outward normals');
        assert.deepEqual(
          collectWorldVertices(model().geometry, model().transform),
          expectedVerts,
          'flushed world vertices must reflect across both X and Y',
        );
      } finally {
        workerAnswers = true;
      }
    });
  } finally {
    await tree.unmount();
  }
});

test('commitMirror disposes baked geometry when target model is deleted and skips transformHook overwrite for inactive model', async (t) => {
  workerAnswers = true;
  deferWorkerAnswers = true;
  manualWorkerReplies.length = 0;
  zModalControl.defer = false;
  zModalControl.pendingContinue = null;
  let mounted: Mounted | null = null;
  const tree = await renderWithProviders(<Probe onRender={(next) => { mounted = next; }} />);
  const current = () => {
    assert.ok(mounted, 'hooks mounted');
    return mounted;
  };
  try {
    await t.test('deleted model: baked geometry is disposed and active model transformHook is untouched', async () => {
      await current().scene.loadFiles([
        new File([CUBE_STL], 'cube-a.stl', { type: 'model/stl' }),
        new File([WEDGE_STL], 'wedge-b.stl', { type: 'model/stl' }),
      ]);
      await waitFor(() => current().scene.models.length === 2, 'two models loaded');
      const modelA = current().scene.models[0];
      const modelB = current().scene.models[1];

      current().scene.setActiveModelId(modelA.id);
      await settle(30);

      current().mirror.handleMirror('x');
      assert.equal(manualWorkerReplies.length, 1, 'worker queued for model A');

      // Delete model A and switch active model to B with distinct transform values.
      current().scene.deleteModel(modelA.id);
      current().scene.setActiveModelId(modelB.id);
      current().transformMgr.transformHook.setPosition(42, 43, 44);
      await settle(30);

      const disposedGeometries: THREE.BufferGeometry[] = [];
      const origDispose = THREE.BufferGeometry.prototype.dispose;
      THREE.BufferGeometry.prototype.dispose = function patchedDispose(this: THREE.BufferGeometry) {
        disposedGeometries.push(this);
        return origDispose.call(this);
      };
      try {
        manualWorkerReplies.shift()!();
        await settle(30);
      } finally {
        THREE.BufferGeometry.prototype.dispose = origDispose;
      }

      assert.ok(
        disposedGeometries.some((g) => g !== modelA.geometry.geometry && g !== modelB.geometry.geometry),
        'baked BufferGeometry must be disposed when target model no longer exists',
      );
      const pos = current().transformMgr.transformHook.transform.position;
      assert.deepEqual(
        [pos.x, pos.y, pos.z],
        [42, 43, 44],
        'transformHook must not be overwritten when deleted model bake finishes',
      );

      // Clean remaining model for next subtest.
      current().scene.deleteModel(modelB.id);
      await settle(20);
    });

    await t.test('inactive model: geometry commits to target model without overwriting different active model transformHook', async () => {
      manualWorkerReplies.length = 0;
      await current().scene.loadFiles([
        new File([CUBE_STL], 'cube-a2.stl', { type: 'model/stl' }),
        new File([WEDGE_STL], 'wedge-b2.stl', { type: 'model/stl' }),
      ]);
      await waitFor(() => current().scene.models.length === 2, 'two models loaded');
      const modelAId = current().scene.models[0].id;
      const modelBId = current().scene.models[1].id;
      const geomABefore = current().scene.models[0].geometry.geometry;

      current().scene.setActiveModelId(modelAId);
      await settle(30);

      current().mirror.handleMirror('x');
      assert.equal(manualWorkerReplies.length, 1, 'worker queued for model A');

      // Switch active model to B before A's worker commits.
      current().scene.setActiveModelId(modelBId);
      current().transformMgr.transformHook.setPosition(88, 99, 11);
      await settle(30);

      manualWorkerReplies.shift()!();
      await waitFor(
        () => current().scene.models.find((m) => m.id === modelAId)?.geometry.geometry !== geomABefore,
        'inactive model A receives baked geometry',
      );
      await settle(20);

      const pos = current().transformMgr.transformHook.transform.position;
      assert.deepEqual(
        [pos.x, pos.y, pos.z],
        [88, 99, 11],
        'active model B transformHook must not be overwritten by inactive model A bake commit',
      );
    });
  } finally {
    deferWorkerAnswers = false;
    manualWorkerReplies.length = 0;
    await tree.unmount();
  }
});
