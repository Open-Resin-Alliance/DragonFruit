/**
 * Athena NanoDLP networking utility module.
 *
 * Where this is consumed:
 * - `src/app/api/network/nanodlp/connect/route.ts`
 * - `src/app/api/network/nanodlp/discover/route.ts`
 * - `src/app/api/network/nanodlp/materials/route.ts`
 * - `src/app/api/network/nanodlp/materials/edit/route.ts`
 *
 * Design intent:
 * - Centralize NanoDLP protocol quirks and parsing heuristics in plugin-owned
 *   code, not core API route files.
 */

/**
 * Raw status object shape returned by NanoDLP `/status` endpoint.
 *
 * NanoDLP payloads vary by firmware/version, so we keep this permissive and
 * use heuristic checks in helper functions below.
 */
export type NanoDlpStatusPayload = Record<string, unknown>;

/**
 * Parse a user-supplied NanoDLP host string into `{ host, port }`.
 *
 * Accepts either plain host/IP (`192.168.1.10`) or full URL
 * (`http://192.168.1.10:8080`).
 */
export function parseNanoDlpHostAndPort(input: string): { host: string; port: number } | null {
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

/**
 * Build the HTTP base URL for NanoDLP host communication.
 */
export function buildNanoDlpBaseUrl(host: string, port: number): string {
  return `http://${host}${port === 80 ? '' : `:${port}`}`;
}

/**
 * Resolve an explicit port with validation, otherwise fall back.
 */
export function resolveNanoDlpPort(rawPort: unknown, fallbackPort: number): number {
  const explicitPort = Number(rawPort);
  return Number.isFinite(explicitPort) && explicitPort >= 1 && explicitPort <= 65535
    ? explicitPort
    : fallbackPort;
}

/**
 * Read the host field from request payloads that may use either `host` or
 * `ipAddress`.
 */
export function resolveNanoDlpRawHost(payload: unknown): string {
  const value = payload as any;
  return typeof value?.host === 'string'
    ? value.host
    : typeof value?.ipAddress === 'string'
      ? value.ipAddress
      : '';
}

/**
 * Derive a human-friendly host label from status payload aliases.
 */
export function resolveNanoDlpStatusHostName(status: NanoDlpStatusPayload): string {
  const candidates = [
    status.Hostname,
    status.hostName,
    status.hostname,
    status.Name,
    status.Build,
    status.IP,
  ];

  for (const value of candidates) {
    if (typeof value === 'string' && value.trim().length > 0) {
      return value.trim();
    }
  }

  return '';
}

/**
 * Derive printer display name from status payload aliases.
 */
export function resolveNanoDlpPrinterName(status: NanoDlpStatusPayload): string {
  if (typeof status.Name === 'string' && status.Name.trim().length > 0) return status.Name.trim();
  if (typeof status.Build === 'string' && status.Build.trim().length > 0) return status.Build.trim();
  return '';
}

/**
 * Heuristically determine whether an object resembles NanoDLP `/status` JSON.
 *
 * We score known keys and require at least three matches to reduce false
 * positives from unrelated devices.
 */
export function looksLikeNanoDlpStatus(status: NanoDlpStatusPayload): boolean {
  const knownKeys = [
    'Printing',
    'Path',
    'LayerID',
    'Version',
    'Hostname',
    'State',
    'Status',
    'LayersCount',
    'PlateID',
    'Build',
    'Paused',
    'CurrentHeight',
    'IP',
  ];

  let score = 0;
  for (const key of knownKeys) {
    if (key in status) {
      score += 1;
      if (score >= 3) return true;
    }
  }

  return false;
}

/**
 * Fast pre-parse filter for status response text.
 *
 * This allows us to reject obviously unrelated/non-JSON responses before
 * parsing, which reduces noisy error handling during network scans.
 */
export function looksLikeNanoDlpStatusText(content: string): boolean {
  if (!content || !content.trimStart().startsWith('{')) return false;

  const knownFields = [
    '"Printing"',
    '"Path"',
    '"LayerID"',
    '"Version"',
    '"Hostname"',
    '"State"',
    '"Status"',
    '"LayersCount"',
    '"PlateID"',
    '"Build"',
    '"Paused"',
    '"CurrentHeight"',
    '"IP"',
  ];

  let matches = 0;
  for (const field of knownFields) {
    if (content.includes(field)) {
      matches += 1;
      if (matches >= 3) return true;
    }
  }

  return false;
}

function isLikelyIpv4Address(value: string): boolean {
  const parts = value.split('.');
  if (parts.length !== 4) return false;

  return parts.every((part) => {
    if (!/^\d{1,3}$/.test(part)) return false;
    const numeric = Number(part);
    return Number.isFinite(numeric) && numeric >= 0 && numeric <= 255;
  });
}

/**
 * Fetch and parse NanoDLP `/status` with a tolerant parser.
 *
 * NanoDLP firmware variants occasionally return JSON with a UTF-8 BOM or
 * slightly malformed response metadata. This helper keeps the route handlers
 * focused on flow control while the plugin owns payload parsing heuristics.
 */
export async function fetchNanoDlpStatus(
  host: string,
  port: number,
  timeoutMs: number = 5000,
): Promise<NanoDlpStatusPayload | null> {
  const response = await fetch(`${buildNanoDlpBaseUrl(host, port)}/status`, {
    method: 'GET',
    headers: {
      Accept: 'application/json',
    },
    cache: 'no-store',
    signal: AbortSignal.timeout(timeoutMs),
  });

  if (response.status !== 200) return null;

  const raw = await response.text().catch(() => '');
  if (!looksLikeNanoDlpStatusText(raw)) return null;

  const cleanedRaw = raw.replace(/^\uFEFF/, '').trim();
  const status = JSON.parse(cleanedRaw) as NanoDlpStatusPayload;
  if (!status || typeof status !== 'object' || !looksLikeNanoDlpStatus(status)) return null;

  return status;
}

/**
 * Resolve the best host/IP to use for subsequent communication.
 *
 * Prefer an IPv4 value exposed by NanoDLP status payload when present, otherwise
 * fall back to the scanned host (which may be an IP or `.local` hostname).
 */
export function resolveNanoDlpResolvedAddress(status: NanoDlpStatusPayload, fallbackHost: string): string {
  const ipCandidates = [status.IP, status.ip, status.ipAddress, status.IPAddress];
  for (const value of ipCandidates) {
    if (typeof value !== 'string') continue;
    const trimmed = value.trim();
    if (trimmed.length === 0) continue;
    if (isLikelyIpv4Address(trimmed)) return trimmed;
  }

  return fallbackHost.trim();
}