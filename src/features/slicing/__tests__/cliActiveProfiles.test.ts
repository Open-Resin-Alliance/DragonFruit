import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import test from 'node:test';

import { resolveSceneSliceJob, resolveSceneTipShrinkPercent } from '../../../../scripts/cli/sceneSliceJob';
import { getActiveMaterialProfile, getActivePrinterProfile } from '@/features/profiles/profileStore';
import { calculateTipOffset } from '@/supports/rendering/calculateTipOffset';
import { PRINTERS } from './helpers/sliceJobFixtures';

/**
 * Support tip penetration reads the active profiles from the store while the
 * mesh is built, so `scene slice` has to activate the job's own. Otherwise the
 * tips sink by the offset of whichever material the store started with.
 */

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

test('a layer height override reaches the active material', () => {
  const job = resolveSceneSliceJob({
    printer: printer(),
    material: { name: 'Thin', layerHeightMm: 0.05 },
    layerHeight: '0.03',
  });
  assert.equal(job.material?.layerHeightMm, 0.03);
  assert.equal(getActiveMaterialProfile()?.layerHeightMm, 0.03);
});

test('a layer height override leaves the job on the material it asked for', () => {
  const job = resolveSceneSliceJob({
    printer: printer(),
    material: { name: 'Official', layerHeightMm: 0.05, normalExposureSec: 3.3, locked: true },
    layerHeight: '0.03',
  });
  assert.equal(job.material?.normalExposureSec, 3.3);
  assert.equal(getActiveMaterialProfile()?.normalExposureSec, 3.3);
  assert.equal(getActiveMaterialProfile()?.layerHeightMm, 0.03);
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

test('3DAA presets shrink tips by the material default, as the app does', () => {
  assert.equal(shrinkFor('balanced'), 10);
  assert.equal(shrinkFor('smooth'), 10);
});

test('the material decides how much tips shrink under 3DAA', () => {
  assert.equal(shrinkFor('balanced', 25), 25);
  assert.equal(shrinkFor('balanced', 0), 0);
});

test('tips do not shrink without 3DAA', () => {
  assert.equal(shrinkFor('sharp', 25), 0);
  assert.equal(shrinkFor('raw', 25), 0);
});

test('a job without a printer has no tip shrink', () => {
  assert.equal(resolveSceneTipShrinkPercent(resolveSceneSliceJob({})), 0);
});
