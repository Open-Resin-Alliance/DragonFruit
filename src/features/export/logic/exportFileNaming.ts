import type { LoadedModel } from '@/features/scene/useSceneCollectionManager';
import { KNOWN_SOURCE_EXTENSION_STRIP_RE } from '@/features/plugins/pluginFileTypeExtensions';

export function normalizeExportBaseName(rawName: string | null | undefined): string {
  const trimmed = (rawName ?? '').trim();
  if (!trimmed) return 'MyPrint';

  // Strip common source suffixes if present (including chained suffixes).
  const withoutKnownExt = trimmed.replace(KNOWN_SOURCE_EXTENSION_STRIP_RE, '');
  const cleaned = withoutKnownExt.replace(/[.\s]+$/g, '').trim();
  return cleaned || 'MyPrint';
}

export function resolveEntirePlateExportBaseName(models: LoadedModel[]): string {
  const firstVisible = models.find((model) => model.visible) ?? models[0] ?? null;
  const firstBase = normalizeExportBaseName(firstVisible?.name);
  return `${firstBase}_DF_Scene`;
}