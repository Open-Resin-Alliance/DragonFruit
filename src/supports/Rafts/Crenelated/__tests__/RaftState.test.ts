import test from 'node:test';
import assert from 'node:assert/strict';
import { DEFAULT_RAFT_SETTINGS } from '../RaftDefaults';
import { getRaftSettings, setRaftSettings, updateRaftSettings } from '../RaftState';

function reset(): void {
  setRaftSettings(DEFAULT_RAFT_SETTINGS);
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
