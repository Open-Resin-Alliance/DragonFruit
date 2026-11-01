import assert from 'node:assert/strict';
import test from 'node:test';

import type { MaterialProfile } from '../profileStore';
import { resolveTankMaterialProfiles } from '../tankMaterials';

const material = (id: string, name: string) => ({ id, name } as MaterialProfile);

test('tank materials come in tank order, once each, and only when real', () => {
  const materials = [
    material('blue', 'Blue Resin'),
    material('grey', 'Grey Resin'),
    material('red', 'Red Resin'),
  ];

  assert.deepEqual(
    resolveTankMaterialProfiles(
      { materialMode: 'multiTank', tankMaterials: ['red', 'blue', '', 'red', 'deleted'] },
      materials,
    ).map((entry) => entry.id),
    ['red', 'blue'],
  );

  assert.deepEqual(
    resolveTankMaterialProfiles({ materialMode: 'single', tankMaterials: ['red'] }, materials),
    [],
    'a single-material printer has no tank choice',
  );

  assert.deepEqual(
    resolveTankMaterialProfiles({ materialMode: 'multiTank', tankMaterials: [] }, materials),
    [],
  );
});
