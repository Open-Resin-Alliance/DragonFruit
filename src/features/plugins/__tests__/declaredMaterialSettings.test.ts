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
    tabs: [{ id: 'basic', title: 'Basic' }],
    cards: [{ id: 'print', title: 'Print', tabId: 'basic' }],
  });

  assert.ok(adapter);
  assert.equal(adapter.outputFormat, '.exf');
  assert.equal(adapter.displayName, 'Echo settings');
  assert.deepEqual(adapter.fields.map((field) => field.key), ['exposureSec', 'antialias']);
  assert.equal(adapter.fields[0].kind, 'number');
  assert.equal(adapter.fields[0].max, 30);
  assert.deepEqual(adapter.fields[1].options, [{ value: '2', label: '2x' }]);
  assert.deepEqual(adapter.tabs?.map((tab) => tab.id), ['basic']);
  assert.deepEqual(adapter.cards?.map((card) => card.id), ['print']);
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
