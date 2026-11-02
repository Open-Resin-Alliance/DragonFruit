import assert from 'node:assert/strict';
import test from 'node:test';

import { resolveCompositeMaterialLabel, resolveMaterialFamilyNameLabel } from '../materialLabel';

const material = { brand: 'ELEGOO', resinFamily: 'standard', name: 'V3 Blue' };

test('the menu label carries the family and name without the brand', () => {
  assert.equal(resolveMaterialFamilyNameLabel(material), 'Standard V3 Blue');
});

test('a name that already opens with its family is not repeated', () => {
  assert.equal(resolveMaterialFamilyNameLabel({ ...material, name: 'Standard Blue' }), 'Standard Blue');
});

test('the composite label still carries the brand', () => {
  assert.equal(resolveCompositeMaterialLabel(material), 'ELEGOO Standard V3 Blue');
});
