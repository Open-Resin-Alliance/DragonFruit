import assert from 'node:assert/strict';
import test from 'node:test';

import { resolveSceneSliceJob, sliceRunArgs } from '../../../../scripts/cli/sceneSliceJob';
import { captureAppSliceJob, cubeModel, type CapturedSliceJob } from './helpers/captureAppSliceJob';
import { MATERIALS, PRINTERS, appMaterial, comparableMetadata, material, type PrinterTraits } from './helpers/sliceJobFixtures';

/**
 * `scene slice` claims to build the job the app would. This compares the two on
 * the job fields the CLI controls: the app's side is the real orchestrator,
 * captured at the Tauri boundary; the CLI's side is the argv it hands
 * `dragonfruit-cli slice run`.
 *
 * Anti-aliasing is deliberately not compared (out of scope for this parity
 * work): `slice run` has no flags for most of the panel's AA fields.
 */

/** Reads the `slice run` flags back into the native job's field names. */
function cliJob(argv: string[]): Record<string, unknown> {
  const value = (flag: string) => {
    const index = argv.indexOf(flag);
    return index < 0 ? undefined : argv[index + 1];
  };
  const number = (flag: string) => (value(flag) === undefined ? undefined : Number(value(flag)));
  const dither = argv.includes('--dither');
  return {
    source_width_px: number('--source-width-px'),
    source_height_px: number('--source-height-px'),
    x_packing_mode: value('--x-packing-mode') ?? 'none',
    mirror_x: argv.includes('--mirror-x'),
    mirror_y: argv.includes('--mirror-y'),
    format_version: value('--format-version') ?? null,
    build_width_mm: number('--build-width-mm'),
    build_depth_mm: number('--build-depth-mm'),
    layer_height_mm: number('--layer-height'),
    dither_enabled: dither,
    dither_bit_depth: dither ? number('--dither-bit-depth') : null,
    dither_device_gamma: dither ? number('--dither-device-gamma') : null,
    metadata_json: value('--metadata-json') ?? '{}',
  };
}


type Aspect = {
  name: string;
  /** Why the CLI is known to differ from the app here; such cases run as `todo`. */
  knownDivergence?: (traits: PrinterTraits, ditherEnabled: boolean) => string | undefined;
  compare: (app: CapturedSliceJob, cli: Record<string, unknown>) => void;
};

const ASPECTS: Aspect[] = [
  {
    name: 'raster grid and mirroring',
    compare: (app, cli) => {
      for (const key of ['source_width_px', 'source_height_px', 'mirror_x', 'mirror_y']) {
        assert.equal(cli[key], app[key], key);
      }
    },
  },
  {
    name: 'format version',
    knownDivergence: (traits) => (traits.defaultFormatVersion
      ? 'the CLI passes the profile\'s format version as is and never resolves the format\'s default'
      : undefined),
    compare: (app, cli) => assert.equal(cli.format_version, app.format_version),
  },
  {
    name: 'x-packing',
    knownDivergence: (traits) => (traits.packed
      ? undefined
      : 'the CLI always packs X; the app packs only when the format declares it (NanoDLP)'),
    compare: (app, cli) => assert.equal(cli.x_packing_mode, app.x_packing_mode),
  },
  {
    name: 'build volume',
    knownDivergence: (traits) => (traits.derivedBuildVolume
      ? 'the CLI falls back to 218 × 122 mm where the app derives width and depth from resolution × pixel size'
      : undefined),
    compare: (app, cli) => {
      assert.equal(cli.build_width_mm, app.build_width_mm, 'build_width_mm');
      assert.equal(cli.build_depth_mm, app.build_depth_mm, 'build_depth_mm');
    },
  },
  {
    name: 'layer height',
    knownDivergence: () => 'the CLI defaults to 0.05 mm instead of the material\'s layer height',
    compare: (app, cli) => assert.equal(cli.layer_height_mm, app.layer_height_mm),
  },
  {
    name: 'dithering',
    knownDivergence: (traits, ditherEnabled) => (traits.eightBitPanel && ditherEnabled
      ? 'the CLI\'s copy of the dither policy predates #652 and dithers 8-bit panels to 7 bits'
      : undefined),
    compare: (app, cli) => {
      assert.equal(cli.dither_enabled, app.dither_enabled, 'dither_enabled');
      if (app.dither_enabled) {
        assert.equal(cli.dither_bit_depth, app.dither_bit_depth, 'dither_bit_depth');
        assert.equal(cli.dither_device_gamma, app.dither_device_gamma, 'dither_device_gamma');
      }
    },
  },
  {
    name: 'encoder metadata',
    knownDivergence: () => 'the CLI never passes --metadata-json, so every encoder reads {}',
    compare: (app, cli) => assert.deepEqual(
      comparableMetadata(cli.metadata_json as string),
      comparableMetadata(app.metadata_json),
    ),
  },
];

for (const printer of PRINTERS) {
  for (const materialFixture of MATERIALS) {
    const { ditherEnabled } = materialFixture;
    const caseLabel = `${printer.label}, material ${materialFixture.label}`;
    let jobs: Promise<{ app: CapturedSliceJob; cli: Record<string, unknown> }> | undefined;
    const bothJobs = () => {
      jobs ??= (async () => {
        const appPrinter = printer.appPrinter();
        const app = await captureAppSliceJob({
          models: [cubeModel('parity-cube', 10)],
          printerProfile: appPrinter,
          materialProfile: appMaterial(appPrinter, material(materialFixture)),
        });
        const cli = cliJob(sliceRunArgs(
          resolveSceneSliceJob({ printer: printer.cliPrinter(), material: material(materialFixture) }),
          'positions.bin',
          'out',
        ));
        return { app, cli };
      })();
      return jobs;
    };

    for (const aspect of ASPECTS) {
      const todo = aspect.knownDivergence?.(printer.traits, ditherEnabled);
      test(`scene slice matches the app: ${aspect.name} (${caseLabel})`, { todo }, async () => {
        const { app, cli } = await bothJobs();
        aspect.compare(app, cli);
      });
    }
  }
}
