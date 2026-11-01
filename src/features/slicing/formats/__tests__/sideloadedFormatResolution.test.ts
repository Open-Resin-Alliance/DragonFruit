import assert from 'node:assert/strict';
import test from 'node:test';
import {
  applySideloadedOutputFormats,
  getSideloadedOutputFormatsSnapshot,
  subscribeSideloadedFileTypes,
} from '@/features/plugins/sideloadedFileTypeRegistry';
import {
  getAvailableOutputFormatOptions,
  resolveOutputFileExtension,
  resolveOutputFormatVersion,
  resolveSlicingFormatDefinitionByOutput,
} from '@/features/slicing/formats/registry';

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

// A package can offer output versions, and a version can be the file extension:
// the Echo container keeps one encoder but writes `.exf` or the multi-tank `.exm`.
test('a sideloaded format can offer versions that are the output extension', () => {
  applySideloadedOutputFormats([
    {
      pluginId: 'example.full',
      pluginName: 'Full Feature Example',
      extension: '.exf',
      displayName: 'Echo container',
      multiTank: true,
      formatVersions: [
        { id: 'exf', label: 'Echo', isDefault: true },
        { id: 'exm', label: 'Echo Multi' },
      ],
      fileExtensionFromVersion: true,
    },
  ]);

  const definition = resolveSlicingFormatDefinitionByOutput('.exf');
  assert.deepEqual(definition?.formatVersions?.map((entry) => entry.value), ['exf', 'exm']);
  assert.equal(definition?.formatVersions?.[1].label, 'Echo Multi');
  assert.equal(definition?.fileExtensionFromVersion, true);
  assert.equal(definition?.supportsMultiTank, true);

  assert.equal(resolveOutputFormatVersion('.exf', 'exm'), 'exm');
  assert.equal(resolveOutputFileExtension('.exf', 'exm'), 'exm');
  assert.equal(resolveOutputFileExtension('.exf', 'exf'), 'exf');

  const option = getAvailableOutputFormatOptions().find((entry) => entry.value === '.exf');
  assert.equal(option?.label, 'Echo container', 'the picker names the format only');
  applySideloadedOutputFormats([]);
});

// A package reinstalled at the same id and extension still changes what it
// offers; comparing only identity left the stale snapshot in place, which is why
// a new output version never reached the profile editor.
test('reinstalling a package updates the formats snapshot', () => {
  let notifications = 0;
  const unsubscribe = subscribeSideloadedFileTypes(() => {
    notifications += 1;
  });

  applySideloadedOutputFormats([
    {
      pluginId: 'example.full',
      pluginName: 'Full Feature Example',
      extension: '.exf',
      displayName: 'Echo container',
    },
  ]);
  applySideloadedOutputFormats([
    {
      pluginId: 'example.full',
      pluginName: 'Full Feature Example',
      extension: '.exf',
      displayName: 'Echo container',
      multiTank: true,
      formatVersions: [
        { id: 'exf', label: 'Echo', isDefault: true },
        { id: 'exm', label: 'Echo Multi' },
      ],
      fileExtensionFromVersion: true,
    },
  ]);

  const formats = getSideloadedOutputFormatsSnapshot();
  assert.equal(formats[0]?.formatVersions?.length, 2);
  assert.equal(formats[0]?.multiTank, true);
  assert.ok(notifications >= 2, 'subscribers were told each time');
  unsubscribe();
  applySideloadedOutputFormats([]);
});
