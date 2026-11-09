import assert from 'node:assert/strict';
import test from 'node:test';
import { formatFixed, formatNumber, parseDecimal } from '../localeNumber';

test('formatFixed uses the locale decimal separator', () => {
  assert.equal(formatFixed(28.034, 2, 'en'), '28.03');
  assert.equal(formatFixed(28.034, 2, 'es'), '28,03');
  assert.equal(formatFixed(0.5, 0, 'en'), '1');
  assert.equal(formatFixed(3, 1, 'es'), '3,0');
});

test('formatFixed groups thousands per locale', () => {
  assert.equal(formatFixed(560464, 0, 'en'), '560,464');
  assert.equal(formatFixed(560464, 0, 'es'), '560.464');
  // Spanish CLDR only groups from five digits up.
  assert.equal(formatFixed(1234.5, 1, 'es'), '1234,5');
  assert.equal(formatFixed(1234.5, 1, 'en'), '1,234.5');
});

test('formatNumber passes Intl options through and caches per locale', () => {
  assert.equal(formatNumber(0.25, 'en', { style: 'percent' }), '25%');
  assert.equal(formatNumber(0.25, 'es', { style: 'percent' }), '25 %');
  assert.equal(formatNumber(1.5, 'en', { maximumFractionDigits: 2 }), '1.5');
  assert.equal(formatNumber(1.5, 'es', { maximumFractionDigits: 2 }), '1,5');
});

test('parseDecimal reads the locale separator and a dot', () => {
  assert.equal(parseDecimal('10,6', 'es'), 10.6);
  assert.equal(parseDecimal('10.6', 'es'), 10.6);
  assert.equal(parseDecimal(' 215 ', 'es'), 215);
  assert.equal(parseDecimal('10.6', 'en'), 10.6);
  // In English the comma groups thousands, and a field never shows one: "10,6" is no number.
  assert.ok(Number.isNaN(parseDecimal('10,6', 'en')));
  assert.equal(parseDecimal('-.5', 'es'), -0.5);
  assert.ok(Number.isNaN(parseDecimal('-', 'es')));
  assert.ok(Number.isNaN(parseDecimal('', 'es')));
  assert.ok(Number.isNaN(parseDecimal('abc', 'es')));
  assert.ok(Number.isNaN(parseDecimal('12abc', 'es')), 'the whole text, not a leading number');
});
