import assert from 'node:assert/strict';
import { test } from 'node:test';
import { NAMED_3D_MOUSE } from '../SpaceMouseController';
import { SPNAV_DEVICE_ID, spnavStateToGamepad } from '../spnavSpaceMouse';

test('disconnected spacenavd yields no pad', () => {
  assert.equal(spnavStateToGamepad({ connected: false, axes: [0, 0, 0, 0, 0, 0], buttons: [] }), null);
});

test('connected spacenavd yields a named six-axis pad', () => {
  const pad = spnavStateToGamepad({
    connected: true,
    axes: [0.5, -1, 0, 0, 0, 0.25],
    buttons: [false, true],
  });
  assert.ok(pad);
  assert.equal(pad.id, SPNAV_DEVICE_ID);
  assert.match(pad.id, NAMED_3D_MOUSE);
  assert.deepEqual([...pad.axes], [0.5, -1, 0, 0, 0, 0.25]);
  assert.deepEqual(pad.buttons.map((b) => b.pressed), [false, true]);
});
