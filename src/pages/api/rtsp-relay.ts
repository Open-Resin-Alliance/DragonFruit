import type { NextApiRequest, NextApiResponse } from 'next';

function readUrlQuery(req: NextApiRequest): string {
  const raw = req.query.url;
  if (Array.isArray(raw)) {
    return String(raw[0] ?? '').trim();
  }
  return String(raw ?? '').trim();
}

function isSafeRtspUrl(value: string): boolean {
  const trimmed = value.trim();
  if (!trimmed) return false;
  return /^rtsps?:\/\//i.test(trimmed);
}

export default async function handler(req: NextApiRequest, res: NextApiResponse): Promise<void> {
  if (req.method && req.method !== 'GET' && req.method !== 'HEAD') {
    res.status(405).json({
      ok: false,
      error: 'Method not allowed.',
    });
    return;
  }

  const rtspUrl = readUrlQuery(req);
  if (rtspUrl && !isSafeRtspUrl(rtspUrl)) {
    res.status(400).json({
      ok: false,
      error: 'Invalid RTSP URL.',
    });
    return;
  }

  // Legacy Next.js relay is intentionally retired.
  // Desktop runtime now uses the native Tauri command `ensure_rtsp_relay`.
  res.status(501).json({
    ok: false,
    error: 'Node RTSP relay has been retired. Use the native desktop relay command path.',
    wsBaseUrl: null,
    rtspDebugTransport: null,
    rtspReclaimDebug: null,
  });
}

export const config = {
  api: {
    bodyParser: false,
  },
};
