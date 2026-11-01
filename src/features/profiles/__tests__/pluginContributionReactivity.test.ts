import assert from 'node:assert/strict';
import test from 'node:test';

import type { PluginManifest } from '@/features/plugins/pluginRegistry';
import {
  getAvailablePrinterPresets,
  getProfileStoreSnapshot,
  installPluginFromManifest,
  uninstallPlugin,
} from '../profileStore';

/**
 * A package's presets are read out of the plugin registry on every call, so the
 * store's snapshot has to move when the registry does. Without that,
 * `useSyncExternalStore` compares two identical objects, skips the render, and a
 * plugin installed this session stays invisible in the printer library until a
 * reload — which is exactly how it failed.
 */
const PLUGIN_ID = 'test.contribution-reactivity';
const PRESET_ID = 'test.contribution-reactivity-printer';

const manifest: PluginManifest = {
  schemaVersion: 1,
  id: PLUGIN_ID,
  name: 'Contribution Reactivity',
  version: '1.0.0',
  printerPresets: [
    {
      presetId: PRESET_ID,
      profileVersion: 1,
      manufacturer: 'Test',
      name: 'Reactive Printer',
      buildVolumeMm: { width: 100, depth: 60, height: 120 },
      display: { resolutionX: 2048, resolutionY: 1152, outputFormat: '.png' },
    },
  ],
  materialTemplates: [{ name: 'Reactive Resin' } as PluginManifest['materialTemplates'] extends (infer T)[] | undefined ? T : never],
};

const hasPreset = () => getAvailablePrinterPresets().some((preset) => preset.presetId === PRESET_ID);

test('the profile snapshot is stable while nothing changes', () => {
  assert.equal(getProfileStoreSnapshot(), getProfileStoreSnapshot());
});

test('installing a plugin with presets moves the snapshot and publishes the preset', () => {
  assert.equal(hasPreset(), false, 'the preset is absent before the install');
  const before = getProfileStoreSnapshot();

  installPluginFromManifest(manifest);

  const after = getProfileStoreSnapshot();
  assert.notEqual(after, before, 'the snapshot identity changed, so consumers re-render');
  assert.equal(getProfileStoreSnapshot(), after, 'the new snapshot is itself stable');
  assert.equal(hasPreset(), true);

  uninstallPlugin(PLUGIN_ID);

  assert.notEqual(getProfileStoreSnapshot(), after, 'removing the plugin moves the snapshot again');
  assert.equal(hasPreset(), false);
});
