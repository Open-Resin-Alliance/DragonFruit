import assert from 'node:assert/strict';
import test from 'node:test';

import type { MaterialProfile } from '../profileStore';
import { matchSceneMaterialsToTanks, resolveTankMaterialProfiles } from '../tankMaterials';

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

test('scene materials fall into the tanks they occupied on the previous printer', () => {
  const { tankMaterials, assignments } = matchSceneMaterialsToTanks(
    ['red', 'blue'],
    ['red', 'blue', ''],
    ['', ''],
  );
  assert.deepEqual(tankMaterials, ['red', 'blue']);
  assert.deepEqual(assignments, [
    { materialId: 'red', tankIndex: 0 },
    { materialId: 'blue', tankIndex: 1 },
  ]);
});

test('a target tank already holding a scene material is left alone', () => {
  const { tankMaterials, assignments } = matchSceneMaterialsToTanks(
    ['red', 'blue'],
    ['red', 'blue'],
    ['red', ''],
  );
  assert.deepEqual(tankMaterials, ['red', 'blue']);
  assert.deepEqual(assignments, [{ materialId: 'blue', tankIndex: 1 }]);
});

test('an occupied preferred tank falls back to the first free tank', () => {
  const { tankMaterials } = matchSceneMaterialsToTanks(
    ['red'],
    ['red', ''],
    ['yellow', ''],
  );
  assert.deepEqual(tankMaterials, ['yellow', 'red']);
});

test('no assignment is made when every target tank is occupied', () => {
  const { tankMaterials, assignments } = matchSceneMaterialsToTanks(
    ['red'],
    ['red'],
    ['yellow'],
  );
  assert.deepEqual(tankMaterials, ['yellow']);
  assert.deepEqual(assignments, []);
});
