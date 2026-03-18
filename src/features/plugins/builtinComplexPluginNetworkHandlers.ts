import type { PluginNetworkOperationHandler } from '@/features/plugins/networkPluginRegistry';
import { BUILTIN_COMPLEX_PLUGIN_ID_ALLOWLIST } from '@/features/plugins/builtinComplexPlugins';
import { GENERATED_BUILTIN_COMPLEX_PLUGIN_NETWORK_HANDLERS } from '@/features/plugins/generatedBuiltinComplexPluginNetworkHandlers';

export type BuiltinComplexPluginNetworkHandler = {
  pluginId: string;
  handler: PluginNetworkOperationHandler;
};

let cachedHandlers: BuiltinComplexPluginNetworkHandler[] | null = null;

export function getBuiltinComplexPluginNetworkHandlers(): BuiltinComplexPluginNetworkHandler[] {
  if (cachedHandlers) return cachedHandlers;

  cachedHandlers = [...GENERATED_BUILTIN_COMPLEX_PLUGIN_NETWORK_HANDLERS];

  const allowSet = new Set(BUILTIN_COMPLEX_PLUGIN_ID_ALLOWLIST);
  cachedHandlers.forEach((entry) => {
    if (!allowSet.has(entry.pluginId)) {
      throw new Error(`[BuiltinComplexPluginNetworkHandlers] Plugin id "${entry.pluginId}" is not in the compile-time allowlist`);
    }
  });

  return cachedHandlers;
}
