import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { quantizeToScale } from '@/utils/math';
import { isTaperedShaft } from '../../SupportPrimitives/Shaft/InstancedShaftGroup';
import type { InstancedShaft } from '../../SupportPrimitives/Shaft/InstancedShaftGroup';
import type { Vec3 } from '../../types';
import {
  buildShaftSlotIndex,
  shaftTaperRatio,
  type ShaftSlotGroup,
} from '../shaftSlots';

const at = (x: number, y: number, z: number) => ({ x, y, z });

/** The buckets-per-ratio-unit the legacy tapered group quantizes with. */
const LEGACY_TAPER_BUCKETS = 20;

function straight(
  id: string,
  supportId: string,
  start: Vec3,
  end: Vec3,
  diameter: number,
  modelId?: string,
): InstancedShaft {
  return { id, supportId, start, end, diameter, ...(modelId ? { modelId } : {}) };
}

function tapered(
  id: string,
  supportId: string,
  start: Vec3,
  end: Vec3,
  diameter: number,
  diameterEnd: number,
): InstancedShaft {
  return { id, supportId, start, end, diameter, diameterEnd };
}

function curved(
  id: string,
  supportId: string,
  start: Vec3,
  end: Vec3,
  diameter: number,
): InstancedShaft {
  return {
    id,
    supportId,
    start,
    end,
    diameter,
    controlPoint1: at(start.x + 0.3, start.y + 0.4, start.z),
    controlPoint2: at(end.x - 0.3, end.y + 0.4, end.z),
  };
}

/**
 * Two colours, one support split across both groups, a zero-length shaft, a
 * collapsed curve, and the same colour appearing twice: the producer's grouping
 * with every case the index has to resolve.
 */
function groups(): ShaftSlotGroup[] {
  return [
    {
      color: '#a1a1a1',
      shafts: [
        straight('s-1', 'sup-1', at(0, 0, 0), at(0, 0, 10), 1.2, 'model-1'),
        tapered('s-2', 'sup-1', at(0, 0, 10), at(0, 0, 20), 1, 0.7),
        // A leaf's shaft: dropped by the split, so it must not have a slot.
        straight('s-zero', 'sup-1', at(0, 0, 20), at(0, 0, 20), 0.4),
        curved('c-1', 'sup-2', at(1, 0, 0), at(1, 0, 5), 0.32),
        // Collapsed control net: also not drawn, so also not a curve.
        {
          id: 'c-collapsed',
          supportId: 'sup-2',
          start: at(2, 0, 0),
          end: at(2, 0, 0),
          diameter: 0.3,
          controlPoint1: at(2, 0, 0),
          controlPoint2: at(2, 0, 0),
        },
      ],
    },
    {
      color: '#b2b2b2',
      shafts: [
        straight('s-3', 'sup-3', at(0, 1, 0), at(0, 1, 4), 0.8),
        // 0.72 quantizes to the same 0.7 bucket as s-2.
        tapered('s-4', 'sup-3', at(0, 1, 4), at(0, 1, 8), 1, 0.72),
        curved('c-2', 'sup-4', at(3, 0, 0), at(3, 0, 5), 0.32),
      ],
    },
    {
      // The same colour in a later group merges into the one tube mesh.
      color: '#a1a1a1',
      shafts: [curved('c-3', 'sup-5', at(4, 0, 0), at(4, 0, 5), 0.32)],
    },
  ];
}

describe('buildShaftSlotIndex', () => {
  it('keeps group order then shaft order, and drops the entries the split drops', () => {
    const index = buildShaftSlotIndex(groups());

    assert.deepEqual(
      index.slots.map((record) => record.slot.id),
      ['s-1', 's-2', 's-3', 's-4'],
    );
    assert.deepEqual(
      index.slots.map((record) => record.id),
      [0, 1, 2, 3],
    );
    assert.deepEqual(
      index.straight.map((record) => record.slot.id),
      ['s-1', 's-3'],
    );
    assert.equal(index.counts.straight, 2);
    assert.equal(index.counts.tapered, 2);
    assert.equal(index.counts.curved, 3);
  });

  it('numbers straight slots densely, so the slot is the drawn instance', () => {
    const index = buildShaftSlotIndex(groups());

    assert.deepEqual(
      index.straight.map((record) => record.instance),
      [0, 1],
    );
    for (const record of index.straight) {
      assert.equal(record.kind, 'straight');
      assert.equal(record.ratio, 1);
      assert.equal(record.bucketKey, undefined);
      assert.ok(!Object.prototype.hasOwnProperty.call(record, 'bucketKey'));
    }
  });

  it('buckets tapered slots by the legacy quantized ratio, first seen first', () => {
    const index = buildShaftSlotIndex(groups());

    assert.equal(index.tapered.length, 1);
    const [bucket] = index.tapered;
    assert.equal(bucket.ratio, quantizeToScale(0.7, LEGACY_TAPER_BUCKETS));
    assert.equal(bucket.key, String(bucket.ratio));
    assert.deepEqual(
      bucket.slots.map((record) => record.slot.id),
      ['s-2', 's-4'],
    );
    assert.deepEqual(
      bucket.slots.map((record) => record.instance),
      [0, 1],
    );
    for (const record of bucket.slots) {
      assert.equal(record.kind, 'tapered');
      assert.equal(record.bucketKey, bucket.key);
      assert.equal(record.ratio, bucket.ratio);
    }
  });

  it('gives every tapered bucket the width the legacy cone template expects', () => {
    const index = buildShaftSlotIndex(groups());

    // The ratio is the cone's top radius over the unit template's bottom radius,
    // so `diameter * ratio` is the width at `end`.
    for (const bucket of index.tapered) {
      for (const record of bucket.slots) {
        const widthAtEnd = record.slot.diameter * record.ratio;
        assert.ok(Math.abs(widthAtEnd - record.slot.diameterEnd) <= 0.05 * record.slot.diameter / 2);
      }
    }
  });

  it('separates tapered from straight with the group’s own predicate', () => {
    const index = buildShaftSlotIndex([
      {
        color: '#000000',
        shafts: [
          // A taper inside the epsilon is the same width at both ends: straight.
          {
            id: 's-tiny-taper',
            supportId: 'sup-1',
            start: at(0, 0, 0),
            end: at(0, 0, 1),
            diameter: 1,
            diameterEnd: 1 + 5e-7,
          },
          // Past it, the shaft needs a cone of its own.
          tapered('s-taper', 'sup-1', at(0, 0, 1), at(0, 0, 2), 1, 0.9),
        ],
      },
    ]);

    assert.deepEqual(index.straight.map((record) => record.slot.id), ['s-tiny-taper']);
    assert.deepEqual(index.slots.map((record) => record.kind), ['straight', 'tapered']);
    assert.equal(isTaperedShaft({ id: 'x', start: at(0, 0, 0), end: at(0, 0, 1), diameter: 1, diameterEnd: 1 }), false);
  });

  it('groups curves by colour without converting them to instances', () => {
    const input = groups();
    const index = buildShaftSlotIndex(input);

    const first = index.curvedByColor.get('#a1a1a1');
    const second = index.curvedByColor.get('#b2b2b2');
    assert.ok(first && second);
    assert.deepEqual(first.map((shaft) => shaft.id), ['c-1', 'c-3']);
    assert.deepEqual(second.map((shaft) => shaft.id), ['c-2']);
    // The tube builder caches by shaft identity, so the producer's objects are
    // handed on, not copied.
    assert.equal(first[0], input[0].shafts[3]);
    assert.equal(index.curvedByColor.has('#c0c0c0'), false);
    assert.equal(
      index.slots.some((record) => record.slot.id.startsWith('c-')),
      false,
    );
  });

  it('maps support ids to their batch-drawn slots, across groups', () => {
    const index = buildShaftSlotIndex(groups());

    assert.deepEqual(index.bySupport.get('sup-1'), [0, 1]);
    assert.deepEqual(index.bySupport.get('sup-3'), [2, 3]);
    // Curves are not batch slots: they keep the legacy curved overlay.
    assert.equal(index.bySupport.has('sup-2'), false);
    assert.equal(index.bySupport.size, 2);
  });

  it('maps primitive ids to the batch and instance that draw them', () => {
    const index = buildShaftSlotIndex(groups());

    assert.deepEqual(index.byPrimitive.get('s-1'), { kind: 'straight', id: 0, instance: 0 });
    assert.deepEqual(index.byPrimitive.get('s-3'), { kind: 'straight', id: 2, instance: 1 });
    assert.deepEqual(index.byPrimitive.get('s-4'), {
      kind: 'tapered',
      id: 3,
      instance: 1,
      bucket: String(quantizeToScale(0.7, LEGACY_TAPER_BUCKETS)),
    });
    assert.deepEqual(index.byPrimitive.get('c-3'), { kind: 'curved', color: '#a1a1a1', instance: 1 });
    assert.equal(index.byPrimitive.has('s-zero'), false);
    assert.equal(index.byPrimitive.has('c-collapsed'), false);
  });

  it('groups a shaft with no owning support under its own id', () => {
    const index = buildShaftSlotIndex([
      {
        color: '#000000',
        shafts: [{ id: 'homeless', start: at(0, 0, 0), end: at(0, 0, 1), diameter: 1 }],
      },
    ]);

    assert.equal(index.slots.length, 1);
    assert.equal(index.slots[0].slot.supportId, 'homeless');
    assert.deepEqual(index.bySupport.get('homeless'), [0]);
  });

  it('copies the endpoints and copies only what the producer resolved', () => {
    const input = groups();
    const index = buildShaftSlotIndex(input);
    const source = input[0].shafts[0];

    const slot = index.slots[0].slot;
    assert.notEqual(slot.start, source.start);
    assert.deepEqual(slot.start, at(0, 0, 0));
    assert.deepEqual(slot.end, at(0, 0, 10));
    assert.equal(slot.diameter, 1.2);
    assert.equal(slot.diameterEnd, 1.2, 'a straight slot is uniform at both ends');
    assert.equal(slot.modelId, 'model-1');

    source.start.x = 99;
    source.end.z = 99;
    assert.deepEqual(slot.start, at(0, 0, 0), 'the slot never aliases a live producer vector');
    assert.deepEqual(slot.end, at(0, 0, 10));

    // No drop offset is applied here: the producer already baked it in, so the
    // written position is exactly the produced one.
    const taperedSlot = index.slots[1].slot;
    assert.deepEqual(taperedSlot.start, at(0, 0, 10));
    assert.deepEqual(taperedSlot.end, at(0, 0, 20));
    assert.equal(taperedSlot.diameterEnd, 0.7);
    assert.equal(taperedSlot.modelId, undefined);
    assert.ok(!Object.prototype.hasOwnProperty.call(taperedSlot, 'modelId'));
    assert.equal(index.slots[2].color, '#b2b2b2');
  });

  it('returns an empty index for no groups', () => {
    const index = buildShaftSlotIndex([]);

    assert.deepEqual(index.slots, []);
    assert.deepEqual(index.straight, []);
    assert.deepEqual(index.tapered, []);
    assert.equal(index.curvedByColor.size, 0);
    assert.equal(index.bySupport.size, 0);
    assert.equal(index.byPrimitive.size, 0);
    assert.deepEqual(index.counts, { straight: 0, tapered: 0, curved: 0 });
  });
});

describe('shaftTaperRatio', () => {
  it('matches the legacy quantizer, including a widening upward', () => {
    for (const [diameter, diameterEnd] of [
      [1, 0.7],
      [1, 0.72],
      [1.2, 0.4],
      [0.4, 1],
      [2, 2],
      [0.325, 0.325],
    ]) {
      assert.equal(
        shaftTaperRatio({ diameter, diameterEnd }),
        quantizeToScale(diameterEnd / diameter, LEGACY_TAPER_BUCKETS),
      );
    }
  });

  it('never divides by a zero diameter', () => {
    assert.equal(shaftTaperRatio({ diameter: 0, diameterEnd: 0 }), 1);
  });
});
