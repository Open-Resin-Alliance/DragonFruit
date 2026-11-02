import assert from 'node:assert/strict';
import test from 'node:test';

import {
  addPrinterProfileFromPreset,
  clearPrinterProfilesMissingPlugin,
  getProfileStoreSnapshot,
  markPrinterProfilesMissingPlugin,
  removePrinterProfile,
} from '../profileStore';
import { installExternalProfilePlugin, uninstallExternalProfilePlugin } from '@/features/plugins/pluginRegistry';

/**
 * A profile built from a plugin's preset outlives the plugin. When the package is
 * removed the profile stays (its scene reference is the user's), marked so the rail
 * can grey it out and say which plugin is missing; reinstalling clears it.
 */
const PLUGIN_ID = 'test.missing-plugin';
const PRESET_ID = 'test.missing-plugin-printer';

const profileWithPreset = () => getProfileStoreSnapshot().printerProfiles
  .find((profile) => profile.officialPresetId === PRESET_ID);

test('removing the plugin marks the profiles it contributed', () => {
  installExternalProfilePlugin({
    schemaVersion: 1,
    id: PLUGIN_ID,
    name: 'Missing Plugin',
    version: '1.0.0',
    printerPresets: [{
      presetId: PRESET_ID,
      profileVersion: 1,
      manufacturer: 'Test',
      name: 'Missing Printer',
      buildVolumeMm: { width: 100, depth: 60, height: 120 },
      display: { resolutionX: 2048, resolutionY: 1152, outputFormat: '.png' },
    }],
  });

  const profileId = addPrinterProfileFromPreset(PRESET_ID);
  try {
    assert.equal(profileWithPreset()?.missingPlugin, undefined, 'usable while the plugin is there');

    markPrinterProfilesMissingPlugin(PLUGIN_ID, 'Missing Plugin', [PRESET_ID]);

    assert.deepEqual(profileWithPreset()?.missingPlugin, { id: PLUGIN_ID, name: 'Missing Plugin' });

    clearPrinterProfilesMissingPlugin(PLUGIN_ID, [PRESET_ID]);
    assert.equal(profileWithPreset()?.missingPlugin, undefined, 'cleared when the presets are back');
  } finally {
    removePrinterProfile(profileId);
    uninstallExternalProfilePlugin(PLUGIN_ID);
  }
});

test('marking only touches profiles whose preset belonged to that plugin', () => {
  installExternalProfilePlugin({
    schemaVersion: 1,
    id: PLUGIN_ID,
    name: 'Missing Plugin',
    version: '1.0.0',
    printerPresets: [{
      presetId: PRESET_ID,
      profileVersion: 1,
      manufacturer: 'Test',
      name: 'Missing Printer',
      buildVolumeMm: { width: 100, depth: 60, height: 120 },
      display: { resolutionX: 2048, resolutionY: 1152, outputFormat: '.png' },
    }],
  });

  const profileId = addPrinterProfileFromPreset(PRESET_ID);
  try {
    markPrinterProfilesMissingPlugin('someone.else', 'Someone Else', ['unrelated-preset']);
    assert.equal(profileWithPreset()?.missingPlugin, undefined);

    markPrinterProfilesMissingPlugin(PLUGIN_ID, 'Missing Plugin', []);
    assert.equal(profileWithPreset()?.missingPlugin, undefined, 'no preset ids, nothing to mark');
  } finally {
    removePrinterProfile(profileId);
    uninstallExternalProfilePlugin(PLUGIN_ID);
  }
});
