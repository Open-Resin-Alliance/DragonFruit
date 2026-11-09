import { describe, it } from 'node:test';
import assert from 'node:assert';
import { splitBatchedShafts } from '../Curves/batchedBezierTubeGeometry';
import type { InstancedShaft } from '../SupportPrimitives/Shaft/InstancedShaftGroup';

function shaft(id: string, z0: number, z1: number, curved = false): InstancedShaft {
  return {
    id,
    start: { x: 0, y: 0, z: z0 },
    end: { x: 0, y: 0, z: z1 },
    diameter: 1,
    controlPoint1: curved ? { x: 1, y: 0, z: z0 } : undefined,
    controlPoint2: curved ? { x: 1, y: 0, z: z1 } : undefined,
  } as InstancedShaft;
}

describe('batched shaft split', () => {
  it('separates curved from straight', () => {
    const { straightShafts, curvedShafts } = splitBatchedShafts([shaft('a', 0, 5), shaft('b', 0, 5, true)]);

    assert.deepStrictEqual(straightShafts.map((s) => s.id), ['a']);
    assert.deepStrictEqual(curvedShafts.map((s) => s.id), ['b']);
  });

  it('drops a shaft with no length, so it is not drawn and cannot be hovered', () => {
    // A leaf's contact point is a zero-length segment. The straight batch answers
    // hover from an index of its instances, so anything dropped here has to be
    // dropped there too: leaving it in the index shifts every later instance and
    // a hit resolves to a neighbouring support's model.
    const { straightShafts, curvedShafts } = splitBatchedShafts([shaft('a', 0, 5), shaft('leaf', 3, 3), shaft('c', 0, 5)]);

    assert.deepStrictEqual(straightShafts.map((s) => s.id), ['a', 'c']);
    assert.deepStrictEqual(curvedShafts, []);
  });

  it('keeps the input order, which the instance index depends on', () => {
    const ids = ['a', 'b', 'c', 'd', 'e'];
    const { straightShafts } = splitBatchedShafts(ids.map((id) => shaft(id, 0, 5)));

    assert.deepStrictEqual(straightShafts.map((s) => s.id), ids);
  });

  it('drops a curve whose control net collapses to a point', () => {
    const collapsed = {
      id: 'flat',
      start: { x: 0, y: 0, z: 0 },
      end: { x: 0, y: 0, z: 0 },
      diameter: 1,
      controlPoint1: { x: 0, y: 0, z: 0 },
      controlPoint2: { x: 0, y: 0, z: 0 },
    } as InstancedShaft;

    const { straightShafts, curvedShafts } = splitBatchedShafts([collapsed]);

    assert.deepStrictEqual(straightShafts, []);
    assert.deepStrictEqual(curvedShafts, []);
  });
});
