import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import {
  ROOT_SHAPE_RATIO_BUCKETS_PER_UNIT,
  ROOT_SHAPE_RATIO_STEP,
  rootBucketKey,
  rootShapeRatio,
  type InstancedRoot,
} from '../../SupportPrimitives/Roots/InstancedRootsGroup';
import type { Vec3 } from '../../types';
import { SUPPORT_INSTANCED_ROOTS } from '../flags';
import { buildRootSlotIndex, type RootSlotGroup } from '../rootSlots';

const at = (x: number, y: number, z: number): Vec3 => ({ x, y, z });

function root(
  id: string,
  supportId: string | undefined,
  basePos: Vec3,
  overrides: Partial<Omit<InstancedRoot, 'id' | 'supportId' | 'basePos'>> = {},
): InstancedRoot {
  return {
    id,
    ...(supportId !== undefined ? { supportId } : {}),
    basePos,
    bottomRadius: 4,
    topRadius: 1,
    effectiveDiskHeight: 0.1,
    coneHeight: 0.6,
    ...overrides,
  };
}

/**
 * Two colours. root-1 and root-2 share the 0.25 bucket from different raw
 * ratios (0.2725 quantizes down); root-2 has no cone at all; root-3 is a second
 * bucket; root-bad is the degenerate root the legacy group drops.
 */
function groups(): RootSlotGroup[] {
  return [
    {
      color: '#ff8800',
      roots: [
        root('root-1', 'sup-1', at(1, 1, 2)),
        root('root-2', 'sup-1', at(2, 1, 2), {
          topRadius: 1.09,
          effectiveDiskHeight: 0.2,
          coneHeight: 0,
        }),
      ],
    },
    {
      color: '#888888',
      roots: [
        root('root-3', 'sup-2', at(3, 1, 2), { topRadius: 2, coneHeight: 0.4 }),
        root('root-bad', 'sup-2', at(4, 1, 2), { bottomRadius: 0 }),
      ],
    },
  ];
}

describe('buildRootSlotIndex', () => {
  it('keeps producer order and drops the roots the legacy group drops', () => {
    const index = buildRootSlotIndex(groups());

    assert.deepEqual(
      index.slots.map((record) => record.slot.id),
      ['root-1', 'root-2', 'root-3'],
    );
    assert.equal(index.byPrimitive.has('root-bad'), false);

    const zeroDisk = buildRootSlotIndex([
      {
        color: '#000000',
        roots: [root('flat', 'sup', at(0, 0, 0), { effectiveDiskHeight: 0 })],
      },
    ]);
    assert.equal(zeroDisk.slots.length, 0);
  });

  it('buckets the cone by the legacy quantized ratio and uses that ratio as the geometry', () => {
    const [first] = groups()[0].roots;

    assert.equal(ROOT_SHAPE_RATIO_STEP, 0.05);
    assert.equal(ROOT_SHAPE_RATIO_BUCKETS_PER_UNIT, 20);

    const index = buildRootSlotIndex(groups());

    assert.deepEqual(
      index.buckets.map((bucket) => bucket.key),
      ['0.25', '0.5'],
    );
    const [shared, wider] = index.buckets;
    assert.equal(shared.ratio, 0.25);
    // Unlike a contact cone, the *quantized* ratio is the geometry ratio.
    assert.equal(shared.ratio, rootShapeRatio(first));
    assert.equal(shared.key, rootBucketKey(first));
    assert.equal(wider.ratio, 0.5);
    assert.equal(wider.key, '0.5');

    // root-2's raw ratio is 0.2725: it lands in the same bucket, and is absent
    // from it anyway because it has no cone.
    assert.equal(
      rootBucketKey(root('x', 's', at(0, 0, 0), { topRadius: 1.09 })),
      '0.25',
    );
    assert.deepEqual(
      shared.records.map((record) => record.slot.id),
      ['root-1'],
    );
    assert.deepEqual(
      wider.records.map((record) => record.slot.id),
      ['root-3'],
    );
  });

  it('draws a disk for every root and cone/sphere instances only for cone-bearing roots', () => {
    const index = buildRootSlotIndex(groups());

    assert.deepEqual(
      index.disks.map((record) => record.diskInstance),
      [0, 1, 2],
    );
    assert.deepEqual(
      index.spheres.map((record) => record.slot.id),
      ['root-1', 'root-3'],
    );
    assert.deepEqual(
      index.spheres.map((record) => record.sphereInstance),
      [0, 1],
    );
    assert.deepEqual(
      index.slots.map((record) => record.coneInstance),
      // Cone instances are dense inside each bucket, so root-3 is instance 0 of
      // its own 0.5 bucket.
      [0, undefined, 0],
    );

    const diskOnly = index.slots[1];
    assert.equal(diskOnly.coneInstance, undefined);
    assert.equal(diskOnly.sphereInstance, undefined);
    assert.equal(Object.prototype.hasOwnProperty.call(diskOnly, 'bucketKey'), false);
    assert.equal(diskOnly.ratio, 1, 'a cone-less root has no ratio to draw');

    assert.deepEqual(index.counts, { disks: 3, cones: 2, spheres: 2, buckets: 2 });
  });

  it('records an inline root’s fixed disk height and no cone', () => {
    const index = buildRootSlotIndex([
      {
        color: '#ff8800',
        roots: [
          root('inline', 'sup', at(0, 0, 1), {
            bottomRadius: 3,
            topRadius: 1,
            effectiveDiskHeight: 0.1,
            coneHeight: 0,
          }),
        ],
      },
    ]);

    const [record] = index.slots;
    assert.equal(record.slot.diskHeight, 0.1);
    assert.equal(record.slot.coneHeight, 0);
    assert.equal(record.diskInstance, 0);
    assert.equal(index.buckets.length, 0);
    assert.equal(index.spheres.length, 0);
    assert.deepEqual(index.counts, { disks: 1, cones: 0, spheres: 0, buckets: 0 });
  });

  it('copies the slot data and leaves the render lift to the writer', () => {
    const input = groups();
    const index = buildRootSlotIndex(input);
    const source = input[0].roots[0];

    const slot = index.slots[0].slot;
    assert.notEqual(slot.basePos, source.basePos);
    assert.deepEqual(slot.basePos, at(1, 1, 2));
    assert.equal(slot.bottomRadius, 4);
    assert.equal(slot.topRadius, 1);
    assert.equal(slot.diskHeight, 0.1);
    assert.equal(slot.coneHeight, 0.6);
    assert.equal(slot.modelId, undefined);
    assert.equal(Object.prototype.hasOwnProperty.call(slot, 'modelId'), false);

    // The lift is a rendering offset, not a producer position: the slot still
    // sits exactly on the plate and the writer raises it.
    assert.equal(slot.basePos.z, 2);

    source.basePos.x = 99;
    assert.deepEqual(slot.basePos, at(1, 1, 2), 'the slot never aliases a live producer vector');

    const withModel = buildRootSlotIndex([
      {
        color: '#000000',
        roots: [root('modelled', 'sup', at(0, 0, 0), { modelId: 'model-1' })],
      },
    ]);
    assert.equal(withModel.slots[0].slot.modelId, 'model-1');
    assert.equal(index.slots[2].color, '#888888');

    const negative = buildRootSlotIndex([
      {
        color: '#000000',
        roots: [root('negative', 'sup', at(0, 0, 0), { coneHeight: -1 })],
      },
    ]);
    assert.equal(negative.slots[0].slot.coneHeight, 0);
    assert.equal(negative.buckets.length, 0);
  });

  it('maps support and primitive ids, falling back to the root’s own id', () => {
    const index = buildRootSlotIndex(groups());

    assert.deepEqual(index.bySupport.get('sup-1'), [0, 1]);
    assert.deepEqual(index.bySupport.get('sup-2'), [2]);
    assert.deepEqual([...index.byPrimitive.entries()], [
      ['root-1', 0],
      ['root-2', 1],
      ['root-3', 2],
    ]);

    const homeless = buildRootSlotIndex([
      { color: '#000000', roots: [root('homeless', undefined, at(0, 0, 0))] },
    ]);
    assert.equal(homeless.slots[0].slot.supportId, 'homeless');
    assert.deepEqual(homeless.bySupport.get('homeless'), [0]);
  });

  it('returns an empty index for no groups', () => {
    const index = buildRootSlotIndex([]);

    assert.deepEqual(index.slots, []);
    assert.deepEqual(index.buckets, []);
    assert.deepEqual(index.disks, []);
    assert.deepEqual(index.spheres, []);
    assert.equal(index.bySupport.size, 0);
    assert.equal(index.byPrimitive.size, 0);
    assert.deepEqual(index.counts, { disks: 0, cones: 0, spheres: 0, buckets: 0 });
  });
});

describe('the root flag', () => {
  it('is on now that the batch component is the mounted path', () => {
    assert.equal(SUPPORT_INSTANCED_ROOTS, true);
  });
});
