import type { MaterialProfile, PrinterProfile } from './profileStore';

/**
 * The materials a multi-tank printer can actually print with: the profiles its
 * tanks hold, in tank order, each once.
 *
 * A single-material machine has no per-tank choice, and a tank id whose profile
 * was deleted is skipped rather than surfaced as a nameless entry.
 */
export function resolveTankMaterialProfiles(
  printer: Pick<PrinterProfile, 'materialMode' | 'tankMaterials'> | null | undefined,
  materials: readonly MaterialProfile[],
): MaterialProfile[] {
  if (printer?.materialMode !== 'multiTank') return [];

  const byId = new Map(materials.map((material) => [material.id, material]));
  const seen = new Set<string>();
  const resolved: MaterialProfile[] = [];
  for (const id of printer.tankMaterials ?? []) {
    if (!id || seen.has(id)) continue;
    const material = byId.get(id);
    if (!material) continue;
    seen.add(id);
    resolved.push(material);
  }
  return resolved;
}
