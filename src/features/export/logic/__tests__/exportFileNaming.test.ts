import assert from 'node:assert/strict';
import test from 'node:test';

import { normalizeExportBaseName } from '../exportFileNaming';

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
