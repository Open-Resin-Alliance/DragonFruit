import assert from 'node:assert/strict';
import test from 'node:test';

import {
  buildDeclaredRemoteMaterialsAdapter,
  sanitizeDeclaredRemoteMaterials,
} from '../declaredRemoteMaterials';

const schema = {
  primaryFields: [
    { key: 'exposureSec', label: 'Exposure (s)', defaultValue: 2.5, kind: 'number', description: 'Per-layer exposure.' },
    { key: 'liftMm', label: 'Lift (mm)', defaultValue: 6, kind: 'number', aliases: ['liftDistanceMm'] },
    { key: 'resinType', label: 'Resin', defaultValue: 'standard', kind: 'select', options: [{ value: 'standard', label: 'Standard' }] },
  ],
  basicSections: [{ id: 'print', title: 'Print', keys: ['exposureSec', 'liftMm'] }],
  advancedSections: [{ id: 'advanced', title: 'Advanced', keywords: ['lift'] }],
};

test('a declared schema keeps its fields and sections', () => {
  const declared = sanitizeDeclaredRemoteMaterials(schema);
  assert.ok(declared);
  assert.deepEqual(declared.primaryFields.map((field) => field.key), ['exposureSec', 'liftMm', 'resinType']);
  assert.deepEqual(declared.basicSections, [{ id: 'print', title: 'Print', keys: ['exposureSec', 'liftMm'] }]);
  assert.deepEqual(declared.advancedSections, [{ id: 'advanced', title: 'Advanced', keywords: ['lift'] }]);
});

test('fields the dialog cannot render are dropped, and duplicates collapse', () => {
  const declared = sanitizeDeclaredRemoteMaterials({
    primaryFields: [
      { key: 'exposureSec', label: 'Exposure', defaultValue: 2 },
      { key: 'exposureSec', label: 'Duplicate', defaultValue: 3 },
      { label: 'No key', defaultValue: 1 },
      { key: 'blank', label: 'Blank', defaultValue: 0 },
    ],
  });
  assert.ok(declared);
  assert.deepEqual(declared.primaryFields.map((field) => field.key), ['exposureSec', 'blank']);
  assert.equal(declared.primaryFields[0].label, 'Exposure');
});

test('a schema with no usable field is refused', () => {
  assert.equal(sanitizeDeclaredRemoteMaterials({ primaryFields: [] }), null);
  assert.equal(sanitizeDeclaredRemoteMaterials({}), null);
  assert.equal(sanitizeDeclaredRemoteMaterials(null), null);
});

test('the draft comes from meta by key or alias, defaulting when absent', () => {
  const declared = sanitizeDeclaredRemoteMaterials(schema);
  assert.ok(declared);
  const adapter = buildDeclaredRemoteMaterialsAdapter(declared);

  assert.deepEqual(
    adapter.resolveEditDraftFromMeta({ exposureSec: 3, liftDistanceMm: 8 }),
    { exposureSec: '3', liftMm: '8', resinType: 'standard' },
  );
  assert.deepEqual(
    adapter.resolveEditDraftFromMeta({}),
    { exposureSec: '2.5', liftMm: '6', resinType: 'standard' },
  );
});

test('process values read the documented meta keys', () => {
  const declared = sanitizeDeclaredRemoteMaterials(schema);
  assert.ok(declared);
  const adapter = buildDeclaredRemoteMaterialsAdapter(declared);

  assert.deepEqual(
    adapter.resolveMaterialProcessValues({
      layerHeightMm: '0.05',
      normalExposureSec: 2.5,
      bottomExposureSec: 28,
      bottomLayerCount: '5',
      ignored: 1,
    }),
    { layerHeightMm: 0.05, normalExposureSec: 2.5, bottomExposureSec: 28, bottomLayerCount: 5 },
  );
});

test('the backend receives the draft keys unchanged, and sections resolve by keyword', () => {
  const declared = sanitizeDeclaredRemoteMaterials(schema);
  assert.ok(declared);
  const adapter = buildDeclaredRemoteMaterialsAdapter(declared);

  assert.deepEqual(adapter.denormalizeEditDraftForBackend({ exposureSec: '3' }), { exposureSec: '3' });
  assert.equal(adapter.resolveAdvancedSectionId('liftMm'), 'advanced');
  assert.equal(adapter.resolveAdvancedSectionId('exposureSec'), '');
  assert.equal(adapter.getFieldHelpText('exposureSec'), 'Per-layer exposure.');
  assert.equal(adapter.getFieldHelpText('liftMm'), '');
  assert.equal(adapter.isDynamicWaitEnabled({}), false);
});
