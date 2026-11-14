import crealityHalotPrinters from './printers/halot-series.json';

function resolvePresetImagePath(imageAssetPath: unknown): string | undefined {
  if (typeof imageAssetPath !== 'string' || !imageAssetPath.trim()) return undefined;
  const trimmed = imageAssetPath.trim();
  if (trimmed.startsWith('/') || trimmed.startsWith('http')) return trimmed;
  const normalized = trimmed.startsWith('./') ? trimmed.slice(2) : trimmed;
  return `/plugins/creality/printers/${normalized}`;
}

function mapPresets(presets: Record<string, unknown>[]) {
  return presets.map((preset) => ({
    ...preset,
    imageAssetPath: resolvePresetImagePath(preset.imageAssetPath),
  }));
}

export const CREALITY_PLUGIN_MANIFEST = {
  schemaVersion: 1,
  id: 'creality-builtin',
  name: 'Creality Plugin',
  version: '0.1.0',
  description: 'Creality HALOT printer profiles and native .cxdlpv4 slicing support for DragonFruit.',
  author: 'Open Resin Alliance',
  homepage: 'https://www.creality.com',
  printerPresets: [
    ...mapPresets(crealityHalotPrinters as Record<string, unknown>[]),
  ],
  materialTemplates: [],
};
