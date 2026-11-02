import { msg } from '@lingui/core/macro';
import { i18n } from '@/i18n';
import { getProfileNetworkUiAdapter, type ProfileNetworkUiAdapter } from '@/features/plugins/pluginRegistry';
import { getBuiltinComplexPluginUploadHandlers } from './builtinComplexPluginUploadHandlers';
import { pluginNetworkFetch, readNativeFileSize } from '@/utils/pluginNetworkBridge';

export type PluginUploadProgressEvent = {
  loaded: number;
  total: number;
  uploadSpeed: string;
  remainingTime: string;
  transferred: string;
  percentComplete: number;
};

export type PluginUploadStatusUpdate = {
  stage: 'uploading' | 'processing' | 'complete' | 'error';
  message: string;
  progress?: PluginUploadProgressEvent;
  plateId?: number | null;
  error?: string;
};

export type PluginUploadCallbacks = {
  onProgress: (event: PluginUploadProgressEvent) => void;
  onStatusUpdate: (update: PluginUploadStatusUpdate) => void;
  onComplete?: (plateId: number | null) => void;
  onError?: (error: string) => void;
};

export type PluginUploadHandler = (args: {
  hostUrl: string;
  zipBlob?: Blob | null;
  zipFilePath?: string | null;
  path: string;
  profileId: string;
  callbacks: PluginUploadCallbacks;
}) => Promise<{ ok: boolean; plateId: number | null }>;

export async function uploadPrintJobWithProgress(args: {
  networkMode: string;
  hostUrl: string;
  zipBlob?: Blob | null;
  zipFilePath?: string | null;
  path: string;
  profileId: string;
  callbacks: PluginUploadCallbacks;
}): Promise<{ ok: boolean; plateId: number | null }> {
  const { networkMode, hostUrl, zipBlob, zipFilePath, path, profileId, callbacks } = args;
  const adapter = getProfileNetworkUiAdapter(networkMode);

  const hasBlob = Boolean(zipBlob && zipBlob.size > 0);
  const normalizedPath = typeof zipFilePath === 'string' ? zipFilePath.trim() : '';
  const hasFilePath = normalizedPath.length > 0;
  if (!hasBlob && !hasFilePath) {
    throw new Error('No upload payload available: expected zipBlob or zipFilePath.');
  }

  if (!adapter) {
    throw new Error(`No network adapter found for mode: ${networkMode}`);
  }

  const handlerByPluginId = new Map<string, PluginUploadHandler>(
    getBuiltinComplexPluginUploadHandlers().map((entry) => [entry.pluginId, entry.handler]),
  );

  const handler = handlerByPluginId.get(adapter.pluginId);
  if (handler) {
    return handler({
      hostUrl,
      zipBlob,
      zipFilePath: hasFilePath ? normalizedPath : null,
      path,
      profileId,
      callbacks,
    });
  }

  if (adapter.operations.upload) {
    return uploadThroughDeclaredOperation({
      adapter,
      operation: adapter.operations.upload,
      hostUrl,
      zipBlob,
      zipFilePath: hasFilePath ? normalizedPath : null,
      path,
      profileId,
      callbacks,
    });
  }

  throw new Error(`Upload with progress is not implemented for plugin: ${adapter.pluginId}`);
}

/** One chunk per request: the plugin reads it from the local file itself. */
const DECLARED_UPLOAD_CHUNK_BYTES = 512 * 1024;

function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB'];
  let value = bytes;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  return `${unit === 0 || value >= 100 ? Math.round(value) : value.toFixed(1)} ${units[unit]}`;
}

function formatRemaining(seconds: number): string {
  const total = Number.isFinite(seconds) && seconds > 0 ? Math.round(seconds) : 0;
  return `${Math.floor(total / 60)}:${String(total % 60).padStart(2, '0')}`;
}

/**
 * A declared network mode uploads through its own operations: `begin` hands it the
 * local file path, every `chunk` names an offset and length it must consume, and
 * `end` returns the plate id. The chunk loop is what produces progress — the panel
 * has no byte stream of its own, so the plugin reads the file it was given.
 */
async function uploadThroughDeclaredOperation(args: {
  adapter: ProfileNetworkUiAdapter;
  operation: string;
  hostUrl: string;
  zipBlob?: Blob | null;
  zipFilePath: string | null;
  path: string;
  profileId: string;
  callbacks: PluginUploadCallbacks;
}): Promise<{ ok: boolean; plateId: number | null }> {
  const { adapter, operation, hostUrl, zipBlob, zipFilePath, path, profileId, callbacks } = args;
  const sourcePath = (zipFilePath ?? '').trim();
  if (!sourcePath) {
    throw new Error('This network mode uploads from a local file path, which a browser build does not have.');
  }

  const send = async (payload: Record<string, unknown>) => {
    const response = await pluginNetworkFetch({
      pluginId: adapter.pluginId,
      operation,
      ...payload,
    });
    const body = await response.json().catch(() => null) as Record<string, unknown> | null;
    if (!response.ok) {
      const message = typeof body?.error === 'string' ? body.error : `Upload request failed (${response.status}).`;
      throw new Error(message);
    }
    return body ?? {};
  };

  const measured = await readNativeFileSize(sourcePath);
  const totalBytes = measured ?? (zipBlob && zipBlob.size > 0 ? zipBlob.size : 0);

  const begin = await send({ phase: 'begin', host: hostUrl, path, sourcePath, totalBytes, profileId });
  const uploadId = typeof begin.uploadId === 'string' ? begin.uploadId : '';
  if (!uploadId) {
    throw new Error('Upload begin returned no upload id.');
  }

  let offset = 0;
  const startedAt = Date.now();
  while (offset < totalBytes) {
    const length = Math.min(DECLARED_UPLOAD_CHUNK_BYTES, totalBytes - offset);
    const chunk = await send({ phase: 'chunk', uploadId, offset, length });
    offset += length;

    const reported = Number(chunk.received);
    const loaded = Number.isFinite(reported) ? Math.max(0, Math.min(reported, totalBytes)) : offset;
    const elapsedSeconds = Math.max(0.001, (Date.now() - startedAt) / 1000);
    const bytesPerSecond = loaded / elapsedSeconds;
    callbacks.onProgress({
      loaded,
      total: totalBytes,
      percentComplete: totalBytes > 0 ? Math.round((loaded / totalBytes) * 10000) / 100 : 0,
      uploadSpeed: `${formatBytes(bytesPerSecond)}/s`,
      remainingTime: formatRemaining(bytesPerSecond > 0 ? (totalBytes - loaded) / bytesPerSecond : 0),
      transferred: `${formatBytes(loaded)} / ${formatBytes(totalBytes)}`,
    });
  }

  const end = await send({ phase: 'end', uploadId });
  callbacks.onStatusUpdate({
    stage: 'processing',
    message: i18n._(msg`File uploaded, processing on device…`),
  });

  const plateValue = Number(end.plateId);
  return {
    ok: end.ok !== false,
    plateId: Number.isFinite(plateValue) ? plateValue : null,
  };
}
