import test from 'node:test';
import assert from 'node:assert/strict';
import { platesListHasFileNamed, slicedFileToUpload } from '../slicedFileUpload';

test('a name already on the printer is found by its file name, in any case', () => {
  const payload = { plates: [{ Path: '/local/plate_1_2.ctb' }, { name: 'other.ctb' }] };
  assert.equal(platesListHasFileNamed(payload, 'plate_1_2.ctb'), true);
  assert.equal(platesListHasFileNamed(payload, 'PLATE_1_2.CTB'), true);
  assert.equal(platesListHasFileNamed(payload, 'other.ctb'), true);
});

test('a name that only contains another file name is not a match', () => {
  const payload = { plates: [{ Path: '/local/plate10.ctb' }] };
  assert.equal(platesListHasFileNamed(payload, 'plate1.ctb'), false);
  assert.equal(platesListHasFileNamed(payload, '10.ctb'), false);
});

test('a response without a plates list holds no files', () => {
  assert.equal(platesListHasFileNamed(null, 'a.ctb'), false);
  assert.equal(platesListHasFileNamed({ ok: false }, 'a.ctb'), false);
  assert.equal(platesListHasFileNamed({ plates: [null, { Path: 7 }] }, 'a.ctb'), false);
});

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
