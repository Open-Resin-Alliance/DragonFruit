import type { PluginManifest } from '@/features/plugins/pluginRegistry';
import { GENERATED_BUILTIN_SIMPLE_PLUGIN_MANIFESTS } from '@/features/plugins/generatedBuiltinSimplePlugins';

export const BUILTIN_SIMPLE_PLUGIN_MANIFESTS: readonly PluginManifest[] = Object.freeze([
  ...GENERATED_BUILTIN_SIMPLE_PLUGIN_MANIFESTS,
]);
