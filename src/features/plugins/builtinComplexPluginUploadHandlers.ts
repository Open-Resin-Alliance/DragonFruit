import { BUILTIN_COMPLEX_PLUGIN_ID_ALLOWLIST } from '@/features/plugins/builtinComplexPlugins';
import { GENERATED_BUILTIN_COMPLEX_PLUGIN_UPLOAD_HANDLERS } from '@/features/plugins/generatedBuiltinComplexPluginUploadHandlers';
import type { PluginUploadHandler } from '@/features/plugins/pluginUploadBridge';

export type BuiltinComplexPluginUploadHandler = {
  pluginId: string;
  handler: PluginUploadHandler;
};

let cachedHandlers: BuiltinComplexPluginUploadHandler[] | null = null;

export function getBuiltinComplexPluginUploadHandlers(): BuiltinComplexPluginUploadHandler[] {
  if (cachedHandlers) return cachedHandlers;

  cachedHandlers = [...GENERATED_BUILTIN_COMPLEX_PLUGIN_UPLOAD_HANDLERS];

  const allowSet = new Set(BUILTIN_COMPLEX_PLUGIN_ID_ALLOWLIST);
  cachedHandlers.forEach((entry) => {
    if (!allowSet.has(entry.pluginId)) {
      throw new Error(`[BuiltinComplexPluginUploadHandlers] Plugin id "${entry.pluginId}" is not in the compile-time allowlist`);
    }
  });

  return cachedHandlers;
}
