import assert from 'node:assert/strict';
import test from 'node:test';

import {
  addPrinterProfile,
  getMaterialProfilesForPrinter,
  importSceneMaterials,
  removePrinterProfile,
} from '../profileStore';

const sourceMaterial = {
  id: 'scene-material-blue',
  name: 'V3 Blue',
  brand: 'ELEGOO',
  resinFamily: 'standard',
  officialTemplateId: 'test-scene-material-blue',
  layerHeightMm: 0.05,
  bottomLayerCount: 4,
};

const sceneBlueCount = (printerId: string) => getMaterialProfilesForPrinter(printerId)
  .filter((material) => material.brand === 'ELEGOO' && material.name === 'V3 Blue')
  .length;

const printer = (name: string) => addPrinterProfile({
  name,
  manufacturer: 'Test',
  buildVolumeMm: { width: 100, depth: 100, height: 100 },
  display: { resolutionX: 640, resolutionY: 480, outputFormat: '.zip' },
});

test('a scene material with another local id maps onto the installed profile', () => {
  const printerId = printer('Scene material dedupe');
  try {
    importSceneMaterials(printerId, [sourceMaterial]);
    const remap = importSceneMaterials(printerId, [{ ...sourceMaterial, id: 'scene-material-blue-2' }]);

    assert.equal(sceneBlueCount(printerId), 1, 'no duplicate profile');
    assert.equal(remap.get('scene-material-blue-2'), 'scene-material-blue');
  } finally {
    removePrinterProfile(printerId);
  }
});

test('an id owned by another printer becomes a new id for this printer', () => {
  const firstPrinter = printer('Scene material owner');
  const secondPrinter = printer('Scene material receiver');
  try {
    importSceneMaterials(firstPrinter, [sourceMaterial]);
    const remap = importSceneMaterials(secondPrinter, [sourceMaterial]);

    assert.notEqual(remap.get(sourceMaterial.id), sourceMaterial.id, 'the id is not moved between printers');
    assert.equal(sceneBlueCount(firstPrinter), 1);
    assert.equal(sceneBlueCount(secondPrinter), 1);
  } finally {
    removePrinterProfile(firstPrinter);
    removePrinterProfile(secondPrinter);
  }
});
