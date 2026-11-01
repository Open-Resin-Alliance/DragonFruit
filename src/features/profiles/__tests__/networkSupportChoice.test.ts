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
 * A preset carries a network mode, so "None" is a choice a user makes against it.
 * An absent `networkSupport` means "inherit the preset", which is why clearing it
 * used to snap back to the preset's mode after the next state sanitize.
 */
const PLUGIN_ID = 'test.network-choice';
const PRESET_ID = 'test.network-choice-printer';

const profile = () => getProfileStoreSnapshot().printerProfiles
  .find((entry) => entry.officialPresetId === PRESET_ID);

test('choosing None sticks on a profile whose preset has a network mode', () => {
  installExternalProfilePlugin({
    schemaVersion: 1,
    id: PLUGIN_ID,
    name: 'Network Choice',
    version: '1.0.0',
    printerPresets: [{
      presetId: PRESET_ID,
      profileVersion: 1,
      manufacturer: 'Test',
      name: 'Choice Printer',
      networkSupport: 'demo-echo',
      buildVolumeMm: { width: 100, depth: 60, height: 120 },
      display: { resolutionX: 2048, resolutionY: 1152, outputFormat: '.png' },
    }],
  });

  const profileId = addPrinterProfileFromPreset(PRESET_ID);
  try {
    assert.equal(profile()?.networkSupport, 'demo-echo', 'the preset mode is inherited');

    updatePrinterProfile(profileId, { networkSupport: undefined });

    assert.equal(profile()?.networkSupport, undefined, 'None survives the state sanitize');
    assert.equal(profile()?.networkSupportDisabled, true);

    updatePrinterProfile(profileId, { networkSupport: 'nanodlp' });

    assert.equal(profile()?.networkSupport, 'nanodlp');
    assert.equal(profile()?.networkSupportDisabled, undefined, 'a real mode clears the flag');
  } finally {
    removePrinterProfile(profileId);
    uninstallExternalProfilePlugin(PLUGIN_ID);
  }
});
