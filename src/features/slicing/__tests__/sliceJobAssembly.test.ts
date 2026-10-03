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
