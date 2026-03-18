import { uploadToNanoDlpWithProgress } from '../../../plugins/athena/network';
import { BUILTIN_COMPLEX_PLUGIN_ID_ALLOWLIST } from '@/features/plugins/builtinComplexPlugins';
import type { PluginUploadHandler } from '@/features/plugins/pluginUploadBridge';

export type BuiltinComplexPluginUploadHandler = {
  pluginId: string;
  handler: PluginUploadHandler;
};

let cachedHandlers: BuiltinComplexPluginUploadHandler[] | null = null;

export function getBuiltinComplexPluginUploadHandlers(): BuiltinComplexPluginUploadHandler[] {
  if (cachedHandlers) return cachedHandlers;

  cachedHandlers = [
    {
      pluginId: 'athena',
      handler: async ({ hostUrl, zipBlob, path, profileId, callbacks }) => {
        return uploadToNanoDlpWithProgress(hostUrl, zipBlob, path, profileId, callbacks);
      },
    },
  ];

  const allowSet = new Set(BUILTIN_COMPLEX_PLUGIN_ID_ALLOWLIST);
  cachedHandlers.forEach((entry) => {
    if (!allowSet.has(entry.pluginId)) {
      throw new Error(`[BuiltinComplexPluginUploadHandlers] Plugin id "${entry.pluginId}" is not in the compile-time allowlist`);
    }
  });

  return cachedHandlers;
}
