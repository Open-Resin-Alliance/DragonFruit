import assert from 'node:assert/strict';
import test from 'node:test';

import {
  addPrinterProfileFromPreset,
  getProfileStoreSnapshot,
  markPrinterProfilesMissingPlugin,
  removePrinterProfile,
  setActivePrinterProfile,
  updatePrinterProfile,
} from '../profileStore';
import { installExternalProfilePlugin, uninstallExternalProfilePlugin } from '@/features/plugins/pluginRegistry';

/**
 * A missing-plugin printer is unusable; it must not stay selected after a reload or
 * a removal, or the app opens on a machine it cannot slice for.
 */
const PLUGIN_ID = 'test.selection-plugin';
const PRESET_ID = 'test.selection-printer';
const OTHER_PLUGIN_ID = 'test.selection-plugin-other';
const OTHER_PRESET_ID = 'test.selection-printer-other';

const snapshot = () => getProfileStoreSnapshot();

test('a missing printer is replaced by the next usable one', () => {
  installExternalProfilePlugin({
    schemaVersion: 1,
    id: PLUGIN_ID,
    name: 'Selection Plugin',
    version: '1.0.0',
    printerPresets: [{
      presetId: PRESET_ID,
      profileVersion: 1,
      manufacturer: 'Test',
      name: 'Selection Printer',
      buildVolumeMm: { width: 100, depth: 60, height: 120 },
      display: { resolutionX: 2048, resolutionY: 1152, outputFormat: '.png' },
    }],
  });

  installExternalProfilePlugin({
    schemaVersion: 1,
    id: OTHER_PLUGIN_ID,
    name: 'Other Plugin',
    version: '1.0.0',
    printerPresets: [{
      presetId: OTHER_PRESET_ID,
      profileVersion: 1,
      manufacturer: 'Test',
      name: 'Other Printer',
      buildVolumeMm: { width: 120, depth: 70, height: 140 },
      display: { resolutionX: 2048, resolutionY: 1152, outputFormat: '.png' },
    }],
  });

  const pluginProfileId = addPrinterProfileFromPreset(PRESET_ID);
  const otherProfileId = addPrinterProfileFromPreset(OTHER_PRESET_ID);
  try {
    setActivePrinterProfile(pluginProfileId);
    assert.equal(snapshot().activePrinterProfileId, pluginProfileId);

    markPrinterProfilesMissingPlugin(PLUGIN_ID, 'Selection Plugin', [PRESET_ID]);

    assert.equal(snapshot().activePrinterProfileId, otherProfileId, 'the active printer moved to the usable one');
  } finally {
    updatePrinterProfile(pluginProfileId, { missingPlugin: undefined });
    removePrinterProfile(pluginProfileId);
    removePrinterProfile(otherProfileId);
    uninstallExternalProfilePlugin(PLUGIN_ID);
    uninstallExternalProfilePlugin(OTHER_PLUGIN_ID);
  }
});
