import { test } from 'node:test';
import assert from 'node:assert/strict';
import { getInstalledProfilePlugins } from '../pluginRegistry';
import {
  getAvailablePrinterPresets,
  getLibraryPrinterPresets,
  matchPrinterVariantByBitDepth,
} from '../../profiles/profileStore';
import type { PrinterPreset } from '../../profiles/profileStore';

const ATHENA_16K_8B = 'concepts3d-athena2-16k8b-nanodlp';
const ATHENA_16K_3B = 'concepts3d-athena2-16k3b-nanodlp';

function getAthenaPresets(): PrinterPreset[] {
  return getInstalledProfilePlugins()
    .flatMap((plugin) => (plugin.enabled ? (plugin.manifest.printerPresets ?? []) : []))
    .filter((preset) => preset.manufacturer === 'Concepts3D');
}

test('plugin sanitizer preserves model-variant preset fields', () => {
  const presets = getAthenaPresets();

  const parent = presets.find((preset) => preset.presetId === ATHENA_16K_8B);
  assert.ok(parent, 'Athena II 16K 8-bit parent preset exists');
  assert.deepEqual(parent.modelVariants, [ATHENA_16K_8B, ATHENA_16K_3B]);
  assert.equal(parent.modelVariantDetectPath, '/athena-iot/dragonfruit/printer_data');

  const variant = presets.find((preset) => preset.presetId === ATHENA_16K_3B);
  assert.ok(variant, 'Athena II 16K 3-bit variant preset exists');
  assert.equal(variant.isModelVariant, true);
});

test('library preset lists hide hidden variants but keep the family card', () => {
  const all = getAvailablePrinterPresets();
  const library = getLibraryPrinterPresets();

  assert.equal(
    all.some((preset) => preset.presetId === ATHENA_16K_8B),
    true,
    'full list includes the 8-bit family preset',
  );
  assert.equal(
    all.some((preset) => preset.presetId === ATHENA_16K_3B),
    true,
    'full list still includes the hidden 3-bit variant (reachable by presetId)',
  );

  assert.equal(
    library.some((preset) => preset.presetId === ATHENA_16K_8B),
    true,
    'library list shows the family card',
  );
  assert.equal(
    library.some((preset) => preset.presetId === ATHENA_16K_3B),
    false,
    'library list hides the 3-bit variant',
  );
});

test('matchPrinterVariantByBitDepth resolves by declared bit depth', () => {
  const presets = getAthenaPresets();
  const variants = presets.filter(
    (preset) => preset.presetId === ATHENA_16K_8B || preset.presetId === ATHENA_16K_3B,
  );

  assert.equal(matchPrinterVariantByBitDepth(variants, 8)?.presetId, ATHENA_16K_8B);
  assert.equal(matchPrinterVariantByBitDepth(variants, 3)?.presetId, ATHENA_16K_3B);
  assert.equal(matchPrinterVariantByBitDepth(variants, 6), null);
  assert.equal(matchPrinterVariantByBitDepth(variants, null), null);
  assert.equal(matchPrinterVariantByBitDepth(variants, undefined), null);
});
