import assert from 'node:assert/strict';
import test from 'node:test';

import { getInstalledProfilePlugins, installExternalProfilePlugin, uninstallExternalProfilePlugin } from '@/features/plugins/pluginRegistry';
import { getJobMetadataPayloadDeclarations } from '../jobMetadataPayloads';

/**
 * A package declares the same payload pairs a compiled plugin does. The baker knows
 * only the kinds, so the declaration list must carry the package's entry.
 */
const PLUGIN_ID = 'test.job-metadata';

const declarations = () => getJobMetadataPayloadDeclarations();
const ours = () => declarations().filter((declaration) => declaration.settingPath === 'echo.embedScene');

test('a package declaration joins the baked payload list', () => {
  assert.equal(ours().length, 0, 'absent before the install');

  installExternalProfilePlugin({
    schemaVersion: 1,
    id: PLUGIN_ID,
    name: 'Job Metadata',
    version: '1.0.0',
    jobMetadataPayloads: [
      { settingPath: 'echo.embedScene', payloadPath: 'echo.sceneBase64', payload: 'voxl-scene' },
    ],
  });
  try {
    assert.deepEqual(ours(), [
      { settingPath: 'echo.embedScene', payloadPath: 'echo.sceneBase64', payload: 'voxl-scene' },
    ]);
  } finally {
    uninstallExternalProfilePlugin(PLUGIN_ID);
  }

  assert.equal(ours().length, 0, 'withdrawn with the plugin');
  assert.equal(getInstalledProfilePlugins().some((plugin) => plugin.manifest.id === PLUGIN_ID), false);
});
