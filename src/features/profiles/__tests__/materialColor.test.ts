import assert from 'node:assert/strict';
import test from 'node:test';

import {
  addMaterialProfile,
  addPrinterProfileFromPreset,
  getProfileStoreSnapshot,
  removeMaterialProfile,
  removePrinterProfile,
  updateMaterialProfile,
} from '../profileStore';
import { installExternalProfilePlugin, uninstallExternalProfilePlugin } from '@/features/plugins/pluginRegistry';

/**
 * Colour is part of the material meta, so it travels with a profile (and through a
 * plugin's template) like name and brand do.
 */
const PLUGIN_ID = 'test.material-color';

const materialById = (id: string) => getProfileStoreSnapshot().materialProfiles.find((material) => material.id === id);

test('a material keeps a hex colour and drops anything else', () => {
  installExternalProfilePlugin({
    schemaVersion: 1,
    id: PLUGIN_ID,
    name: 'Material Color',
    version: '1.0.0',
    printerPresets: [{
      presetId: 'test.material-color-printer',
      profileVersion: 1,
      manufacturer: 'Test',
      name: 'Color Printer',
      buildVolumeMm: { width: 100, depth: 60, height: 120 },
      display: { resolutionX: 2048, resolutionY: 1152, outputFormat: '.png' },
    }],
  });

  const profileId = addPrinterProfileFromPreset('test.material-color-printer');
  const materialId = addMaterialProfile(profileId, { name: 'Blue Resin', color: '#3B82F6' });
  try {
    assert.equal(materialById(materialId)?.color, '#3b82f6', 'normalised to lowercase');

    updateMaterialProfile(materialId, { color: 'blue' });
    assert.equal(materialById(materialId)?.color, undefined, 'a non-hex value clears the colour');

    updateMaterialProfile(materialId, { color: '#22C55E' });
    assert.equal(materialById(materialId)?.color, '#22c55e');

    // None sends `color: undefined`, which has to clear rather than be ignored.
    updateMaterialProfile(materialId, { color: undefined });
    assert.equal(materialById(materialId)?.color, undefined, 'None removes the colour');
  } finally {
    removeMaterialProfile(materialId);
    removePrinterProfile(profileId);
    uninstallExternalProfilePlugin(PLUGIN_ID);
  }
});
