import assert from 'node:assert/strict';
import test from 'node:test';

import {
  resolveFormatVersionFromOptions,
  resolvePrinterFormatVersionOptions,
  sanitizePrinterFormatVersionOptions,
} from '../printerFormatVersionOptions';

const registeredOptions = [
  { value: 'v3', label: 'CTB V3' },
  { value: 'v4', label: 'CTB V4' },
  { value: 'v5enc', label: 'CTB V5 encrypted', isDefault: true },
];

test('curated options retain labels and registered values', () => {
  const options = resolvePrinterFormatVersionOptions(registeredOptions, [
    { value: 'V4', label: 'V4 (Firmware 4.4+)', isDefault: true },
    { value: 'v3', label: 'V3 (Firmware 4.3.x)' },
  ]);

  assert.deepEqual(options, [
    { value: 'v4', label: 'V4 (Firmware 4.4+)', isDefault: true },
    { value: 'v3', label: 'V3 (Firmware 4.3.x)' },
  ]);
});

test('invalid curated options fall back to registered options', () => {
  const options = resolvePrinterFormatVersionOptions(registeredOptions, [
    { value: 'v99', label: 'Unsupported' },
  ]);

  assert.equal(options, registeredOptions);
});

test('official profile updates preserve an allowed selected version', () => {
  const version = resolveFormatVersionFromOptions('v3', 'v4', [
    { value: 'v4', label: 'V4 (Firmware 4.4+)', isDefault: true },
    { value: 'v3', label: 'V3 (Firmware 4.3.x)' },
  ]);

  assert.equal(version, 'v3');
});

test('official profile updates use the preset default when selection is no longer allowed', () => {
  const version = resolveFormatVersionFromOptions('v2', 'v4', [
    { value: 'v4', label: 'V4 (Firmware 4.4+)', isDefault: true },
    { value: 'v3', label: 'V3 (Firmware 4.3.x)' },
  ]);

  assert.equal(version, 'v4');
});

test('sanitization removes malformed and duplicate options', () => {
  const options = sanitizePrinterFormatVersionOptions([
    { value: 'v4', label: ' V4 ' },
    { value: 'V4', label: 'Duplicate' },
    { value: 'bad value', label: 'Invalid' },
  ]);

  assert.deepEqual(options, [{ value: 'v4', label: 'V4' }]);
});
