import test from 'node:test';
import assert from 'node:assert/strict';
import { slicedFileToUpload } from '../slicedFileUpload';

test('a file of the printer format keeps its path and name', () => {
  assert.deepEqual(slicedFileToUpload({ name: 'plate_1.ctb', path: 'C:\\out\\plate_1.ctb' }, 'ctb'), {
    blob: null,
    outputName: 'plate_1.ctb',
    nativeTempPath: 'C:\\out\\plate_1.ctb',
  });
});

test('the extension matches in any case and the name is made ASCII', () => {
  assert.equal(slicedFileToUpload({ name: 'Arañita v1.2.CTB', path: '/x' }, 'ctb')?.outputName, 'Aranita_v1_2.ctb');
});

test('a file of another format is refused', () => {
  assert.equal(slicedFileToUpload({ name: 'plate.goo', path: '/x' }, 'ctb'), null);
  assert.equal(slicedFileToUpload({ name: 'plate.ctb.zip', path: '/x' }, 'ctb'), null);
  assert.equal(slicedFileToUpload({ name: 'plate', path: '/x' }, 'ctb'), null);
});
