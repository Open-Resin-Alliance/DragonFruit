import type { NextApiRequest, NextApiResponse } from 'next';

const JSMPEG_CDN_URL = 'https://cdn.jsdelivr.net/gh/phoboslab/jsmpeg@b5799bf/jsmpeg.min.js';

declare global {
  // eslint-disable-next-line no-var
  var __dragonfruitJsmpegBundlePromise: Promise<string> | undefined;
}

function getJsmpegBundlePromise(): Promise<string> {
  if (!global.__dragonfruitJsmpegBundlePromise) {
    global.__dragonfruitJsmpegBundlePromise = fetch(JSMPEG_CDN_URL, {
      cache: 'force-cache',
    }).then(async (response) => {
      if (!response.ok) {
        throw new Error(`Failed to fetch JSMpeg bundle: HTTP ${response.status}`);
      }
      return response.text();
    });
  }

  return global.__dragonfruitJsmpegBundlePromise;
}

export default async function handler(req: NextApiRequest, res: NextApiResponse): Promise<void> {
  if (req.method && req.method !== 'GET' && req.method !== 'HEAD') {
    res.status(405).json({
      ok: false,
      error: 'Method not allowed.',
    });
    return;
  }

  try {
    const script = await getJsmpegBundlePromise();
    res.setHeader('Content-Type', 'application/javascript; charset=utf-8');
    res.setHeader('Cache-Control', 'public, max-age=86400, stale-while-revalidate=604800');
    if (req.method === 'HEAD') {
      res.status(200).end();
      return;
    }

    res.status(200).send(script);
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Failed to load JSMpeg bundle.';
    res.status(500).json({ ok: false, error: message });
  }
}