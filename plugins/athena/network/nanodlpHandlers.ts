import os from 'os';
import { readFile } from 'fs/promises';
import {
  buildNanoDlpBaseUrl,
  fetchNanoDlpStatus,
  parseNanoDlpHostAndPort,
  resolveNanoDlpPort,
  resolveNanoDlpPrinterModel,
  resolveNanoDlpPrinterName,
  resolveNanoDlpRawHost,
  resolveNanoDlpResolvedAddress,
  type SupportedAthenaModel,
  resolveSupportedAthenaModel,
  resolveNanoDlpStatusHostName,
} from './nanodlp';
import { dispatchNanoDlpOperation } from './handlers';
import athenaPrinters from '../printers/printers.json';

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
  printerModel: string;
  statusText: string;
  state: string;
  firmwareVersion: string;
};

type DiscoveryScope = 'all' | 'local-hostnames' | 'subnet';

const DEFAULT_LOCAL_HOSTNAMES = ['nanodlp.local', 'athena.local', 'printer.local', 'resin.local'];

type NanoDlpRawProfile = Record<string, unknown>;
type AthenaPrinterPresetRow = {
  networkSupport?: unknown;
  networkFilter?: unknown;
};

const ATHENA_NETWORK_FILTERS = Array.from(new Set(
  (athenaPrinters as AthenaPrinterPresetRow[])
    .filter((preset) => preset?.networkSupport === 'nanodlp')
    .map((preset) => (typeof preset?.networkFilter === 'string' ? preset.networkFilter.trim() : ''))
    .filter((value) => value.length > 0),
));

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

function normalizeSupportedAthenaModelHint(value: unknown): SupportedAthenaModel | null {
  if (typeof value !== 'string') return null;

  const normalized = value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();

  if (!normalized) return null;
  if (/\bathena\s*2\b/.test(normalized) || normalized.includes('athena2')) return 'athena-2';
  if (normalized.includes('athena')) return 'athena';
  return null;
}

function isSupportedAthenaModelMatch(
  supportedModel: SupportedAthenaModel,
  requestedModelHint: SupportedAthenaModel | null,
): boolean {
  if (!requestedModelHint) return true;
  return supportedModel === requestedModelHint;
}

function normalizeMachineName(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function isNanoDlpFilterDebugEnabled(payload: unknown, requestedNetworkFilter: string | null): boolean {
  if (typeof (payload as any)?.suppressNetworkFilterDebug === 'boolean') {
    return !(payload as any).suppressNetworkFilterDebug;
  }
  if (typeof (payload as any)?.debugNetworkFilter === 'boolean') return (payload as any).debugNetworkFilter;
  if (typeof (payload as any)?.debugDiscovery === 'boolean') return (payload as any).debugDiscovery;
  if (requestedNetworkFilter && requestedNetworkFilter.trim().length > 0) return true;
  return true;
}

function logNanoDlpFilterDebug(enabled: boolean, scope: string, details: Record<string, unknown>): void {
  if (!enabled) return;
  try {
    console.info(`[Athena][NanoDLP][FilterDebug][${scope}]`, details);
  } catch {
    // no-op
  }
}

function resolveKnownNetworkFilter(machineName: string): string | null {
  const normalizedMachineName = normalizeMachineName(machineName);
  if (!normalizedMachineName) return null;

  for (const filter of ATHENA_NETWORK_FILTERS) {
    const normalizedFilter = normalizeMachineName(filter);
    if (!normalizedFilter) continue;
    if (normalizedMachineName === normalizedFilter) return filter;
  }

  for (const filter of ATHENA_NETWORK_FILTERS) {
    const normalizedFilter = normalizeMachineName(filter);
    if (!normalizedFilter) continue;
    if (normalizedMachineName.includes(normalizedFilter) || normalizedFilter.includes(normalizedMachineName)) {
      return filter;
    }
  }

  return null;
}

async function fetchNanoDlpMachineName(
  host: string,
  port: number,
  timeoutMs: number = 3000,
): Promise<string | null> {
  try {
    const response = await fetch(`${buildNanoDlpBaseUrl(host, port)}/json/db/machine.json`, {
      method: 'GET',
      headers: { Accept: 'application/json' },
      cache: 'no-store',
      signal: AbortSignal.timeout(timeoutMs),
    });

    if (response.status !== 200) return null;
    const payload = await response.json().catch(() => null) as Record<string, unknown> | null;
    const name = typeof payload?.Name === 'string' ? payload.Name.trim() : '';
    return name.length > 0 ? name : null;
  } catch {
    return null;
  }
}

async function resolveRequestedNetworkFilter(payload: unknown): Promise<string | null> {
  const explicitFilter = typeof (payload as any)?.networkFilter === 'string'
    ? (payload as any).networkFilter.trim()
    : '';
  if (explicitFilter.length > 0) return explicitFilter;
  return null;
}

async function resolveDeviceNetworkFilter(hostOrIp: string, port: number, timeoutMs: number): Promise<string | null> {
  const machineName = await fetchNanoDlpMachineName(hostOrIp, port, timeoutMs);
  if (!machineName) return null;
  return resolveKnownNetworkFilter(machineName);
}

async function resolveDeviceMachineName(hostOrIp: string, port: number, timeoutMs: number): Promise<string | null> {
  const machineName = await fetchNanoDlpMachineName(hostOrIp, port, timeoutMs);
  if (!machineName) return null;
  return machineName.trim() || null;
}

async function probeNanoDlp(
  hostOrIp: string,
  port: number,
  timeoutMs: number = 5000,
  requestedModelHint: SupportedAthenaModel | null = null,
  requestedNetworkFilter: string | null = null,
  debugFilter: boolean = false,
): Promise<NanoDlpDiscoveredDevice | null> {
  try {
    const status = await fetchNanoDlpStatus(hostOrIp, port, timeoutMs);
    if (!status) {
      logNanoDlpFilterDebug(debugFilter, 'probe/reject', {
        hostOrIp,
        port,
        reason: 'status-unavailable',
      });
      return null;
    }

    const supportedModel = resolveSupportedAthenaModel(status);
    if (!supportedModel) {
      logNanoDlpFilterDebug(debugFilter, 'probe/reject', {
        hostOrIp,
        port,
        reason: 'unsupported-model',
        printerModel: resolveNanoDlpPrinterModel(status),
      });
      return null;
    }

    let networkFilterMatched = false;

    if (requestedNetworkFilter) {
      const machineName = await resolveDeviceMachineName(hostOrIp, port, Math.max(1200, Math.min(timeoutMs, 4000)));
      if (!machineName) {
        logNanoDlpFilterDebug(debugFilter, 'probe/fallback', {
          hostOrIp,
          port,
          reason: 'machine-name-unavailable',
          requestedNetworkFilter,
          fallbackToModelHint: true,
        });
      } else {
        const normalizedMachineName = normalizeMachineName(machineName);
        const normalizedRequestedFilter = normalizeMachineName(requestedNetworkFilter);
        if (normalizedMachineName !== normalizedRequestedFilter) {
          const knownNetworkFilter = resolveKnownNetworkFilter(machineName);
          const normalizedKnownNetworkFilter = knownNetworkFilter ? normalizeMachineName(knownNetworkFilter) : null;
          const explicitKnownFilterMismatch = Boolean(
            normalizedKnownNetworkFilter
            && normalizedKnownNetworkFilter !== normalizedRequestedFilter,
          );

          if (explicitKnownFilterMismatch) {
            logNanoDlpFilterDebug(debugFilter, 'probe/reject', {
              hostOrIp,
              port,
              reason: 'explicit-known-filter-mismatch',
              machineName,
              knownNetworkFilter,
              normalizedKnownNetworkFilter,
              requestedNetworkFilter,
              normalizedRequestedFilter,
              printerModel: resolveNanoDlpPrinterModel(status),
            });
            return null;
          }

          logNanoDlpFilterDebug(debugFilter, 'probe/fallback', {
            hostOrIp,
            port,
            reason: 'network-filter-mismatch',
            machineName,
            normalizedMachineName,
            knownNetworkFilter,
            normalizedKnownNetworkFilter,
            requestedNetworkFilter,
            normalizedRequestedFilter,
            printerModel: resolveNanoDlpPrinterModel(status),
            fallbackToModelHint: true,
          });
        } else {
          networkFilterMatched = true;

          logNanoDlpFilterDebug(debugFilter, 'probe/match', {
            hostOrIp,
            port,
            machineName,
            requestedNetworkFilter,
          });
        }
      }
    }

    const modelHintMatched = isSupportedAthenaModelMatch(supportedModel, requestedModelHint);
    if (!modelHintMatched && !networkFilterMatched) {
      logNanoDlpFilterDebug(debugFilter, 'probe/reject', {
        hostOrIp,
        port,
        reason: 'model-hint-mismatch',
        supportedModel,
        requestedModelHint,
        modelHintMatched,
        networkFilterMatched,
        printerModel: resolveNanoDlpPrinterModel(status),
      });
      return null;
    }

    const hostName = resolveNanoDlpStatusHostName(status);
    const printerName = resolveNanoDlpPrinterName(status);
    const printerModel = resolveNanoDlpPrinterModel(status);
    const resolvedAddress = resolveNanoDlpResolvedAddress(status, hostOrIp);

    return {
      ipAddress: resolvedAddress,
      port,
      hostName,
      printerName,
      printerModel,
      statusText: typeof status.Status === 'string' ? status.Status : 'Online',
      state: typeof status.State === 'string' ? status.State : '',
      firmwareVersion: status.Version != null ? String(status.Version) : '',
    };
  } catch {
    logNanoDlpFilterDebug(debugFilter, 'probe/reject', {
      hostOrIp,
      port,
      reason: 'probe-exception',
    });
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

function hasPositiveNumber(value: unknown): boolean {
  if (value == null) return false;
  if (typeof value === 'number') return Number.isFinite(value) && value > 0;
  const parsed = Number(String(value).trim());
  return Number.isFinite(parsed) && parsed > 0;
}

function toAbsoluteNanoDlpUrl(candidate: string, host: string, port: number): string {
  const trimmed = candidate.trim();
  if (/^https?:\/\//i.test(trimmed)) return trimmed;
  if (trimmed.startsWith('//')) return `http:${trimmed}`;
  if (trimmed.startsWith('/')) return `${buildNanoDlpBaseUrl(host, port)}${trimmed}`;
  return `${buildNanoDlpBaseUrl(host, port)}/${trimmed.replace(/^\/+/, '')}`;
}

function resolveNanoDlpWebcamCandidates(status: Record<string, unknown>, host: string, port: number): string[] {
  const candidates = [
    status.WebcamURL,
    status.webcamUrl,
    status.Webcam,
    status.webcam,
    status.CameraURL,
    status.cameraUrl,
    status.StreamURL,
    status.streamUrl,
    status.MjpegURL,
    status.mjpegUrl,
    status.SnapshotURL,
    status.snapshotUrl,
  ]
    .filter((value): value is string => typeof value === 'string' && value.trim().length > 0)
    .map((value) => toAbsoluteNanoDlpUrl(value, host, port));

  return Array.from(new Set(candidates));
}

function resolveAthenaCameraOnline(statePayload: unknown): boolean {
  if (statePayload == null) return false;
  if (typeof statePayload === 'boolean') return statePayload;
  if (typeof statePayload === 'number') return Number.isFinite(statePayload) && statePayload > 0;
  if (typeof statePayload === 'string') {
    const normalized = statePayload.trim().toLowerCase();
    return /online|active|enabled|ready|stream/.test(normalized) && !/offline|disabled|error|fail/.test(normalized);
  }

  if (typeof statePayload === 'object') {
    const obj = statePayload as Record<string, unknown>;
    const boolish = [obj.online, obj.enabled, obj.active, obj.streaming, obj.available];
    for (const value of boolish) {
      if (value === true) return true;
      if (typeof value === 'number' && Number.isFinite(value) && value > 0) return true;
      if (typeof value === 'string') {
        const normalized = value.trim().toLowerCase();
        if (normalized === 'true' || normalized === 'online' || normalized === 'active' || normalized === 'enabled') return true;
      }
    }

    const stateText = String(obj.state ?? obj.status ?? obj.message ?? '').trim().toLowerCase();
    if (stateText && /online|active|enabled|ready|stream/.test(stateText) && !/offline|disabled|error|fail/.test(stateText)) {
      return true;
    }
  }

  return false;
}

async function resolveAthenaCameraFeedInfo(host: string, port: number): Promise<{
  online: boolean;
  streamUrl: string | null;
  snapshotUrl: string | null;
  statePayload: unknown;
}> {
  const baseUrl = buildNanoDlpBaseUrl(host, port);
  const stateUrl = `${baseUrl}/athena-camera/state`;
  const streamUrl = `${baseUrl}/athena-camera/stream`;

  const probeStreamReachable = async (): Promise<boolean> => {
    try {
      const response = await fetch(streamUrl, {
        method: 'GET',
        headers: { Accept: 'multipart/x-mixed-replace, image/*, */*;q=0.8' },
        cache: 'no-store',
        signal: AbortSignal.timeout(2500),
      });

      // Some setups may challenge auth; that still proves endpoint exists.
      const reachable = response.status === 200 || response.status === 206 || response.status === 302 || response.status === 401 || response.status === 403;
      try {
        await response.body?.cancel?.();
      } catch {
        // Ignore cancellation errors for stream bodies.
      }
      return reachable;
    } catch {
      return false;
    }
  };

  let parsedState: unknown = null;

  try {
    const response = await fetch(stateUrl, {
      method: 'GET',
      headers: { Accept: 'application/json, text/plain;q=0.9, */*;q=0.8' },
      cache: 'no-store',
      signal: AbortSignal.timeout(4500),
    });

    if (response.status !== 200) {
      parsedState = { status: response.status };
    } else {
      const text = await response.text().catch(() => '');
      parsedState = (() => {
        if (!text.trim()) return null;
        try {
          return JSON.parse(text);
        } catch {
          return text;
        }
      })();
    }
  } catch {
    parsedState = null;
  }

  const streamReachable = await probeStreamReachable();
  const online = resolveAthenaCameraOnline(parsedState) || streamReachable;
  const snapshotCandidate = typeof (parsedState as any)?.snapshotUrl === 'string' ? (parsedState as any).snapshotUrl : null;

  return {
    online,
    streamUrl: online ? streamUrl : null,
    snapshotUrl: snapshotCandidate ? toAbsoluteNanoDlpUrl(snapshotCandidate, host, port) : null,
    statePayload: parsedState,
  };
}

function normalizeJobName(value: string): string {
  return value
    .trim()
    .replace(/\.[^.]+$/i, '')
    .toLowerCase();
}

function getPlateName(plate: Record<string, unknown>): string {
  const candidates = [plate.Path, plate.path, plate.File, plate.file, plate.Name, plate.name];
  for (const value of candidates) {
    if (typeof value !== 'string') continue;
    const trimmed = value.trim();
    if (trimmed) return trimmed;
  }
  return '';
}

function findPlate(
  plates: Array<Record<string, unknown>>,
  options: { plateId?: number | null; jobName?: string | null },
): Record<string, unknown> | null {
  const { plateId, jobName } = options;
  const normalizedJob = jobName ? normalizeJobName(jobName) : '';

  for (const plate of plates) {
    const rawId = plate.PlateID ?? plate.plateId ?? plate.plate_id ?? plate.id;
    const parsedId = Number(String(rawId ?? '').trim());
    if (plateId && Number.isFinite(parsedId) && parsedId === plateId) {
      return plate;
    }
  }

  if (!normalizedJob) return null;

  for (const plate of plates) {
    const plateName = getPlateName(plate);
    if (!plateName) continue;
    if (normalizeJobName(plateName) === normalizedJob) {
      return plate;
    }
  }

  return null;
}

function normalizeNanoDlpFileLocation(value: unknown): 'Local' | 'Usb' {
  if (typeof value !== 'string') return 'Local';

  const normalized = value.trim().toLowerCase();
  if (!normalized) return 'Local';
  if (normalized === 'usb' || normalized === 'external') return 'Usb';
  if (normalized === 'local' || normalized === 'internal') return 'Local';
  return 'Local';
}

async function resolveNanoDlpPlateFileTarget(
  host: string,
  port: number,
  plateId: number,
): Promise<{ location: 'Local' | 'Usb'; filePath: string } | null> {
  try {
    const response = await fetch(`${buildNanoDlpBaseUrl(host, port).replace(/\/+$/, '')}/plates/list/json`, {
      method: 'GET',
      headers: { Accept: 'application/json' },
      cache: 'no-store',
      signal: AbortSignal.timeout(10_000),
    });

    if (response.status !== 200) return null;

    const decoded = await response.json().catch(() => null);
    if (!decoded) return null;

    const entries = extractListFromJson(decoded, ['plates', 'files', 'data']);
    const plates = entries
      .filter((entry) => entry && typeof entry === 'object')
      .map((entry) => entry as Record<string, unknown>);

    const matched = findPlate(plates, { plateId, jobName: null });
    if (!matched) return null;

    const rawPath = matched.Path ?? matched.path ?? matched.File ?? matched.file ?? matched.Name ?? matched.name;
    const filePath = typeof rawPath === 'string' ? rawPath.trim() : '';
    if (!filePath) return null;

    const rawLocation = matched.Location
      ?? matched.location
      ?? matched.LocationCategory
      ?? matched.locationCategory
      ?? matched.storage
      ?? matched.Storage;

    return {
      location: normalizeNanoDlpFileLocation(rawLocation),
      filePath,
    };
  } catch {
    return null;
  }
}

function isPlateMetadataReady(plate: Record<string, unknown>): boolean {
  const candidates = [
    plate.LayerHeight,
    plate.layerHeight,
    plate.LayersCount,
    plate.layerCount,
    plate.PrintTime,
    plate.printTime,
    plate.UsedMaterial,
    plate.usedMaterial,
  ];

  if (candidates.some(hasPositiveNumber)) return true;

  const fileData = (plate.file_data ?? plate.fileData) as Record<string, unknown> | undefined;
  if (fileData && typeof fileData === 'object') {
    const lastModified = fileData.last_modified ?? fileData.lastModified;
    if (hasPositiveNumber(lastModified)) return true;
  }

  return false;
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
  const requestedModelHint = normalizeSupportedAthenaModelHint((payload as any)?.modelHint);
  const requestedNetworkFilter = await resolveRequestedNetworkFilter(payload);
  const debugFilter = isNanoDlpFilterDebugEnabled(payload, requestedNetworkFilter);

  logNanoDlpFilterDebug(debugFilter, 'connect/request', {
    host: parsedHost.host,
    port,
    requestedModelHint,
    requestedNetworkFilter,
  });

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

    const supportedModel = resolveSupportedAthenaModel(status);
    const printerModel = resolveNanoDlpPrinterModel(status);
    const deviceNetworkFilter = await resolveDeviceNetworkFilter(parsedHost.host, port, 3500);
    const deviceMachineName = await resolveDeviceMachineName(parsedHost.host, port, 3500);
    logNanoDlpFilterDebug(debugFilter, 'connect/candidate', {
      host: parsedHost.host,
      port,
      supportedModel,
      requestedModelHint,
      printerModel,
      requestedNetworkFilter,
      deviceMachineName,
      normalizedDeviceMachineName: deviceMachineName ? normalizeMachineName(deviceMachineName) : null,
      normalizedRequestedNetworkFilter: requestedNetworkFilter ? normalizeMachineName(requestedNetworkFilter) : null,
      deviceNetworkFilter,
    });

    const normalizedRequestedNetworkFilter = requestedNetworkFilter ? normalizeMachineName(requestedNetworkFilter) : null;
    const normalizedDeviceMachineName = deviceMachineName ? normalizeMachineName(deviceMachineName) : null;
    const normalizedDeviceNetworkFilter = deviceNetworkFilter ? normalizeMachineName(deviceNetworkFilter) : null;
    const networkFilterMatched = Boolean(
      normalizedRequestedNetworkFilter
      && normalizedDeviceMachineName
      && normalizedDeviceMachineName === normalizedRequestedNetworkFilter,
    );
    const explicitKnownFilterMismatch = Boolean(
      normalizedRequestedNetworkFilter
      && normalizedDeviceNetworkFilter
      && normalizedDeviceNetworkFilter !== normalizedRequestedNetworkFilter,
    );
    const modelHintMatched = Boolean(
      supportedModel
      && isSupportedAthenaModelMatch(supportedModel, requestedModelHint),
    );

    if (!supportedModel || explicitKnownFilterMismatch || (!modelHintMatched && !networkFilterMatched)) {
      logNanoDlpFilterDebug(debugFilter, 'connect/reject', {
        host: parsedHost.host,
        port,
        reason: !supportedModel
          ? 'unsupported-model'
          : explicitKnownFilterMismatch
            ? 'explicit-known-filter-mismatch'
          : 'model-hint-mismatch',
        requestedModelHint,
        requestedNetworkFilter,
        modelHintMatched,
        networkFilterMatched,
        explicitKnownFilterMismatch,
        supportedModel,
        printerModel,
        deviceMachineName,
        deviceNetworkFilter,
      });
      const requestedLabel = requestedModelHint === 'athena-2' ? 'Athena 2' : requestedModelHint === 'athena' ? 'Athena' : null;
      return {
        status: 200,
        body: {
          connected: false,
          mode: 'nanodlp',
          hostName: resolveNanoDlpStatusHostName(status),
          printerName: resolveNanoDlpPrinterName(status),
          printerModel,
          ipAddress: resolveNanoDlpResolvedAddress(status, parsedHost.host),
          port,
          statusText: requestedNetworkFilter
            ? (printerModel
              ? `Printer model mismatch: expected ${requestedNetworkFilter}, found "${deviceNetworkFilter ?? printerModel}".`
              : `Printer model mismatch: expected ${requestedNetworkFilter}.`)
            : requestedLabel
            ? (printerModel
              ? `Printer model mismatch: expected ${requestedLabel}, found "${printerModel}".`
              : `Printer model mismatch: expected ${requestedLabel}.`)
            : (printerModel
              ? `Unsupported printer model "${printerModel}". Supported models: Athena, Athena 2.`
              : 'Unsupported printer model. Supported models: Athena, Athena 2.'),
          state: typeof status.State === 'string' ? status.State : '',
          firmwareVersion: status.Version != null ? String(status.Version) : '',
        },
      };
    }

    const hostName = resolveNanoDlpStatusHostName(status);
    const printerName = resolveNanoDlpPrinterName(status);
    const resolvedAddress = resolveNanoDlpResolvedAddress(status, parsedHost.host);

    logNanoDlpFilterDebug(debugFilter, 'connect/accept', {
      host: parsedHost.host,
      port,
      resolvedAddress,
      printerModel,
      requestedNetworkFilter,
      deviceMachineName,
    });

    return {
      status: 200,
      body: {
        connected: true,
        mode: 'nanodlp',
        hostName,
        printerName,
        printerModel,
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
  const requestedModelHint = normalizeSupportedAthenaModelHint((payload as any)?.modelHint);
  const requestedNetworkFilter = await resolveRequestedNetworkFilter(payload);
  const debugFilter = isNanoDlpFilterDebugEnabled(payload, requestedNetworkFilter);
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

  logNanoDlpFilterDebug(debugFilter, 'discover/request', {
    scanScope,
    requestedModelHint,
    requestedNetworkFilter,
    forcedHost,
    targetPorts,
    localTargetCount: localTargets.length,
    subnetTargetCount: subnetTargets.length,
    progressive,
  });

  const foundByAddress = new Map<string, NanoDlpDiscoveredDevice>();

  if (localTargets.length > 0) {
    await runWithConcurrency(localTargets, localConcurrency, async (target) => {
      const result = await probeNanoDlp(
        target.host,
        target.port,
        Math.max(probeTimeoutMs, 1500),
        requestedModelHint,
        requestedNetworkFilter,
        debugFilter,
      );
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
      const result = await probeNanoDlp(target.ipAddress, target.port, probeTimeoutMs, requestedModelHint, requestedNetworkFilter, debugFilter);
      if (!result) return null;
      if (foundByAddress.has(result.ipAddress)) {
        logNanoDlpFilterDebug(debugFilter, 'discover/duplicate', {
          phase: 'subnet-progressive',
          ipAddress: result.ipAddress,
          port: result.port,
        });
        return null;
      }
      foundByAddress.set(result.ipAddress, result);
      logNanoDlpFilterDebug(debugFilter, 'discover/accept', {
        phase: 'subnet-progressive',
        ipAddress: result.ipAddress,
        port: result.port,
        printerModel: result.printerModel,
      });
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
      const result = await probeNanoDlp(target.ipAddress, target.port, probeTimeoutMs, requestedModelHint, requestedNetworkFilter, debugFilter);
      if (!result) return null;

      if (!foundByAddress.has(result.ipAddress)) {
        foundByAddress.set(result.ipAddress, result);
        logNanoDlpFilterDebug(debugFilter, 'discover/accept', {
          phase: 'subnet-full',
          ipAddress: result.ipAddress,
          port: result.port,
          printerModel: result.printerModel,
        });
        return result;
      }

      logNanoDlpFilterDebug(debugFilter, 'discover/duplicate', {
        phase: 'subnet-full',
        ipAddress: result.ipAddress,
        port: result.port,
      });
      return null;
    });
  }

  logNanoDlpFilterDebug(debugFilter, 'discover/summary', {
    discoveredCount: foundByAddress.size,
    scanScope,
    scannedHosts: localHostCandidates.length + effectiveSubnetHostCandidates.length,
    scannedEndpoints: localTargets.length + subnetTargets.length,
  });

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

async function handleNanoDlpJobImport(payload: unknown): Promise<HandlerResult> {
  const rawHost = resolveNanoDlpRawHost(payload);
  const parsedHost = parseNanoDlpHostAndPort(rawHost);
  if (!parsedHost) {
    return { status: 400, body: { ok: false, error: 'Invalid host or IP address' } };
  }

  const port = resolveNanoDlpPort((payload as any)?.port, parsedHost.port);
  const zipBase64 = typeof (payload as any)?.zipBase64 === 'string' ? (payload as any).zipBase64.trim() : '';
  const zipFilePath = typeof (payload as any)?.zipFilePath === 'string' ? (payload as any).zipFilePath.trim() : '';
  if (!zipBase64 && !zipFilePath) {
    return { status: 400, body: { ok: false, error: 'zipBase64 payload or zipFilePath is required' } };
  }

  const pathRaw = typeof (payload as any)?.path === 'string' ? (payload as any).path.trim() : '';
  const path = pathRaw || 'dragonfruit_job';
  const profileId = typeof (payload as any)?.profileId === 'string' ? (payload as any).profileId.trim() : '';
  if (!profileId) {
    return { status: 400, body: { ok: false, error: 'profileId is required for NanoDLP import' } };
  }

  const host = parsedHost.host.toLowerCase();
  const isLocalhost = host === 'localhost' || host === '127.0.0.1' || host.startsWith('127.');
  const usbFilePath = typeof (payload as any)?.usbFilePath === 'string' ? (payload as any).usbFilePath.trim() : '';

  try {
    let zipBytes: Buffer | null = null;

    if (zipFilePath) {
      try {
        zipBytes = await readFile(zipFilePath);
      } catch (fileError) {
        if (!zipBase64) {
          const reason = fileError instanceof Error ? fileError.message : 'Unknown file read error';
          return { status: 400, body: { ok: false, error: `Failed to read zipFilePath: ${reason}` } };
        }
      }
    }

    if (!zipBytes && zipBase64) {
      zipBytes = Buffer.from(zipBase64, 'base64');
    }

    if (!zipBytes || zipBytes.length === 0) {
      return { status: 400, body: { ok: false, error: 'Decoded job payload is empty' } };
    }

    const form = new FormData();
    form.set('Path', path);
    form.set('ProfileID', profileId);

    if (isLocalhost && usbFilePath) {
      form.set('USBFile', usbFilePath);
    } else {
      const zipArrayBuffer = Uint8Array.from(zipBytes).buffer;
      form.set('ZipFile', new Blob([zipArrayBuffer], { type: 'application/octet-stream' }), `${path}.nanodlp`);
    }

    const response = await fetch(`${buildNanoDlpBaseUrl(parsedHost.host, port)}/plate/add`, {
      method: 'POST',
      body: form,
      headers: {
        Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
      },
      redirect: 'manual',
      signal: AbortSignal.timeout(300_000),
    });

    const responseText = await response.text().catch(() => '');
    const location = response.headers.get('location') ?? '';
    const locationPlateMatch = /\/(\d+)(?:\D*$)?/.exec(location);
    const bodyPlateMatch = /(plate[_\s-]?id|\bplate\b)\D{0,12}(\d{1,10})/i.exec(responseText);
    const plateId = Number(locationPlateMatch?.[1] ?? bodyPlateMatch?.[2] ?? '');
    const responseJson = (() => {
      if (!responseText) return null;
      try {
        return JSON.parse(responseText) as unknown;
      } catch {
        return null;
      }
    })();

    if (!(response.ok || response.status === 302)) {
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
        path,
        plateId: Number.isFinite(plateId) && plateId > 0 ? plateId : null,
        status: response.status,
        location,
        response: responseJson ?? responseText,
      },
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Failed to upload print job to NanoDLP';
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

  const handled = await dispatchNanoDlpOperation(op, payload, {
    connect: handleNanoDlpConnect,
    discover: handleNanoDlpDiscover,
    materials: handleNanoDlpMaterials,
    materialsEdit: handleNanoDlpMaterialsEdit,
    jobImport: handleNanoDlpJobImport,
    platesListJson: handleNanoDlpPlatesListJson,
    plateDelete: handleNanoDlpPlateDelete,
    printerStart: handleNanoDlpPrinterStart,
    printerPause: handleNanoDlpPrinterPause,
    printerResume: handleNanoDlpPrinterResume,
    printerCancel: handleNanoDlpPrinterCancel,
    printerEmergencyStop: handleNanoDlpPrinterEmergencyStop,
    printerStatus: handleNanoDlpPrinterStatus,
    printerWebcamInfo: handleNanoDlpPrinterWebcamInfo,
  });

  if (handled) return handled;

  return { status: 404, body: { error: 'Unknown Athena NanoDLP operation' } };
}

// Generic compile-time registration alias used by generated plugin registries.
export const handlePluginNetworkOperation = handleAthenaNetworkOperation;

async function handleNanoDlpPlatesListJson(payload: unknown): Promise<HandlerResult> {
  const rawHost = resolveNanoDlpRawHost(payload);
  const parsedHost = parseNanoDlpHostAndPort(rawHost);
  if (!parsedHost) {
    return { status: 400, body: { ok: false, error: 'Invalid host or IP address' } };
  }

  const port = resolveNanoDlpPort((payload as any)?.port, parsedHost.port);
  const baseUrl = buildNanoDlpBaseUrl(parsedHost.host, port);

  try {
    const response = await fetch(`${baseUrl}/plates/list/json`, {
      method: 'GET',
      headers: { Accept: 'application/json' },
      cache: 'no-store',
      signal: AbortSignal.timeout(15_000),
    });

    if (response.status !== 200) {
      return {
        status: 502,
        body: {
          ok: false,
          ipAddress: parsedHost.host,
          port,
          status: response.status,
          error: `HTTP ${response.status}`,
          plates: [],
        },
      };
    }

    const decoded = await response.json().catch(() => null);
    if (!decoded) {
      return {
        status: 200,
        body: {
          ok: true,
          ipAddress: parsedHost.host,
          port,
          plates: [],
        },
      };
    }

    const entries = extractListFromJson(decoded, ['plates', 'files', 'data']);
    const plates = entries
      .filter((entry) => entry && typeof entry === 'object')
      .map((entry) => entry as Record<string, unknown>);

    const targetPlateId = Number((payload as any)?.plateId);
    const targetJobName = typeof (payload as any)?.jobName === 'string' ? (payload as any).jobName : '';
    const matchedPlate = findPlate(plates, {
      plateId: Number.isFinite(targetPlateId) && targetPlateId > 0 ? targetPlateId : null,
      jobName: targetJobName || null,
    });

    return {
      status: 200,
      body: {
        ok: true,
        ipAddress: parsedHost.host,
        port,
        plates,
        matchedPlate,
        metadataReady: matchedPlate ? isPlateMetadataReady(matchedPlate) : false,
      },
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Failed to list NanoDLP plates';
    return {
      status: 500,
      body: {
        ok: false,
        ipAddress: parsedHost.host,
        port,
        error: message,
        plates: [],
      },
    };
  }
}

async function handleNanoDlpPlateDelete(payload: unknown): Promise<HandlerResult> {
  const rawHost = resolveNanoDlpRawHost(payload);
  const parsedHost = parseNanoDlpHostAndPort(rawHost);
  if (!parsedHost) {
    return { status: 400, body: { ok: false, error: 'Invalid host or IP address' } };
  }

  const plateIdRaw = Number((payload as any)?.plateId);
  if (!Number.isFinite(plateIdRaw) || plateIdRaw <= 0) {
    return { status: 400, body: { ok: false, error: 'Invalid plateId' } };
  }

  const plateId = Math.round(plateIdRaw);
  const port = resolveNanoDlpPort((payload as any)?.port, parsedHost.port);
  const baseNoSlash = buildNanoDlpBaseUrl(parsedHost.host, port).replace(/\/+$/, '');
  const fileTarget = await resolveNanoDlpPlateFileTarget(parsedHost.host, port, plateId);

  const endpointAttempts: Array<{ method: 'DELETE' | 'GET'; path: string }> = [];

  if (fileTarget) {
    const query = new URLSearchParams({
      location: fileTarget.location,
      file_path: fileTarget.filePath,
    });
    endpointAttempts.push({ method: 'DELETE', path: `/file?${query.toString()}` });
  }

  endpointAttempts.push(
    { method: 'GET', path: `/plate/delete/${plateId}` },
    { method: 'GET', path: `/plates/delete/${plateId}` },
    { method: 'GET', path: `/plate/remove/${plateId}` },
  );

  const attempted: Array<{ method: string; path: string; status: number }> = [];
  let lastNetworkError: unknown = null;

  for (const endpoint of endpointAttempts) {
    const endpointPath = endpoint.path;
    try {
      const response = await fetch(`${baseNoSlash}${endpointPath}`, {
        method: endpoint.method,
        redirect: 'manual',
        cache: 'no-store',
        signal: AbortSignal.timeout(15_000),
      });

      attempted.push({ method: endpoint.method, path: endpointPath, status: response.status });

      if (response.status === 200 || response.status === 202 || response.status === 204 || response.status === 302) {
        return {
          status: 200,
          body: {
            ok: true,
            ipAddress: parsedHost.host,
            port,
            plateId,
            status: response.status,
            method: endpoint.method,
            endpoint: endpointPath,
            message: `Deleted plate #${plateId}.`,
            attempted,
          },
        };
      }
    } catch (error) {
      lastNetworkError = error;
    }
  }

  const lastAttempt = attempted[attempted.length - 1] ?? null;
  const lastStatus = lastAttempt?.status ?? null;
  const networkMessage = lastNetworkError instanceof Error ? lastNetworkError.message : null;

  return {
    status: lastStatus != null ? 502 : 500,
    body: {
      ok: false,
      ipAddress: parsedHost.host,
      port,
      plateId,
      status: lastStatus,
      error: networkMessage ?? `Delete plate command failed for plate #${plateId}.`,
      attempted,
    },
  };
}

async function handleNanoDlpPrinterStart(payload: unknown): Promise<HandlerResult> {
  const rawHost = resolveNanoDlpRawHost(payload);
  const parsedHost = parseNanoDlpHostAndPort(rawHost);
  if (!parsedHost) {
    return { status: 400, body: { ok: false, error: 'Invalid host or IP address' } };
  }

  const plateIdRaw = Number((payload as any)?.plateId);
  if (!Number.isFinite(plateIdRaw) || plateIdRaw <= 0) {
    return { status: 400, body: { ok: false, error: 'Invalid plateId' } };
  }

  const plateId = Math.round(plateIdRaw);
  const port = resolveNanoDlpPort((payload as any)?.port, parsedHost.port);
  const baseNoSlash = buildNanoDlpBaseUrl(parsedHost.host, port).replace(/\/+$/, '');

  try {
    const response = await fetch(`${baseNoSlash}/printer/start/${plateId}`, {
      method: 'GET',
      redirect: 'manual',
      cache: 'no-store',
      signal: AbortSignal.timeout(15_000),
    });

    if (response.status !== 200 && response.status !== 302) {
      return {
        status: 502,
        body: {
          ok: false,
          ipAddress: parsedHost.host,
          port,
          plateId,
          status: response.status,
          error: `HTTP ${response.status}`,
        },
      };
    }

    return {
      status: 200,
      body: {
        ok: true,
        ipAddress: parsedHost.host,
        port,
        plateId,
        status: response.status,
      },
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Failed to start print job';
    return {
      status: 500,
      body: {
        ok: false,
        ipAddress: parsedHost.host,
        port,
        plateId,
        error: message,
      },
    };
  }
}

async function handleNanoDlpPrinterControl(
  payload: unknown,
  options: {
    action: 'pause' | 'resume' | 'cancel' | 'emergency-stop';
    endpointPaths: string[];
    successMessage: string;
    failureLabel: string;
    treatAnyResponseAsSuccess?: boolean;
  },
): Promise<HandlerResult> {
  const rawHost = resolveNanoDlpRawHost(payload);
  const parsedHost = parseNanoDlpHostAndPort(rawHost);
  if (!parsedHost) {
    return { status: 400, body: { ok: false, error: 'Invalid host or IP address' } };
  }

  const port = resolveNanoDlpPort((payload as any)?.port, parsedHost.port);
  const baseNoSlash = buildNanoDlpBaseUrl(parsedHost.host, port).replace(/\/+$/, '');
  const attempted: Array<{ path: string; status: number }> = [];
  let lastError: unknown = null;

  for (const path of options.endpointPaths) {
    const normalizedPath = path.trim();
    if (!normalizedPath) continue;

    try {
      const response = await fetch(`${baseNoSlash}${normalizedPath}`, {
        method: 'GET',
        redirect: 'manual',
        cache: 'no-store',
        signal: AbortSignal.timeout(15_000),
      });

      attempted.push({ path: normalizedPath, status: response.status });

      if (response.status === 200 || response.status === 302) {
        return {
          status: 200,
          body: {
            ok: true,
            action: options.action,
            ipAddress: parsedHost.host,
            port,
            status: response.status,
            endpoint: normalizedPath,
            message: options.successMessage,
          },
        };
      }
    } catch (error) {
      lastError = error;
    }
  }

  const lastAttempt = attempted[attempted.length - 1] ?? null;
  const lastStatus = lastAttempt?.status ?? null;
  const networkMessage = lastError instanceof Error ? lastError.message : null;

  if (options.treatAnyResponseAsSuccess === true && attempted.length > 0) {
    return {
      status: 200,
      body: {
        ok: true,
        action: options.action,
        ipAddress: parsedHost.host,
        port,
        status: lastStatus,
        endpoint: lastAttempt?.path ?? null,
        message: options.successMessage,
        warning: `Command returned non-200 status (${lastStatus ?? 'unknown'}) but was treated as success for fail-safe behavior.`,
        attempted,
      },
    };
  }

  return {
    status: lastStatus != null ? 502 : 500,
    body: {
      ok: false,
      action: options.action,
      ipAddress: parsedHost.host,
      port,
      status: lastStatus,
      error: networkMessage ?? `${options.failureLabel} not supported or failed on this NanoDLP host.`,
      attempted,
    },
  };
}

async function handleNanoDlpPrinterPause(payload: unknown): Promise<HandlerResult> {
  return handleNanoDlpPrinterControl(payload, {
    action: 'pause',
    endpointPaths: ['/printer/pause'],
    successMessage: 'Pause command sent to printer.',
    failureLabel: 'Pause command',
  });
}

async function handleNanoDlpPrinterResume(payload: unknown): Promise<HandlerResult> {
  return handleNanoDlpPrinterControl(payload, {
    action: 'resume',
    endpointPaths: ['/printer/unpause', '/printer/resume'],
    successMessage: 'Resume command sent to printer.',
    failureLabel: 'Resume command',
  });
}

async function handleNanoDlpPrinterCancel(payload: unknown): Promise<HandlerResult> {
  return handleNanoDlpPrinterControl(payload, {
    action: 'cancel',
    endpointPaths: ['/printer/stop', '/printer/cancel'],
    successMessage: 'Cancel command sent to printer.',
    failureLabel: 'Cancel command',
  });
}

async function handleNanoDlpPrinterEmergencyStop(payload: unknown): Promise<HandlerResult> {
  return handleNanoDlpPrinterControl(payload, {
    action: 'emergency-stop',
    endpointPaths: ['/printer/force-stop', '/printer/emergency-stop', '/printer/emergency', '/printer/abort', '/printer/stop'],
    successMessage: 'Emergency stop command sent to printer.',
    failureLabel: 'Emergency stop command',
    treatAnyResponseAsSuccess: true,
  });
}

async function handleNanoDlpPrinterStatus(payload: unknown): Promise<HandlerResult> {
  const rawHost = resolveNanoDlpRawHost(payload);
  const parsedHost = parseNanoDlpHostAndPort(rawHost);
  if (!parsedHost) {
    return { status: 400, body: { ok: false, error: 'Invalid host or IP address' } };
  }

  const port = resolveNanoDlpPort((payload as any)?.port, parsedHost.port);

  try {
    const status = await fetchNanoDlpStatus(parsedHost.host, port, 8000);
    if (!status) {
      return {
        status: 200,
        body: {
          ok: false,
          ipAddress: parsedHost.host,
          port,
          error: 'NanoDLP status endpoint unavailable.',
          status: null,
        },
      };
    }

    return {
      status: 200,
      body: {
        ok: true,
        ipAddress: parsedHost.host,
        port,
        status,
      },
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Failed to fetch NanoDLP status.';
    return {
      status: 500,
      body: {
        ok: false,
        ipAddress: parsedHost.host,
        port,
        error: message,
        status: null,
      },
    };
  }
}

async function handleNanoDlpPrinterWebcamInfo(payload: unknown): Promise<HandlerResult> {
  const rawHost = resolveNanoDlpRawHost(payload);
  const parsedHost = parseNanoDlpHostAndPort(rawHost);
  if (!parsedHost) {
    return { status: 400, body: { ok: false, error: 'Invalid host or IP address' } };
  }

  const port = resolveNanoDlpPort((payload as any)?.port, parsedHost.port);

  try {
    const [status, athenaCamera] = await Promise.all([
      fetchNanoDlpStatus(parsedHost.host, port, 5000),
      resolveAthenaCameraFeedInfo(parsedHost.host, port),
    ]);

    if (!status && !athenaCamera.online) {
      return {
        status: 200,
        body: {
          ok: false,
          available: false,
          ipAddress: parsedHost.host,
          port,
          streamUrl: null,
          snapshotUrl: null,
          candidates: [],
          message: 'No camera endpoint available from this printer.',
          status: null,
          cameraState: athenaCamera.statePayload,
        },
      };
    }

    const statusCandidates = status
      ? resolveNanoDlpWebcamCandidates(status, parsedHost.host, port)
      : [];

    const candidates = Array.from(new Set([
      ...(athenaCamera.streamUrl ? [athenaCamera.streamUrl] : []),
      ...(athenaCamera.snapshotUrl ? [athenaCamera.snapshotUrl] : []),
      ...statusCandidates,
    ]));

    const snapshotUrl = candidates.find((value) => /snapshot|jpg|jpeg|png/i.test(value)) ?? candidates[0] ?? null;
    const streamUrl = candidates.find((value) => /stream|mjpeg|video/i.test(value)) ?? candidates[0] ?? null;

    return {
      status: 200,
      body: {
        ok: true,
        available: Boolean(streamUrl || snapshotUrl),
        ipAddress: parsedHost.host,
        port,
        streamUrl,
        snapshotUrl,
        candidates,
        message: athenaCamera.online
          ? 'Athena camera stream available.'
          : candidates.length > 0
            ? 'Webcam endpoint detected.'
            : 'No webcam endpoint reported by this printer.',
        status: status ?? null,
        cameraState: athenaCamera.statePayload,
      },
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Failed to resolve NanoDLP webcam information.';
    return {
      status: 500,
      body: {
        ok: false,
        available: false,
        ipAddress: parsedHost.host,
        port,
        streamUrl: null,
        snapshotUrl: null,
        candidates: [],
        message,
        status: null,
      },
    };
  }
}