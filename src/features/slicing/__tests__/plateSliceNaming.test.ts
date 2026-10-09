import assert from 'node:assert/strict';
import test from 'node:test';

import { derivePlateOutputPath, joinSliceOutputPath } from '../plateSliceNaming';

test('a batch file lands in the chosen folder, named for its plate', () => {
  assert.equal(
    joinSliceOutputPath('C:\\prints\\batch', 'Plate_2', 'ctb'),
    'C:\\prints\\batch\\Plate_2.ctb',
  );
  // A trailing separator is not doubled, and a Unix path keeps its own separator.
  assert.equal(
    joinSliceOutputPath('/home/paul/batch/', 'Left_bed', '.ctb'),
    '/home/paul/batch/Left_bed.ctb',
  );
  // Nothing to name it for still yields a usable file.
  assert.equal(joinSliceOutputPath('/tmp/out', '', ''), '/tmp/out/slice_export');
});

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
