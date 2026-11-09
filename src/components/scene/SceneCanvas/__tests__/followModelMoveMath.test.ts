import assert from 'node:assert/strict';
import test from 'node:test';
import { FOLLOW_HANDOFF_MAX_FRAMES, stepFollowHandoff, type FollowHandoffState } from '../followModelMoveMath';

const idle: FollowHandoffState = { tracked: null, framesSinceRelease: 0 };

test('a live drag offsets the helper by the delta from its base transform', () => {
  const { state, offset } = stepFollowHandoff({ x: 10, y: 4 }, { x: 0, y: 0 }, idle);

  assert.deepEqual(offset, { x: 10, y: 4 });
  assert.deepEqual(state, { tracked: { x: 10, y: 4 }, framesSinceRelease: 0 });
});

test('the offset survives the release frame while the committed base is still stale', () => {
  const dragging = stepFollowHandoff({ x: 10, y: 4 }, { x: 0, y: 0 }, idle);

  // The live transform is gone, the React prop has not re-rendered yet.
  const released = stepFollowHandoff(null, { x: 0, y: 0 }, dragging.state);

  assert.deepEqual(released.offset, { x: 10, y: 4 }, 'no snap back to the drag start');
  assert.equal(released.state.framesSinceRelease, 1);
});

test('the handoff ends as soon as the base catches up', () => {
  const dragging = stepFollowHandoff({ x: 10, y: 4 }, { x: 0, y: 0 }, idle);
  const released = stepFollowHandoff(null, { x: 0, y: 0 }, dragging.state);
  const committed = stepFollowHandoff(null, { x: 10, y: 4 }, released.state);

  assert.deepEqual(committed.offset, { x: 0, y: 0 });
  assert.deepEqual(committed.state, idle);
});

test('a cancelled drag lets go after the handoff budget', () => {
  let state: FollowHandoffState = stepFollowHandoff({ x: 10, y: 4 }, { x: 0, y: 0 }, idle).state;
  let offset = { x: 10, y: 4 };

  for (let frame = 1; frame <= FOLLOW_HANDOFF_MAX_FRAMES; frame += 1) {
    ({ state, offset } = stepFollowHandoff(null, { x: 0, y: 0 }, state));
    assert.deepEqual(offset, { x: 10, y: 4 }, `still held on frame ${frame}`);
  }

  const after = stepFollowHandoff(null, { x: 0, y: 0 }, state);
  assert.deepEqual(after.offset, { x: 0, y: 0 }, 'the helper returns to the unchanged base');
  assert.deepEqual(after.state, idle);
});

test('an idle helper has no offset', () => {
  const { state, offset } = stepFollowHandoff(null, { x: 3, y: 2 }, idle);

  assert.deepEqual(offset, { x: 0, y: 0 });
  assert.equal(state.tracked, null);
});
