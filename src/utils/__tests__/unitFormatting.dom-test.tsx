import assert from 'node:assert/strict';
import test from 'node:test';
import { setupI18n } from '@lingui/core';
import { messages as enMessages } from '@/locales/en.js';
import { messages as esMessages } from '@/locales/es.js';
import { unitFormat } from '../unitFormatting';
import { formatFileSize, formatPolygonCountCompact } from '../meshStatsFormatting';

// A .dom-test only because this runner compiles the Lingui macro; nothing here
// touches the DOM. The compiled catalogs are the real ones, so a missing or
// broken Spanish entry fails here.
function formatFor(locale: 'en' | 'es') {
  const i18n = setupI18n({ locale, messages: { en: enMessages, es: esMessages } });
  return unitFormat(locale, i18n._.bind(i18n));
}

const en = formatFor('en');
const es = formatFor('es');

test('unit places the value in the unit message per locale', () => {
  assert.equal(en.unit('mm', '1.5'), '1.5 mm');
  assert.equal(es.unit('mm', '1,5'), '1,5 mm');
  assert.equal(en.unit('percent', '28'), '28%');
  assert.equal(es.unit('percent', '28'), '28 %');
});

test('quantity formats the number for the locale before placing it', () => {
  assert.equal(en.quantity(12.345, 2, 'mm2'), '12.35 mm²');
  assert.equal(es.quantity(12.345, 2, 'mm2'), '12,35 mm²');
  assert.equal(es.quantity(0.05, 0, 'um'), '0 μm');
});

test('formatFileSize keeps English as it was and localizes Spanish', () => {
  const size = 28.03 * 1024 * 1024;
  assert.equal(formatFileSize(size, en), '28.03 MB');
  assert.equal(formatFileSize(size, es), '28,03 MB');
  assert.equal(formatFileSize(1536, es), '1,5 KB');
  assert.equal(formatFileSize(512, es), '512 B');
  assert.equal(formatFileSize(0, es), null);
});

test('formatPolygonCountCompact uses the translated compact suffixes', () => {
  assert.equal(formatPolygonCountCompact(1_376_686, en), '1.38M');
  assert.equal(formatPolygonCountCompact(50_000, en), '50K');
  assert.equal(formatPolygonCountCompact(1_376_686, es), '1,38 M');
  assert.equal(formatPolygonCountCompact(5_500, es), '5,5 mil');
  assert.equal(formatPolygonCountCompact(999, es), '999');
});
