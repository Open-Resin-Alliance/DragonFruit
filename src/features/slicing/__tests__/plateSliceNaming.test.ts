import assert from 'node:assert/strict';
import test from 'node:test';

import { derivePlateOutputPath, plateSliceBaseName } from '../plateSliceNaming';
import type { LoadedModel } from '@/features/scene/useSceneCollectionManager';

/** Only the fields the naming reads: a model's display name. */
const model = (name: string): LoadedModel => ({ name, visible: true } as LoadedModel);

test("a plate's slice takes the plate's name when it has one", () => {
  assert.equal(plateSliceBaseName('Left bed', [model('poussin.stl')]), 'Left bed');
  // The plate's name wins even when its models disagree.
  assert.equal(plateSliceBaseName('Left bed', [model('other.stl')]), 'Left bed');
});

test('an unnamed plate falls back to the first model standing on it', () => {
  assert.equal(plateSliceBaseName('', [model('poussin.stl'), model('second.stl')]), 'poussin');
  // Whitespace is not a name.
  assert.equal(plateSliceBaseName('   ', [model('poussin.stl')]), 'poussin');
});

test('an unnamed plate with no models still gets a usable name', () => {
  assert.equal(plateSliceBaseName('', []), 'MyPrint');
});

test('a sibling output path keeps the directory and the extension', () => {
  assert.equal(
    derivePlateOutputPath('C:\\prints\\scene.ctb', 'Left bed'),
    'C:\\prints\\Left bed.ctb',
  );
  assert.equal(
    derivePlateOutputPath('/home/paul/scene.ctb', 'Right bed'),
    '/home/paul/Right bed.ctb',
  );
});

test('a chosen path with no extension still yields a sibling', () => {
  assert.equal(derivePlateOutputPath('/home/paul/scene', 'Left bed'), '/home/paul/Left bed');
});

test('no chosen path leaves the destination to the caller', () => {
  assert.equal(derivePlateOutputPath('', 'Left bed'), null);
  assert.equal(derivePlateOutputPath('   ', 'Left bed'), null);
});
