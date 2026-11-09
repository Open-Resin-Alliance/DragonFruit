import assert from 'node:assert/strict';
import test from 'node:test';

import { inlineSideloadedPresetAssets } from '../pluginAssets';

const read = (pluginId: string, assetPath: string) => Promise.resolve({
  mime: 'image/png',
  dataUrl: `data:image/png;base64,READ:${pluginId}:${assetPath}`,
});

test('a package-relative image path becomes a data URL', async () => {
  const [preset] = await inlineSideloadedPresetAssets('example.full', [
    { presetId: 'a', imageAssetPath: 'printers/echo.png' },
  ], read);

  assert.equal(preset.imageAssetPath, 'data:image/png;base64,READ:example.full:printers/echo.png');
});

test('an assets/ prefix is part of the package layout, not the path', async () => {
  const [preset] = await inlineSideloadedPresetAssets('example.full', [
    { presetId: 'a', imageAssetPath: 'assets/echo.png' },
  ], read);

  assert.equal(preset.imageAssetPath, 'data:image/png;base64,READ:example.full:echo.png');
});

test('remote, data and absolute paths pass through untouched', async () => {
  const presets = await inlineSideloadedPresetAssets('example.full', [
    { presetId: 'remote', imageAssetPath: 'https://example.com/a.png' },
    { presetId: 'data', imageAssetPath: 'data:image/png;base64,AAAA' },
    { presetId: 'absolute', imageAssetPath: '/printers/a.png' },
    { presetId: 'none' },
  ], read);

  assert.equal(presets[0].imageAssetPath, 'https://example.com/a.png');
  assert.equal(presets[1].imageAssetPath, 'data:image/png;base64,AAAA');
  assert.equal(presets[2].imageAssetPath, '/printers/a.png');
  assert.equal(presets[3].imageAssetPath, undefined);
});

test('a missing asset leaves the preset without an image instead of failing the install', async () => {
  const [preset] = await inlineSideloadedPresetAssets('example.full', [
    { presetId: 'a', imageAssetPath: 'missing.png' },
  ], async () => {
    throw new Error('asset not found');
  });

  assert.equal(preset.imageAssetPath, 'missing.png');
  assert.equal(preset.presetId, 'a');
});
