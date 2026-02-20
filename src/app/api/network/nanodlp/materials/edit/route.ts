import { NextResponse } from 'next/server';
import {
  buildNanoDlpBaseUrl,
  parseNanoDlpHostAndPort,
  resolveNanoDlpPort,
  resolveNanoDlpRawHost,
} from '../../../../../../../plugins/athena/network/nanodlp';

export async function POST(request: Request) {
  let payload: unknown;
  try {
    payload = await request.json();
  } catch {
    return NextResponse.json({ ok: false, error: 'Invalid request JSON' }, { status: 400 });
  }

  const rawHost = resolveNanoDlpRawHost(payload);

  const parsedHost = parseNanoDlpHostAndPort(rawHost);
  if (!parsedHost) {
    return NextResponse.json({ ok: false, error: 'Invalid host or IP address' }, { status: 400 });
  }

  const profileIdRaw = Number((payload as any)?.profileId);
  if (!Number.isFinite(profileIdRaw) || profileIdRaw <= 0) {
    return NextResponse.json({ ok: false, error: 'Invalid profileId' }, { status: 400 });
  }

  const port = resolveNanoDlpPort((payload as any)?.port, parsedHost.port);

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
