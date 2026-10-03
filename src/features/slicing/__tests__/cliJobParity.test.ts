import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import test from 'node:test';

import {
  addMaterialProfile,
  addPrinterProfileFromPreset,
  getMaterialProfilesForPrinter,
  getProfileStoreSnapshot,
  importPrinterBundle,
  type MaterialProfile,
  type PrinterProfile,
} from '@/features/profiles/profileStore';
import { resolveSceneSliceJob, sliceRunArgs } from '../../../../scripts/cli/sceneSliceJob';
import { captureAppSliceJob, cubeModel, type CapturedSliceJob } from './helpers/captureAppSliceJob';

/**
 * `scene slice` claims to build the job the app would. This compares the two on
 * the job fields the CLI controls: the app's side is the real orchestrator,
 * captured at the Tauri boundary; the CLI's side is the argv it hands
 * `dragonfruit-cli slice run`.
 *
 * Anti-aliasing is deliberately not compared (out of scope for this parity
 * work): `slice run` has no flags for most of the panel's AA fields.
 */

const REPO_ROOT = join(__dirname, '../../../..');

type PrinterFixture = {
  label: string;
  traits: PrinterTraits;
  /** Where the CLI reads the printer from, as a user would pass it to `--printer`. */
  cliPrinter: () => unknown;
  /** The same printer as the app holds it after the user adds it. */
  appPrinter: () => PrinterProfile;
};

/** What sets this printer apart for the job assembly; drives the known divergences below. */
type PrinterTraits = {
  /** The app packs X for this format (NanoDLP). */
  packed?: boolean;
  /** Width and depth come from resolution × pixel size, not from the profile. */
  derivedBuildVolume?: boolean;
  eightBitPanel?: boolean;
  /** The profile names no format version and the app fills in the format's default. */
  defaultFormatVersion?: boolean;
};

function presetFixture(label: string, file: string, presetId: string, traits: PrinterTraits): PrinterFixture {
  return {
    label,
    traits,
    cliPrinter: () => {
      const presets = JSON.parse(readFileSync(join(REPO_ROOT, file), 'utf-8')) as Array<{ presetId: string }>;
      const preset = presets.find((entry) => entry.presetId === presetId);
      assert.ok(preset, `${presetId} is missing from ${file}`);
      return preset;
    },
    appPrinter: () => storedPrinter(addPrinterProfileFromPreset(presetId)),
  };
}

function bundleFixture(label: string, file: string, traits: PrinterTraits): PrinterFixture {
  const read = () => JSON.parse(readFileSync(join(REPO_ROOT, file), 'utf-8')) as unknown;
  return {
    label,
    traits,
    cliPrinter: read,
    appPrinter: () => storedPrinter(importPrinterBundle(read())),
  };
}

function storedPrinter(id: string): PrinterProfile {
  const printer = getProfileStoreSnapshot().printerProfiles.find((entry) => entry.id === id);
  assert.ok(printer, `printer ${id} was not stored`);
  return printer;
}

// One printer per case the job assembly branches on: container family, packed or
// not, panel bit depth (undeclared, 3, 4, 8), settings mode, and build volume
// declared or derived from the pixel size.
const PRINTERS: PrinterFixture[] = [
  presetFixture('Saturn 4 (.goo, undeclared depth)', 'plugins/elegoo/printers/saturn-series.json', 'elegoo-saturn-4-goo',
    { derivedBuildVolume: true, defaultFormatVersion: true }),
  presetFixture('Saturn 3 (.ctb v5enc, undeclared depth)', 'plugins/elegoo/printers/saturn-series.json', 'elegoo-saturn-3-ctb',
    { derivedBuildVolume: true }),
  presetFixture('Saturn 4 Ultra 16K (.ctb, 3-bit, tilting)', 'plugins/elegoo/printers/saturn-series.json', 'elegoo-saturn-4-ultra-16k-ctb',
    { derivedBuildVolume: true }),
  presetFixture('Mars 2 Pro (.ctb v2, 4-bit, simple)', 'plugins/elegoo/printers/mars-series.json', 'elegoo-mars-2-pro-ctb', {}),
  presetFixture('Athena II 16K (.lumen, 8-bit)', 'plugins/athena/printers/printers.json', 'concepts3d-athena2-16k8b-odyssey',
    { derivedBuildVolume: true, eightBitPanel: true, defaultFormatVersion: true }),
  presetFixture('Athena II 16K 8-bit (.nanodlp)', 'plugins/athena/printers/printers.json', 'concepts3d-athena2-16k8b-nanodlp',
    { packed: true, derivedBuildVolume: true, eightBitPanel: true }),
  presetFixture('Athena II 16K 3-bit (.nanodlp)', 'plugins/athena/printers/printers.json', 'concepts3d-athena2-16k3b-nanodlp',
    { packed: true, derivedBuildVolume: true }),
  bundleFixture('Saturn 4 Ultra 16K bundle (declared build volume)', 'scripts/bench/printers/saturn_4_ultra_16k-bundle.json', {}),
];

type MaterialFixture = { label: string; ditherEnabled: boolean; perFormatSettings?: boolean };

// Dithering on and off, because the panel bit depth decides it differently for
// each; and per-format settings stored on the material, because for GOO, CTB and
// Lumen those (or the plugin's defaults, when none are stored) replace the
// material's own exposure in the metadata the encoders read.
const MATERIALS: MaterialFixture[] = [
  { label: 'dithering on', ditherEnabled: true },
  { label: 'dithering off', ditherEnabled: false },
  { label: 'per-format settings stored', ditherEnabled: false, perFormatSettings: true },
];

/**
 * The material as the slicing panel hands it over: stored for the printer, then
 * read back with the store's per-format settings applied to its own fields.
 */
function appMaterial(printer: PrinterProfile, raw: MaterialProfile): MaterialProfile {
  const partial: Partial<MaterialProfile> = { ...raw };
  delete partial.id;
  const id = addMaterialProfile(printer.id, partial);
  const stored = getMaterialProfilesForPrinter(printer.id).find((entry) => entry.id === id);
  assert.ok(stored, `material ${id} was not stored`);
  return stored;
}

function material(fixture: MaterialFixture): MaterialProfile {
  const stored = { normalExposureSec: 3.3, bottomExposureSec: 41, bottomLayerCount: 7, layerHeightMm: 0.04 };
  const ditherEnabled = fixture.ditherEnabled;
  return {
    id: `parity-material-${fixture.label.replace(/\W+/g, '-')}`,
    name: 'Parity resin',
    layerHeightMm: 0.03,
    normalExposureSec: 2.3,
    bottomExposureSec: 31,
    bottomLayerCount: 6,
    liftDistanceMm: 6,
    liftSpeedMmMin: 60,
    retractSpeedMmMin: 150,
    antiAliasingSettings: { ditherEnabled, ditherBitDepth: 4, ditherDeviceGamma: 2.2 },
    ...(fixture.perFormatSettings
      ? { localSettingsByOutput: { '.goo': stored, '.ctb': stored, '.lumen': stored } }
      : {}),
  } as MaterialProfile;
}

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

/**
 * The metadata the encoders read, minus what differs between any two runs: the
 * creation time, and the ids the profile store generates for the printer and material.
 */
function encoderMetadata(metadataJson: string): Record<string, unknown> {
  const metadata = JSON.parse(metadataJson) as Record<string, unknown>;
  delete metadata.createdAt;
  if (metadata.printer && typeof metadata.printer === 'object') {
    metadata.printer = { ...(metadata.printer as Record<string, unknown>), id: undefined };
  }
  if (metadata.material && typeof metadata.material === 'object') {
    metadata.material = { ...(metadata.material as Record<string, unknown>), id: undefined };
  }
  return metadata;
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
      encoderMetadata(cli.metadata_json as string),
      encoderMetadata(app.metadata_json),
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
