import genericPrinters from './generic/printers.json';

function normalizeRelativePath(baseDir: string, relativePath: string): string {
  const stack = baseDir.split('/').filter(Boolean);
  const segments = relativePath.split('/');

  for (const segment of segments) {
    if (!segment || segment === '.') continue;
    if (segment === '..') {
      if (stack.length > 0) stack.pop();
      continue;
    }
    stack.push(segment);
  }

  return stack.join('/');
}

function normalizePresetImagePath(baseDir: string, imageAssetPath?: string): string | undefined {
  if (!imageAssetPath) return undefined;

  const trimmed = imageAssetPath.trim();
  if (!trimmed) return undefined;

  if (
    trimmed.startsWith('http://')
    || trimmed.startsWith('https://')
    || trimmed.startsWith('data:')
    || trimmed.startsWith('/api/profile-assets/')
    || trimmed.startsWith('/')
  ) {
    return trimmed;
  }

  const normalized = normalizeRelativePath(baseDir, trimmed);
  return `/api/profile-assets/${normalized}`;
}

function withResolvedImagePaths<T extends object>(
  baseDir: string,
  presets: T[],
): T[] {
  return presets.map((preset) => {
    const currentImagePath = (preset as { imageAssetPath?: string }).imageAssetPath;
    const normalizedImagePath = normalizePresetImagePath(baseDir, currentImagePath);

    if (!normalizedImagePath) {
      return preset;
    }

    return {
      ...preset,
      imageAssetPath: normalizedImagePath,
    } as T;
  });
}

// The one core preset, and the only place a format ships without a plugin declaring
// it as its own printer's. It prints `.lumen` deliberately: the Generic Machine is the
// Open Resin Alliance reference machine and LUMEN is the alliance's format, so this is
// a statement about that machine rather than a default for everyone - every other
// preset names the format its printer actually reads, and a profile whose format no
// installed plugin claims is reported to the user instead of being substituted
// (see features/slicing/formats/registry.ts).
const printerPresets = [
  ...withResolvedImagePaths('printers/generic', genericPrinters),
];

export default printerPresets;
