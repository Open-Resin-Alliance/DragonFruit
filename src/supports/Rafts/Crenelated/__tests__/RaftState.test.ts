import test from 'node:test';
import assert from 'node:assert/strict';
import { DEFAULT_RAFT_SETTINGS } from '../RaftDefaults';
import {
  applyImportDefaultRaftSettings,
  clearRaftSettingsForModel,
  getRaftSettings,
  getRaftStateSnapshot,
  getRaftStoreRevision,
  seedRaftStateSnapshot,
  setRaftSettings,
  setRaftSettingsForModel,
  subscribeToRaftStore,
  updateRaftSettings,
} from '../RaftState';

function reset(): void {
  seedRaftStateSnapshot({ global: DEFAULT_RAFT_SETTINGS, perModel: {} });
}

test('a line base never keeps a wall', () => {
  reset();
  updateRaftSettings({ bottomMode: 'line' });
  assert.equal(getRaftSettings().wallEnabled, false);
});

test('the mode round-trip restores a wall that was on', () => {
  reset();
  assert.equal(getRaftSettings().wallEnabled, true);

  updateRaftSettings({ bottomMode: 'line' });
  updateRaftSettings({ bottomMode: 'solid' });

  assert.equal(getRaftSettings().wallEnabled, true);
});

test('the mode round-trip keeps a wall the user turned off', () => {
  reset();
  updateRaftSettings({ wallEnabled: false });

  updateRaftSettings({ bottomMode: 'line' });
  updateRaftSettings({ bottomMode: 'solid' });

  assert.equal(getRaftSettings().wallEnabled, false);
});

test('getRaftStoreRevision increments on every global, per-model, and seed write while staying stable across reads', () => {
  const saved = getRaftStateSnapshot();
  try {
    reset();
    const r0 = getRaftStoreRevision();
    assert.equal(typeof r0, 'number');
    assert.strictEqual(getRaftStoreRevision(), r0);
    assert.strictEqual(getRaftStoreRevision(), r0);

    setRaftSettings({ ...DEFAULT_RAFT_SETTINGS, thickness: 1.8 });
    const r1 = getRaftStoreRevision();
    assert.ok(r1 > r0, 'setRaftSettings must increment revision');
    assert.strictEqual(getRaftStoreRevision(), r1);

    updateRaftSettings({ bottomMode: 'line' });
    const r2 = getRaftStoreRevision();
    assert.ok(r2 > r1, 'updateRaftSettings must increment revision');

    applyImportDefaultRaftSettings({ ...DEFAULT_RAFT_SETTINGS, bottomMode: 'solid' });
    const r3 = getRaftStoreRevision();
    assert.ok(r3 > r2, 'applyImportDefaultRaftSettings must increment revision');

    let listenerCalls = 0;
    const unsubscribe = subscribeToRaftStore(() => {
      listenerCalls += 1;
    });
    try {
      setRaftSettingsForModel('model-alpha', { ...DEFAULT_RAFT_SETTINGS, bottomMode: 'line' });
      const r4 = getRaftStoreRevision();
      assert.ok(r4 > r3, 'setRaftSettingsForModel must increment revision');
      assert.equal(listenerCalls, 1);

      clearRaftSettingsForModel('model-alpha');
      const r5 = getRaftStoreRevision();
      assert.ok(r5 > r4, 'clearRaftSettingsForModel must increment revision');
      assert.equal(listenerCalls, 2);

      seedRaftStateSnapshot({
        global: { ...DEFAULT_RAFT_SETTINGS, bottomMode: 'off' },
        perModel: { 'model-beta': { ...DEFAULT_RAFT_SETTINGS, bottomMode: 'solid' } },
      });
      const r6 = getRaftStoreRevision();
      assert.ok(r6 > r5, 'seedRaftStateSnapshot must increment revision');
      assert.equal(listenerCalls, 2, 'seedRaftStateSnapshot hydrates silently without firing listeners');
      assert.strictEqual(getRaftStoreRevision(), r6);
    } finally {
      unsubscribe();
    }
  } finally {
    seedRaftStateSnapshot(saved);
  }
});

