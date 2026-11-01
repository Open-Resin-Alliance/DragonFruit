import assert from 'node:assert/strict';
import test from 'node:test';

import { applySideloadedOutputFormats } from '../sideloadedFileTypeRegistry';
import { outputFormatSupportsMultiTank } from '@/features/slicing/formats/registry';

/**
 * Material Mode only means something for a format that can carry more than one
 * material. A package declares that on its format, and the printer settings hide the
 * control for every other format.
 */
test('a package format declares multi-tank, and only that format reports it', () => {
  assert.equal(outputFormatSupportsMultiTank('.exf'), false, 'nothing installed yet');

  applySideloadedOutputFormats([
    {
      pluginId: 'example.full',
      pluginName: 'Full Feature Example',
      extension: '.exf',
      displayName: 'Echo container',
      multiTank: true,
    },
    {
      pluginId: 'example.single',
      pluginName: 'Single',
      extension: '.one',
      displayName: 'Single material container',
    },
  ]);

  try {
    assert.equal(outputFormatSupportsMultiTank('.exf'), true);
    assert.equal(outputFormatSupportsMultiTank('.one'), false, 'a format without the flag does not offer it');
    assert.equal(outputFormatSupportsMultiTank('.ctb'), false, 'compiled formats are single-material today');
    assert.equal(outputFormatSupportsMultiTank(''), false);
    assert.equal(outputFormatSupportsMultiTank(null), false);
  } finally {
    applySideloadedOutputFormats([]);
  }

  assert.equal(outputFormatSupportsMultiTank('.exf'), false, 'withdrawn with the formats');
});
