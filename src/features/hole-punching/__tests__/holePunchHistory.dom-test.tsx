import assert from 'node:assert/strict';
import { resolveObjectURL } from 'node:buffer';
import test from 'node:test';
import { useEffect, useRef, useState } from 'react';
import * as THREE from 'three';
import { clearMocks, mockIPC } from '@tauri-apps/api/mocks';
import type { HollowingPanelState } from '@/features/hollowing';
import type { HollowPreviewCacheEntry, HollowingSourceEntry } from '@/features/hollowing/hollowingPreviewTypes';
import type { HolePunchPanelState } from '@/features/hole-punching/HolePunchPanel';
import type { HolePunchPlacementState } from '@/features/hole-punching/holePunchGeometry';
import { useHolePunchManager } from '@/features/hole-punching/useHolePunchManager';
import { useSceneCollectionManager } from '@/features/scene/useSceneCollectionManager';
import { useTransformManager } from '@/features/transform/useTransformManager';
import { clearHistory, getUndoCount, redo, undo } from '@/history/historyStore';
import { renderWithProviders, settle } from '@/utils/__tests__/helpers/renderDom';

type Scene = ReturnType<typeof useSceneCollectionManager>;
type HolePunch = ReturnType<typeof useHolePunchManager>;

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

const DEFAULT_HOLLOWING: HollowingPanelState = {
  mode: 'cavity',
  voxelSizeMm: 0.65,
  shellThicknessMm: 2,
  infillMode: 'lattice',
  infillCellMm: 4.2426,
  infillBeamRadiusMm: 0.35,
  openFace: 'z_max',
};
const DEFAULT_HOLE_PUNCH: HolePunchPanelState = { radiusMm: 2, depthMm: 3, depthMode: 'manual' };

type Mounted = { scene: Scene; holePunch: HolePunch };

function Probe({ onRender }: { onRender: (mounted: Mounted) => void }) {
  const scene = useSceneCollectionManager();
  const transformMgr = useTransformManager({ geom: scene.geom, activeModel: scene.activeModel ?? null });
  const [hollowingState, setHollowingState] = useState(DEFAULT_HOLLOWING);
  const [isShellOpenFaceSelected, setIsShellOpenFaceSelected] = useState(true);
  const [hollowingDraftEnabled, setHollowingDraftEnabled] = useState(false);
  const [, setPendingModifierResetAction] = useState<'hollowing' | 'hole_punch' | 'clear_hollowing' | null>(null);
  const [isApplyingHolePunch, setIsApplyingHolePunch] = useState(false);
  const [pendingHolePunchAutoApplyModelId, setPendingHolePunchAutoApplyModelId] = useState<string | null>(null);
  const [selectedHolePunchPlacementIds, setSelectedHolePunchPlacementIds] = useState<string[]>([]);
  const [, setHoveredHolePunchPlacementId] = useState<string | null>(null);
  const [, setHolePunchHoverPlacement] = useState<HolePunchPlacementState | null>(null);
  const [, setShowDamagedModelDialog] = useState(false);
  const hollowingSourceByModelIdRef = useRef(new Map<string, HollowingSourceEntry>());
  const hollowPreviewResultCacheRef = useRef(new Map<string, HollowPreviewCacheEntry>());

  const holePunch = useHolePunchManager({
    scene,
    transformMgr,
    sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
    hollowingState,
    hollowingDraftEnabled,
    hollowPreview: null,
    isShellOpenFaceSelected,
    defaultHolePunchState: DEFAULT_HOLE_PUNCH,
    recommendedHolePunchDepthMm: DEFAULT_HOLE_PUNCH.depthMm,
    setHollowingState,
    setIsShellOpenFaceSelected,
    setHollowingDraftEnabled,
    persistActiveModelModifiers: (next, options) => {
      if (scene.activeModelId) scene.setModelMeshModifiers(scene.activeModelId, next, options);
    },
    setPendingModifierResetAction,
    hollowingSourceByModelIdRef,
    hollowPreviewResultCacheRef,
    isApplyingHolePunch,
    setIsApplyingHolePunch,
    isApplyingHollowing: false,
    pendingHolePunchAutoApplyModelId,
    setPendingHolePunchAutoApplyModelId,
    selectedHolePunchPlacementIds,
    setSelectedHolePunchPlacementIds,
    setHoveredHolePunchPlacementId,
    setHolePunchHoverPlacement,
    showOperationError: (message) => assert.fail(message),
    setShowDamagedModelDialog,
    beginFinalizing: () => {},
    clearFinalizing: () => {},
    nextPaint: () => Promise.resolve(),
  });

  useEffect(() => {
    onRender({ scene, holePunch });
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

function hitOn(modelId: string, point: THREE.Vector3): THREE.Intersection {
  const object = new THREE.Mesh();
  object.userData.modelId = modelId;
  return {
    distance: 1,
    point,
    object,
    face: { a: 0, b: 1, c: 2, normal: new THREE.Vector3(0, 0, 1), materialIndex: 0 },
  };
}

test('hole punch edits land in undo history', async (t) => {
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
    const holes = () => current().scene.getModelMeshModifiers(modelId)?.holePunches ?? [];

    await t.test('adding a hole is one step', async () => {
      clearHistory();
      current().holePunch.handleHolePunchClick(hitOn(modelId, new THREE.Vector3(5, 5, 10)));
      await settle(20);
      assert.equal(holes().length, 1);
      assert.equal(getUndoCount(), 1);
      undo();
      await settle(20);
      assert.equal(holes().length, 0, 'undo removes the hole');
      redo();
      await settle(20);
      assert.equal(holes().length, 1, 'redo puts it back');
    });

    await t.test('a run of radius edits is one step', async () => {
      clearHistory();
      const placementId = holes()[0].id;
      current().holePunch.handleSelectHolePunchPlacement(placementId);
      await settle(20);
      for (const radiusMm of [2.5, 3, 3.5]) {
        current().holePunch.handleHolePunchStateChange({ ...DEFAULT_HOLE_PUNCH, radiusMm });
        await settle(20);
      }
      assert.equal(holes()[0].radiusMm, 3.5);
      assert.equal(getUndoCount(), 1);
      undo();
      await settle(20);
      assert.equal(holes()[0].radiusMm, 2, 'undo returns to the radius before the run');
    });

    await t.test('two holes added in a row are two steps', async () => {
      // With a hole selected, a click on the model only clears the selection.
      current().holePunch.handleHolePunchClick(hitOn(modelId, new THREE.Vector3(5, 5, 10)));
      await settle(20);
      clearHistory();
      current().holePunch.handleHolePunchClick(hitOn(modelId, new THREE.Vector3(2, 2, 10)));
      await settle(20);
      current().holePunch.handleHolePunchClick(hitOn(modelId, new THREE.Vector3(8, 8, 10)));
      await settle(20);
      assert.equal(holes().length, 3);
      assert.equal(getUndoCount(), 2);
    });

    await t.test('applying the holes is one step that restores geometry and drafts together', async () => {
      const punched = new Float32Array([0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0, 1, 1, 0, 0, 0, 1, 0]);
      const tauriWindow = window as unknown as { __TAURI_INTERNALS__?: unknown };
      tauriWindow.__TAURI_INTERNALS__ ??= {};
      mockIPC((cmd) => {
        if (cmd === 'mesh_punch_from_captured_source') {
          return JSON.stringify({ sourceTriangleCount: 12, outputTriangleCount: 2, removedTriangleCount: 10, punchCount: 3 });
        }
        if (cmd === 'mesh_punch_read_positions') return new Uint8Array(punched.buffer);
        return null;
      });
      try {
        clearHistory();
        const geometryBefore = current().scene.models[0].geometry.geometry;
        current().holePunch.handleApplyHolePunch();
        await waitFor(() => current().scene.models[0].geometry.geometry !== geometryBefore, 'the punched geometry');
        await settle(20);
        assert.equal(current().scene.getModelMeshModifiers(modelId)?.holePunchesBakedIntoGeometry, true);
        assert.equal(getUndoCount(), 1);

        undo();
        await settle(20);
        assert.equal(current().scene.models[0].geometry.geometry, geometryBefore, 'undo restores the geometry');
        assert.equal(current().scene.getModelMeshModifiers(modelId)?.holePunchesBakedIntoGeometry, false);
        assert.equal(holes().length, 3, 'the holes are drafts again');
      } finally {
        clearMocks();
        delete tauriWindow.__TAURI_INTERNALS__;
      }
    });
  } finally {
    await tree.unmount();
  }
});
