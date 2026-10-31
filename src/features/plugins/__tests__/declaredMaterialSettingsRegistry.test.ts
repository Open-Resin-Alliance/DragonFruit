import assert from 'node:assert/strict';
import test from 'node:test';

import {
  getProfileLocalMaterialSettingsAdapter,
  installExternalProfilePlugin,
  uninstallExternalProfilePlugin,
} from '../pluginRegistry';
import type { PluginManifest } from '../pluginRegistry';

/**
 * A package's material pane is the compiled plugins' schema, carried as data. The
 * registry registers it for the package's own output format and refuses to take a
 * format or mode a compiled plugin already owns.
 */
const PLUGIN_ID = 'test.declared-material-settings';

const manifest: PluginManifest = {
  schemaVersion: 1,
  id: PLUGIN_ID,
  name: 'Declared Settings',
  version: '1.0.0',
  materialSettings: {
    byOutput: {
      '.exf': {
        displayName: 'Echo settings',
        fields: [{ key: 'exposureSec', label: 'Exposure', kind: 'number', defaultValue: 2.5 }],
      },
    },
    byOutputAndMode: {
      '.exf': {
        twostage: {
          $inherit: 'default',
          fields: [{ key: 'lift2Mm', label: 'Lift 2', kind: 'number', defaultValue: 4 }],
        },
      },
    },
  },
};

const settingsFor = (format: string) => getProfileLocalMaterialSettingsAdapter(format);

test('a package fills a format no compiled plugin owns', () => {
  assert.equal(settingsFor('.exf'), null, 'absent before the install');

  installExternalProfilePlugin(manifest);
  try {
    const adapter = settingsFor('.exf');
    assert.ok(adapter);
    assert.equal(adapter.outputFormat, '.exf');
    assert.deepEqual(adapter.fields.map((field) => field.key), ['exposureSec']);
    assert.equal(adapter.displayName, 'Echo settings');
  } finally {
    uninstallExternalProfilePlugin(PLUGIN_ID);
  }

  assert.equal(settingsFor('.exf'), null, 'withdrawn with the plugin');
});

test('a compiled format keeps its own settings', () => {
  const builtin = settingsFor('.ctb');
  assert.ok(builtin, 'the ctb format ships settings');

  installExternalProfilePlugin({
    ...manifest,
    materialSettings: {
      byOutput: { '.ctb': { displayName: 'Hijacked', fields: [{ key: 'x', label: 'X', kind: 'number', defaultValue: 1 }] } },
      byOutputAndMode: { '.ctb': { default: { displayName: 'Hijacked', fields: [{ key: 'x', label: 'X', kind: 'number', defaultValue: 1 }] } } },
    },
  });
  try {
    assert.equal(settingsFor('.ctb'), builtin, 'the compiled adapter is still registered');
  } finally {
    uninstallExternalProfilePlugin(PLUGIN_ID);
  }
});
