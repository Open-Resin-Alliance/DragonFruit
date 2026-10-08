import type { LoadedModel } from '@/features/scene/useSceneCollectionManager';
import { KNOWN_SOURCE_EXTENSION_STRIP_RE } from '@/features/plugins/pluginFileTypeExtensions';

export function normalizeExportBaseName(rawName: string | null | undefined): string {
  const trimmed = (rawName ?? '').trim();
  if (!trimmed) return 'MyPrint';

  // Strip common source suffixes if present (including chained suffixes).
  const withoutKnownExt = trimmed.replace(KNOWN_SOURCE_EXTENSION_STRIP_RE, '');
  // A space is what a person types; a file name reads better without it, and a shell needs it
  // quoted. Runs of whitespace become one underscore.
  const underscored = withoutKnownExt.replace(/\s+/g, '_');
  const cleaned = underscored.replace(/[._\s]+$/g, '').trim();
  return cleaned || 'MyPrint';
}

export function resolveEntirePlateExportBaseName(models: LoadedModel[]): string {
  const firstVisible = models.find((model) => model.visible) ?? models[0] ?? null;
  return normalizeExportBaseName(firstVisible?.name);
}

/**
 * The base name one plate's output is written under, for an export and for a slice alike.
 *
 * The plate's own name when it has one. Failing that, the first model standing on it — that is
 * what the user is looking at, and what a bare "Plate 1" says nothing about. A plate with
 * nothing on it has no model to go by, and falls back to its number, which the caller phrases
 * because it owns the translation.
 */
export function resolvePlateOutputBaseName(options: {
  plateName: string;
  plateNumberLabel: string;
  /** The models standing on the plate, in the order the caller lists them. */
  plateModels: readonly LoadedModel[];
}): string {
  const named = options.plateName.trim();
  if (named.length > 0) return normalizeExportBaseName(named);
  if (options.plateModels.length > 0) return resolveEntirePlateExportBaseName([...options.plateModels]);
  return normalizeExportBaseName(options.plateNumberLabel);
}