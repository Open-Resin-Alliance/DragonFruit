import assert from 'node:assert/strict';
import test from 'node:test';

import {
  addPrinterProfileFromPreset,
  getProfileStoreSnapshot,
  removePrinterProfile,
} from '../profileStore';
import { installExternalProfilePlugin, uninstallExternalProfilePlugin } from '@/features/plugins/pluginRegistry';

/**
 * `allowMultiPlate` defaults to true. A preset that says false is inherited by the
 * profile it creates, and the scene reads that value to hide the plate name and the
 * plate's side buttons.
 */
const PLUGIN_ID = 'test.allow-multi-plate';
const DEFAULT_PRESET_ID = 'test.allow-multi-plate-default';
const SINGLE_PRESET_ID = 'test.allow-multi-plate-single';

const profileByPreset = (presetId: string) => getProfileStoreSnapshot().printerProfiles
  .find((profile) => profile.officialPresetId === presetId);

test('allowMultiPlate defaults true and a preset can turn it off', () => {
  installExternalProfilePlugin({
    schemaVersion: 1,
    id: PLUGIN_ID,
    name: 'Allow Multi Plate',
    version: '1.0.0',
    printerPresets: [
      {
        presetId: DEFAULT_PRESET_ID,
        profileVersion: 1,
        manufacturer: 'Test',
        name: 'Default Plates',
        buildVolumeMm: { width: 100, depth: 60, height: 120 },
        display: { resolutionX: 2048, resolutionY: 1152, outputFormat: '.png' },
      },
      {
        presetId: SINGLE_PRESET_ID,
        profileVersion: 1,
        manufacturer: 'Test',
        name: 'One Plate',
        allowMultiPlate: false,
        buildVolumeMm: { width: 100, depth: 60, height: 120 },
        display: { resolutionX: 2048, resolutionY: 1152, outputFormat: '.png' },
      },
    ],
  });

  const defaultId = addPrinterProfileFromPreset(DEFAULT_PRESET_ID);
  const singleId = addPrinterProfileFromPreset(SINGLE_PRESET_ID);
  try {
    assert.equal(profileByPreset(DEFAULT_PRESET_ID)?.allowMultiPlate, true, 'absent means true');
    assert.equal(profileByPreset(SINGLE_PRESET_ID)?.allowMultiPlate, false, 'the preset turns it off');
    assert.equal(getProfileStoreSnapshot().printerProfiles.find((profile) => profile.id === defaultId)?.allowMultiPlate, true);
    assert.equal(getProfileStoreSnapshot().printerProfiles.find((profile) => profile.id === singleId)?.allowMultiPlate, false);
  } finally {
    if (defaultId) removePrinterProfile(defaultId);
    if (singleId) removePrinterProfile(singleId);
    uninstallExternalProfilePlugin(PLUGIN_ID);
  }
});
