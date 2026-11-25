import { NextResponse } from 'next/server';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { getNetworkPluginHandler } from '@/features/plugins/networkPluginRegistry';

/**
 * Streaming counterpart to `/api/network/plugin`.
 *
 * Some network backends move a large artifact to the device and report progress
 * while they do it, which a request/response JSON route cannot express. This
 * route is only transport: it spools a bytes body to a temporary file, asks the
 * addressed plugin for an operation that returns a `ReadableStream`, and
 * forwards that stream as newline-delimited JSON.
 *
 * Address it the same way as the generic route:
 *
 *   POST /api/network/plugin-stream?pluginId=<id>&operation=<name>/<verb>
 *
 * Every other query parameter is passed through to the plugin untouched, and a
 * JSON body may name an existing file instead of streaming bytes:
 *
 *   { "filePath": "C:\\path\\to\\job.tar" }
 *
 * The plugin is reached through the registry, so core code never imports
 * plugin internals and never names a vendor.
 */

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

/** Query parameters the route consumes itself; everything else is forwarded. */
const RESERVED_PARAMS: Record<string, true> = {
  pluginId: true,
  operation: true,
  filePath: true,
};

function readString(...values: unknown[]): string {
  for (const value of values) {
    if (typeof value === 'string' && value.trim()) return value.trim();
  }
  return '';
}

/** Copies the plugin's stream so the temporary file is removed when either side ends. */
function withCleanup(
  source: ReadableStream<Uint8Array>,
  cleanup: () => Promise<void>,
): ReadableStream<Uint8Array> {
  const reader = source.getReader();
  let released = false;
  const release = () => {
    if (released) return;
    released = true;
    void cleanup();
  };

  return new ReadableStream<Uint8Array>({
    async pull(controller) {
      const { value, done } = await reader.read();
      if (done) {
        controller.close();
        release();
        return;
      }
      controller.enqueue(value);
    },
    cancel(reason) {
      release();
      return reader.cancel(reason);
    },
  });
}

export async function POST(request: Request): Promise<Response> {
  const url = new URL(request.url);
  const pluginId = readString(url.searchParams.get('pluginId')).toLowerCase();
  const operation = readString(url.searchParams.get('operation'));

  if (!pluginId) {
    return NextResponse.json({ error: 'pluginId is required' }, { status: 400 });
  }
  if (!operation) {
    return NextResponse.json({ error: 'operation is required' }, { status: 400 });
  }

  const handler = getNetworkPluginHandler(pluginId);
  if (!handler) {
    return NextResponse.json({ error: 'Unknown network plugin' }, { status: 404 });
  }

  const forwarded: Record<string, unknown> = {};
  url.searchParams.forEach((value, key) => {
    if (!(key in RESERVED_PARAMS)) forwarded[key] = value;
  });

  const contentType = request.headers.get('content-type') ?? '';
  // Neutral name: the route never learns what the file means, only where it is.
  let filePath = readString(forwarded.filePath, url.searchParams.get('filePath'));
  let temporaryDir: string | null = null;

  if (contentType.includes('application/json')) {
    const body = await request.json().catch(() => null) as { filePath?: unknown } | null;
    filePath = readString(body?.filePath) || filePath;
    if (!filePath) {
      return NextResponse.json({ error: 'filePath is required for a JSON body' }, { status: 400 });
    }
  } else if (contentType.includes('octet-stream') || contentType === '') {
    const bytes = new Uint8Array(await request.arrayBuffer());
    if (bytes.byteLength === 0) {
      return NextResponse.json({ error: 'Empty request body' }, { status: 400 });
    }
    const name = readString(forwarded.name) || 'job';
    temporaryDir = await mkdtemp(path.join(tmpdir(), 'dragonfruit-upload-'));
    filePath = path.join(temporaryDir, `${name}.bin`);
    await writeFile(filePath, bytes);
  }

  const cleanup = async () => {
    if (temporaryDir) {
      await rm(temporaryDir, { recursive: true, force: true }).catch(() => undefined);
    }
  };

  const payload = { ...forwarded, filePath: filePath || null };
  const operationPath = operation.split('/').filter((segment) => segment.length > 0);

  let result;
  try {
    result = await handler(operationPath, payload);
  } catch (error) {
    await cleanup();
    const message = error instanceof Error ? error.message : 'Failed to start the operation';
    return NextResponse.json({ error: message }, { status: 500 });
  }

  if (!(result.body instanceof ReadableStream)) {
    await cleanup();
    return NextResponse.json(result.body, { status: result.status });
  }

  return new Response(withCleanup(result.body as ReadableStream<Uint8Array>, cleanup), {
    headers: {
      'Content-Type': 'application/x-ndjson; charset=utf-8',
      'Cache-Control': 'no-store',
      'X-Accel-Buffering': 'no',
    },
  });
}
