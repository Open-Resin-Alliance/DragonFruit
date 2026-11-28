import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import test from 'node:test';

import { assembleSliceJob, describeSliceJobModel } from '../sliceJobAssembly';
import { cubeModel } from './helpers/captureAppSliceJob';
import { MATERIALS, PRINTERS, appMaterial, comparableMetadata, material } from './helpers/sliceJobFixtures';

/**
 * `assembleSliceJob` must give, on its own, the fields the app's export hands the
 * native slicer: the CLI calls it without the orchestrator, `window` or Tauri.
 * The expected values are the golden jobs captured from the real orchestrator.
 */

const golden = JSON.parse(
  readFileSync(join(__dirname, 'fixtures/appSliceJobs.golden.json'), 'utf-8'),
) as Record<string, Record<string, unknown>>;

const FIELDS: Array<[keyof ReturnType<typeof assembleSliceJob>, string]> = [
  ['outputFormat', 'output_format'],
  ['formatVersion', 'format_version'],
  ['sourceWidthPx', 'source_width_px'],
  ['sourceHeightPx', 'source_height_px'],
  ['widthPx', 'width_px'],
  ['heightPx', 'height_px'],
  ['xPackingMode', 'x_packing_mode'],
  ['mirrorX', 'mirror_x'],
  ['mirrorY', 'mirror_y'],
  ['buildWidthMm', 'build_width_mm'],
  ['buildDepthMm', 'build_depth_mm'],
  ['layerHeightMm', 'layer_height_mm'],
  ['totalLayers', 'total_layers'],
  ['ditherEnabled', 'dither_enabled'],
  ['ditherBitDepth', 'dither_bit_depth'],
  ['ditherDeviceGamma', 'dither_device_gamma'],
];

for (const printer of PRINTERS) {
  for (const fixture of MATERIALS) {
    const label = `${printer.label}, material ${fixture.label}`;
    test(`assembleSliceJob alone matches the app's job: ${label}`, () => {
      assert.equal(typeof window, 'undefined', 'runs without a window');
      const expected = golden[label];
      assert.ok(expected, `no golden job for "${label}"`);
      const cube = cubeModel('golden-cube', 10);

      const printerProfile = printer.appPrinter();
      const job = assembleSliceJob({
        printerProfile,
        materialProfile: appMaterial(printerProfile, material(fixture)),
        scene: {
          totalLayers: expected.total_layers as number,
          tallestObjectHeightMm: 10,
          models: [describeSliceJobModel(cube)],
        },
      });

      for (const [field, key] of FIELDS) {
        // The Tauri bridge sends an absent format version as null.
        assert.equal(job[field] ?? null, expected[key], field);
      }
      assert.deepStrictEqual(JSON.parse(JSON.stringify(comparableMetadata(job.metadataJson))), expected.metadata_json);
    });
  }
}

/**
 * A material picked from a network printer (the slicing panel's effective profile, with
 * `remoteProcessFields`) is what the file is sliced with: its values win over the per-format
 * settings stored on the local material, which otherwise replace the material's own.
 */
test('a remote material\'s process values win over the stored per-format settings', () => {
  const printer = PRINTERS.find((entry) => entry.label.startsWith('Saturn 4 (.goo'));
  assert.ok(printer, 'the .goo printer fixture');
  const printerProfile = printer.appPrinter();
  const local = appMaterial(printerProfile, material({ label: 'remote', ditherEnabled: false, perFormatSettings: true }));
  const scene = { totalLayers: 200, tallestObjectHeightMm: 10, models: [describeSliceJobModel(cubeModel('remote-cube', 10))] };
  const materialOf = (job: ReturnType<typeof assembleSliceJob>) =>
    (JSON.parse(job.metadataJson) as { material: Record<string, unknown> }).material;

  const stored = materialOf(assembleSliceJob({ printerProfile, materialProfile: local, scene }));
  assert.equal(stored.normalExposureSec, 3.3, 'without a remote material the stored setting wins');
  assert.equal(stored.bottomLayerCount, 7);

  const remote = materialOf(assembleSliceJob({
    printerProfile,
    materialProfile: {
      ...local,
      layerHeightMm: 0.05,
      normalExposureSec: 2.5,
      bottomExposureSec: 30,
      bottomLayerCount: 4,
      remoteProcessFields: ['layerHeightMm', 'normalExposureSec', 'bottomExposureSec', 'bottomLayerCount'],
    },
    scene,
  }));
  assert.equal(remote.layerHeightMm, 0.05);
  assert.equal(remote.normalExposureSec, 2.5);
  assert.equal(remote.bottomExposureSec, 30);
  assert.equal(remote.bottomLayerCount, 4);

  const partial = materialOf(assembleSliceJob({
    printerProfile,
    materialProfile: { ...local, normalExposureSec: 2.5, remoteProcessFields: ['normalExposureSec'] },
    scene,
  }));
  assert.equal(partial.normalExposureSec, 2.5, 'a field the remote material supplied');
  assert.equal(partial.bottomExposureSec, 41, 'a field it did not supply keeps the stored setting');
});
