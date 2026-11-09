import assert from 'node:assert/strict';
import test from 'node:test';

import {
  addPrinterProfileFromPresetIfAvailable,
  getProfileStoreSnapshot,
  importPrinterBundle,
  removePrinterProfile,
} from '../profileStore';
import { installExternalProfilePlugin, uninstallExternalProfilePlugin } from '@/features/plugins/pluginRegistry';

const PLUGIN_ID = 'test.official-bundle';
const PRESET_ID = 'test.official-bundle-p01';
const IMAGE = 'data:image/png;base64,AAAA';

test('a scene bundle for an installed official preset recreates the official card', () => {
  installExternalProfilePlugin({
    schemaVersion: 1,
    id: PLUGIN_ID,
    name: 'Official Bundle',
    version: '1.0.0',
    printerPresets: [{
      presetId: PRESET_ID,
      profileVersion: 1,
      manufacturer: 'Test',
      name: 'P0 Printer',
      imageAssetPath: IMAGE,
      buildVolumeMm: { width: 10, depth: 10, height: 10 },
      display: { resolutionX: 640, resolutionY: 480, outputFormat: '.zip' },
    }],
  });

  const id = addPrinterProfileFromPresetIfAvailable(PRESET_ID);
  try {
    assert.ok(id);
    const profile = getProfileStoreSnapshot().printerProfiles.find((entry) => entry.id === id);
    assert.equal(profile?.officialPresetId, PRESET_ID);
    assert.equal(profile?.isOfficial, true);
    assert.equal(profile?.imageDataUrl, IMAGE, 'the official preset image comes with it');
  } finally {
    if (id) removePrinterProfile(id);
    uninstallExternalProfilePlugin(PLUGIN_ID);
  }
});

test('a custom bundle import keeps the material colours it carries', () => {
  const id = importPrinterBundle({
    version: 1,
    printer: {
      name: 'Bundle Printer',
      manufacturer: 'Test',
      materialMode: 'multiTank',
      tankCount: 2,
      tankMaterials: ['bundle-blue', 'bundle-yellow'],
      buildVolumeMm: { width: 10, depth: 10, height: 10 },
      display: { resolutionX: 640, resolutionY: 480, outputFormat: '.zip' },
    },
    materials: [
      { id: 'bundle-blue', name: 'V3 Blue', brand: 'ELEGOO', color: '#1e90ff' },
      { id: 'bundle-yellow', name: 'V3 Yellow', brand: 'ELEGOO', color: '#ffd700' },
    ],
  });
  try {
    const material = getProfileStoreSnapshot().materialProfiles.find((entry) => (
      entry.printerProfileId === id && entry.name === 'V3 Blue'
    ));
    assert.equal(material?.color, '#1e90ff');
    const profile = getProfileStoreSnapshot().printerProfiles.find((entry) => entry.id === id);
    assert.equal(profile?.materialMode, 'multiTank');
    assert.equal(profile?.tankCount, 2);
    assert.equal(profile?.tankMaterials?.length, 2);
    const importedIds = new Set(getProfileStoreSnapshot().materialProfiles
      .filter((entry) => entry.printerProfileId === id)
      .map((entry) => entry.id));
    assert.ok(profile?.tankMaterials?.every((materialId) => importedIds.has(materialId)), 'tanks point at imported materials');
  } finally {
    removePrinterProfile(id);
  }
});
