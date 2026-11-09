import assert from 'node:assert/strict';
import test from 'node:test';

import { normalizeExportBaseName, resolvePlateOutputBaseName } from '../exportFileNaming';
import type { LoadedModel } from '@/features/scene/useSceneCollectionManager';

/** Only the fields the naming reads: a model's display name, and whether it is visible. */
const model = (name: string, visible = true): LoadedModel => ({ name, visible } as LoadedModel);

const outputName = resolvePlateOutputBaseName;

test('a typed name becomes a file name', () => {
  // A plate's own name, and the number it falls back to, both reach the file name.
  assert.equal(normalizeExportBaseName('Plate 1'), 'Plate_1');
  assert.equal(normalizeExportBaseName('Front Left'), 'Front_Left');
});

test('runs of whitespace collapse to one underscore', () => {
  assert.equal(normalizeExportBaseName('  spaced   out  '), 'spaced_out');
  assert.equal(normalizeExportBaseName('tab\tseparated'), 'tab_separated');
});

test('a trailing separator or source extension is dropped', () => {
  assert.equal(normalizeExportBaseName('box60.stl'), 'box60');
  assert.equal(normalizeExportBaseName('model name.'), 'model_name');
  assert.equal(normalizeExportBaseName('trailing '), 'trailing');
});

test('an empty name still yields a usable file name', () => {
  assert.equal(normalizeExportBaseName(''), 'MyPrint');
  assert.equal(normalizeExportBaseName(null), 'MyPrint');
  assert.equal(normalizeExportBaseName('   '), 'MyPrint');
  assert.equal(normalizeExportBaseName('.'), 'MyPrint');
});

test("a plate's output takes the plate's name when it has one", () => {
  assert.equal(outputName({
    plateName: 'Left bed',
    plateNumberLabel: 'Plate 1',
    plateModels: [model('poussin.stl')],
  }), 'Left_bed');
  // The plate's name wins even when its models disagree, and however many beds there are.
  assert.equal(outputName({
    plateName: 'Left bed',
    plateNumberLabel: 'Plate 2',
    plateModels: [model('other.stl')],
  }), 'Left_bed');
});

test('a lone unnamed bed is named for the model on it', () => {
  assert.equal(outputName({
    plateName: '',
    plateNumberLabel: 'Plate 1',
    plateModels: [model('poussin.stl'), model('second.stl')],
  }), 'poussin');
  // Whitespace is not a name either.
  assert.equal(outputName({
    plateName: '   ',
    plateNumberLabel: 'Plate 1',
    plateModels: [model('poussin.stl')],
  }), 'poussin');
  // A hidden model is not what the file is named for.
  assert.equal(outputName({
    plateName: '',
    plateNumberLabel: 'Plate 1',
    plateModels: [model('hidden.stl', false), model('shown.stl')],
  }), 'shown');
});

test('every unnamed bed goes by its own first model, however many there are', () => {
  // Two beds of a batch: each is named for what stands on it, so the files say what they hold.
  assert.equal(outputName({
    plateName: '',
    plateNumberLabel: 'Plate 1',
    plateModels: [model('poussin.stl')],
  }), 'poussin');
  assert.equal(outputName({
    plateName: '',
    plateNumberLabel: 'Plate 2',
    plateModels: [model('cube.stl'), model('other.stl')],
  }), 'cube');
});

test('a bed with nothing on it falls back to its number', () => {
  assert.equal(outputName({
    plateName: '',
    plateNumberLabel: 'Plate 2',
    plateModels: [],
  }), 'Plate_2');
});
