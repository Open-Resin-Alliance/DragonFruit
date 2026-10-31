import assert from 'node:assert/strict';
import test from 'node:test';
import { applySideloadedOutputFormats } from '@/features/plugins/sideloadedFileTypeRegistry';
import { resolveSlicingFormatDefinitionByOutput } from '@/features/slicing/formats/registry';

// The slice path refuses a profile whose output format has no definition, which
// is how it avoids writing bytes that do not match the file name. A sideloaded
// package's format has to resolve, or installing an encoder changes nothing.
test('a sideloaded format resolves like a compiled-in one', () => {
  applySideloadedOutputFormats([
    {
      pluginId: 'example.encoder',
      pluginName: 'Echo Container Encoder',
      extension: '.exf',
      displayName: 'Echo container',
    },
  ]);

  const definition = resolveSlicingFormatDefinitionByOutput('.exf');
  assert.ok(definition, 'the format resolved');
  assert.equal(definition.outputFormat, '.exf');
  assert.equal(definition.displayName, 'Echo container');
  assert.equal(definition.ownership, 'plugin');
  assert.equal(definition.pluginId, 'example.encoder');
  assert.equal(definition.id, 'exf');

  // Compiled-in formats still win, and an unknown token still resolves to nothing.
  assert.equal(resolveSlicingFormatDefinitionByOutput('.ctb')?.outputFormat, '.ctb');
  assert.equal(resolveSlicingFormatDefinitionByOutput('.nope'), null);
});
