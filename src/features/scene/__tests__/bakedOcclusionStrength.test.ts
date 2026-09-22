import assert from 'node:assert/strict';
import test from 'node:test';
import { BAKED_OCCLUSION_STRENGTH, bakedOcclusionStrength } from '../bakedOcclusion';

test('the slider multiplies the tuned strength, and zero means off', () => {
  assert.equal(bakedOcclusionStrength(0), 0);
  assert.equal(bakedOcclusionStrength(1), BAKED_OCCLUSION_STRENGTH);
  assert.equal(bakedOcclusionStrength(2), BAKED_OCCLUSION_STRENGTH * 2);
  assert.equal(bakedOcclusionStrength(0.5), BAKED_OCCLUSION_STRENGTH * 0.5);
});

test('out of range values cannot flip the occlusion or darken past the range', () => {
  // Negative would brighten the surface, past the slider it would clip.
  assert.equal(bakedOcclusionStrength(-1), 0);
  assert.equal(bakedOcclusionStrength(10), BAKED_OCCLUSION_STRENGTH * 2);
  assert.equal(bakedOcclusionStrength(Number.NaN), BAKED_OCCLUSION_STRENGTH);
});
