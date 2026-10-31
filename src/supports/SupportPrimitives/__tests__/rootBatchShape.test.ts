import { describe, it } from 'node:test';
import assert from 'node:assert';
import {
  rootBucketKey,
  rootInstanceScales,
  rootShapeRatio,
  type InstancedRoot,
} from '../Roots/InstancedRootsGroup';

function root(overrides: Partial<InstancedRoot> = {}): InstancedRoot {
  return {
    id: 'r',
    modelId: 'm',
    basePos: { x: 0, y: 0, z: 0 },
    bottomRadius: 2,
    topRadius: 0.5,
    effectiveDiskHeight: 0.3,
    coneHeight: 1.2,
    ...overrides,
  };
}

function closeTo(actual: readonly number[], expected: readonly number[]): void {
  assert.strictEqual(actual.length, expected.length);
  for (let i = 0; i < expected.length; i += 1) {
    assert.ok(Math.abs(actual[i] - expected[i]) < 1e-9, `axis ${i}: ${actual[i]} != ${expected[i]}`);
  }
}

describe('root batch shape', () => {
  it('keys on the cone ratio, so roots that differ only in size share a mesh', () => {
    const small = root({ bottomRadius: 2, topRadius: 0.5, effectiveDiskHeight: 0.3, coneHeight: 1.2 });
    // Same top-to-bottom ratio, twice the size and a different disk height.
    const large = root({ bottomRadius: 4, topRadius: 1, effectiveDiskHeight: 0.5, coneHeight: 2.4 });

    assert.ok(Math.abs(rootShapeRatio(small) - 0.25) < 1e-9);
    assert.strictEqual(rootBucketKey(small), rootBucketKey(large));
  });

  it('separates roots whose base cones genuinely differ in taper', () => {
    const steep = root({ bottomRadius: 2, topRadius: 0.5 });
    const gentle = root({ bottomRadius: 2, topRadius: 1.5 });

    assert.notStrictEqual(rootBucketKey(steep), rootBucketKey(gentle));
  });

  it('scales the unit disk, cone and sphere by each root dimension', () => {
    const scales = rootInstanceScales(root({ bottomRadius: 2, topRadius: 0.5, effectiveDiskHeight: 0.3, coneHeight: 1.2 }));

    closeTo(scales.disk, [2, 0.3, 2]);
    closeTo(scales.cone, [2, 1.2, 2]);
    closeTo(scales.sphere, [0.5, 0.5, 0.5]);
  });

  it('never scales a primitive to zero on a degenerate root', () => {
    const scales = rootInstanceScales(root({ bottomRadius: 0, topRadius: 0, effectiveDiskHeight: 0, coneHeight: 0 }));

    for (const axis of [...scales.disk, ...scales.cone, ...scales.sphere]) {
      assert.ok(axis > 0, `axis ${axis} should stay positive`);
    }
  });
});
