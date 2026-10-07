import type { LoadedModel } from '@/features/scene/useSceneCollectionManager';
import { normalizeExportBaseName, resolveEntirePlateExportBaseName } from '@/features/export/logic/exportFileNaming';

/** What one plate's slice covers, and what its output is called. */
export type PlateSliceScope = {
  /** The plate's own name, or '' when the user has not named it. */
  plateName: string;
  modelIds: readonly string[];
  /** The plate's build volume in world coordinates. */
  volumeBoundsMm: { minX: number; minY: number; maxX: number; maxY: number };
  /** Where the plate sits in the cascade, so its geometry can be shifted to the origin. */
  offsetMm: { dxMm: number; dyMm: number };
};

/**
 * The base name a plate's slice is written under: the plate's own name when it
 * has one, otherwise the first model standing on it, which is what a user who
 * never named a plate would look for.
 */
export function plateSliceBaseName(plateName: string, plateModels: readonly LoadedModel[]): string {
  const trimmed = plateName.trim();
  if (trimmed.length > 0) return normalizeExportBaseName(trimmed);
  return resolveEntirePlateExportBaseName([...plateModels]);
}

/**
 * A sibling of the chosen output path under a different base name, keeping its
 * directory and extension. Null when no path was chosen, which leaves the
 * destination to the caller's own flow.
 */
export function derivePlateOutputPath(chosenPath: string, baseName: string): string | null {
  const trimmed = chosenPath.trim();
  if (!trimmed) return null;

  const separator = Math.max(trimmed.lastIndexOf('/'), trimmed.lastIndexOf('\\'));
  const directory = separator >= 0 ? trimmed.slice(0, separator + 1) : '';
  const file = separator >= 0 ? trimmed.slice(separator + 1) : trimmed;
  const dot = file.lastIndexOf('.');
  const extension = dot > 0 ? file.slice(dot) : '';

  return `${directory}${baseName}${extension}`;
}
