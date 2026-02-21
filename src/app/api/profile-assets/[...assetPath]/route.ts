import { promises as fs } from 'fs';
import path from 'path';
import { NextResponse } from 'next/server';

const PROFILE_ROOT = path.resolve(process.cwd(), 'profiles');
const PLUGIN_ROOT = path.resolve(process.cwd(), 'plugins');

const CONTENT_TYPE_BY_EXTENSION: Record<string, string> = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.gif': 'image/gif',
  '.svg': 'image/svg+xml',
  '.avif': 'image/avif',
};

function getContentType(filePath: string): string {
  return CONTENT_TYPE_BY_EXTENSION[path.extname(filePath).toLowerCase()] ?? 'application/octet-stream';
}

function isPathInsideRoot(targetPath: string): boolean {
  const relative = path.relative(PROFILE_ROOT, targetPath);
  return !relative.startsWith('..') && !path.isAbsolute(relative);
}

function isPathInsidePluginRoot(targetPath: string): boolean {
  const relative = path.relative(PLUGIN_ROOT, targetPath);
  return !relative.startsWith('..') && !path.isAbsolute(relative);
}

async function readIfExists(filePath: string): Promise<Buffer | null> {
  try {
    return await fs.readFile(filePath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException)?.code === 'ENOENT') {
      return null;
    }
    throw error;
  }
}

async function resolveLegacyPrinterAssets(assetParts: string[]): Promise<string | null> {
  if (assetParts.length < 3) return null;
  if (assetParts[0] !== 'printers' || assetParts[1] !== 'assets') return null;

  const assetTail = assetParts.slice(2);
  const manufacturersRoot = path.join(PROFILE_ROOT, 'printers');

  let manufacturerEntries: string[] = [];
  try {
    manufacturerEntries = await fs.readdir(manufacturersRoot);
  } catch {
    return null;
  }

  for (const manufacturer of manufacturerEntries) {
    const fallbackPath = path.join(manufacturersRoot, manufacturer, 'assets', ...assetTail);
    if (!isPathInsideRoot(fallbackPath)) continue;

    const bytes = await readIfExists(fallbackPath);
    if (bytes) {
      return fallbackPath;
    }
  }

  return null;
}

export async function GET(
  _request: Request,
  context: { params: Promise<{ assetPath: string[] }> },
) {
  const { assetPath } = await context.params;

  const safeAssetPath = (assetPath ?? []).filter((segment) => segment && segment !== '.');
  if (safeAssetPath.length === 0) {
    return NextResponse.json({ error: 'Missing asset path' }, { status: 400 });
  }

  const isPluginAsset = safeAssetPath[0] === 'plugins';
  const requestedPath = isPluginAsset
    ? path.resolve(process.cwd(), ...safeAssetPath)
    : path.resolve(PROFILE_ROOT, ...safeAssetPath);

  if (isPluginAsset) {
    if (!isPathInsidePluginRoot(requestedPath)) {
      return NextResponse.json({ error: 'Invalid plugin asset path' }, { status: 400 });
    }
  } else if (!isPathInsideRoot(requestedPath)) {
    return NextResponse.json({ error: 'Invalid asset path' }, { status: 400 });
  }

  let resolvedPath = requestedPath;
  let bytes = await readIfExists(resolvedPath);

  if (!bytes) {
    const legacyResolvedPath = await resolveLegacyPrinterAssets(safeAssetPath);
    if (legacyResolvedPath) {
      resolvedPath = legacyResolvedPath;
      bytes = await readIfExists(resolvedPath);
    }
  }

  if (!bytes) {
    return NextResponse.json({ error: 'Asset not found' }, { status: 404 });
  }

  return new NextResponse(Uint8Array.from(bytes), {
    headers: {
      'Content-Type': getContentType(resolvedPath),
      'Cache-Control': 'public, max-age=31536000, immutable',
    },
  });
}
