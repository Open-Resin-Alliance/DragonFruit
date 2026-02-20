import os from 'os';
import {
  buildNanoDlpBaseUrl,
  fetchNanoDlpStatus,
  parseNanoDlpHostAndPort,
  resolveNanoDlpPort,
  resolveNanoDlpPrinterName,
  resolveNanoDlpRawHost,
  resolveNanoDlpResolvedAddress,
  resolveNanoDlpStatusHostName,
} from './nanodlp';

/**
 * Athena-owned NanoDLP network operation handlers.
 *
 * These handlers keep NanoDLP-specific protocol behavior inside the plugin,
 * while core API routes simply dispatch requests to registered plugin handlers.
 */

type HandlerResult = {
  status: number;
  body: unknown;
};

type NanoDlpDiscoveredDevice = {
  ipAddress: string;
  port: number;
  hostName: string;
  printerName: string;
  statusText: string;
  state: string;
  firmwareVersion: string;
};

type DiscoveryScope = 'all' | 'local-hostnames' | 'subnet';

const DEFAULT_LOCAL_HOSTNAMES = ['nanodlp.local', 'athena.local', 'printer.local', 'resin.local'];

type NanoDlpRawProfile = Record<string, unknown>;

/**
 * Resolve local IPv4 subnet prefixes from host network interfaces.
 */

function getLocalSubnetPrefixes(): string[] {
  const interfaces = os.networkInterfaces();
  const prefixes = new Set<string>();

  for (const values of Object.values(interfaces)) {
    for (const value of values ?? []) {
      const family = String((value as { family?: unknown }).family ?? '');
      const isIpv4 = family === 'IPv4' || family === '4';
      if (!isIpv4) continue;
      if (value.internal) continue;

      const parts = value.address.split('.');
      if (parts.length !== 4) continue;
      prefixes.add(`${parts[0]}.${parts[1]}.${parts[2]}`);
    }
  }

  return Array.from(prefixes);
}

/**
 * Expand one or more `/24` prefixes (for example `192.168.2`) to host
 * candidates from `.1` through `.254`.
 */
function buildIpCandidatesFromPrefixes(prefixes: string[]): string[] {
  const all: string[] = [];

  for (const prefix of prefixes) {
    for (let host = 1; host <= 254; host += 1) {
      all.push(`${prefix}.${host}`);
    }
  }

  return all;
}

function buildIpCandidates(forcedHost: string | null): string[] {
  if (forcedHost) return [forcedHost];

  const prefixes = getLocalSubnetPrefixes();
  return buildIpCandidatesFromPrefixes(prefixes);
}

function normalizeHostnameCandidates(values: unknown): string[] {
  if (!Array.isArray(values)) return [];

  const deduped = new Set<string>();
  for (const value of values) {
    if (typeof value !== 'string') continue;
    const trimmed = value.trim().toLowerCase();
    if (!trimmed) continue;
    if (!trimmed.endsWith('.local')) continue;
    deduped.add(trimmed);
  }

  return Array.from(deduped).slice(0, 24);
}

function isPlainIpv4(value: string): boolean {
  const parts = value.split('.');
  if (parts.length !== 4) return false;
  return parts.every((part) => {
    if (!/^\d{1,3}$/.test(part)) return false;
    const numeric = Number(part);
    return Number.isFinite(numeric) && numeric >= 0 && numeric <= 255;
  });
}

/**
 * Normalize arbitrary payload arrays into clean, deduped IPv4 candidates.
 */
function normalizeIpv4Candidates(values: unknown): string[] {
  if (!Array.isArray(values)) return [];

  const deduped = new Set<string>();
  for (const value of values) {
    if (typeof value !== 'string') continue;
    const trimmed = value.trim();
    if (!isPlainIpv4(trimmed)) continue;
    deduped.add(trimmed);
  }

  return Array.from(deduped);
}

/**
 * Derive `/24` prefix from a validated IPv4 address.
 */
function toSubnetPrefix(ipAddress: string): string | null {
  if (!isPlainIpv4(ipAddress)) return null;
  const [a, b, c] = ipAddress.split('.');
  return `${a}.${b}.${c}`;
}

async function probeNanoDlp(hostOrIp: string, port: number, timeoutMs: number = 5000): Promise<NanoDlpDiscoveredDevice | null> {
  try {
    const status = await fetchNanoDlpStatus(hostOrIp, port, timeoutMs);
    if (!status) return null;

    const hostName = resolveNanoDlpStatusHostName(status);
    const printerName = resolveNanoDlpPrinterName(status);
    const resolvedAddress = resolveNanoDlpResolvedAddress(status, hostOrIp);

    return {
      ipAddress: resolvedAddress,
      port,
      hostName,
      printerName,
      statusText: typeof status.Status === 'string' ? status.Status : 'Online',
      state: typeof status.State === 'string' ? status.State : '',
      firmwareVersion: status.Version != null ? String(status.Version) : '',
    };
  } catch {
    return null;
  }
}

function clampNumber(value: unknown, fallback: number, min: number, max: number): number {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) return fallback;
  return Math.max(min, Math.min(max, Math.round(numeric)));
}

async function runWithConcurrency<T, R>(items: T[], limit: number, worker: (item: T) => Promise<R | null>): Promise<R[]> {
  const results: R[] = [];
  let index = 0;

  const runners = Array.from({ length: Math.max(1, limit) }, async () => {
    while (index < items.length) {
      const currentIndex = index;
      index += 1;

      const result = await worker(items[currentIndex]);
      if (result) results.push(result);
    }
  });

  await Promise.all(runners);
  return results;
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
  const candidates = [raw.profileId, raw.ProfileID, raw.ProfileId, raw.id, raw.ID, raw.Path, raw.path, raw.File, raw.file, raw.name, raw.Name];

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

async function handleNanoDlpConnect(payload: unknown): Promise<HandlerResult> {
  const rawHost = resolveNanoDlpRawHost(payload);
  const parsedHost = parseNanoDlpHostAndPort(rawHost);
  if (!parsedHost) {
    return { status: 400, body: { error: 'Invalid host or IP address' } };
  }

  const port = resolveNanoDlpPort((payload as any)?.port, parsedHost.port);

  try {
    const status = await fetchNanoDlpStatus(parsedHost.host, port, 5000);
    if (!status) {
      return {
        status: 200,
        body: {
          connected: false,
          mode: 'nanodlp',
          hostName: '',
          printerName: '',
          ipAddress: parsedHost.host,
          port,
          statusText: 'NanoDLP host unreachable or invalid status payload',
          state: '',
          firmwareVersion: '',
        },
      };
    }

    const hostName = resolveNanoDlpStatusHostName(status);
    const printerName = resolveNanoDlpPrinterName(status);
    const resolvedAddress = resolveNanoDlpResolvedAddress(status, parsedHost.host);

    return {
      status: 200,
      body: {
        connected: true,
        mode: 'nanodlp',
        hostName,
        printerName,
        ipAddress: resolvedAddress,
        port,
        statusText: typeof status.Status === 'string' ? status.Status : 'Online',
        state: typeof status.State === 'string' ? status.State : '',
        firmwareVersion: status.Version != null ? String(status.Version) : '',
      },
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unable to reach NanoDLP host';
    return {
      status: 200,
      body: {
        connected: false,
        mode: 'nanodlp',
        hostName: '',
        printerName: '',
        ipAddress: parsedHost.host,
        port,
        statusText: message,
        state: '',
        firmwareVersion: '',
      },
    };
  }
}

async function handleNanoDlpDiscover(payload: unknown): Promise<HandlerResult> {
  // NanoDLP discovery supports optional mode filtering for future extensibility.
  const mode = (payload as any)?.mode;
  if (mode && mode !== 'nanodlp') {
    return { status: 400, body: { error: 'Unsupported network mode' } };
  }

  const scopeRaw = (payload as any)?.scanScope;
  const scanScope: DiscoveryScope = scopeRaw === 'local-hostnames' || scopeRaw === 'subnet' || scopeRaw === 'all'
    ? scopeRaw
    : 'all';

  const rawHost = resolveNanoDlpRawHost(payload);
  const forcedHostParsed = rawHost.trim().length > 0 ? parseNanoDlpHostAndPort(rawHost) : null;
  const forcedHost = forcedHostParsed?.host ?? null;
  const forcedHostIsIpv4 = forcedHost ? isPlainIpv4(forcedHost) : false;

  const portsInput = Array.isArray((payload as any)?.ports) ? (payload as any).ports : [80, 8080];
  const ports: number[] = portsInput
    .map((value: unknown) => resolveNanoDlpPort(value, -1))
    .filter((value: number) => value >= 1 && value <= 65535)
    .slice(0, 4);

  const targetPorts: number[] = ports.length > 0 ? Array.from(new Set<number>(ports)) : [80, 8080];
  const payloadLocalHostnames = normalizeHostnameCandidates((payload as any)?.localHostnames);
  const localHostCandidates = Array.from(new Set([
    ...(forcedHost && forcedHost.endsWith('.local') ? [forcedHost] : []),
    ...payloadLocalHostnames,
    ...DEFAULT_LOCAL_HOSTNAMES,
  ])).slice(0, 24);

  const localTargets: Array<{ host: string; port: number }> = [];
  const shouldScanLocalHostnames = scanScope === 'all' || scanScope === 'local-hostnames';
  if (shouldScanLocalHostnames) {
    for (const host of localHostCandidates) {
      for (const port of targetPorts) {
        localTargets.push({ host, port });
      }
    }
  }

  const subnetHostCandidates = (scanScope === 'all' || scanScope === 'subnet')
    ? buildIpCandidates(forcedHostIsIpv4 ? forcedHost : null)
    : [];

  const excludedHosts = normalizeHostnameCandidates((payload as any)?.excludeHosts)
    .concat(normalizeIpv4Candidates((payload as any)?.excludeHosts));
  const excludedHostSet = new Set(excludedHosts);

  let effectiveSubnetHostCandidates = subnetHostCandidates;

  // Fallback for environments where `os.networkInterfaces()` yields no usable
  // IPv4 subnet prefixes: derive candidate subnets from known/seed IPs.
  if (effectiveSubnetHostCandidates.length === 0 && (scanScope === 'all' || scanScope === 'subnet')) {
    const ipv4Seeds = new Set<string>([
      ...(forcedHostIsIpv4 && forcedHost ? [forcedHost] : []),
      ...normalizeIpv4Candidates((payload as any)?.excludeHosts),
      ...normalizeIpv4Candidates((payload as any)?.seedIps),
    ]);

    const derivedPrefixes = Array.from(ipv4Seeds)
      .map((ipAddress) => toSubnetPrefix(ipAddress))
      .filter((prefix): prefix is string => Boolean(prefix));

    if (derivedPrefixes.length > 0) {
      effectiveSubnetHostCandidates = buildIpCandidatesFromPrefixes(derivedPrefixes);
    }
  }

  const subnetTargets: Array<{ ipAddress: string; port: number }> = [];
  for (const ipAddress of effectiveSubnetHostCandidates) {
    if (excludedHostSet.has(ipAddress)) continue;
    for (const port of targetPorts) {
      subnetTargets.push({ ipAddress, port });
    }
  }

  const progressive = (payload as any)?.progressive === true;
  const probeTimeoutMs = clampNumber((payload as any)?.probeTimeoutMs, 1200, 350, 8000);
  const localConcurrency = clampNumber((payload as any)?.localConcurrency, forcedHost ? 8 : 20, 4, 64);
  const subnetConcurrency = clampNumber((payload as any)?.subnetConcurrency, forcedHost ? 12 : 84, 8, 160);
  const requestedBatchStart = clampNumber((payload as any)?.batchStart, 0, 0, Number.MAX_SAFE_INTEGER);
  const requestedBatchSize = clampNumber((payload as any)?.batchSize, 96, 8, 256);

  const foundByAddress = new Map<string, NanoDlpDiscoveredDevice>();

  if (localTargets.length > 0) {
    await runWithConcurrency(localTargets, localConcurrency, async (target) => {
      const result = await probeNanoDlp(target.host, target.port, Math.max(probeTimeoutMs, 1500));
      if (!result) return null;
      if (foundByAddress.has(result.ipAddress)) return null;
      foundByAddress.set(result.ipAddress, result);
      return result;
    });
  }

  if (progressive && scanScope === 'subnet') {
    const totalEndpoints = subnetTargets.length;
    const batchStart = Math.min(requestedBatchStart, totalEndpoints);
    const batchEnd = Math.min(totalEndpoints, batchStart + requestedBatchSize);
    const batchTargets = subnetTargets.slice(batchStart, batchEnd);

    await runWithConcurrency(batchTargets, subnetConcurrency, async (target) => {
      const result = await probeNanoDlp(target.ipAddress, target.port, probeTimeoutMs);
      if (!result) return null;
      if (foundByAddress.has(result.ipAddress)) return null;
      foundByAddress.set(result.ipAddress, result);
      return result;
    });

    return {
      status: 200,
      body: {
        mode: 'nanodlp',
        devices: Array.from(foundByAddress.values()),
        scannedHosts: effectiveSubnetHostCandidates.length,
        scannedEndpoints: batchEnd,
        scannedLocalHostnames: 0,
        scannedSubnetHosts: effectiveSubnetHostCandidates.length,
        scanScope,
        progressive: true,
        totalEndpoints,
        batchStart,
        batchSize: batchTargets.length,
        nextBatchStart: batchEnd,
        done: batchEnd >= totalEndpoints,
      },
    };
  }

  if (subnetTargets.length > 0) {
    await runWithConcurrency(subnetTargets, subnetConcurrency, async (target) => {
      if (foundByAddress.has(target.ipAddress)) return null;
      const result = await probeNanoDlp(target.ipAddress, target.port, probeTimeoutMs);
      if (!result) return null;

      if (!foundByAddress.has(result.ipAddress)) {
        foundByAddress.set(result.ipAddress, result);
        return result;
      }

      return null;
    });
  }

  return {
    status: 200,
    body: {
      mode: 'nanodlp',
      devices: Array.from(foundByAddress.values()),
      scannedHosts: localHostCandidates.length + effectiveSubnetHostCandidates.length,
      scannedEndpoints: localTargets.length + subnetTargets.length,
      scannedLocalHostnames: localHostCandidates.length,
      scannedSubnetHosts: effectiveSubnetHostCandidates.length,
      scanScope,
    },
  };
}

async function handleNanoDlpMaterials(payload: unknown): Promise<HandlerResult> {
  const rawHost = resolveNanoDlpRawHost(payload);
  const parsedHost = parseNanoDlpHostAndPort(rawHost);
  if (!parsedHost) {
    return { status: 400, body: { error: 'Invalid host or IP address' } };
  }

  const port = resolveNanoDlpPort((payload as any)?.port, parsedHost.port);
  const baseUrl = buildNanoDlpBaseUrl(parsedHost.host, port);

  try {
    const response = await fetch(`${baseUrl}/json/db/profiles.json`, {
      method: 'GET',
      headers: { Accept: 'application/json' },
      cache: 'no-store',
      signal: AbortSignal.timeout(10000),
    });

    if (response.status !== 200) {
      return {
        status: 200,
        body: {
          ipAddress: parsedHost.host,
          port,
          materials: [],
          error: `HTTP ${response.status}`,
        },
      };
    }

    const decoded = await response.json().catch(() => null);
    if (!decoded) {
      return {
        status: 200,
        body: {
          ipAddress: parsedHost.host,
          port,
          materials: [],
          error: 'Invalid JSON payload',
        },
      };
    }

    const entries = extractListFromJson(decoded, ['profiles', 'data']);
    const seen = new Set<string>();
    const materials: Array<{ id: string; name: string; locked: boolean; meta: NanoDlpRawProfile }> = [];

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

      materials.push({ id, name, locked, meta: mergedMeta });
      seen.add(id);
    }

    return {
      status: 200,
      body: {
        ipAddress: parsedHost.host,
        port,
        materials,
      },
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Failed to fetch NanoDLP materials';
    return {
      status: 200,
      body: {
        ipAddress: parsedHost.host,
        port,
        materials: [],
        error: message,
      },
    };
  }
}

async function handleNanoDlpMaterialsEdit(payload: unknown): Promise<HandlerResult> {
  const rawHost = resolveNanoDlpRawHost(payload);
  const parsedHost = parseNanoDlpHostAndPort(rawHost);
  if (!parsedHost) {
    return { status: 400, body: { ok: false, error: 'Invalid host or IP address' } };
  }

  const profileIdRaw = Number((payload as any)?.profileId);
  if (!Number.isFinite(profileIdRaw) || profileIdRaw <= 0) {
    return { status: 400, body: { ok: false, error: 'Invalid profileId' } };
  }

  const port = resolveNanoDlpPort((payload as any)?.port, parsedHost.port);
  const fieldsRaw = (payload as any)?.fields;
  if (!fieldsRaw || typeof fieldsRaw !== 'object') {
    return { status: 400, body: { ok: false, error: 'Missing fields payload' } };
  }

  const fields = fieldsRaw as Record<string, unknown>;
  const body = new URLSearchParams();
  for (const [key, value] of Object.entries(fields)) {
    if (value == null) continue;
    body.set(key, String(value));
  }

  const baseUrl = buildNanoDlpBaseUrl(parsedHost.host, port);

  try {
    const response = await fetch(`${baseUrl}/profile/edit/simple/${Math.round(profileIdRaw)}`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      body: body.toString(),
      cache: 'no-store',
      signal: AbortSignal.timeout(15000),
    });

    const responseText = await response.text().catch(() => '');
    const responseJson = (() => {
      if (!responseText) return null;
      try {
        return JSON.parse(responseText) as unknown;
      } catch {
        return null;
      }
    })();

    if (response.status !== 200 && response.status !== 201) {
      return {
        status: 502,
        body: {
          ok: false,
          ipAddress: parsedHost.host,
          port,
          status: response.status,
          error: `HTTP ${response.status}`,
          response: responseJson ?? responseText,
        },
      };
    }

    return {
      status: 200,
      body: {
        ok: true,
        ipAddress: parsedHost.host,
        port,
        profileId: Math.round(profileIdRaw),
        response: responseJson ?? responseText,
      },
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Failed to edit NanoDLP profile';
    return {
      status: 500,
      body: {
        ok: false,
        ipAddress: parsedHost.host,
        port,
        error: message,
      },
    };
  }
}

export async function handleAthenaNetworkOperation(operationPath: string[], payload: unknown): Promise<HandlerResult> {
  // Athena currently exposes NanoDLP operations under `nanodlp/*`.
  if (operationPath.length === 0 || operationPath[0] !== 'nanodlp') {
    return { status: 404, body: { error: 'Unknown Athena network operation' } };
  }

  // Operation routing is string-based to keep payload contracts simple and
  // compatible with the generic plugin network route dispatcher.
  const op = operationPath.slice(1).join('/');

  if (op === 'connect') return handleNanoDlpConnect(payload);
  if (op === 'discover') return handleNanoDlpDiscover(payload);
  if (op === 'materials') return handleNanoDlpMaterials(payload);
  if (op === 'materials/edit') return handleNanoDlpMaterialsEdit(payload);

  return { status: 404, body: { error: 'Unknown Athena NanoDLP operation' } };
}