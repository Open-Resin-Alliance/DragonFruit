import { getProfileNetworkUiAdapter } from '@/features/plugins/pluginRegistry';
import { getBuiltinComplexPluginUploadHandlers } from './builtinComplexPluginUploadHandlers';

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

  throw new Error(`Upload with progress is not implemented for plugin: ${adapter.pluginId}`);
}
