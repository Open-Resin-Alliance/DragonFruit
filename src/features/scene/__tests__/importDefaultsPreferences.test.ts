import assert from 'node:assert/strict';
import test from 'node:test';

import {
  applyImportDefaultsToSupportPayload,
  getImportDefaultsRaftPatch,
  normalizeImportDefaultsSettings,
  type ImportDefaultsSettings,
} from '@/features/scene/importDefaultsPreferences';
import type { DragonfruitImportFormat } from '@/supports/types';

function makePayload(): DragonfruitImportFormat {
  return {
    version: 1,
    meta: {
      source: 'unit-test',
      objectCenter: { x: 0, y: 0, z: 0 },
    },
    roots: [
      {
        id: 'root-a',
        modelId: 'm1',
        transform: { pos: { x: 0, y: 0, z: 0 }, rot: { x: 0, y: 0, z: 0, w: 1 } },
        diameter: 4,
        diskHeight: 1,
        coneHeight: 1,
      },
      {
        id: 'root-b',
        modelId: 'm1',
        transform: { pos: { x: 10, y: 0, z: 0 }, rot: { x: 0, y: 0, z: 0, w: 1 } },
        diameter: 7,
        diskHeight: 1,
        coneHeight: 1,
      },
    ],
    trunks: [
      {
        id: 'trunk-a',
        modelId: 'm1',
        rootId: 'root-a',
        baseDiameterMm: 1.25,
        segments: [
          {
            id: 'seg-a',
            diameter: 1.25,
            topJoint: { id: 'ja', pos: { x: 0, y: 0, z: 5 }, diameter: 1.35 },
          },
        ],
      },
      {
        id: 'trunk-b',
        modelId: 'm1',
        rootId: 'root-b',
        segments: [
          {
            id: 'seg-b',
            diameter: 2.1,
            topJoint: { id: 'jb', pos: { x: 10, y: 0, z: 5 }, diameter: 2.2 },
          },
        ],
      },
    ],
    branches: [],
    leaves: [],
    twigs: [],
    sticks: [],
    braces: [],
    knots: [],
  };
}

test('normalizeImportDefaultsSettings falls back to safe defaults', () => {
  const normalized = normalizeImportDefaultsSettings({
    raftBottomMode: 'invalid',
    raftWallEnabled: 'yes',
    rootsEnabled: 123,
    autoRepairScenes: 'no',
  });

  assert.equal(normalized.raftBottomMode, 'solid');
  assert.equal(normalized.raftWallEnabled, true);
  assert.equal(normalized.rootsEnabled, true);
  assert.equal(normalized.autoRepairScenes, false);
});

test('normalizeImportDefaultsSettings preserves explicit auto repair toggle', () => {
  const normalized = normalizeImportDefaultsSettings({
    raftBottomMode: 'solid',
    raftWallEnabled: true,
    rootsEnabled: true,
    autoRepairScenes: false,
  });

  assert.equal(normalized.autoRepairScenes, false);
});

test('normalizeImportDefaultsSettings enforces roots enabled for line raft mode and preserves wall preference', () => {
  const normalized = normalizeImportDefaultsSettings({
    raftBottomMode: 'line',
    raftWallEnabled: true,
    rootsEnabled: false,
    autoRepairScenes: false,
  });

  assert.equal(normalized.raftBottomMode, 'line');
  assert.equal(normalized.raftWallEnabled, true);
  assert.equal(normalized.rootsEnabled, true);
  assert.equal(normalized.autoRepairScenes, false);
});

test('normalizeImportDefaultsSettings keeps wall preference when raft mode is non-solid', () => {
  const normalized = normalizeImportDefaultsSettings({
    raftBottomMode: 'off',
    raftWallEnabled: false,
    rootsEnabled: true,
    autoRepairScenes: true,
  });

  assert.equal(normalized.raftBottomMode, 'off');
  assert.equal(normalized.raftWallEnabled, false);
  assert.equal(normalized.autoRepairScenes, true);
});

test('applyImportDefaultsToSupportPayload keeps payload unchanged when roots are enabled', () => {
  const payload = makePayload();
  const defaults: ImportDefaultsSettings = {
    raftBottomMode: 'line',
    raftWallEnabled: true,
    rootsEnabled: true,
    autoRepairScenes: true,
  };

  const next = applyImportDefaultsToSupportPayload(payload, defaults);
  assert.equal(next, payload);
});

test('applyImportDefaultsToSupportPayload aligns root diameter to trunk diameter when roots are disabled', () => {
  const payload = makePayload();
  const defaults: ImportDefaultsSettings = {
    raftBottomMode: 'line',
    raftWallEnabled: true,
    rootsEnabled: false,
    autoRepairScenes: true,
  };

  const next = applyImportDefaultsToSupportPayload(payload, defaults);

  assert.notEqual(next, payload);
  assert.equal(next.roots[0].diameter, 1.25);
  assert.equal(next.roots[1].diameter, 2.1);
  assert.equal(payload.roots[0].diameter, 4, 'original payload must not be mutated');
  assert.equal(payload.roots[1].diameter, 7, 'original payload must not be mutated');
});

test('getImportDefaultsRaftPatch disables wall when raft base is off', () => {
  const patch = getImportDefaultsRaftPatch({
    raftBottomMode: 'off',
    raftWallEnabled: true,
    rootsEnabled: false,
    autoRepairScenes: true,
  });

  assert.equal(patch.bottomMode, 'off');
  assert.equal(patch.wallEnabled, false);
});

test('getImportDefaultsRaftPatch disables wall when raft base is line', () => {
  const patch = getImportDefaultsRaftPatch({
    raftBottomMode: 'line',
    raftWallEnabled: true,
    rootsEnabled: true,
    autoRepairScenes: true,
  });

  assert.equal(patch.bottomMode, 'line');
  assert.equal(patch.wallEnabled, false);
});
