import { NextResponse } from 'next/server';
import { getNetworkPluginHandler } from '@/features/plugins/networkPluginRegistry';

type RoutePayload = {
  pluginId?: unknown;
  operation?: unknown;
  [key: string]: unknown;
};

/**
 * Parse operation metadata into path segments.
 *
 * Supports either:
 * - `operation: 'nanodlp/connect'`
 * - `operation: ['nanodlp', 'connect']`
 */
function normalizeOperationPath(operation: unknown): string[] {
  if (typeof operation === 'string') {
    return operation
      .split('/')
      .map((segment) => segment.trim())
      .filter((segment) => segment.length > 0);
  }

  if (Array.isArray(operation)) {
    return operation
      .filter((segment) => typeof segment === 'string')
      .map((segment) => String(segment).trim())
      .filter((segment) => segment.length > 0);
  }

  return [];
}

export async function POST(request: Request) {
  let payload: RoutePayload;
  try {
    payload = await request.json() as RoutePayload;
  } catch {
    return NextResponse.json({ error: 'Invalid request JSON' }, { status: 400 });
  }

  const pluginId = typeof payload.pluginId === 'string' ? payload.pluginId.trim().toLowerCase() : '';
  if (!pluginId) {
    return NextResponse.json({ error: 'pluginId is required' }, { status: 400 });
  }

  const operationPath = normalizeOperationPath(payload.operation);
  if (operationPath.length === 0) {
    return NextResponse.json({ error: 'operation is required' }, { status: 400 });
  }

  const handler = getNetworkPluginHandler(pluginId);
  if (!handler) {
    return NextResponse.json({ error: 'Unknown network plugin' }, { status: 404 });
  }

  const { pluginId: _pluginId, operation: _operation, ...operationPayload } = payload;
  const result = await handler(operationPath, operationPayload);

  return NextResponse.json(result.body, { status: result.status });
}