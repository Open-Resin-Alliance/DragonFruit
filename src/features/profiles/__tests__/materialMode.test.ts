import assert from 'node:assert/strict';
import test from 'node:test';

import {
  addPrinterProfileFromPreset,
  getProfileStoreSnapshot,
  removePrinterProfile,
  updatePrinterProfile,
} from '../profileStore';
import { installExternalProfilePlugin, uninstallExternalProfilePlugin } from '@/features/plugins/pluginRegistry';

/**
 * `materialMode` says how a machine handles materials. Existing printers have no
 * value and mean single material; `multiTank` marks a machine that carries more than
 * one tank. The switching semantics are not defined yet, so this only covers the
 * field surviving storage and preset creation.
 */
const PLUGIN_ID = 'test.material-mode';
const SINGLE_PRESET_ID = 'test.material-mode-single';
const TANK_PRESET_ID = 'test.material-mode-tank';

const profileByPreset = (presetId: string) => getProfileStoreSnapshot().printerProfiles
  .find((profile) => profile.officialPresetId === presetId);

test('a printer without the field reads as single material', () => {
  installExternalProfilePlugin({
    schemaVersion: 1,
    id: PLUGIN_ID,
    name: 'Material Mode',
    version: '1.0.0',
    printerPresets: [
      {
        presetId: SINGLE_PRESET_ID,
        profileVersion: 1,
        manufacturer: 'Test',
        name: 'Single Printer',
        buildVolumeMm: { width: 100, depth: 60, height: 120 },
        display: { resolutionX: 2048, resolutionY: 1152, outputFormat: '.png' },
      },
      {
        presetId: TANK_PRESET_ID,
        profileVersion: 1,
        manufacturer: 'Test',
        name: 'Tank Printer',
        materialMode: 'multiTank',
        buildVolumeMm: { width: 100, depth: 60, height: 120 },
        display: { resolutionX: 2048, resolutionY: 1152, outputFormat: '.png' },
      },
    ],
  });

  const singleId = addPrinterProfileFromPreset(SINGLE_PRESET_ID);
  const tankId = addPrinterProfileFromPreset(TANK_PRESET_ID);
  try {
    assert.equal(profileByPreset(SINGLE_PRESET_ID)?.materialMode, undefined, 'absent means single');
    assert.equal(profileByPreset(TANK_PRESET_ID)?.materialMode, 'multiTank', 'the preset brings the mode');

    updatePrinterProfile(singleId, { materialMode: 'multiTank' });
    assert.equal(profileByPreset(SINGLE_PRESET_ID)?.materialMode, 'multiTank');

    updatePrinterProfile(singleId, { materialMode: 'single' });
    assert.equal(profileByPreset(SINGLE_PRESET_ID)?.materialMode, 'single');

    updatePrinterProfile(singleId, { materialMode: 'somethingElse' as never });
    assert.equal(profileByPreset(SINGLE_PRESET_ID)?.materialMode, undefined, 'an unknown mode is dropped');
  } finally {
    removePrinterProfile(singleId);
    removePrinterProfile(tankId);
    uninstallExternalProfilePlugin(PLUGIN_ID);
  }
});

test('User Notes are trimmed, capped and survive on an official profile', () => {
  installExternalProfilePlugin({
    schemaVersion: 1,
    id: PLUGIN_ID,
    name: 'Material Mode',
    version: '1.0.0',
    printerPresets: [{
      presetId: SINGLE_PRESET_ID,
      profileVersion: 1,
      manufacturer: 'Test',
      name: 'Single Printer',
      buildVolumeMm: { width: 100, depth: 60, height: 120 },
      display: { resolutionX: 2048, resolutionY: 1152, outputFormat: '.png' },
    }],
  });

  const profileId = addPrinterProfileFromPreset(SINGLE_PRESET_ID);
  try {
    assert.equal(profileByPreset(SINGLE_PRESET_ID)?.isOfficial, true, 'preset profiles are official');

    updatePrinterProfile(profileId, { notes: '  Service: 2026-03, vat gasket  ' });
    assert.equal(profileByPreset(SINGLE_PRESET_ID)?.notes, 'Service: 2026-03, vat gasket');

    updatePrinterProfile(profileId, { notes: '   ' });
    assert.equal(profileByPreset(SINGLE_PRESET_ID)?.notes, undefined, 'blank notes are no notes');

    updatePrinterProfile(profileId, { notes: 'x'.repeat(2500) });
    assert.equal(profileByPreset(SINGLE_PRESET_ID)?.notes?.length, 2000, 'notes are capped');
  } finally {
    removePrinterProfile(profileId);
    uninstallExternalProfilePlugin(PLUGIN_ID);
  }
});
