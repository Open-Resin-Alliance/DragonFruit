import { NextResponse } from 'next/server';
import {
  buildNanoDlpBaseUrl,
  looksLikeNanoDlpStatus,
  parseNanoDlpHostAndPort,
  resolveNanoDlpPort,
  resolveNanoDlpPrinterName,
  resolveNanoDlpRawHost,
  resolveNanoDlpStatusHostName,
  type NanoDlpStatusPayload,
} from '../../../../../../plugins/athena/network/nanodlp';

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

export async function POST(request: Request) {
  let payload: unknown;
  try {
    payload = await request.json();
  } catch {
    return NextResponse.json({ error: 'Invalid request JSON' }, { status: 400 });
  }

  const rawHost = resolveNanoDlpRawHost(payload);

  const parsedHost = parseNanoDlpHostAndPort(rawHost);
  if (!parsedHost) {
    return NextResponse.json({ error: 'Invalid host or IP address' }, { status: 400 });
  }

  const port = resolveNanoDlpPort((payload as any)?.port, parsedHost.port);

  const baseUrl = buildNanoDlpBaseUrl(parsedHost.host, port);

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

    const hostName = resolveNanoDlpStatusHostName(status);
    const printerName = resolveNanoDlpPrinterName(status);

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
