import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import test from 'node:test';

import { resolveSceneSliceJob, resolveSceneTipShrinkPercent } from '../../../../scripts/cli/sceneSliceJob';
import { getActiveMaterialProfile, getActivePrinterProfile } from '@/features/profiles/profileStore';
import { calculateTipOffset } from '@/supports/rendering/calculateTipOffset';
import { PRINTERS } from './helpers/sliceJobFixtures';

// Tip penetration reads the active profiles, so `scene slice` must activate the job's own.

const printer = () => PRINTERS[0].cliPrinter();

function activeTipOffset(): number {
  const activePrinter = getActivePrinterProfile()!;
  const activeMaterial = getActiveMaterialProfile()!;
  const pitch = activePrinter.pixelSize!;
  return calculateTipOffset(
    activeMaterial.antiAliasingSettings,
    activeMaterial.layerHeightMm,
    pitch.x / 1000,
    pitch.y / 1000,
  );
}

test('a material passed to scene slice becomes the active one', () => {
  const job = resolveSceneSliceJob({ printer: printer(), material: { name: 'Thin', layerHeightMm: 0.03 } });
  assert.equal(getActivePrinterProfile()?.id, job.printer?.id);
  assert.equal(getActiveMaterialProfile()?.id, job.material?.id);
  assert.equal(getActiveMaterialProfile()?.layerHeightMm, 0.03);
});

test('the tip offset follows the material passed, not the one before it', () => {
  resolveSceneSliceJob({ printer: printer(), material: { name: 'Thick', layerHeightMm: 0.05 } });
  const thick = activeTipOffset();
  resolveSceneSliceJob({ printer: printer(), material: { name: 'Thin', layerHeightMm: 0.03 } });
  const thin = activeTipOffset();
  assert.ok(thin < thick, `0.03 mm layers gave ${thin}, 0.05 mm gave ${thick}`);
});

test('without a material the job and the store still agree', () => {
  const job = resolveSceneSliceJob({ printer: printer() });
  assert.equal(getActiveMaterialProfile()?.id, job.material?.id);
});

test('a layer height override reaches the active material and keeps its other settings', () => {
  const job = resolveSceneSliceJob({
    printer: printer(),
    material: { name: 'Official', layerHeightMm: 0.05, normalExposureSec: 3.3, locked: true },
    layerHeight: '0.03',
  });
  assert.equal(job.material?.layerHeightMm, 0.03);
  assert.equal(getActiveMaterialProfile()?.layerHeightMm, 0.03);
  assert.equal(getActiveMaterialProfile()?.normalExposureSec, 3.3);
});

const mars4Ultra = () => JSON.parse(
  readFileSync(join(__dirname, '../../../../plugins/elegoo/printers/mars-series.json'), 'utf-8'),
) as unknown;
const thinMaterial = (percent?: number) => ({
  name: 'Thin',
  layerHeightMm: 0.03,
  ...(percent === undefined ? {} : { antiAliasingSettings: { supportTipShrinkPercent: percent } }),
});
const shrinkFor = (aaPreset: 'raw' | 'sharp' | 'balanced' | 'smooth', percent?: number) => resolveSceneTipShrinkPercent(
  resolveSceneSliceJob({ printer: mars4Ultra(), printerId: 'Mars 4 Ultra', material: thinMaterial(percent), aaPreset }),
);

test('under 3DAA tips shrink by the material setting, 10 % by default', () => {
  assert.equal(shrinkFor('balanced'), 10);
  assert.equal(shrinkFor('smooth', 25), 25);
  assert.equal(shrinkFor('balanced', 0), 0);
});

test('tips do not shrink without 3DAA or without a printer', () => {
  assert.equal(shrinkFor('sharp', 25), 0);
  assert.equal(shrinkFor('raw', 25), 0);
  assert.equal(resolveSceneTipShrinkPercent(resolveSceneSliceJob({})), 0);
});
