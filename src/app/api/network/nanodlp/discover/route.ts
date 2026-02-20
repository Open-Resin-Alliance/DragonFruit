import os from 'os';
import { NextResponse } from 'next/server';
import {
  buildNanoDlpBaseUrl,
  looksLikeNanoDlpStatus,
  looksLikeNanoDlpStatusText,
  parseNanoDlpHostAndPort,
  resolveNanoDlpPort,
  resolveNanoDlpPrinterName,
  resolveNanoDlpRawHost,
  resolveNanoDlpStatusHostName,
  type NanoDlpStatusPayload,
} from '../../../../../../plugins/athena/network/nanodlp';

type NanoDlpDiscoveredDevice = {
  ipAddress: string;
  port: number;
  hostName: string;
  printerName: string;
  statusText: string;
  state: string;
  firmwareVersion: string;
};


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

function buildIpCandidates(forcedHost: string | null): string[] {
  if (forcedHost) return [forcedHost];

  const prefixes = getLocalSubnetPrefixes();
  const all: string[] = [];

  for (const prefix of prefixes) {
    for (let host = 1; host <= 254; host += 1) {
      all.push(`${prefix}.${host}`);
    }
  }

  return all;
}

async function probeNanoDlp(ipAddress: string, port: number): Promise<NanoDlpDiscoveredDevice | null> {
  try {
    const response = await fetch(`${buildNanoDlpBaseUrl(ipAddress, port)}/status`, {
      method: 'GET',
      headers: {
        Accept: 'application/json',
      },
      cache: 'no-store',
      signal: AbortSignal.timeout(5000),
    });

    if (response.status !== 200) return null;

  const raw = await response.text().catch(() => '');
  if (!looksLikeNanoDlpStatusText(raw)) return null;

    const cleanedRaw = raw.replace(/^\uFEFF/, '').trim();
    const status = JSON.parse(cleanedRaw) as NanoDlpStatusPayload;
  if (!status || typeof status !== 'object' || !looksLikeNanoDlpStatus(status)) return null;

    const hostName = resolveNanoDlpStatusHostName(status);
    const printerName = resolveNanoDlpPrinterName(status);

    return {
      ipAddress,
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

async function runWithConcurrency<T, R>(
  items: T[],
  limit: number,
  worker: (item: T) => Promise<R | null>,
): Promise<R[]> {
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

export async function POST(request: Request) {
  let payload: unknown;
  try {
    payload = await request.json();
  } catch {
    return NextResponse.json({ error: 'Invalid request JSON' }, { status: 400 });
  }

  const mode = (payload as any)?.mode;
  if (mode && mode !== 'nanodlp') {
    return NextResponse.json({ error: 'Unsupported network mode' }, { status: 400 });
  }

  const rawHost = resolveNanoDlpRawHost(payload);

  const forcedHost = rawHost.trim().length > 0
    ? parseNanoDlpHostAndPort(rawHost)?.host ?? null
    : null;

  const portsInput = Array.isArray((payload as any)?.ports)
    ? (payload as any).ports
    : [80, 8080];

  const ports: number[] = portsInput
    .map((value: unknown) => resolveNanoDlpPort(value, -1))
    .filter((value: number) => value >= 1 && value <= 65535)
    .slice(0, 4);

  const targetPorts: number[] = ports.length > 0 ? Array.from(new Set<number>(ports)) : [80, 8080];
  const ipCandidates = buildIpCandidates(forcedHost);

  if (ipCandidates.length === 0) {
    return NextResponse.json({
      mode: 'nanodlp',
      devices: [],
      scannedHosts: 0,
      scannedEndpoints: 0,
    });
  }

  const scanTargets: Array<{ ipAddress: string; port: number }> = [];
  for (const ipAddress of ipCandidates) {
    for (const port of targetPorts) {
      scanTargets.push({ ipAddress, port });
    }
  }

  const foundByIp = new Map<string, NanoDlpDiscoveredDevice>();

  await runWithConcurrency(scanTargets, forcedHost ? 8 : 48, async (target) => {
    if (foundByIp.has(target.ipAddress)) return null;

    const result = await probeNanoDlp(target.ipAddress, target.port);
    if (!result) return null;

    if (!foundByIp.has(target.ipAddress)) {
      foundByIp.set(target.ipAddress, result);
      return result;
    }

    return null;
  });

  return NextResponse.json({
    mode: 'nanodlp',
    devices: Array.from(foundByIp.values()),
    scannedHosts: ipCandidates.length,
    scannedEndpoints: scanTargets.length,
  });
}
