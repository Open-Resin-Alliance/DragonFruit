import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import test from 'node:test';
import { getSnapshot, setSnapshot } from '@/supports/state';
import { createEmptySupportCollections } from '@/supports/supportTypeRegistry';
import type { SupportState } from '@/supports/types';
import { getRaftSettings, setRaftSettings, updateRaftSettings } from '@/supports/Rafts/Crenelated/RaftState';
import { buildSupportAndRaftWorldTriangles, resolveSupportSliceTessellation } from '../rasterLayerZipExport';

const MODEL_ID = 'exported-plate-model';
const OTHER_MODEL_ID = 'other-plate-model';
const MODEL_IDS = new Set([MODEL_ID]);

function supportPair(id: string, modelId: string) {
  const root = {
    id: `root-${id}`, modelId,
    transform: { pos: { x: 350, y: 0, z: 0 }, rot: { x: 0, y: 0, z: 0, w: 1 } },
    diameter: 4, diskHeight: 0.5, coneHeight: 1,
  };
  const trunk = {
    id: `trunk-${id}`, typeId: 'trunk' as const, modelId, rootId: root.id,
    segments: [{ id: `segment-${id}`, diameter: 1, topJoint: { id: `joint-${id}`, pos: { x: 350, y: 0, z: 10 }, diameter: 1.1 } }],
  };
  return { root, trunk };
}

function selectedForest(): SupportState {
  const { root, trunk } = supportPair('selected', MODEL_ID);
  return {
    ...createEmptySupportCollections(),
    roots: { [root.id]: root }, trunks: { [trunk.id]: trunk },
    selectedId: null, hoveredId: null, selectedCategory: null,
    hoveredCategory: 'none', interactionWarning: null,
  } as unknown as SupportState;
}

function withSupportState(run: () => void): void {
  const savedState = getSnapshot();
  const savedRaft = getRaftSettings();
  try {
    updateRaftSettings({ bottomMode: 'off', wallEnabled: false });
    run();
  } finally {
    setSnapshot(savedState);
    setRaftSettings(savedRaft);
  }
}

function bakedGeometry(state: SupportState): string {
  setSnapshot(state);
  const triangles = buildSupportAndRaftWorldTriangles(MODEL_IDS);
  return createHash('sha256').update(JSON.stringify(triangles)).digest('hex');
}

test('a shaft forest on another plate cannot change the exported support mesh', () => withSupportState(() => {
  const selected = selectedForest();
  const baseline = bakedGeometry(selected);
  const other = supportPair('other', OTHER_MODEL_ID);
  other.trunk.segments = Array.from({ length: 20_000 }, (_, i) => ({
    ...other.trunk.segments[0], id: `foreign-segment-${i}`,
  }));
  const combined = {
    ...selected,
    roots: { ...selected.roots, [other.root.id]: other.root },
    trunks: { ...selected.trunks, [other.trunk.id]: other.trunk },
  } as unknown as SupportState;
  assert.equal(bakedGeometry(combined), baseline);
}));

test('roots on another plate cannot change the exported support mesh', () => withSupportState(() => {
  const selected = selectedForest();
  const baseline = bakedGeometry(selected);
  const template = supportPair('other', OTHER_MODEL_ID).root;
  const roots = { ...selected.roots };
  for (let i = 0; i < 24_000; i++) {
    const id = `foreign-root-${i}`;
    roots[id] = { ...template, id };
  }
  assert.equal(bakedGeometry({ ...selected, roots }), baseline);
}));

test('shaftless supports on another plate cannot change the exported support mesh', () => withSupportState(() => {
  const selected = selectedForest();
  const baseline = bakedGeometry(selected);
  const leaves = Object.fromEntries(Array.from({ length: 24_000 }, (_, i) => {
    const id = `foreign-leaf-${i}`;
    return [id, { id, modelId: OTHER_MODEL_ID, typeId: 'leaf', segments: [] }];
  }));
  assert.equal(bakedGeometry({ ...selected, leaves } as unknown as SupportState), baseline);
}));

test('owned roots with stale model IDs count like directly assigned roots', () => {
  const canonical = selectedForest();
  canonical.roots = {};
  canonical.trunks = {};
  for (let i = 0; i < 12_000; i++) {
    const { root, trunk } = supportPair(String(i), MODEL_ID);
    canonical.roots[root.id] = root;
    canonical.trunks[trunk.id] = trunk as unknown as SupportState['trunks'][string];
  }
  const linkedRootIds = new Set(Object.keys(canonical.roots));
  const stale = {
    ...canonical,
    roots: Object.fromEntries(Object.entries(canonical.roots).map(([id, root]) => [id, { ...root, modelId: OTHER_MODEL_ID }])),
  };
  assert.deepEqual(
    resolveSupportSliceTessellation(stale, MODEL_IDS, linkedRootIds),
    resolveSupportSliceTessellation(canonical, MODEL_IDS, linkedRootIds),
  );
});
