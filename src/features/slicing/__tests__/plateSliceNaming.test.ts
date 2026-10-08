import assert from 'node:assert/strict';
import test from 'node:test';

import { derivePlateOutputPath } from '../plateSliceNaming';

test('a sibling output path keeps the directory and the extension', () => {
  assert.equal(
    derivePlateOutputPath('C:\\prints\\scene.ctb', 'Left_bed'),
    'C:\\prints\\Left_bed.ctb',
  );
  assert.equal(
    derivePlateOutputPath('/home/paul/scene.ctb', 'Right_bed'),
    '/home/paul/Right_bed.ctb',
  );
});

test('a chosen path with no extension still yields a sibling', () => {
  assert.equal(derivePlateOutputPath('/home/paul/scene', 'Left_bed'), '/home/paul/Left_bed');
});

test('no chosen path leaves the destination to the caller', () => {
  assert.equal(derivePlateOutputPath('', 'Left_bed'), null);
  assert.equal(derivePlateOutputPath('   ', 'Left_bed'), null);
});
