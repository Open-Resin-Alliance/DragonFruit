import assert from 'node:assert/strict';
import test from 'node:test';

import {
  addMaterialProfile,
  addPrinterProfile,
  copyMaterialProfilesToPrinter,
  getMaterialProfilesForPrinter,
  removePrinterProfile,
} from '../profileStore';

const printer = (name: string) => addPrinterProfile({
  name,
  manufacturer: 'Test',
  buildVolumeMm: { width: 100, depth: 100, height: 100 },
  display: { resolutionX: 640, resolutionY: 480, outputFormat: '.zip' },
});

test('material profiles copy to another printer as independent local profiles', () => {
  const source = printer('Copy source');
  const target = printer('Copy target');
  try {
    const sourceMaterialId = addMaterialProfile(source, {
      name: 'V3 Blue',
      brand: 'ELEGOO',
      color: '#1e90ff',
      layerHeightMm: 0.05,
      bottomLayerCount: 4,
      localSettingsByOutput: { '.zip': { traLayers: 2 } },
    });
    const copied = copyMaterialProfilesToPrinter(source, target);

    assert.ok(copied > 0);
    const targetMaterials = getMaterialProfilesForPrinter(target);
    const copy = targetMaterials.find((material) => material.name === 'V3 Blue');
    assert.ok(copy);
    assert.notEqual(copy.id, sourceMaterialId, 'the copy gets its own id');
    assert.equal(copy.printerProfileId, target);
    assert.equal(copy.color, '#1e90ff');
    assert.equal(copy.localSettingsByOutput?.['.zip']?.traLayers, 2);
    assert.equal(copy.locked, false);
    assert.equal(copy.officialTemplateId, undefined);
    assert.ok(getMaterialProfilesForPrinter(source).some((material) => material.id === sourceMaterialId), 'the source stays');
  } finally {
    removePrinterProfile(source);
    removePrinterProfile(target);
  }
});
