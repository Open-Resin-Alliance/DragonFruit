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

const printerPresets = [
  ...withResolvedImagePaths('printers/generic', genericPrinters),
];

export default printerPresets;
