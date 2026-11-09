import assert from 'node:assert/strict';
import test from 'node:test';

import {
  addMaterialProfile,
  addPrinterProfileFromPreset,
  getProfileStoreSnapshot,
  removeMaterialProfile,
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

test('a tank count is carried, clamped, and belongs to the profile', () => {
  installExternalProfilePlugin({
    schemaVersion: 1,
    id: PLUGIN_ID,
    name: 'Material Mode',
    version: '1.0.0',
    printerPresets: [{
      presetId: TANK_PRESET_ID,
      profileVersion: 1,
      manufacturer: 'Test',
      name: 'Tank Printer',
      materialMode: 'multiTank',
      tankCount: 4,
      buildVolumeMm: { width: 100, depth: 60, height: 120 },
      display: { resolutionX: 2048, resolutionY: 1152, outputFormat: '.png' },
    }],
  });

  const profileId = addPrinterProfileFromPreset(TANK_PRESET_ID);
  try {
    assert.equal(profileByPreset(TANK_PRESET_ID)?.tankCount, 4, 'the preset brings the count');

    updatePrinterProfile(profileId, { tankCount: 1 });
    assert.equal(profileByPreset(TANK_PRESET_ID)?.tankCount, 2, 'a machine cannot have fewer than two');

    updatePrinterProfile(profileId, { tankCount: 99 });
    assert.equal(profileByPreset(TANK_PRESET_ID)?.tankCount, 16, 'nor more than sixteen');

    updatePrinterProfile(profileId, { tankCount: 3.6 });
    assert.equal(profileByPreset(TANK_PRESET_ID)?.tankCount, 4, 'rounded to whole tanks');
  } finally {
    removePrinterProfile(profileId);
    uninstallExternalProfilePlugin(PLUGIN_ID);
  }
});

test('a Multi-Tank profile never resolves to fewer than two tanks', () => {
  installExternalProfilePlugin({
    schemaVersion: 1,
    id: PLUGIN_ID,
    name: 'Material Mode',
    version: '1.0.0',
    printerPresets: [{
      presetId: TANK_PRESET_ID,
      profileVersion: 1,
      manufacturer: 'Test',
      name: 'Tank Printer',
      materialMode: 'multiTank',
      buildVolumeMm: { width: 100, depth: 60, height: 120 },
      display: { resolutionX: 2048, resolutionY: 1152, outputFormat: '.png' },
    }],
  });

  const profileId = addPrinterProfileFromPreset(TANK_PRESET_ID);
  try {
    assert.equal(profileByPreset(TANK_PRESET_ID)?.tankCount, 2, 'no count declared means two');

    updatePrinterProfile(profileId, { materialMode: 'multiTank' });
    assert.equal(profileByPreset(TANK_PRESET_ID)?.tankCount, 2, 'still two after switching mode');
  } finally {
    removePrinterProfile(profileId);
    uninstallExternalProfilePlugin(PLUGIN_ID);
  }
});

test('tank assignments survive, resize with the count and clear with their material', () => {
  installExternalProfilePlugin({
    schemaVersion: 1,
    id: PLUGIN_ID,
    name: 'Material Mode',
    version: '1.0.0',
    printerPresets: [{
      presetId: TANK_PRESET_ID,
      profileVersion: 1,
      manufacturer: 'Test',
      name: 'Tank Printer',
      materialMode: 'multiTank',
      tankCount: 3,
      buildVolumeMm: { width: 100, depth: 60, height: 120 },
      display: { resolutionX: 2048, resolutionY: 1152, outputFormat: '.png' },
    }],
  });

  const profileId = addPrinterProfileFromPreset(TANK_PRESET_ID);
  // The preset path creates the first material; add a second one. The profile already
  // owns a default material from createDefaultMaterials, so find it via the snapshot.
  const firstMaterialId = getProfileStoreSnapshot().materialProfiles
    .find((material) => material.printerProfileId === profileId)?.id;
  const secondMaterialId = addMaterialProfile(profileId, { name: 'Second Resin' });

  try {
    assert.ok(firstMaterialId);
    updatePrinterProfile(profileId, { tankMaterials: [firstMaterialId!, secondMaterialId, ''] });
    assert.deepEqual(profileByPreset(TANK_PRESET_ID)?.tankMaterials, [firstMaterialId, secondMaterialId, '']);

    updatePrinterProfile(profileId, { tankCount: 2 });
    assert.deepEqual(profileByPreset(TANK_PRESET_ID)?.tankMaterials, [firstMaterialId, secondMaterialId], 'trimmed to the count');

    updatePrinterProfile(profileId, { tankCount: 4 });
    assert.deepEqual(profileByPreset(TANK_PRESET_ID)?.tankMaterials, [firstMaterialId, secondMaterialId, '', ''], 'padded to the count');

    updatePrinterProfile(profileId, { tankMaterials: ['does-not-exist', secondMaterialId, '', ''] });
    assert.equal(profileByPreset(TANK_PRESET_ID)?.tankMaterials?.[0], '', 'an unknown material id is cleared');

    removeMaterialProfile(secondMaterialId);
    // With nothing assigned the array collapses to absent, which the UI reads as all
    // tanks unassigned; what matters is that the removed id is gone.
    assert.equal(
      (profileByPreset(TANK_PRESET_ID)?.tankMaterials ?? []).includes(secondMaterialId),
      false,
      'removing the material clears its tank',
    );
  } finally {
    removePrinterProfile(profileId);
    uninstallExternalProfilePlugin(PLUGIN_ID);
  }
});
