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

export type TankMaterialMatch = {
  materialId: string;
  tankIndex: number;
};

/**
 * Place scene materials into the target printer's tanks, preferring the tank a
 * material occupied on the previous printer and falling back to the first free
 * tank. Materials already held by the target are left alone.
 */
export function matchSceneMaterialsToTanks(
  sceneMaterialIds: readonly string[],
  previousTankMaterials: readonly (string | undefined)[],
  targetTankMaterials: readonly string[],
): { tankMaterials: string[]; assignments: TankMaterialMatch[] } {
  const tankMaterials = [...targetTankMaterials];
  const assignments: TankMaterialMatch[] = [];
  for (const materialId of sceneMaterialIds) {
    if (!materialId || tankMaterials.includes(materialId)) continue;
    const preferredIndex = previousTankMaterials.indexOf(materialId);
    const tankIndex = preferredIndex >= 0
      && preferredIndex < tankMaterials.length
      && !tankMaterials[preferredIndex]
      ? preferredIndex
      : tankMaterials.findIndex((material) => !material);
    if (tankIndex < 0) continue;
    tankMaterials[tankIndex] = materialId;
    assignments.push({ materialId, tankIndex });
  }
  return { tankMaterials, assignments };
}
