import { NextResponse } from 'next/server';
import { createHash } from 'node:crypto';
import { normalizeFormatVersion, normalizeOutputFormat, normalizeSettingsMode, normalizeWebcamRotationDeg, DEFAULT_WEBCAM_ROTATION_DEG } from '@/features/profiles/outputFormatUtils';

type GithubRepoRef = {
  owner: string;
  repo: string;
  branch?: string;
};

const MAX_PRINTER_PRESETS = 128;
const MAX_MATERIAL_TEMPLATES = 512;
const MAX_MATERIAL_PRESETS = 2048;
const MAX_INLINE_ASSET_BYTES = 2_500_000;
const MAX_INLINE_ASSET_BUDGET_BYTES = 20_000_000;
const DEFAULT_GITHUB_PLUGIN_ALLOWLIST = 'open-resin-alliance/*';

type GithubAllowlistRule = {
  owner: string;
  repo: string | '*';
};

type DebugPluginKind = 'official' | '3rd';

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

function parseOutputFormat(value: unknown): string {
  return normalizeOutputFormat(value);
}

function parseNetworkSupport(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const normalized = value.trim().toLowerCase();
  if (!normalized) return undefined;
  return normalized;
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
    profileVersion: Number.isFinite(Number((value as any).profileVersion))
      ? Math.max(1, Math.round(Number((value as any).profileVersion)))
      : undefined,
    manufacturer,
    family: boundedString(value.family, 80) || undefined,
    name,
    imageAssetPath: resolveAssetPath(baseRawDir, typeof value.imageAssetPath === 'string' ? value.imageAssetPath : undefined),
    antiAliasing: typeof value.antiAliasing === 'boolean' ? value.antiAliasing : undefined,
    hasCamera: typeof value.hasCamera === 'boolean' ? value.hasCamera : undefined,
    buildVolumeMm: {
      width: sanitizeNumber((value as any).buildVolumeMm?.width, 143, 1, 10000),
      depth: sanitizeNumber((value as any).buildVolumeMm?.depth, 89, 1, 10000),
      height: sanitizeNumber((value as any).buildVolumeMm?.height, 175, 1, 10000),
    },
    display: {
      resolutionX: Math.round(sanitizeNumber((value as any).display?.resolutionX, 2560, 1, 200000)),
      resolutionY: Math.round(sanitizeNumber((value as any).display?.resolutionY, 1620, 1, 200000)),
      outputFormat: parseOutputFormat((value as any).display?.outputFormat),
      formatVersion: normalizeFormatVersion((value as any).display?.formatVersion),
      settingsMode: normalizeSettingsMode((value as any).display?.settingsMode),
      webcamRotationDeg: normalizeWebcamRotationDeg(
        (value as any).display?.webcamRotationDeg ?? (value as any).display?.webcamOrientation,
        DEFAULT_WEBCAM_ROTATION_DEG,
      ),
      mirrorX: typeof (value as any).display?.mirrorX === 'boolean'
        ? (value as any).display.mirrorX
        : undefined,
      mirrorY: typeof (value as any).display?.mirrorY === 'boolean'
        ? (value as any).display.mirrorY
        : undefined,
    },
    networkSupport: parseNetworkSupport(value.networkSupport),
    networkFilter: boundedString((value as any).networkFilter, 120) || undefined,
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

function sanitizeMaterialPreset(input: unknown) {
  const base = sanitizeMaterialTemplate(input);
  if (!base) return null;

  const value = (input ?? {}) as Record<string, unknown>;
  const templateId = boundedString(value.templateId as string | undefined, 200) || undefined;
  const profileVersion = Number.isFinite(Number(value.profileVersion))
    ? Math.max(1, Math.round(Number(value.profileVersion)))
    : undefined;
  const validForPresets = Array.isArray(value.validForPresets)
    ? (value.validForPresets as unknown[])
      .slice(0, 256)
      .map((v) => boundedString(v as string, 120))
      .filter((v): v is string => v.length > 0)
    : undefined;

  const localSettingsByOutput = value.localSettingsByOutput && typeof value.localSettingsByOutput === 'object' && !Array.isArray(value.localSettingsByOutput)
    ? Object.fromEntries(
        Object.entries(value.localSettingsByOutput as Record<string, unknown>)
          .slice(0, 32)
          .map(([format, settings]) => [
            format,
            settings && typeof settings === 'object' && !Array.isArray(settings)
              ? Object.fromEntries(
                  Object.entries(settings as Record<string, unknown>)
                    .slice(0, 256)
                    .map(([k, v]) => [k, typeof v === 'number' || typeof v === 'boolean' || typeof v === 'string' ? v : 0]),
                )
              : {},
          ]),
      )
    : undefined;

  return {
    ...base,
    ...(templateId !== undefined ? { templateId } : {}),
    ...(profileVersion !== undefined ? { profileVersion } : {}),
    ...(validForPresets !== undefined ? { validForPresets } : {}),
    ...(localSettingsByOutput !== undefined ? { localSettingsByOutput } : {}),
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

function parseDebugPluginKind(input: string): DebugPluginKind | null {
  const trimmed = input.trim().toLowerCase();
  if (!trimmed) return null;

  if (trimmed === 'df://debug_plugin_official') return 'official';
  if (trimmed === 'df://debug_plugin_3rd') return '3rd';

  try {
    const parsed = new URL(trimmed);
    if (parsed.protocol !== 'df:' && parsed.protocol !== 'dragonfruit:') return null;
    const target = parsed.hostname || parsed.pathname.replace(/^\/+/, '');
    if (target === 'debug_plugin_official') return 'official';
    if (target === 'debug_plugin_3rd') return '3rd';
  } catch {
    return null;
  }

  return null;
}

function buildDebugPluginManifest(kind: DebugPluginKind) {
  if (kind === 'official') {
    return {
      schemaVersion: 1,
      id: 'debug-official-plugin',
      name: 'Debug Official Plugin',
      version: '0.0.1-debug',
      description: 'Synthetic allowlisted debug plugin used to validate the install workflow.',
      author: 'Open Resin Alliance',
      homepage: 'https://github.com/Open-Resin-Alliance/DragonFruit',
      printerPresets: [
        {
          presetId: 'debug.official.printer',
          manufacturer: 'ORA Debug',
          name: 'Official Debug Printer',
          buildVolumeMm: {
            width: 143,
            depth: 89,
            height: 175,
          },
          display: {
            resolutionX: 2560,
            resolutionY: 1620,
            outputFormat: 'nanodlp',
          },
        },
      ],
      materialTemplates: [
        {
          name: 'Official Debug Resin',
          brand: 'ORA Debug',
          currencyCode: 'USD',
          bottlePrice: 0,
          bottleCapacityMl: 1000,
          resinFamily: 'standard',
          scaleCompensationPct: {
            x: 0,
            y: 0,
            z: 0,
          },
          layerHeightMm: 0.05,
          normalExposureSec: 2.5,
          bottomExposureSec: 28,
          bottomLayerCount: 5,
          liftDistanceMm: 6,
          liftSpeedMmMin: 60,
          retractSpeedMmMin: 150,
        },
      ],
    };
  }

  return {
    schemaVersion: 1,
    id: 'debug-3rdparty-plugin',
    name: 'Debug 3rd-Party Plugin',
    version: '0.0.1-debug',
    description: 'Synthetic unverified debug plugin used to validate the liability-warning workflow.',
    author: 'Example Third Party',
    homepage: 'https://example.com/debug-plugin-3rd-party',
    printerPresets: [
      {
        presetId: 'debug.3rd.printer',
        manufacturer: 'Third-Party Debug',
        name: '3rd-Party Debug Printer',
        buildVolumeMm: {
          width: 130,
          depth: 80,
          height: 150,
        },
        display: {
          resolutionX: 1920,
          resolutionY: 1080,
          outputFormat: 'nanodlp',
        },
      },
    ],
    materialTemplates: [
      {
        name: '3rd-Party Debug Resin',
        brand: 'Example Vendor',
        currencyCode: 'USD',
        bottlePrice: 0,
        bottleCapacityMl: 1000,
        resinFamily: 'standard',
        scaleCompensationPct: {
          x: 0,
          y: 0,
          z: 0,
        },
        layerHeightMm: 0.05,
        normalExposureSec: 2.7,
        bottomExposureSec: 30,
        bottomLayerCount: 5,
        liftDistanceMm: 6,
        liftSpeedMmMin: 60,
        retractSpeedMmMin: 150,
      },
    ],
  };
}

function parseExpectedSha256(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim().toLowerCase();
  if (!trimmed) return null;
  if (!/^[a-f0-9]{64}$/.test(trimmed)) return null;
  return trimmed;
}

function computeSha256Hex(input: string): string {
  return createHash('sha256').update(input, 'utf8').digest('hex');
}

function parseGithubAllowlistRules(): GithubAllowlistRule[] {
  const rawConfig = (process.env.DRAGONFRUIT_PLUGIN_GITHUB_ALLOWLIST ?? DEFAULT_GITHUB_PLUGIN_ALLOWLIST)
    .trim();

  const entries = rawConfig
    .split(',')
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0);

  const rules: GithubAllowlistRule[] = [];
  for (const entry of entries) {
    if (entry === '*') {
      rules.push({ owner: '*', repo: '*' });
      continue;
    }

    const parts = entry.split('/').map((part) => part.trim().toLowerCase()).filter(Boolean);
    if (parts.length < 2) continue;
    const owner = parts[0];
    const repo = parts[1] === '*' ? '*' : parts[1];
    if (!owner) continue;
    rules.push({ owner, repo });
  }

  if (rules.length === 0) {
    return [{ owner: 'open-resin-alliance', repo: '*' }];
  }
  return rules;
}

function isGithubRepoAllowed(owner: string, repo: string, rules: GithubAllowlistRule[]): boolean {
  const ownerLower = owner.trim().toLowerCase();
  const repoLower = repo.trim().toLowerCase();
  if (!ownerLower || !repoLower) return false;

  return rules.some((rule) => {
    if (rule.owner === '*') return true;
    if (rule.owner !== ownerLower) return false;
    return rule.repo === '*' || rule.repo === repoLower;
  });
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

function sanitizeRelativeManifestPath(input: unknown): string | null {
  if (typeof input !== 'string') return null;
  const normalized = input.trim().replace(/^\/+/, '');
  if (!normalized) return null;
  if (normalized.includes('..') || normalized.includes('\\') || normalized.length > 240) return null;
  return normalized;
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

function guessImageMimeFromUrl(assetUrl: string): string {
  const lower = assetUrl.toLowerCase();
  if (lower.endsWith('.png')) return 'image/png';
  if (lower.endsWith('.jpg') || lower.endsWith('.jpeg')) return 'image/jpeg';
  if (lower.endsWith('.webp')) return 'image/webp';
  if (lower.endsWith('.gif')) return 'image/gif';
  if (lower.endsWith('.svg')) return 'image/svg+xml';
  if (lower.endsWith('.avif')) return 'image/avif';
  return 'application/octet-stream';
}

function normalizeImageMime(contentTypeHeader: string | null, assetUrl: string): string {
  const raw = (contentTypeHeader ?? '').split(';')[0]?.trim().toLowerCase();
  if (raw && raw.startsWith('image/')) return raw;
  return guessImageMimeFromUrl(assetUrl);
}

async function inlinePrinterPresetAssets<T extends { imageAssetPath?: string }>(
  presets: T[],
): Promise<T[]> {
  let budgetRemaining = MAX_INLINE_ASSET_BUDGET_BYTES;

  const transformed: T[] = [];
  for (const preset of presets) {
    const imageAssetPath = preset.imageAssetPath;
    if (!imageAssetPath || !/^https?:\/\//i.test(imageAssetPath)) {
      transformed.push(preset);
      continue;
    }

    if (budgetRemaining <= 0) {
      transformed.push(preset);
      continue;
    }

    try {
      const response = await fetch(imageAssetPath, {
        cache: 'no-store',
        signal: AbortSignal.timeout(8000),
      });

      if (!response.ok) {
        transformed.push(preset);
        continue;
      }

      const bytes = new Uint8Array(await response.arrayBuffer());
      if (bytes.length === 0 || bytes.length > MAX_INLINE_ASSET_BYTES || bytes.length > budgetRemaining) {
        transformed.push(preset);
        continue;
      }

      const mime = normalizeImageMime(response.headers.get('content-type'), imageAssetPath);
      const encoded = Buffer.from(bytes).toString('base64');
      budgetRemaining -= bytes.length;

      transformed.push({
        ...preset,
        imageAssetPath: `data:${mime};base64,${encoded}`,
      });
    } catch {
      transformed.push(preset);
    }
  }

  return transformed;
}

async function sanitizeManifest(manifest: any, baseRawDir: string) {
  const value = (manifest ?? {}) as any;

  const inlinePrinterPresetEntries: Array<{ preset: unknown; baseRawDir: string }> = Array.isArray(value.printerPresets)
    ? value.printerPresets.map((preset: unknown) => ({ preset, baseRawDir }))
    : [];

  const presetPathEntries: string[] = Array.isArray(value.printerPresetPaths)
    ? value.printerPresetPaths
        .map((entry: unknown) => sanitizeRelativeManifestPath(entry))
        .filter((entry: string | null): entry is string => entry !== null)
        .slice(0, 64)
    : [];

  const fetchedPrinterPresetEntries = await Promise.all(
    presetPathEntries.map(async (relativePath: string) => {
      const rawUrl = `${baseRawDir}/${relativePath}`;
      const sourceBaseRawDir = rawUrl.includes('/')
        ? rawUrl.slice(0, rawUrl.lastIndexOf('/'))
        : baseRawDir;
      try {
        const response = await fetch(rawUrl, {
          headers: {
            Accept: 'application/json',
          },
          cache: 'no-store',
          signal: AbortSignal.timeout(9000),
        });

        if (!response.ok) return [] as Array<{ preset: unknown; baseRawDir: string }>;
        const payload = await response.json().catch(() => null) as unknown;

        if (Array.isArray(payload)) {
          return payload.map((preset: unknown) => ({ preset, baseRawDir: sourceBaseRawDir }));
        }
        if (payload && typeof payload === 'object' && Array.isArray((payload as any).printerPresets)) {
          return ((payload as any).printerPresets as unknown[])
            .map((preset: unknown) => ({ preset, baseRawDir: sourceBaseRawDir }));
        }
      } catch {
        // Ignore preset-source fetch failures and continue with remaining sources.
      }

      return [] as Array<{ preset: unknown; baseRawDir: string }>;
    }),
  );

  const combinedPrinterPresetEntries = [
    ...inlinePrinterPresetEntries,
    ...fetchedPrinterPresetEntries.flat(),
  ];

  const sanitizedPrinterPresets = Array.isArray(combinedPrinterPresetEntries)
    ? combinedPrinterPresetEntries
      .slice(0, MAX_PRINTER_PRESETS)
      .map((entry) => sanitizePrinterPreset(entry.preset, entry.baseRawDir))
      .filter((preset: ReturnType<typeof sanitizePrinterPreset>): preset is NonNullable<ReturnType<typeof sanitizePrinterPreset>> => preset !== null)
    : [];

  const offlineReadyPrinterPresets = await inlinePrinterPresetAssets(sanitizedPrinterPresets);

  const sanitizedMaterialTemplates = Array.isArray(value.materialTemplates)
    ? value.materialTemplates
      .slice(0, MAX_MATERIAL_TEMPLATES)
      .map((template: unknown) => sanitizeMaterialTemplate(template))
      .filter((template: ReturnType<typeof sanitizeMaterialTemplate>): template is NonNullable<ReturnType<typeof sanitizeMaterialTemplate>> => template !== null)
    : [];

  const inlineMaterialPresetEntries: unknown[] = Array.isArray(value.materialPresets)
    ? value.materialPresets
    : [];

  const materialPresetPathEntries: string[] = Array.isArray(value.materialPresetPaths)
    ? value.materialPresetPaths
      .map((entry: unknown) => sanitizeRelativeManifestPath(entry))
      .filter((entry: string | null): entry is string => entry !== null)
      .slice(0, 64)
    : [];

  const fetchedMaterialPresetEntries = await Promise.all(
    materialPresetPathEntries.map(async (relativePath: string) => {
      const rawUrl = `${baseRawDir}/${relativePath}`;
      try {
        const response = await fetch(rawUrl, {
          headers: {
            Accept: 'application/json',
          },
          cache: 'no-store',
          signal: AbortSignal.timeout(9000),
        });

        if (!response.ok) return [] as unknown[];
        const payload = await response.json().catch(() => null) as unknown;

        if (Array.isArray(payload)) return payload;
        if (payload && typeof payload === 'object' && Array.isArray((payload as any).materialPresets)) {
          return (payload as any).materialPresets as unknown[];
        }
        if (payload && typeof payload === 'object') {
          return [payload];
        }
      } catch {
        // Ignore preset-source fetch failures and continue with remaining sources.
      }

      return [] as unknown[];
    }),
  );

  const combinedMaterialPresetEntries = [
    ...inlineMaterialPresetEntries,
    ...fetchedMaterialPresetEntries.flat(),
  ];

  const sanitizedMaterialPresets = combinedMaterialPresetEntries
    .slice(0, MAX_MATERIAL_PRESETS)
    .map((preset: unknown) => sanitizeMaterialPreset(preset))
    .filter((preset: ReturnType<typeof sanitizeMaterialPreset>): preset is NonNullable<ReturnType<typeof sanitizeMaterialPreset>> => preset !== null);

  const sanitized = {
    schemaVersion: Number.isFinite(Number(value.schemaVersion)) ? Number(value.schemaVersion) : 1,
    id: boundedString(value.id, 120),
    name: boundedString(value.name, 120),
    version: boundedString(value.version, 48),
    description: boundedString(value.description, 500) || undefined,
    author: boundedString(value.author, 120) || undefined,
    homepage: optionalHttpUrl(value.homepage),
    printerPresets: offlineReadyPrinterPresets,
    materialTemplates: sanitizedMaterialTemplates,
    materialPresets: sanitizedMaterialPresets,
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
  const allowUnverifiedInstall = (payload as any)?.allowUnverifiedInstall === true;
  const acknowledgeLiabilityWarning = (payload as any)?.acknowledgeLiabilityWarning === true;
  const debugPluginKind = parseDebugPluginKind(repoUrl);
  const manifestPath = typeof (payload as any)?.manifestPath === 'string' && (payload as any).manifestPath.trim().length > 0
    ? (payload as any).manifestPath.trim().replace(/^\/+/, '')
    : 'dragonfruit-plugin.json';

  if (manifestPath.includes('..') || manifestPath.includes('\\') || manifestPath.length > 240) {
    return NextResponse.json({ ok: false, error: 'Invalid manifest path' }, { status: 400 });
  }

  if (debugPluginKind) {
    const debugAllowlistRules = ['open-resin-alliance/*'];
    const isOfficialDebug = debugPluginKind === 'official';

    if (!isOfficialDebug && !(allowUnverifiedInstall && acknowledgeLiabilityWarning)) {
      return NextResponse.json({
        ok: false,
        error: 'Debug 3rd-party plugin is intentionally unverified and requires liability acknowledgement.',
        requiresLiabilityWarning: true,
        unverifiedRepo: {
          owner: 'debug',
          name: 'plugin-3rd-party',
        },
        allowlistRules: debugAllowlistRules,
      }, { status: 403 });
    }

    const manifest = buildDebugPluginManifest(debugPluginKind);
    const manifestSha256 = computeSha256Hex(JSON.stringify(manifest));

    return NextResponse.json({
      ok: true,
      repo: {
        owner: isOfficialDebug ? 'open-resin-alliance' : 'debug',
        name: isOfficialDebug ? 'debug-plugin-official' : 'plugin-3rd-party',
        branch: 'debug',
      },
      repoAllowlisted: isOfficialDebug,
      manifestSha256,
      allowlistRules: debugAllowlistRules,
      rawManifestUrl: repoUrl,
      manifest,
    });
  }

  const repoRef = parseGithubRepoUrl(repoUrl);
  if (!repoRef) {
    return NextResponse.json({ ok: false, error: 'Invalid GitHub repository URL' }, { status: 400 });
  }

  const allowlistRules = parseGithubAllowlistRules();
  const isAllowlistedRepo = isGithubRepoAllowed(repoRef.owner, repoRef.repo, allowlistRules);
  if (!isAllowlistedRepo && !(allowUnverifiedInstall && acknowledgeLiabilityWarning)) {
    return NextResponse.json({
      ok: false,
      error: `Repository is not in the plugin allowlist: ${repoRef.owner}/${repoRef.repo}`,
      requiresLiabilityWarning: true,
      unverifiedRepo: {
        owner: repoRef.owner,
        name: repoRef.repo,
      },
      allowlistRules: allowlistRules.map((rule) => `${rule.owner}/${rule.repo}`),
    }, { status: 403 });
  }

  const expectedManifestSha256 = parseExpectedSha256((payload as any)?.expectedManifestSha256);
  if ((payload as any)?.expectedManifestSha256 != null && !expectedManifestSha256) {
    return NextResponse.json({
      ok: false,
      error: 'Invalid expectedManifestSha256 (must be 64-char lowercase hex).',
    }, { status: 400 });
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

    const manifestText = await response.text();
    const manifestSha256 = computeSha256Hex(manifestText);

    if (expectedManifestSha256 && manifestSha256 !== expectedManifestSha256) {
      return NextResponse.json({
        ok: false,
        error: 'Manifest hash mismatch.',
        rawManifestUrl,
        expectedManifestSha256,
        manifestSha256,
      }, { status: 409 });
    }

    let manifestPayload: unknown;
    try {
      manifestPayload = JSON.parse(manifestText) as unknown;
    } catch {
      manifestPayload = null;
    }
    if (!manifestPayload || typeof manifestPayload !== 'object') {
      return NextResponse.json({ ok: false, error: 'Manifest is not valid JSON', rawManifestUrl }, { status: 400 });
    }

    const baseRawDir = rawManifestUrl.slice(0, rawManifestUrl.lastIndexOf('/'));
    const manifest = await sanitizeManifest(manifestPayload, baseRawDir);

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
      repoAllowlisted: isAllowlistedRepo,
      manifestSha256,
      allowlistRules: allowlistRules.map((rule) => `${rule.owner}/${rule.repo}`),
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
