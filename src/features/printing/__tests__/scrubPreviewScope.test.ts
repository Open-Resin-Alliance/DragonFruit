import assert from 'node:assert/strict';
import test from 'node:test';
import * as THREE from 'three';

import { DYNAMIC_PLATE_ORDERING } from '@/features/scene/plates/plateCascade';
import { computePlateFrames } from '@/features/scene/plates/plateLayout';
import { scrubPreviewScope } from '../scrubPreviewScope';

const footprint = { widthMm: 218, depthMm: 123, originMode: 'center' as const };
const frames = computePlateFrames({ plates: [{ id: 'p1' }, { id: 'p2' }], footprint, ordering: DYNAMIC_PLATE_ORDERING });
const [, second] = frames;

const model = (id: string, x: number, y: number) => ({ id, transform: { position: new THREE.Vector3(x, y, 0) } });

// A full plate 1, and one model in the middle of plate 2 (#867).
const models = [
  model('edge-a', -100, -50),
  model('edge-b', 100, 50),
  model('middle-of-2', second.dxMm + 3, second.dyMm - 4),
];

const xy = (m: { transform: { position: THREE.Vector3 } }) => ({ x: m.transform.position.x, y: m.transform.position.y });

test('scrubbing plate 2 draws its models at the origin and leaves plate 1\'s supports out', () => {
  const scope = scrubPreviewScope({ models, frames, plateId: 'p2' });
  assert.deepEqual(scope.models.map((m) => m.id), ['middle-of-2']);
  assert.deepEqual(xy(scope.models[0]), { x: 3, y: -4 }, 'the same spot on the bed, at the origin');
  assert.deepEqual(scope.supportExcludeModelIds, ['edge-a', 'edge-b']);
  // Its supports make the same move as the model.
  assert.deepEqual(scope.offsetMm, { dxMm: second.dxMm, dyMm: second.dyMm });
  assert.ok(second.dxMm !== 0, 'plate 2 sits away from the origin');
  // The scene's own models are not moved.
  assert.deepEqual(xy(models[2]), { x: second.dxMm + 3, y: second.dyMm - 4 });
});

test('scrubbing plate 1 draws it where it stands and leaves plate 2\'s supports out', () => {
  const scope = scrubPreviewScope({ models, frames, plateId: 'p1' });
  assert.deepEqual(scope.models.map((m) => m.id), ['edge-a', 'edge-b']);
  assert.equal(scope.models[0], models[0], 'a model that does not move keeps its object');
  assert.deepEqual(scope.supportExcludeModelIds, ['middle-of-2']);
  assert.deepEqual(scope.offsetMm, { dxMm: 0, dyMm: 0 });
});

test('an unknown plate reads as the first, and a scene without beds draws everything', () => {
  assert.deepEqual(scrubPreviewScope({ models, frames, plateId: 'gone' }).supportExcludeModelIds, ['middle-of-2']);
  const bare = scrubPreviewScope({ models, frames: [], plateId: 'p1' });
  assert.equal(bare.models.length, 3);
  assert.deepEqual(bare.supportExcludeModelIds, []);
});
