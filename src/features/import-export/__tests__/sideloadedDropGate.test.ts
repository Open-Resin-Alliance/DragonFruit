import assert from 'node:assert/strict';
import test from 'node:test';
import { applySideloadedFileTypes } from '@/features/plugins/sideloadedFileTypeRegistry';
import { isSceneFileName, isSupportedPrepareDropName } from '@/features/import-export/fileHandling';

// The drop handler asks these two synchronously, before anything is opened. A
// sideloaded package's extension only exists once the app has listed what is
// installed, so these gates decide whether a dropped file is even looked at.
test('a sideloaded scene extension passes the drop gate', () => {
  applySideloadedFileTypes([
    {
      pluginId: 'example.importer',
      pluginName: 'Echo Project Import',
      extension: '.echo',
      displayName: 'Echo project',
      isSceneFile: true,
    },
  ]);

  assert.equal(isSupportedPrepareDropName('job.echo'), true);
  assert.equal(isSceneFileName('job.echo'), true);
  assert.equal(isSupportedPrepareDropName('JOB.ECHO'), true, 'case-insensitive');

  assert.equal(isSupportedPrepareDropName('job.stl'), true, 'compiled-in formats still work');
  assert.equal(isSupportedPrepareDropName('job.unknown'), false);
  assert.equal(isSceneFileName('job.unknown'), false);
});

test('clearing the registry closes the gate again', () => {
  applySideloadedFileTypes([]);
  assert.equal(isSupportedPrepareDropName('job.echo'), false);
  assert.equal(isSceneFileName('job.echo'), false);
});
