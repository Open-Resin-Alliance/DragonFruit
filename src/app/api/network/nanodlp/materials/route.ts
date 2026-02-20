import { NextResponse } from 'next/server';

type NanoDlpRawProfile = Record<string, unknown>;

type NanoDlpMaterialEntry = {
  id: string;
  name: string;
  locked: boolean;
  meta: NanoDlpRawProfile;
};

function parseHostAndPort(input: string): { host: string; port: number } | null {
  const trimmed = input.trim();
  if (!trimmed) return null;

  try {
    const normalized = /^https?:\/\//i.test(trimmed) ? trimmed : `http://${trimmed}`;
    const parsed = new URL(normalized);
    if (!['http:', 'https:'].includes(parsed.protocol)) return null;

    const host = parsed.hostname.trim();
    if (!host) return null;

    const port = parsed.port ? Number(parsed.port) : 80;
    if (!Number.isFinite(port) || port < 1 || port > 65535) return null;

    return { host, port };
  } catch {
    return null;
  }
}

function buildBaseUrl(host: string, port: number): string {
  return `http://${host}${port === 80 ? '' : `:${port}`}`;
}

function extractListFromJson(decoded: unknown, keys: string[]): unknown[] {
  if (Array.isArray(decoded)) return decoded;

  if (decoded && typeof decoded === 'object') {
    const objectValue = decoded as Record<string, unknown>;

    for (const key of keys) {
      const value = objectValue[key];
      if (Array.isArray(value)) return value;
    }

    const firstArray = Object.values(objectValue).find((value) => Array.isArray(value));
    if (Array.isArray(firstArray)) return firstArray;

    return [objectValue];
  }

  return [];
}

function resolveProfileId(raw: NanoDlpRawProfile): string | null {
  const candidates = [
    raw.profileId,
    raw.ProfileID,
    raw.ProfileId,
    raw.id,
    raw.ID,
    raw.Path,
    raw.path,
    raw.File,
    raw.file,
    raw.name,
    raw.Name,
  ];

  for (const value of candidates) {
    if (value == null) continue;
    const normalized = String(value).trim();
    if (normalized.length > 0) return normalized;
  }

  return null;
}

function friendlyNameFromPath(pathValue: string): string | null {
  const normalized = pathValue.trim();
  if (!normalized) return null;

  const parts = normalized.split('/');
  const tail = parts[parts.length - 1] || normalized;
  const withoutExtension = tail.replace(/\.[a-z0-9]+$/i, '');
  const spaced = withoutExtension.replace(/[_\-]+/g, ' ').trim();
  return spaced.length > 0 ? spaced : null;
}

function resolveProfileName(raw: NanoDlpRawProfile): string {
  const candidates = [
    raw.display_name,
    raw.DisplayName,
    raw.label,
    raw.Label,
    raw.title,
    raw.Title,
    raw.desc,
    raw.Desc,
    raw.Description,
    raw.ProfileName,
    raw.profileName,
    raw.MaterialName,
    raw.materialName,
    raw.ResinName,
    raw.resinName,
    raw.name,
    raw.Name,
  ];

  for (const value of candidates) {
    if (typeof value === 'string' && value.trim().length > 0) {
      return value.trim();
    }
  }

  const pathCandidates = [raw.Path, raw.path, raw.File, raw.file];
  for (const value of pathCandidates) {
    if (typeof value !== 'string') continue;
    const derived = friendlyNameFromPath(value);
    if (derived) return derived;
  }

  return 'Unknown Resin Profile';
}

function detectLockedProfile(name: string, raw: NanoDlpRawProfile): boolean {
  if (typeof raw.locked === 'boolean') return raw.locked;
  const shortBracketPrefix = /^\[([A-Z]{2,5})\]\s*/;
  return shortBracketPrefix.test(name);
}

export async function POST(request: Request) {
  let payload: unknown;
  try {
    payload = await request.json();
  } catch {
    return NextResponse.json({ error: 'Invalid request JSON' }, { status: 400 });
  }

  const rawHost = typeof (payload as any)?.host === 'string'
    ? (payload as any).host
    : typeof (payload as any)?.ipAddress === 'string'
      ? (payload as any).ipAddress
      : '';

  const parsedHost = parseHostAndPort(rawHost);
  if (!parsedHost) {
    return NextResponse.json({ error: 'Invalid host or IP address' }, { status: 400 });
  }

  const explicitPort = Number((payload as any)?.port);
  const port = Number.isFinite(explicitPort) && explicitPort >= 1 && explicitPort <= 65535
    ? explicitPort
    : parsedHost.port;

  const baseUrl = buildBaseUrl(parsedHost.host, port);

  try {
    const response = await fetch(`${baseUrl}/json/db/profiles.json`, {
      method: 'GET',
      headers: {
        Accept: 'application/json',
      },
      cache: 'no-store',
      signal: AbortSignal.timeout(10000),
    });

    if (response.status !== 200) {
      return NextResponse.json({
        ipAddress: parsedHost.host,
        port,
        materials: [],
        error: `HTTP ${response.status}`,
      });
    }

    const decoded = await response.json().catch(() => null);
    if (!decoded) {
      return NextResponse.json({
        ipAddress: parsedHost.host,
        port,
        materials: [],
        error: 'Invalid JSON payload',
      });
    }

    const entries = extractListFromJson(decoded, ['profiles', 'data']);

    const seen = new Set<string>();
    const materials: NanoDlpMaterialEntry[] = [];

    for (const entry of entries) {
      if (!entry || typeof entry !== 'object') continue;

      const raw = entry as NanoDlpRawProfile;
      const customValues = (raw as any).CustomValues;
      const mergedMeta: NanoDlpRawProfile = {
        ...raw,
        ...(customValues && typeof customValues === 'object' ? customValues as Record<string, unknown> : {}),
      };

      const id = resolveProfileId(mergedMeta);
      if (!id || seen.has(id)) continue;

      const name = resolveProfileName(mergedMeta);
      const locked = detectLockedProfile(name, mergedMeta);

      materials.push({
        id,
        name,
        locked,
        meta: mergedMeta,
      });

      seen.add(id);
    }

    return NextResponse.json({
      ipAddress: parsedHost.host,
      port,
      materials,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Failed to fetch NanoDLP materials';
    return NextResponse.json({
      ipAddress: parsedHost.host,
      port,
      materials: [],
      error: message,
    });
  }
}
