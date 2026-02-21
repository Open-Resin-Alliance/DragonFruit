import { NextResponse } from 'next/server';

type GithubRepoRef = {
  owner: string;
  repo: string;
  branch?: string;
};

const MAX_PRINTER_PRESETS = 128;
const MAX_MATERIAL_TEMPLATES = 512;

function boundedString(value: unknown, max = 120): string {
  return typeof value === 'string' ? value.trim().slice(0, max) : '';
}

function optionalHttpUrl(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  if (!trimmed) return undefined;

  try {
    const parsed = new URL(trimmed);
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return undefined;
    return parsed.toString();
  } catch {
    return undefined;
  }
}

function parseOutputFormat(value: unknown): '.nanodlp' | '.goo' | '.lumen' {
  return value === '.nanodlp' || value === '.goo' || value === '.lumen'
    ? value
    : '.goo';
}

function sanitizeNumber(value: unknown, fallback: number, min: number, max: number): number {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, n));
}

function sanitizePrinterPreset(input: unknown, baseRawDir: string) {
  const value = (input ?? {}) as Record<string, unknown>;

  const presetId = boundedString(value.presetId, 120);
  const manufacturer = boundedString(value.manufacturer, 80);
  const name = boundedString(value.name, 120);
  if (!presetId || !manufacturer || !name) return null;

  return {
    presetId,
    manufacturer,
    name,
    imageAssetPath: resolveAssetPath(baseRawDir, typeof value.imageAssetPath === 'string' ? value.imageAssetPath : undefined),
    buildVolumeMm: {
      width: sanitizeNumber((value as any).buildVolumeMm?.width, 143, 1, 10000),
      depth: sanitizeNumber((value as any).buildVolumeMm?.depth, 89, 1, 10000),
      height: sanitizeNumber((value as any).buildVolumeMm?.height, 175, 1, 10000),
    },
    display: {
      resolutionX: Math.round(sanitizeNumber((value as any).display?.resolutionX, 2560, 1, 200000)),
      resolutionY: Math.round(sanitizeNumber((value as any).display?.resolutionY, 1620, 1, 200000)),
      outputFormat: parseOutputFormat((value as any).display?.outputFormat),
    },
    networkSupport: (value as any).networkSupport === 'nanodlp' ? 'nanodlp' : undefined,
  };
}

function sanitizeMaterialTemplate(input: unknown) {
  const value = (input ?? {}) as Record<string, unknown>;
  const name = boundedString(value.name, 120);
  if (!name) return null;

  const currencyCode = boundedString(value.currencyCode, 3).toUpperCase() || 'USD';
  const resinFamilyRaw = boundedString(value.resinFamily, 32).toLowerCase();
  const resinFamily = (
    resinFamilyRaw === 'standard'
    || resinFamilyRaw === 'abs-like'
    || resinFamilyRaw === 'tough'
    || resinFamilyRaw === 'flexible'
    || resinFamilyRaw === 'engineering'
    || resinFamilyRaw === 'other'
  )
    ? resinFamilyRaw
    : 'standard';

  return {
    name,
    brand: boundedString(value.brand, 80) || 'Default',
    currencyCode,
    bottlePrice: sanitizeNumber(value.bottlePrice, 0, 0, 1000000),
    bottleCapacityMl: sanitizeNumber(value.bottleCapacityMl, 1000, 1, 1000000),
    resinFamily,
    scaleCompensationPct: {
      x: sanitizeNumber((value as any).scaleCompensationPct?.x, 0, -100, 100),
      y: sanitizeNumber((value as any).scaleCompensationPct?.y, 0, -100, 100),
      z: sanitizeNumber((value as any).scaleCompensationPct?.z, 0, -100, 100),
    },
    layerHeightMm: sanitizeNumber(value.layerHeightMm, 0.05, 0.001, 10),
    normalExposureSec: sanitizeNumber(value.normalExposureSec, 2.5, 0.01, 10000),
    bottomExposureSec: sanitizeNumber(value.bottomExposureSec, 28, 0.01, 10000),
    bottomLayerCount: Math.round(sanitizeNumber(value.bottomLayerCount, 5, 0, 100000)),
    liftDistanceMm: sanitizeNumber(value.liftDistanceMm, 6, 0, 1000),
    liftSpeedMmMin: sanitizeNumber(value.liftSpeedMmMin, 60, 0, 100000),
    retractSpeedMmMin: sanitizeNumber(value.retractSpeedMmMin, 150, 0, 100000),
  };
}

function parseGithubRepoUrl(input: string): GithubRepoRef | null {
  const trimmed = input.trim();
  if (!trimmed) return null;

  try {
    const parsed = new URL(trimmed);
    if (!/github\.com$/i.test(parsed.hostname)) return null;

    const parts = parsed.pathname.split('/').filter(Boolean);
    if (parts.length < 2) return null;

    const owner = parts[0];
    const repo = parts[1].replace(/\.git$/i, '');
    if (!owner || !repo) return null;

    let branch: string | undefined;
    if (parts[2] === 'tree' && parts[3]) {
      branch = parts[3];
    }

    return { owner, repo, branch };
  } catch {
    return null;
  }
}

async function resolveDefaultBranch(owner: string, repo: string): Promise<string> {
  try {
    const response = await fetch(`https://api.github.com/repos/${owner}/${repo}`, {
      headers: {
        Accept: 'application/vnd.github+json',
      },
      cache: 'no-store',
      signal: AbortSignal.timeout(8000),
    });

    if (!response.ok) return 'main';
    const payload = await response.json().catch(() => null) as any;
    return typeof payload?.default_branch === 'string' && payload.default_branch.trim().length > 0
      ? payload.default_branch.trim()
      : 'main';
  } catch {
    return 'main';
  }
}

function toRawGithubUrl(owner: string, repo: string, branch: string, path: string): string {
  return `https://raw.githubusercontent.com/${owner}/${repo}/${branch}/${path}`;
}

function resolveAssetPath(baseRawDir: string, inputPath?: string): string | undefined {
  if (!inputPath) return undefined;
  const trimmed = inputPath.trim();
  if (!trimmed) return undefined;

  if (/^https?:\/\//i.test(trimmed)) return trimmed;
  if (trimmed.startsWith('data:')) return undefined;

  const normalized = trimmed.replace(/^\/+/, '');
  return `${baseRawDir}/${normalized}`;
}

function sanitizeManifest(manifest: any, baseRawDir: string) {
  const value = (manifest ?? {}) as any;

  const sanitizedPrinterPresets = Array.isArray(value.printerPresets)
    ? value.printerPresets
      .slice(0, MAX_PRINTER_PRESETS)
      .map((preset: unknown) => sanitizePrinterPreset(preset, baseRawDir))
      .filter((preset: ReturnType<typeof sanitizePrinterPreset>): preset is NonNullable<ReturnType<typeof sanitizePrinterPreset>> => preset !== null)
    : [];

  const sanitizedMaterialTemplates = Array.isArray(value.materialTemplates)
    ? value.materialTemplates
      .slice(0, MAX_MATERIAL_TEMPLATES)
      .map((template: unknown) => sanitizeMaterialTemplate(template))
      .filter((template: ReturnType<typeof sanitizeMaterialTemplate>): template is NonNullable<ReturnType<typeof sanitizeMaterialTemplate>> => template !== null)
    : [];

  const sanitized = {
    schemaVersion: Number.isFinite(Number(value.schemaVersion)) ? Number(value.schemaVersion) : 1,
    id: boundedString(value.id, 120),
    name: boundedString(value.name, 120),
    version: boundedString(value.version, 48),
    description: boundedString(value.description, 500) || undefined,
    author: boundedString(value.author, 120) || undefined,
    homepage: optionalHttpUrl(value.homepage),
    printerPresets: sanitizedPrinterPresets,
    materialTemplates: sanitizedMaterialTemplates,
  };

  if (!sanitized.id || !sanitized.name || !sanitized.version) {
    return null;
  }

  return sanitized;
}

export async function POST(request: Request) {
  let payload: unknown;
  try {
    payload = await request.json();
  } catch {
    return NextResponse.json({ ok: false, error: 'Invalid request JSON' }, { status: 400 });
  }

  const repoUrl = typeof (payload as any)?.repoUrl === 'string' ? (payload as any).repoUrl : '';
  const manifestPath = typeof (payload as any)?.manifestPath === 'string' && (payload as any).manifestPath.trim().length > 0
    ? (payload as any).manifestPath.trim().replace(/^\/+/, '')
    : 'dragonfruit-plugin.json';

  if (manifestPath.includes('..') || manifestPath.includes('\\') || manifestPath.length > 240) {
    return NextResponse.json({ ok: false, error: 'Invalid manifest path' }, { status: 400 });
  }

  const repoRef = parseGithubRepoUrl(repoUrl);
  if (!repoRef) {
    return NextResponse.json({ ok: false, error: 'Invalid GitHub repository URL' }, { status: 400 });
  }

  const branch = repoRef.branch || await resolveDefaultBranch(repoRef.owner, repoRef.repo);
  const rawManifestUrl = toRawGithubUrl(repoRef.owner, repoRef.repo, branch, manifestPath);

  try {
    const response = await fetch(rawManifestUrl, {
      headers: {
        Accept: 'application/json',
      },
      cache: 'no-store',
      signal: AbortSignal.timeout(10000),
    });

    if (!response.ok) {
      return NextResponse.json({
        ok: false,
        error: `Unable to fetch manifest (HTTP ${response.status})`,
        rawManifestUrl,
      }, { status: 404 });
    }

    const manifestPayload = await response.json().catch(() => null);
    if (!manifestPayload) {
      return NextResponse.json({ ok: false, error: 'Manifest is not valid JSON', rawManifestUrl }, { status: 400 });
    }

    const baseRawDir = rawManifestUrl.slice(0, rawManifestUrl.lastIndexOf('/'));
    const manifest = sanitizeManifest(manifestPayload, baseRawDir);

    if (!manifest) {
      return NextResponse.json({ ok: false, error: 'Manifest missing required fields: id, name, version', rawManifestUrl }, { status: 400 });
    }

    return NextResponse.json({
      ok: true,
      repo: {
        owner: repoRef.owner,
        name: repoRef.repo,
        branch,
      },
      rawManifestUrl,
      manifest,
    });
  } catch (error) {
    return NextResponse.json({
      ok: false,
      error: error instanceof Error ? error.message : 'Failed to fetch manifest',
      rawManifestUrl,
    }, { status: 500 });
  }
}
