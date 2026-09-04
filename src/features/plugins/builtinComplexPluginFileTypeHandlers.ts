import { BUILTIN_COMPLEX_PLUGIN_ID_ALLOWLIST } from '@/features/plugins/builtinComplexPlugins';
import { isPluginGatedByDisabledExperiment } from '@/features/experiments/experimentsRegistry';
import {
  GENERATED_BUILTIN_COMPLEX_PLUGIN_FILE_TYPE_HANDLERS,
  type GeneratedBuiltinComplexPluginFileTypeHandler,
} from '@/features/plugins/generatedBuiltinComplexPluginFileTypeHandlers';

export type BuiltinComplexPluginFileTypeHandler = GeneratedBuiltinComplexPluginFileTypeHandler;

let cachedHandlers: BuiltinComplexPluginFileTypeHandler[] | null = null;

export function getBuiltinComplexPluginFileTypeHandlers(): BuiltinComplexPluginFileTypeHandler[] {
  if (!cachedHandlers) {
    cachedHandlers = [...GENERATED_BUILTIN_COMPLEX_PLUGIN_FILE_TYPE_HANDLERS];

    const allowSet = new Set(BUILTIN_COMPLEX_PLUGIN_ID_ALLOWLIST);
    cachedHandlers.forEach((entry) => {
      if (!allowSet.has(entry.pluginId)) {
        throw new Error(`[BuiltinComplexPluginFileTypeHandlers] Plugin id "${entry.pluginId}" is not in the compile-time allowlist`);
      }
    });
  }

  // Keep the file-type surface in lockstep with gated plugin definitions.
  return cachedHandlers.filter(
    (entry) => !isPluginGatedByDisabledExperiment(entry.pluginId),
  );
}
