import assert from 'node:assert/strict';
import test from 'node:test';

import {
  addMaterialProfile,
  addPrinterProfile,
  getMaterialProfilesForPrinter,
  removePrinterProfile,
  updateMaterialProfile,
} from '../profileStore';

const printer = (name: string) => addPrinterProfile({
  name,
  manufacturer: 'Test',
  buildVolumeMm: { width: 100, depth: 100, height: 100 },
  display: { resolutionX: 640, resolutionY: 480, outputFormat: '.zip' },
});

test('a material profile is visible on the printers it is shared with', () => {
  const owner = printer('Owner printer');
  const shared = printer('Shared printer');
  try {
    const materialId = addMaterialProfile(owner, { name: 'V3 Blue', brand: 'ELEGOO' });
    updateMaterialProfile(materialId, { compatiblePrinterProfileIds: [shared] });

    assert.ok(getMaterialProfilesForPrinter(owner).some((material) => material.id === materialId));
    assert.ok(getMaterialProfilesForPrinter(shared).some((material) => material.id === materialId));
  } finally {
    removePrinterProfile(owner);
    removePrinterProfile(shared);
  }
});

test('removing a printer drops it from compatibility lists', () => {
  const owner = printer('Owner cleanup');
  const shared = printer('Shared cleanup');
  try {
    const materialId = addMaterialProfile(owner, { name: 'V3 Red', brand: 'ELEGOO' });
    updateMaterialProfile(materialId, { compatiblePrinterProfileIds: [shared] });
    removePrinterProfile(shared);

    assert.equal(getMaterialProfilesForPrinter(owner).find((material) => material.id === materialId)?.compatiblePrinterProfileIds, undefined);
  } finally {
    removePrinterProfile(owner);
  }
});
