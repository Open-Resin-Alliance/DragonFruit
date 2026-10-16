import assert from 'node:assert/strict';
import test from 'node:test';

import { clampSliceJobNumber, SLICE_JOB_LIMITS } from '../sliceJobLimits';

test('holds each field to its own bounds', () => {
  assert.equal(clampSliceJobNumber('zBlurRadiusLayers', 99), 8);
  assert.equal(clampSliceJobNumber('zBlurRadiusLayers', -3), 0);
  assert.equal(clampSliceJobNumber('containerCompressionLevel', 42), 9);
  assert.equal(clampSliceJobNumber('blurBrushSigmaX', 0), 0.05);
  assert.equal(clampSliceJobNumber('blurBrushSigmaX', 1000), 16);
  assert.equal(clampSliceJobNumber('zBlendMaxAlphaPercent', 150), 100);
  assert.equal(clampSliceJobNumber('supportHaloRadiusPx', 25), 16);
  assert.equal(clampSliceJobNumber('supportHaloRadiusPx', -2), 0);
  assert.equal(clampSliceJobNumber('supportHaloRadiusMm', 1.25), 0.5);
  assert.equal(clampSliceJobNumber('supportHaloRadiusMm', -0.1), 0);
  assert.equal(clampSliceJobNumber('supportHaloInverseScalePercent', 350), 200);
  assert.equal(clampSliceJobNumber('supportHaloInverseScalePercent', -20), 0);
  assert.equal(clampSliceJobNumber('supportHaloMaxIntensityPercent', 140), 100);
  assert.equal(clampSliceJobNumber('supportHaloMaxIntensityPercent', -5), 0);
  assert.equal(clampSliceJobNumber('supportHaloMaxTipDiameterMm', 0.01), 0.1);
  assert.equal(clampSliceJobNumber('supportHaloMaxTipDiameterMm', 9.0), 5.0);
});

test('snaps before applying the bounds', () => {
  // 8.4 rounds to 8 and stays inside the range; 8.6 rounds to 9 and is capped.
  assert.equal(clampSliceJobNumber('zBlurRadiusLayers', 8.4), 8);
  assert.equal(clampSliceJobNumber('zBlurRadiusLayers', 8.6), 8);
  assert.equal(clampSliceJobNumber('modelTriangleCount', 12.9), 12);
  assert.equal(clampSliceJobNumber('blurBrushRadiusPx', 2.5), 3);
  assert.equal(clampSliceJobNumber('supportHaloRadiusPx', 3.6), 4);
});

test('leaves unsnapped fields fractional', () => {
  assert.equal(clampSliceJobNumber('zBlurSigma', 1.25), 1.25);
  assert.equal(clampSliceJobNumber('zBlendMinimumAlphaPercent', 33.5), 33.5);
  assert.equal(clampSliceJobNumber('supportHaloRadiusMm', 0.18), 0.18);
  assert.equal(clampSliceJobNumber('supportHaloMaxTipDiameterMm', 0.75), 0.75);
});

test('substitutes the fallback for a missing or non-numeric input', () => {
  assert.equal(clampSliceJobNumber('zBlendLookBack', undefined), 2);
  assert.equal(clampSliceJobNumber('zBlurSigma', null), 0.5);
  assert.equal(clampSliceJobNumber('zBlendLookBack', 'not a number'), 2);
  assert.equal(clampSliceJobNumber('zBlendMaxAlphaPercent', Number.NaN), 90);
  assert.equal(clampSliceJobNumber('supportHaloRadiusPx', undefined), 0);
  assert.equal(clampSliceJobNumber('supportHaloRadiusMm', undefined), 0.15);
  assert.equal(clampSliceJobNumber('supportHaloInverseScalePercent', undefined), 100);
  assert.equal(clampSliceJobNumber('supportHaloMaxIntensityPercent', undefined), 25);
  assert.equal(clampSliceJobNumber('supportHaloMaxTipDiameterMm', undefined), 0.8);
});

test('never returns a non-finite number', () => {
  const fields = Object.keys(SLICE_JOB_LIMITS) as Array<keyof typeof SLICE_JOB_LIMITS>;
  const hostile = [undefined, null, Number.NaN, Infinity, -Infinity, 'x', {}, []];

  for (const field of fields) {
    for (const value of hostile) {
      const result = clampSliceJobNumber(field, value);
      assert.ok(
        Number.isFinite(result),
        `${field} returned ${result} for ${String(value)}`,
      );
    }
  }
});

test('every fallback is itself inside its bounds', () => {
  for (const [field, limit] of Object.entries(SLICE_JOB_LIMITS)) {
    assert.ok(limit.fallback >= limit.min, `${field} fallback below min`);
    if ('max' in limit) {
      assert.ok(limit.fallback <= limit.max, `${field} fallback above max`);
    }
  }
});
