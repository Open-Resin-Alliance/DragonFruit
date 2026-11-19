import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import test from 'node:test';

import {
  buildSceneSliceRun,
  resolveSceneSliceJob,
  type SceneSliceGeometry,
  type SceneSliceJobOptions,
} from '../sceneSliceJob';

const REPO_ROOT = join(__dirname, '../../..');
const S4U_16K_BUNDLE = JSON.parse(
  readFileSync(join(REPO_ROOT, 'scripts/bench/printers/saturn_4_ultra_16k-bundle.json'), 'utf-8'),
) as unknown;

const TEST_GEOMETRY: SceneSliceGeometry = {
  maxZMm: 22.2,
  modelTriangleCount: 12,
  models: [
    {
      id: 'cube-1',
      name: 'Cube.stl',
      polygonCount: 12,
      transform: {
        position: { x: 0, y: 0, z: 13.5355 },
        rotation: { x: 0.7854, y: 0.7854, z: 1.5708 },
        scale: { x: 1, y: 1, z: 1 },
      },
    },
  ],
};

function assembleJobPayload(options: SceneSliceJobOptions): Record<string, unknown> {
  const job = resolveSceneSliceJob({
    printer: S4U_16K_BUNDLE,
    ...options,
  });
  const run = buildSceneSliceRun(job, TEST_GEOMETRY, 'positions.bin', 'out.ctb', 'job.json');
  assert.ok(run.jobJson, 'Expected jobJson to be produced when printer is provided');
  return JSON.parse(run.jobJson) as Record<string, unknown>;
}

test('sceneSliceJob: --support-halo with --aa-preset raw enables Stage 5 calibrated defaults while preserving Off/Coverage AA', () => {
  const noHalo = assembleJobPayload({ aaPreset: 'raw' });
  const withHalo = assembleJobPayload({ aaPreset: 'raw', supportHalo: 'on' });

  assert.equal(noHalo.support_halo_enabled, false);
  assert.equal(noHalo.anti_aliasing_level, 'Off');
  assert.equal(noHalo.anti_aliasing_mode, 'Coverage');

  assert.equal(withHalo.support_halo_enabled, true);
  assert.equal(withHalo.support_halo_radius_mm, 0.15);
  assert.equal(withHalo.support_halo_inverse_scale_percent, 100);
  assert.equal(withHalo.support_halo_max_intensity_percent, 25);
  assert.equal(withHalo.support_halo_profile, 'donut');
  assert.equal(withHalo.support_halo_scope, 'tips_only');
  assert.equal(withHalo.support_halo_max_tip_diameter_mm, 0.8);

  // Critical: enabling --support-halo MUST NOT clobber --aa-preset raw
  assert.equal(withHalo.anti_aliasing_level, 'Off');
  assert.equal(withHalo.anti_aliasing_mode, 'Coverage');
  assert.equal(withHalo.blur_brush_radius_px, 0);
  assert.equal(withHalo.z_blur_radius_layers, 0);
});

test('sceneSliceJob: --support-halo is orthogonal to --aa-preset sharp, balanced, and smooth', () => {
  for (const preset of ['sharp', 'balanced', 'smooth'] as const) {
    const base = assembleJobPayload({ aaPreset: preset });
    const halo = assembleJobPayload({ aaPreset: preset, supportHalo: true });

    assert.equal(base.support_halo_enabled, false, `${preset} base should have halo disabled`);
    assert.equal(halo.support_halo_enabled, true, `${preset} + supportHalo should have halo enabled`);
    assert.equal(halo.support_halo_profile, 'donut');
    assert.equal(halo.support_halo_radius_mm, 0.15);
    assert.equal(halo.support_halo_inverse_scale_percent, 100);
    assert.equal(halo.support_halo_max_intensity_percent, 25);

    // Every core AA parameter of the preset must remain untouched
    assert.equal(halo.anti_aliasing_mode, base.anti_aliasing_mode, `${preset} mode mismatch`);
    assert.equal(halo.anti_aliasing_level, base.anti_aliasing_level, `${preset} level mismatch`);
    assert.equal(halo.blur_brush_radius_px, base.blur_brush_radius_px, `${preset} blur radius mismatch`);
    assert.equal(halo.z_blur_radius_layers, base.z_blur_radius_layers, `${preset} z-blur mismatch`);
    assert.equal(halo.z_blend_look_back, base.z_blend_look_back, `${preset} z-lookback mismatch`);
  }
});

test('sceneSliceJob: granular --support-halo-* flags implicitly enable supportHaloEnabled and override defaults', () => {
  const payload = assembleJobPayload({
    aaPreset: 'balanced',
    supportHaloRadiusMm: '0.25',
    supportHaloInverseScalePercent: '50',
    supportHaloMaxIntensityPercent: '40',
    supportHaloProfile: 'exp_decay',
    supportHaloScope: 'full_supports',
    supportHaloMaxTipDiameterMm: '1.2',
  });

  assert.equal(payload.support_halo_enabled, true);
  assert.equal(payload.support_halo_radius_mm, 0.25);
  assert.equal(payload.support_halo_inverse_scale_percent, 50);
  assert.equal(payload.support_halo_max_intensity_percent, 40);
  assert.equal(payload.support_halo_profile, 'gaussian');
  assert.equal(payload.support_halo_scope, 'full_supports');
  assert.equal(payload.support_halo_max_tip_diameter_mm, 1.2);
  // Preserves balanced 3DAA mode
  assert.equal(payload.anti_aliasing_mode, 'Vertical2');
});

test('sceneSliceJob: --no-support-halo (supportHalo: "off") disables halo even when --aa-settings enables it', () => {
  const payload = assembleJobPayload({
    aaPreset: 'sharp',
    aaSettings: {
      antiAliasingSettings: {
        supportHaloEnabled: true,
        supportHaloRadiusMm: 0.22,
      },
    },
    supportHalo: 'off',
  });

  assert.equal(payload.support_halo_enabled, false);
  // Also verify that aaSettings with only supportHalo* fields did not force balanced/default override over sharp
  assert.equal(payload.anti_aliasing_mode, 'Blur');
});

test('sceneSliceJob: inline 2DAA and 3DAA override flags configure explicit UI modes cleanly with and without halo', () => {
  const blur8x = assembleJobPayload({
    aaMode: 'Blur',
    aaLevel: '8x',
    blurRadiusPx: '2',
    supportHalo: 'on',
  });
  assert.equal(blur8x.anti_aliasing_mode, 'Blur');
  assert.equal(blur8x.anti_aliasing_level, '8x');
  assert.equal(blur8x.blur_brush_radius_px, 2);
  assert.equal(blur8x.support_halo_enabled, true);

  const daa16x = assembleJobPayload({
    aaMode: '3DAA',
    aaLevel: '16x',
    blurRadiusPx: '2',
    zBlurRadiusLayers: '2',
    zBlendLookBack: '4',
    supportHalo: 'on',
  });
  assert.equal(daa16x.anti_aliasing_mode, 'Vertical2');
  assert.equal(daa16x.anti_aliasing_level, '16x');
  assert.equal(daa16x.blur_brush_radius_px, 2);
  assert.equal(daa16x.z_blur_radius_layers, 2);
  assert.equal(daa16x.z_blend_look_back, 4);
  assert.equal(daa16x.support_halo_enabled, true);
});
