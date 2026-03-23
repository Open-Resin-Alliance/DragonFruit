import type { NextApiRequest, NextApiResponse } from 'next';
import express from 'express';
import rtspRelay from 'rtsp-relay';
import { createServer, type Server as HttpServer } from 'http';
import * as net from 'node:net';

type RelayServerState = {
  relayServer: HttpServer | null;
  relayPort: number | null;
  startupPromise: Promise<void> | null;
  relayVersion: number;
  dumpProxyByTarget: Map<string, { server: net.Server; port: number }>;
};

declare global {
  // eslint-disable-next-line no-var
  var __dragonfruitRtspRelayState: RelayServerState | undefined;
}

function getRelayState(): RelayServerState {
  if (!global.__dragonfruitRtspRelayState) {
    global.__dragonfruitRtspRelayState = {
      relayServer: null,
      relayPort: null,
      startupPromise: null,
      relayVersion: 0,
      dumpProxyByTarget: new Map(),
    };
  }
  return global.__dragonfruitRtspRelayState;
}

function splitHeaderLines(headerBlock: string): string[] {
  return headerBlock.replace(/\r\n/g, '\n').split('\n');
}

function joinHeaderLines(lines: string[]): string {
  return `${lines.join('\r\n')}`;
}

function findRtspHeaderTerminator(buffer: Buffer): { headerEnd: number; delimiterLength: number } | null {
  const crlfIndex = buffer.indexOf('\r\n\r\n');
  const lfIndex = buffer.indexOf('\n\n');

  if (crlfIndex < 0 && lfIndex < 0) return null;
  if (crlfIndex >= 0 && lfIndex >= 0) {
    return crlfIndex <= lfIndex
      ? { headerEnd: crlfIndex, delimiterLength: 4 }
      : { headerEnd: lfIndex, delimiterLength: 2 };
  }

  if (crlfIndex >= 0) return { headerEnd: crlfIndex, delimiterLength: 4 };
  return { headerEnd: lfIndex, delimiterLength: 2 };
}

function isSafeRtspUrl(value: string): boolean {
  const trimmed = value.trim();
  if (!trimmed) return false;
  return /^rtsps?:\/\//i.test(trimmed);
}

function describeRtspTrafficChunk(direction: '->' | '<-', target: string, chunk: Buffer): void {
  const headerTerminator = findRtspHeaderTerminator(chunk);
  if (headerTerminator) {
    const headerBlock = chunk
      .subarray(0, headerTerminator.headerEnd + headerTerminator.delimiterLength)
      .toString('utf8');
    const payload = chunk.subarray(headerTerminator.headerEnd + headerTerminator.delimiterLength);
    console.log(`[rtsp-dump] ${direction} ${target} RTSP header (${chunk.length} bytes)`);
    console.log(headerBlock.trimEnd());
    if (payload.length > 0) {
      console.log(`[rtsp-dump] ${direction} ${target} RTSP payload (${payload.length} bytes) hex=`);
      console.log(payload.toString('hex'));
    }
    return;
  }

  console.log(`[rtsp-dump] ${direction} ${target} raw (${chunk.length} bytes) hex=`);
  console.log(chunk.toString('hex'));
}

async function ensureDumpingRtspProxyUrl(targetRtspUrl: string): Promise<string> {
  const normalizedTargetUrl = targetRtspUrl.trim();
  const state = getRelayState();
  const existing = state.dumpProxyByTarget.get(normalizedTargetUrl);
  if (existing) {
    return `rtsp://127.0.0.1:${existing.port}/df-relay`;
  }

  const target = new URL(normalizedTargetUrl);
  const targetHost = target.hostname;
  const targetPort = target.port ? Number(target.port) : 554;

  const server = net.createServer((clientSocket) => {
    const upstreamSocket = net.createConnection({ host: targetHost, port: targetPort });

    const teardown = () => {
      if (!clientSocket.destroyed) clientSocket.destroy();
      if (!upstreamSocket.destroyed) upstreamSocket.destroy();
    };

    clientSocket.on('data', (chunk) => {
      describeRtspTrafficChunk('->', normalizedTargetUrl, chunk);
      upstreamSocket.write(chunk);
    });

    upstreamSocket.on('data', (chunk) => {
      describeRtspTrafficChunk('<-', normalizedTargetUrl, chunk);
      clientSocket.write(chunk);
    });

    clientSocket.on('error', teardown);
    upstreamSocket.on('error', teardown);
    clientSocket.on('close', teardown);
    upstreamSocket.on('close', teardown);
  });

  const port = await new Promise<number>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      if (!address || typeof address === 'string' || !Number.isFinite(address.port)) {
        reject(new Error('Failed to bind RTSP dump proxy on localhost.'));
        return;
      }
      resolve(address.port);
    });
  });

  state.dumpProxyByTarget.set(normalizedTargetUrl, { server, port });
  console.log(`[rtsp-dump] proxy active for ${normalizedTargetUrl} on 127.0.0.1:${port}`);
  return `rtsp://127.0.0.1:${port}/df-relay`;
}

const PREFERRED_RELAY_PORT = 9334;
const RELAY_SERVER_VERSION = 3;

async function ensureRtspRelayReady(): Promise<void> {
  const state = getRelayState();
  if (state.startupPromise) {
    await state.startupPromise;
  }

  if (
    state.relayServer &&
    state.relayPort != null &&
    state.relayVersion === RELAY_SERVER_VERSION
  ) {
    return;
  }

  if (state.startupPromise) {
    await state.startupPromise;
    return;
  }

  state.startupPromise = new Promise<void>((resolve, reject) => {
    const relayApp = express();
    const relayServer = createServer(relayApp);
    const relay = rtspRelay(relayApp, relayServer);

    (relayApp as any).ws('/api/rtsp-relay/stream', async (ws: any, req: any) => {
      const rawQueryUrl = req.query?.url;
      const urlCandidate = Array.isArray(rawQueryUrl)
        ? String(rawQueryUrl[0] ?? '')
        : String(rawQueryUrl ?? '');
      const shouldDebugRtspTraffic = process.env.RTSP_RELAY_DEBUG === '1';

      if (!isSafeRtspUrl(urlCandidate)) {
        try {
          ws.close();
        } catch {
          // no-op
        }
        return;
      }

      try {
        const relayTargetUrl = shouldDebugRtspTraffic
          ? await ensureDumpingRtspProxyUrl(urlCandidate.trim())
          : urlCandidate.trim();
        const handler = relay.proxy({
          url: relayTargetUrl,
          verbose: shouldDebugRtspTraffic,
          transport: 'udp',
          additionalFlags: [
            '-analyzeduration', '0',
            '-probesize', '32',
            '-fflags', 'nobuffer',
            '-strict', '-2',
          ],
        });
        handler(ws as any);
      } catch {
        try {
          ws.close();
        } catch {
          // no-op
        }
      }
    });

    const listenOn = (port: number) => {
      const onError = (error: NodeJS.ErrnoException) => {
        relayServer.removeListener('listening', onListening);
        if (error?.code === 'EADDRINUSE' && port !== 0) {
          relayServer.removeListener('error', onError);
          listenOn(0);
          return;
        }
        state.startupPromise = null;
        reject(error);
      };

      const onListening = () => {
        relayServer.removeListener('error', onError);
        const address = relayServer.address();
        const resolvedPort = typeof address === 'object' && address ? address.port : null;
        if (!resolvedPort || !Number.isFinite(resolvedPort)) {
          state.startupPromise = null;
          reject(new Error('RTSP relay started without a valid port.'));
          return;
        }

        state.relayServer = relayServer;
        state.relayPort = resolvedPort;
        state.relayVersion = RELAY_SERVER_VERSION;
        state.startupPromise = null;
        resolve();
      };

      relayServer.once('error', onError);
      relayServer.once('listening', onListening);
      relayServer.listen(port, '127.0.0.1');
    };

    listenOn(PREFERRED_RELAY_PORT);
  });

  await state.startupPromise;
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
    await ensureRtspRelayReady();
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Failed to initialize RTSP relay server.';
    res.status(500).json({
      ok: false,
      error: message,
    });
    return;
  }

  res.status(200).json({
    ok: true,
    message: 'RTSP relay endpoint ready.',
    wsBaseUrl: `ws://127.0.0.1:${getRelayState().relayPort}/api/rtsp-relay/stream`,
  });
}

export const config = {
  api: {
    bodyParser: false,
  },
};
