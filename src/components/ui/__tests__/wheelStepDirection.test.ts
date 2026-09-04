import assert from 'node:assert/strict';
import test from 'node:test';

import { wheelStepDirection } from '../wheelStepDirection';

test('trackpad vertical scroll steps by deltaY', () => {
  assert.equal(wheelStepDirection({ deltaX: 0, deltaY: -16 }), 1);
  assert.equal(wheelStepDirection({ deltaX: 0, deltaY: 16 }), -1);
});

test('shift+wheel arrives as horizontal scroll and still steps', () => {
  // Logitech M500s with Shift held: deltaY is 0, movement lands in deltaX.
  assert.equal(wheelStepDirection({ deltaX: -27, deltaY: 0 }), 1);
  assert.equal(wheelStepDirection({ deltaX: 9, deltaY: 0 }), -1);
});

test('diagonal trackpad movement follows the dominant axis', () => {
  assert.equal(wheelStepDirection({ deltaX: 3, deltaY: -12 }), 1);
  assert.equal(wheelStepDirection({ deltaX: -12, deltaY: 3 }), 1);
});

test('no movement means no step', () => {
  assert.equal(wheelStepDirection({ deltaX: 0, deltaY: 0 }), 0);
  assert.equal(wheelStepDirection({ deltaX: Number.NaN, deltaY: Number.NaN }), 0);
});
