import { describe, it } from 'node:test';
import assert from 'node:assert';
import {
  coneBucketKey,
  conePrimitiveScales,
  coneShapeRatio,
  type InstancedContactCone,
} from '../ContactCone/InstancedContactConeGroup';

/** The scale maths is float, so compare with a tolerance rather than exactly. */
function closeTo(actual: readonly number[], expected: readonly number[]): void {
  assert.strictEqual(actual.length, expected.length);
  for (let i = 0; i < expected.length; i += 1) {
    assert.ok(Math.abs(actual[i] - expected[i]) < 1e-9, `axis ${i}: ${actual[i]} != ${expected[i]}`);
  }
}

function cone(overrides: Partial<InstancedContactCone['profile']> = {}, pos = { x: 0, y: 0, z: 0 }): InstancedContactCone {
  return {
    id: 'c',
    modelId: 'm',
    pos,
    normal: { x: 0, y: 0, z: 1 },
    profile: {
      type: 'disk',
      contactDiameterMm: 0.4,
      bodyDiameterMm: 1.2,
      lengthMm: 2,
      penetrationMm: 0.1,
      diskThicknessMm: 0.1,
      maxStandoffMm: 1.5,
      standoffAngleThreshold: 0.5,
      ...overrides,
    },
  } as InstancedContactCone;
}

describe('cone batch shape', () => {
  it('keys on the shape ratio, so two cones that differ only in size share a mesh', () => {
    const small = cone();
    const large = cone({ contactDiameterMm: 0.8, bodyDiameterMm: 2.4, lengthMm: 4 });

    closeTo([coneShapeRatio(small)], [3]);
    closeTo([coneShapeRatio(large)], [3]);
    assert.strictEqual(coneBucketKey(small), coneBucketKey(large));
  });

  it('separates cones whose tips genuinely differ in shape', () => {
    const narrow = cone({ contactDiameterMm: 0.4, bodyDiameterMm: 1.2 });
    const wide = cone({ contactDiameterMm: 0.4, bodyDiameterMm: 2.0 });

    assert.notStrictEqual(coneBucketKey(narrow), coneBucketKey(wide));
  });

  it('shares a bucket between ratios inside the 0.05 step and splits across it', () => {
    // Ratios 3.0 and 3.005: a 0.005 difference is a quarter of a micron of body
    // radius on a 0.2 mm contact radius, and must not buy a new draw call.
    const base = cone({ contactDiameterMm: 0.4, bodyDiameterMm: 1.2 });
    const nearlyIdentical = cone({ contactDiameterMm: 0.4, bodyDiameterMm: 1.202 });
    // Ratio 3.05 is the next bucket and genuinely differs by a step.
    const nextStep = cone({ contactDiameterMm: 0.4, bodyDiameterMm: 1.22 });

    assert.strictEqual(coneBucketKey(base), coneBucketKey(nearlyIdentical));
    assert.notStrictEqual(coneBucketKey(base), coneBucketKey(nextStep));
  });

  it('separates a disk profile from a sphere profile', () => {
    assert.notStrictEqual(coneBucketKey(cone({ type: 'disk' })), coneBucketKey(cone({ type: 'sphere' })));
  });

  it('scales a unit disk to its radius and its thickness plus penetration', () => {
    const scales = conePrimitiveScales(cone(), 0.1, 0.05);

    closeTo(scales.disk, [0.2, 0.15, 0.2]);
  });

  it('scales a unit body to its radius and length, keeping the tip ratio in the geometry', () => {
    const scales = conePrimitiveScales(cone(), 0.1, 0);

    closeTo(scales.body, [0.2, 2, 0.2]);
  });

  it('scales a unit sphere uniformly', () => {
    const scales = conePrimitiveScales(cone(), 0, 0);

    closeTo(scales.tip, [0.2, 0.2, 0.2]);
  });

  it('never scales a primitive to zero', () => {
    const degenerate = cone({ contactDiameterMm: 0, bodyDiameterMm: 0, lengthMm: 0 });
    const scales = conePrimitiveScales(degenerate, 0, 0);

    for (const axis of [...scales.disk, ...scales.body, ...scales.tip]) {
      assert.ok(axis > 0, `axis ${axis} should stay positive`);
    }
  });
});
