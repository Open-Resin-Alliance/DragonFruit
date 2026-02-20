import { NextResponse } from 'next/server';

type NanoDlpConnectResponse = {
  connected: boolean;
  mode: 'nanodlp';
  hostName: string;
  printerName: string;
  ipAddress: string;
  port: number;
  statusText: string;
  state: string;
  firmwareVersion: string;
};

type NanoDlpStatusPayload = Record<string, unknown>;

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

function resolveStatusHostName(status: NanoDlpStatusPayload): string {
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

function looksLikeNanoDlpStatus(status: NanoDlpStatusPayload): boolean {
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

function buildBaseUrl(host: string, port: number): string {
  return `http://${host}${port === 80 ? '' : `:${port}`}`;
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
    const response = await fetch(`${baseUrl}/status`, {
      method: 'GET',
      headers: {
        Accept: 'application/json',
      },
      cache: 'no-store',
      signal: AbortSignal.timeout(5000),
    });

    if (response.status !== 200) {
      return NextResponse.json({
        connected: false,
        mode: 'nanodlp',
        hostName: '',
        printerName: '',
        ipAddress: parsedHost.host,
        port,
        statusText: `HTTP ${response.status}`,
        state: '',
        firmwareVersion: '',
      } satisfies NanoDlpConnectResponse);
    }

    const status = await response.json().catch(() => null) as NanoDlpStatusPayload | null;
    if (!status || typeof status !== 'object' || !looksLikeNanoDlpStatus(status)) {
      return NextResponse.json({
        connected: false,
        mode: 'nanodlp',
        hostName: '',
        printerName: '',
        ipAddress: parsedHost.host,
        port,
        statusText: 'Invalid NanoDLP status payload',
        state: '',
        firmwareVersion: '',
      } satisfies NanoDlpConnectResponse);
    }

    const hostName = resolveStatusHostName(status);
    const printerName = typeof status.Name === 'string'
      ? status.Name.trim()
      : typeof status.Build === 'string'
        ? status.Build.trim()
        : '';

    const result: NanoDlpConnectResponse = {
      connected: true,
      mode: 'nanodlp',
      hostName,
      printerName,
      ipAddress: parsedHost.host,
      port,
      statusText: typeof status.Status === 'string' ? status.Status : 'Online',
      state: typeof status.State === 'string' ? status.State : '',
      firmwareVersion: status.Version != null ? String(status.Version) : '',
    };

    return NextResponse.json(result);
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unable to reach NanoDLP host';
    return NextResponse.json({
      connected: false,
      mode: 'nanodlp',
      hostName: '',
      printerName: '',
      ipAddress: parsedHost.host,
      port,
      statusText: message,
      state: '',
      firmwareVersion: '',
    } satisfies NanoDlpConnectResponse);
  }
}
