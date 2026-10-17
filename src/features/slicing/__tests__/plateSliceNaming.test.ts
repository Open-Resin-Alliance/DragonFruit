import assert from 'node:assert/strict';
import test from 'node:test';

import { joinSliceOutputPath, sliceFileBaseName } from '../plateSliceNaming';

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

test('a plate name keeps its letters and loses what a file system refuses', () => {
  assert.equal(sliceFileBaseName('Arañita_(copia)'), 'Arañita_(copia)');
  assert.equal(sliceFileBaseName('Left/right: bed?'), 'Left_right_ bed_');
  assert.equal(joinSliceOutputPath('/tmp', 'a/b', 'ctb'), '/tmp/a_b.ctb');
});
