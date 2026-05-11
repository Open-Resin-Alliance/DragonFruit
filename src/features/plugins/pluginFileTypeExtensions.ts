import { GENERATED_BUILTIN_COMPLEX_PLUGIN_DEFINITIONS } from './generatedBuiltinComplexPlugins';

/**
 * File extensions contributed by built-in fileType plugins (without leading dot, lowercase).
 * Derived at module load time from the auto-generated plugin registry.
 */
export const PLUGIN_CONTRIBUTED_FILE_EXTENSIONS: readonly string[] = Object.freeze(
  GENERATED_BUILTIN_COMPLEX_PLUGIN_DEFINITIONS.flatMap((def) => def.fileTypes ?? []).map((ft) =>
    ft.fileExtension.replace(/^\./, '').toLowerCase(),
  ),
);

/**
 * Regex that strips all known source file extensions from the tail of a filename,
 * including chained suffixes (e.g. "model.stl.lys" → "model").
 *
 * Core extensions are hardcoded here; plugin-contributed extensions are included
 * automatically from the generated plugin registry.
 */
export const KNOWN_SOURCE_EXTENSION_STRIP_RE: RegExp = (() => {
  const core = ['stl', 'obj', '3mf', 'json', 'voxl'];
  const all = [...core, ...PLUGIN_CONTRIBUTED_FILE_EXTENSIONS];
  return new RegExp(`(\\.(${all.join('|')}))+$`, 'i');
})();
