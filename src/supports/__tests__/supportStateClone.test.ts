import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert';
import { cloneSupportState, getSnapshot, resetStore, setSnapshot } from '../state';
import { SUPPORT_TYPES } from '../supportTypeRegistry';
import type { Knot, Roots, SupportState, Trunk } from '../types';

const MODEL_ID = 'clone-model';

function buildState(x = 0): SupportState {
  const roots: Record<string, Roots> = {};
  const knots: Record<string, Knot> = {};
  const trunks: Record<string, Trunk> = {};

  for (let i = 0; i < 3; i += 1) {
    const id = `trunk-${i}`;
    const segmentId = `${id}-s`;
    roots[`root-${i}`] = {
      id: `root-${i}`,
      modelId: MODEL_ID,
      transform: { pos: { x: x + i, y: 0, z: 0 }, rot: { x: 0, y: 0, z: 0, w: 1 } },
      diameter: 3,
      diskHeight: 0.8,
      coneHeight: 1.2,
    };
    trunks[id] = {
      id,
      modelId: MODEL_ID,
      rootId: `root-${i}`,
      segments: [{
        id: segmentId,
        type: 'straight',
        diameter: 1,
        bottomJoint: { id: `${segmentId}-b`, pos: { x: x + i, y: 0, z: 1 }, diameter: 1.1 },
        topJoint: { id: `${segmentId}-t`, pos: { x: x + i, y: 0, z: 6 }, diameter: 1.1 },
      }],
    };
    knots[`knot-${i}`] = { id: `knot-${i}`, parentShaftId: segmentId, t: 0.5, pos: { x: x + i, y: 0, z: 4 }, diameter: 1.1 };
  }

  return { roots, knots, trunks } as unknown as SupportState;
}

describe('cloneSupportState', () => {
  beforeEach(() => {
    resetStore();
  });

  it('keeps every entity reachable through its own collection', () => {
    setSnapshot(buildState());

    const clone = cloneSupportState(getSnapshot());
    const live = getSnapshot();

    for (const descriptor of SUPPORT_TYPES) {
      const key = descriptor.location.key;
      const cloned = clone[key];
      const original = live[key];
      assert.equal(
        Object.keys(cloned).length,
        Object.keys(original).length,
        `${descriptor.id}: the clone holds a different number of entities`,
      );
      for (const id of Object.keys(original)) {
        assert.ok(cloned[id], `${descriptor.id}: ${id} is missing from the clone`);
        assert.notEqual(cloned[id], original[id], `${descriptor.id}: ${id} was not copied`);
      }
    }

    assert.deepEqual(Object.keys(clone.roots), Object.keys(live.roots));
    assert.deepEqual(Object.keys(clone.knots), Object.keys(live.knots));
    assert.notEqual(clone.roots, live.roots);
    assert.notEqual(clone.roots['root-0'], live.roots['root-0']);
    assert.notEqual(clone.knots['knot-0'], live.knots['knot-0']);
    assert.notEqual(clone.trunks['trunk-0'].segments[0], live.trunks['trunk-0'].segments[0]);
  });

  it('does not alias the live state it was taken from', () => {
    setSnapshot(buildState());

    const clone = cloneSupportState(getSnapshot());

    // In-place edits stand in for any later write: a snapshot that shared an
    // entity object with the store would follow it.
    const live = getSnapshot();
    live.roots['root-0'].transform.pos.x = 999;
    live.trunks['trunk-0'].segments[0].topJoint!.pos.z = 999;
    live.knots['knot-0'].pos.y = 999;

    assert.equal(clone.roots['root-0'].transform.pos.x, 0);
    assert.equal(clone.trunks['trunk-0'].segments[0].topJoint?.pos.z, 6);
    assert.equal(clone.knots['knot-0'].pos.y, 0);
  });
});
