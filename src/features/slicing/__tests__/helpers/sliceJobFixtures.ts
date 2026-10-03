import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import {
  addMaterialProfile,
  addPrinterProfileFromPreset,
  getMaterialProfilesForPrinter,
  getProfileStoreSnapshot,
  importPrinterBundle,
  type MaterialProfile,
  type PrinterProfile,
} from '@/features/profiles/profileStore';

/**
 * Printers and materials the slice-job tests run over. One printer per case the
 * job assembly branches on, each reachable the way a user would reach it: from
 * an official preset, or from an app-exported bundle.
 */

const REPO_ROOT = join(__dirname, '../../../../..');

export type PrinterFixture = {
  label: string;
  /** Where the CLI reads the printer from, as a user would pass it to `--printer`. */
  cliPrinter: () => unknown;
  /** The same printer as the app holds it after the user adds it. */
  appPrinter: () => PrinterProfile;
};

function presetFixture(label: string, file: string, presetId: string): PrinterFixture {
  return {
    label,
    cliPrinter: () => {
      const presets = JSON.parse(readFileSync(join(REPO_ROOT, file), 'utf-8')) as Array<{ presetId: string }>;
      const preset = presets.find((entry) => entry.presetId === presetId);
      assert.ok(preset, `${presetId} is missing from ${file}`);
      return preset;
    },
    appPrinter: () => storedPrinter(addPrinterProfileFromPreset(presetId)),
  };
}

function bundleFixture(label: string, file: string): PrinterFixture {
  const read = () => JSON.parse(readFileSync(join(REPO_ROOT, file), 'utf-8')) as unknown;
  return {
    label,
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
export const PRINTERS: PrinterFixture[] = [
  presetFixture('Saturn 4 (.goo, undeclared depth)', 'plugins/elegoo/printers/saturn-series.json', 'elegoo-saturn-4-goo'),
  presetFixture('Saturn 3 (.ctb v5enc, undeclared depth)', 'plugins/elegoo/printers/saturn-series.json', 'elegoo-saturn-3-ctb'),
  presetFixture('Saturn 4 Ultra 16K (.ctb, 3-bit, tilting)', 'plugins/elegoo/printers/saturn-series.json', 'elegoo-saturn-4-ultra-16k-ctb'),
  presetFixture('Mars 2 Pro (.ctb v2, 4-bit, simple)', 'plugins/elegoo/printers/mars-series.json', 'elegoo-mars-2-pro-ctb'),
  presetFixture('Athena II 16K (.lumen, 8-bit)', 'plugins/athena/printers/printers.json', 'concepts3d-athena2-16k8b-odyssey'),
  presetFixture('Athena II 16K 8-bit (.nanodlp)', 'plugins/athena/printers/printers.json', 'concepts3d-athena2-16k8b-nanodlp'),
  presetFixture('Athena II 16K 3-bit (.nanodlp)', 'plugins/athena/printers/printers.json', 'concepts3d-athena2-16k3b-nanodlp'),
  bundleFixture('Saturn 4 Ultra 16K bundle (declared build volume)', 'scripts/bench/printers/saturn_4_ultra_16k-bundle.json'),
];

export type MaterialFixture = { label: string; ditherEnabled: boolean; perFormatSettings?: boolean };

// Dithering on and off, because the panel bit depth decides it differently for
// each; and per-format settings stored on the material, because for GOO, CTB and
// Lumen those (or the plugin's defaults, when none are stored) replace the
// material's own exposure in the metadata the encoders read.
export const MATERIALS: MaterialFixture[] = [
  { label: 'dithering on', ditherEnabled: true },
  { label: 'dithering off', ditherEnabled: false },
  { label: 'per-format settings stored', ditherEnabled: false, perFormatSettings: true },
];

/**
 * The material as the slicing panel hands it over: stored for the printer, then
 * read back with the store's per-format settings applied to its own fields.
 */
export function appMaterial(printer: PrinterProfile, raw: MaterialProfile): MaterialProfile {
  const partial: Partial<MaterialProfile> = { ...raw };
  delete partial.id;
  const id = addMaterialProfile(printer.id, partial);
  const stored = getMaterialProfilesForPrinter(printer.id).find((entry) => entry.id === id);
  assert.ok(stored, `material ${id} was not stored`);
  return stored;
}

export function material(fixture: MaterialFixture): MaterialProfile {
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

/**
 * The metadata the encoders read, minus what differs between any two runs: the
 * creation time, and the ids the profile store generates for the printer and material.
 */
export function comparableMetadata(metadataJson: string): Record<string, unknown> {
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
