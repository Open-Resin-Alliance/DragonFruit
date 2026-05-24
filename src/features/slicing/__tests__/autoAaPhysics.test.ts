import assert from 'node:assert/strict';
import test from 'node:test';

import { computePhysicalAaConfig } from '../autoAaPhysics';

test('balanced auto uses 3DAA for fine-pitch thick-layer printers', () => {
  const cfg = computePhysicalAaConfig('balanced', 0.019, 0.05);

  assert.equal(cfg.aaMode, '3DAA');
  assert.equal(cfg.antiAliasingMode, 'Vertical2');
  assert.equal(cfg.aaSteps, 8);
  assert.equal(cfg.blurBrushRadiusPx, 2);
  assert.equal(cfg.zBlurRadiusLayers, 2);
  assert.equal(cfg.zBlendLookBack, 4);
});

test('sharp auto preserves fine detail with coverage supersampling instead of blur', () => {
  const cfg = computePhysicalAaConfig('sharp', 0.019, 0.05);

  assert.equal(cfg.aaMode, 'Blur');
  assert.equal(cfg.antiAliasingMode, 'Coverage');
  assert.equal(cfg.aaSteps, 4);
  assert.equal(cfg.blurBrushRadiusPx, 0);
  assert.equal(cfg.zBlurRadiusLayers, 0);
});

test('balanced auto avoids 3DAA when very thin layers make Z stairs sub-pixel', () => {
  const cfg = computePhysicalAaConfig('balanced', 0.047, 0.01);

  assert.equal(cfg.aaMode, 'Blur');
  assert.equal(cfg.antiAliasingMode, 'Blur');
  assert.equal(cfg.zBlurRadiusLayers, 0);
});

test('balanced auto scales from typical 4K and low-resolution voxel geometry', () => {
  const fourK = computePhysicalAaConfig('balanced', 0.047, 0.05);
  assert.equal(fourK.aaMode, '3DAA');
  assert.equal(fourK.aaSteps, 4);
  assert.equal(fourK.blurBrushRadiusPx, 1);
  assert.equal(fourK.zBlendLookBack, 3);

  const coarse = computePhysicalAaConfig('balanced', 0.085, 0.05);
  assert.equal(coarse.aaMode, '3DAA');
  assert.equal(coarse.aaSteps, 3);
  assert.equal(coarse.zBlendLookBack, 2);
});

test('auto uses area-equivalent pitch and a small boost for non-square pixels', () => {
  const cfg = computePhysicalAaConfig('balanced', 0.035, 0.05, 0.070);

  assert.equal(cfg.antiAliasingMode, 'Vertical2');
  assert.equal(cfg.aaSteps, 5);
  assert.ok(Math.abs(cfg.pixelPitchMm - Math.sqrt(0.035 * 0.070)) < 1e-9);
});
