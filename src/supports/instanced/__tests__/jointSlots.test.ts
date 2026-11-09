import { describe, it } from 'node:test';
import assert from 'node:assert';
import { buildJointSlotIndex } from '../jointSlots';
import type { JointSlotGroup } from '../jointSlots';
import type { InstancedJoint } from '../../SupportPrimitives/Joint/InstancedJointGroup';

const at = (x: number, y: number, z: number) => ({ x, y, z });

/**
 * Two colours, a support split across both groups, a joint with no owner, and a
 * joint id repeated in the last group: the producer's colour grouping with every
 * case the index has to resolve.
 */
function jointGroups(): JointSlotGroup[] {
  const firstJoint: InstancedJoint = {
    id: 'joint-1',
    supportId: 'sup-1',
    modelId: 'model-1',
    pos: at(0, 0, 1),
    diameter: 1.05,
  };
  const secondJoint: InstancedJoint = {
    id: 'joint-2',
    supportId: 'sup-1',
    pos: at(0, 0, 2),
    diameter: 1.2,
  };
  const thirdJoint: InstancedJoint = {
    id: 'joint-3',
    supportId: 'sup-2',
    pos: at(1, 0, 3),
    diameter: 0.9,
  };
  const fourthJoint: InstancedJoint = {
    id: 'joint-4',
    supportId: 'sup-1',
    modelId: 'model-2',
    pos: at(2, 0, 4),
    diameter: 1.1,
  };
  const homelessJoint: InstancedJoint = {
    id: 'joint-homeless',
    pos: at(3, 0, 5),
    diameter: 0.8,
  };
  const repeatedIdJoint: InstancedJoint = {
    id: 'joint-1',
    supportId: 'sup-3',
    pos: at(4, 0, 6),
    diameter: 1.4,
  };

  return [
    {
      color: '#a1a1a1',
      joints: [firstJoint, secondJoint, thirdJoint],
    },
    {
      color: '#b2b2b2',
      joints: [
        fourthJoint,
        homelessJoint,
        repeatedIdJoint,
        {
          id: 'joint-5',
          supportId: 'sup-4',
          pos: at(5, 0, 7),
          diameter: 1.0,
        },
      ],
    },
  ];
}

describe('buildJointSlotIndex', () => {
  it('keeps group order then joint order, so slot index is the instance id', () => {
    const index = buildJointSlotIndex(jointGroups());

    assert.deepStrictEqual(
      index.slots.map((slot) => slot.id),
      ['joint-1', 'joint-2', 'joint-3', 'joint-4', 'joint-homeless', 'joint-1', 'joint-5'],
    );
    assert.deepStrictEqual(
      index.slots.map((slot) => slot.diameter),
      [1.05, 1.2, 0.9, 1.1, 0.8, 1.4, 1.0],
    );
    assert.deepStrictEqual(index.slots[3].pos, at(2, 0, 4));
    assert.strictEqual(index.slots[3].supportId, 'sup-1');
    assert.strictEqual(index.slots[3].modelId, 'model-2');
    assert.strictEqual(index.slots[2].modelId, undefined);
    assert.ok(!Object.prototype.hasOwnProperty.call(index.slots[2], 'modelId'));
  });

  it('maps each support id to its slot indices, across groups', () => {
    const index = buildJointSlotIndex(jointGroups());

    assert.deepStrictEqual(index.bySupport.get('sup-1'), [0, 1, 3]);
    assert.deepStrictEqual(index.bySupport.get('sup-2'), [2]);
    assert.deepStrictEqual(index.bySupport.get('sup-3'), [5]);
    assert.deepStrictEqual(index.bySupport.get('sup-4'), [6]);
    assert.strictEqual(index.bySupport.size, 5);
  });

  it('groups a joint without a support id under its own id', () => {
    const index = buildJointSlotIndex(jointGroups());

    assert.deepStrictEqual(index.bySupport.get('joint-homeless'), [4]);
    assert.strictEqual(index.slots[4].supportId, 'joint-homeless');
    assert.strictEqual(index.byPrimitive.get('joint-homeless'), 4);
  });

  it('mirrors each group colour onto its slots', () => {
    const index = buildJointSlotIndex(jointGroups());

    assert.deepStrictEqual(index.colorBySlot, ['#a1a1a1', '#a1a1a1', '#a1a1a1', '#b2b2b2', '#b2b2b2', '#b2b2b2', '#b2b2b2']);
    assert.strictEqual(index.colorBySlot.length, index.slots.length);
  });

  it('maps joint id to slot index, last wins on a repeated id', () => {
    const index = buildJointSlotIndex(jointGroups());

    assert.deepStrictEqual(
      [...index.byPrimitive.entries()],
      [
        ['joint-1', 5],
        ['joint-2', 1],
        ['joint-3', 2],
        ['joint-4', 3],
        ['joint-homeless', 4],
        ['joint-5', 6],
      ],
    );
    assert.strictEqual(index.slots[index.byPrimitive.get('joint-1')!].diameter, 1.4);
  });

  it('copies pos and diameter instead of aliasing the producer', () => {
    const groups = jointGroups();
    const sourceJoint = groups[0].joints[0];
    const index = buildJointSlotIndex(groups);

    assert.notStrictEqual(index.slots[0].pos, sourceJoint.pos);
    assert.deepStrictEqual(index.slots[0].pos, at(0, 0, 1));
    assert.strictEqual(index.slots[0].diameter, sourceJoint.diameter);

    const sourcePos = { x: sourceJoint.pos.x, y: sourceJoint.pos.y, z: sourceJoint.pos.z };
    sourceJoint.pos.x = 99;
    sourceJoint.diameter = 42;
    assert.deepStrictEqual(index.slots[0].pos, sourcePos);
    assert.strictEqual(index.slots[0].diameter, 1.05);

    index.slots[0].pos.y = -7;
    assert.strictEqual(sourceJoint.pos.y, sourcePos.y);
  });

  it('returns an empty index for no groups', () => {
    const index = buildJointSlotIndex([]);

    assert.deepStrictEqual(index.slots, []);
    assert.deepStrictEqual(index.colorBySlot, []);
    assert.strictEqual(index.bySupport.size, 0);
    assert.strictEqual(index.byPrimitive.size, 0);
  });
});
