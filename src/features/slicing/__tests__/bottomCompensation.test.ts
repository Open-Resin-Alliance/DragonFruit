import assert from 'node:assert/strict';
import test from 'node:test';

import { buildSceneSliceRun, resolveSceneSliceJob } from '../../../../scripts/cli/sceneSliceJob';
import {
  addMaterialProfile,
  getMaterialProfilesForPrinter,
  updateMaterialProfile,
  type MaterialProfile,
  type PrinterProfile,
} from '@/features/profiles/profileStore';
import { assembleSliceJob, describeSliceJobModel, resolveBottomCompensationLayers } from '../sliceJobAssembly';
import { toNativeMetadataPayload } from '../tauri/nativeSlicerBridge';
import { cubeModel } from './helpers/captureAppSliceJob';
import { MATERIALS, PRINTERS, appMaterial, material } from './helpers/sliceJobFixtures';

/**
 * Bottom contour compensation, from the material profile to the job: off by
 * default, clamped, and applied to the bottom and transition layers the format's
 * encoder reads, fading out through the transition layers unless the material
 * turns the fade off.
 */

const printerFixture = (prefix: string) => {
  const printer = PRINTERS.find((entry) => entry.label.startsWith(prefix));
  assert.ok(printer, `no printer fixture starts with ${prefix}`);
  return printer;
};

function storedMaterial(printer: PrinterProfile, partial: Partial<MaterialProfile>): MaterialProfile {
  const id = addMaterialProfile(printer.id, partial);
  const stored = getMaterialProfilesForPrinter(printer.id).find((entry) => entry.id === id);
  assert.ok(stored, `material ${id} was not stored`);
  return stored;
}

function assemble(printer: PrinterProfile, materialProfile: MaterialProfile) {
  return assembleSliceJob({
    printerProfile: printer,
    materialProfile,
    scene: { totalLayers: 200, tallestObjectHeightMm: 10, models: [describeSliceJobModel(cubeModel('cube', 10))] },
  });
}

test('a material without the fields has compensation off', () => {
  const printer = printerFixture('Saturn 4 (.goo').appPrinter();
  const stored = storedMaterial(printer, { name: 'Plain' });
  assert.equal(stored.bottomOutlineCompensationMm, 0);
  assert.equal(stored.bottomHoleCompensationMm, 0);
  assert.equal(stored.bottomCompensationFade, true, 'the fade is on by default');

  const job = assemble(printer, stored);
  assert.equal(job.bottomOutlineCompensationMm, 0);
  assert.equal(job.bottomHoleCompensationMm, 0);
});

test('the profile store clamps the distances to plus or minus 2 mm', () => {
  const printer = printerFixture('Saturn 4 (.goo').appPrinter();
  const stored = storedMaterial(printer, { bottomOutlineCompensationMm: 5, bottomHoleCompensationMm: -7 });
  assert.equal(stored.bottomOutlineCompensationMm, 2);
  assert.equal(stored.bottomHoleCompensationMm, -2);

  updateMaterialProfile(stored.id, { bottomOutlineCompensationMm: -9, bottomHoleCompensationMm: Number.NaN });
  const updated = getMaterialProfilesForPrinter(printer.id).find((entry) => entry.id === stored.id);
  assert.equal(updated?.bottomOutlineCompensationMm, -2);
  assert.equal(updated?.bottomHoleCompensationMm, -2, 'a non-number keeps the stored value');

  const junk = storedMaterial(printer, {
    bottomOutlineCompensationMm: 'wide' as unknown as number,
    bottomCompensationFade: 'yes' as unknown as boolean,
  });
  assert.equal(junk.bottomOutlineCompensationMm, 0);
  assert.equal(junk.bottomCompensationFade, true);

  const hard = storedMaterial(printer, { bottomCompensationFade: false });
  assert.equal(hard.bottomCompensationFade, false);
  updateMaterialProfile(hard.id, { bottomOutlineCompensationMm: -0.1 });
  assert.equal(
    getMaterialProfilesForPrinter(printer.id).find((entry) => entry.id === hard.id)?.bottomCompensationFade,
    false,
    'an update that leaves the fade out keeps it',
  );
});

test('the bridge clamps what reaches the engine', () => {
  const printer = printerFixture('Saturn 4 (.goo').appPrinter();
  const job = assemble(printer, storedMaterial(printer, {}));
  const payload = toNativeMetadataPayload({
    ...job,
    ...job.antiAliasing,
    aaOnSupports: false,
    pngCompressionStrategy: 'fastest',
    modelTriangleCount: 12,
    trianglesXYZ: new Float32Array(0),
    bottomOutlineCompensationMm: 3,
    bottomHoleCompensationMm: -3,
    bottomCompensationLayers: 4.6,
    bottomCompensationFadeLayers: -1,
  });
  assert.equal(payload.bottom_outline_compensation_mm, 2);
  assert.equal(payload.bottom_hole_compensation_mm, -2);
  assert.equal(payload.bottom_compensation_layers, 5);
  assert.equal(payload.bottom_compensation_fade_layers, 0);
});

test('the layers come from the bottom and transition counts the encoder reads', () => {
  const metadata = (nodes: Record<string, unknown>) => JSON.stringify(nodes);
  const goo = metadata({ material: { bottomLayerCount: 6 }, goo: { transitionLayerCount: 4 } });
  // Fade on: full on the bottom layers, fading over the transition layers.
  assert.deepEqual(resolveBottomCompensationLayers(goo, '.goo', true), { layers: 6, fadeLayers: 4 });
  // Fade off: full on both, then a hard stop.
  assert.deepEqual(resolveBottomCompensationLayers(goo, '.goo', false), { layers: 10, fadeLayers: 0 });
  // The format's own node wins over `material`, as in the GOO and CTB encoders.
  assert.deepEqual(resolveBottomCompensationLayers(
    metadata({ material: { bottomLayerCount: 6 }, export: { ctb: { transitionLayerCount: 2 } } }),
    '.ctb',
    false,
  ), { layers: 8, fadeLayers: 0 });
  assert.deepEqual(resolveBottomCompensationLayers(
    metadata({ material: { bottomLayerCount: 6, transitionLayerCount: 1 }, goo: { bottomLayerCount: 3 } }),
    '.goo',
    true,
  ), { layers: 3, fadeLayers: 1 });
  // No transition layers recorded: the bottom layers alone, and nothing to fade over.
  const nanodlp = metadata({ material: { bottomLayerCount: 6 } });
  assert.deepEqual(resolveBottomCompensationLayers(nanodlp, '.nanodlp', true), { layers: 6, fadeLayers: 0 });
  assert.deepEqual(resolveBottomCompensationLayers(nanodlp, '.nanodlp', false), { layers: 6, fadeLayers: 0 });
  assert.deepEqual(resolveBottomCompensationLayers('not json', '.goo', true), { layers: 0, fadeLayers: 0 });
});

test('a GOO job fades over the stored transition layers', () => {
  const printer = printerFixture('Saturn 4 (.goo').appPrinter();
  const fixture = MATERIALS.find((entry) => entry.bottomCompensation);
  assert.ok(fixture);
  const job = assemble(printer, appMaterial(printer, material(fixture)));
  assert.equal(job.bottomOutlineCompensationMm, -0.12);
  assert.equal(job.bottomHoleCompensationMm, -0.05);
  // 7 bottom layers and 3 transition layers stored for `.goo`.
  assert.equal(job.bottomCompensationLayers, 7);
  assert.equal(job.bottomCompensationFadeLayers, 3);

  const hard = assemble(printer, appMaterial(printer, { ...material(fixture), bottomCompensationFade: false }));
  assert.equal(hard.bottomCompensationLayers, 10);
  assert.equal(hard.bottomCompensationFadeLayers, 0);
});

test('a GOO job without stored settings uses the plugin defaults the encoder writes', () => {
  const printer = printerFixture('Saturn 4 (.goo').appPrinter();
  const job = assemble(printer, storedMaterial(printer, { bottomCompensationFade: false }));
  const parsed = JSON.parse(job.metadataJson) as { material: { bottomLayerCount: number }; goo: { transitionLayerCount: number } };
  assert.equal(job.bottomCompensationLayers, parsed.material.bottomLayerCount + parsed.goo.transitionLayerCount);
  assert.equal(job.bottomCompensationFadeLayers, 0);
});

test('a NanoDLP job covers the material bottom layers only, with no fade', () => {
  const printer = printerFixture('Athena II 16K 8-bit (.nanodlp').appPrinter();
  const job = assemble(printer, storedMaterial(printer, { bottomLayerCount: 6 }));
  assert.equal(job.bottomCompensationLayers, 6);
  assert.equal(job.bottomCompensationFadeLayers, 0);
});

for (const fade of [true, false]) {
  test(`scene slice hands slice run the same compensation as the app, fade ${fade ? 'on' : 'off'}`, () => {
    const fixture = MATERIALS.find((entry) => entry.bottomCompensation);
    assert.ok(fixture);
    const printer = printerFixture('Saturn 4 Ultra 16K (.ctb');
    const raw = { ...material(fixture), bottomCompensationFade: fade };
    const appPrinter = printer.appPrinter();
    const app = assemble(appPrinter, appMaterial(appPrinter, raw));

    const run = buildSceneSliceRun(
      resolveSceneSliceJob({ printer: printer.cliPrinter(), material: raw }),
      { maxZMm: 10, models: [describeSliceJobModel(cubeModel('cube', 10))] },
      'positions.bin',
      'out',
      'job.json',
    );
    assert.ok(run.jobJson);
    const cli = JSON.parse(run.jobJson) as Record<string, unknown>;
    assert.equal(cli.bottom_outline_compensation_mm, -0.12);
    assert.equal(cli.bottom_hole_compensation_mm, -0.05);
    assert.equal(cli.bottom_compensation_layers, app.bottomCompensationLayers);
    assert.equal(cli.bottom_compensation_fade_layers, app.bottomCompensationFadeLayers);
    assert.deepEqual(
      [cli.bottom_compensation_layers, cli.bottom_compensation_fade_layers],
      fade ? [7, 3] : [10, 0],
    );
  });
}
