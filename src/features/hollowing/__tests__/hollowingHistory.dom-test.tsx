import assert from 'node:assert/strict';
import { resolveObjectURL } from 'node:buffer';
import test from 'node:test';
import { useEffect, useRef } from 'react';
import { clearMocks, mockIPC } from '@tauri-apps/api/mocks';
import { useHollowingManager, type HollowingManagerDeps } from '@/features/hollowing/useHollowingManager';
import { useSceneCollectionManager } from '@/features/scene/useSceneCollectionManager';
import { useTransformManager } from '@/features/transform/useTransformManager';
import { clearHistory, getUndoCount, redo, undo } from '@/history/historyStore';
import { renderWithProviders, settle } from '@/utils/__tests__/helpers/renderDom';

type Scene = ReturnType<typeof useSceneCollectionManager>;
type Hollowing = ReturnType<typeof useHollowingManager>;

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

type Mounted = { scene: Scene; hollowing: Hollowing };

function Probe({ onRender }: { onRender: (mounted: Mounted) => void }) {
  const scene = useSceneCollectionManager();
  const transformMgr = useTransformManager({ geom: scene.geom });
  const noop = () => {};
  const deps = useRef<HollowingManagerDeps>({
    showOperationError: (message) => assert.fail(message),
    setShowDamagedModelDialog: () => assert.fail('the damaged-model dialog opened'),
    beginFinalizing: noop,
    clearFinalizing: noop,
    nextPaint: () => Promise.resolve(),
    persistActiveModelModifiers: noop,
    setPendingModifierResetAction: noop,
    setInteriorView: noop,
    computeAutoHolePunchDepthMmForGeometry: () => 3,
    setHolePunchState: noop,
    setHolePunchPlacements: noop,
    holePunchPlacementsRef: { current: [] },
    setPendingHolePunchAutoApplyModelId: noop,
    setPendingBlockerResetState: noop,
    setSelectedHolePunchPlacementIds: noop,
    setHoveredHolePunchPlacementId: noop,
    setHolePunchHoverPlacement: noop,
    interiorView: false,
  });
  const hollowing = useHollowingManager({ scene, transformMgr, deps });

  useEffect(() => {
    deps.current.persistActiveModelModifiers = (next, options) => {
      if (scene.activeModelId) scene.setModelMeshModifiers(scene.activeModelId, next, options);
    };
    onRender({ scene, hollowing });
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

test('hollowing edits land in undo history', async (t) => {
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
    const hollowingModifier = () => current().scene.getModelMeshModifiers(modelId)?.hollowing;

    await t.test('ordinary pose edits do not warm hollowing, and intent warmup stays unmaterialized', async () => {
      const tauriWindow = window as unknown as { __TAURI_INTERNALS__?: unknown };
      tauriWindow.__TAURI_INTERNALS__ ??= {};
      const calls: string[] = [];
      const original = current().scene.models[0].transform;
      mockIPC((cmd) => {
        calls.push(cmd);
        if (cmd === 'mesh_hollow_preview_from_captured_source') return '{}';
        if (cmd === 'mesh_hollow_preview_read_positions') {
          return new Uint8Array(new Float32Array([0, 0, 0, 1, 0, 0, 0, 1, 0]).buffer);
        }
        if (cmd.startsWith('mesh_hollow_preview_read_')) throw new Error('no optional data');
        return null;
      });
      try {
        const changed = { position: original.position.clone(), rotation: original.rotation.clone(), scale: original.scale.clone() };
        changed.rotation.y += 0.4;
        changed.scale.multiplyScalar(1.2);
        current().scene.setModelTransformRaw(modelId, changed);
        await settle(80);
        assert.equal(calls.filter(cmd => cmd.startsWith('mesh_hollow_preview_')).length, 0);
        await current().hollowing.primeHollowPreviewCache(current().scene.models[0]);
        assert.ok(calls.includes('mesh_hollow_preview_from_captured_source'), 'the bridge works for explicit intent');
        await settle(80);
        const key = current().hollowing.buildHollowPreviewRequest(current().scene.models[0]).previewKey;
        const entry = current().hollowing.hollowPreviewResultCacheRef.current.get(key);
        assert.ok(entry);
        assert.equal(entry.previewGeometry, null, 'idle time does not build unused render geometry');
        const materialized = current().hollowing.materializeHollowPreviewCacheEntry(key);
        assert.ok(materialized);
        assert.ok(materialized.previewGeometry);
        assert.ok(materialized.previewGeometry.getAttribute('normal'));
        assert.ok(materialized.previewGeometry.boundingBox);
        materialized.previewGeometry.dispose();
        current().hollowing.hollowPreviewResultCacheRef.current.clear();
      } finally {
        clearMocks();
        delete tauriWindow.__TAURI_INTERNALS__;
        current().scene.setModelTransformRaw(modelId, original);
        await settle(20);
      }
    });

    await t.test('a run of settings edits is one step', async () => {
      clearHistory();
      for (const shellThicknessMm of [2.2, 2.4, 2.6]) {
        current().hollowing.handleHollowingStateChange({ ...current().hollowing.hollowingState, shellThicknessMm });
        await settle(20);
      }
      assert.equal(hollowingModifier()?.shellThicknessMm, 2.6);
      assert.equal(getUndoCount(), 1);
      undo();
      await settle(20);
      assert.equal(hollowingModifier(), undefined, 'undo returns to no hollowing draft');
      redo();
      await settle(20);
      assert.equal(hollowingModifier()?.shellThicknessMm, 2.6);
    });

    await t.test('blocker edits are global steps, inside the edit mode and after Done', async () => {
      clearHistory();
      current().hollowing.handleStartHollowVoxelEditing();
      await settle(20);
      current().hollowing.handleBlockedHollowVoxelMarqueeSelection(['4', '7']);
      await settle(20);
      current().hollowing.handleBlockedHollowVoxelMarqueeSelection(['9']);
      await settle(20);
      assert.deepEqual(current().hollowing.editingBlockedHollowVoxelIndices, [4, 7, 9]);
      assert.equal(getUndoCount(), 2);

      undo();
      await settle(20);
      assert.deepEqual(current().hollowing.editingBlockedHollowVoxelIndices, [4, 7], 'undo inside the edit mode');
      redo();
      await settle(20);
      assert.deepEqual(current().hollowing.editingBlockedHollowVoxelIndices, [4, 7, 9]);

      current().hollowing.handleDoneHollowVoxelEditing();
      await settle(20);
      assert.equal(current().hollowing.hollowingEditMode, false);
      assert.deepEqual(hollowingModifier()?.blockedVoxelIndices, [4, 7, 9]);
      assert.equal(getUndoCount(), 2, 'Done adds no step of its own');

      undo();
      await settle(20);
      assert.deepEqual(hollowingModifier()?.blockedVoxelIndices, [4, 7], 'undo after Done moves the committed blockers');
      assert.equal(current().hollowing.hollowingEditMode, true, 'and goes back into the edit mode');
      assert.deepEqual(current().hollowing.editingBlockedHollowVoxelIndices, [4, 7]);
      redo();
      await settle(20);
      assert.deepEqual(hollowingModifier()?.blockedVoxelIndices, [4, 7, 9], 'redo there still moves the committed blockers');
      assert.deepEqual(current().hollowing.editingBlockedHollowVoxelIndices, [4, 7, 9]);
      current().hollowing.handleDoneHollowVoxelEditing();
      await settle(20);
      assert.equal(getUndoCount(), 2, 'walking the steps adds none');
    });

    await t.test('a step from an edit session left without Done is dropped', async () => {
      clearHistory();
      current().hollowing.handleStartHollowVoxelEditing();
      await settle(20);
      current().hollowing.handleBlockedHollowVoxelMarqueeSelection(['12']);
      await settle(20);
      current().hollowing.setHollowingEditMode(false);
      await settle(20);

      undo();
      await settle(20);
      assert.deepEqual(hollowingModifier()?.blockedVoxelIndices, [4, 7, 9], 'the committed blockers are untouched');
      assert.equal(getUndoCount(), 0);
    });

    await t.test('undoing Apply returns to the draft, blockers included', async () => {
      const hollowed = new Float32Array([0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0, 1, 1, 0, 0, 0, 1, 0]);
      const tauriWindow = window as unknown as { __TAURI_INTERNALS__?: unknown };
      tauriWindow.__TAURI_INTERNALS__ ??= {};
      mockIPC((cmd) => {
        if (cmd === 'mesh_hollow_apply_from_captured_source') {
          return JSON.stringify({ removedVoxels: 100, outputTriangleCount: 2 });
        }
        if (cmd === 'mesh_repair_read_positions') return new Uint8Array(hollowed.buffer);
        if (cmd === 'mesh_hollow_staged_read_cavity_positions') throw new Error('no cavity');
        return null;
      });
      try {
        clearHistory();
        const draft = hollowingModifier();
        assert.equal(draft?.bakedIntoGeometry, false);
        const geometryBefore = current().scene.models[0].geometry.geometry;
        current().hollowing.handleApplyHollowing();
        await waitFor(() => current().scene.models[0].geometry.geometry !== geometryBefore, 'the hollowed geometry');
        await settle(20);
        assert.equal(hollowingModifier()?.bakedIntoGeometry, true);
        assert.equal(getUndoCount(), 1);

        undo();
        await settle(20);
        assert.equal(current().scene.models[0].geometry.geometry, geometryBefore, 'undo restores the geometry');
        assert.equal(hollowingModifier()?.bakedIntoGeometry, false, 'the hollow is a draft again');
        assert.deepEqual(hollowingModifier()?.blockedVoxelIndices, [4, 7, 9], 'with its blockers');
        assert.deepEqual(current().hollowing.blockedHollowVoxelIndices, [4, 7, 9], 'and the panel shows them');
      } finally {
        clearMocks();
        delete tauriWindow.__TAURI_INTERNALS__;
      }
    });
  } finally {
    await tree.unmount();
  }
});
