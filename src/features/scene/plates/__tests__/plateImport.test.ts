import assert from 'node:assert/strict';
import test from 'node:test';

import { resolveImportedPlates } from '../plateImport';

const filePlates = [
  { id: 'plate-a', name: 'First' },
  { id: 'plate-b', name: 'Second' },
];

const ids = () => {
  let n = 0;
  return () => `fresh-${(n += 1)}`;
};

test('into an empty scene the file keeps its own plate ids', () => {
  const resolved = resolveImportedPlates(filePlates, 'plate-b', false, ids());
  assert.deepEqual(resolved.plates, [
    { id: 'plate-a', name: 'First' },
    { id: 'plate-b', name: 'Second' },
  ]);
  assert.equal(resolved.append, false);
  assert.equal(resolved.activePlateId, 'plate-b');
  assert.equal(resolved.idMap.get('plate-a'), 'plate-a');
});

test('into a scene with models the file plates are appended as new plates', () => {
  const resolved = resolveImportedPlates(filePlates, 'plate-b', true, ids());
  assert.deepEqual(resolved.plates, [
    { id: 'fresh-1', name: 'First' },
    { id: 'fresh-2', name: 'Second' },
  ]);
  assert.equal(resolved.append, true);
  assert.equal(resolved.activePlateId, 'fresh-2');
  assert.equal(resolved.idMap.get('plate-a'), 'fresh-1');
  assert.equal(resolved.idMap.get('plate-b'), 'fresh-2');
});

test('opening the same scene twice never reuses a plate id', () => {
  const generateId = ids();
  const first = resolveImportedPlates(filePlates, 'plate-a', true, generateId);
  const second = resolveImportedPlates(filePlates, 'plate-a', true, generateId);
  assert.notDeepEqual(
    second.plates.map((plate) => plate.id),
    first.plates.map((plate) => plate.id),
  );
  assert.equal(second.idMap.get('plate-a'), 'fresh-3');
  assert.equal(second.activePlateId, 'fresh-3');
});

test('an unnamed active plate falls back to the first plate', () => {
  const resolved = resolveImportedPlates(filePlates, null, true, ids());
  assert.equal(resolved.activePlateId, 'fresh-1');
});

test('a file with no plates resolves to nothing', () => {
  const resolved = resolveImportedPlates([], null, true, ids());
  assert.deepEqual(resolved.plates, []);
  assert.equal(resolved.append, false);
  assert.equal(resolved.activePlateId, undefined);
});
