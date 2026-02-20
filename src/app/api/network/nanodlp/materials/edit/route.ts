import { NextResponse } from 'next/server';

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

export async function POST(request: Request) {
  let payload: unknown;
  try {
    payload = await request.json();
  } catch {
    return NextResponse.json({ ok: false, error: 'Invalid request JSON' }, { status: 400 });
  }

  const rawHost = typeof (payload as any)?.host === 'string'
    ? (payload as any).host
    : typeof (payload as any)?.ipAddress === 'string'
      ? (payload as any).ipAddress
      : '';

  const parsedHost = parseHostAndPort(rawHost);
  if (!parsedHost) {
    return NextResponse.json({ ok: false, error: 'Invalid host or IP address' }, { status: 400 });
  }

  const profileIdRaw = Number((payload as any)?.profileId);
  if (!Number.isFinite(profileIdRaw) || profileIdRaw <= 0) {
    return NextResponse.json({ ok: false, error: 'Invalid profileId' }, { status: 400 });
  }

  const explicitPort = Number((payload as any)?.port);
  const port = Number.isFinite(explicitPort) && explicitPort >= 1 && explicitPort <= 65535
    ? explicitPort
    : parsedHost.port;

  const fieldsRaw = (payload as any)?.fields;
  if (!fieldsRaw || typeof fieldsRaw !== 'object') {
    return NextResponse.json({ ok: false, error: 'Missing fields payload' }, { status: 400 });
  }

  const fields = fieldsRaw as Record<string, unknown>;
  const body = new URLSearchParams();
  for (const [key, value] of Object.entries(fields)) {
    if (value == null) continue;
    body.set(key, String(value));
  }

  const baseUrl = buildBaseUrl(parsedHost.host, port);

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
      return NextResponse.json({
        ok: false,
        ipAddress: parsedHost.host,
        port,
        status: response.status,
        error: `HTTP ${response.status}`,
        response: responseJson ?? responseText,
      }, { status: 502 });
    }

    return NextResponse.json({
      ok: true,
      ipAddress: parsedHost.host,
      port,
      profileId: Math.round(profileIdRaw),
      response: responseJson ?? responseText,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Failed to edit NanoDLP profile';
    return NextResponse.json({
      ok: false,
      ipAddress: parsedHost.host,
      port,
      error: message,
    }, { status: 500 });
  }
}
