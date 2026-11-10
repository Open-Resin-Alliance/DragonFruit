import assert from 'node:assert/strict';
import test from 'node:test';

import { sanitizeDeclaredMaterialSettings } from '../declaredMaterialSettings';

const contract = {
  displayName: 'Echo settings',
  fields: [
    { key: 'exposureSec', label: 'Exposure (s)', kind: 'number', defaultValue: 2.5, min: 0.1, max: 30, step: 0.1 },
    { key: 'antialias', label: 'Anti-aliasing', kind: 'select', defaultValue: '2', options: [{ value: '2', label: '2x' }] },
  ],
};

test('a declared contract keeps its fields and metadata', () => {
  const adapter = sanitizeDeclaredMaterialSettings('.exf', {
    ...contract,
    tabs: [{ id: 'basic', title: 'Basic' }, { id: 'vendor', title: 'Vendor', order: 20 }],
    sections: [{ id: 'exposure', title: 'Exposure', tabId: 'basic' }],
    cards: [{ id: 'print', title: 'Print', tabId: 'basic', sectionId: 'exposure' }],
  });

  assert.ok(adapter);
  assert.equal(adapter.outputFormat, '.exf');
  assert.equal(adapter.displayName, 'Echo settings');
  assert.deepEqual(adapter.fields.map((field) => field.key), ['exposureSec', 'antialias']);
  assert.equal(adapter.fields[0].kind, 'number');
  assert.equal(adapter.fields[0].max, 30);
  assert.deepEqual(adapter.fields[1].options, [{ value: '2', label: '2x' }]);
  assert.deepEqual(adapter.tabs?.map((tab) => tab.id), ['basic', 'vendor']);
  assert.deepEqual(adapter.sections?.map((section) => section.id), ['exposure']);
  assert.deepEqual(adapter.cards?.map((card) => card.id), ['print']);
  assert.equal(adapter.cards?.[0].sectionId, 'exposure');
});

test('a textfield keeps its free-form default verbatim', () => {
  const adapter = sanitizeDeclaredMaterialSettings('.exf', {
    fields: [{
      key: 'extraIni',
      label: 'Extra INI',
      kind: 'textfield',
      defaultValue: 'customField = customValue\nsecondField = 2',
      previewKeys: ['hLayer', 'expoTime'],
      previewLabel: 'Standard INI Fields',
    }],
  });

  assert.ok(adapter);
  assert.equal(adapter.fields[0].kind, 'textfield');
  assert.equal(adapter.fields[0].defaultValue, 'customField = customValue\nsecondField = 2');
  assert.deepEqual(adapter.fields[0].previewKeys, ['hLayer', 'expoTime']);
  assert.equal(adapter.fields[0].previewLabel, 'Standard INI Fields');
});

test('a field the renderer cannot interpret is dropped, not guessed at', () => {
  const adapter = sanitizeDeclaredMaterialSettings('.exf', {
    fields: [
      { key: 'good', label: 'Good', kind: 'number', defaultValue: 1 },
      { key: 'unknown-kind', label: 'Bad', kind: 'slider', defaultValue: 1 },
      { key: 'no-default', label: 'Bad', kind: 'number' },
      { label: 'No key', kind: 'text', defaultValue: 'x' },
    ],
  });

  assert.ok(adapter);
  assert.deepEqual(adapter.fields.map((field) => field.key), ['good']);
});

test('a contract with no usable fields is refused', () => {
  assert.equal(sanitizeDeclaredMaterialSettings('.exf', { fields: [] }), null);
  assert.equal(sanitizeDeclaredMaterialSettings('.exf', { fields: [{ key: 'x', kind: 'slider', defaultValue: 1 }] }), null);
  assert.equal(sanitizeDeclaredMaterialSettings('.exf', null), null);
});

test('per-layer metadata keeps explicit booleans without coercing opt-in', () => {
  const adapter = sanitizeDeclaredMaterialSettings('.exf', {
    fields: [true, false, undefined, 'true', 1, null].map((perLayerEditable, index) => ({
      key: `field-${index}`,
      kind: 'number',
      defaultValue: 1,
      perLayerEditable,
    })),
  });

  assert.ok(adapter);
  assert.deepEqual(adapter.fields.map((field) => field.perLayerEditable), [
    true, false, undefined, undefined, undefined, undefined,
  ]);
  assert.equal('perLayerEditable' in adapter.fields[2], false);
});

test('per-layer bindings are trimmed, bounded and omitted when unusable', () => {
  const adapter = sanitizeDeclaredMaterialSettings('.exf', {
    fields: [' exposureSec ', 'x'.repeat(100), '   ', 42, undefined].map((perLayerField, index) => ({
      key: `field-${index}`,
      kind: 'integer',
      defaultValue: 1,
      perLayerEditable: true,
      perLayerField,
    })),
  });

  assert.ok(adapter);
  assert.deepEqual(adapter.fields.map((field) => field.perLayerField), [
    'exposureSec', 'x'.repeat(64), undefined, undefined, undefined,
  ]);
  assert.equal('perLayerField' in adapter.fields[2], false);
});

test('mode resolution preserves inherited per-layer bindings and explicit opt-out', () => {
  const modes = {
    simple: {
      fields: [
        { key: 'normalExposureSec', kind: 'number', defaultValue: 2, perLayerEditable: true, perLayerField: 'exposureSec' },
        { key: 'liftDistanceMm', kind: 'number', defaultValue: 6, perLayerEditable: true, perLayerField: 'liftHeightMm' },
        { key: 'liftSpeedMmMin', kind: 'number', defaultValue: 60, perLayerEditable: true },
      ],
    },
    tilting: {
      $inherit: 'simple',
      $remove: { fields: ['liftDistanceMm'] },
      fields: [{ key: 'liftSpeedMmMin', perLayerEditable: false }],
    },
  };

  const adapter = sanitizeDeclaredMaterialSettings('.exf', modes.tilting, modes);
  assert.ok(adapter);
  assert.deepEqual(adapter.fields.map((field) => [field.key, field.perLayerEditable, field.perLayerField]), [
    ['normalExposureSec', true, 'exposureSec'],
    ['liftSpeedMmMin', false, undefined],
  ]);
  assert.equal(modes.simple.fields[2].perLayerEditable, true);
});

test('a differential contract inherits, removes and adds', () => {
  const modes = {
    simple: {
      fields: [
        { key: 'exposureSec', label: 'Exposure', kind: 'number', defaultValue: 2 },
        { key: 'liftMm', label: 'Lift', kind: 'number', defaultValue: 6 },
      ],
    },
    twostage: {
      $inherit: 'simple',
      $remove: { fields: ['liftMm'] },
      fields: [{ key: 'liftDistance2Mm', label: 'Lift 2', kind: 'number', defaultValue: 4 }],
    },
  };

  const adapter = sanitizeDeclaredMaterialSettings('.exf', modes.twostage, modes);
  assert.ok(adapter);
  assert.deepEqual(adapter.fields.map((field) => field.key), ['exposureSec', 'liftDistance2Mm']);
});

test('an unresolvable differential is refused instead of half-rendering', () => {
  const modes = { twostage: { $inherit: 'missing', fields: [] } };
  assert.equal(sanitizeDeclaredMaterialSettings('.exf', modes.twostage, modes), null);
});
