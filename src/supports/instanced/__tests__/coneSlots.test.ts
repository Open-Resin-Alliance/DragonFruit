import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import {
  CONE_RATIO_BUCKET_STEP,
  CONE_RATIO_BUCKETS_PER_UNIT,
  coneShapeRatio,
  getDiskThicknessForCone,
  getProfileType,
  type InstancedContactCone,
} from '../../SupportPrimitives/ContactCone/InstancedContactConeGroup';
import type { SupportTipProfile } from '../../SupportPrimitives/ContactCone/types';
import type { Vec3 } from '../../types';
import { SUPPORT_INSTANCED_CONES, SUPPORT_INSTANCED_ROOTS } from '../flags';
import { buildConeSlotIndex, type ConeSlotGroup } from '../coneSlots';

const at = (x: number, y: number, z: number): Vec3 => ({ x, y, z });

function diskProfile(
  contactDiameterMm = 0.4,
  bodyDiameterMm = 1.2,
  lengthMm = 3,
): SupportTipProfile {
  return {
    type: 'disk',
    contactDiameterMm,
    bodyDiameterMm,
    lengthMm,
    penetrationMm: 0.05,
    diskThicknessMm: 0.1,
    maxStandoffMm: 0.25,
    standoffAngleThreshold: Math.PI / 4,
  };
}

function sphereProfile(
  contactDiameterMm = 0.4,
  bodyDiameterMm = 1.2,
  lengthMm = 3,
): SupportTipProfile {
  return {
    type: 'sphere',
    sphereRadiusRatio: 1.5,
    contactDiameterMm,
    bodyDiameterMm,
    lengthMm,
    penetrationMm: 0.05,
  };
}

function legacyProfile(
  contactDiameterMm = 0.4,
  bodyDiameterMm = 1.2,
  lengthMm = 3,
): SupportTipProfile {
  return { contactDiameterMm, bodyDiameterMm, lengthMm, penetrationMm: 0.05 };
}

function cone(
  id: string,
  supportId: string | undefined,
  pos: Vec3,
  normal: Vec3,
  profile: SupportTipProfile,
  extra: Partial<InstancedContactCone> = {},
): InstancedContactCone {
  return {
    id,
    ...(supportId !== undefined ? { supportId } : {}),
    pos,
    normal,
    profile,
    ...extra,
  };
}

/**
 * Two colours, all three profile kinds, a bucket shared by two raw ratios, a
 * support owning two cones, and a degenerate normal.
 *
 * Raw body/contact ratios: cone-1 3.075, cone-2 3.11 (both bucket "3.1"),
 * cone-3 3 (bucket "3"), cone-4 3.075 ("3.1").
 */
function groups(): ConeSlotGroup[] {
  return [
    {
      color: '#a1a1a1',
      cones: [
        cone('cone-1', 'sup-1', at(0, 0, 1), at(0, 0, -1), diskProfile(0.4, 1.23, 3)),
        cone(
          'cone-2',
          'sup-1',
          at(1, 0, 1),
          at(0, 0, -1),
          sphereProfile(0.4, 1.244, 4),
          { surfaceNormal: at(0.2, 0, -0.98) },
        ),
        cone('cone-3', 'sup-2', at(2, 0, 1), at(0, 0, -1), legacyProfile(0.4, 1.2, 5)),
        // The legacy group drops this one: `setFromUnitVectors` would go NaN.
        cone('cone-bad', 'sup-2', at(3, 0, 1), at(0, 0, 0), diskProfile(0.4, 1.23, 3)),
      ],
    },
    {
      color: '#b2b2b2',
      cones: [
        cone('cone-4', 'sup-3', at(4, 0, 1), at(0, 0, -1), diskProfile(0.4, 1.23, 3)),
      ],
    },
  ];
}

describe('buildConeSlotIndex', () => {
  it('keeps producer order and drops only the degenerate normals', () => {
    const index = buildConeSlotIndex(groups());

    assert.deepEqual(
      index.slots.map((record) => record.slot.id),
      ['cone-1', 'cone-2', 'cone-3', 'cone-4'],
    );
    assert.deepEqual(
      index.slots.map((record) => record.id),
      [0, 1, 2, 3],
    );
    assert.equal(index.byPrimitive.has('cone-bad'), false);
    assert.equal(index.bySupport.has('missing'), false);

    // A normal below the epsilon is dropped too: the legacy filter is `>`.
    const boundary = buildConeSlotIndex([
      {
        color: '#000000',
        cones: [cone('tiny', 'sup', at(0, 0, 0), at(1e-5, 0, 0), legacyProfile())],
      },
    ]);
    assert.equal(boundary.slots.length, 0);
  });

  it('numbers the body densely inside its bucket, tips and disks densely across the index', () => {
    const index = buildConeSlotIndex(groups());

    assert.deepEqual(
      index.bodies.map((bucket) => bucket.key),
      ['3.1', '3'],
    );
    assert.deepEqual(
      index.bodies[0].records.map((record) => record.slot.id),
      ['cone-1', 'cone-2', 'cone-4'],
    );
    assert.deepEqual(
      index.bodies[0].records.map((record) => record.bodyInstance),
      [0, 1, 2],
    );
    assert.deepEqual(
      index.bodies[1].records.map((record) => record.bodyInstance),
      [0],
    );

    assert.deepEqual(
      index.tips.map((record) => record.tipInstance),
      [0, 1, 2, 3],
    );
    assert.deepEqual(
      index.slots.map((record) => record.diskInstance),
      // Only a disk profile has a nib: cone-1 and cone-4 carry one, while the
      // sphere cone-2 and the legacy cone-3 draw a body and a tip alone.
      [0, undefined, undefined, 1],
    );
    assert.deepEqual(
      index.disks.map((record) => record.slot.id),
      ['cone-1', 'cone-4'],
    );

    assert.deepEqual(index.counts, { bodies: 4, tips: 4, disks: 2 });
  });

  it('keys the body bucket on the quantized ratio but draws it with the first raw ratio', () => {
    const [diskCone] = groups()[0].cones;

    assert.equal(CONE_RATIO_BUCKET_STEP, 0.1);
    assert.equal(CONE_RATIO_BUCKETS_PER_UNIT, 10);

    const index = buildConeSlotIndex([groups()[0]]);
    const bucket = index.bodies[0];
    const rawRatio = coneShapeRatio(diskCone);

    assert.equal(bucket.key, '3.1');
    assert.equal(bucket.ratio, rawRatio, 'the geometry ratio is the first-seen raw one');
    assert.notEqual(bucket.ratio, 3.1, 'the bucket does not quantize its own geometry');
    // Every instance in the bucket, first one included, reports that geometry.
    for (const record of bucket.records) {
      assert.equal(record.bodyRatio, rawRatio);
      assert.equal(record.bodyBucket, '3.1');
    }
    assert.ok(Math.abs(coneShapeRatio(groups()[0].cones[1]) - rawRatio) > 0.01);
  });

  it('merges the three profile kinds into one body bucket', () => {
    const index = buildConeSlotIndex([
      {
        color: '#000000',
        cones: [
          cone('disk', 'sup', at(0, 0, 0), at(0, 0, 1), diskProfile(0.4, 1.2, 3)),
          cone('sphere', 'sup', at(1, 0, 0), at(0, 0, 1), sphereProfile(0.4, 1.2, 3)),
          cone('legacy', 'sup', at(2, 0, 0), at(0, 0, 1), legacyProfile(0.4, 1.2, 3)),
        ],
      },
    ]);

    assert.equal(index.bodies.length, 1);
    assert.deepEqual(
      index.bodies[0].records.map((record) => record.kind),
      ['disk', 'sphere', 'legacy'],
    );
    assert.deepEqual(
      index.slots.map((record) => record.kind),
      ['disk', 'sphere', 'legacy'],
    );
    // The profile only decides which contact primitives exist.
    assert.deepEqual(
      index.slots.map((record) => record.kind),
      [
        getProfileType(diskProfile()),
        getProfileType(sphereProfile()),
        getProfileType(legacyProfile()),
      ],
    );
    assert.equal(index.counts.bodies, 3);
    assert.equal(index.counts.tips, 3);
    assert.equal(index.counts.disks, 1);
  });

  it('resolves the contact radius, the length and the nib thickness the legacy group uses', () => {
    const input = groups();
    const index = buildConeSlotIndex(input);

    const diskSlot = index.slots[0].slot;
    assert.equal(diskSlot.contactRadius, 0.2);
    assert.equal(diskSlot.lengthMm, 3);
    assert.equal(diskSlot.diskThickness, getDiskThicknessForCone(input[0].cones[0]));
    // Normal and surface normal agree, so the nib is at its minimum: the round
    // tip's radius (0.2) beats the authored 0.1.
    assert.equal(diskSlot.diskThickness, 0.2);

    assert.equal(index.slots[1].slot.diskThickness, 0, 'a sphere profile has no nib');
    assert.equal(index.slots[2].slot.diskThickness, 0, 'a legacy profile has no nib');
    // The authored embed depth travels with the slot: it is the fallback a nib
    // is sunk by when the active material does not compute one.
    assert.deepEqual(
      index.slots.map((record) => record.slot.penetrationMm),
      [0.05, 0.05, 0.05, 0.05],
    );

    const overridden = buildConeSlotIndex([
      {
        color: '#000000',
        cones: [
          cone('over', 'sup', at(0, 0, 0), at(0, 0, 1), diskProfile(), {
            diskLengthOverride: 0.35,
          }),
        ],
      },
    ]);
    assert.equal(overridden.slots[0].slot.diskThickness, 0.35);
  });

  it('copies positions and normals and resolves the effective surface normal', () => {
    const input = groups();
    const index = buildConeSlotIndex(input);
    const source = input[0].cones[0];

    const slot = index.slots[0].slot;
    assert.notEqual(slot.pos, source.pos);
    assert.deepEqual(slot.pos, at(0, 0, 1));
    assert.notEqual(slot.normal, source.normal);
    assert.deepEqual(slot.normal, at(0, 0, -1));
    assert.notEqual(slot.surfaceNormal, source.normal);
    assert.deepEqual(slot.surfaceNormal, at(0, 0, -1), 'no surface normal falls back to the axis');

    // cone-2 authored a different surface normal, which the slot keeps.
    assert.deepEqual(index.slots[1].slot.surfaceNormal, at(0.2, 0, -0.98));

    source.pos.x = 99;
    source.normal.z = 99;
    assert.deepEqual(slot.pos, at(0, 0, 1), 'the slot never aliases a live producer vector');
    assert.deepEqual(slot.normal, at(0, 0, -1));

    // The producer already applied the model drop offset: the slot simply keeps
    // the produced position, and nothing here re-adds the offset.
    assert.deepEqual(index.slots[1].slot.pos, at(1, 0, 1));
    assert.equal(index.slots[0].color, '#a1a1a1');
    assert.equal(index.slots[3].color, '#b2b2b2');
  });

  it('keeps penetration out of the index: it is a writer input', () => {
    const index = buildConeSlotIndex(groups());

    for (const record of index.slots) {
      assert.equal(Object.prototype.hasOwnProperty.call(record.slot, 'penetration'), false);
      assert.equal(Object.prototype.hasOwnProperty.call(record, 'penetration'), false);
    }
  });

  it('maps support ids across groups, with a stick contributing two cones', () => {
    const index = buildConeSlotIndex(groups());

    assert.deepEqual(index.bySupport.get('sup-1'), [0, 1]);
    assert.deepEqual(index.bySupport.get('sup-2'), [2]);
    assert.deepEqual(index.bySupport.get('sup-3'), [3]);
    assert.deepEqual([...index.byPrimitive.entries()], [
      ['cone-1', 0],
      ['cone-2', 1],
      ['cone-3', 2],
      ['cone-4', 3],
    ]);

    const homeless = buildConeSlotIndex([
      {
        color: '#000000',
        cones: [cone('homeless', undefined, at(0, 0, 0), at(0, 0, 1), legacyProfile())],
      },
    ]);
    assert.equal(homeless.slots[0].slot.supportId, 'homeless');
    assert.deepEqual(homeless.bySupport.get('homeless'), [0]);
  });

  it('keeps the model id only when the producer had one', () => {
    const index = buildConeSlotIndex([
      {
        color: '#000000',
        cones: [
          cone('with-model', 'sup', at(0, 0, 0), at(0, 0, 1), legacyProfile(), {
            modelId: 'model-1',
          }),
          cone('no-model', 'sup', at(0, 0, 0), at(0, 0, 1), legacyProfile()),
        ],
      },
    ]);

    assert.equal(index.slots[0].slot.modelId, 'model-1');
    assert.equal(index.slots[1].slot.modelId, undefined);
    assert.equal(
      Object.prototype.hasOwnProperty.call(index.slots[1].slot, 'modelId'),
      false,
    );
  });

  it('returns an empty index for no groups', () => {
    const index = buildConeSlotIndex([]);

    assert.deepEqual(index.slots, []);
    assert.deepEqual(index.bodies, []);
    assert.deepEqual(index.tips, []);
    assert.deepEqual(index.disks, []);
    assert.equal(index.bySupport.size, 0);
    assert.equal(index.byPrimitive.size, 0);
    assert.deepEqual(index.counts, { bodies: 0, tips: 0, disks: 0 });
  });
});

describe('the cone and root flags', () => {
  it('are on now that the batch components are the mounted path', () => {
    assert.equal(SUPPORT_INSTANCED_CONES, true);
    assert.equal(SUPPORT_INSTANCED_ROOTS, true);
  });
});
