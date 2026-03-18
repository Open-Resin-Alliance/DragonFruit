import type { ComplexPluginDefinition } from '@/features/plugins/complexPluginContracts';
import {
  GENERATED_BUILTIN_COMPLEX_PLUGIN_DEFINITIONS,
  GENERATED_BUILTIN_COMPLEX_PLUGIN_ID_ALLOWLIST,
} from '@/features/plugins/generatedBuiltinComplexPlugins';

let cachedDefinitions: ComplexPluginDefinition[] | null = null;

export const BUILTIN_COMPLEX_PLUGIN_ID_ALLOWLIST = Object.freeze([
  ...GENERATED_BUILTIN_COMPLEX_PLUGIN_ID_ALLOWLIST,
]) as readonly string[];

function assertBuiltinComplexPluginIntegrity(definitions: ComplexPluginDefinition[]): void {
  const allowSet = new Set(BUILTIN_COMPLEX_PLUGIN_ID_ALLOWLIST);
  const seen = new Set<string>();

  for (const definition of definitions) {
    const id = (definition.id || '').trim();
    if (!id) {
      throw new Error('[BuiltinComplexPlugins] Found complex plugin with empty id');
    }
    if (!allowSet.has(id)) {
      throw new Error(`[BuiltinComplexPlugins] Complex plugin "${id}" is not in the compile-time allowlist`);
    }
    if (seen.has(id)) {
      throw new Error(`[BuiltinComplexPlugins] Duplicate complex plugin id detected: "${id}"`);
    }
    seen.add(id);
  }
}

export function getBuiltinComplexPluginDefinitions(): ComplexPluginDefinition[] {
  if (cachedDefinitions) return cachedDefinitions;

  const definitions = [...GENERATED_BUILTIN_COMPLEX_PLUGIN_DEFINITIONS];
  assertBuiltinComplexPluginIntegrity(definitions);
  cachedDefinitions = definitions;
  return cachedDefinitions;
}
