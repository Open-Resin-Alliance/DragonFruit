import { footprintFromPoints } from '@/volumeAnalysis/Islands/voxelFootprint';
import { buildIslandInstances, EMPTY_ISLAND_INSTANCES, type IslandVisual } from '../islandInstances';
import { test } from 'node:test';
import assert from 'node:assert/strict';

const VOXEL_RADIUS_MM = 0.0375;

/**
 * The buffers are Float32, so a millimetre value written as a decimal literal
 * comes back as the nearest float32. Round the expectations the same way so the
 * comparison is exact rather than approximate.
 */
function expectF32(values: number[]): number[] {
  return Array.from(new Float32Array(values));
}

function island(overrides: Partial<IslandVisual> = {}): IslandVisual {
  return {
    markerId: 7,
    type: 0,
    centerX: 1,
    centerY: 2,
    baseZ: 3,
    radius: 0.4,
    footprint: null,
    ...overrides,
  };
}

test('buildIslandInstances: no islands yields the empty buffer', () => {
  const instances = buildIslandInstances([], VOXEL_RADIUS_MM);
  assert.equal(instances.count, 0);
  assert.equal(instances, EMPTY_ISLAND_INSTANCES);
});

test('buildIslandInstances: an island without a footprint is one disc at its contact', () => {
  const instances = buildIslandInstances([island()], VOXEL_RADIUS_MM);

  assert.equal(instances.count, 1);
  assert.deepEqual(Array.from(instances.centerRadius), expectF32([1, 2, 3, 0.4]));
  assert.deepEqual(Array.from(instances.meta), [7, 0]);
});

test('buildIslandInstances: an island with a footprint is one disc per contact voxel', () => {
  const instances = buildIslandInstances(
    [
      island({
        markerId: 1000003,
        type: 1,
        footprint: footprintFromPoints([{ x: 0.5, y: 1.5 }, { x: 2.5, y: 3.5 }, { x: 4.5, y: 5.5 }]),
      }),
    ],
    VOXEL_RADIUS_MM,
  );

  assert.equal(instances.count, 3);
  // Every voxel sits on the island's base plane at the grid tiling radius,
  // carrying the island's marker id and type.
  assert.deepEqual(Array.from(instances.centerRadius), expectF32([
    0.5, 1.5, 3, VOXEL_RADIUS_MM,
    2.5, 3.5, 3, VOXEL_RADIUS_MM,
    4.5, 5.5, 3, VOXEL_RADIUS_MM,
  ]));
  assert.deepEqual(Array.from(instances.meta), [1000003, 1, 1000003, 1, 1000003, 1]);
});

test('buildIslandInstances: an empty footprint falls back to the single contact disc', () => {
  const instances = buildIslandInstances([island({ footprint: footprintFromPoints([]) })], VOXEL_RADIUS_MM);

  assert.equal(instances.count, 1);
  assert.deepEqual(Array.from(instances.centerRadius), expectF32([1, 2, 3, 0.4]));
});

test('buildIslandInstances: footprints of several islands pack in order', () => {
  const instances = buildIslandInstances(
    [
      island({ markerId: 1, baseZ: 0, footprint: footprintFromPoints([{ x: 0, y: 0 }, { x: 1, y: 0 }]) }),
      island({ markerId: 2, baseZ: 5, footprint: null }),
      island({ markerId: 3, baseZ: 9, footprint: footprintFromPoints([{ x: 9, y: 9 }]) }),
    ],
    VOXEL_RADIUS_MM,
  );

  assert.equal(instances.count, 4);
  assert.deepEqual(Array.from(instances.meta), [1, 0, 1, 0, 2, 0, 3, 0]);
  // Every instance keeps its own island's base plane.
  assert.deepEqual(
    Array.from(instances.centerRadius).filter((_, i) => i % 4 === 2),
    [0, 0, 5, 9],
  );
});
