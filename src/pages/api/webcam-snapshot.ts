import type { NextApiRequest, NextApiResponse } from 'next';

const SNAPSHOT_FETCH_TIMEOUT_MS = 12_000;
const MAX_STREAM_SCAN_BYTES = 8 * 1024 * 1024;

function isLikelyStreamUrl(targetUrl: URL): boolean {
  const pathname = targetUrl.pathname.toLowerCase();
  if (/\/(stream|mjpeg|video)(?:\/)?$/.test(pathname)) return true;
  const query = targetUrl.search.toLowerCase();
  return query.includes('stream=') || query.includes('mjpeg=');
}

function buildFetchCandidates(targetUrl: URL): string[] {
  const out: string[] = [targetUrl.toString()];
  const pathname = targetUrl.pathname;

  if (/\/athena-camera\/stream\/?$/i.test(pathname)) {
    const snapshotCandidate = new URL(targetUrl.toString());
    snapshotCandidate.pathname = snapshotCandidate.pathname.replace(/\/stream\/?$/i, '/snapshot');
    out.unshift(snapshotCandidate.toString());
  }

  return Array.from(new Set(out));
}

function findJpegFrame(buffer: Buffer): Buffer | null {
  const start = buffer.indexOf(Buffer.from([0xff, 0xd8]));
  if (start < 0) return null;

  const end = buffer.indexOf(Buffer.from([0xff, 0xd9]), start + 2);
  if (end < 0) return null;

  return buffer.subarray(start, end + 2);
}

async function readFirstJpegFrame(
  stream: ReadableStream<Uint8Array<ArrayBufferLike>> | null,
  signal: AbortSignal,
): Promise<Buffer> {
  if (!stream) {
    throw new Error('Snapshot stream body was empty.');
  }

  const reader = stream.getReader();
  let buffer = Buffer.alloc(0);

  try {
    while (true) {
      if (signal.aborted) {
        throw new Error('Snapshot stream timed out before first frame.');
      }

      const { value, done } = await reader.read();
      if (done) {
        break;
      }
      if (!value || value.length === 0) {
        continue;
      }

      buffer = buffer.length === 0
        ? Buffer.from(value)
        : Buffer.concat([buffer, Buffer.from(value)]);

      const frame = findJpegFrame(buffer);
      if (frame) {
        return frame;
      }

      if (buffer.length > MAX_STREAM_SCAN_BYTES) {
        const start = buffer.indexOf(Buffer.from([0xff, 0xd8]));
        if (start >= 0) {
          buffer = buffer.subarray(start);
        } else {
          buffer = buffer.subarray(Math.max(0, buffer.length - 8192));
        }
      }
    }
  } finally {
    try {
      await reader.cancel();
    } catch {
      // ignore cancellation errors
    }
  }

  throw new Error('Snapshot stream ended before a full JPEG frame was received.');
}

function readQueryUrl(req: NextApiRequest): string {
  const raw = req.query.url;
  if (Array.isArray(raw)) {
    return String(raw[0] ?? '').trim();
  }
  return String(raw ?? '').trim();
}

function readErrorMessage(error: unknown, fallback: string): string {
  if (error instanceof Error && error.message.trim().length > 0) {
    return error.message.trim();
  }
  const message = String(error ?? '').trim();
  return message.length > 0 ? message : fallback;
}

export default async function handler(req: NextApiRequest, res: NextApiResponse): Promise<void> {
  if (req.method && req.method !== 'GET' && req.method !== 'HEAD') {
    res.status(405).json({
      ok: false,
      error: 'Method not allowed.',
    });
    return;
  }

  const targetUrlRaw = readQueryUrl(req);
  if (!targetUrlRaw) {
    res.status(400).json({
      ok: false,
      error: 'Missing webcam snapshot URL.',
    });
    return;
  }

  let targetUrl: URL;
  try {
    targetUrl = new URL(targetUrlRaw);
  } catch {
    res.status(400).json({
      ok: false,
      error: 'Invalid webcam snapshot URL.',
    });
    return;
  }

  if (targetUrl.protocol !== 'http:' && targetUrl.protocol !== 'https:') {
    res.status(400).json({
      ok: false,
      error: 'Only HTTP(S) webcam snapshot URLs are supported.',
    });
    return;
  }

  const controller = new AbortController();
  const timeoutId = setTimeout(() => {
    controller.abort();
  }, SNAPSHOT_FETCH_TIMEOUT_MS);

  try {
    const candidates = buildFetchCandidates(targetUrl);
    let lastFetchError: string | null = null;
    let resolvedBytes: Buffer | null = null;
    let resolvedContentType = 'application/octet-stream';

    for (const candidate of candidates) {
      const candidateUrl = new URL(candidate);
      const likelyStream = isLikelyStreamUrl(candidateUrl);

      try {
        const upstreamResponse = await fetch(candidateUrl.toString(), {
          method: 'GET',
          cache: 'no-store',
          redirect: 'follow',
          signal: controller.signal,
          headers: {
            Accept: likelyStream
              ? 'multipart/x-mixed-replace, image/*, */*;q=0.8'
              : 'image/*,*/*;q=0.8',
          },
        });

        if (!upstreamResponse.ok) {
          lastFetchError = `Snapshot source request failed (HTTP ${upstreamResponse.status}).`;
          continue;
        }

        const contentType = upstreamResponse.headers.get('content-type')?.trim() || '';
        const shouldReadAsStream = likelyStream || /multipart\/x-mixed-replace/i.test(contentType);

        const bytes = shouldReadAsStream
          ? await readFirstJpegFrame(upstreamResponse.body, controller.signal)
          : Buffer.from(await upstreamResponse.arrayBuffer());

        if (bytes.length <= 0) {
          lastFetchError = 'Snapshot source returned an empty payload.';
          continue;
        }

        resolvedBytes = bytes;
        resolvedContentType = shouldReadAsStream
          ? 'image/jpeg'
          : (contentType || 'application/octet-stream');
        break;
      } catch (error) {
        lastFetchError = readErrorMessage(error, 'Failed to fetch webcam snapshot bytes.');
      }
    }

    if (!resolvedBytes) {
      res.status(502).json({
        ok: false,
        error: lastFetchError ?? 'Failed to fetch webcam snapshot bytes.',
      });
      return;
    }

    res.setHeader('Cache-Control', 'no-store, max-age=0');
    res.setHeader('Content-Type', resolvedContentType);
    res.setHeader('X-Content-Type-Options', 'nosniff');

    if (req.method === 'HEAD') {
      res.status(200).end();
      return;
    }

    res.status(200).send(resolvedBytes);
  } catch (error) {
    const message = readErrorMessage(error, 'Failed to fetch webcam snapshot bytes.');
    res.status(502).json({ ok: false, error: message });
  } finally {
    clearTimeout(timeoutId);
  }
}
