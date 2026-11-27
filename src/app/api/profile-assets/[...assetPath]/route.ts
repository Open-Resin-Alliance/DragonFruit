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
  request: Request,
  context: { params: Promise<{ assetPath: string[] }> },
) {
  const { assetPath } = await context.params;

  const safeAssetPath = (assetPath ?? []).filter((segment) => segment && segment !== '.');
  if (safeAssetPath.length === 0) {
    return NextResponse.json({ error: 'Missing asset path' }, { status: 400 });
  }

  const isPluginAsset = safeAssetPath[0] === 'plugins';
  const relativeAssetPath = isPluginAsset ? safeAssetPath.slice(1) : safeAssetPath;
  const requestedPath = isPluginAsset
    ? path.resolve(PLUGIN_ROOT, ...relativeAssetPath)
    : path.resolve(PROFILE_ROOT, ...relativeAssetPath);

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

  // These files are edited in place - a plugin swaps a printer photo without the
  // URL changing - so the response is revalidated rather than declared immutable.
  // That is what made `tauri:dev` keep showing a replaced preset image: the webview
  // had cached the old bytes for a year under the same path.
  const info = await fs.stat(resolvedPath);
  const etag = `W/"${bytes.length.toString(16)}-${Math.floor(info.mtimeMs).toString(16)}"`;
  const headers = {
    'Content-Type': getContentType(resolvedPath),
    'Cache-Control': 'no-cache',
    ETag: etag,
  };

  if (request.headers.get('if-none-match') === etag) {
    return new NextResponse(null, { status: 304, headers });
  }

  return new NextResponse(Uint8Array.from(bytes), { headers });
}
